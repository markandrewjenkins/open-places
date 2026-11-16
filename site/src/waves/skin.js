// "Neoprene '94" skin extras for West Coast Water: a surf-shop "conditions board" live strip under the top bar (pulsing
// dot, buoy readouts, best window, DATA AS OF), a flavour line at the foot of the left rail, and a hover/press ripple on
// tiles and cards. Everything here exists only while the skin is active (data-skin="alt" on <html>) and is removed when
// it is switched off. It only reads data the modules already loaded (W.waves).
import { W, TZ, swell, wd, hr, f0, f1 } from "./common.js";

const root = document.documentElement;
const on = () => root.dataset.skin === "alt";
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
let built = null;

export function neoprene() {
  if (on()) { build(); update(); }
}

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function build() {
  if (built) return;
  const top = document.querySelector(".topbar"), foot = document.querySelector(".cx-foot");
  if (!top || !foot) return;
  const strip = h("div", "np-strip");
  strip.setAttribute("aria-hidden", "true");
  strip.innerHTML = `<div class="np-strip-in">
    <span class="np-live"><i class="np-dot"></i>Live</span>
    <span><em>Neah Bay</em><b data-k="nb">—</b></span>
    <span class="np-hide-sm"><em>La Perouse</em><b data-k="lp">—</b></span>
    <span class="np-hide-sm"><em>English Bay</em><b data-k="eb">—</b></span>
    <span><em>Best window</em><b data-k="best" data-tier>—</b></span>
    <span class="np-asof"><em>Data as of</em><b data-k="asof">—</b></span>
  </div>`;
  top.after(strip);
  const flav = h("p", "np-flavour", "Booties on. Hood up. Check Neah Bay first.");
  flav.setAttribute("aria-hidden", "true");
  foot.append(flav);
  built = { strip, flav };
  window.dispatchEvent(new Event("resize")); // the console re-measures the space above the app
}

function teardown() {
  if (!built) return;
  built.strip.remove(); built.flav.remove();
  built = null;
  window.dispatchEvent(new Event("resize"));
}

function update() {
  if (!built || !W.waves) return;
  const set = (k, v) => { const n = built.strip.querySelector(`[data-k="${k}"]`); if (n) n.textContent = v; };
  const B = W.waves.buoys;
  const nb = B["46087"]?.latest, lp = B["46206"]?.latest, eb = B["46304"]?.latest;
  set("nb", nb ? swell(nb.hs, nb.tp, nb.dir) : "no report");
  set("lp", lp ? `${swell(lp.hs, lp.tp, lp.dir)}${lp.stale ? " (stale)" : ""}` : "no report");
  set("eb", eb ? `${f1(eb.hs, " m")} · wind ${f0(eb.wspd)} km/h` : "no report");
  const best = ["S", "A", "B", "C"].flatMap((t) => W.waves.windows.items[t] || [])[0];
  set("best", best ? `${best.tier} ${best.name.replace(/ \(.*\)/, "")} ${wd(best.start)} ${hr(best.start)}` : "none this week");
  set("asof", new Date(W.waves.generated).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ }));
}

// ripple: a ring of colour from the pointer on tiles and cards
document.addEventListener("pointerdown", (e) => {
  if (!on() || still()) return;
  const host = e.target.closest?.(".cx-tile, button.card, .ww-card");
  if (!host) return;
  const r = host.getBoundingClientRect(), dot = h("span", "np-ripple");
  dot.style.left = `${e.clientX - r.left}px`; dot.style.top = `${e.clientY - r.top}px`;
  host.append(dot);
  dot.addEventListener("animationend", () => dot.remove(), { once: true });
});

window.addEventListener("skinchange", () => { if (on()) { build(); update(); } else teardown(); });
window.addEventListener("waves-data", () => { if (on()) { build(); update(); } });
