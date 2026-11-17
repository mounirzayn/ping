// Ping : appli Mac avec navigateur intégré. Surveille les recherches et notifie les nouvelles annonces.
const { app, BrowserWindow, ipcMain, Notification, shell, Tray, Menu, nativeImage, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const SITE = 'https://mounirzayn.github.io/ping/';
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
const publicState = () => ({ ...state, siteUrl: SITE, watches: state.watches.map(({ seen, ...w }) => w) });
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
  const out = new Map();
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href;
    let id = null, site = null;
    for (const [p, s] of pats) { const m = href.match(p); if (m) { id = m[1]; site = s; break; } }
    if (!id || out.has(id)) continue;
    const text = (a.innerText || a.getAttribute('aria-label') || a.title || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const pm = text.match(/(\d[\d\s  .]*(?:,\d{1,2})?)\s?(?:€|EUR)/);
    const price = pm ? parseFloat(pm[1].replace(/[\s  .]/g, '').replace(',', '.')) : null;
    const img = a.querySelector('img');
    out.set(id, { id: site + ':' + id, site, url: href.split('?')[0], title: text.slice(0, 160), price, img: img ? (img.currentSrc || img.src) : null });
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
    await bw.webContents.executeJavaScript('window.scrollTo(0, 1200); true').catch(() => {});
    await sleep(800);
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
      notify({ title: '⚠️ Ping en pause : ' + w.name, message: 'Le site demande une vérification ou une connexion. Clique pour la faire dans Ping.', url: w.url });
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

function matches(w, it) {
  if (w.min !== '' && w.min != null && it.price != null && it.price < +w.min) return false;
  if (w.max !== '' && w.max != null && it.price != null && it.price > +w.max) return false;
  const t = it.title.toLowerCase();
  const list = (s) => (s || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  if (list(w.exclude).some((x) => t.includes(x))) return false;
  const incl = list(w.include);
  return !incl.length || incl.some((x) => t.includes(x));
}

// ---------- Notifications : Mac + téléphone (ntfy) ----------
function notify({ title, message, url, img }) {
  if (state.desktopNotif !== false && Notification.isSupported()) {
    const n = new Notification({ title, body: message, silent: false });
    n.on('click', () => openBrowser(url));
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
  if (wc.getType() === 'webview') {
    wc.setWindowOpenHandler(({ url }) => { wc.loadURL(url); return { action: 'deny' }; });
  }
});

// ---------- Actions depuis l'interface ----------
ipcMain.handle('getState', () => publicState());
const ALLOWED_URL = /^https:\/\/(www\.)?(leboncoin\.fr|facebook\.com|vinted\.fr|ebay\.fr)\//;
function doAction(type, p, fromWeb = false) {
  const find = (id) => state.watches.find((w) => w.id === id);
  switch (type) {
    case 'addWatches': {
      const list = (Array.isArray(p) ? p : []).filter((w) => w && ALLOWED_URL.test(w.url || '')).slice(0, 8).map((w) => ({
        name: String(w.name || 'Ping').slice(0, 60), site: String(w.site || '').slice(0, 20), cat: String(w.cat || 'tout'),
        url: w.url, min: w.min ?? '', max: w.max ?? '', include: String(w.include || ''), exclude: String(w.exclude || '').slice(0, 300),
        interval: Math.max(MIN_INTERVAL, +w.interval || 60),
        id: crypto.randomUUID(), seen: [], primed: false, count: 0, status: 'pending', active: true,
      }));
      state.watches.push(...list); save(); scheduleAll(); break;
    }
    case 'toggle': { const w = find(p); if (w) { w.active = !w.active; save(); scheduleAll(); } break; }
    case 'delete': state.watches = state.watches.filter((w) => w.id !== p); save(); scheduleAll(); break;
    case 'checkNow': if (find(p)) enqueue(() => check(p, true)); break;
    case 'pauseAll': { const any = state.watches.some((w) => w.active); state.watches.forEach((w) => (w.active = !any)); save(); scheduleAll(); break; }
    case 'refresh': pushState(); break;
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
});
app.on('second-instance', showMain);
app.on('activate', showMain);
app.on('before-quit', () => { quitting = true; try { fs.writeFileSync(dataFile, JSON.stringify(state)); } catch {} });
app.on('window-all-closed', (e) => e.preventDefault()); // reste actif dans la barre des menus
