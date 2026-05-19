// ── Configuration ────────────────────────────────────────
var API_URL = "https://www.stops.lt/rigaapp/read.php";

var STOPS_DATA = {
  "stops": [
    { "id": "2081", "name": "Prūšu iela",    "direction": "→ uz centru", "street": "Prūšu iela" },
    { "id": "2091", "name": "Prūšu iela",    "direction": "← no centra", "street": "Prūšu iela" },
    { "id": "0201", "name": "Ikšķiles iela", "direction": "← no centra", "street": "Latgales iela" },
    { "id": "0202", "name": "Ikšķiles iela", "direction": "→ uz centru", "street": "Latgales iela" },
    { "id": "0154", "name": "Ikšķiles iela", "direction": "→ uz centru", "street": "Lokomotīves iela" },
    { "id": "0155", "name": "Ikšķiles iela", "direction": "← no centra", "street": "Lokomotīves iela" },
  ]
};

var REQUEST_HEADERS = {
  "Origin-Custom": "stops.lt",
  "Referer":        "https://stops.lt/",
  "User-Agent":     "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

// ── Entry point ──────────────────────────────────────────
// Routes are selected via the `action` query parameter:
//   ?action=stops
//   ?action=departures&stop_id=1234
//   ?action=all
//   ?action=health  (default)
function doGet(e) {
  var params = e.parameter || {};
  var action = params.action || "health";
  var stopId  = params.stop_id || null;

  var result;

  switch (action) {
    case "stops":
      result = loadStops();
      break;

    case "departures":
      if (!stopId) {
        result = { error: "stop_id parameter is required" };
      } else {
        result = {
          stop_id:    stopId,
          timestamp:  Math.floor(Date.now() / 1000),
          now_sec:    secondsFromMidnight(),
          departures: fetchStop(stopId),
        };
      }
      break;

    case "all":
      var stops     = loadStops();
      var allStops  = [];
      for (var i = 0; i < stops.length; i++) {
        var stop = stops[i];
        if (!stop.id) {
          allStops.push({ stop: stop, departures: [] });
          continue;
        }
        allStops.push({ stop: stop, departures: fetchStop(stop.id) });
      }
      result = {
        timestamp: Math.floor(Date.now() / 1000),
        now_sec:   secondsFromMidnight(),
        stops:     allStops,
      };
      break;

    case "health":
    default:
      result = { status: "ok", time: Math.floor(Date.now() / 1000) };
      break;
  }

  var json     = JSON.stringify(result);
  var callback  = params.callback;

  // JSONP: wrap in callback when ?callback= is present (bypasses CORS redirect issue)
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Stop validation ──────────────────────────────────────
function validateStop(stop) {
  if (typeof stop !== "object" || stop === null || Array.isArray(stop)) {
    return false;
  }

  var id        = stop.id;
  var name      = stop.name;
  var direction = stop.direction;
  var street    = stop.street;

  // ID must be a 4-digit string
  if (typeof id !== "string" || id.length !== 4 || !/^\d{4}$/.test(id)) {
    return false;
  }
  // name must be a non-empty string ≤ 100 chars
  if (typeof name !== "string" || name.trim() === "" || name.length > 100) {
    return false;
  }
  // direction must be a non-empty string ≤ 100 chars
  if (typeof direction !== "string" || direction.trim() === "" || direction.length > 100) {
    return false;
  }
  // street must be a non-empty string ≤ 100 chars
  if (typeof street !== "string" || street.trim() === "" || street.length > 100) {
    return false;
  }

  return true;
}

// ── Load stops from embedded config ─────────────────────
function loadStops() {
  var data = STOPS_DATA;

  if (typeof data !== "object" || data === null ||
      !Array.isArray(data.stops)) {
    Logger.log("JSON struktūras kļūda: lauks 'stops' nav derīgs");
    return [];
  }

  var validStops = [];
  for (var i = 0; i < data.stops.length; i++) {
    var stop = data.stops[i];
    if (validateStop(stop)) {
      validStops.push(stop);
    } else {
      Logger.log("Nederīgs pieturas ieraksts: " + JSON.stringify(stop));
    }
  }
  return validStops;
}

// ── Time helpers ─────────────────────────────────────────
function secondsFromMidnight() {
  var now = new Date();
  return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
}

// ── Parse raw CSV departures text ────────────────────────
function parseDepartures(rawText) {
  var lines  = rawText.trim().split("\n");
  var nowSec = secondsFromMidnight();
  var departures = [];

  // Skip the first (header) line
  for (var i = 1; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;

    var parts = line.split(",");
    if (parts.length < 6) continue;

    var transportType = parts[0];   // bus, trol, tram, train
    var route         = parts[1];
    var direction     = parts[2];
    var scheduledSec  = parseInt(parts[3], 10);
    var transportId   = parseInt(parts[4], 10);
    var destination   = parts[5];

    var schedMin = Math.round((scheduledSec - nowSec) / 60);
    // Skip departures that left more than 1 minute ago
    if (schedMin < -1) continue;

    departures.push({
      type:          transportType,
      route:         route,
      direction:     direction,
      destination:   destination,
      scheduled_min: schedMin,
      scheduled_sec: scheduledSec,
      transport_id:  transportId,
    });
  }

  departures.sort(function(a, b) { return a.scheduled_sec - b.scheduled_sec; });
  return departures.slice(0, 10);
}

// ── Fetch departures for a single stop ───────────────────
function fetchStop(stopId) {
  var url = API_URL + "?stopid=" + encodeURIComponent(stopId) +
                      "&time="   + Date.now();
  var options = {
    method:            "get",
    headers:           REQUEST_HEADERS,
    muteHttpExceptions: true,
  };

  try {
    var resp = UrlFetchApp.fetch(url, options);
    if (resp.getResponseCode() !== 200) {
      return { error: "HTTP " + resp.getResponseCode() };
    }
    return parseDepartures(resp.getContentText());
  } catch (e) {
    return { error: e.toString() };
  }
}
