const CATS = {
  consoles: { label: 'Consoles & jeux vidéo', lbc: 43 },
  voitures: { label: 'Voitures', lbc: 2 },
  motos: { label: 'Motos', lbc: 3 },
  telephones: { label: 'Téléphones', lbc: 17 },
  informatique: { label: 'Informatique', lbc: 15 },
  tout: { label: 'Toutes catégories', lbc: null },
};
const SITE_NAMES = { lbc: 'Leboncoin', fb: 'Marketplace', vinted: 'Vinted', ebay: 'eBay' };
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const act = (t, p) => window.ping.action(t, p);
let S = { watches: [], hits: [], unread: 0, ntfyTopic: '', desktopNotif: true };

function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 2200); }
const ago = (t) => { if (!t) return 'pas encore'; const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `il y a ${s} s` : s < 3600 ? `il y a ${Math.round(s / 60)} min` : s < 86400 ? `il y a ${Math.round(s / 3600)} h` : `il y a ${Math.round(s / 86400)} j`; };
const eur = (p) => (p == null ? 'Prix non indiqué' : p === 0 ? 'Gratuit' : p.toLocaleString('fr-FR') + ' €');

// ---------- Navigation ----------
function go(v) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  document.querySelectorAll('.view').forEach((x) => x.classList.toggle('on', x.id === 'v-' + v));
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => go(b.dataset.v)));

// ---------- Construction des URL de recherche ----------
$('#fCat').innerHTML = Object.entries(CATS).map(([k, c]) => `<option value="${k}">${c.label}</option>`).join('');
function buildUrl(site, q, catKey, min, max) {
  const cat = CATS[catKey];
  const query = q || (catKey !== 'tout' ? cat.label : '');
  let u;
  if (site === 'lbc') {
    u = new URL('https://www.leboncoin.fr/recherche');
    if (cat.lbc) u.searchParams.set('category', cat.lbc);
    if (q) u.searchParams.set('text', q);
    if (min || max) u.searchParams.set('price', `${min || 'min'}-${max || 'max'}`);
    u.searchParams.set('sort', 'time'); u.searchParams.set('order', 'desc');
  } else if (site === 'fb') {
    u = new URL('https://www.facebook.com/marketplace/search/');
    u.searchParams.set('query', query); u.searchParams.set('sortBy', 'creation_time_descend');
    if (min) u.searchParams.set('minPrice', min); if (max) u.searchParams.set('maxPrice', max);
  } else if (site === 'vinted') {
    u = new URL('https://www.vinted.fr/catalog');
    u.searchParams.set('search_text', query); u.searchParams.set('order', 'newest_first');
    if (min) u.searchParams.set('price_from', min); if (max) u.searchParams.set('price_to', max);
  } else {
    u = new URL('https://www.ebay.fr/sch/i.html');
    u.searchParams.set('_nkw', query); u.searchParams.set('_sop', '10');
    if (min) u.searchParams.set('_udlo', min); if (max) u.searchParams.set('_udhi', max);
  }
  return u.toString();
}
const siteOf = (url) => (/leboncoin/.test(url) ? 'Leboncoin' : /facebook/.test(url) ? 'Marketplace' : /vinted/.test(url) ? 'Vinted' : /ebay/.test(url) ? 'eBay' : 'Site');

$('#btnAdd').onclick = async () => {
  const variants = $('#fQuery').value.split(',').map((x) => x.trim()).filter(Boolean);
  const cat = $('#fCat').value;
  const custom = $('#fUrl').value.trim();
  const sites = [...document.querySelectorAll('.sites input:checked')].map((i) => i.value);
  if (!variants.length && !custom) return toast('Écris ce que tu cherches');
  const group = crypto.randomUUID();
  const base = {
    group, name: variants[0] || 'Recherche', cat, min: $('#fMin').value, max: $('#fMax').value,
    include: variants.join(', '), exclude: $('#fExclude').value, interval: +$('#fInterval').value,
  };
  const list = [];
  if (custom) {
    if (!/^https:\/\/(www\.)?(leboncoin\.fr|facebook\.com|vinted\.fr|ebay\.fr)\//.test(custom)) return toast('Adresse non prise en charge');
    list.push({ ...base, url: custom, site: siteOf(custom) });
  } else {
    if (!sites.length) return toast('Choisis au moins un site');
    sites.forEach((s) => list.push({ ...base, site: SITE_NAMES[s], url: buildUrl(s, variants[0], cat, base.min, base.max) }));
  }
  await act('addWatches', list);
  ['#fQuery', '#fMin', '#fMax', '#fExclude', '#fUrl'].forEach((s) => ($(s).value = ''));
  toast('Surveillance lancée');
  go('pings');
};

// ---------- Annonces ----------
function renderFeed() {
  const el = $('#feed');
  if (!S.hits.length) {
    const any = S.watches.length;
    el.innerHTML = `<div class="empty" style="grid-column:1/-1"><b>${any ? 'Aucune nouvelle annonce pour le moment' : 'Aucune recherche en cours'}</b>${any ? 'Ping a mémorisé les annonces déjà en ligne. Tu seras prévenu dès qu\'une nouvelle sort.' : 'Crée ta première recherche dans « + Nouvelle recherche ».'}</div>`;
    return;
  }
  el.innerHTML = S.hits.slice(0, 200).map((h, i) => `
    <div class="hit ${i < S.unread ? 'new' : ''}">
      <div class="img" ${h.img ? `style="background-image:url('${esc(h.img)}')"` : ''}>${h.img ? '' : 'Pas de photo'}<span class="site s-${esc(h.site)}">${esc(h.site)}</span></div>
      <div class="b">
        <div class="p">${eur(h.price)}</div>
        <div class="t">${esc(h.title)}</div>
        <div class="m">${esc(h.watchName)} · ${ago(h.at)}</div>
        <div class="go"><button data-ext="${esc(h.url)}">Voir l'annonce ↗</button></div>
      </div>
    </div>`).join('');
}
$('#feed').onclick = (e) => {
  const b = e.target.closest('[data-ext]');
  const card = e.target.closest('.hit');
  const url = b ? b.dataset.ext : card ? card.querySelector('[data-ext]').dataset.ext : null;
  if (url) act('openExternal', url);
};

// ---------- Recherches (groupées par recherche, une ligne par site) ----------
const STATUS = { ok: 'Surveille', blocked: 'Vérification demandée par le site', error: 'Erreur de lecture', empty: 'Aucune annonce lue', pending: 'Démarrage…' };
function renderGroups() {
  const el = $('#groups');
  if (!S.watches.length) { el.innerHTML = `<div class="empty" style="grid-column:1/-1"><b>Aucune recherche</b>Clique sur « + Nouvelle recherche » pour commencer.</div>`; return; }
  const groups = new Map();
  for (const w of S.watches) {
    const k = w.group || `${w.name}|${w.cat}|${w.min}|${w.max}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(w);
  }
  el.innerHTML = [...groups.values()].map((ws) => {
    const w0 = ws[0];
    const total = ws.reduce((n, w) => n + (w.count || 0), 0);
    const price = w0.min || w0.max ? ` · ${w0.min ? 'de ' + w0.min + ' €' : ''}${w0.min && w0.max ? ' ' : ''}${w0.max ? "jusqu'à " + w0.max + ' €' : ''}` : '';
    return `<div class="g">
      <div class="top"><div>
        <h3>${esc(w0.include || w0.name)}</h3>
        <div class="f">${esc(CATS[w0.cat]?.label || '')}${price} · toutes les ${w0.interval >= 60 ? w0.interval / 60 + ' min' : w0.interval + ' s'}${w0.exclude ? ' · sans : ' + esc(w0.exclude) : ''}</div>
        <div class="f">${total} nouvelle(s) annonce(s) trouvée(s)</div>
      </div>
      <button class="mini" data-gdel="${esc(ws.map((w) => w.id).join(','))}">Supprimer</button></div>
      <div class="rows">${ws.map((w) => `
        <div class="row">
          <span class="dot ${w.active ? esc(w.status) : ''}"></span>
          <span class="n">${esc(w.site)}</span>
          <span class="st">${w.active ? esc(STATUS[w.status] || '') : 'En pause'} · vérifié ${ago(w.lastCheck)}${w.statusMsg ? ' · ' + esc(w.statusMsg) : ''}</span>
          <span class="acts">
            ${w.status === 'blocked' ? `<button class="mini" data-a="open" data-id="${w.id}">Débloquer</button>` : ''}
            <button class="mini" data-a="now" data-id="${w.id}" title="Vérifier maintenant">↻</button>
            <button class="mini" data-a="toggle" data-id="${w.id}">${w.active ? 'Pause' : 'Reprendre'}</button>
            <button class="mini" data-a="open" data-id="${w.id}" title="Voir la recherche dans le navigateur Ping">Voir</button>
          </span>
        </div>`).join('')}</div>
    </div>`;
  }).join('');
}
$('#groups').onclick = async (e) => {
  const del = e.target.closest('[data-gdel]');
  if (del) {
    if (del.dataset.sure !== '1') { del.dataset.sure = '1'; del.textContent = 'Confirmer ?'; return; }
    for (const id of del.dataset.gdel.split(',')) await act('delete', id);
    return toast('Recherche supprimée');
  }
  const b = e.target.closest('button[data-a]'); if (!b) return;
  const w = S.watches.find((x) => x.id === b.dataset.id); if (!w) return;
  if (b.dataset.a === 'open') return act('openBrowser', w.url);
  if (b.dataset.a === 'now') { toast('Vérification lancée'); return act('checkNow', w.id); }
  if (b.dataset.a === 'toggle') return act('toggle', w.id);
};

// ---------- Rendu global ----------
function render(s) {
  if (s) S = s;
  renderFeed(); renderGroups();
  const active = S.watches.filter((w) => w.active);
  const blocked = active.filter((w) => w.status === 'blocked').length;
  const dot = $('#globalDot'), txt = $('#globalTxt');
  if (!S.watches.length) { dot.className = 'dot'; txt.textContent = 'Aucune recherche'; }
  else if (!active.length) { dot.className = 'dot'; txt.textContent = 'En pause'; }
  else if (blocked) { dot.className = 'dot blocked'; txt.textContent = `${blocked} site(s) demandent une vérification`; }
  else { dot.className = 'dot ok'; txt.textContent = `Surveillance active · ${active.length} site(s)`; }
  const ub = $('#unreadBadge'); ub.hidden = !S.unread; ub.textContent = S.unread;
  $('#btnPause').textContent = active.length ? 'Tout mettre en pause' : 'Tout reprendre';
  $('#topic').textContent = S.ntfyTopic;
  if (document.activeElement !== $('#topicEdit')) $('#topicEdit').value = S.ntfyTopic;
  $('#desktopNotif').checked = S.desktopNotif !== false;
}

const webLink = () => (S.siteUrl || '') + 'app.html#' + S.ntfyTopic;
$('#btnWeb').onclick = () => act('openExternal', webLink());
$('#btnWebCopy').onclick = () => { navigator.clipboard.writeText(webLink()); toast('Lien copié'); };
$('#btnClear').onclick = () => act('clearUnread');
$('#btnCopy').onclick = () => { navigator.clipboard.writeText($('#topic').textContent); toast('Code copié'); };
$('#btnTest').onclick = () => { act('testPush'); toast('Alerte de test envoyée'); };
$('#btnPause').onclick = () => act('pauseAll');
$('#desktopNotif').onchange = (e) => act('setDesktop', e.target.checked);
$('#btnTopic').onclick = () => {
  const v = $('#topicEdit').value.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (v.length < 6) return toast('6 caractères minimum');
  act('setTopic', v); toast('Code enregistré');
};
document.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => act('openBrowser', b.dataset.open)));

window.ping.onState(render);
window.ping.getState().then(render);
setInterval(() => render(), 15000);
