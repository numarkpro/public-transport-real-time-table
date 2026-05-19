// ================================================================
// Transit Board — Google Apps Script Backend
// Деплой: Extensions → Apps Script → Deploy → New deployment
//         Type: Web App, Execute as: Me, Who has access: Anyone
// После деплоя скопируй URL и вставь в index.html (APPS_SCRIPT_URL)
// ================================================================

const STOPS_JSON = JSON.stringify({
  "stops": [
    { "id": "2091", "name": "Ikšķiles iela",  "direction": "← no centra", "street": "Prūšu iela" },
    { "id": "2081", "name": "Prūšu iela",     "direction": "→ uz centru", "street": "Prūšu iela" },
    { "id": "0155", "name": "Ikšķiles iela",  "direction": "← no centra", "street": "Lokomotīves iela", "group": "lok" },
    { "id": "0154", "name": "Ikšķiles iela",  "direction": "→ uz centru", "street": "Lokomotīves iela", "group": "lok" },
    { "id": "",     "name": "Šķirotava",      "direction": "",             "street": "Lokomotīves iela" },
    { "id": "0201", "name": "Ikšķiles iela",  "direction": "← no centra", "street": "Latgales iela" },
    { "id": "0202", "name": "Ikšķiles iela",  "direction": "→ uz centru", "street": "Latgales iela" }
  ]
});

const API_URL  = "https://www.stops.lt/rigaapp/read.php";
const VIVI_URL = "https://trainmap.vivi.lv/api/trainGraph";

// ── Entry point ─────────────────────────────────────────────
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || "all";

  let result;
  try {
    if (action === "stops")       result = loadStops();
    else if (action === "all")    result = getAllDepartures();
    else if (action === "health") result = { status: "ok", time: Math.floor(Date.now() / 1000) };
    else                          result = { error: "Unknown action: " + action };
  } catch (err) {
    result = { error: err.message };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Helpers ──────────────────────────────────────────────────
function loadStops() {
  return JSON.parse(STOPS_JSON).stops;
}

// Rīgas laiks UTC+3 → sekundes no pusnakts
function secondsFromMidnight() {
  const now = new Date();
  const rigaOffset = 3 * 60; // minūtes
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const rigaMin = (utcMin + rigaOffset) % (24 * 60);
  const rigaSec = rigaMin * 60 + now.getUTCSeconds();
  return rigaSec;
}

// ── stops.lt API ─────────────────────────────────────────────
function fetchStop(stopId) {
  const url = API_URL + "?stopid=" + encodeURIComponent(stopId)
            + "&time=" + Date.now();
  const options = {
    method: "get",
    headers: {
      "Origin-Custom": "stops.lt",
      "Referer":       "https://stops.lt/",
      "User-Agent":    "Mozilla/5.0"
    },
    muteHttpExceptions: true
  };

  try {
    const resp = UrlFetchApp.fetch(url, options);
    if (resp.getResponseCode() !== 200) {
      return { error: "HTTP " + resp.getResponseCode() };
    }
    return parseDepartures(resp.getContentText());
  } catch (e) {
    return { error: e.message };
  }
}

function parseDepartures(rawText) {
  const nowSec = secondsFromMidnight();
  const lines = rawText.trim().split("\n");
  const departures = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length < 6) continue;

    const transportType  = parts[0];
    const route          = parts[1];
    const direction      = parts[2];
    const scheduledSec   = parseInt(parts[3], 10);
    const transportId    = parseInt(parts[4], 10);
    const destination    = parts[5];

    const schedMin = Math.round((scheduledSec - nowSec) / 60);
    if (schedMin < -1) continue;

    departures.push({
      type:          transportType,
      route:         route,
      direction:     direction,
      destination:   destination,
      scheduled_min: schedMin,
      scheduled_sec: scheduledSec,
      transport_id:  transportId
    });
  }

  departures.sort((a, b) => a.scheduled_sec - b.scheduled_sec);
  return departures.slice(0, 10);
}

// ── ViVi trains API ──────────────────────────────────────────
function fetchTrainStop() {
  const nowSec = secondsFromMidnight();
  try {
    const resp = UrlFetchApp.fetch(VIVI_URL, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return { error: "HTTP " + resp.getResponseCode() };
    const trains = JSON.parse(resp.getContentText()).data || [];

    const departures = [];
    for (const train of trains) {
      const stops = train.stops || [];
      const skiIdx = stops.findIndex(s => (s.title || "").toLowerCase().includes("irotava"));
      if (skiIdx === -1) continue;

      const depIso = stops[skiIdx].departure || "";
      const hhmm   = depIso.length >= 16 ? depIso.substring(11, 16) : "";
      if (!hhmm || !hhmm.includes(":")) continue;

      const h = parseInt(hhmm.substring(0, 2), 10);
      const m = parseInt(hhmm.substring(3, 5), 10);
      const schedSec = h * 3600 + m * 60;
      const schedMin = Math.round((schedSec - nowSec) / 60);
      if (schedMin < -1) continue;

      departures.push({
        type:          "train",
        route:         String(train.train || "?"),
        direction:     train.direction || "",
        destination:   stops.length ? (stops[stops.length - 1].title || "?") : "?",
        origin:        stops.length ? (stops[0].title || "") : "",
        scheduled_min: schedMin,
        scheduled_sec: schedSec,
        transport_id:  0
      });
    }

    departures.sort((a, b) => a.scheduled_sec - b.scheduled_sec);
    return departures.slice(0, 10);
  } catch (e) {
    return { error: e.message };
  }
}

// ── /api/all equivalent ──────────────────────────────────────
function getAllDepartures() {
  const stops = loadStops();
  const result = [];

  for (const stop of stops) {
    const stopId = (stop.id || "").trim();
    let departures;

    if (!stopId) {
      // Vilcienu pietura (Šķirotava)
      departures = (stop.name || "").toLowerCase().includes("irotava")
        ? fetchTrainStop()
        : [];
    } else {
      departures = fetchStop(stopId);
    }

    result.push({ stop: stop, departures: departures });
  }

  return {
    timestamp: Math.floor(Date.now() / 1000),
    now_sec:   secondsFromMidnight(),
    stops:     result
  };
}