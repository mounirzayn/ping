const { CATS, SITE_NAMES, groupOf, buildUrl, fillSelect } = window.PING_CATALOG;
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
// ---------- Formulaire : la catégorie décide des sites proposés ----------
fillSelect($('#fCat'), 'consoles');
function onCatChange() {
  const g = groupOf($('#fCat').value);
  $('#siteChips').innerHTML = g.sites.map((s) => `<label class="chip"><input type="checkbox" value="${s}" ${g.defaults.includes(s) ? 'checked' : ''}> ${SITE_NAMES[s]}</label>`).join('');
  $('#specBox').style.display = g.links.length ? '' : 'none';
  $('#specLinks').innerHTML = g.links.map(([n, u]) => `<button class="mini" data-spec="${u}">${n} ↗</button>`).join('');
  $('#cityBox').style.display = g.city ? '' : 'none';
  $('#cityHint').textContent = g.cityRequired ? 'Ville (obligatoire, ex : Melun)' : 'Ville (facultatif, ex : Melun)';
  $('#fStrict').checked = !!g.strict;
  $('#qHint').textContent = g.id === 'immobilier' ? 'Facultatif : ex. « T3, balcon »' : 'Plusieurs variantes possibles, séparées par des virgules';
  $('#fQuery').placeholder = { vehicules: 'clio 4, 208', immobilier: 'T3, balcon', multimedia: 'ps5, playstation 5', maison: 'canapé cuir', mode: 'air max 90', loisirs: 'lego star wars', famille: 'poussette yoyo' }[g.id] || 'que cherches-tu ?';
}
$('#fCat').onchange = onCatChange;
onCatChange();
$('#specLinks').onclick = (e) => { const b = e.target.closest('[data-spec]'); if (b) act('openBrowser', b.dataset.spec); };

const siteOf = (url) => (/leboncoin\./.test(url) ? 'Leboncoin' : /facebook\./.test(url) ? 'Marketplace' : /vinted\./.test(url) ? 'Vinted' : /ebay\./.test(url) ? 'eBay' : (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'Site'; } })());

$('#btnAdd').onclick = async () => {
  const variants = $('#fQuery').value.split(',').map((x) => x.trim()).filter(Boolean);
  const cat = $('#fCat').value;
  const custom = $('#fUrl').value.trim();
  const sites = [...document.querySelectorAll('#siteChips input:checked')].map((i) => i.value);
  const g = groupOf(cat);
  const city = g.city ? $('#fCity').value.trim() : '';
  if (!custom && g.cityRequired && !city) return toast('Indique la ville');
  if (!variants.length && !custom && (cat === 'tout' || !['immobilier', 'vehicules'].includes(g.id))) return toast('Écris ce que tu cherches');
  const group = crypto.randomUUID();
  const base = {
    group, city, name: variants[0] || (custom ? siteOf(custom) : CATS[cat].label + (city ? ' · ' + city : '')), cat, min: $('#fMin').value, max: $('#fMax').value,
    include: variants.join(', '), exclude: $('#fExclude').value, interval: +$('#fInterval').value, strict: $('#fStrict').checked,
  };
  const list = [];
  if (custom) {
    if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(custom)) return toast('Colle un lien complet qui commence par https://');
    list.push({ ...base, url: custom, site: siteOf(custom) });
  } else {
    if (!sites.length) return toast('Choisis au moins un site');
    sites.forEach((s) => list.push({ ...base, site: SITE_NAMES[s], url: buildUrl(s, variants[0], cat, base.min, base.max, city) }));
  }
  await act('addWatches', list);
  ['#fQuery', '#fMin', '#fMax', '#fExclude', '#fUrl', '#fCity'].forEach((s) => ($(s).value = ''));
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
      <div class="img" ${h.img ? `style="background-image:url('${esc(h.img)}')"` : ''}>${h.img ? '' : 'Pas de photo'}<span class="site s-${esc(h.site)}">${esc(h.site)}</span><button class="del" data-del="${esc(h.id)}" title="Supprimer cette annonce">✕</button></div>
      <div class="b">
        <div class="p">${eur(h.price)}</div>
        <div class="t">${esc(h.title)}</div>
        <div class="m">${esc(h.watchName)} · ${ago(h.at)}</div>
        <div class="go"><button data-ext="${esc(h.url)}">Voir l'annonce ↗</button></div>
      </div>
    </div>`).join('');
}
$('#feed').onclick = (e) => {
  const d = e.target.closest('[data-del]');
  if (d) { e.stopPropagation(); act('deleteHit', d.dataset.del); return; }
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
        <h3>${esc(w0.include || w0.name)}${w0.city ? ' · ' + esc(w0.city) : ''}</h3>${/leboncoin|facebook|vinted|ebay/.test(w0.url) ? '' : `<div class="f">Lien perso : ${esc(w0.url.slice(0, 60))}…</div>`}
        <div class="f">${esc(CATS[w0.cat]?.label || '')}${price} · toutes les ${w0.interval >= 60 ? w0.interval / 60 + ' min' : w0.interval + ' s'}${w0.exclude ? ' · sans : ' + esc(w0.exclude) : ''}</div>
        <div class="f">${total} nouvelle(s) annonce(s) trouvée(s)</div>
      </div>
      <div style="display:flex;gap:6px"><button class="mini" data-gedit="${esc(ws.map((w) => w.id).join(','))}">Modifier</button><button class="mini" data-gdel="${esc(ws.map((w) => w.id).join(','))}">Supprimer</button></div></div>
      ${w0.strict ? '<div class="f" style="color:var(--acc)">✓ Uniquement l\'objet (accessoires ignorés)</div>' : ''}
      <div class="edit" data-editbox="${esc(ws.map((w) => w.id).join(','))}" style="display:none">
        <label class="wide">Mots-clés<input data-k="include" value="${esc(w0.include || w0.name)}"></label>
        <label>Prix min (€)<input data-k="min" type="number" value="${esc(w0.min)}"></label>
        <label>Prix max (€)<input data-k="max" type="number" value="${esc(w0.max)}"></label>
        <label class="wide">Ignorer les annonces qui contiennent<input data-k="exclude" value="${esc(w0.exclude)}" placeholder="ex : housse, jeu, cassé"></label>
        <label class="wide" style="flex-direction:row;align-items:center;gap:8px;color:var(--txt)"><input type="checkbox" data-k="strict" ${w0.strict ? 'checked' : ''}> Uniquement l'objet lui-même (ignorer accessoires et jeux)</label>
        <div class="wide"><button class="mini" data-gsave="${esc(ws.map((w) => w.id).join(','))}" style="background:var(--acc);color:#04120a;border:0;font-weight:700">Enregistrer</button></div>
      </div>
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
let editing = false;
$('#groups').onclick = async (e) => {
  const ed = e.target.closest('[data-gedit]');
  if (ed) { const box = document.querySelector(`[data-editbox="${ed.dataset.gedit}"]`); const open = box.style.display === 'none'; box.style.display = open ? 'grid' : 'none'; editing = open; return; }
  const sv = e.target.closest('[data-gsave]');
  if (sv) {
    const box = document.querySelector(`[data-editbox="${sv.dataset.gsave}"]`);
    const v = (k) => box.querySelector(`[data-k="${k}"]`);
    await act('updateGroup', { ids: sv.dataset.gsave.split(','), include: v('include').value, min: v('min').value, max: v('max').value, exclude: v('exclude').value, strict: v('strict').checked });
    editing = false; toast('Recherche mise à jour'); render(); return;
  }
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
// Son « ping » joué par l'appli à chaque nouvelle annonce
let lastUnread = null;
function ding() {
  try {
    const c = window.__ac || (window.__ac = new AudioContext());
    [880, 1320].forEach((f, i) => { const o = c.createOscillator(), g = c.createGain(); o.frequency.value = f; o.type = 'sine';
      const t = c.currentTime + i * 0.12; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.3, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.4); });
  } catch {}
}
function render(s) {
  if (s) S = s;
  if (lastUnread !== null && S.unread > lastUnread && S.soundOn !== false && S.desktopNotif === false) ding(); // sinon la notification joue déjà le son
  lastUnread = S.unread;
  renderFeed(); if (!editing) renderGroups();
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
  $('#soundOn').checked = S.soundOn !== false;
  $('#ver').textContent = S.version || '';
  const u = S.update; $('#updBar').style.display = u ? 'flex' : 'none';
  if (u) {
    $('#updTxt').textContent = u.status === 'installing' ? 'Installation de la mise à jour… Ping va redémarrer.' : u.status === 'error' ? 'La mise à jour a échoué : télécharge-la depuis le site.' : `Nouvelle version de Ping disponible (${u.tag}).`;
    $('#btnUpd').hidden = u.status === 'installing';
  }
}
$('#btnUpd').onclick = () => act('installUpdate');
$('#btnCheckUpd').onclick = (e) => { e.preventDefault(); act('checkUpdate'); toast('Vérification…'); };

const webLink = () => (S.siteUrl || '') + 'app.html#' + S.ntfyTopic;
$('#btnWeb').onclick = () => act('openExternal', webLink());
$('#btnWebCopy').onclick = () => { navigator.clipboard.writeText(webLink()); toast('Lien copié'); };
$('#btnClear').onclick = () => act('clearUnread');
$('#btnClearAll').onclick = (e) => {
  const b = e.currentTarget;
  if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Confirmer : tout effacer ?'; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Effacer toutes les annonces'; }, 4000); return; }
  act('clearHits'); toast('Annonces effacées');
};
$('#btnCopy').onclick = () => { navigator.clipboard.writeText($('#topic').textContent); toast('Code copié'); };
$('#btnTest').onclick = () => { act('testPush'); toast('Alerte de test envoyée'); };
$('#btnPause').onclick = () => act('pauseAll');
$('#desktopNotif').onchange = (e) => act('setDesktop', e.target.checked);
$('#soundOn').onchange = (e) => act('setSound', e.target.checked);
$('#btnSound').onclick = () => ding();
$('#btnTopic').onclick = () => {
  const v = $('#topicEdit').value.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (v.length < 6) return toast('6 caractères minimum');
  act('setTopic', v); toast('Code enregistré');
};
document.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => act('openBrowser', b.dataset.open)));

window.ping.onState(render);
window.ping.getState().then(render);
setInterval(() => render(), 15000);
