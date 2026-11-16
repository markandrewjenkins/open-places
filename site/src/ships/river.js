// River & tides: the Fraser River (how high it's running, and who uses it) and tides at five CHS stations, both read
// live from the source. Tide and water-level data: Canadian Hydrographic Service (not for navigation); river flow:
// Water Survey of Canada, Open Government Licence – Canada.
import * as d3 from "d3";
import { el, tipRow, cssVar } from "../shared/ui.js";
import { frame, gridY, axisClean } from "../shared/charts.js";
import { dNote } from "../shared/console.js";
import { W, $, tip, fmt0, fmt1, fTime, fStamp, fDay, CAT_SHORT, CAT_VAR, TIDE_STATIONS, tides, levelAt, surge, hopeLive, hopeNormal, area, legendKey, TZ, loadCore } from "./common.js";

const S = { station: null, tide: null, tideErr: null, hope: null, hopeErr: null };
const defStation = () => S.station || (W.region === "vancouver" ? "07654" : "07120");
const stName = (code) => TIDE_STATIONS.find((s) => s.code === code)?.name || code;
const fmtM = (v) => (v == null ? "–" : `${v.toFixed(2)} m`);
const signed = (v) => (v == null ? "–" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)} m`);

function loadTide(ctx) {
  const code = defStation();
  if (S.tide?.code === code || S.tideLoading === code || (S.tideFail?.code === code && Date.now() - S.tideFail.at < 120e3)) return;
  S.tideLoading = code;
  tides(code).then((t) => { S.tide = { code, ...t }; S.tideErr = null; S.tideFail = null; }, (e) => { S.tideErr = String(e.message || e); S.tideFail = { code, at: Date.now() }; })
    .finally(() => { S.tideLoading = null; ctx.refresh(); });
}
function loadHope(ctx) {
  if (S.hope || S.hopeLoading || S.hopeErr) return;     // one try per page load
  S.hopeLoading = true;
  hopeLive().then((h) => { S.hope = h; }, (e) => { S.hopeErr = String(e.message || e); }).finally(() => { S.hopeLoading = false; ctx.refresh(); });
}
const hopeNow = () => { const h = S.hope?.at(-1); if (!h) return null; const n = hopeNormal(h.t); return { ...h, normal: n, pct: n ? h.q / n[1] : null }; };
const nextHiLo = (td, hi) => td?.hilo.find((x) => x.t > Date.now() && x.hi === hi);
const rel = (d) => { const m = Math.round((d - Date.now()) / 6e4); return m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`; };

export const river = {
  id: "river", title: "River & tides", tileTitle: "River & tides", color: "var(--t-river)",
  eyebrow: "Fraser River", heading: "Tides & Water Levels",
  load: (ctx) => loadCore().then(() => { loadTide(ctx); loadHope(ctx); }),
  badge: () => { const h = hopeNow(); return h ? [`${fmt0(h.q)} m³/s`, "Fraser at Hope right now"] : ""; },
  kpis: (ctx) => {
    loadTide(ctx); loadHope(ctx);
    const h = hopeNow(), td = S.tide, hi = nextHiLo(td, true), lo = nextHiLo(td, false), sg = td ? surge(td) : null;
    return [
      ["Fraser at Hope", h ? `${fmt0(h.q)} m³/s` : S.hopeErr ? "unavailable" : "…", h?.pct ? `${Math.round(h.pct * 100)}% of normal for the date` : "live, Water Survey of Canada"],
      [`Next high · ${stName(defStation())}`, hi ? fTime(hi.t) : S.tideErr ? "unavailable" : "…", hi ? `${fmtM(hi.v)} · ${rel(hi.t)}` : ""],
      ["Next low", lo ? fTime(lo.t) : S.tideErr ? "–" : "…", lo ? `${fmtM(lo.v)} · ${rel(lo.t)}` : ""],
      ["Above prediction", sg ? signed(sg.v) : "–", sg ? `observed ${fTime(sg.t)} (surge, wind, river)` : "observed minus predicted"],
    ];
  },
  tile: (t, ctx) => {
    loadTide(ctx); loadHope(ctx);
    const h = hopeNow(), td = S.tide, hi = nextHiLo(td, true);
    t.kpis([[hi ? fTime(hi.t) : S.tideErr ? "–" : "…", hi ? `next high water, ${stName(defStation())} (${fmtM(hi.v)})` : "next high water"],
      [h ? `${fmt0(h.q)}` : S.hopeErr ? "–" : "…", h?.pct ? `m³/s Fraser at Hope · ${Math.round(h.pct * 100)}% of normal` : "m³/s, Fraser at Hope"],
      [`${Math.round(((area("fraser-up")?.by_cat[3] || 0) / Math.max(1, d3.sum(area("fraser-up")?.by_cat || [1]))) * 100)}%`, "of river traffic above New West is tugs"]]);
    t.status(td ? `Live ${fTime(td.fetched)}` : "");
    if (td) tideChart(t.vis, td, { mini: true });
    else if (S.tideErr && W.river) fraserMini(t.vis, `Tides unavailable (${S.tideErr}) · the Fraser at Hope against its normal range`);
    else t.vis.replaceChildren(el("p", { class: "note cx-status" }, S.tideErr ? `Tides unavailable: ${S.tideErr}` : "Loading tides…"));
  },
  subs: [
    { id: "tides", title: "Tides", short: "Tides", class: "pane-wwtides",
      view: (host, ctx) => renderTides(ctx),
      html: `<div class="ww-pick" id="ww-tide-pick"></div>
      <div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title" id="ww-tide-t">Tide</h3><p class="note cx-card-sub" id="ww-tide-sub"></p><div class="legend" id="ww-tide-legend"></div><div class="chart" id="ww-tide"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">Highs and lows</h3><p class="note cx-card-sub">Predicted by the Canadian Hydrographic Service, local time, metres above chart datum.</p><ol class="ww-hilo cx-grow" id="ww-hilo"></ol><p class="note ww-chs">Contains data of the Canadian Hydrographic Service. Not to be used for navigation.</p></div>
      </div>` },
    { id: "fraser", title: "Fraser River", short: "Fraser", class: "pane-wwfraser",
      view: (host, ctx) => renderFraser(ctx),
      html: `<div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title">Fraser River flow</h3><p class="note cx-card-sub" id="ww-hope-sub"></p><div class="legend" id="ww-hope-legend"></div><div class="chart" id="ww-hope"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">River users</h3><p class="note cx-card-sub">Vessels a day on three reaches of the Fraser, by type, from one summer week of AIS. Barges don't carry AIS: their tugs do.</p><div class="legend" id="ww-reach-legend"></div><div class="chart" id="ww-reach"></div><p class="note" id="ww-reach-note"></p></div>
      </div>` },
  ],
};

// ------------------------------------------------------------------ tide chart
function tideChart(target, td, { mini } = {}) {
  const m = mini ? { l: 4, r: 4, t: 14, b: 16 } : { l: 40, r: 12, t: 16, b: 24 };
  const { g, iw, ih } = frame(target, m, mini ? 150 : 260);
  const now = new Date();
  const from = mini ? new Date(+now - 6 * 36e5) : td.pred[0]?.t, to = mini ? new Date(+now + 24 * 36e5) : td.pred.at(-1)?.t;
  const pred = td.pred.filter((p) => p.t >= from && p.t <= to), obs = td.obs.filter((p) => p.t >= from);
  if (!pred.length) return;
  const x = d3.scaleTime([from, to], [0, iw]);
  const all = pred.map((p) => p.v).concat(obs.map((p) => p.v));
  const y = d3.scaleLinear([Math.min(0, d3.min(all)), d3.max(all) + 0.2], [ih, 0]).nice(4);
  // higher-water windows: the upper third of the day's range (shaded)
  const lo = d3.min(pred, (p) => p.v), hi = d3.max(pred, (p) => p.v), thr = lo + (hi - lo) * (2 / 3);
  if (!mini) {
    gridY(g, y, iw, ih, (v) => `${v} m`);
    let start = null;
    for (const p of pred.concat([{ t: to, v: -1e9 }])) {
      if (p.v >= thr && start == null) start = p.t;
      if (p.v < thr && start != null) { g.append("rect").attr("class", "ww-hw").attr("x", x(start)).attr("width", Math.max(1, x(p.t) - x(start))).attr("y", 0).attr("height", ih); start = null; }
    }
    // midnight lines
    for (const d of d3.timeDay.range(from, to)) g.append("line").attr("x1", x(d)).attr("x2", x(d)).attr("y1", 0).attr("y2", ih).style("stroke", "var(--axis)").style("stroke-dasharray", "2 3");
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(Math.max(3, Math.floor(iw / 80))).tickFormat((d) => d.getHours() === 0 ? d3.timeFormat("%a")(d) : d3.timeFormat("%-I %p")(d)).tickSize(0).tickPadding(6)).call(axisClean);
  }
  g.append("path").datum(pred).attr("d", d3.area().x((p) => x(p.t)).y0(ih).y1((p) => y(p.v)).curve(d3.curveMonotoneX)).style("fill", "var(--t-river)").style("opacity", 0.12);
  g.append("path").datum(pred).attr("d", d3.line().x((p) => x(p.t)).y((p) => y(p.v)).curve(d3.curveMonotoneX)).style("fill", "none").style("stroke", "var(--t-river)").style("stroke-width", mini ? 1.8 : 2);
  if (obs.length) g.append("path").datum(obs).attr("d", d3.line().x((p) => x(p.t)).y((p) => y(p.v))).style("fill", "none").style("stroke", "var(--ink)").style("stroke-width", 1.6);
  const nx = x(now);
  g.append("line").attr("x1", nx).attr("x2", nx).attr("y1", -6).attr("y2", ih).style("stroke", "var(--ink)").style("opacity", 0.7);
  g.append("text").attr("class", "axis-t halo").attr("x", nx + 4).attr("y", -4).text("now");
  for (const p of td.hilo.filter((p) => p.t >= from && p.t <= to)) {
    const px = x(p.t), py = y(p.v);
    g.append("circle").attr("cx", px).attr("cy", py).attr("r", 2.6).style("fill", "var(--surface)").style("stroke", "var(--t-river)").style("stroke-width", 1.5);
    if (!mini || px > 20 && px < iw - 20) g.append("text").attr("class", "axis-t halo").attr("x", px).attr("y", p.hi ? py - 7 : py + 13).attr("text-anchor", "middle").text(`${fTime(p.t).replace(/ (a|p)\.?m\.?/i, (s) => s.trim().toLowerCase()[0])} ${p.v.toFixed(1)}`);
  }
  if (mini) g.append("text").attr("class", "axis-t").attr("x", 2).attr("y", ih + 13).text(`tide, ${stName(td.code)} · next 24 h`);
  g.append("rect").attr("width", iw).attr("height", ih).style("fill", "transparent").on("pointermove", (e) => {
    const t = x.invert(d3.pointer(e)[0]), v = levelAt(td.pred, t), o = obs.length && t <= obs.at(-1).t ? levelAt(obs, t) : null;
    tip.show(e.clientX, e.clientY, (tt) => { tt.append(el("div", { class: "t-title" }, fStamp(t)), tipRow(cssVar("--t-river"), fmtM(v), "predicted")); if (o != null) tt.append(tipRow(cssVar("--ink"), fmtM(o), "observed")); });
  }).on("pointerleave", () => tip.hide());
}

function renderTides(ctx) {
  loadTide(ctx);
  const code = defStation();
  $("ww-tide-pick").replaceChildren(el("label", { class: "ww-pick-l" }, "Station "), el("div", { class: "seg" }, ...TIDE_STATIONS.map((s) =>
    el("button", { type: "button", "aria-pressed": String(s.code === code), onclick: () => { S.station = s.code; ctx.refresh(); } }, s.name))));
  $("ww-tide-t").textContent = `Tide at ${stName(code)}`;
  const td = S.tide?.code === code ? S.tide : null;
  $("ww-tide-legend").replaceChildren(legendKey("--t-river", "Predicted", "line"), legendKey("--ink", "Observed", "line"), el("span", { class: "key" }, el("i", { class: "band ww-hw-key" }), "Higher-water windows (top third of the range)"));
  if (!td) { $("ww-tide").replaceChildren(el("p", { class: "note cx-status" }, S.tideErr ? `Couldn't reach the CHS tide service: ${S.tideErr}` : "Loading tides…")); $("ww-hilo").replaceChildren(); $("ww-tide-sub").textContent = ""; return; }
  const sg = surge(td), river = TIDE_STATIONS.find((s) => s.code === code)?.river;
  $("ww-tide-sub").textContent = `Last 18 hours and the next 2 days, live from CHS (fetched ${fTime(td.fetched)}).${sg ? ` The water is ${signed(sg.v)} ${sg.v >= 0 ? "above" : "below"} the prediction right now.` : ""}${river ? " On the river the tide is mixed with the Fraser's own flow, so in a freshet levels run well above the tide prediction." : ""}`;
  tideChart("ww-tide", td);
  $("ww-hilo").replaceChildren(...td.hilo.filter((p) => p.t > Date.now() - 6 * 36e5).slice(0, 10).map((p) => el("li", { class: p.t < Date.now() ? "past" : "" },
    el("b", {}, p.hi ? "High" : "Low"), el("span", {}, `${fDay(p.t)} ${fTime(p.t)}`), el("em", {}, fmtM(p.v)))));
}

// ------------------------------------------------------------------ Fraser at Hope: this year against the normal band
/** tile fallback when CHS doesn't answer: the year's normal band, the median and the last 30 days, filling the box */
function fraserMini(host, caption) {
  const R = W.river; host.replaceChildren();
  const w = Math.max(160, host.clientWidth), h = Math.max(70, (host.clientHeight || 130) - 18);
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${w} ${h}`).attr("width", w).attr("height", h);
  const yr = new Date().getFullYear(), D = (k) => new Date(yr, 0, k), x = d3.scaleTime([D(1), D(366)], [2, w - 2]);
  const recent = (S.hope || []).filter((p, i, a) => i % 12 === 0 || i === a.length - 1);
  const y = d3.scaleLinear([0, Math.max(d3.max(R.normals, (n) => n[3]), d3.max(recent, (p) => p.q) || 0)], [h - 2, 4]);
  svg.append("path").datum(R.normals).attr("d", d3.area().x((n) => x(D(n[0]))).y0((n) => y(n[1])).y1((n) => y(n[3])).curve(d3.curveMonotoneX)).style("fill", "var(--t-river)").style("opacity", 0.18);
  svg.append("path").datum(R.normals).attr("d", d3.line().x((n) => x(D(n[0]))).y((n) => y(n[2])).curve(d3.curveMonotoneX)).style("fill", "none").style("stroke", "var(--t-river)").style("stroke-width", 1.4);
  if (recent.length) svg.append("path").datum(recent).attr("d", d3.line().x((p) => x(new Date(yr, p.t.getMonth(), p.t.getDate(), p.t.getHours()))).y((p) => y(p.q))).style("fill", "none").style("stroke", "var(--ink)").style("stroke-width", 2);
  host.append(el("p", { class: "note" }, caption));
}
function renderFraser(ctx) {
  loadHope(ctx);
  const R = W.river, h = hopeNow();
  $("ww-hope-sub").textContent = R ? `Daily flow at Hope, where the Fraser leaves the canyon. Band: the middle 80% of ${R.years[0]}–${R.years[1]}; line: the median. Bold line: the last 30 days, live. The spring freshet usually peaks around ${d3.timeFormat("%B %-d")(new Date(2026, 0, R.peaks.median_doy))} near ${fmt0(R.peaks.median_q)} m³/s; high water brings faster currents, debris and restrictions on barge tows.` : "";
  $("ww-hope-legend").replaceChildren(legendKey("--t-river", "Normal range (p10–p90)", "band"), legendKey("--t-river", "Median", "line"), legendKey("--ink", "Last 30 days", "line"));
  if (!R) return $("ww-hope").replaceChildren(el("p", { class: "note" }, "River normals not built yet."));
  const { g, iw, ih } = frame("ww-hope", { l: 48, r: 10, t: 10, b: 22 }, 240);
  const yr = new Date().getFullYear(), D = (k) => new Date(yr, 0, k);
  const x = d3.scaleTime([D(1), D(366)], [0, iw]);
  const recent = (S.hope || []).filter((p, i, a) => i % 12 === 0 || i === a.length - 1);
  const y = d3.scaleLinear([0, Math.max(d3.max(R.normals, (n) => n[3]), d3.max(recent, (p) => p.q) || 0)], [ih, 0]).nice(5);
  gridY(g, y, iw, ih, d3.format("~s"));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(d3.timeMonth.every(iw < 420 ? 2 : 1)).tickFormat(d3.timeFormat("%b")).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("path").datum(R.normals).attr("d", d3.area().x((n) => x(D(n[0]))).y0((n) => y(n[1])).y1((n) => y(n[3])).curve(d3.curveMonotoneX)).style("fill", "var(--t-river)").style("opacity", 0.18);
  g.append("path").datum(R.normals).attr("d", d3.line().x((n) => x(D(n[0]))).y((n) => y(n[2])).curve(d3.curveMonotoneX)).style("fill", "none").style("stroke", "var(--t-river)").style("stroke-width", 1.6);
  if (recent.length) g.append("path").datum(recent).attr("d", d3.line().x((p) => x(new Date(yr, p.t.getMonth(), p.t.getDate(), p.t.getHours()))).y((p) => y(p.q))).style("fill", "none").style("stroke", "var(--ink)").style("stroke-width", 2.2);
  const nx = x(new Date());
  g.append("line").attr("x1", nx).attr("x2", nx).attr("y1", 0).attr("y2", ih).style("stroke", "var(--ink)").style("opacity", 0.5).style("stroke-dasharray", "3 3");
  if (h) g.append("text").attr("class", "axis-t halo").attr("x", nx + (nx > iw * 0.8 ? -6 : 6)).attr("text-anchor", nx > iw * 0.8 ? "end" : "start").attr("y", y(h.q) - 8)
    .text(`${fmt0(h.q)} m³/s now${h.pct ? ` · ${Math.round(h.pct * 100)}% of normal` : ""}`);
  else if (S.hopeErr) g.append("text").attr("class", "axis-t").attr("x", 6).attr("y", 12).text(`Live flow unavailable: ${S.hopeErr}`);
  g.append("rect").attr("width", iw).attr("height", ih).style("fill", "transparent").on("pointermove", (e) => {
    const t = x.invert(d3.pointer(e)[0]), n = hopeNormal(t);
    tip.show(e.clientX, e.clientY, (tt) => { tt.append(el("div", { class: "t-title" }, d3.timeFormat("%b %-d")(t))); if (n) tt.append(tipRow(cssVar("--t-river"), `${fmt0(n[1])} m³/s`, `median · range ${fmt0(n[0])}–${fmt0(n[2])}`)); });
  }).on("pointerleave", () => tip.hide());

  // river reaches: vessels a day by type
  const reaches = ["fraser-mouth", "fraser-main", "fraser-up"].map(area).filter(Boolean);
  $("ww-reach-legend").replaceChildren(...[3, 1, 0, 4, 5, 6].map((i) => legendKey(CAT_VAR[i], CAT_SHORT[i], "band")));
  const fr = frame("ww-reach", { l: 120, r: 36, t: 4, b: 4 }, 160);
  const yy = d3.scaleBand(reaches.map((a) => a.id), [0, fr.ih]).padding(0.3), xx = d3.scaleLinear([0, d3.max(reaches, (a) => d3.sum(a.by_cat)) || 1], [0, fr.iw]);
  for (const a of reaches) {
    let acc = 0;
    for (const c of [3, 1, 2, 0, 4, 5, 6]) {
      const v = a.by_cat[c]; if (v <= 0) continue;
      fr.g.append("rect").attr("x", xx(acc)).attr("y", yy(a.id)).attr("width", Math.max(0, xx(acc + v) - xx(acc) - 0.5)).attr("height", yy.bandwidth()).style("fill", `var(${CAT_VAR[c]})`)
        .on("pointermove", (e) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, a.name), tipRow(cssVar(CAT_VAR[c]), fmt1(v), `${CAT_SHORT[c]} a day`))))
        .on("pointerleave", () => tip.hide());
      acc += v;
    }
    fr.g.append("text").attr("class", "label").attr("x", -8).attr("y", yy(a.id) + yy.bandwidth() / 2).attr("dy", "0.35em").attr("text-anchor", "end").style("font-size", "11.5px")
      .text({ "fraser-mouth": "Mouth & Sand Heads", "fraser-main": "Steveston – New West", "fraser-up": "Above New West" }[a.id]);
    fr.g.append("text").attr("class", "label strong").attr("x", xx(acc) + 5).attr("y", yy(a.id) + yy.bandwidth() / 2).attr("dy", "0.35em").style("font-size", "11px").text(fmt0(acc));
  }
  const up = area("fraser-up");
  $("ww-reach-note").textContent = up ? `Above New Westminster ${Math.round((up.by_cat[3] / Math.max(1, d3.sum(up.by_cat))) * 100)}% of vessels are tugs, mostly towing log booms, gravel and chip barges; regulars include ${up.regulars.filter((r) => r[1] === 3).slice(0, 3).map((r) => r[0]).join(", ")}.` : "";
}
