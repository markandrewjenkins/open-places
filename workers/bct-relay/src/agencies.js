// The relay's allow-list: every agency it will fetch for a browser, with its upstream GTFS-Realtime URLs and the
// credit line its terms ask for. Nothing outside this list is ever fetched (the relay is not an open proxy).
// Only feeds that need no key are here. Keep ids in step with pipelines/blink/agencies.py (static GTFS) and
// site/src/blink/regions.js (the page's regions).
//
//   feeds: { vehicles?, trips?, alerts? }   upstream URLs (any can be missing: BART has no vehicle positions)
//   short: (route_id) => short name         optional, for the `route` field and ?route= filter
//   ttl:   seconds an upstream copy is reused (≥ 15)
//   big:   true when trip updates are too heavy to decode inside Workers Free's 10 ms CPU budget: the relay only
//          passes those through (trips.pb) and the page decodes them

const BCT = (op) => ({
  vehicles: `https://bct.tmix.se/gtfs-realtime/vehicleupdates.pb?operatorIds=${op}`,
  trips: `https://bct.tmix.se/gtfs-realtime/tripupdates.pb?operatorIds=${op}`,
  alerts: `https://bct.tmix.se/gtfs-realtime/alerts.pb?operatorIds=${op}`,
});
export const BCT_CREDIT = "Contains information licensed under BC Transit's Open Data Terms of Use. Not endorsed by BC Transit.";
const bctShort = (id) => (id ? id.replace(/-[A-Z]+$/, "") : null);   // "95-VIC" → "95"

// BC Transit systems: operatorIds from https://www.bctransit.com/open-data (checked 2026-11-13); all keyless
const BCT_SYSTEMS = {
  victoria: 48, nanaimo: 41, kelowna: 47, kamloops: 46, "fraser-valley": 13, "comox-valley": 45, "cowichan-valley": 10,
  "campbell-river": 12, "port-alberni": 11, squamish: 43, whistler: 44, pemberton: 50, "sunshine-coast": 18, "powell-river": 29,
  "salt-spring": 39, "west-coast": 51, "mount-waddington": 17, vernon: 14, "south-okanagan": 15, "west-kootenay": 20,
  "east-kootenay": 21, "creston-valley": 16, revelstoke: 36, merritt: 37, ashcroft: 38, clearwater: 35, "100-mile-house": 34,
  "williams-lake": 33, quesnel: 32, "prince-george": 22, smithers: 31, skeena: 26, "prince-rupert": 23, "fort-st-john": 28,
  "dawson-creek": 27,
};

export const AGENCIES = {
  ...Object.fromEntries(Object.entries(BCT_SYSTEMS).map(([id, op]) => [id, {
    name: `BC Transit (${id})`, feeds: BCT(op), credit: BCT_CREDIT, short: bctShort, ttl: 15, big: op === 48,
  }])),
  "king-county": {
    name: "King County Metro", ttl: 15, big: true, credit: "Transit scheduling, geographic, and real-time data provided by permission of King County.",
    feeds: { vehicles: "https://s3.amazonaws.com/kcm-alerts-realtime-prod/vehiclepositions.pb", trips: "https://s3.amazonaws.com/kcm-alerts-realtime-prod/tripupdates.pb",
      alerts: "https://s3.amazonaws.com/kcm-alerts-realtime-prod/alerts.pb" },
  },
  ttc: {
    name: "TTC", ttl: 15, big: true, credit: "Contains information licensed under the Open Government Licence – Toronto.",
    feeds: { vehicles: "https://bustime.ttc.ca/gtfsrt/vehicles", trips: "https://bustime.ttc.ca/gtfsrt/trips", alerts: "https://bustime.ttc.ca/gtfsrt/alerts" },
  },
  calgary: {
    name: "Calgary Transit", ttl: 30, big: true, credit: "Contains information licensed under the Open Government Licence – City of Calgary.",
    feeds: { vehicles: "https://data.calgary.ca/download/am7c-qe3u/application%2Foctet-stream", trips: "https://data.calgary.ca/download/gs4m-mdc2/application%2Foctet-stream",
      alerts: "https://data.calgary.ca/download/jhgn-ynqj/application%2Foctet-stream" },
  },
  edmonton: {
    name: "Edmonton Transit Service", ttl: 15, big: true, credit: "Contains data from the City of Edmonton Open Data Terms of Use.",
    feeds: { vehicles: "https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/Vehicle/VehiclePositions.pb", trips: "https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/TripUpdate/TripUpdates.pb",
      alerts: "https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/Alert/Alerts.pb" },
  },
  mbta: {
    name: "MBTA", ttl: 15, big: true, credit: "Data provided by MassDOT / MBTA under the MassDOT Developers License Agreement.",
    feeds: { vehicles: "https://cdn.mbta.com/realtime/VehiclePositions.pb", trips: "https://cdn.mbta.com/realtime/TripUpdates.pb", alerts: "https://cdn.mbta.com/realtime/Alerts.pb" },
  },
  sacrt: {
    name: "SacRT", ttl: 15, credit: "Data from Sacramento Regional Transit (SacRT) under its data licence agreement.",
    feeds: { vehicles: "https://bustime.sacrt.com/gtfsrt/vehicles", trips: "https://bustime.sacrt.com/gtfsrt/trips", alerts: "https://bustime.sacrt.com/gtfsrt/alerts" },
  },
  bart: {
    name: "BART", ttl: 15, credit: "Schedule and real-time data from BART under the BART Developer License Agreement.",
    feeds: { trips: "https://api.bart.gov/gtfsrt/tripupdate.aspx", alerts: "https://api.bart.gov/gtfsrt/alerts.aspx" },
  },
};
