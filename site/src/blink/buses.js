// Side-view bus icons in the style of Greater Victoria's fleet: white body, black glazing bands, an amber LED
// destination sign, and green-and-blue stripes low on the side. These are generic drawings, not BC Transit's logo
// or marks: no wordmark and no swoosh. Route 95 is drawn as a double-decker; other routes as a single-deck bus.

const INK = "#1b2127", GLASS = "#20272e", SIGN = "#ffa726", GREEN = "#4caf50", BLUE = "#1e6bb8", WHEEL = "#222", HUB = "#b8bec4";

// facing right (front on the right); the left-facing version is mirrored
function doubleDecker(muted = false) {
  const body = muted ? "#e6e8ea" : "#ffffff", g = muted ? "#59626b" : GLASS;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="46" viewBox="0 0 64 46">
  <rect x="2" y="2" width="59" height="36" rx="4" fill="${body}" stroke="${INK}" stroke-width="1.4"/>
  <rect x="5" y="5.5" width="48" height="10" rx="1.5" fill="${g}"/>
  <path d="M55 5.5h3.2a1.8 1.8 0 0 1 1.8 1.8V15.5H55z" fill="${g}"/>
  <rect x="5" y="19.5" width="38" height="9" rx="1.2" fill="${g}"/>
  <rect x="45" y="19.5" width="6.5" height="15" rx="0.8" fill="${muted ? "#7a838c" : "#38424c"}"/>
  <path d="M53.5 21.5h6.5v12.5h-6.5z" fill="${g}"/>
  <rect x="53.5" y="18" width="6.5" height="2.6" rx="0.6" fill="${muted ? "#c9a46a" : SIGN}"/>
  <path d="M2.8 31h24c4 0 6 3.4 10 3.4H2.8z" fill="${muted ? "#9cc79e" : GREEN}"/>
  <path d="M2.8 34.4h34l4 2.6H2.8z" fill="${muted ? "#93b4d6" : BLUE}"/>
  <circle cx="14" cy="38.5" r="5" fill="${WHEEL}"/><circle cx="14" cy="38.5" r="1.9" fill="${HUB}"/>
  <circle cx="49" cy="38.5" r="5" fill="${WHEEL}"/><circle cx="49" cy="38.5" r="1.9" fill="${HUB}"/>
</svg>`;
}
function singleDeck(muted = true) {
  const body = muted ? "#e6e8ea" : "#ffffff", g = muted ? "#59626b" : GLASS;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="30" viewBox="0 0 56 30">
  <rect x="2" y="2" width="51" height="21" rx="3.5" fill="${body}" stroke="${INK}" stroke-width="1.3"/>
  <rect x="5" y="5" width="33" height="9" rx="1.2" fill="${g}"/>
  <rect x="40" y="5" width="5.5" height="15" rx="0.8" fill="${muted ? "#7a838c" : "#38424c"}"/>
  <path d="M47 7h4.2a1 1 0 0 1 1 1v11h-5.2z" fill="${g}"/>
  <rect x="46.5" y="3.6" width="5.6" height="2.2" rx="0.5" fill="${muted ? "#c9a46a" : SIGN}"/>
  <path d="M2.8 16.5h20c3 0 5 2.4 8 2.4H2.8z" fill="${muted ? "#9cc79e" : GREEN}"/>
  <path d="M2.8 18.9h28l3 2.6H2.8z" fill="${muted ? "#93b4d6" : BLUE}"/>
  <circle cx="12" cy="23.5" r="4.2" fill="${WHEEL}"/><circle cx="12" cy="23.5" r="1.6" fill="${HUB}"/>
  <circle cx="43" cy="23.5" r="4.2" fill="${WHEEL}"/><circle cx="43" cy="23.5" r="1.6" fill="${HUB}"/>
</svg>`;
}
const mirror = (svg) => svg.replace(/(<svg[^>]*>)/, `$1<g transform="translate(${svg.match(/width="(\d+)"/)[1]} 0) scale(-1 1)">`).replace("</svg>", "</g></svg>");
const uri = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

export const BUS_SVG = {
  "bus-r": doubleDecker(), "bus-l": mirror(doubleDecker()),
  "sbus-r": singleDeck(), "sbus-l": mirror(singleDeck()),
};
export const busURI = (name) => uri(BUS_SVG[name]);

let imgs = null;
function loadImages() {
  return (imgs ||= Promise.all(Object.keys(BUS_SVG).map((k) => new Promise((ok, no) => {
    const im = new Image(); im.onload = () => ok([k, im]); im.onerror = no; im.src = busURI(k);
  }))));
}
/** Add the bus icons to a MapLibre map (call on every style load; setStyle drops images). Drawn at 2× for sharpness. */
export async function addBusImages(map) {
  for (const [k, im] of await loadImages()) if (!map.hasImage(k)) map.addImage(k, im, { pixelRatio: 2 });
}

/** "r" when the bus heads east (bearing 0–180°), "l" when west; fallback from direction (0 = to Downtown, eastbound). */
export const facing = (bearing, dir, dLon) =>
  bearing != null && bearing !== "" && !Number.isNaN(+bearing) ? (+bearing % 360 < 180 ? "r" : "l")
    : dLon != null && Math.abs(dLon) > 1e-6 ? (dLon > 0 ? "r" : "l") : dir === 1 ? "l" : "r";
