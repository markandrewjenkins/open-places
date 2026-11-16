// Open Places: the overview's Alert Feed ("what changed") and the detector runner.
//
// Any code on the page reports a change with
//   window.dispatchEvent(new CustomEvent("op-alert", { detail: { id, topic, level, title, body, place, href, seed? } }))
//   id     stable string, so repeats are dropped (e.g. "drivebc:DBC-12345:closed")
//   topic  module id ("roads", "airtraffic", …) → colour and label;  level "info" | "notice" | "warn"
//   place  optional place id or name; events for places outside the current place's chain are ignored
//   seed   optional: the first-load state ("2 warnings active"), shown but never sounded
//   since  optional: when the condition began (ISO time); the Overview shows "since …", else when it was noticed
// The feed keeps the last 50 per place in sessionStorage ("odp-alerts:<place id>"), newest first, and renders them as a
// one-line strip near the top of #overview (with an "All" list), in the All Alerts pane (#alerts-feed) and on each topic's
// Summary page.
//
// Detectors: a module may define detect(data, ctx) → items | { items, summary }, where data is its need(ctx) result and
// each item is { id, level, title, body, href, state? }. run(modules) evaluates them (on every data arrival and once a
// minute) and dispatches op-alert only for changes:
//   default items are events, sent once per id per place per session (a new quake, an aircraft, a warning);
//   state items (state: true) are sent when they appear after being absent (an air-quality category).
// A module's first evaluation for a place is the seed: it sends `summary` if the result has that key (null = nothing),
// else up to three notice/warn items, all with seed: true. Runner state lives in sessionStorage ("odp-alert-run:<place>").

import { el } from "../src/shared/ui.js";
import { chainOf, PLACES } from "./civic-data.js";

const MAX = 50;
const LEVELS = ["info", "notice", "warn"];
const ss = {
  get: (k, d) => { try { const v = sessionStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set: (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked or full */ } },
};
const LEVEL_NAME = { info: "Information", notice: "Notice", warn: "Warning" };

/** "now", "4 min", "3 h", "2 d" */
export function rel(t, now = Date.now()) {
  const s = Math.max(0, (now - t) / 1000);
  return s < 45 ? "now" : s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`;
}

/**
 * ctx: the shell context (ctx.place); colorOf(topic) → CSS colour; nameOf(topic) → label; onNew(alert) after a new one is
 * stored (alert.seed tells first-load state apart).
 */
export function createAlerts({ ctx, colorOf = () => "var(--accent)", nameOf = (t) => t, onNew = null } = {}) {
  const key = () => `odp-alerts:${ctx.place?.id || "none"}`;
  let items = ss.get(key(), []);
  const listeners = new Set();

  // a known place (id or name) must be the current place or above it; any other string ("Swartz Bay", "Haro Strait") is a
  // location label inside the area and is kept as the alert's "where"
  const known = (s) => PLACES.find((n) => [n.id, n.name, n.short].some((v) => v && String(v).toLowerCase() === s));
  const placeMatch = (pl) => {
    if (pl == null || pl === "") return true;
    const s = String(pl).toLowerCase();
    if (chainOf(ctx.place).some((n) => [n.id, n.name, n.short].some((v) => v && String(v).toLowerCase() === s))) return true;
    return !known(s);
  };
  /** steps up from the current place to the alert's place (0 = here or a location inside it) */
  const distOf = (pl) => { if (pl == null || pl === "") return 0; const s = String(pl).toLowerCase(), i = chainOf(ctx.place).findIndex((n) => [n.id, n.name, n.short].some((v) => v && String(v).toLowerCase() === s)); return i < 0 ? 0 : i; };

  function add(d) {
    if (!d || d.id == null || !d.title || !placeMatch(d.place)) return null;
    const id = String(d.id);
    if (items.some((x) => x.id === id)) return null;
    const a = { id, topic: String(d.topic || ""), level: LEVELS.includes(d.level) ? d.level : "info", title: String(d.title).slice(0, 140),
      body: d.body ? String(d.body).slice(0, 400) : "", href: typeof d.href === "string" && d.href.startsWith("#") ? d.href : "", t: Date.now(), seed: !!d.seed,
      where: d.place != null && !known(String(d.place).toLowerCase()) ? String(d.place).slice(0, 80) : "", dist: distOf(d.place), since: d.since ? Date.parse(d.since) || null : null };
    items.unshift(a);
    if (items.length > MAX) items.length = MAX;
    ss.set(key(), items);
    paint();
    for (const f of listeners) f(a);
    onNew?.(a);
    return a;
  }
  addEventListener("op-alert", (e) => add(e.detail));

  // ---------------------------------------------------------------- rendering
  const levelIcon = (lv) => el("i", { class: "civ-fd-ic", "data-level": lv, role: "img", "aria-label": LEVEL_NAME[lv] });
  /** one feed row: icon, title, (body), topic, relative time; a link when it has an href */
  function row(a, { body = false } = {}) {
    const tag = a.href ? "a" : "div";
    const n = el(tag, { class: `civ-fd${a.seed ? " seed" : ""}`, "data-level": a.level, href: a.href || null, title: [a.title, a.body, nameOf(a.topic)].filter(Boolean).join(" · ") },
      levelIcon(a.level),
      el("b", { class: "civ-fd-t" }, a.title),
      body && a.body ? el("span", { class: "civ-fd-b" }, a.body) : null,
      el("small", { class: "civ-fd-k" }, [nameOf(a.topic), a.seed ? "at load" : null].filter(Boolean).join(" · ")),
      el("time", { class: "civ-fd-w", datetime: new Date(a.t).toISOString() }, rel(a.t)));
    n.style.setProperty("--tc", colorOf(a.topic));
    return n;
  }
  /** a vertical list of rows (the All list, the alerts pane, a topic summary) */
  function listEl(list, { empty = "No changes yet." } = {}) {
    return list.length ? el("div", { class: "civ-fd-list" }, ...list.map((a) => row(a, { body: true }))) : el("p", { class: "civ-fd-none" }, empty);
  }

  // the overview row: heading, the newest few as one line, and an All button with the full list
  const strip = el("div", { class: "civ-fd-strip", role: "list" });
  const allBtn = el("button", { type: "button", class: "civ-fd-all", "aria-expanded": "false", "aria-haspopup": "true" }, "All");
  const pop = el("div", { class: "civ-fd-pop", hidden: "", role: "dialog", "aria-label": "Alert feed" });
  const count = el("span", {});
  const section = el("section", { class: "civ-step civ-feed", "data-level": "feed", "aria-label": "Alert feed" },
    el("header", { class: "civ-step-h" }, el("b", {}, "Alert Feed"), count),
    strip, el("div", { class: "civ-fd-side" }, allBtn, pop));
  const closePop = () => { pop.hidden = true; allBtn.setAttribute("aria-expanded", "false"); };
  allBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!pop.hidden) return closePop();
    pop.replaceChildren(el("div", { class: "civ-fd-pop-h" }, `Last ${items.length} for ${ctx.place?.short || "here"} · this session`),
      listEl(items, { empty: "Nothing has changed since this page opened." }));
    pop.hidden = false; allBtn.setAttribute("aria-expanded", "true");
  });
  document.addEventListener("click", (e) => { if (!pop.hidden && !pop.contains(e.target)) closePop(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) { closePop(); allBtn.focus(); } });
  pop.addEventListener("click", (e) => { if (e.target.closest("a")) closePop(); });

  function paint() {
    const now = Date.now();
    count.textContent = items.length ? `${items.length} this session` : "what changed";
    strip.replaceChildren(...(items.length ? items.slice(0, 8).map((a) => { const r = row(a); r.setAttribute("role", "listitem"); return r; })
      : [el("span", { class: "civ-fd-none" }, "No changes yet. New alerts appear here as the feeds update.")]));
    allBtn.textContent = items.length ? `All ${items.length}` : "All";
    allBtn.disabled = !items.length;
    for (const t of document.querySelectorAll(".civ-fd-w")) { const d = Date.parse(t.getAttribute("datetime")); if (d) t.textContent = rel(d, now); }
    const pane = document.getElementById("alerts-feed");
    if (pane) pane.replaceChildren(listEl(items, { empty: "Nothing has changed since this page opened. New alerts land here, newest first." }));
  }
  setInterval(() => { if (!document.hidden) paint(); }, 30000);

  // ---------------------------------------------------------------- detectors
  const runKey = () => `odp-alert-run:${ctx.place?.id || "none"}`;
  const stamp = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`; };
  function emit(x, m, seed) {
    dispatchEvent(new CustomEvent("op-alert", { detail: { id: x.id, topic: m.id, level: x.level || "info", title: x.title, body: x.body || "", place: ctx.place?.id, href: x.href || `#${m.id}`, seed: !!seed } }));
  }
  function run(mods) {
    if (!ctx.place) return;
    const st = ss.get(runKey(), { init: [], seen: [], prev: {} });
    let dirty = false;
    for (const m of mods) {
      if (typeof m.detect !== "function" || typeof m.need !== "function") continue;
      try { if (m.applies && !m.applies(ctx)) continue; } catch { continue; }
      let d, out;
      try { d = m.need(ctx); } catch { continue; }
      if (!d || d.err) continue;
      try { out = m.detect(d, ctx); } catch (e) { console.warn(`[alerts] ${m.id} detector:`, e?.message || e); continue; }
      const list = (Array.isArray(out) ? out : out?.items || []).filter((x) => x && x.id != null && x.title);
      const first = !st.init.includes(m.id);
      const prev = new Set(st.prev[m.id] || []), cur = [], fresh = [];
      for (const x of list) {
        const cid = `${m.id}:${x.id}`;
        if (x.state) { cur.push(cid); if (!prev.has(cid)) fresh.push({ ...x, id: `${cid}@${stamp()}` }); }
        else if (!st.seen.includes(cid)) { st.seen.push(cid); fresh.push({ ...x, id: cid }); }
      }
      if (cur.join() !== [...prev].join()) { st.prev[m.id] = cur; dirty = true; }
      if (fresh.length) dirty = true;
      if (first) {
        st.init.push(m.id); dirty = true;
        const hasSummary = out && !Array.isArray(out) && "summary" in out;
        const seeds = hasSummary ? (out.summary ? [{ ...out.summary, id: `${m.id}:${out.summary.id}` }] : []) : fresh.filter((x) => x.level && x.level !== "info").slice(0, 3);
        for (const x of seeds) emit(x, m, true);
      } else for (const x of fresh) emit(x, m, false);
    }
    if (st.seen.length > 400) st.seen = st.seen.slice(-400);
    if (dirty) ss.set(runKey(), st);
  }

  /** after ctx.place changes: switch to that place's bucket */
  function setPlace() { items = ss.get(key(), []); closePop(); paint(); }

  paint();
  return {
    section, paint, run, setPlace, listEl, row, add,
    items: () => items.slice(),
    /** the newest non-seed alert younger than ms */
    latest: (ms) => items.find((a) => !a.seed && Date.now() - a.t < ms) || null,
    forTopics: (ids) => items.filter((a) => ids.includes(a.topic)),
    subscribe: (f) => { listeners.add(f); return () => listeners.delete(f); },
  };
}
