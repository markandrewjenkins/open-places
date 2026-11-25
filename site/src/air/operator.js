// Who flies an aircraft, for the Air Traffic card's "Operator" row. An airline callsign (three letters and a flight
// number, ACA810) names the airline from OpenFlights' airline database (data/air/airline-names.json, ODbL 1.0, built by
// tools/fetch_airline_names.mjs, loaded once, lazily). Anything else is private or general aviation, with the country the
// aircraft is registered in from its ICAO 24-bit address: ICAO Annex 10 (Vol. III) gives each state a block of addresses.
// Military aircraft (adsb.lol's flag) say so. No registrations or owner names are shown.
//
//   loadAirlines() → Promise
//   operatorOf(a) → { text, sub } | null   sync; airline names appear once the file has loaded
//   operatorEl(a) → <span>                 fills itself in when the airline names arrive
//   airlineOf(a) → Promise<{ code, name } | null>   the airline behind an airline callsign (photo.js: its livery)
//   regCountry(hex) → "Canada" | ""        the state an ICAO 24-bit address is allocated to
import { el } from "../shared/ui.js";

let NAMES = null, LOAD = null;
const waiting = new Set();
export function loadAirlines() {
  return (LOAD ||= fetch(new URL("../data/air/airline-names.json", location.href))
    .then((r) => (r.ok ? r.json() : null)).catch(() => null)
    .then((j) => { NAMES = j?.names || {}; for (const f of waiting) f(); waiting.clear(); return NAMES; }));
}

// ICAO 24-bit address blocks (ICAO Annex 10, Vol. III, Part I, Ch. 9, Table 9-1): [first, last, state]. The states
// aircraft over the Salish Sea come from most often, and the larger blocks; anything else reads "registration unknown".
const BLOCKS = [
  [0x008000, 0x00ffff, "South Africa"], [0x010000, 0x017fff, "Egypt"], [0x040000, 0x040fff, "Ethiopia"], [0x06a000, 0x06a3ff, "Qatar"],
  [0x0ac000, 0x0acfff, "Colombia"], [0x0b0000, 0x0b0fff, "Cuba"], [0x0c2000, 0x0c27ff, "Panama"], [0x0d0000, 0x0d7fff, "Mexico"],
  [0x100000, 0x1fffff, "Russia"], [0x300000, 0x33ffff, "Italy"], [0x340000, 0x37ffff, "Spain"], [0x380000, 0x3bffff, "France"],
  [0x3c0000, 0x3fffff, "Germany"], [0x400000, 0x43ffff, "United Kingdom"], [0x440000, 0x447fff, "Austria"], [0x448000, 0x44ffff, "Belgium"],
  [0x458000, 0x45ffff, "Denmark"], [0x460000, 0x467fff, "Finland"], [0x468000, 0x46ffff, "Greece"], [0x470000, 0x477fff, "Hungary"],
  [0x478000, 0x47ffff, "Norway"], [0x480000, 0x487fff, "Netherlands"], [0x488000, 0x48ffff, "Poland"], [0x490000, 0x497fff, "Portugal"],
  [0x498000, 0x49ffff, "Czechia"], [0x4a8000, 0x4affff, "Sweden"], [0x4b0000, 0x4b7fff, "Switzerland"], [0x4b8000, 0x4bffff, "Turkey"],
  [0x4ca000, 0x4cafff, "Ireland"], [0x4cc000, 0x4ccfff, "Iceland"], [0x710000, 0x717fff, "Saudi Arabia"], [0x718000, 0x71ffff, "South Korea"],
  [0x738000, 0x73ffff, "Israel"], [0x750000, 0x757fff, "Malaysia"], [0x758000, 0x75ffff, "Philippines"], [0x760000, 0x767fff, "Pakistan"],
  [0x768000, 0x76ffff, "Singapore"], [0x780000, 0x7bffff, "China"], [0x7c0000, 0x7fffff, "Australia"], [0x800000, 0x83ffff, "India"],
  [0x840000, 0x87ffff, "Japan"], [0x880000, 0x887fff, "Thailand"], [0x888000, 0x88ffff, "Vietnam"], [0x896000, 0x896fff, "United Arab Emirates"],
  [0x899000, 0x8993ff, "Taiwan"], [0x8a0000, 0x8affff, "Indonesia"], [0xa00000, 0xafffff, "United States"], [0xc00000, 0xc3ffff, "Canada"],
  [0xc80000, 0xc87fff, "New Zealand"], [0xe00000, 0xe3ffff, "Argentina"], [0xe40000, 0xe7ffff, "Brazil"], [0xe80000, 0xe80fff, "Chile"],
];
/** the airline behind an airline callsign ("ACA810" → { code: "ACA", name: "Air Canada" }), once the names have loaded; else null */
export async function airlineOf(a) {
  const m = /^([A-Z]{3})\d/.exec(String(a?.flight || "").trim().toUpperCase());
  if (!m || a.mil) return null;
  const n = (await loadAirlines())?.[m[1]];
  return n ? { code: m[1], name: n[0] } : null;
}
export function regCountry(hex) {
  const n = parseInt(String(hex || "").replace(/^~/, ""), 16);
  if (!Number.isFinite(n) || /^~/.test(hex || "")) return "";
  return BLOCKS.find(([a, b]) => n >= a && n <= b)?.[2] || "";
}

export function operatorOf(a) {
  if (!a) return null;
  const c = String(a.flight || "").trim().toUpperCase(), reg = regCountry(a.hex);
  const where = reg ? `registered in ${reg}` : a.hex ? "registration country unknown" : "identity withheld";
  if (a.mil) return { text: "Military", sub: where };
  const m = /^([A-Z]{3})\d/.exec(c);
  if (m) {
    const n = NAMES?.[m[1]];
    if (n) return { text: n[0], sub: n[1] ? `airline · ${n[1]}` : "airline", src: "OpenFlights (ODbL)" };
    if (NAMES) return { text: `Operator code ${m[1]}`, sub: where };
    return { text: m[1], sub: where };
  }
  return { text: "Private / general aviation", sub: where };
}
export function operatorEl(a) {
  const span = el("span", { class: "air-op" });
  const fill = () => { const o = operatorOf(a); span.replaceChildren(o ? o.text : "unknown", o?.sub ? el("small", {}, ` · ${o.sub}`) : ""); if (o?.src) span.title = `Airline from the callsign prefix; ${o.src}`; };
  fill();
  if (!NAMES) { waiting.add(fill); loadAirlines(); }
  return span;
}
