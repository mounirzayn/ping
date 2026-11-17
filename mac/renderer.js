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
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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
    u.searchParams.set('query', query);
    u.searchParams.set('sortBy', 'creation_time_descend');
    if (min) u.searchParams.set('minPrice', min);
    if (max) u.searchParams.set('maxPrice', max);
  } else if (site === 'vinted') {
    u = new URL('https://www.vinted.fr/catalog');
    u.searchParams.set('search_text', query);
    u.searchParams.set('order', 'newest_first');
    if (min) u.searchParams.set('price_from', min);
    if (max) u.searchParams.set('price_to', max);
  } else {
    u = new URL('https://www.ebay.fr/sch/i.html');
    u.searchParams.set('_nkw', query);
    u.searchParams.set('_sop', '10');
    if (min) u.searchParams.set('_udlo', min);
    if (max) u.searchParams.set('_udhi', max);
  }
  return u.toString();
}

function siteOf(url) {
  if (/leboncoin/.test(url)) return 'Leboncoin';
  if (/facebook/.test(url)) return 'Marketplace';
  if (/vinted/.test(url)) return 'Vinted';
  if (/ebay/.test(url)) return 'eBay';
  return 'Site';
}

let S = { watches: [], hits: [], unread: 0, ntfyTopic: '', desktopNotif: true };
const act = (t, p) => window.ping.action(t, p);

$('#btnAdd').onclick = async () => {
  const name = $('#fName').value.trim() || $('#fQuery').value.trim() || CATS[$('#fCat').value].label;
  const base = { name, cat: $('#fCat').value, min: $('#fMin').value, max: $('#fMax').value, include: '', exclude: $('#fExclude').value, interval: +$('#fInterval').value };
  const custom = $('#fUrl').value.trim();
  const sites = [...document.querySelectorAll('.sites input:checked')].map((i) => i.value);
  const q = $('#fQuery').value.trim();
  const fresh = [];
  if (custom) {
    if (!/^https:\/\/(www\.)?(leboncoin\.fr|facebook\.com|vinted\.fr|ebay\.fr)\//.test(custom)) return alert('URL non prise en charge (Leboncoin, Facebook, Vinted ou eBay).');
    fresh.push({ ...base, url: custom, site: siteOf(custom) });
  } else {
    if (!sites.length) return alert('Choisis au moins un site.');
    if (!q && $('#fCat').value === 'tout') return alert('Ajoute des mots-clés ou choisis une catégorie.');
    sites.forEach((s) => fresh.push({ ...base, site: SITE_NAMES[s], url: buildUrl(s, q, $('#fCat').value, base.min, base.max) }));
  }
  await act('addWatches', fresh);
  ['#fName', '#fQuery', '#fMin', '#fMax', '#fExclude', '#fUrl'].forEach((s) => ($(s).value = ''));
};
const STATUS = { ok: 'Actif', blocked: 'Vérification demandée par le site', error: 'Erreur', empty: 'Aucune annonce lue', pending: 'Premier passage en cours…' };
const ago = (t) => { if (!t) return 'jamais'; const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `il y a ${s} s` : s < 3600 ? `il y a ${Math.round(s / 60)} min` : `il y a ${Math.round(s / 3600)} h`; };

function renderWatches(watches) {
  const el = $('#watchList');
  if (!watches.length) { el.innerHTML = '<div class="empty-state">Aucun ping. Crée ton premier au-dessus.</div>'; return; }
  el.innerHTML = watches.map((w) => `
    <div class="watch">
      <div>
        <div class="t"><span class="dot ${w.active ? esc(w.status) : ''}"></span>${esc(w.name)} <span class="m">· ${esc(w.site)}</span></div>
        <div class="m">${esc(CATS[w.cat]?.label || '')}${w.min || w.max ? ` · ${w.min || 0} à ${w.max || '∞'} €` : ''} · toutes les ${w.interval} s · ${w.count || 0} alerte(s)</div>
        <div class="m">${w.active ? esc(STATUS[w.status] || '') : 'En pause'}${w.statusMsg ? ' : ' + esc(w.statusMsg) : ''} · vérifié ${ago(w.lastCheck)}</div>
      </div>
      <div class="acts">
        <button class="ghost small" data-a="now" data-id="${w.id}">Vérifier</button>
        <button class="ghost small" data-a="toggle" data-id="${w.id}">${w.active ? 'Pause' : 'Reprendre'}</button>
        <button class="ghost small" data-a="open" data-id="${w.id}">Ouvrir</button>
        <button class="ghost small" data-a="del" data-id="${w.id}">✕</button>
      </div>
    </div>`).join('');
}

$('#watchList').onclick = async (e) => {
  const b = e.target.closest('button[data-a]'); if (!b) return;
  const w = S.watches.find((x) => x.id === b.dataset.id); if (!w) return;
  if (b.dataset.a === 'open') return act('openBrowser', w.url);
  if (b.dataset.a === 'now') return act('checkNow', w.id);
  if (b.dataset.a === 'toggle') return act('toggle', w.id);
  if (b.dataset.a === 'del' && confirm('Supprimer ce ping ?')) return act('delete', w.id);
};

function renderFeed(hits, unread) {
  const el = $('#feed');
  if (!hits.length) { el.innerHTML = '<div class="empty-state">Les nouvelles annonces apparaîtront ici en temps réel. Le premier passage mémorise les annonces déjà en ligne, ensuite seules les nouvelles déclenchent une alerte.</div>'; return; }
  el.innerHTML = hits.slice(0, 120).map((h, i) => `
    <a class="hit ${i < unread ? 'new' : ''}" href="#" data-url="${esc(h.url)}">
      <div class="img" style="${h.img ? `background-image:url('${esc(h.img)}')` : ''}"></div>
      <div class="b">
        <div class="p">${h.price != null ? h.price.toLocaleString('fr-FR') + ' €' : 'Prix ?'}</div>
        <div class="ti">${esc(h.title)}</div>
        <div class="meta">${esc(h.site)} · ${esc(h.watchName)} · ${ago(h.at)}</div>
      </div>
    </a>`).join('');
}

function render(s) {
  if (s) S = s;
  renderWatches(S.watches); renderFeed(S.hits, S.unread);
  const a = S.watches.filter((w) => w.active).length;
  $('#statWatches').textContent = `${a} ping${a > 1 ? 's' : ''} actif${a > 1 ? 's' : ''}`;
  $('#statHits').textContent = `${S.hits.length} alerte${S.hits.length > 1 ? 's' : ''}`;
  $('#btnPause').textContent = a ? 'Tout en pause' : 'Tout reprendre';
  $('#topic').textContent = S.ntfyTopic;
  if (document.activeElement !== $('#topicEdit')) $('#topicEdit').value = S.ntfyTopic;
  $('#desktopNotif').checked = S.desktopNotif !== false;
}

const webLink = () => (S.siteUrl || '') + 'app.html#' + S.ntfyTopic;
$('#btnWeb').onclick = () => act('openExternal', webLink());
$('#btnWebCopy').onclick = () => navigator.clipboard.writeText(webLink());
$('#btnClear').onclick = () => act('clearUnread');
$('#btnCopy').onclick = () => navigator.clipboard.writeText($('#topic').textContent);
$('#btnTest').onclick = () => act('testPush');
$('#btnBrowser').onclick = () => act('openBrowser');
$('#btnPause').onclick = () => act('pauseAll');
$('#desktopNotif').onchange = (e) => act('setDesktop', e.target.checked);
$('#btnTopic').onclick = () => {
  const v = $('#topicEdit').value.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (v.length < 6) return alert('6 caractères minimum (lettres, chiffres, - ou _).');
  act('setTopic', v);
};
$('#feed').onclick = (e) => { const a = e.target.closest('a[data-url]'); if (a) { e.preventDefault(); act('openBrowser', a.dataset.url); } };
document.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => act('openBrowser', b.dataset.open)));
window.addEventListener('focus', () => S.unread && setTimeout(() => act('clearUnread'), 4000));

window.ping.onState(render);
window.ping.getState().then(render);
setInterval(() => render(), 15000);
