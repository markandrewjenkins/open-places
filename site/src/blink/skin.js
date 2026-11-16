// "Night Run" skin extras for Route 95 Reliability: a "DATA AS OF" strip under the top bar (buses at the last logged
// poll, on-time share with its sample, hours watched, the time of the last poll) and a flavour line at the foot of the
// rail. Everything exists only while the skin is active (data-skin="alt" on <html>) and is removed when it's switched
// off. It only reads data the modules already loaded (common.js).
import { B, MIN, thin, pct, hrs, fStamp, fTime, coverage } from "./common.js";

const root = document.documentElement;
const on = () => root.dataset.skin === "alt";
let strip = null, flav = null;

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function item(label, value, isThin) {
  const s = h("span", isThin ? "nr-thin" : "");
  s.append(label, h("b", "", value));
  return s;
}

export function nightRun() {
  if (!on()) { strip?.remove(); flav?.remove(); strip = flav = null; return; }
  if (!B.blink) return;
  const top = document.querySelector(".topbar");
  if (!strip && top) { strip = h("div", "nr-strip"); strip.setAttribute("aria-hidden", "true"); top.after(strip); }
  if (strip) {
    const p = B.blink.headline.punctuality, c = coverage(), w = B.blink.headline.wait;
    const live = h("span", "nr-live"); live.append(h("i", "nr-dot"), B.live?.realtime ? "Live" : "Logging");
    const asof = item("Data as of", fStamp(B.live?.as_of || c.last)); asof.classList.add("nr-asof");
    strip.replaceChildren(live,
      item("Buses on route", String(B.live?.vehicles?.length ?? 0)),
      item("On time", thin(p.n, MIN.events) ? `${pct(p.on_time)} · collecting` : pct(p.on_time), thin(p.n, MIN.events)),
      item("Excess wait", w.ewt_min == null ? "–" : thin(w.stop_hours, MIN.stopHours) ? "collecting" : `${w.ewt_min.toFixed(1)} min`, thin(w.stop_hours, MIN.stopHours)),
      item("Watched", `${hrs(c.hours)} / ${c.days}d`),
      asof);
  }
  const foot = document.querySelector(".cx-foot");
  if (!flav && foot) { flav = h("p", "nr-flavour"); flav.setAttribute("aria-hidden", "true"); foot.append(flav); }
  if (flav) flav.textContent = `Langford ⇄ Downtown · ${B.live?.realtime ? "live" : "last bus logged"} ${fTime(B.live?.as_of)} · hold on while the bus is moving`;
}
