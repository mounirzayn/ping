// Cotes de référence : prix de REVENTE RAPIDE d'occasion en bon état, en France (fin 2026).
// C'est la base des Pépites : un prix qu'on peut vraiment obtenir en revendant vite, pas le prix demandé
// par les vendeurs optimistes. Ping les croise avec les ventes réelles qu'il relève quand il y en a assez.
// À ajuster ici si le marché bouge (une ligne = un modèle).

const N = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9+]+/g, ' ').replace(/\s+/g, ' ').trim();

const r = (rx, p, label, opt = {}) => ({ rx, p, label, ...opt });
const DIGI = '(?:digital|digitale|numerique|sans lecteur|edition digitale)';

// Cartes graphiques : du plus précis au plus général (4070 ti super avant 4070 ti avant 4070)
const GPU = {
  '5090': 2000, '5080': 850, '5070 ti': 620, '5070': 450, '5060 ti': 330, '5060': 260,
  '4090': 1500, '4080 super': 800, '4080': 750, '4070 ti super': 600, '4070 ti': 520, '4070 super': 460, '4070': 400, '4060 ti': 280, '4060': 230,
  '3090 ti': 650, '3090': 550, '3080 ti': 420, '3080': 360, '3070 ti': 290, '3070': 260, '3060 ti': 210, '3060': 180, '3050': 130,
  '2080 ti': 300, '2080 super': 240, '2080': 220, '2070 super': 190, '2070': 170, '2060 super': 150, '2060': 130,
  '1660 super': 100, '1660 ti': 100, '1660': 90, '1080 ti': 150, '1080': 110, '1070': 90,
  'rx 7900 xtx': 700, 'rx 7900 xt': 550, 'rx 7800 xt': 400, 'rx 7700 xt': 320, 'rx 7600': 200, 'rx 6950 xt': 450, 'rx 6900 xt': 400,
  'rx 6800 xt': 330, 'rx 6800': 280, 'rx 6750 xt': 240, 'rx 6700 xt': 220, 'rx 6650 xt': 180, 'rx 6600 xt': 170, 'rx 6600': 150, 'rx 580': 60,
};
const gpuRules = Object.entries(GPU).sort((a, b) => b[0].length - a[0].length).map(([k, p]) => {
  const parts = k.split(' ');
  const core = parts.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(' ?');
  const tail = parts.length === 1 || /^rx/.test(k) && parts.length === 2 ? '(?! ?(?:ti|super|xt|xtx)\\b)' : '';
  return { re: new RegExp(`\\b(?:rtx |gtx )?${core}${tail}\\b`), p, label: (/^rx/.test(k) ? 'Radeon ' : 'RTX ') + k.replace(/^rx /, 'RX ').toUpperCase() };
});

const IPHONE = [['17 pro max', 1050], ['17 pro', 950], ['air', 800], ['17', 750], ['16 pro max', 850], ['16 pro', 750], ['16 plus', 620], ['16e', 400], ['16', 580],
  ['15 pro max', 680], ['15 pro', 580], ['15 plus', 480], ['15', 450], ['14 pro max', 520], ['14 pro', 450], ['14 plus', 360], ['14', 340],
  ['13 pro max', 400], ['13 pro', 350], ['13 mini', 230], ['13', 280], ['12 pro max', 300], ['12 pro', 260], ['12 mini', 160], ['12', 200],
  ['11 pro max', 230], ['11 pro', 200], ['11', 160], ['se', 120], ['xr', 110], ['xs max', 130], ['xs', 110]]
  .map(([k, p]) => r(new RegExp(`\\biphone ?${k.replace(/ /g, ' ?')}(?! ?(?:pro|max|plus|mini|e)\\b)\\b`), p, 'iPhone ' + k.replace(/\b\w/g, (c) => c.toUpperCase()), { storage: true }));

const RULES = [
  // Consoles
  r(new RegExp(`\\bps5 ?pro\\b`), 550, 'PS5 Pro'),
  r(new RegExp(`\\bps5\\b(?=.*\\bslim\\b)(?=.*\\b${DIGI}\\b)`), 320, 'PS5 Slim Digital'),
  r(/\bps5\b(?=.*\bslim\b)|\bslim\b(?=.*\bps5\b)/, 380, 'PS5 Slim'),
  r(new RegExp(`\\bps5\\b(?=.*\\b${DIGI}\\b)`), 280, 'PS5 Digital'),
  r(/\bps5\b(?=.*\b(?:standard|lecteur|disque|blu ?ray|fat)\b)/, 340, 'PS5 standard'),
  r(/\b(?:ps5|playstation 5)\b/, 300, 'PS5 (version non précisée)', { vague: true }),
  r(/\bswitch 2\b/, 380, 'Switch 2'),
  r(/\bswitch\b(?=.*\boled\b)|\boled\b(?=.*\bswitch\b)/, 220, 'Switch OLED'),
  r(/\bswitch lite\b/, 110, 'Switch Lite'),
  r(/\bsteam deck\b(?=.*\boled\b)(?=.*\b(?:1 ?to|1 ?tb)\b)/, 500, 'Steam Deck OLED 1 To'),
  r(/\bsteam deck\b(?=.*\boled\b)/, 430, 'Steam Deck OLED'),
  r(/\bsteam deck\b(?=.*\b512\b)/, 320, 'Steam Deck 512 Go'),
  r(/\bsteam deck\b(?=.*\b256\b)/, 290, 'Steam Deck 256 Go'),
  r(/\bsteam deck\b(?=.*\b64\b)/, 250, 'Steam Deck 64 Go'),
  r(/\bsteam deck\b/, 270, 'Steam Deck (version non précisée)', { vague: true }),
  // iPhone
  ...IPHONE,
  // MacBook (puce Apple)
  ...[['air', 'm4', 900], ['air', 'm3', 800], ['air', 'm2', 650], ['air', 'm1', 450],
    ['', 'm4 max', 2200], ['', 'm4 pro', 1600], ['', 'm3 max', 1800], ['', 'm3 pro', 1300], ['', 'm2 max', 1500], ['', 'm2 pro', 1100], ['', 'm1 max', 1100], ['', 'm1 pro', 900],
    ['pro', 'm4', 1200], ['pro', 'm3', 1000], ['pro', 'm2', 750], ['pro', 'm1', 550]]
    .map(([fam, chip, p]) => r(new RegExp(`\\bmacbook\\b${fam ? `(?=.*\\b${fam}\\b)` : ''}(?=.*\\b${chip.replace(' ', ' ?')}${chip.includes(' ') ? '' : '(?! ?(?:pro|max)\\b)'}\\b)`), p,
      `MacBook ${fam ? fam[0].toUpperCase() + fam.slice(1) + ' ' : ''}${chip.toUpperCase()}`, { storage: true })),
  r(/\bmacbook\b(?=.*\b(?:i5|i7|i9|intel|core|20(?:0\d|1\d))\b)/, 200, 'MacBook Intel (ancien)'),
  // iPad Pro
  r(/\bipad pro\b(?=.*\bm4\b)/, 750, 'iPad Pro M4', { storage: true }),
  r(/\bipad pro\b(?=.*\bm2\b)/, 550, 'iPad Pro M2', { storage: true }),
  r(/\bipad pro\b(?=.*\bm1\b)/, 450, 'iPad Pro M1', { storage: true }),
  // Montres
  r(/\bapple watch\b(?=.*\bultra ?3\b)/, 550, 'Apple Watch Ultra 3'),
  r(/\bapple watch\b(?=.*\bultra ?2\b)/, 450, 'Apple Watch Ultra 2'),
  r(/\bapple watch\b(?=.*\bultra\b)/, 330, 'Apple Watch Ultra'),
  r(/\bapple watch\b(?=.*\b(?:series|serie|s)? ?11\b)/, 330, 'Apple Watch Series 11'),
  r(/\bapple watch\b(?=.*\b(?:series|serie|s)? ?10\b)/, 280, 'Apple Watch Series 10'),
  r(/\bapple watch\b(?=.*\b(?:series|serie|s) ?9\b)/, 220, 'Apple Watch Series 9'),
  r(/\bapple watch\b(?=.*\b(?:series|serie|s) ?8\b)/, 180, 'Apple Watch Series 8'),
  r(/\bapple watch\b(?=.*\b(?:series|serie|s) ?7\b)/, 140, 'Apple Watch Series 7'),
  r(/\bapple watch\b(?=.*\bse\b)/, 110, 'Apple Watch SE'),
  r(/\bfenix ?8\b/, 550, 'Garmin Fenix 8'), r(/\bfenix ?7(?: ?x)? ?pro\b/, 400, 'Garmin Fenix 7 Pro'), r(/\bfenix ?7\b/, 320, 'Garmin Fenix 7'), r(/\bfenix ?6\b/, 180, 'Garmin Fenix 6'),
  r(/\bepix\b(?=.*\bpro\b)/, 550, 'Garmin Epix Pro'), r(/\bepix\b/, 380, 'Garmin Epix'),
  r(/\bforerunner ?965\b/, 350, 'Forerunner 965'), r(/\bforerunner ?955\b/, 250, 'Forerunner 955'), r(/\bforerunner ?265\b/, 230, 'Forerunner 265'),
  r(/\bforerunner ?255\b/, 160, 'Forerunner 255'), r(/\bforerunner ?165\b/, 170, 'Forerunner 165'),
  r(/\btissot prx\b(?=.*\b(?:powermatic|automatique|automatic|80)\b)/, 450, 'Tissot PRX Powermatic 80'),
  r(/\btissot prx\b/, 220, 'Tissot PRX quartz'),
  // Audio, maison
  r(/\bairpods max\b/, 280, 'AirPods Max'),
  r(/\bdyson\b(?=.*\bgen ?5\b)/, 350, 'Dyson Gen5'), r(/\bdyson\b(?=.*\bv ?15\b)/, 280, 'Dyson V15'), r(/\bdyson\b(?=.*\bv ?12\b)/, 200, 'Dyson V12'),
  r(/\bdyson\b(?=.*\bv ?11\b)/, 170, 'Dyson V11'), r(/\bdyson\b(?=.*\bv ?10\b)/, 130, 'Dyson V10'), r(/\bdyson\b(?=.*\bv ?8\b)/, 90, 'Dyson V8'),
  r(/\bairwrap\b/, 280, 'Dyson Airwrap'), r(/\bsupersonic\b/, 180, 'Dyson Supersonic'),
  r(/\btm ?7\b/, 1000, 'Thermomix TM7'), r(/\btm ?6\b/, 750, 'Thermomix TM6'), r(/\btm ?5\b/, 350, 'Thermomix TM5'),
  // Drones, photo
  r(/\bmini ?4 ?pro\b/, 550, 'DJI Mini 4 Pro'), r(/\bmini ?3 ?pro\b/, 400, 'DJI Mini 3 Pro'), r(/\bmini ?4 ?k\b/, 200, 'DJI Mini 4K'),
  r(/\bdji\b(?=.*\bmini ?3\b)/, 280, 'DJI Mini 3'), r(/\bdji\b(?=.*\bmini ?2\b)/, 200, 'DJI Mini 2'),
  r(/\bair ?3 ?s\b/, 900, 'DJI Air 3S'), r(/\bdji\b(?=.*\bair ?3\b)/, 750, 'DJI Air 3'), r(/\bair ?2 ?s\b/, 550, 'DJI Air 2S'),
  r(/\bmavic ?3 ?pro\b/, 1500, 'DJI Mavic 3 Pro'), r(/\bmavic ?3\b/, 1100, 'DJI Mavic 3'), r(/\bavata ?2\b/, 450, 'DJI Avata 2'),
  r(/\ba7 ?(?:iv|4|m4)\b/, 1550, 'Sony A7 IV'), r(/\ba7 ?(?:iii|3|m3)\b/, 950, 'Sony A7 III'), r(/\ba7c ?(?:ii|2)\b/, 1500, 'Sony A7C II'), r(/\ba7c\b/, 900, 'Sony A7C'),
  r(/\br6 ?(?:mark ?ii|mk ?ii|ii|2)\b/, 1650, 'Canon R6 Mark II'), r(/\beos r6\b|\bcanon r6\b/, 1150, 'Canon R6'), r(/\b(?:eos|canon) r8\b/, 1100, 'Canon R8'),
  r(/\b(?:eos|canon) r7\b/, 1000, 'Canon R7'), r(/\b(?:eos|canon) r10\b/, 650, 'Canon R10'), r(/\b(?:eos|canon) r50\b/, 550, 'Canon R50'), r(/\b(?:eos|canon) rp\b/, 550, 'Canon RP'),
  r(/\beos r\b(?! ?\d)/, 750, 'Canon EOS R'),
  r(/\bx ?t5\b/, 1200, 'Fujifilm X-T5'), r(/\bx ?t4\b/, 850, 'Fujifilm X-T4'), r(/\bx ?t30\b/, 500, 'Fujifilm X-T30'), r(/\bx ?t3\b/, 550, 'Fujifilm X-T3'), r(/\bx ?s20\b/, 900, 'Fujifilm X-S20'),
];

const BUNDLE = /\+|\b(?:lot|pack|bundle)\b|\b(?:avec|plus|et)\b.{0,25}\b(?:jeux?|manettes?)\b|\b\d+ (?:jeux|manettes)\b/;
const PC = /\b(?:pc|tour|ordinateur|ordi|config|setup|unite centrale|uc)\b/;

// Renvoie { p, label, vague? } ou null si le modèle n'est pas identifiable avec certitude
function refFor(text, cat) {
  const t = N(text);
  // Cartes graphiques : carte seule, ou PC complet (estimation : la carte fait l'essentiel du prix)
  if (cat === 'informatique' || /\b(?:rtx|gtx|radeon|rx \d)\b/.test(t)) {
    for (const g of gpuRules) if (g.re.test(t)) {
      if (PC.test(t) && !/\bmacbook\b/.test(t)) return { p: Math.round(g.p * 1.5 + 150), label: `PC avec ${g.label} (estimation)`, estimate: true };
      return { p: g.p, label: g.label };
    }
  }
  for (const x of RULES) {
    if (!x.rx.test(t)) continue;
    let p = x.p;
    if (x.storage) p = Math.round(p * (/\b(?:2 ?to|2 ?tb)\b/.test(t) ? 1.4 : /\b(?:1 ?to|1 ?tb)\b/.test(t) ? 1.3 : /\b512\b/.test(t) ? 1.2 : /\b256\b/.test(t) ? 1.1 : 1));
    if (/\b(?:ps5|switch|steam deck)\b/.test(t) && BUNDLE.test(t)) p += 30; // jeux / 2e manette : un peu plus
    return { p, label: x.label, vague: !!x.vague };
  }
  return null;
}

module.exports = { refFor, N };
