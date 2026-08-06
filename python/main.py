from flask import Flask, jsonify
from flask_cors import CORS
from waitress import serve
import requests
import datetime
import time
import json
import os

app = Flask(__name__)
CORS(app)

STOPS_FILE = os.path.join(os.path.dirname(__file__), 'stops.json')
API_URL    = "https://www.stops.lt/rigaapp/read.php"
VIVI_URL   = "https://trainmap.vivi.lv/api/trainGraph"

HEADERS = {
    "Origin-Custom": "stops.lt",
    "Referer":       "https://stops.lt/",
    "User-Agent":    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
}

def load_stops():
    with open(STOPS_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)['stops']

def seconds_from_midnight():
    # Izmanto Rīgas laiku UTC+3, nevis lokālo servera laiku
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=3)))
    return now.hour * 3600 + now.minute * 60 + now.second

def parse_departures(raw_text):
    lines = raw_text.strip().split('\n')
    now_sec = seconds_from_midnight()
    departures = []

    for line in lines[1:]:
        line = line.strip()
        if not line:
            continue
        parts = line.split(',')
        if len(parts) < 6:
            continue

        transport_type = parts[0]          # bus, trol, tram, train
        route          = parts[1]
        direction      = parts[2]
        scheduled_sec  = int(parts[3])
        transport_id   = int(parts[4])     # brauciena ID (ne reāllaiks)
        destination    = parts[5]

        sched_min = round((scheduled_sec - now_sec) / 60)
        if sched_min < -1:
            continue

        departures.append({
            "type":          transport_type,
            "route":         route,
            "direction":     direction,
            "destination":   destination,
            "scheduled_min": sched_min,
            "scheduled_sec": scheduled_sec,
            "transport_id":  transport_id,
        })

    departures.sort(key=lambda x: x['scheduled_sec'])
    return departures[:10]

def fetch_stop(stop_id):
    params = {
        "stopid": stop_id,
        "time":   str(int(time.time() * 1000)),
    }
    try:
        resp = requests.get(API_URL, params=params, headers=HEADERS, timeout=5)
        resp.raise_for_status()
        return parse_departures(resp.text)
    except Exception as e:
        return {"error": str(e)}

def fetch_train_stop():
    # Iegūst vilcienu datus no ViVi API stacijai Šķirotava.
    # Meklē pēc "irotava" (nevis "kirotava"), jo ķ ≠ k
    now_sec = seconds_from_midnight()
    try:
        resp = requests.get(VIVI_URL, timeout=8)
        resp.raise_for_status()
        trains = resp.json().get("data", [])
    except Exception as e:
        return {"error": str(e)}

    departures = []
    for train in trains:
        stops = train.get("stops", [])

        # Meklē Šķirotava pieturu maršrutā
        ski_idx = next(
            (i for i, s in enumerate(stops) if "irotava" in s.get("title", "").lower()),
            -1
        )
        if ski_idx == -1:
            continue

        dep_iso  = stops[ski_idx].get("departure", "")
        hhmm     = dep_iso[11:16] if len(dep_iso) >= 16 else ""
        if not hhmm or ":" not in hhmm:
            continue

        h, m      = int(hhmm[:2]), int(hhmm[3:5])
        sched_sec = h * 3600 + m * 60
        sched_min = round((sched_sec - now_sec) / 60)

        # Izlaiž jau aizbraukušos vilcienus
        if sched_min < -1:
            continue

        departures.append({
            "type":          "train",
            "route":         str(train.get("train", "?")),
            "direction":     train.get("direction", ""),
            "destination":   stops[-1].get("title", "?") if stops else "?",
            "origin":        stops[0].get("title", "") if stops else "",
            "scheduled_min": sched_min,
            "scheduled_sec": sched_sec,
            "transport_id":  0,
        })

    departures.sort(key=lambda x: x['scheduled_sec'])
    return departures[:10]

# ── Routes ──────────────────────────────────────────────

@app.route('/api/stops', methods=['GET'])
def get_stops():
    return jsonify(load_stops())

@app.route('/api/departures/<stop_id>', methods=['GET'])
def get_departures(stop_id):
    return jsonify({
        "stop_id":   stop_id,
        "timestamp": int(time.time()),
        "now_sec":   seconds_from_midnight(),
        "departures": fetch_stop(stop_id),
    })

@app.route('/api/all', methods=['GET'])
def get_all():
    stops  = load_stops()
    result = []
    for stop in stops:
        stop_id = stop.get('id', '').strip()

        # Ja id ir tukšs un nosaukums satur 'irotava' → vilcienu API
        if not stop_id:
            if "irotava" in stop.get("name", "").lower():
                departures = fetch_train_stop()
            else:
                departures = []
        else:
            departures = fetch_stop(stop_id)

        result.append({"stop": stop, "departures": departures})

    return jsonify({
        "timestamp": int(time.time()),
        "now_sec":   seconds_from_midnight(),
        "stops":     result,
    })

@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "time": int(time.time())})

if __name__ == '__main__':
    print("Transit Board API → http://localhost:5000")
    serve(app, host='0.0.0.0', port=5000)