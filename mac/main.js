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
  if (state.update && state.update.status === 'installing') delete state.update;
  if (!state.v2) { // nouvelle lecture des annonces : on repart d'une base propre
    state.hits = []; state.unread = 0;
    state.watches.forEach((w) => { w.seen = []; w.primed = false; w.count = 0; });
    state.v2 = true;
  }
  if (!state.v3) { // filtre « uniquement l'objet » activé par défaut sur les catégories où les accessoires polluent
    state.watches.forEach((w) => { if (w.strict === undefined) w.strict = ['consoles', 'telephones', 'informatique'].includes(w.cat); });
    state.v3 = true;
  }
  if (!state.v4) { // nettoie le flux avec le nouveau filtre (jeux vendus seuls)
    state.hits = state.hits.filter((h) => { const w = state.watches.find((x) => x.id === h.watchId); return !w || (matches(w, h) && !belowCote(w, h, coteForWatch(w))); });
    state.unread = Math.min(state.unread, state.hits.length);
    state.v4 = true;
  }
  if (!state.v5) { // filtre « uniquement l'objet » sur toutes les recherches de consoles / téléphones / ordis, puis nettoyage
    state.watches.forEach((w) => { if (['consoles', 'telephones', 'informatique'].includes(w.cat)) w.strict = true; });
    state.hits = state.hits.filter((h) => { const w = state.watches.find((x) => x.id === h.watchId); return !w || (matches(w, h) && !belowCote(w, h, coteForWatch(w))); });
    state.unread = Math.min(state.unread, state.hits.length);
    state.v5 = true;
  }
  if (!state.v6) { state.hits = state.hits.filter((h) => { const w = state.watches.find((x) => x.id === h.watchId); return !w || matches(w, h); }); state.unread = Math.min(state.unread, state.hits.length); state.v6 = true; }
  // À chaque démarrage : on repasse le flux au filtre actuel (les règles s'améliorent à chaque version)
  state.hits = state.hits.filter((h) => { const w = state.watches.find((x) => x.id === h.watchId); return !w || (matches(w, h) && !belowCote(w, h, coteForWatch(w))); });
  state.unread = Math.min(state.unread, state.hits.length);
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
const publicState = () => ({ ...state, siteUrl: SITE, version: BUILD.tag || 'dev', cotes: groupCotes(), watches: state.watches.map(({ seen, cote, ...w }) => w) });
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
// File de vérification : 2 recherches en parallèle, chacune limitée dans le temps,
// pour qu'une page qui ne répond plus ne bloque jamais les autres.
const MAX_PARALLEL = 2, CHECK_TIMEOUT = 75000;
const queue = []; const busy = new Set(); let running = 0;
function enqueue(fn, id) {
  if (id && (busy.has(id) || queue.some((q) => q.id === id))) return; // déjà prévue
  queue.push({ fn, id }); pump();
}
function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const { fn, id } = queue.shift(); running++; if (id) busy.add(id);
    let to;
    const timeout = new Promise((_, rej) => { to = setTimeout(() => rej(new Error('timeout')), CHECK_TIMEOUT); });
    Promise.race([Promise.resolve().then(fn), timeout])
      .catch((e) => {
        console.error('[Ping]', e);
        if (id && String(e.message) === 'timeout') onCheckTimeout(id);
      })
      .finally(() => { clearTimeout(to); running--; if (id) busy.delete(id); pump(); });
  }
}
function onCheckTimeout(id) {
  const bw = workers.get(id); if (bw && !bw.isDestroyed()) bw.destroy(); workers.delete(id);
  const w = state.watches.find((x) => x.id === id); if (!w) return;
  w.status = 'error'; w.statusMsg = 'La page ne répond pas, nouvel essai bientôt'; w.lastCheck = Date.now();
  save(); if (w.active) scheduleNext(w, 1.5);
}
const withTimeout = (p, ms, fallback) => Promise.race([p, sleep(ms).then(() => fallback)]);
// Filet de sécurité : toute recherche active sans prochain passage prévu est relancée
setInterval(() => {
  state.watches.filter((w) => w.active && !timers.has(w.id) && !busy.has(w.id) && !queue.some((q) => q.id === w.id))
    .forEach((w, i) => schedule(w.id, 2000 + i * 5000));
}, 60000);

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
  timers.set(id, setTimeout(() => { timers.delete(id); enqueue(() => check(id), id); }, delay));
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
  const priceRe = /(?:€|EUR)[ \u202f\u00a0]?(\d{1,3}(?:[ \u202f\u00a0.]\d{3})*|\d+)(?:[.,](\d{1,2}))?|(\d{1,3}(?:[ \u202f\u00a0.]\d{3})*|\d+)(?:[.,](\d{1,2}))?[ \u202f\u00a0]?(?:€|EUR)/; // pas de retour à la ligne dans un prix
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
  // Texte de la carte, y compris quand le site ne l'affiche pas encore (annonces hors écran)
  const textOf = (el) => { const t = el.innerText || ''; if (t.trim().length > 20) return t;
    return [...el.querySelectorAll('*')].filter((e) => e.tagName !== 'STYLE' && e.tagName !== 'SCRIPT' && !e.children.length).map((e) => e.textContent.trim()).filter(Boolean).join('\n'); };
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
    const cardText = textOf(card);
    if (/(^|\n)\s*à la une\s*(\n|$)/i.test(cardText)) continue; // annonce ancienne remise en avant (payante), pas une nouveauté
    const srRe = /^(voir l.annonce|see listing)\s*:\s*\S/i;
    const srTitle = ([...card.querySelectorAll('*')].flatMap((e) => [e.getAttribute('title'), e.getAttribute('aria-label'), /^(SPAN|H2|H3)$/.test(e.tagName) ? e.textContent.trim() : null]).find((t) => t && srRe.test(t)) || '').replace(/^[^:]+:\s*/, '');
    const attrTitle = srTitle || [a.getAttribute('title'), a.getAttribute('aria-label')].find((t) => t && t.length > 8 && !bad.test(t)) || '';
    const imgAlt = [...card.querySelectorAll('img[alt]')].map((i) => i.alt).find((t) => t && t.length > 8 && !/avatar|profil|logo/i.test(t)) || '';
    const attrStr = (t) => /^[^:]{1,25}:\s*["«]/.test(t) || /["»]\.\s*[A-Za-zÀ-ÿ ]{2,20}\s*:/.test(t);
    const heading = ([...card.querySelectorAll('h1,h2,h3,h4,[class*="title" i]')].map((e) => e.innerText.trim()).find((t) => t.length > 3 && !priceRe.test(t) && !bad.test(t) && !attrStr(t)) || '');
    const lines = cardText.split('\n').map((l) => l.trim()).filter((l) => l.length > 3 && !bad.test(l) && !priceRe.test(l) && !/\b\d{5}\b/.test(l) && !attrStr(l));
    const fromLines = lines.sort((x, y) => y.length - x.length)[0] || '';
    let title = (attrTitle || (site.includes('.') ? heading : '') || imgAlt || heading || fromLines).split(/,\s*(?:Marque|État|Taille|Brand|Condition)\s*:/)[0].replace(/,\s*\d[\d.,\s]*\s?€.*$/, '').trim();
    if (!title) continue;
    if (site.includes('.') && !img && !priceRe.test(cardText)) continue; // lien de filtre, pas une annonce
    const price = parsePrice(attrTitle) ?? parsePrice(imgAlt) ?? parsePrice(cardText);
    const url = known(a.href) ? a.href.split('?')[0].split('#')[0] : a.href.split('#')[0];
    out.set(id, { id, site, url, title: title.slice(0, 140), price, img });
  }
  const head = (document.title + ' ' + (document.body ? document.body.innerText.slice(0, 600) : '')).toLowerCase();
  const blocked = /captcha|datadome|verify you are human|vous êtes un robot|accès temporairement restreint|log in to continue|connecte-toi pour|se connecter à facebook|pardon our interruption|checking your browser|access denied|accès refusé|robot check|êtes-vous un humain|vérification de sécurité|security check|unusual traffic/.test(head);
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

// ---------- Cote du marché ----------
// Toutes les 6 h, chaque recherche relit sa page SANS filtre de prix et garde le prix des objets
// qui passent les mêmes filtres (mots-clés, objet seul). La médiane de ces prix = la cote.
const COTE_EVERY = 6 * 3600 * 1000;
const median = (a) => { const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
function coteOf(prices) {
  let p = prices.filter((x) => x > 1);
  if (p.length < 6) return null;
  const m0 = median(p);
  p = p.filter((x) => x >= m0 * 0.35 && x <= m0 * 2.5); // jeux à 10 € ou lots à 2 000 € : hors cote
  if (p.length < 6) return null;
  return { med: Math.round(median(p)), n: p.length };
}
function groupCotes() {
  const by = {};
  for (const w of state.watches) {
    if (!w.cote || !w.cote.p) continue;
    const g = w.group || w.id; (by[g] = by[g] || { p: [], at: 0 });
    by[g].p.push(...w.cote.p); by[g].at = Math.max(by[g].at, w.cote.at);
  }
  const out = {};
  for (const [g, v] of Object.entries(by)) { const c = coteOf(v.p); if (c) out[g] = { ...c, at: v.at }; }
  return out;
}
const coteForWatch = (w) => groupCotes()[w.group || w.id] || null;
// Mode objet seul : bien en dessous de la cote = presque toujours un accessoire, une pièce ou une arnaque
const belowCote = (w, it, c) => !!(w.strict && c && it.price != null && it.price < c.med * 0.4);
async function checkCote(id) {
  const w0 = state.watches.find((x) => x.id === id); if (!w0) return;
  const url = rewriteUrl(w0.url, '', '', '');
  const key = 'cote:' + id;
  let items = [];
  try {
    const bw = getWorker(key);
    await Promise.race([bw.loadURL(url).catch(() => {}), sleep(30000)]);
    await sleep(2500 + Math.random() * 1500);
    for (const y of [700, 1400, 2100, 2800]) {
      await withTimeout(bw.webContents.executeJavaScript(`window.scrollTo(0, ${y}); true`).catch(() => {}), 5000);
      await sleep(450);
    }
    const r = await withTimeout(bw.webContents.executeJavaScript(`(${extractListings.toString()})()`), 20000, null);
    if (r && !r.blocked) items = r.items || [];
  } catch {}
  const bw = workers.get(key); if (bw && !bw.isDestroyed()) bw.destroy(); workers.delete(key);
  const w = state.watches.find((x) => x.id === id); if (!w) return;
  const free = { ...w, min: '', max: '' };
  const prices = items.filter((it) => it.price != null && matches(free, it)).map((it) => it.price);
  w.cote = { p: prices.slice(0, 80), at: Date.now() };
  save();
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
      await withTimeout(bw.webContents.executeJavaScript(`window.scrollTo(0, ${y}); true`).catch(() => {}), 5000);
      await sleep(450);
    }
    result = await withTimeout(bw.webContents.executeJavaScript(`(${extractListings.toString()})()`), 20000, null);
    if (!result) throw new Error('La page ne répond pas');
  } catch (e) {
    result = { items: [], blocked: false, error: String(e.message || e) };
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
  if (!w.cote || Date.now() - w.cote.at > COTE_EVERY) enqueue(() => checkCote(w.id), 'cote:' + w.id);
  const seen = new Set(w.seen || []);
  const fresh = result.items.filter((it) => !seen.has(it.id));
  result.items.forEach((it) => seen.add(it.id));
  w.seen = [...seen].slice(-MAX_SEEN);
  const cote0 = coteForWatch(w);
  const hits = w.primed ? fresh.filter((it) => matches(w, it) && !belowCote(w, it, cote0)) : [];
  w.primed = true; // premier passage : mémorise l'existant sans notifier
  w.count = (w.count || 0) + hits.length;

  const cote = coteForWatch(w);
  const stamped = hits.map((h) => ({ ...h, watchId: w.id, watchName: w.name, cat: w.cat, at: Date.now(), cote: cote ? cote.med : null }));
  state.hits = [...stamped, ...state.hits].slice(0, MAX_HITS);
  state.unread += stamped.length;
  save();

  stamped.slice(0, MAX_NOTIF_PER_CYCLE).forEach((h) => notify({
    title: `🔔 ${h.price != null ? h.price.toLocaleString('fr-FR') + ' € · ' : ''}${w.name}`,
    message: `${h.title}\n${h.site}${coteLine(h.price, h.cote)}`,
    url: h.url, img: h.img,
  }));
  if (w.active) scheduleNext(w);
}

// Variantes d'écriture d'un même produit (« ps5 » = « PlayStation 5 » = « Play 5 »…)
const SYNONYMS = [
  ['ps5', 'playstation5', 'play5', 'playstationfive', 'sonyps5'],
  ['ps4', 'playstation4', 'play4'],
  ['xboxseriesx', 'xboxseriex', 'seriesx', 'seriex', 'xsx'],
  ['xboxseriess', 'xboxseries', 'seriess', 'xss'],
  ['switch', 'nintendoswitch'],
  ['switcholed', 'switcholed', 'oled'],
];
function expandKw(list) {
  const out = new Set(list);
  for (const k of list) for (const g of SYNONYMS) if (g.includes(k)) g.forEach((x) => out.add(x));
  return [...out];
}
const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
function keywordsOf(w) {
  if (w.include) return w.include;
  try { const u = new URL(w.url); return u.searchParams.get('text') || u.searchParams.get('query') || u.searchParams.get('search_text') || u.searchParams.get('_nkw') || ''; } catch { return ''; }
}
// Mode « uniquement l'objet » : écarte les accessoires / jeux vendus seuls (FR, EN, ES, IT)
const ACC = new Set(['speicherplatz','portal','festplatte','disco','volante','lenkrad','thrustmaster','metalbox','blister','mannete','manete','manetta','speicherkarte','speicher','storage','expansion','seagate','ssd','memoire','caja','scatola','doos','karton','vacia','vuota','vide','leer','empty','box','emballage','carton','manette','manettes','controller','controllers','mando','mandos','controllo','dualsense','dualshock','coque','housse','funda','etui','case','cover','skin','skins','sticker','stickers','protection','chargeur','charger','cable','cables','support','socle','dock','casque','headset','volant','jeu','jeux','game','games','gioco','giochi','juego','juegos','boite','grip','grips','joystick','pochette','sacoche','ventilateur','telecommande','remote','camera','facade','plaque','piece','pieces','carte','disque','batterie','accessoire','accessoires','adaptateur','adapter','clavier','souris','keyboard','mouse','hub','cle','convertisseur','station','refroidisseur','cooler','stand','sac','valise','malette']);
const words = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
const NOT_SALE = new Set(['procurando','procuro','busca','buscando','suchen','rechercher','recherchons','rachetons','recherche','recherches','cherche','cherchons','achete','achetons','achat','rachete','rachat','echange','echanges','troc','wanted','busco','cerco','suche','sucht','search','searching','looking','compro','scambio','cambio','tausch','nettoyage','reparation','depannage','location','loue']);
// Jeux vendus seuls : mot "jeu" n'importe où, ou nom de jeu connu, sans indice de console
const GAME_WORDS = new Set(['jeu','jeux','game','games','videojuego','videojuegos','videogioco','videogiochi','videogame','videogames','videojeu','videojeux','jogo','juegos','spel','spellen','jogo','jogos','gra','gry','gioco','giochi','juego','juegos','spiel','spiele','cartouche','pegi','steelbook','goty','remastered','remaster','dlc','collectible','collector','figurine','figure','amiibo','artbook','poster','shockbox','funko']);
const GAME_TITLES = ['dead island','dredge','ultimate edition','deluxe edition','gold edition','game of the year','complete edition','definitive edition','collector','fifa','fc 24','fc 25','fc 26','fc 27','ea sports','gta','grand theft auto','call of duty','black ops','modern warfare','warzone','spider man','spiderman','god of war','gran turismo','hogwarts','elden ring','assassin','ratchet','horizon','last of us','resident evil','mortal kombat','nba 2k','2k25','2k26','minecraft','zelda','mario','pokemon','sonic','crash bandicoot','ghost of tsushima','demon s souls','returnal','f1 2','f1 24','f1 25','battlefield','cyberpunk','red dead','diablo','final fantasy','street fighter','tekken','lego','just dance','sims','need for speed','forza','halo','starfield','astro bot','it takes two','split fiction','dragon ball','naruto','one piece','star wars','avatar','far cry','watch dogs','uncharted','death stranding','stellar blade','wukong','metal gear','silent hill','the crew','tomb raider','batman','hitman','dead space','dying light','sekiro','bloodborne','destiny','overwatch','rocket league','fortnite','valhalla','mirage','shadows','madden','ufc','wwe','pga','nhl','rayman','kingdom hearts','persona','yakuza','like a dragon','monster hunter','devil may cry','alan wake','lies of p','atomic heart','hollow knight','jedi','outlaws'];
const CONSOLE_HINT = /\b(console|konsole|consola|slim|pro|digital|digitale|standard|lecteur|bundle|pack|\d+\s?(go|gb|to|tb)|1to|2to|825)\b/;
function isGame(title, keywords = []) {
  const ws = words(title); const flat = ' ' + ws.join(' ') + ' ';
  if (!/ console /.test(flat) && / (games? bundle|jeux lot|lot (de )?(\d+ )?jeux|\d+ (games|jeux|giochi|juegos|spiele)) /.test(flat)) return true; // lot de jeux seuls
  if (CONSOLE_HINT.test(flat)) return false; // « PS5 Slim + FIFA » = une console, on garde
  const startsWithKw = keywords.some((k) => { const kw = words(k).join(' '); return kw && flat.startsWith(' ' + kw + ' '); });
  if (startsWithKw && /\+|\bavec\b|\bwith\b|\bcon\b|\bmit\b/i.test(title)) return false; // « PS5 + 2 manettes + 3 jeux » = lot console
  if (ws.some((x) => GAME_WORDS.has(x))) return true;
  // « Xbox One Xbox Series X », « PS4 / PS5 » : étiquette de compatibilité d'un jeu, pas une console
  if (/ xbox one /.test(flat) && / series /.test(flat)) return true;
  if (/ (ps4|playstation 4) /.test(flat) && / (ps5|playstation 5) /.test(flat)) return true;
  return GAME_TITLES.some((g) => flat.includes(' ' + g + ' ') || flat.includes(' ' + g.replace(/ /g, '') + ' '));
}
const SALE_PREFIX = /^\s*(vends?|vente|a vendre|à vendre|vendo|verkaufe|for sale|selling)\b[\s:,-]*/i;
function bundleWithKw(title, keywords) { // « PS5 avec sa manette », « PS5 + 2 jeux »
  const t = title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return keywords.some((k) => { const kw = words(k).join('\\W*'); return kw && new RegExp(kw + '\\W*(avec|with|con|mit|\\+|et\\s+\\d)').test(t); });
}
function isAccessory(title, keywords) {
  title = String(title || '').replace(SALE_PREFIX, '');
  if (bundleWithKw(title, keywords) && !NOT_SALE.has(words(title)[0])) return false;
  const ws = words(title);
  if (isGame(title, keywords)) return true;
  // Accessoire cité n'importe où (« HyperX Cloud III Casque … PS5 ») quand rien n'indique une console
  const flatAll = ' ' + ws.join(' ') + ' ';
  const startsWithKw = keywords.some((k) => { const kw = words(k).join(' '); return kw && flatAll.startsWith(' ' + kw + ' '); });
  if (!CONSOLE_HINT.test(flatAll) && !startsWithKw && ws.some((x) => ACC.has(x))) return true;
  if (NOT_SALE.has(ws[0]) || / (contre|echange|troc|scambio|cambio|tausch|nettoyage|reparation) /.test(' ' + ws.join(' ') + ' ')) return true; // « Recherche PS5 », « PS5 contre PC »
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
  const kwsRaw = String(keywordsOf(w)).split(',').map((x) => x.trim()).filter(Boolean);
  const kwsAll = [...kwsRaw, ...(kwsRaw.some((k) => norm(k) === 'ps5') ? ['playstation 5', 'play 5', 'ps 5'] : []), ...(kwsRaw.some((k) => norm(k) === 'ps4') ? ['playstation 4', 'play 4'] : [])];
  if (w.strict && isAccessory(it.title, kwsAll)) return false;
  if (w.strict && it.price != null && it.price <= 1) return false; // prix symbolique (échange, recherche)
  // Prix plancher : une console (ou tout objet cherché) vendue à moins du quart du budget max, c'est presque toujours
  // un jeu, une boîte vide ou un accessoire. Ex. budget 300 € : on ignore ce qui est sous 75 €.
  if (w.strict && (w.min === '' || w.min == null) && +w.max > 0 && it.price != null && it.price < +w.max * 0.25) return false;
  const incl = expandKw(list(keywordsOf(w)));
  return !incl.length || incl.some((x) => t.includes(x)); // l'annonce doit contenir un des mots-clés (ou une variante)
}

function coteLine(price, cote) {
  if (!cote || price == null) return '';
  const d = Math.round(((price - cote) / cote) * 100);
  return `\nCote ~${cote.toLocaleString('fr-FR')} € · ${d > 0 ? '+' : ''}${d} %`;
}

// ---------- Notifications : Mac + téléphone (ntfy) ----------
function notify({ title, message, url, img, inApp }) {
  if (state.desktopNotif !== false && Notification.isSupported()) {
    const n = new Notification({ title, body: message, silent: state.soundOn === false, sound: IS_MAC && state.soundOn !== false ? 'Glass' : undefined });
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
        interval: Math.max(MIN_INTERVAL, +w.interval || 60), strict: !!w.strict, city: String(w.city || '').slice(0, 60),
        id: crypto.randomUUID(), seen: [], primed: false, count: 0, status: 'pending', active: true,
      }));
      state.watches.push(...list); save(); scheduleAll(); break;
    }
    case 'toggle': { const w = find(p); if (w) { w.active = !w.active; save(); scheduleAll(); } break; }
    case 'delete': state.watches = state.watches.filter((w) => w.id !== p); save(); scheduleAll(); break;
    case 'checkNow': if (find(p)) enqueue(() => check(p, true), p); break;
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
        w.seen = []; w.primed = false; w.cote = null; // nouvelle base (et nouvelle cote)
      });
      scheduleAll();
      save(); break;
    }
    case 'clearUnread': if (!fromWeb) { state.unread = 0; save(); } break;
    case 'testPush': if (!fromWeb) notify({ title: '🔔 Test Ping', message: 'Si tu vois ce message, tes alertes sont prêtes.', url: 'https://ntfy.sh' }); break;
    case 'setTopic': if (!fromWeb) { state.ntfyTopic = p; save(); listenCmds(); pushState(); } break;
    case 'setDesktop': if (!fromWeb) { state.desktopNotif = !!p; save(); } break;
    case 'setSound': if (!fromWeb) { state.soundOn = !!p; save(); } break;
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
    quitting = true;
    try { fs.writeFileSync(dataFile, JSON.stringify({ ...state, update: undefined })); } catch {}
    for (const bw of workers.values()) { try { if (!bw.isDestroyed()) bw.destroy(); } catch {} }
    app.exit(0); // fermeture forcée : aucune page ne peut bloquer la mise à jour
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
    st: w.status, ct: w.count || 0, lc: w.lastCheck || 0, co: (coteForWatch(w) || {}).med || 0, ...(withUrl ? { u: w.url } : {}),
  })) };
}
function maybePushState() {
  // n'envoie que sur un vrai changement (économise le quota ntfy)
  const sig = JSON.stringify(state.watches.map((w) => [w.id, w.name, w.active, w.status, w.count, w.min, w.max, w.interval, w.cote && w.cote.at]));
  if (sig === lastSig) return;
  lastSig = sig;
  clearTimeout(stateTimer);
  stateTimer = setTimeout(pushState, 4000);
}
function pushState() {
  if (!state.ntfyTopic) return;
  // ntfy limite un message à 4 Ko : au-delà il devient une pièce jointe illisible pour le téléphone.
  // Avec beaucoup de recherches on découpe donc l'état en plusieurs messages (le site les réassemble).
  const full = compactState(), MAX = 3800;
  const parts = []; let cur = [];
  const size = (w) => JSON.stringify({ v: 2, at: full.at, k: 99, n: 99, w }).length;
  for (const w of full.w) {
    if (size([...cur, w]) > MAX) {
      if (size([w]) > MAX) delete w.u; // lien trop long : le site le montrera sans le bouton
      if (cur.length) { parts.push(cur); cur = []; }
    }
    cur.push(w);
  }
  parts.push(cur);
  parts.forEach((w, k) => fetch(NTFY + state.ntfyTopic + '-etat', { method: 'POST', body: JSON.stringify({ v: 2, at: full.at, k, n: parts.length, w }) }).catch(() => {}));
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
    { label: 'Quitter Ping', click: () => { quitting = true; app.quit(); setTimeout(() => { try { fs.writeFileSync(dataFile, JSON.stringify(state)); } catch {} app.exit(0); }, 2500); } },
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
  setInterval(checkUpdate, 3600 * 1000);
});
app.on('second-instance', showMain);
app.on('activate', showMain);
app.on('before-quit', () => { quitting = true;
  for (const bw of workers.values()) { try { if (!bw.isDestroyed()) bw.destroy(); } catch {} } try { fs.writeFileSync(dataFile, JSON.stringify(state)); } catch {} });
app.on('window-all-closed', (e) => e.preventDefault()); // reste actif dans la barre des menus
