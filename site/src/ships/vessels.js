// Generic top-down vessel silhouettes for the map, one per kind of vessel, bow up so MapLibre can rotate them by course.
// Plain shapes in neutral category colours: no company colours, funnel marks, flags or ferry-operator liveries.
// Each kind has a distinct outline as well as a colour, so the key still reads for colour-blind viewers:
//   ferry     double-ended hull (blunt at both ends), open car deck at each end, superstructure with a bridge at both ends
//   cruise    long hull, pointed bow, almost all white superstructure with balcony rows, pool and funnel aft
//   cargo     box hull, container stacks, bridge aft          tanker   pointed hull, deck pipeline and manifold, bridge aft
//   tug       short beamy hull with a heavy fender, wheelhouse forward, towing hook aft
//   fishing   small hull, wheelhouse forward, outrigger poles, net drum aft
//   pleasure  motor boat: pointed bow, windscreen, cockpit    sail     slim hull, mast and a boom swung out to one side
// A halo keeps each readable on both basemaps: white with a dark outline on the light map, near-black with a light
// outline on the dark one (addShipImages(map, dark) adds the matching set). Images are drawn at 3× (pixelRatio 3).

export const KIND_COLOR = { ferry: "#2a63d6", cruise: "#c2418f", cargo: "#e07b24", tanker: "#c23b3b", tug: "#8b44d6", fishing: "#0f9488", pleasure: "#4c9a2a", sail: "#c79a12", other: "#7d8794" };
export const KIND_NAME = { ferry: "Ferry", cruise: "Cruise & passenger", cargo: "Cargo", tanker: "Tanker", tug: "Tug & tow", fishing: "Fishing", pleasure: "Pleasure craft", sail: "Sailing", other: "Other & unknown" };
export const KINDS = Object.keys(KIND_COLOR);
const PR = 3;
const THEME = { light: { halo: "#ffffff", ink: "#1b2127", deck: "#f6f7f9", win: "#26303a" }, dark: { halo: "#0b1119", ink: "#e3e9f0", deck: "#f2f4f7", win: "#26303a" } };

const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w * PR}" height="${h * PR}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
/** the hull: halo underneath, then the coloured fill with an ink outline */
const hull = (T, d, c, inkW = 0.8) => `<path d="${d}" fill="none" stroke="${T.halo}" stroke-width="3.2" stroke-linejoin="round" opacity="0.95"/><path d="${d}" fill="${c}" stroke="${T.ink}" stroke-width="${inkW}" stroke-linejoin="round"/>`;
const rect = (x, y, w, h, rx, fill, extra = "") => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" ${extra}/>`;

const SHAPES = {
  ferry: (c, T) => svg(16, 46,
    hull(T, "M8 1C12.6 2.6 15 7.5 15 12.5V33.5C15 38.5 12.6 43.4 8 45C3.4 43.4 1 38.5 1 33.5V12.5C1 7.5 3.4 2.6 8 1Z", c)
    // open car deck at both ends: lane lines
    + `<path d="M5.4 5.2V11M8 3.6V11M10.6 5.2V11M5.4 35V40.8M8 35V42.4M10.6 35V40.8" stroke="${T.deck}" stroke-width="0.7" stroke-linecap="round" opacity="0.7"/>`
    // superstructure, a bridge (dark window band) at each end, two funnels side by side amidships
    + rect(3, 12, 10, 22, 2.6, T.deck, `stroke="${T.ink}" stroke-width="0.5"`)
    + rect(3.8, 13.2, 8.4, 1.7, 0.6, T.win) + rect(3.8, 31.1, 8.4, 1.7, 0.6, T.win)
    + rect(5, 21.2, 2.2, 3.6, 0.9, c) + rect(8.8, 21.2, 2.2, 3.6, 0.9, c)),
  cruise: (c, T) => svg(18, 56,
    hull(T, "M9 1C14.5 7 17 14 17 21V51Q17 55 13 55H5Q1 55 1 51V21C1 14 3.5 7 9 1Z", c)
    + rect(3, 11, 12, 41, 3.5, T.deck, `stroke="${T.ink}" stroke-width="0.5"`)
    + [16, 21, 26, 31, 36, 41].map((y) => rect(3.4, y, 1.5, 3, 0.5, c, `opacity="0.85"`) + rect(13.1, y, 1.5, 3, 0.5, c, `opacity="0.85"`)).join("")
    + rect(6.5, 23, 5, 7, 1.5, "#5bb6e8", `stroke="${T.ink}" stroke-width="0.3"`)
    + rect(7, 40, 4, 6, 2, c)),
  cargo: (c, T) => svg(14, 46,
    hull(T, "M7 1C11 5 13 10 13 15V43Q13 45 11 45H3Q1 45 1 43V15C1 10 3 5 7 1Z", c)
    + [11, 16.5, 22, 27.5].map((y, i) => rect(2.8, y, 8.4, 4.6, 0.5, i % 2 ? "#f6d2a8" : "#9a4a17")).join("")
    + rect(2.4, 36, 9.2, 6, 1, T.deck, `stroke="${T.ink}" stroke-width="0.5"`) + rect(3.2, 36.8, 7.6, 1.4, 0.4, T.win)),
  tanker: (c, T) => svg(14, 46,
    hull(T, "M7 1C11.5 6 13 11 13 16V42Q13 45 10 45H4Q1 45 1 42V16C1 11 2.5 6 7 1Z", c)
    + `<path d="M7 8V34M3.6 21H10.4" stroke="${T.deck}" stroke-width="1.1" stroke-linecap="round"/>`
    + `<circle cx="7" cy="13" r="1.6" fill="${T.deck}"/><circle cx="7" cy="28" r="1.6" fill="${T.deck}"/>`
    + rect(2.4, 36, 9.2, 6, 1, T.deck, `stroke="${T.ink}" stroke-width="0.5"`) + rect(3.2, 36.8, 7.6, 1.4, 0.4, T.win)),
  tug: (c, T) => svg(12, 22,
    `<path d="M6 1C10 2 11 6 11 9V18Q11 21 8 21H4Q1 21 1 18V9C1 6 2 2 6 1Z" fill="none" stroke="${T.halo}" stroke-width="3.4"/>`
    + `<path d="M6 1C10 2 11 6 11 9V18Q11 21 8 21H4Q1 21 1 18V9C1 6 2 2 6 1Z" fill="${c}" stroke="${T.ink}" stroke-width="1.7"/>`
    + rect(3.4, 5, 5.2, 5, 1, T.deck, `stroke="${T.ink}" stroke-width="0.5"`) + rect(3.9, 5.5, 4.2, 1.3, 0.4, T.win)
    + `<path d="M3.8 16.5Q6 14.2 8.2 16.5" fill="none" stroke="${T.ink}" stroke-width="0.9" stroke-linecap="round"/>`),
  fishing: (c, T) => svg(18, 26,
    `<path d="M1.5 13.5L6.5 11M16.5 13.5L11.5 11" stroke="${T.halo}" stroke-width="2.4" stroke-linecap="round"/><path d="M1.5 13.5L6.5 11M16.5 13.5L11.5 11" stroke="${T.ink}" stroke-width="0.8" stroke-linecap="round"/>`
    + hull(T, "M9 1C12 4 13 8 13 11V23Q13 25 11 25H7Q5 25 5 23V11C5 8 6 4 9 1Z", c)
    + rect(6.6, 6.5, 4.8, 4.2, 0.8, T.deck, `stroke="${T.ink}" stroke-width="0.4"`)
    + `<circle cx="9" cy="19.5" r="1.9" fill="none" stroke="${T.deck}" stroke-width="0.9"/>`),
  pleasure: (c, T) => svg(10, 22,
    hull(T, "M5 1C8 4.5 9 8.5 9 12V19Q9 21 7 21H3Q1 21 1 19V12C1 8.5 2 4.5 5 1Z", c)
    + `<path d="M2.2 10.2Q5 7.6 7.8 10.2" fill="none" stroke="${T.deck}" stroke-width="1.1" stroke-linecap="round"/>`
    + rect(2.5, 12.5, 5, 6, 1.2, T.deck, `opacity="0.85"`)),
  sail: (c, T) => svg(14, 24,
    hull(T, "M7 1C9.6 5 10.5 9 10.5 13V21Q10.5 23 8.5 23H5.5Q3.5 23 3.5 21V13C3.5 9 4.4 5 7 1Z", c)
    // the mast, and the boom with its sail swung out to starboard
    + `<path d="M7 8.5Q11 13 12.6 19.5" fill="none" stroke="${T.halo}" stroke-width="2.4" stroke-linecap="round"/>`
    + `<path d="M7 8.5Q11 13 12.6 19.5" fill="none" stroke="${T.ink}" stroke-width="0.9" stroke-linecap="round"/>`
    + `<circle cx="7" cy="8.5" r="1.3" fill="${T.ink}"/>`),
  // Open Places' Sea Traffic classes (classes.js) add five more outlines:
  // a short double-ended ferry (inter-island), a small passenger boat with a long cabin (foot ferry, water taxi, tour
  // boat), a catamaran (high-speed craft), and a patrol boat with a plain orange diagonal band (Coast Guard, rescue, pilot; no service's own marks)
  ferrys: (c, T) => svg(14, 32,
    hull(T, "M7 1C11 2.4 13 6 13 9.5V22.5C13 26 11 29.6 7 31C3 29.6 1 26 1 22.5V9.5C1 6 3 2.4 7 1Z", c)
    + `<path d="M4.8 4.4V8.6M7 3.2V8.6M9.2 4.4V8.6M4.8 23.4V27.6M7 23.4V28.8M9.2 23.4V27.6" stroke="${T.deck}" stroke-width="0.7" stroke-linecap="round" opacity="0.7"/>`
    + rect(3, 10, 8, 12, 2.2, T.deck, `stroke="${T.ink}" stroke-width="0.5"`)
    + rect(3.7, 11, 6.6, 1.5, 0.5, T.win) + rect(3.7, 19.5, 6.6, 1.5, 0.5, T.win)),
  foot: (c, T) => svg(10, 24,
    hull(T, "M5 1C8.2 4 9 8 9 11V21Q9 23 7 23H3Q1 23 1 21V11C1 8 1.8 4 5 1Z", c)
    + rect(2.3, 7.5, 5.4, 12.5, 1.6, T.deck, `stroke="${T.ink}" stroke-width="0.4"`)
    + [9.5, 12.5, 15.5].map((y) => rect(2.9, y, 4.2, 1.3, 0.4, T.win)).join("")),
  hsc: (c, T) => svg(16, 32,
    `<path d="M3.5 2C6 5 6 9 6 12V29H1V12C1 9 1 5 3.5 2ZM12.5 2C15 5 15 9 15 12V29H10V12C10 9 10 5 12.5 2Z" fill="none" stroke="${T.halo}" stroke-width="3.2" stroke-linejoin="round"/>`
    + `<path d="M3.5 2C6 5 6 9 6 12V29H1V12C1 9 1 5 3.5 2ZM12.5 2C15 5 15 9 15 12V29H10V12C10 9 10 5 12.5 2Z" fill="${c}" stroke="${T.ink}" stroke-width="0.8" stroke-linejoin="round"/>`
    + rect(2, 10, 12, 16, 2.4, T.deck, `stroke="${T.ink}" stroke-width="0.5"`)
    + `<path d="M3 13.2Q8 10.6 13 13.2" fill="none" stroke="${T.win}" stroke-width="1.5" stroke-linecap="round"/>`),
  gov: (c, T) => svg(12, 30,
    hull(T, "M6 1C10 5 11 10 11 14V27Q11 29 9 29H3Q1 29 1 27V14C1 10 2 5 6 1Z", c)
    + `<path d="M1.4 15.5L10.6 9.5V12.8L1.4 18.8Z" fill="#e8742a"/>`
    + rect(3, 17.5, 6, 6.5, 1.2, T.deck, `stroke="${T.ink}" stroke-width="0.5"`) + rect(3.6, 18.2, 4.8, 1.3, 0.4, T.win)),
  other: (c, T) => svg(10, 18,
    hull(T, "M5 1C8 4 9 7 9 10V15Q9 17 7 17H3Q1 17 1 15V10C1 7 2 4 5 1Z", c)
    + rect(3, 7, 4, 4, 0.8, T.deck)),
};
/** the SVG markup for a kind (light-map halo by default) */
export const shipSVG = (kind, dark = false) => SHAPES[kind] ? SHAPES[kind](KIND_COLOR[kind], THEME[dark ? "dark" : "light"]) : SHAPES.other(KIND_COLOR.other, THEME.light);
/** any outline above in any colour (Open Places' Sea Traffic classes, src/ships/classes.js) */
export const vesselSVG = (shape, color, dark = false) => (SHAPES[shape] || SHAPES.other)(color, THEME[dark ? "dark" : "light"]);
export const VESSEL_PR = PR;
export const shipURI = (kind, dark = false) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(shipSVG(kind, dark))}`;

const sets = {};
const load = (dark) => (sets[dark ? "d" : "l"] ||= Promise.all(KINDS.map((k) => new Promise((ok, no) => {
  const im = new Image(); im.onload = () => ok([k, im]); im.onerror = no; im.src = shipURI(k, dark);
}))));
/** add every silhouette to a MapLibre map as "ship-<kind>" with the halo for its basemap (call after each style load:
 *  setStyle drops images) */
export async function addShipImages(map, dark = false) {
  for (const [k, im] of await load(dark)) {
    if (map.hasImage(`ship-${k}`)) map.updateImage(`ship-${k}`, im); else map.addImage(`ship-${k}`, im, { pixelRatio: PR });
  }
}
// the length (m) each silhouette is drawn for at scale 1: real lengths scale it by the square root, so a 330 m container
// ship reads bigger than a 150 m one without small craft vanishing
const NOMINAL_M = { cargo: 190, tanker: 190, cruise: 290, ferry: 140, tug: 30, fishing: 25, pleasure: 12, sail: 12, other: 30 };
/** relative drawing scale by vessel length (metres) */
export const sizeOf = (kind, len) => {
  if (!len || len < 3) return 1;
  return Math.max(0.65, Math.min(1.5, Math.sqrt(len / (NOMINAL_M[kind] || 40))));
};
