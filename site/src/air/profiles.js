// Side-profile drawings of aircraft type families, for the aircraft card (layer.js aircraftCard) when no photo of the
// exact type is on file (src/shared/typephoto.js). Plain generic outlines drawn in code, nose to the right: no
// operator colours, liveries or marks. The fin carries the card's kind colour (airliner, cargo, private, …) only.
//
//   FAMILIES                 { id: label } in a sensible order
//   familyOf(a)              aircraft (enriched: type, cat, shape, float, mil) → family id, or null when too little is known
//   profileSVG(id, { dark, accent }) → SVG string (viewBox 200×64)
import { shapeOf } from "./feed.js";

export const FAMILIES = {
  narrow: "Narrow-body airliner", wide: "Wide-body airliner", regional: "Regional jet", turboprop: "Turboprop airliner", float: "Floatplane",
  heli: "Helicopter", single: "Light single-engine", twin: "Light twin", bizjet: "Business jet", military: "Military jet",
};
const has = (s) => { const set = new Set(s.split(" ")); return (t) => set.has(t); };
const WIDE = has("A306 A310 A332 A333 A338 A339 A342 A343 A345 A346 A359 A35K A388 B741 B742 B743 B744 B748 B74S B762 B763 B764 B772 B77L B773 B77W B778 B779 B788 B789 B78X MD11 DC10 L101 K35R KC46 CC30 E3TF E3CF E6 C17 C5M A400 A124 A225 BLCF A3ST A337 B52 KC10");
const REGIONAL = ["CRJ", "E135", "E145", "E35L", "E45X", "F100", "F70", "MD8", "MD9", "DC9", "B712", "RJ"];
const FIGHTER = has("F16 F18 F35 F22 F15 HAWK T6 PC9 PC21 CT114 CT155 CT156 EUFI TOR A10 T38 F5");
const SINGLE_TP = has("C208 PC12 TBM7 TBM8 TBM9 KODI PC6T P46T");
const TWIN = has("BE58 BE55 BE60 BE76 PA31 PA34 PA44 PA23 PA30 PA27 C310 C340 C414 C421 C337 DA42 DA62 P68 C402 C404");

export function familyOf(a) {
  const t = String(a?.type || "").toUpperCase(), cat = a?.cat || "", shape = a?.shape || shapeOf(t, cat);
  if (shape === "heli") return "heli";
  if (FIGHTER(t) || (a?.mil && cat === "A6")) return "military";
  if (a?.float) return "float";
  if (shape === "quad" || WIDE(t) || cat === "A5") return "wide";
  if (shape === "prop" || shape === "prop4") return SINGLE_TP(t) ? "single" : TWIN(t) ? "twin" : "turboprop";
  if (shape === "rear") return REGIONAL.some((r) => t.startsWith(r)) ? "regional" : "bizjet";
  if (shape === "light") return "single";
  if (shape === "jet") return cat === "A1" || cat === "A2" ? "bizjet" : "narrow";
  return cat === "A1" || cat === "B4" ? "single" : null;
}

const r1 = (v) => Math.round(v * 10) / 10;
/** a jet airliner: fuselage x0..x1 around cy with radius r; engines on the wing or at the tail; T-tail or not */
function jet({ x0, x1, cy, r, eng, er, el, ex, tt, win = 4.6, big = false }) {
  const top = cy - r, bot = cy + r, fh = r * 2.9;
  const body = `M${x0} ${top + 2} L${x0 + 26} ${top} L${x1 - 22} ${top} C${x1 - 10} ${top} ${x1 - 2} ${top + 5} ${x1} ${cy + 2} C${x1 - 3} ${bot - 2} ${x1 - 11} ${bot} ${x1 - 20} ${bot} L${x0 + 44} ${bot} C${x0 + 30} ${bot} ${x0 + 14} ${cy + 2} ${x0} ${top + 4} Z`;
  const fin = `M${x0 + 4} ${top + 2} L${x0 - 6} ${top - fh} L${x0 + 7} ${top - fh} L${x0 + 34} ${top} Z`;
  const stab = tt ? `M${x0 - 10} ${top - fh} L${x0 + 18} ${top - fh + 1} L${x0 + 18} ${top - fh + 3.5} L${x0 - 8} ${top - fh + 3} Z`
    : `M${x0 - 6} ${top + 4} L${x0 + 24} ${top + 5} L${x0 + 24} ${top + 7.5} L${x0 - 4} ${top + 7} Z`;
  const wing = `M${ex - 18} ${bot - 1} L${ex + 22} ${bot - 1} L${ex + 30} ${bot + 2} L${ex - 10} ${bot + 2} Z`;
  const ey = eng === "rear" ? top - er + 2 : bot + 1, exx = eng === "rear" ? x0 + 34 : ex - 2;
  const nac = `M${exx} ${ey} h${el} a${er} ${er} 0 0 1 0 ${er * 2} h-${el} a${er * 0.6} ${er} 0 0 1 0 -${er * 2} Z`;
  const pylon = eng === "rear" ? `M${exx + el * 0.3} ${ey + er * 2 - 1} h${el * 0.4} l2 3 h-${el * 0.4} Z` : `M${exx + el * 0.25} ${ey + 1} h${el * 0.5} l2 -3 h-${el * 0.5} Z`;
  const wins = []; for (let x = x0 + 44; x < x1 - 28; x += win) wins.push(`<circle cx="${r1(x)}" cy="${r1(cy - r * 0.32)}" r="${big ? 1.2 : 1}"/>`);
  const ck = `M${x1 - 14} ${top + 3} L${x1 - 6} ${top + 5.5} L${x1 - 7.5} ${top + 8} L${x1 - 15} ${top + 6.5} Z`;
  return { body, parts: [fin, stab, wing, nac, pylon], fin, wins, ck };
}
/** a light aircraft: cowl, cabin, tail cone; high wing (strut) or low wing */
function light({ s = 1, high = true, gear = "wheels", twin = false, turbo = false }) {
  const X = (x) => r1(100 + (x - 100) * s), Y = (y) => r1(34 + (y - 34) * s);
  const P = (pts) => pts.map(([c, ...v], i) => `${c}${v.map((n, j) => (j % 2 ? Y(n) : X(n))).join(" ")}`).join(" ");
  const body = P([["M", 36, 33], ["L", 70, 30], ["L", 112, 28], ["L", 118, 21], ["L", 146, 21], ["L", 154, 28], ["L", 164, 29], ["C", 172, 30, 174, 33, 174, 35], ["C", 174, 39, 170, 41, 162, 41], ["L", 124, 43], ["L", 72, 38], ["Z"]]);
  const fin = P([["M", 38, 33], ["L", 30, 12], ["L", 41, 12], ["L", 66, 31], ["Z"]]);
  const stab = P([["M", 28, 32], ["L", 58, 33], ["L", 58, 35.5], ["L", 30, 35], ["Z"]]);
  const wing = high ? P([["M", 112, 20], ["L", 152, 20], ["L", 154, 17], ["L", 114, 17], ["Z"]]) : P([["M", 112, 40], ["L", 152, 39], ["L", 156, 43], ["L", 116, 44], ["Z"]]);
  const strut = high ? P([["M", 144, 31], ["L", 130, 20], ["L", 132, 20], ["L", 146, 31], ["Z"]]) : "";
  const glass = P([["M", 120, 23], ["L", 144, 23], ["L", 150, 28], ["L", 116, 28], ["Z"]]);
  const nac = twin ? P([["M", 128, 36], ["L", 160, 36], ["C", 166, 36, 168, 40, 166, 42], ["L", 130, 42], ["Z"]]) : "";
  const prop = twin ? { cx: X(168), cy: Y(39), ry: 11 * s } : { cx: X(176), cy: Y(35), ry: 13 * s };
  const parts = [fin, stab, wing, strut, nac].filter(Boolean);
  let under = "";
  if (gear === "wheels") under = `<path d="${P([["M", 126, 42], ["L", 121, 50], ["L", 124, 50], ["L", 130, 42], ["Z"]])}"/><circle cx="${X(122)}" cy="${Y(51)}" r="${r1(3.2 * s)}"/><path d="${P([["M", 161, 41], ["L", 161, 49], ["L", 163, 49], ["L", 163, 41], ["Z"]])}"/><circle cx="${X(162)}" cy="${Y(50.5)}" r="${r1(2.6 * s)}"/>`;
  if (gear === "floats") under = `<path d="${P([["M", 112, 42], ["L", 108, 51], ["L", 111, 51], ["L", 116, 42], ["Z"], ["M", 150, 41], ["L", 150, 51], ["L", 153, 51], ["L", 153, 41], ["Z"]])}"/><path class="fl" d="${P([["M", 76, 51], ["L", 166, 51], ["C", 174, 51, 178, 53, 180, 55], ["L", 92, 56], ["C", 84, 56, 78, 54, 76, 51], ["Z"]])}"/>`;
  return { body, parts, fin, glass, prop, under, turbo };
}

export function profileSVG(id, { dark = false, accent = "#2f6bd0" } = {}) {
  const fill = dark ? "#dfe5ec" : "#f5f7fa", line = dark ? "#8392a5" : "#4a5568", win = dark ? "#2a3442" : "#39475a", grey = dark ? "#aab4c0" : "#8d99a8";
  const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 64" width="200" height="64"><g stroke="${line}" stroke-width="1" stroke-linejoin="round" fill="${fill}">${inner}</g></svg>`;
  const P = (d, f) => (d ? `<path d="${d}"${f ? ` fill="${f}"` : ""}/>` : "");
  if (id === "heli") {
    return wrap(`<path d="M94 31 L28 32 L28 36 L94 39 Z"/><path d="M30 34 L20 16 L27 16 L38 33 Z" fill="${accent}"/><circle cx="24" cy="24" r="8" fill="none" stroke-dasharray="3 2"/>`
      + `<path d="M96 22 C120 17 152 21 164 34 C166 43 154 47 132 47 L104 47 C94 47 88 41 90 32 Z"/><path d="M128 24 C140 23 152 27 158 33 L130 33 Z" fill="${win}"/>`
      + `<rect x="122" y="13" width="5" height="9"/><path d="M40 12 L196 12 L196 14.5 L40 14.5 Z" fill="${grey}"/>`
      + `<path d="M104 47 L100 53 M150 47 L154 53" fill="none"/><path d="M88 54 L164 54 C168 54 170 52 171 50" fill="none" stroke-width="2"/>`);
  }
  if (id === "military") {
    const g = dark ? "#b7c0cb" : "#9aa5b2";
    return wrap(`<path d="M30 31 L16 8 L30 8 L62 30 Z" fill="${accent}"/><path d="M14 33 L50 34 L50 37 L16 36 Z"/>`
      + `<path d="M18 30 L44 28 L140 28 L194 35 L140 40 L44 41 L18 40 Z" fill="${g}"/><path d="M134 28 C142 20 160 21 168 31 L134 31 Z" fill="${win}"/>`
      + `<path d="M74 40 L124 39 L136 44 L84 45 Z" fill="${g}"/><path d="M98 36 L118 36 L118 41 L98 41 Z" fill="${grey}"/>`);
  }
  if (["single", "twin", "float"].includes(id)) {
    const o = id === "single" ? light({ s: 0.95 }) : id === "twin" ? light({ s: 1, high: false, twin: true }) : light({ s: 1.05, gear: "floats" });
    const [fin, ...rest] = o.parts;
    return wrap(`${P(fin, accent)}${rest.slice(0, 1).map((d) => P(d)).join("")}${P(o.body)}${rest.slice(1).map((d) => P(d)).join("")}${P(o.glass, win)}${o.under.replace('class="fl"', `fill="${fill}"`)}`
      + `<ellipse cx="${o.prop.cx}" cy="${o.prop.cy}" rx="1.6" ry="${r1(o.prop.ry)}" fill="${grey}" stroke="none" opacity=".7"/>`);
  }
  if (id === "turboprop") {
    const j = jet({ x0: 22, x1: 182, cy: 36, r: 6.5, eng: "wing", er: 3, el: 10, ex: 110, tt: true, win: 6 });
    const wingTop = `M92 28.5 L132 28.5 L136 26 L96 26 Z`, nac = `M106 25 L136 25 C140 25 142 28 142 30 C142 33 140 34 136 34 L110 34 Z`;
    return wrap(`${P(j.fin, accent)}${P(j.parts[1])}${P(j.body)}${P(wingTop)}${P(nac)}<g fill="${win}" stroke="none">${j.wins.join("")}</g>${P(j.ck, win)}`
      + `<ellipse cx="144" cy="29.5" rx="1.6" ry="14" fill="${grey}" stroke="none" opacity=".7"/>`);
  }
  const cfg = {
    narrow: { x0: 16, x1: 188, cy: 36, r: 7, eng: "wing", er: 4, el: 22, ex: 100, tt: false },
    wide: { x0: 8, x1: 194, cy: 35, r: 9.5, eng: "wing", er: 6, el: 30, ex: 98, tt: false, win: 4.2, big: true },
    regional: { x0: 20, x1: 184, cy: 36, r: 6, eng: "rear", er: 3.5, el: 20, ex: 104, tt: true, win: 5 },
    bizjet: { x0: 34, x1: 174, cy: 36, r: 5.2, eng: "rear", er: 3.2, el: 18, ex: 104, tt: true, win: 10 },
  }[id] || null;
  if (!cfg) return "";
  const j = jet(cfg);
  const [, stab, wing, nac, pylon] = j.parts;
  const engs = cfg.eng === "rear" ? `${P(j.body)}${P(pylon)}${P(nac)}${P(wing)}` : `${P(wing)}${P(j.body)}${P(pylon)}${P(nac)}`;
  return wrap(`${P(j.fin, accent)}${P(stab)}${engs}<g fill="${win}" stroke="none">${j.wins.join("")}</g>${P(j.ck, win)}`);
}
export const profileURI = (id, opts) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(profileSVG(id, opts))}`;
