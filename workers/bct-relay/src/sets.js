// Live "sets" for the hub (hub.js): which live sources one Open Places place needs. A set is named after the Open Places
// place id (site/places/civic-data.js; keep the ids and coordinates in step), and each of its parts names one shared
// source, so places that share a source share its one upstream clock:
//   transit  BC Transit agency id (agencies.js): vehicles + trip-update delays every 20 s, alerts every 60 s
//   air      [lat, lon, r_nm]: the set's aircraft circle, big enough to hold every place's own circle and the Air
//            Traffic page's Greater Victoria view (48.53, -123.42, 40 nm). It sits inside the pnw zone (airzones.js),
//            whose one shared snapshot /live cuts down to it, so a set costs adsb.lol nothing extra
//   ais      aisstream area (ais.js AIS_AREAS): one persistent websocket for the whole area
//   roads    DriveBC bbox "w,s,e,n" (0.5°-snapped, ≤ 3° a side): one box covers every place in the region
// Greater Victoria is the first region. Add another by giving its places the same four parts.

// Sooke's 22 nm circle reaches 35.4 nm from this centre and the Air Traffic page's 40 nm view (snapped to 48.55, -123.40) 45.0 nm
const CRD_AIR = [48.5, -123.5, 46];
// one DriveBC box for the whole CRD: the union of every CRD place's own 0.5°-snapped box (civic-mod-roads.js boxFor),
// which also takes in the Malahat. Old /drivebc/events.json requests for any box inside it are answered from it.
const CRD_ROADS = "-125,47.5,-122,49.5";

const CRD = [
  ["crd", "Greater Victoria", [-123.37, 48.45]],
  ["victoria-city", "Victoria", [-123.365, 48.428]], ["saanich", "Saanich", [-123.372, 48.484]], ["oak-bay", "Oak Bay", [-123.317, 48.437]],
  ["esquimalt", "Esquimalt", [-123.414, 48.432]], ["view-royal", "View Royal", [-123.44, 48.455]], ["colwood", "Colwood", [-123.495, 48.424]],
  ["langford", "Langford", [-123.505, 48.449]], ["metchosin", "Metchosin", [-123.54, 48.382]], ["sooke", "Sooke", [-123.726, 48.374]],
  ["highlands", "Highlands", [-123.5, 48.52]], ["central-saanich", "Central Saanich", [-123.41, 48.565]],
  ["north-saanich", "North Saanich", [-123.42, 48.64]], ["sidney", "Sidney", [-123.399, 48.65]],
];

export const SETS = Object.fromEntries(CRD.map(([id, name, [lon, lat]]) => [id, {
  name, region: "Greater Victoria", ll: [lon, lat], transit: "victoria", air: CRD_AIR, ais: "salish", roads: CRD_ROADS,
}]));
SETS.victoria = { ...SETS.crd };   // alias: "victoria" = Greater Victoria

export const PARTS = ["transit", "alerts", "air", "ais", "roads"];
