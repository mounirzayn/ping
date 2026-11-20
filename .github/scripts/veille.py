"""Veille Ping : toutes les 10 min, vérifie que chaque ordinateur envoie son état (toutes les 30 min).
Plus rien depuis 50 min = la surveillance est coupée : on prévient le téléphone (une seule fois par coupure)."""
import json, os, time, urllib.request, urllib.parse
from datetime import datetime, timezone, timedelta

NTFY = 'https://ntfy.sh/'
APP = 'https://mounirzayn.github.io/ping/app.html'
LIMIT = 50 * 60

def poll(topic, since, extra=''):
    url = f"{NTFY}{urllib.parse.quote(topic)}/json?poll=1&since={since}{extra}"
    with urllib.request.urlopen(url, timeout=20) as r:
        return [json.loads(l) for l in r.read().decode().splitlines() if l.strip()]

def paris(ts):
    # heure de Paris (UTC+1 l'hiver, UTC+2 l'été) sans dépendance externe
    d = datetime.fromtimestamp(ts, timezone.utc)
    y = d.year
    last_sun = lambda m: max(datetime(y, m, day, 1, tzinfo=timezone.utc) for day in range(25, 32) if datetime(y, m, day).weekday() == 6)
    off = 2 if last_sun(3) <= d < last_sun(10) else 1
    return (d + timedelta(hours=off)).strftime('%H:%M')

topics = [t.strip() for t in os.environ.get('PING_TOPICS', '').replace('\n', ',').split(',') if t.strip()]
now = time.time()
for t in topics:
    try:
        vie = [m for m in poll(t + '-etat', '24h') if m.get('event') == 'message']
        if not vie:
            print(t[:10], 'aucun signe de vie sur 24 h : ignoré'); continue
        last = max(m['time'] for m in vie)
        age = now - last
        if age < LIMIT:
            print(t[:10], f'ok ({int(age // 60)} min)'); continue
        deja = [m for m in poll(t, str(int(last)), '&tags=ping-coupe') if m.get('event') == 'message']
        if deja:
            print(t[:10], 'coupure déjà signalée'); continue
        body = json.dumps({
            'topic': t, 'title': '⚠️ Ping est coupé',
            'message': f"Ton ordinateur ne surveille plus depuis {paris(last)}. Rallume-le ou rouvre Ping. "
                       "En attendant, ton espace Ping affiche tes recherches en liens directs.",
            'tags': ['ping-coupe'], 'priority': 4, 'click': APP,
        }).encode()
        urllib.request.urlopen(urllib.request.Request(NTFY, data=body, headers={'Content-Type': 'application/json'}), timeout=20)
        print(t[:10], 'ALERTE envoyée')
    except Exception as e:
        print(t[:10], 'erreur', e)
