// Public Transit: the regions the page can show, each backed by one or more agencies with open data.
// An agency id is the same in three places: the network pipeline (pipelines/blink/agencies.py), the relay's
// allow-list (workers/bct-relay/src/agencies.js) and here. Bounding boxes and centres come from the built network
// (../data/blink/agencies/index.json); a region only names its agencies, its group in the picker and what's missing.
//
// live: "rt" = GTFS-Realtime vehicles, predictions and alerts through the relay; "trips" = predictions and alerts
// but no vehicle positions; "static" = timetables only (the live feed needs a key: listed, not wired).
// places: Open Places place ids this region serves (site/places/civic-data.js).

const BCT = [
  ["nanaimo", "Nanaimo"], ["kelowna", "Kelowna"], ["kamloops", "Kamloops"], ["fraser-valley", "Chilliwack & Central Fraser Valley"],
  ["comox-valley", "Comox Valley"], ["cowichan-valley", "Cowichan Valley"], ["campbell-river", "Campbell River"], ["port-alberni", "Port Alberni"],
  ["squamish", "Squamish"], ["whistler", "Whistler"], ["pemberton", "Pemberton Valley"], ["sunshine-coast", "Sunshine Coast"],
  ["powell-river", "Powell River"], ["salt-spring", "Salt Spring Island"], ["west-coast", "West Coast (Tofino–Ucluelet)"],
  ["mount-waddington", "Mount Waddington"], ["vernon", "Vernon & Shuswap"], ["south-okanagan", "Penticton & South Okanagan"],
  ["west-kootenay", "West Kootenay"], ["east-kootenay", "East Kootenay"], ["creston-valley", "Creston Valley"], ["revelstoke", "Revelstoke"],
  ["merritt", "Merritt"], ["ashcroft", "Ashcroft–Cache Creek–Clinton"], ["clearwater", "Clearwater"], ["100-mile-house", "100 Mile House"],
  ["williams-lake", "Williams Lake"], ["quesnel", "Quesnel"], ["prince-george", "Prince George"], ["smithers", "Smithers"],
  ["skeena", "Terrace, Kitimat & Hazeltons"], ["prince-rupert", "Prince Rupert"], ["fort-st-john", "Fort St. John"], ["dawson-creek", "Dawson Creek"],
];

export const REGIONS = [
  { id: "victoria", name: "Greater Victoria", short: "Victoria", group: "BC Transit", agencies: ["victoria"], live: "rt", tz: "America/Vancouver",
    places: ["crd", "victoria-city", "saanich", "oak-bay", "esquimalt", "view-royal", "colwood", "langford", "metchosin", "sooke", "highlands", "central-saanich", "north-saanich", "sidney"],
    spotlight: "95", center: [-123.40, 48.45], zoom: 11.2 },
  ...BCT.map(([id, name]) => ({ id, name, short: name.split(/[ (&,–]/)[0], group: "BC Transit", agencies: [id], live: "rt", tz: "America/Vancouver", places: [] })),
  { id: "vancouver", name: "Greater Vancouver", short: "Vancouver", group: "Canada", agencies: ["translink"], live: "static", tz: "America/Vancouver", places: ["metrovan"],
    missing: "TransLink's live feeds (vehicles, predictions, alerts) need a free TransLink developer key, so this region shows timetables only.", center: [-123.05, 49.25], zoom: 10.4 },
  { id: "toronto", name: "Toronto", group: "Canada", agencies: ["ttc"], live: "rt", tz: "America/Toronto", places: ["toronto"], center: [-79.39, 43.68], zoom: 10.8,
    missing: "GO Transit and the 905 agencies aren't included yet." },
  { id: "calgary", name: "Calgary", group: "Canada", agencies: ["calgary"], live: "rt", tz: "America/Edmonton", places: [], center: [-114.07, 51.04], zoom: 10.6 },
  { id: "edmonton", name: "Edmonton", group: "Canada", agencies: ["edmonton"], live: "rt", tz: "America/Edmonton", places: [], center: [-113.5, 53.54], zoom: 10.6 },
  { id: "seattle", name: "Seattle & King County", short: "Seattle", group: "United States", agencies: ["king-county"], live: "rt", tz: "America/Los_Angeles", places: ["seattle"],
    center: [-122.31, 47.6], zoom: 10.6,
    missing: "Sound Transit's own live feed (Link light rail, ST Express) is published through OneBusAway Puget Sound, which needs a key; King County Metro's buses, streetcars and water taxis are live." },
  { id: "sfbay", name: "SF Bay Area (BART)", short: "BART", group: "United States", agencies: ["bart"], live: "trips", tz: "America/Los_Angeles", places: ["sfbay"],
    center: [-122.2, 37.8], zoom: 9.8,
    missing: "BART publishes predictions and alerts but no train positions. Muni, AC Transit, Caltrain and the other Bay Area agencies are live through 511.org, which needs a free token." },
  { id: "sacramento", name: "Sacramento", group: "United States", agencies: ["sacrt"], live: "rt", tz: "America/Los_Angeles", places: ["sacramento"], center: [-121.45, 38.58], zoom: 10.6 },
  { id: "boston", name: "Boston (MBTA)", short: "Boston", group: "United States", agencies: ["mbta"], live: "rt", tz: "America/New_York", places: [], center: [-71.08, 42.35], zoom: 10.6 },
];
export const REGION = new Map(REGIONS.map((r) => [r.id, r]));

// Open Places places with no wired feed yet, and why (shown honestly instead of a mock board)
export const UNCOVERED = {
  la: "LA Metro publishes its timetables openly, but its live feed (via Swiftly) needs a key.",
  sandiego: "San Diego MTS publishes its timetables openly; its live feed needs a key on request.",
  lasvegas: "RTC Southern Nevada publishes its timetables openly; its live feed (via Swiftly) needs a key.",
  phoenix: "Valley Metro publishes its timetables openly; its live feed URL carries a shared key, left out for now.",
  tucson: "No open Sun Tran feed found in the Mobility Database.",
};

// Route 95's set piece belongs to Langford and the West Shore (and the CRD as a whole), not to the rest of the region
export const SPOTLIGHT_PLACES = new Set(["crd", "langford", "colwood", "view-royal", "highlands", "metchosin", "sooke"]);

/** the region for an Open Places place id (or null) */
export const regionForPlace = (placeId) => REGIONS.find((r) => r.places.includes(placeId)) || null;

/** the region whose agencies' built bbox contains a point (smallest wins), given the loaded index */
export function regionAt(index, lon, lat) {
  let best = null;
  for (const r of REGIONS) for (const a of r.agencies) {
    const b = index?.agencies?.[a]?.bbox; if (!b) continue;
    const pad = 0.05;
    if (lon >= b[0] - pad && lon <= b[2] + pad && lat >= b[1] - pad && lat <= b[3] + pad) {   // bbox = w, s, e, n
      const area = (b[2] - b[0]) * (b[3] - b[1]);
      if (!best || area < best.area) best = { r, area };
    }
  }
  return best?.r || null;
}
