// West Coast Water: state, data loading, formatting and the chart pieces shared by the topic modules
// (surf, calm, live, trust). Each module loads only the files it needs; files are fetched once and shared.
import * as d3 from "d3";
import { cssVar, tooltip, el, tipRow, loadJSON } from "../shared/ui.js";
import { frame, gridY, axisClean } from "../shared/charts.js";

export const TZ = "America/Vancouver";
// W.waves: waves.json · W.fc: forecast.json · W.tides · W.obs: obs_recent.json · W.bt: backtest.json · W.ctx: console ctx
export const W = { waves: null, fc: null, tides: null, obs: null, bt: null, ctx: null, spot: "jordan", paddle: "english_bay" };

export const tip = tooltip();
export const $ = (id) => (typeof id === "string" ? document.getElementById(id) : id);
export const route = () => W.ctx.route;

// ------------------------------------------------------------------ loading
const cache = {};
const file = (name, key) => (cache[name] ||= loadJSON(`../data/waves/${name}`).then((d) => { W[key] = d; return d; }));
export const loadWaves = () => file("waves.json", "waves").then((D) => {
  const gen = `Data refreshed ${new Date(D.generated).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: TZ })}`;
  for (const id of ["generated", "generated-rail"]) { const n = $(id); if (n) n.textContent = gen; }
  window.dispatchEvent(new CustomEvent("waves-data"));
  return D;
});
export const loadForecast = () => Promise.all([loadWaves(), file("forecast.json", "fc")]);
export const loadLive = () => Promise.all([loadWaves(), file("obs_recent.json", "obs"), file("tides.json", "tides")]);
export const loadTrust = () => Promise.all([loadWaves(), file("backtest.json", "bt")]);

// ------------------------------------------------------------------ Civic Atlas metadata (lon/lat bboxes; the console ignores these today)
export const BBOX_COAST = [-126.2, 48.25, -123.85, 49.25];      // Juan de Fuca open coast to Tofino
export const BBOX_VICTORIA = [-123.55, 48.38, -123.25, 48.50];
export const BBOX_VANCOUVER = [-123.30, 49.20, -122.90, 49.36];
export const BBOX_ALL = [-126.2, 48.25, -122.9, 49.45];
export const clamp01 = (v) => Math.max(0, Math.min(1, v));
// hours until the first window at or above a tier, or Infinity
export function hoursToWindow(list, minScore, now = new Date()) {
  const ws = Object.values(list?.items || {}).flat().filter((w) => w.score >= minScore);
  const h = ws.map((w) => (new Date(w.start) - now) / 36e5).filter((x) => x > -6);
  return h.length ? Math.max(0, Math.min(...h)) : Infinity;
}

// ------------------------------------------------------------------ formatting (always in Pacific time)
const fmtParts = (opt) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, ...opt });
const fWd = fmtParts({ weekday: "short" }), fWdLong = fmtParts({ weekday: "long", month: "short", day: "numeric" });
const fHr = fmtParts({ hour: "numeric" }), fHm = fmtParts({ hour: "numeric", minute: "2-digit" });
const fMd = fmtParts({ month: "short", day: "numeric" }), fYmd = fmtParts({ year: "numeric", month: "2-digit", day: "2-digit" });
const clean = (s) => s.replace(/\s?a\.m\./, " am").replace(/\s?p\.m\./, " pm").replace(/\./g, "");
export const tDate = (s) => (s instanceof Date ? s : new Date(s));
export const wd = (t) => fWd.format(tDate(t)).replace(".", "");
export const dayLong = (t) => clean(fWdLong.format(tDate(t)));
export const hr = (t) => clean(fHr.format(tDate(t)));
export const hm = (t) => clean(fHm.format(tDate(t)));
export const md = (t) => clean(fMd.format(tDate(t)));
export const ymd = (t) => fYmd.format(tDate(t));            // YYYY-MM-DD in Pacific time
export const dayOf = (s) => new Date(`${s}T12:00:00-08:00`);  // a YYYY-MM-DD as a Date at local noon
export const span = (a, b) => `${wd(a)} ${hr(a)}–${hr(b)}`;
export const f1 = (v, u = "") => (v == null ? "–" : `${(+v).toFixed(1)}${u}`);
export const f0 = (v, u = "") => (v == null ? "–" : `${Math.round(v)}${u}`);
export const pct = (v) => (v == null ? "–" : `${Math.round(v * 100)}%`);
export const dec = (v) => (v == null ? "–" : (+v).toFixed(2).replace(/^0/, "").replace(/^-0/, "−"));
export const COMPASS = "N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW".split(" ");
export const compass = (d) => (d == null ? "–" : COMPASS[Math.round(((d % 360) + 360) % 360 / 22.5) % 16]);
export const swell = (h, t, d) => (h == null ? "–" : `${f1(h, " m")} @ ${f0(t, " s")} ${compass(d)}`);
export const ago = (h) => (h == null ? "" : h < 1 ? "just now" : h < 24 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} d ago`);

// ------------------------------------------------------------------ tiers and trust
export const TIERS = ["S", "A", "B", "C", "D"];
export const TIER_MIN = { S: 85, A: 70, B: 55, C: 40, D: 0 };
export const tierOf = (s) => (s == null ? null : TIERS.find((t) => s >= TIER_MIN[t]));
export const tierVar = (t) => (t ? `--t-${t}` : "--surface-2");
export const tierCol = (t) => cssVar(tierVar(t));
export const SMALL_N = 60;   // backtests on fewer days than this are flagged
// a trust chip: HSS and false-alarm ratio lead (accuracy flatters rare GO days); small samples flagged
export function trustChip(tr, opt = {}) {
  if (!tr || tr.hss == null) return el("span", { class: "ww-trust none" }, "no backtest");
  const small = tr.n_days < SMALL_N;
  return el("span", { class: `ww-trust${small ? " small" : ""}`, title: `Backtest at this lead: Heidke skill ${dec(tr.hss)} (0 = no better than chance, 1 = perfect), false-alarm ratio ${pct(tr.far)}, probability of detection ${pct(tr.pod)}, over ${tr.n_days} days${small ? " — small sample" : ""}` },
    el("b", {}, `skill ${dec(tr.hss)}`), el("span", {}, `${pct(tr.far)} false alarms`), small ? el("em", {}, `${tr.n_days}-day sample`) : null, opt.extra || null);
}
export const smallNote = (n) => (n != null && n < SMALL_N ? ` Only ${n} days of buoy overlap so far: treat as indicative.` : "");

// ------------------------------------------------------------------ hourly arrays
export function hours(F) { const t0 = new Date(F.start); return d3.range(F.hours).map((i) => new Date(+t0 + i * 36e5)); }

// spot × day matrix (HTML): rows = spots, cols = days from each spot's daily[]; click a cell → pick(key, date)
export function dayMatrix(host, rows, opt) {
  host = $(host);
  const days = rows[0].daily.map((d) => d.date);
  const head = el("div", { class: "ww-mx-row ww-mx-head" }, el("span", { class: "ww-mx-name" }, ""),
    ...days.map((d) => el("span", { class: "ww-mx-day" }, el("b", {}, wd(dayOf(d))), el("small", {}, md(dayOf(d))))));
  const body = rows.map((r) => el("div", { class: `ww-mx-row${r.key === opt.sel ? " on" : ""}` },
    el("button", { type: "button", class: "ww-mx-name", "data-pick": "", title: `Show ${r.name} hour by hour`, onclick: () => opt.select(r.key) },
      el("b", {}, r.name), el("small", {}, r.sub || "")),
    ...r.daily.map((d) => {
      const on = opt.selItem === `${r.key}:${d.date}`;
      if (d.best == null) return el("span", { class: "ww-mx-cell none", title: "No daylight left / no forecast" }, "–");
      return el("button", { type: "button", "data-pick": "", class: `ww-mx-cell tier-${d.tier}${on ? " sel" : ""}${d.go ? " go" : ""}`,
        title: `${r.name}, ${dayLong(dayOf(d.date))}: best ${Math.round(d.best)} (${d.tier}) at ${hr(d.best_time)}; ${d.go_hours} h at B or better`,
        onclick: () => opt.pick(r.key, d.date) }, el("b", {}, d.tier), el("small", {}, Math.round(d.best)));
    })));
  host.replaceChildren(el("div", { class: "ww-mx", style: `--cols:${days.length}` }, head, ...body));
}

// 7-day hourly strip: score columns (coloured by tier, daylight only), night shading, optional overlay lines (right axis)
export function hourStrip(id, T, score, dayMask, opt = {}) {
  const m = { l: 30, r: opt.lines ? 40 : 10, t: 10, b: 22 };
  const { svg, g, iw, ih } = frame(id, m, 220);
  const x = d3.scaleTime([T[0], new Date(+T.at(-1) + 36e5)], [0, iw]);
  const y = d3.scaleLinear([0, 100], [ih, 0]);
  const bw = Math.max(1, iw / T.length);
  // nights
  g.append("g").selectAll("rect").data(T.map((t, i) => [t, i]).filter(([, i]) => !dayMask[i])).join("rect")
    .attr("x", ([t]) => x(t)).attr("width", bw + 0.5).attr("y", 0).attr("height", ih).style("fill", "var(--ww-night)");
  g.append("g").attr("class", "grid").selectAll("line").data([40, 55, 70, 85]).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickValues([40, 55, 70, 85]).tickFormat((v) => tierOf(v)).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("g").selectAll("rect").data(T.map((t, i) => [t, score[i], i]).filter(([, s, i]) => s != null && dayMask[i])).join("rect")
    .attr("x", ([t]) => x(t) + 0.3).attr("width", Math.max(1, bw - 0.6)).attr("y", ([, s]) => y(s)).attr("height", ([, s]) => ih - y(s))
    .style("fill", ([, s]) => tierCol(tierOf(s))).style("opacity", ([, , i]) => (opt.hl && !opt.hl(i) ? 0.35 : 1));
  // day ticks at local midnight
  const mids = T.filter((t) => hr(t) === "12 am");
  g.append("g").selectAll("line").data(mids).join("line").attr("x1", x).attr("x2", x).attr("y1", 0).attr("y2", ih + 4).style("stroke", "var(--axis)");
  g.append("g").selectAll("text").data(mids).join("text").attr("class", "axis-t").attr("x", (t) => x(t) + Math.min(60, (24 * bw) / 2)).attr("y", ih + 15)
    .attr("text-anchor", "middle").text((t) => (24 * bw > 70 ? `${wd(t)} ${md(t).split(" ")[1]}` : wd(t)));
  if (opt.lines) {
    const yr = d3.scaleLinear([0, opt.max || d3.max(opt.lines.flatMap((l) => l.v)) || 1], [ih, 0]).nice();
    g.append("g").attr("class", "axis").attr("transform", `translate(${iw},0)`).call(d3.axisRight(yr).ticks(4).tickFormat((v) => `${v}${opt.unit || ""}`).tickSize(0).tickPadding(5)).call(axisClean);
    for (const l of opt.lines) g.append("path").datum(T.map((t, i) => [t, l.v[i]]))
      .attr("d", d3.line().defined(([, v]) => v != null).x(([t]) => x(t) + bw / 2).y(([, v]) => yr(v)).curve(d3.curveMonotoneX))
      .style("fill", "none").style("stroke", l.color).style("stroke-width", l.w || 1.6).style("stroke-dasharray", l.dash || null);
  }
  const cursor = g.append("line").attr("y1", 0).attr("y2", ih).style("stroke", "var(--ink)").style("opacity", 0);
  svg.on("pointermove", (e) => {
    const [px] = d3.pointer(e, g.node());
    const i = Math.max(0, Math.min(T.length - 1, Math.floor(px / bw)));
    cursor.attr("x1", x(T[i]) + bw / 2).attr("x2", x(T[i]) + bw / 2).style("opacity", 0.5);
    tip.show(e.clientX, e.clientY, (t) => opt.tip(t, i));
  }).on("pointerleave", () => { tip.hide(); cursor.style("opacity", 0); })
    .on("click", (e) => { if (!opt.pick) return; const [px] = d3.pointer(e, g.node()); const i = Math.floor(px / bw); if (i >= 0 && i < T.length) { tip.hide(); opt.pick(i); } });
  if (opt.pick) svg.style("cursor", "pointer");
}

// tier board: one row per tier with window cards; card(w) builds the inside; pick(w) opens the drawer
export function tierBoard(host, list, card, pick, sel) {
  host = $(host);
  host.replaceChildren(...TIERS.map((t) => {
    const items = list.items[t] || [];
    return el("div", { class: `ww-tb-row tier-${t}` },
      el("div", { class: "ww-tb-tier" }, el("b", {}, t), el("small", {}, `${list.counts[t] || 0}`)),
      el("div", { class: "ww-tb-cards" }, items.length ? items.map((w) => {
        const key = `${w.spot}@${w.start}`;
        return el("button", { type: "button", class: `ww-card${sel === key ? " sel" : ""}`, "data-pick": "", onclick: () => pick(key) }, ...card(w));
      }) : el("span", { class: "note" }, t === "D" ? "Windows start at C; weaker hours aren't listed." : "None this week.")));
  }));
}
export const findWindow = (list, key) => Object.values(list.items).flat().find((w) => `${w.spot}@${w.start}` === key);

// small factor bars for a drawer: [[label, 0–1, note], …]
export function factorBars(rows) {
  return el("div", { class: "ww-factors" }, ...rows.map(([l, v, note]) => el("div", { class: "ww-factor" },
    el("span", {}, l), el("div", { class: "cx-fillbar" }, el("i", { style: { width: `${Math.round((v ?? 1) * 100)}%`, background: v == null ? "var(--muted)" : v >= 0.85 ? "var(--t-S)" : v >= 0.6 ? "var(--t-B)" : "var(--t-C)" } })),
    el("b", {}, v == null ? "–" : v.toFixed(2)), note ? el("small", {}, note) : null)));
}

// multi-series line chart over a numeric x (lead days, months, …); series = [{ name, v: [], color, dash }]
export function lineChart(id, xs, series, opt = {}) {
  const m = { l: 40, r: opt.labels === false ? 10 : 92, t: 10, b: 24 };
  const { svg, g, iw, ih } = frame(id, m, 200);
  const x = d3.scalePoint(xs, [0, iw]).padding(0.2);
  const all = series.flatMap((s) => s.v).filter((v) => v != null);
  const y = d3.scaleLinear([opt.min ?? Math.min(0, d3.min(all)), opt.max ?? (d3.max(all) || 1)], [ih, 0]).nice();
  gridY(g, y, iw, ih, opt.fmt);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickFormat(opt.xfmt || ((v) => v)).tickSize(0).tickPadding(7)).call(axisClean);
  const labels = [];
  for (const s of series) {
    const pts = xs.map((xv, i) => [xv, s.v[i]]).filter(([, v]) => v != null);
    g.append("path").datum(pts).attr("d", d3.line().x(([a]) => x(a)).y(([, v]) => y(v))).style("fill", "none").style("stroke", s.color).style("stroke-width", s.w || 2).style("stroke-dasharray", s.dash || null);
    g.append("g").selectAll("circle").data(pts).join("circle").attr("cx", ([a]) => x(a)).attr("cy", ([, v]) => y(v)).attr("r", 2.6).style("fill", s.color);
    if (opt.labels !== false && pts.length) labels.push(g.append("text").attr("class", "label halo").attr("x", x(pts.at(-1)[0]) + 6).datum(y(pts.at(-1)[1])).attr("dy", "0.35em")
      .style("font-size", "11px").style("fill", s.color).text(s.name).style("cursor", s.pick ? "pointer" : null).on("click", () => s.pick?.()));
  }
  // end labels: keep them 12px apart so near-identical series stay readable
  labels.sort((p, q) => p.datum() - q.datum());
  let last = -Infinity;
  for (const t of labels) { const yy = Math.max(t.datum(), last + 12); t.attr("y", yy); last = yy; }
  svg.on("pointermove", (e) => {
    const [px] = d3.pointer(e, g.node());
    const i = d3.minIndex(xs, (xv) => Math.abs(x(xv) - px));
    tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, opt.xtitle ? opt.xtitle(xs[i]) : String(xs[i])),
      ...series.filter((s) => s.v[i] != null).map((s) => tipRow(s.color, (opt.fmt || ((v) => v))(s.v[i]), s.name))));
  }).on("pointerleave", () => tip.hide());
}

export const ICONS = { surf: "≋", calm: "◠", live: "◉", trust: "✓" };
export { d3, el, tipRow, cssVar, frame, gridY, axisClean };
