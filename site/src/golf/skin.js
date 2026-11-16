// "Clubhouse" skin extras for Fairway Forecast: a scorecard-style live strip under the top bar ("DATA AS OF", good days
// ahead, best tee time), a clubhouse-rule flavour line at the foot of the left rail, and a basemap tint (card stock by
// day, baize and brass by night). Everything here exists only while the skin is active (data-skin="alt" on <html>)
// and is removed when it is switched off. It reads the data the modules already loaded (common.js G).
import { G, R, regionDays, goodRegionDay, regionCourses, forecastOf, L, fDow, day, hhmm } from "./common.js";

const root = document.documentElement;
const on = () => root.dataset.skin === "alt";
const dark = () => (root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
const RULES = [
  "Repair your pitch marks, and one more.",
  "Rake the bunker. Leave it better than you found it.",
  "Play ready golf. The group behind thanks you.",
  "Replace your divots. Fill with sand where provided.",
  "Shirts with collars in the clubhouse, please.",
  "Frost delay? Tee time stands; coffee's on.",
];
let built = null;

function h(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

export function clubhouse() {
  const sync = () => { if (on()) { build(); update(); } else teardown(); };
  window.addEventListener("skinchange", sync);
  for (const ev of ["golf-data", "golf-region", "golf-weights"]) window.addEventListener(ev, () => { if (on()) update(); });
  sync();
}

function build() {
  if (built) return;
  const top = document.querySelector(".topbar");
  if (!top) return;
  const strip = h("div", "ch-strip");
  strip.setAttribute("aria-hidden", "true");
  strip.innerHTML = `<div class="ch-strip-in">
    <span class="ch-live"><i class="ch-dot"></i>Starter's hut</span>
    <span class="ch-r"><em>Region</em><b data-k="region">—</b></span>
    <span class="ch-r"><em>Good days ahead</em><b data-k="good">—</b></span>
    <span class="ch-r"><em>Best tee time</em><b data-k="tee">—</b></span>
    <span class="ch-r"><em>Top of the board</em><b data-k="top">—</b></span>
    <span class="ch-r ch-asof"><em>Data as of</em><b data-k="asof">—</b></span>
  </div>`;
  top.after(strip);
  const flav = h("p", "ch-flavour", RULES[new Date().getDate() % RULES.length]);
  flav.setAttribute("aria-hidden", "true");
  document.querySelector(".cx-foot")?.append(flav);
  built = { strip, flav };
}
function teardown() {
  if (!built) return;
  built.strip.remove(); built.flav.remove();
  built = null;
}
function update() {
  if (!built || !G.P) return;
  const set = (k, v) => { const n = built.strip.querySelector(`[data-k="${k}"]`); if (n) n.textContent = v; };
  set("region", R().short);
  const rd = regionDays();
  set("good", `${rd.filter(goodRegionDay).length} / ${rd.length}`);
  // best tee time: the highest-ranked course on the best day, with its window
  const best = rd.reduce((a, b) => (b.median > a.median ? b : a));
  const cs = regionCourses().filter((c) => L(c.id)).sort((a, b) => L(b.id).score - L(a.id).score);
  const pick = cs.map((c) => ({ c, f: forecastOf(c.id) })).find((x) => x.f?.days[best.k]?.best_start);
  set("tee", pick ? `${fDow(day(best.date))} ${hhmm(pick.f.days[best.k].best_start)} · ${pick.c.name.replace(/ Golf.*$/, "")}` : "—");
  set("top", cs[0] ? `${cs[0].name.replace(/ Golf.*$/, "").replace(/^Bear Mountain Resort - /, "Bear Mtn ")} (S)` : "—");
  const t = new Date(G.P.forecast_fetched || G.P.generated);
  set("asof", t.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }));
}

// ------------------------------------------------------------------ basemap tint
const TINT = {
  day: { bg: "#f1ead6", water: "#b9cfd0", green: "#dfe3c6", land: "#ece4cc", bldg: "#e2d8bd", road: "#fbf7ea", minor: "#f5efdc", casing: "#d3c7a6" },
  night: { bg: "#0e1d15", water: "#08130e", green: "#13291c", land: "#112319", bldg: "#183022", road: "#2a3d2f", minor: "#1d3024", casing: "#33483a" },
};
export function skinMap(map) {
  if (map.__chHooked) return;
  map.__chHooked = true;
  map.on("style.load", () => tint(map));
  if (map.isStyleLoaded()) tint(map);
}
function tint(map) {
  if (!on()) return; // Classic: the themechange setStyle() restores the stock basemap
  const P = dark() ? TINT.night : TINT.day;
  const set = (id, prop, v) => { try { map.setPaintProperty(id, prop, v); } catch { /* layer absent in this style */ } };
  for (const l of map.getStyle()?.layers || []) {
    const id = l.id;
    if (/^(courses|detail)/.test(id) || l.type === "symbol") continue;
    if (l.type === "background") set(id, "background-color", P.bg);
    else if (l.type === "fill") {
      if (/water/.test(id)) set(id, "fill-color", P.water);
      else if (/park|wood|grass|glacier|ice/.test(id)) set(id, "fill-color", P.green);
      else if (/building/.test(id)) { set(id, "fill-color", P.bldg); set(id, "fill-outline-color", P.casing); }
      else if (/landuse|pier|aeroway/.test(id)) set(id, "fill-color", P.land);
    } else if (l.type === "line") {
      if (/waterway/.test(id)) set(id, "line-color", P.water);
      else if (/casing/.test(id)) set(id, "line-color", P.casing);
      else if (/minor|path|pier|subtle|taxiway|rail/.test(id)) set(id, "line-color", P.minor);
      else if (/highway|road|runway/.test(id)) set(id, "line-color", P.road);
    }
  }
}
