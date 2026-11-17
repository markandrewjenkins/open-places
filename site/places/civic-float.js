// Open Places: compact, collapsible floating panels over the map ("float panels"). The pattern for putting a page's
// non-map content (forecasts, lists, charts, detail) over the map instead of in a full-height side pane:
//   - every panel is a glass card in the stage's left or right column, sized to its content, capped by the column
//   - its header folds it to a one-line bar (the fold is remembered per panel, across pages and visits)
//   - the column keeps its width when a panel folds, so the map's padding and view don't jump
//   - long content scrolls inside the panel, and keeps its scroll position across the shell's re-renders
//   - a panel can be hidden while it has nothing to say (detail before a selection), still without moving the map
// The shell (civic.js fpanel) builds the panel's section and header around the body each render; float() marks the body,
// and the section is decorated right after it lands (a header button with aria-expanded, data-folded on the section).
//
//   float(body, key, { folded })   mark a panel body (an element the page keeps between renders) → body
//   floatShow(body, on)            show or hide the body's panel without re-rendering
// See civic-float.css for the look. Proposed for the shell: fpanel(…, { fold: key }) doing the same natively.
import "./civic-float.css";

const KEY = "odp-places-fold";
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } };
const write = (o) => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* private mode: the fold just isn't remembered */ } };
const state = read();
const bodies = new Set();
let queued = false;

/** mark a panel body as foldable; key names the panel (e.g. "trails:adv"); o.folded = the default; o.keep = the page reuses
 *  this body across renders (else it's forgotten once it leaves the page) */
export function float(body, key, o = {}) {
  body.dataset.fold = key;
  body.classList.add("flt-body");
  if (o.folded && !(key in state)) state[key] = true;
  if (!body.flt) {
    body.flt = { top: 0, hide: false, keep: !!o.keep };
    // remember the scroll of any scroller inside (the shell re-wraps the body each render, which resets it)
    body.addEventListener("scroll", (e) => { const t = e.target; if (t instanceof Element) t.dataset.st = String(t.scrollTop); }, true);
  }
  bodies.add(body);
  schedule();
  return body;
}
/** show or hide a body's panel in place (keeps the column, so the map doesn't move) */
export function floatShow(body, on) {
  body.flt = body.flt || { top: 0 };
  body.flt.hide = !on;
  const sec = body.closest(".civ-fpanel");
  if (sec) sec.hidden = !on;
}
function schedule() { if (!queued) { queued = true; queueMicrotask(() => { queued = false; decorate(); }); requestAnimationFrame(decorate); } }

function decorate() {
  for (const b of bodies) {
    if (!b.isConnected) { if (b.flt?.seen && !b.flt.keep) bodies.delete(b); continue; }
    b.flt.seen = true;
    const sec = b.closest(".civ-fpanel"), h = sec?.querySelector(":scope > .civ-fp-h");
    if (!sec || !h) continue;
    sec.classList.add("flt");
    sec.hidden = !!b.flt?.hide;
    const key = b.dataset.fold, folded = !!state[key];
    sec.toggleAttribute("data-folded", folded);
    let btn = h.querySelector(":scope > .flt-fold");
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button"; btn.className = "flt-fold";
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
      h.append(btn);
      h.classList.add("flt-h");
      const toggle = (e) => { if (e.target.closest("a, button:not(.flt-fold), input, select")) return; state[key] = !state[key]; if (!state[key]) delete state[key]; write(state); decorate(); };
      h.addEventListener("click", toggle);
    }
    const title = h.textContent.trim();
    btn.setAttribute("aria-expanded", String(!folded));
    btn.setAttribute("aria-label", `${folded ? "Show" : "Fold"} ${title}`);
    btn.title = folded ? "Show" : "Fold to the title";
    // scrollers get their position back after the shell moved the body
    for (const s of b.querySelectorAll("[data-st]")) { const v = +s.dataset.st; if (v && Math.abs(s.scrollTop - v) > 2) s.scrollTop = v; }
  }
}
