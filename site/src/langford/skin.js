// "Blueprint" skin extras for the Langford Boom Tracker: a "site board" strip under the title block posting the latest
// numbers, and a flavour line at the foot of the left rail. Everything here exists only while the skin is active
// (data-skin="alt" on <html>) and is removed when it is switched off. It only reads data main.js already loaded (L.D).
import { L } from "./common.js";

const root = document.documentElement;
const on = () => root.dataset.skin === "alt";
const nf = new Intl.NumberFormat("en-CA");
const n0 = (v) => (v == null ? "—" : nf.format(Math.round(v)));
let built = null;

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function build() {
  if (built) return;
  const top = document.querySelector(".topbar");
  const foot = document.querySelector(".cx-foot");
  if (!top) return;
  const strip = h("div", "bp-strip");
  strip.setAttribute("aria-hidden", "true"); // the same numbers are on the Overview tiles
  strip.innerHTML = `<div class="bp-strip-in">
    <span class="bp-board"><i class="bp-dot"></i>Site board</span>
    <span><em>Permits to</em><b data-k="month">—</b></span>
    <span><em>New homes, last 12 mo</em><b data-k="units">—</b></span>
    <span class="bp-opt"><em>Next 12 mo</em><b data-k="fc">—</b></span>
    <span class="bp-opt"><em>Residents</em><b data-k="pop">—</b></span>
    <span class="bp-asof"><em>Data as of</em><b data-k="asof">—</b></span>
  </div>`;
  top.after(strip);
  const flav = h("p", "bp-flavour", "Hard hats past this point. All dimensions to be verified on site.");
  flav.setAttribute("aria-hidden", "true");
  foot?.append(flav);
  built = { strip, flav };
}

function teardown() {
  if (!built) return;
  built.strip.remove(); built.flav.remove();
  built = null;
}

function update() {
  if (!built || !L.D) return;
  const k = L.D.kpis;
  const set = (key, v) => { const n = built.strip.querySelector(`[data-k="${key}"]`); if (n) n.textContent = v; };
  set("month", new Date(k.latest_month + "-15").toLocaleString("en-CA", { month: "short", year: "numeric" }).replace(".", ""));
  set("units", n0(k.units_ttm));
  set("fc", `~${n0(k.forecast_next12_units)}`);
  set("pop", n0(k.pop_estimate));
  set("asof", new Date(L.D.generated).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" }).replace(".", ""));
}

// main.js calls this once the console exists and again when the data arrives
export function siteBoard() {
  if (!on()) return;
  build(); update();
}
window.addEventListener("skinchange", () => { if (on()) siteBoard(); else teardown(); });
