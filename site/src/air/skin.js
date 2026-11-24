// "Flight Strip" skin extra for Air Traffic: one thin strip under the top bar in the manner of an ATC flight-progress
// strip (in the air now, lowest, nearest METAR, data as of). It exists only while the skin is on (data-skin="alt").
import { A, aircraft, isLive, fTime } from "./common.js";
import { airborne, fAlt, callsign } from "./feed.js";

const root = document.documentElement;
let strip = null;
const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const item = (label, value) => { const s = h("span"); s.append(h("small", "", label), h("b", "", value)); return s; };

export function flightStrip() {
  if (root.dataset.skin !== "alt" || root.classList.contains("embed")) { strip?.remove(); strip = null; return; }
  const top = document.querySelector(".topbar");
  if (!strip && top) { strip = h("div", "fs-strip"); strip.setAttribute("aria-hidden", "true"); top.after(strip); }
  if (!strip) return;
  const U = aircraft().filter(airborne), low = U.filter((a) => a.alt != null).sort((a, b) => a.alt - b.alt)[0];
  const m = A.wx?.metar && Object.values(A.wx.metar)[0];
  const live = h("span", "fs-live"); live.append(h("i", "fs-dot"), isLive() ? "Live" : A.uncovered ? "No live aircraft" : "Connecting");
  strip.replaceChildren(live, item("Place", A.place.short), item("Airborne", String(U.length)), item("Lowest", low ? `${callsign(low)} ${fAlt(low.alt)}` : "–"),
    item(m ? m.icaoId : "METAR", m ? `${m.fltCat || "–"} · ${m.wdir ?? "–"}/${m.wspd ?? "–"} kt` : "–"), item("Data as of", A.live ? fTime(A.live.as_of) : "–"));
}
