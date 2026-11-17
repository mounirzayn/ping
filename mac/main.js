// Ping : appli Mac avec navigateur intégré. Surveille les recherches et notifie les nouvelles annonces.
const { app, BrowserWindow, ipcMain, Notification, shell, Tray, Menu, nativeImage, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const SITE = 'https://mounirzayn.github.io/ping/';
const { spawn, execFile } = require('child_process');
const os = require('os');
let BUILD = {}; try { BUILD = require('./build-info.json'); } catch {}
const NTFY = process.env.PING_NTFY || 'https://ntfy.sh/';
const PART = 'persist:ping'; // session partagée : connexions conservées entre navigateur intégré et surveillance
const MIN_INTERVAL = 30, MAX_SEEN = 600, MAX_HITS = 300, MAX_NOTIF_PER_CYCLE = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// User-agent standard du navigateur (sans les mentions Electron/Ping)
app.userAgentFallback = app.userAgentFallback.replace(/\s?Electron\/\S+/i, '').replace(/\s?ping\/\S+/i, '');

if (!app.requestSingleInstanceLock()) app.quit();
const IS_MAC = process.platform === 'darwin';
if (process.platform === 'win32') app.setAppUserModelId('fr.nksupport.ping'); // requis pour les notifications Windows

let state, dataFile, mainWin = null, tray = null, quitting = false;
const timers = new Map();
const workers = new Map();

// ---------- Données ----------
function load() {
  dataFile = path.join(app.getPath('userData'), 'ping-data.json');
  try { state = JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch { state = {}; }
  state = { watches: [], hits: [], unread: 0, ntfyTopic: '', desktopNotif: true, ...state };
  if (!state.v2) { // nouvelle lecture des annonces : on repart d'une base propre
    state.hits = []; state.unread = 0;
    state.watches.forEach((w) => { w.seen = []; w.primed = false; w.count = 0; });
    state.v2 = true;
  }
  if (!state.v3) { // filtre « uniquement l'objet » activé par défaut sur les catégories où les accessoires polluent
    state.watches.forEach((w) => { if (w.strict === undefined) w.strict = ['consoles', 'telephones', 'informatique'].includes(w.cat); });
    state.v3 = true;
  }
  if (!state.ntfyTopic) state.ntfyTopic = 'ping-' + crypto.randomBytes(9).toString('hex');
  save();
}
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(dataFile, JSON.stringify(state), () => {}), 300);
  broadcast();
  maybePushState();
}
const publicState = () => ({ ...state, siteUrl: SITE, version: BUILD.tag || 'dev', watches: state.watches.map(({ seen, ...w }) => w) });
function broadcast() {
  BrowserWindow.getAllWindows().forEach((w) => { if (!w.isDestroyed()) w.webContents.send('state', publicState()); });
  updateBadge();
}
function updateBadge() {
  const n = state.unread ? String(Math.min(state.unread, 99)) : '';
  if (app.dock) app.dock.setBadge(n);
  if (tray) { if (IS_MAC) tray.setTitle(n ? ' ' + n : ''); tray.setToolTip(n ? `Ping · ${n} nouvelle(s) annonce(s)` : 'Ping'); }
  if (!IS_MAC && mainWin && !mainWin.isDestroyed()) mainWin.setTitle(n ? `Ping (${n})` : 'Ping');
}

// ---------- Planification ----------
let chain = Promise.resolve();
const enqueue = (fn) => (chain = chain.then(fn).catch((e) => console.error('[Ping]', e)));

function scheduleAll() {
  timers.forEach(clearTimeout); timers.clear();
  state.watches.filter((w) => w.active).forEach((w, i) => schedule(w.id, 3000 + i * 9000));
  // ferme les fenêtres de surveillance inutiles
  for (const [id, bw] of workers) {
    const w = state.watches.find((x) => x.id === id);
    if (!w || !w.active) { if (!bw.isDestroyed()) bw.destroy(); workers.delete(id); }
  }
}
function schedule(id, delay) {
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => enqueue(() => check(id)), delay));
}
function scheduleNext(w, factor = 1) {
  const base = Math.max(MIN_INTERVAL, w.interval || 60) * factor;
  schedule(w.id, base * (0.8 + Math.random() * 0.4) * 1000); // rythme irrégulier, plus humain
}

// ---------- Extraction (exécutée dans la page) ----------
function extractListings() {
  const pats = [
    [/leboncoin\.fr\/(?:ad\/)?[a-z_]+\/(\d{7,})/, 'Leboncoin'],
    [/facebook\.com\/marketplace\/item\/(\d+)/, 'Marketplace'],
    [/vinted\.[a-z.]+\/items\/(\d+)/, 'Vinted'],
    [/ebay\.[a-z.]+\/itm\/(?:[^/]+\/)?(\d{9,})/, 'eBay'],
  ];
  // Prix : "20 €", "1 350 €", "230.00 €", "21,70 €", "€200", "EUR 12,00"
  const priceRe = /(?:€|EUR)\s?(\d{1,3}(?:[\s  .]\d{3})*|\d+)(?:[.,](\d{1,2}))?|(\d{1,3}(?:[\s  .]\d{3})*|\d+)(?:[.,](\d{1,2}))?\s?(?:€|EUR)/;
  const parsePrice = (t) => {
    if (/\b(gratuit|free)\b/i.test(t || '') && !priceRe.test(t)) return 0;
    const m = (t || '').match(priceRe); if (!m) return null;
    const ent = (m[1] || m[3]).replace(/[\s  .]/g, ''); const dec = m[2] || m[4] || '0';
    return parseFloat(ent + '.' + dec);
  };
  const known = (href) => { for (const [p, s] of pats) { const m = href.match(p); if (m) return [s + ':' + m[1], s]; } return null; };

  // Site inconnu : on repère le "modèle" de lien qui revient le plus souvent à côté d'un prix
  let generic = null;
  const anchors = [...document.querySelectorAll('a[href]')];
  if (!anchors.some((a) => known(a.href))) {
    const shape = (p) => { const seg = p.split('/').filter(Boolean); const last = seg[seg.length - 1] || ''; return seg.length + ':' + seg.slice(0, -1).map((x) => (/\d{3,}/.test(x) || x.length > 24 ? '*' : x)).join('/') + ':' + (/\d{4,}/.test(last) ? '#' : last.length > 24 ? 'L' : 'w'); };
    const groups = new Map();
    for (const a of anchors) {
      if (a.host !== location.host || a.pathname.length < 3 || /^(#|javascript|mailto|tel)/i.test(a.getAttribute('href') || '')) continue;
      if (/\/(login|connexion|compte|account|panier|cart|aide|help|cgu|contact)/i.test(a.pathname)) continue;
      const k = shape(a.pathname);
      if (!groups.has(k)) groups.set(k, new Set());
      groups.get(k).add(a.pathname);
    }
    let best = null, bestScore = 0;
    for (const [k, paths] of groups) {
      if (paths.size < 3) continue;
      const withPrice = [...paths].filter((p) => { const a = anchors.find((x) => x.pathname === p); let c = a; for (let n = 0; n < 4 && c.parentElement; n++) c = c.parentElement; return priceRe.test(c.innerText || ''); }).length;
      const score = withPrice * 2 + paths.size;
      if (withPrice >= Math.min(3, paths.size) && score > bestScore) { best = k; bestScore = score; }
    }
    if (best) generic = groups.get(best);
  }
  const host = location.hostname.replace(/^www\./, '');
  const keyOf = (a) => { const k = known(a.href); if (k) return k; if (generic && a.host === location.host && generic.has(a.pathname)) return ['Web:' + host + a.pathname, host]; return null; };

  const bad = /^(voir l.annonce|see listing|sponsoris|nouveau|new|\d+([.,]\d)?\s*\(\d+\)|prix|située|livraison|pro|urgent|à la une)/i;
  const out = new Map();
  for (const a of anchors) {
    const key = keyOf(a);
    if (!key || out.has(key[0])) continue;
    const [id, site] = key;
    // Carte = plus grand parent qui ne contient que cette annonce
    let card = a;
    while (card.parentElement && card.parentElement !== document.body) {
      const p = card.parentElement;
      const ids = new Set([...p.querySelectorAll('a[href]')].map((x) => (keyOf(x) || [null])[0]).filter(Boolean));
      if (ids.size > 1) break;
      card = p;
    }
    // Photo : la plus grande image réelle de la carte (pas l'avatar du vendeur)
    let img = null, best = 0;
    for (const im of card.querySelectorAll('img')) {
      const src = im.currentSrc || im.src || im.getAttribute('data-src') || '';
      if (!/^https?:/.test(src) || /pp-small|avatar|profile|logo|icon/i.test(src)) continue;
      const r = im.getBoundingClientRect(); const area = Math.max(r.width * r.height, (im.naturalWidth || 0) * (im.naturalHeight || 0) / 4, 1);
      if (area > best) { best = area; img = src; }
    }
    // Titre
    const srTitle = ([...card.querySelectorAll('span,h2,h3')].map((e) => e.textContent.trim()).find((t) => /^(voir l.annonce|see listing)\s*:\s*\S/i.test(t)) || '').replace(/^[^:]+:\s*/, '');
    const attrTitle = srTitle || [a.getAttribute('title'), a.getAttribute('aria-label')].find((t) => t && t.length > 8 && !bad.test(t)) || '';
    const imgAlt = [...card.querySelectorAll('img[alt]')].map((i) => i.alt).find((t) => t && t.length > 8 && !/avatar|profil|logo/i.test(t)) || '';
    const attrStr = (t) => /^[^:]{1,25}:\s*["«]/.test(t) || /["»]\.\s*[A-Za-zÀ-ÿ ]{2,20}\s*:/.test(t);
    const heading = ([...card.querySelectorAll('h1,h2,h3,h4,[class*="title" i]')].map((e) => e.innerText.trim()).find((t) => t.length > 3 && !priceRe.test(t) && !bad.test(t) && !attrStr(t)) || '');
    const lines = (card.innerText || '').split('\n').map((l) => l.trim()).filter((l) => l.length > 3 && !bad.test(l) && !priceRe.test(l) && !/\b\d{5}\b/.test(l) && !attrStr(l));
    const fromLines = lines.sort((x, y) => y.length - x.length)[0] || '';
    let title = (attrTitle || (site.includes('.') ? heading : '') || imgAlt || heading || fromLines).split(/,\s*(?:Marque|État|Taille|Brand|Condition)\s*:/)[0].replace(/,\s*\d[\d.,\s]*\s?€.*$/, '').trim();
    if (!title) continue;
    if (site.includes('.') && !img && !priceRe.test(card.innerText || '')) continue; // lien de filtre, pas une annonce
    const price = parsePrice(attrTitle) ?? parsePrice(imgAlt) ?? parsePrice(card.innerText);
    const url = known(a.href) ? a.href.split('?')[0].split('#')[0] : a.href.split('#')[0];
    out.set(id, { id, site, url, title: title.slice(0, 140), price, img });
  }
  const head = (document.title + ' ' + (document.body ? document.body.innerText.slice(0, 600) : '')).toLowerCase();
  const blocked = /captcha|datadome|verify you are human|vous êtes un robot|accès temporairement restreint|log in to continue|connecte-toi pour|se connecter à facebook/.test(head);
  return { items: [...out.values()], blocked };
}

function getWorker(id) {
  let bw = workers.get(id);
  if (bw && !bw.isDestroyed()) return bw;
  bw = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { partition: PART, backgroundThrottling: false } });
  bw.webContents.setAudioMuted(true);
  bw.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  workers.set(id, bw);
  return bw;
}

// ---------- Vérification ----------
async function check(id, manual = false) {
  let w = state.watches.find((x) => x.id === id);
  if (!w || (!w.active && !manual)) return;
  let result = { items: [], blocked: false };
  try {
    const bw = getWorker(id);
    await Promise.race([bw.loadURL(w.url).catch(() => {}), sleep(30000)]);
    await sleep(2500 + Math.random() * 1500);
    // petit défilement pour charger les vignettes paresseuses
    for (const y of [700, 1400, 2100]) {
      await bw.webContents.executeJavaScript(`window.scrollTo(0, ${y}); true`).catch(() => {});
      await sleep(450);
    }
    result = await bw.webContents.executeJavaScript(`(${extractListings.toString()})()`);
  } catch (e) {
    result.error = String(e.message || e);
  }

  w = state.watches.find((x) => x.id === id);
  if (!w) return;
  w.lastCheck = Date.now();

  if (result.blocked) {
    w.status = 'blocked';
    if (!w.blockedNotified) {
      notify({ title: '⚠️ Ping en pause : ' + w.name, message: 'Le site demande une vérification ou une connexion. Clique pour la faire dans Ping.', url: w.url, inApp: true });
      w.blockedNotified = true;
    }
    save();
    if (w.active) scheduleNext(w, 3);
    return;
  }
  if (result.error || !result.items.length) {
    w.status = result.error ? 'error' : 'empty';
    w.statusMsg = result.error || 'Aucune annonce lue sur la page';
    save();
    if (w.active) scheduleNext(w, 1.5);
    return;
  }

  w.status = 'ok'; w.statusMsg = ''; w.blockedNotified = false;
  const seen = new Set(w.seen || []);
  const fresh = result.items.filter((it) => !seen.has(it.id));
  result.items.forEach((it) => seen.add(it.id));
  w.seen = [...seen].slice(-MAX_SEEN);
  const hits = w.primed ? fresh.filter((it) => matches(w, it)) : [];
  w.primed = true; // premier passage : mémorise l'existant sans notifier
  w.count = (w.count || 0) + hits.length;

  const stamped = hits.map((h) => ({ ...h, watchId: w.id, watchName: w.name, cat: w.cat, at: Date.now() }));
  state.hits = [...stamped, ...state.hits].slice(0, MAX_HITS);
  state.unread += stamped.length;
  save();

  stamped.slice(0, MAX_NOTIF_PER_CYCLE).forEach((h) => notify({
    title: `🔔 ${h.price != null ? h.price.toLocaleString('fr-FR') + ' € · ' : ''}${w.name}`,
    message: `${h.title}\n${h.site}`,
    url: h.url, img: h.img,
  }));
  if (w.active) scheduleNext(w);
}

const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
function keywordsOf(w) {
  if (w.include) return w.include;
  try { const u = new URL(w.url); return u.searchParams.get('text') || u.searchParams.get('query') || u.searchParams.get('search_text') || u.searchParams.get('_nkw') || ''; } catch { return ''; }
}
// Mode « uniquement l'objet » : écarte les accessoires / jeux vendus seuls (FR, EN, ES, IT)
const ACC = new Set(['manette','manettes','controller','controllers','mando','mandos','controllo','dualsense','dualshock','coque','housse','funda','etui','case','cover','skin','skins','sticker','stickers','protection','chargeur','charger','cable','cables','support','socle','dock','casque','headset','volant','jeu','jeux','game','games','gioco','giochi','juego','juegos','boite','grip','grips','joystick','pochette','sacoche','ventilateur','telecommande','remote','camera','facade','plaque','piece','pieces','carte','disque','batterie','accessoire','accessoires']);
const words = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
const NOT_SALE = new Set(['recherche','recherches','cherche','cherchons','achete','achetons','achat','rachete','rachat','echange','echanges','troc','wanted','busco','cerco']);
function isAccessory(title, keywords) {
  const ws = words(title);
  if (NOT_SALE.has(ws[0]) || / (contre|echange|troc) /.test(' ' + ws.join(' ') + ' ')) return true; // « Recherche PS5 », « PS5 contre PC »
  if (ws.slice(0, 2).some((x) => ACC.has(x))) return true; // « Manette PS5 », « Funda rígida… »
  const flat = ' ' + ws.join(' ') + ' ';
  return keywords.some((k) => { const kw = words(k).join(' '); return kw && new RegExp(` (pour|para|for|per|compatible) (la |el |le |the |une |un )?${kw} `).test(flat); });
}
function matches(w, it) {
  if (w.min !== '' && w.min != null && it.price != null && it.price < +w.min) return false;
  if (w.max !== '' && w.max != null && it.price != null && it.price > +w.max) return false;
  const t = norm(it.title);
  const list = (s) => String(s || '').split(',').map(norm).filter(Boolean);
  if (list(w.exclude).some((x) => t.includes(x))) return false;
  if (w.strict && isAccessory(it.title, String(keywordsOf(w)).split(','))) return false;
  if (w.strict && it.price != null && it.price <= 1) return false; // prix symbolique (échange, recherche)
  const incl = list(keywordsOf(w));
  return !incl.length || incl.some((x) => t.includes(x)); // l'annonce doit contenir un des mots-clés
}

// ---------- Notifications : Mac + téléphone (ntfy) ----------
function notify({ title, message, url, img, inApp }) {
  if (state.desktopNotif !== false && Notification.isSupported()) {
    const n = new Notification({ title, body: message, silent: false });
    n.on('click', () => { if (inApp) openBrowser(url); else if (/^https:\/\//.test(url)) shell.openExternal(url); });
    n.show();
  }
  if (state.ntfyTopic) {
    const body = { topic: state.ntfyTopic, title, message, click: url, priority: 5, tags: ['bell'] };
    if (img) body.attach = img;
    fetch(NTFY, { method: 'POST', body: JSON.stringify(body) }).catch(() => {});
  }
}

// ---------- Fenêtres ----------
function showMain() {
  if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); return; }
  mainWin = new BrowserWindow({
    width: 1180, height: 860, minWidth: 820, minHeight: 600, title: 'Ping',
    backgroundColor: '#0b0d12', ...(IS_MAC ? { titleBarStyle: 'hiddenInset' } : { autoHideMenuBar: true }),
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  mainWin.loadFile(path.join(__dirname, 'index.html'));
  mainWin.on('close', (e) => { if (!quitting) { e.preventDefault(); mainWin.hide(); } });
}

function openBrowser(url) {
  const win = new BrowserWindow({
    width: 1280, height: 900, title: 'Ping · Navigateur', backgroundColor: '#0b0d12', ...(IS_MAC ? { titleBarStyle: 'hiddenInset' } : { autoHideMenuBar: true }),
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), webviewTag: true },
  });
  win.loadFile(path.join(__dirname, 'browser.html'), { query: { url: url || 'https://www.leboncoin.fr' } });
}

app.on('web-contents-created', (_e, wc) => {
  // Une page (Facebook, LBC…) ne doit jamais pouvoir bloquer la fermeture de Ping
  wc.on('will-prevent-unload', (ev) => ev.preventDefault());
  if (wc.getType() === 'webview') {
    wc.setWindowOpenHandler(({ url }) => { wc.loadURL(url); return { action: 'deny' }; });
  }
});

// ---------- Actions depuis l'interface ----------
ipcMain.handle('getState', () => publicState());
// N'importe quel site d'annonces en https (pas d'adresse locale ni d'IP)
const ALLOWED_URL = /^https:\/\/(?!localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[|\d+\.\d+\.\d+\.\d+)[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i;
function doAction(type, p, fromWeb = false) {
  const find = (id) => state.watches.find((w) => w.id === id);
  switch (type) {
    case 'addWatches': {
      const list = (Array.isArray(p) ? p : []).filter((w) => w && ALLOWED_URL.test(w.url || '')).slice(0, 8).map((w) => ({
        group: String(w.group || '').slice(0, 64) || undefined, name: String(w.name || 'Ping').slice(0, 60), site: String(w.site || '').slice(0, 20), cat: String(w.cat || 'tout'),
        url: w.url, min: w.min ?? '', max: w.max ?? '', include: String(w.include || ''), exclude: String(w.exclude || '').slice(0, 300),
        interval: Math.max(MIN_INTERVAL, +w.interval || 60), strict: !!w.strict,
        id: crypto.randomUUID(), seen: [], primed: false, count: 0, status: 'pending', active: true,
      }));
      state.watches.push(...list); save(); scheduleAll(); break;
    }
    case 'toggle': { const w = find(p); if (w) { w.active = !w.active; save(); scheduleAll(); } break; }
    case 'delete': state.watches = state.watches.filter((w) => w.id !== p); save(); scheduleAll(); break;
    case 'checkNow': if (find(p)) enqueue(() => check(p, true)); break;
    case 'pauseAll': { const any = state.watches.some((w) => w.active); state.watches.forEach((w) => (w.active = !any)); save(); scheduleAll(); break; }
    case 'refresh': pushState(); break;
    case 'installUpdate': if (!fromWeb) installUpdate(); break;
    case 'checkUpdate': if (!fromWeb) checkUpdate(); break;
    case 'deleteHit': { const ids = new Set([].concat(p)); const before = state.hits.length; state.hits = state.hits.filter((h, i) => { const del = ids.has(h.id); if (del && i < state.unread) state.unread--; return !del; }); state.unread = Math.max(0, Math.min(state.unread, state.hits.length)); if (state.hits.length !== before) save(); break; }
    case 'clearHits': state.hits = []; state.unread = 0; save(); break;
    case 'updateGroup': {
      const ids = new Set([].concat(p && p.ids || []));
      state.watches.filter((w) => ids.has(w.id)).forEach((w) => {
        if (p.exclude !== undefined) w.exclude = String(p.exclude).slice(0, 600);
        if (p.include !== undefined && String(p.include).trim()) w.include = String(p.include).slice(0, 200);
        if (p.min !== undefined) w.min = p.min; if (p.max !== undefined) w.max = p.max;
        if (p.strict !== undefined) w.strict = !!p.strict;
        w.url = rewriteUrl(w.url, String(w.include || '').split(',')[0].trim(), w.min, w.max);
        w.seen = []; w.primed = false; // nouvelle base pour ne pas notifier d'anciennes annonces
      });
      scheduleAll();
      save(); break;
    }
    case 'clearUnread': if (!fromWeb) { state.unread = 0; save(); } break;
    case 'testPush': if (!fromWeb) notify({ title: '🔔 Test Ping', message: 'Si tu vois ce message, tes alertes sont prêtes.', url: 'https://ntfy.sh' }); break;
    case 'setTopic': if (!fromWeb) { state.ntfyTopic = p; save(); listenCmds(); pushState(); } break;
    case 'setDesktop': if (!fromWeb) { state.desktopNotif = !!p; save(); } break;
    case 'openBrowser': if (!fromWeb) openBrowser(p); break;
    case 'openExternal': if (!fromWeb && /^https:\/\//.test(p)) shell.openExternal(p); break;
  }
  return true;
}
ipcMain.handle('action', async (_e, type, p) => doAction(type, p));

// Met à jour la recherche et les prix directement dans l'adresse du site
function rewriteUrl(url, q, min, max) {
  try {
    const u = new URL(url); const set = (k, v) => (v !== '' && v != null ? u.searchParams.set(k, v) : u.searchParams.delete(k));
    if (/leboncoin/.test(u.host)) { if (q) set('text', q); set('price', min || max ? `${min || 'min'}-${max || 'max'}` : ''); }
    else if (/facebook/.test(u.host)) { if (q) set('query', q); set('minPrice', min); set('maxPrice', max); }
    else if (/vinted/.test(u.host)) { if (q) set('search_text', q); set('price_from', min); set('price_to', max); }
    else if (/ebay/.test(u.host)) { if (q) set('_nkw', q); set('_udlo', min); set('_udhi', max); }
    return u.toString();
  } catch { return url; }
}

// ---------- Mise à jour automatique (depuis les versions publiées sur GitHub) ----------
const RELEASES = 'https://api.github.com/repos/mounirzayn/ping/releases/latest';
async function checkUpdate() {
  if (!BUILD.tag) return;
  try {
    const j = await (await fetch(RELEASES, { headers: { 'User-Agent': 'Ping', Accept: 'application/vnd.github+json' } })).json();
    if (j.tag_name && j.tag_name > BUILD.tag) {
      const fresh = !state.update || state.update.tag !== j.tag_name;
      state.update = { tag: j.tag_name, status: 'ready' }; save();
      if (fresh && Notification.isSupported()) {
        const n = new Notification({ title: 'Mise à jour de Ping disponible', body: 'Clique pour l\'installer (30 secondes).' });
        n.on('click', () => { showMain(); installUpdate(); }); n.show();
      }
    } else if (state.update) { delete state.update; save(); }
  } catch {}
}
async function installUpdate() {
  if (!state.update || state.update.status === 'installing') return;
  state.update.status = 'installing'; save();
  try {
    const isMac = process.platform === 'darwin';
    const asset = isMac ? 'Ping-Mac.zip' : 'Ping-Windows-Setup.exe';
    const buf = Buffer.from(await (await fetch(`https://github.com/mounirzayn/ping/releases/download/${state.update.tag}/${asset}`)).arrayBuffer());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ping-maj-'));
    const file = path.join(dir, asset);
    fs.writeFileSync(file, buf);
    if (isMac) {
      await new Promise((ok, ko) => execFile('ditto', ['-x', '-k', file, dir], (e) => (e ? ko(e) : ok())));
      const newApp = path.join(dir, 'Ping-Mac', 'Ping.app');
      const cur = process.execPath.replace(/\/Contents\/MacOS\/.*$/, ''); // …/Ping.app
      const target = /\.app$/.test(cur) ? cur : '/Applications/Ping.app';
      const sh = `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done; rm -rf "${target}"; ditto "${newApp}" "${target}"; xattr -cr "${target}"; codesign --force --deep --sign - "${target}" >/dev/null 2>&1; open "${target}"`;
      spawn('/bin/sh', ['-c', sh], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn(file, [], { detached: true, stdio: 'ignore' }).unref(); // installeur Windows : installe puis relance Ping
    }
    quitting = true; app.quit();
  } catch (e) {
    state.update.status = 'error'; state.update.err = String(e.message || e); save();
  }
}

// ---------- Synchro avec l'espace web (via ntfy, sans serveur) ----------
// Le Mac publie un résumé de ses pings sur <canal>-etat et écoute les commandes sur <canal>-cmd.
let lastSig = '', stateTimer = null, cmdAbort = null;
function compactState(withUrl = true) {
  return { v: 1, at: Date.now(), w: state.watches.map((w) => ({
    id: w.id, n: w.name, s: w.site, c: w.cat, mi: w.min, ma: w.max, i: w.interval, a: w.active ? 1 : 0,
    st: w.status, ct: w.count || 0, lc: w.lastCheck || 0, ...(withUrl ? { u: w.url } : {}),
  })) };
}
function maybePushState() {
  // n'envoie que sur un vrai changement (économise le quota ntfy)
  const sig = JSON.stringify(state.watches.map((w) => [w.id, w.name, w.active, w.status, w.count, w.min, w.max, w.interval]));
  if (sig === lastSig) return;
  lastSig = sig;
  clearTimeout(stateTimer);
  stateTimer = setTimeout(pushState, 4000);
}
function pushState() {
  if (!state.ntfyTopic) return;
  let body = JSON.stringify(compactState());
  if (body.length > 3900) body = JSON.stringify(compactState(false));
  fetch(NTFY + state.ntfyTopic + '-etat', { method: 'POST', body }).catch(() => {});
}
async function listenCmds() {
  if (cmdAbort) cmdAbort.abort();
  const topic = state.ntfyTopic; if (!topic) return;
  const ac = new AbortController(); cmdAbort = ac;
  try {
    const since = state.lastCmdId || '10m';
    const res = await fetch(`${NTFY}${topic}-cmd/json?since=${since}`, { signal: ac.signal });
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.event !== 'message') continue;
          state.lastCmdId = m.id;
          const c = JSON.parse(m.message);
          if (c && c.cmd && Date.now() / 1000 - m.time < 3600) doAction(c.cmd, c.p, true);
        } catch {}
      }
    }
  } catch { if (ac.signal.aborted) return; }
  if (cmdAbort === ac) setTimeout(listenCmds, 5000);
}

// ---------- Barre des menus ----------
function buildTray() {
  let img;
  if (IS_MAC) { img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png')); img.setTemplateImage(true); }
  else img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-win.png'));
  tray = new Tray(img);
  tray.setToolTip('Ping');
  const refresh = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Ouvrir Ping', click: showMain },
    { label: 'Navigateur Ping', click: () => openBrowser() },
    { type: 'separator' },
    { label: state.watches.some((w) => w.active) ? 'Tout mettre en pause' : 'Tout reprendre', click: () => { toggleAll(); refresh(); } },
    { type: 'separator' },
    { label: 'Quitter Ping', click: () => { quitting = true; app.quit(); } },
  ]));
  const toggleAll = () => { const any = state.watches.some((w) => w.active); state.watches.forEach((w) => (w.active = !any)); save(); scheduleAll(); };
  refresh();
  tray.on('mouse-enter', refresh);
  if (!IS_MAC) tray.on('click', showMain); // Windows : clic sur l'icône = ouvrir Ping
  updateBadge();
}

app.whenReady().then(() => {
  app.setName('Ping');
  load();
  powerSaveBlocker.start('prevent-app-suspension'); // garde la surveillance active
  buildTray();
  showMain();
  scheduleAll();
  listenCmds();
  setTimeout(pushState, 8000);
  setInterval(pushState, 2 * 3600 * 1000); // signe de vie toutes les 2 h
  setTimeout(checkUpdate, 15000);
  setInterval(checkUpdate, 3 * 3600 * 1000);
});
app.on('second-instance', showMain);
app.on('activate', showMain);
app.on('before-quit', () => { quitting = true;
  for (const bw of workers.values()) { try { if (!bw.isDestroyed()) bw.destroy(); } catch {} } try { fs.writeFileSync(dataFile, JSON.stringify(state)); } catch {} });
app.on('window-all-closed', (e) => e.preventDefault()); // reste actif dans la barre des menus
