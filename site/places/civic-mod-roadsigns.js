// Open Places · road-event signs: one recognisable symbol per DriveBC event kind, coloured by severity, the same drawing
// on the map (canvas images for MapLibre), in legends, lists and the distance strips (inline SVG).
//   works       construction / road works: the diamond work sign with a worker
//   closure     a closed road: the red no-entry disc with a white bar (always the major colour)
//   incident    a collision or hazard: the warning triangle with "!"
//   conditions  weather or road conditions: a round badge with a snowflake
//   event       anything else (special events …): a square "i" sign
// Severity by colour (Open511 severity): minor yellow, moderate orange, major red; grey when the event is scheduled but not
// in effect now. Construction is always the work-sign orange (#f27a1a), red only when major. Signs keep the same colours in light and dark (like real signs), with a halo in the page's surface colour.
import { el } from "../src/shared/ui.js";
import { color } from "./civic-stage.js";
import "./civic-mod-roadsigns.css";

export const SIGN_KINDS = [
  { k: "works", label: "Construction" },
  { k: "closure", label: "Closure" },
  { k: "incident", label: "Incident" },
  { k: "conditions", label: "Weather or road conditions" },
  { k: "event", label: "Other event" },
];
export const SIGN_TONES = [
  { k: "minor", label: "Minor", css: "var(--sev-minor)" },
  { k: "moderate", label: "Moderate", css: "var(--sev-moderate)" },
  { k: "major", label: "Major", css: "var(--sev-major)" },
  { k: "off", label: "Scheduled, not in effect now", css: "var(--sev-off)" },
];
const TONE = Object.fromEntries(SIGN_TONES.map((t) => [t.k, t]));
/** a sign's field colour: works is construction orange at every severity (red only when major), closures are always
 *  red, the rest by severity; grey when scheduled but not in effect */
const fieldOf = (kind, tone) => (tone === "off" ? TONE.off.css : kind === "closure" ? TONE.major.css
  : kind === "works" ? (tone === "major" ? TONE.major.css : "var(--sev-works)") : (TONE[tone] || TONE.minor).css);
export const KIND_LABEL = Object.fromEntries(SIGN_KINDS.map((x) => [x.k, x.label]));

const closed = (e) => e.roads?.some((r) => r.state === "CLOSED") || /closed/i.test(e.headline || "");
/** the sign for an Open511 event */
export function evKind(e) {
  if (closed(e)) return "closure";
  const t = String(e.event_type || "").toUpperCase();
  return t === "CONSTRUCTION" ? "works" : t === "INCIDENT" ? "incident" : /WEATHER|ROAD_CONDITION/.test(t) ? "conditions" : "event";
}
/** its colour: "minor" | "moderate" | "major" | "off" (live = false: scheduled, not in effect now) */
export function evTone(e, live = true) {
  if (!live) return "off";
  if (closed(e)) return "major";
  const s = String(e.severity || "").toUpperCase();
  return s === "MAJOR" ? "major" : s === "MODERATE" ? "moderate" : "minor";
}
export const signId = (e, live = true) => `${evKind(e)}-${evTone(e, live)}`;
const COLOUR = { minor: "yellow", moderate: "orange", major: "red" };
/** what the sign's colour means, for the popup: "Major construction (red sign)", "Minor construction (orange sign)",
 *  "Scheduled, not in effect now (grey sign)", "Road closed (red sign)" */
export function signNote(e, live = true) {
  const kind = evKind(e), tone = evTone(e, live);
  if (tone === "off") return "Scheduled, not in effect now (grey sign)";
  if (kind === "closure") return "Road closed (red sign)";
  if (kind === "works") return tone === "major" ? "Major construction (red sign)" : `${tone === "moderate" ? "Moderate" : "Minor"} construction (orange sign)`;
  const what = { incident: "incident", conditions: "road conditions", event: "event" }[kind] || "event";
  return `${tone === "major" ? "Major" : tone === "moderate" ? "Moderate" : "Minor"} ${what} (${COLOUR[tone] || "yellow"} sign)`;
}

// ------------------------------------------------------------------ the drawings (24 x 24, SVG path data)
const C10 = "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0Z";
const dot = (x, y, r) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
/** [{ d, fill?, stroke?, w?, halo? }] with colours as tokens: F the tone, K sign ink, W white, H the halo */
function prims(kind) {
  if (kind === "works") return [
    // the standard "road work" sign (MUTCD W21-1 / TAC): an orange diamond with a thin outer edge and an inset black
    // border; the worker faces right, standing upright: round head apart from the body, thick torso, left arm akimbo
    // (elbow out, hand on the hip), right arm down to a straight shovel whose blade sits at the top left of a large
    // rounded pile; two straight legs, feet on the pile's baseline
    { d: "M12 1.6 L22.4 12 L12 22.4 L1.6 12 Z", fill: "F", halo: true },          // the field and its thin outer edge
    { d: "M12 3.1 L20.9 12 L12 20.9 L3.1 12 Z", stroke: "K", w: 1.05 },           // inset black border
    // traced from the standard sign's proportions (x' = 12 + (x - 270) * 0.034 on a 540-unit drawing), so the figure
    // stands tall: feet and the pile share one baseline just inside the border
    { d: dot(11.15, 7.0, 1.0), fill: "K" },                                                     // head, apart from the body
    { d: "M9.11 8.26 L10.57 8.26 L10.98 12.17 L8.26 12.17 Z", fill: "K", stroke: "K", w: 0.35 },  // torso, upright
    { d: "M9.01 8.67 L7.92 9.35 L8.94 10.37", stroke: "K", w: 0.85 },                            // left arm akimbo
    { d: "M10.75 9 L10.4 11.3", stroke: "K", w: 0.9 },                                           // right arm down to the grip
    { d: "M8.25 12 L9.15 12 L9.1 16.18 L8 16.18 Z M9.8 12 L10.95 12 L11.15 16.18 L10.05 16.18 Z", fill: "K" },   // straight legs, apart
    { d: "M10.03 10.91 L13.19 13.43", stroke: "K", w: 0.7 },                                     // shovel handle
    { d: "M12.95 13.02 L13.63 12.88 L14.04 13.77 L13.29 14.04 Z", fill: "K" },                    // blade
    { d: "M11.93 16.18 L13.3 13.1 C13.5 12.6 13.9 12.5 14.4 12.5 C14.9 12.5 15.1 12.6 15.3 12.8 L17.5 14.3 L16 16.18 Z", fill: "K" },   // dirt pile
  ];
  if (kind === "closure") return [
    { d: C10, fill: "F", halo: true },
    { d: "M6 10.3 H18 V13.7 H6 Z", fill: "W" },
  ];
  if (kind === "incident") return [
    { d: "M12 2.2 L22.3 20.6 L1.7 20.6 Z", fill: "F", stroke: "K", w: 1.3, halo: true },
    { d: "M11 8.4 H13 L12.65 15 H11.35 Z", fill: "K" },
    { d: dot(12, 17.5, 1.2), fill: "K" },
  ];
  if (kind === "conditions") return [
    { d: C10, fill: "F", stroke: "K", w: 1.2, halo: true },
    { d: "M12 5.6 V18.4 M6.45 8.8 L17.55 15.2 M6.45 15.2 L17.55 8.8 M10.3 6.4 L12 7.9 L13.7 6.4 M10.3 17.6 L12 16.1 L13.7 17.6", stroke: "K", w: 1.5 },
  ];
  return [
    { d: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z", fill: "F", stroke: "K", w: 1.2, halo: true },
    { d: dot(12, 7.4, 1.35), fill: "K" },
    { d: "M10.9 10.2 H13.1 V17.2 H10.9 Z", fill: "K" },
  ];
}
const INK = "#1b1b1b", WHITE = "#ffffff";

/** a sign's SVG markup in a 24 x 24 box (paths only), coloured with CSS variables */
export function signMarkup(kind, tone = "minor") {
  const F = fieldOf(kind, tone);
  const col = (t) => (t === "F" ? F : t === "K" ? INK : t === "W" ? WHITE : "var(--surface)");
  return prims(kind).map((p) => `${p.halo ? `<path d="${p.d}" style="fill:none;stroke:var(--surface);stroke-width:3.4;stroke-linejoin:round"/>` : ""}<path d="${p.d}" style="fill:${p.fill ? col(p.fill) : "none"};${p.stroke ? `stroke:${col(p.stroke)};stroke-width:${p.w};stroke-linecap:round;stroke-linejoin:round` : ""}"/>`).join("");
}
/** an inline SVG sign (a span), for lists, legends and strips; size in px */
export function sign(kind, tone = "minor", { size = 16, title = null, cls = "" } = {}) {
  const body = signMarkup(kind, tone);
  const s = el("span", { class: `civ-sign ${cls}`.trim(), role: "img", "aria-label": title || KIND_LABEL[kind], title: title || null });
  s.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;
  return s;
}
export const evSign = (e, live = true, o = {}) => sign(evKind(e), evTone(e, live), o);

/** one sign as an ImageData drawn at 2x (48 px = 24 px on the map) */
export function signImage(kind, tone) {
  const s = 48, cv = document.createElement("canvas"); cv.width = cv.height = s;
  const g = cv.getContext("2d"); g.scale(2, 2);
  const F = color(fieldOf(kind, tone)), H = color("var(--surface)");
  const col = (t) => (t === "F" ? F : t === "K" ? INK : t === "W" ? WHITE : H);
  g.lineCap = "round"; g.lineJoin = "round";
  for (const p of prims(kind)) {
    const path = new Path2D(p.d);
    if (p.halo) { g.strokeStyle = H; g.lineWidth = 3.4; g.stroke(path); }
    if (p.fill) { g.fillStyle = col(p.fill); g.fill(path); }
    if (p.stroke) { g.strokeStyle = col(p.stroke); g.lineWidth = p.w; g.stroke(path); }
  }
  return g.getImageData(0, 0, s, s);
}
/** every sign, keyed `${kind}-${tone}` (for an "icon" stage spec's images()) */
export const signImages = () => Object.fromEntries(SIGN_KINDS.flatMap(({ k }) => SIGN_TONES.map((t) => [`${k}-${t.k}`, signImage(k, t.k)])));
/** sign size on the map by zoom */
export const SIGN_SIZE = ["interpolate", ["linear"], ["zoom"], 7, 0.7, 10, 0.85, 13, 1.05];

/** the key: the kinds present (or all), then the colours */
export function signLegend(kinds = null, { tones = ["minor", "moderate", "major", "off"] } = {}) {
  const ks = SIGN_KINDS.filter((x) => !kinds || kinds.includes(x.k));
  return el("div", { class: "civ-signleg" },
    el("div", { class: "civ-signleg-r" }, ...ks.map((x) => el("span", { class: "civ-signleg-i" }, sign(x.k, x.k === "closure" ? "major" : "moderate", { size: 15 }), x.label))),
    el("div", { class: "civ-signleg-r civ-signleg-t" }, ...tones.map((t) => el("span", { class: "civ-signleg-i" }, el("i", { style: `background:${TONE[t].css}` }), TONE[t].label)),
      ks.some((x) => x.k === "works") ? el("span", { class: "civ-signleg-i" }, el("i", { style: "background:var(--sev-works)" }), "Construction: orange, red when major") : null));
}

/** a distance strip: one row per label, each event a sign at its distance; items [{ x, row, kind, tone, title, note }] */
export function signStrip(host, items, { domain = [0, 40], rows = null, ticks = null, fmt = (v) => `${v}`, size = 16 } = {}) {
  const R = rows || [""], span = domain[1] - domain[0] || 1, pct = (v) => `${Math.max(0, Math.min(100, ((v - domain[0]) / span) * 100))}%`;
  const box = el("div", { class: `civ-sstrip${rows ? "" : " civ-sstrip-1"}` },
    ...R.map((label, r) => el("div", { class: "civ-sstrip-row" },
      rows ? el("span", { class: "civ-sstrip-l", title: label }, label) : null,
      el("div", { class: "civ-sstrip-t" }, ...items.filter((d) => (d.row ?? 0) === r).sort((a, b) => (a.tone === "off") - (b.tone === "off")).map((d) => {
        const s = sign(d.kind, d.tone, { size, title: [d.title, d.note].filter(Boolean).join(" · ") });
        s.style.left = pct(d.x);
        return s;
      })))),
    el("div", { class: "civ-sstrip-row civ-sstrip-ax" }, rows ? el("span", { class: "civ-sstrip-l" }) : null,
      el("div", { class: "civ-sstrip-t" }, ...(ticks || [domain[0], domain[1]]).map((v) => el("span", { class: "civ-sstrip-tk", style: `left:${pct(v)}` }, fmt(v))))));
  host.replaceChildren(box);
}

/** a list of events, each row its sign, a label and a value; items [{ kind, tone, label, value, title }] */
export function signRows(host, items) {
  host.replaceChildren(el("div", { class: "civ-evrows" }, ...items.map((d) => el("div", { class: "civ-evrow", title: d.title || null },
    sign(d.kind, d.tone, { size: 16 }), el("b", {}, d.label), el("em", {}, d.value)))));
}
