// Forecast trust: how much to believe day 1 vs day 3 vs day 5. GO/no-go skill per spot by lead time (Heidke skill
// score and false-alarm ratio lead; accuracy flatters rare GO days), then the raw variables against the buoys and shore
// wind stations, then calm water.
import {
  W, $, d3, el, tipRow, cssVar, tip, loadTrust, lineChart, dec, pct, f1, f0, SMALL_N, smallNote, md, dayOf, wd, frame, gridY, axisClean, tierOf, tierCol,
  BBOX_ALL,
} from "./common.js";
import { dStats, dChart, dNote, dLink, dHead } from "../shared/console.js";

const go = (...a) => W.ctx.go(...a);
const LEADS = [1, 2, 3, 4, 5, 6, 7];
const BT = () => W.bt;
const SPOT_COL = { jordan: "--surf", sombrio: "--s2", chesterman: "--s3", cox: "--s4", longbeach: "--s5" };
const PAD_COL = { victoria_waterfront: "--surf", victoria_harbour: "--s3", english_bay: "--calm", false_creek: "--s5" };
const BUOY_COL = { "46087": "--surf", "46206": "--s3", "46146": "--s4", "46304": "--calm" };
const nm = (s) => s.replace(" (Incinerator Rock)", "").replace(/ \(.*\)/, "");
const sn = (n) => n.replace(/ (Bank|buoy)$/, "").replace("Victoria Gonzales", "Victoria");
const leadVals = (byLead, key) => LEADS.map((L) => byLead?.[L]?.[key] ?? null);

export const trust = {
  id: "trust", title: "Forecast trust", color: "var(--trust)",
  eyebrow: "Backtest since Nov 2025", heading: "Accuracy by Lead Time",
  // Civic Atlas: a lens over the whole board; quiet relevance, rising when a GO window is being weighed days out
  footprint: { bbox: BBOX_ALL }, kind: "only-here",
  relevance: () => 0.3,
  load: loadTrust,
  badge: () => { const j = BT().spots.jordan?.by_lead; return j ? [dec(j[3].hss), "Jordan River GO/no-go skill at day 3 (Heidke: 0 = chance, 1 = perfect)"] : ""; },
  kpis: () => {
    const j = BT().spots.jordan.by_lead, c = BT().spots.chesterman.by_lead, nb = BT().buoys["46087"].by_lead;
    return [
      ["Jordan River day 1 → 5", `${dec(j[1].hss)} → ${dec(j[5].hss)}`, `skill · false alarms ${pct(j[1].far)} → ${pct(j[5].far)}`],
      ["Tofino (Chesterman) d1 → d5", `${dec(c[1].hss)} → ${dec(c[5].hss)}`, `skill · ${c[1].n_days}-day sample only`, { class: "cx-kpi ww-small" }],
      ["Neah Bay wave height", `±${f1(nb[1].hs.mae, " m")} → ±${f1(nb[5].hs.mae, " m")}`, `day 1 → 5 error; persistence ±${f1(nb[1].hs_persistence.mae, " m")}`],
      ["Since", md(BT().start), `${BT().spots.jordan.days} days scored`],
    ];
  },
  tile: (t) => {
    const j = BT().spots.jordan.by_lead, c = BT().spots.chesterman.by_lead;
    t.kpis([
      [`${dec(j[3].hss)}`, "Jordan River skill at day 3 (0 = chance, 1 = perfect)"],
      [pct(j[5].far), "of day-5 GO calls didn't happen"],
      [`${c[1].n_days} days`, "Tofino sample so far: indicative"],
    ]);
    lineChart(t.vis, LEADS, Object.entries(BT().spots).filter(([, s]) => s.by_lead).map(([k, s]) => ({
      name: nm(s.name).split(" ")[0], v: leadVals(s.by_lead, "hss"), color: cssVar(SPOT_COL[k] || "--muted"), dash: s.days < SMALL_N ? "4 3" : null, w: 1.6 })),
      { min: 0, max: 1, fmt: (v) => dec(v), xfmt: (L) => `d${L}`, xtitle: (L) => `Day ${L}`, labels: false });
  },
  subs: [
    { id: "spots", title: "Surf GO/no-go", short: "Surf", class: "pane-tspots",
      view: (host, ctx, r) => {
        const S = Object.entries(BT().spots).filter(([, s]) => s.by_lead);
        const mk = (key) => S.map(([k, s]) => ({ name: `${nm(s.name).split(" ")[0]}${s.days < SMALL_N ? "*" : ""}`, v: leadVals(s.by_lead, key), color: cssVar(SPOT_COL[k]), dash: s.days < SMALL_N ? "4 3" : null, pick: () => go("trust", "spots", k) }));
        lineChart("tr-hss", LEADS, mk("hss"), { min: 0, max: 1, fmt: dec, xfmt: (L) => (W.ctx.desktop ? `day ${L}` : `d${L}`), xtitle: (L) => `Forecast made ${L} day${L > 1 ? "s" : ""} ahead` });
        lineChart("tr-far", LEADS, mk("far"), { min: 0, max: 1, fmt: (v) => pct(v), xfmt: (L) => (W.ctx.desktop ? `day ${L}` : `d${L}`), xtitle: (L) => `Forecast made ${L} day${L > 1 ? "s" : ""} ahead` });
        table("tr-table", S, "trust", "spots", r.item);
      }, html: `
      <p class="note cx-lede">Each day since 17 Nov 2025 the spot rule was applied twice: to what the buoy and shore wind actually did, and to what the forecast said 1–7 days earlier. A GO day has 2+ daylight hours at B or better. <b>Skill</b> (Heidke) is 0 for no better than chance and 1 for perfect; <b>false alarms</b> are the share of GO calls that didn't happen. Dashed lines and * mark the Tofino beaches: their buoy has only 28 days online so far.</p>
      <div class="cx-row cols-2">
        <div class="card cx-fill"><h3 class="cx-card-title">Skill by lead time</h3><div class="chart" id="tr-hss"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">False-alarm ratio by lead time</h3><div class="chart" id="tr-far"></div></div>
      </div>
      <div class="card ww-tcard-t"><div id="tr-table"></div></div>` },
    { id: "variables", title: "Waves & wind", short: "Variables", class: "pane-tvars",
      view: () => {
        const Bu = Object.entries(BT().buoys).filter(([, b]) => b.by_lead);
        lineChart("tr-hs", LEADS, [...Bu.map(([k, b]) => ({ name: `${sn(b.name)}${b.n_obs < 24 * SMALL_N ? "*" : ""}`, v: LEADS.map((L) => b.by_lead[L].hs.mae), color: cssVar(BUOY_COL[k]), dash: b.n_obs < 24 * SMALL_N ? "4 3" : null, pick: () => go("trust", "variables", k) })),
          { name: "persistence", v: LEADS.map((L) => BT().buoys["46087"].by_lead[L].hs_persistence.mae), color: cssVar("--muted"), dash: "1 3", w: 1.4 }],
          { min: 0, fmt: (v) => `${(+v).toFixed(2)} m`, xfmt: (L) => `d${L}`, xtitle: (L) => `Day ${L}: mean absolute error` });
        lineChart("tr-tp", LEADS, Bu.map(([k, b]) => ({ name: sn(b.name), v: LEADS.map((L) => b.by_lead[L].tp.mae), color: cssVar(BUOY_COL[k]), dash: b.n_obs < 24 * SMALL_N ? "4 3" : null })),
          { min: 0, fmt: (v) => `${(+v).toFixed(1)} s`, xfmt: (L) => `d${L}`, xtitle: (L) => `Day ${L}: peak-period error` });
        const Wn = Object.entries(BT().wind).filter(([, w]) => w.by_lead);
        lineChart("tr-wind", LEADS, Wn.map(([k, w], i) => ({ name: sn(w.name), v: LEADS.map((L) => w.by_lead[L].wspd.mae), color: cssVar(["--surf", "--s3", "--calm", "--s4", "--s5"][i % 5]) })),
          { min: 0, fmt: (v) => `${(+v).toFixed(1)} km/h`, xfmt: (L) => `d${L}`, xtitle: (L) => `Day ${L}: wind-speed error` });
      }, html: `
      <div class="card cx-fill"><h3 class="cx-card-title">Wave height error at the buoys</h3><p class="note cx-card-sub">Mean absolute error of significant wave height (Open-Meteo best match) by lead. Dotted grey: "it'll be what Neah Bay shows now" (persistence). * = 28–30 days of Canadian buoy data. Click a buoy for its chart.</p><div class="chart" id="tr-hs"></div></div>
      <div class="cx-row cols-2">
        <div class="card cx-fill"><h3 class="cx-card-title">Peak period error</h3><p class="note cx-card-sub">ECMWF WAM peak period vs the buoy's dominant period.</p><div class="chart" id="tr-tp"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">Wind speed error at the shore stations</h3><p class="note cx-card-sub">The day-1 to day-2 step is likely the model blend switching to coarser models.</p><div class="chart" id="tr-wind"></div></div>
      </div>` },
    { id: "calm", title: "Calm water", short: "Calm", class: "pane-tcalm",
      view: (host, ctx, r) => {
        const S = Object.entries(BT().paddle).filter(([, s]) => s.by_lead);
        lineChart("tr-chss", LEADS, S.map(([k, s]) => ({ name: `${nm(s.name).split(" ")[0]}${s.days < SMALL_N ? "*" : ""}`, v: leadVals(s.by_lead, "hss"), color: cssVar(PAD_COL[k]), dash: s.days < SMALL_N ? "4 3" : null, pick: () => go("trust", "calm", k) })),
          { min: 0, max: 1, fmt: dec, xfmt: (L) => (W.ctx.desktop ? `day ${L}` : `d${L}`), xtitle: (L) => `Day ${L}` });
        table("tr-ctable", S, "trust", "calm", r.item);
      }, html: `
      <p class="note cx-lede">Calm days are the norm (84–94% of days have a calm spell at the wind stations), so accuracy is high whatever the forecast does: read the skill score. Gusts aren't observed hourly and are left out; English Bay's waves are checked against its buoy (29 days).</p>
      <div class="card cx-fill"><h3 class="cx-card-title">Calm-window skill by lead time</h3><div class="chart" id="tr-chss"></div></div>
      <div class="card ww-tcard-t"><div id="tr-ctable"></div></div>` },
  ],
  drawers: {
    spots: (host, ctx, k) => spotDrawer(k, "spots"),
    calm: (host, ctx, k) => spotDrawer(k, "calm"),
    variables: (host, ctx, k) => buoyDrawer(k),
  },
};

function table(id, S, topic, sub, sel) {
  const head = el("tr", {}, el("th", {}, ""), ...[1, 3, 5].map((L) => el("th", { colspan: 3 }, `Day ${L}`)), el("th", {}, "Days"), el("th", {}, "GO base rate"));
  const sub2 = el("tr", { class: "ww-th2" }, el("th", {}, ""), ...[1, 3, 5].flatMap(() => [el("th", {}, "skill"), el("th", {}, "false al."), el("th", {}, "hit rate")]), el("th", {}, ""), el("th", {}, ""));
  const rows = S.map(([k, s]) => el("tr", { class: `${sel === k ? "on " : ""}${s.days < SMALL_N ? "small" : ""}`, tabindex: 0, onclick: () => go(topic, sub, k), onkeydown: (e) => { if (e.key === "Enter") go(topic, sub, k); } },
    el("td", {}, el("b", {}, nm(s.name)), s.days < SMALL_N ? el("em", {}, " small sample") : null),
    ...[1, 3, 5].flatMap((L) => { const v = s.by_lead[L]; return [el("td", { class: "ww-num strong" }, dec(v.hss)), el("td", { class: "ww-num" }, pct(v.far)), el("td", { class: "ww-num" }, pct(v.pod))]; }),
    el("td", { class: "ww-num" }, s.days), el("td", { class: "ww-num" }, pct(s.by_lead[1].base_rate))));
  $(id).replaceChildren(el("table", { class: "ww-table" }, el("thead", {}, head, sub2), el("tbody", {}, ...rows)));
}

function spotDrawer(k, group) {
  const s = (group === "calm" ? BT().paddle : BT().spots)[k];
  if (!s?.by_lead) return null;
  const days = BT().spot_days[k];
  const small = s.days < SMALL_N;
  return {
    kicker: `Forecast trust · ${group === "calm" ? "calm water" : "surf"}`, title: nm(s.name),
    body: [
      dStats([[`${dec(s.by_lead[1].hss)} / ${dec(s.by_lead[3].hss)} / ${dec(s.by_lead[5].hss)}`, "skill at day 1 / 3 / 5"], [`${pct(s.by_lead[1].far)} / ${pct(s.by_lead[5].far)}`, "false alarms day 1 / 5"],
        [`${s.days} days`, small ? "small sample: indicative only" : "scored since Nov 2025"], [pct(s.by_lead[1].base_rate), "of days were actually GO"]]),
      small ? dNote(`Only ${s.days} days: the Canadian buoy's online history is 30 days, and this dashboard's own archive started in November 2026. Numbers will steady as it grows.`) : null,
      dChart("dr-tl", "Hits, misses and false alarms by lead (days)"),
      days ? dChart("dr-tdays", "Best daily score, observed vs forecast 1 / 3 / 5 days ahead (last 60 days)") : null,
      dNote(`Observed side: ${group === "calm" ? `wind at ECCC ${s.wind_station}${s.waves_checked ? " and waves at buoy 46304" : ""}` : `swell at buoy ${s.buoy}, wind at ${W.waves.wind_stations[s.wind_station]?.name || s.wind_station}`}. Tide isn't scored (predictions add no forecast error).`),
      dLink(W.ctx.href(group === "calm" ? "calm" : "surf", "week"), "Back to this week's forecast"),
    ],
    after: () => {
      stackLeads("dr-tl", s.by_lead);
      if (days) dayCompare("dr-tdays", days);
    },
  };
}
function stackLeads(id, by) {
  const m = { l: 34, r: 8, t: 8, b: 20 };
  const { g, iw, ih } = frame(id, m, 190);
  const keys = [["hits", "--t-A"], ["misses", "--t-C"], ["false_alarms", "--accent-2"]];
  const x = d3.scaleBand(LEADS, [0, iw]).padding(0.25);
  const y = d3.scaleLinear([0, d3.max(LEADS, (L) => by[L].hits + by[L].misses + by[L].false_alarms) || 1], [ih, 0]).nice();
  gridY(g, y, iw, ih);
  for (const L of LEADS) {
    let acc = 0;
    for (const [k, c] of keys) {
      const v = by[L][k];
      g.append("rect").attr("x", x(L)).attr("width", x.bandwidth()).attr("y", y(acc + v)).attr("height", y(acc) - y(acc + v)).style("fill", `var(${c})`)
        .on("pointermove", (e) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `Day ${L}`), ...keys.map(([kk, cc]) => tipRow(cssVar(cc), by[L][kk], kk.replace("_", " "))), tipRow(null, by[L].correct_no, "correct no-go"))))
        .on("pointerleave", () => tip.hide());
      acc += v;
    }
  }
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickFormat((L) => `d${L}`).tickSize(0).tickPadding(6)).call(axisClean);
}
function dayCompare(id, D) {
  const n = D.date.length, from = Math.max(0, n - 60);
  const rows = D.date.slice(from).map((d, i) => ({ d: dayOf(d), o: D.obs[from + i], a: D.d1?.[from + i], b: D.d3?.[from + i], c: D.d5?.[from + i] }));
  const m = { l: 30, r: 8, t: 8, b: 20 };
  const { svg, g, iw, ih } = frame(id, m, 190);
  const x = d3.scaleTime(d3.extent(rows, (r) => r.d), [0, iw]), y = d3.scaleLinear([0, 100], [ih, 0]);
  gridY(g, y, iw, ih);
  const bw = Math.max(1, iw / rows.length - 1);
  g.selectAll("rect").data(rows).join("rect").attr("x", (r) => x(r.d) - bw / 2).attr("width", bw).attr("y", (r) => y(r.o ?? 0)).attr("height", (r) => ih - y(r.o ?? 0)).style("fill", (r) => tierCol(tierOf(r.o)));
  for (const [k, c, dash] of [["a", "--ink", null], ["b", "--trust", "3 2"], ["c", "--muted", "1 2"]])
    g.append("path").datum(rows.filter((r) => r[k] != null)).attr("d", d3.line().x((r) => x(r.d)).y((r) => y(r[k]))).style("fill", "none").style("stroke", `var(${c})`).style("stroke-width", 1.3).style("stroke-dasharray", dash);
  g.append("line").attr("x1", 0).attr("x2", iw).attr("y1", y(55)).attr("y2", y(55)).style("stroke", "var(--accent-2)").style("stroke-dasharray", "4 3");
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(4).tickFormat(d3.timeFormat("%b %-d")).tickSize(0).tickPadding(6)).call(axisClean);
  svg.on("pointermove", (e) => { const [px] = d3.pointer(e, g.node()); const r = rows[d3.bisector((q) => q.d).center(rows, x.invert(px))];
    tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `${wd(r.d)} ${md(r.d)}`), tipRow(tierCol(tierOf(r.o)), f0(r.o), "observed best"), tipRow(cssVar("--ink"), f0(r.a), "forecast day 1"), tipRow(cssVar("--trust"), f0(r.b), "day 3"), tipRow(cssVar("--muted"), f0(r.c), "day 5"))); })
    .on("pointerleave", () => tip.hide());
}

function buoyDrawer(k) {
  const b = BT().buoys[k], s = BT().series[k];
  if (!b?.by_lead) return null;
  const L = b.by_lead;
  return {
    kicker: "Forecast trust · buoy", title: `${b.name} (${k})`,
    body: [
      dStats([[`±${f1(L[1].hs.mae, " m")} → ±${f1(L[5].hs.mae, " m")}`, "wave-height error, day 1 → 5"], [`${L[1].hs.bias >= 0 ? "+" : ""}${(L[1].hs.bias).toFixed(2)} m`, "bias at day 1"],
        [`±${f1(L[1].tp.mae, " s")}`, "peak-period error, day 1"], [`${f0(L[1].dir.bias, "°")} / ±${f0(L[1].dir.mae, "°")}`, "direction bias / error"]]),
      b.n_obs < 24 * SMALL_N ? dNote(`Only ${Math.round(b.n_obs / 24)} days of observations so far.${k === "46206" ? " The +23° direction bias may be a magnetic/true reference difference in the buoy feed (unverified)." : ""}`) : null,
      s ? dChart("dr-ser", "Observed wave height (area) vs forecast 1, 3 and 5 days ahead (m)") : null,
      dNote(`Mean period runs ${f1(L[1].tm.bias, " s")} above the buoy's average period: different definitions, so the rule uses peak period instead.`),
    ],
    after: () => {
      if (!s) return;
      const t0 = new Date(s.t0), T = s.t.map((h) => new Date(+t0 + h * 36e5));
      const m = { l: 30, r: 8, t: 8, b: 20 };
      const { svg, g, iw, ih } = frame("dr-ser", m, 190);
      const x = d3.scaleTime(d3.extent(T), [0, iw]), y = d3.scaleLinear([0, d3.max([...s.obs, ...s.d1].filter((v) => v != null))], [ih, 0]).nice();
      gridY(g, y, iw, ih);
      g.append("path").datum(T.map((t, i) => [t, s.obs[i]])).attr("d", d3.area().defined(([, v]) => v != null).x(([t]) => x(t)).y0(ih).y1(([, v]) => y(v))).style("fill", "var(--live)").style("opacity", 0.3);
      for (const [k2, c, dash] of [["d1", "--ink", null], ["d3", "--trust", "3 2"], ["d5", "--muted", "1 2"]])
        g.append("path").datum(T.map((t, i) => [t, s[k2][i]])).attr("d", d3.line().defined(([, v]) => v != null).x(([t]) => x(t)).y(([, v]) => y(v))).style("fill", "none").style("stroke", `var(${c})`).style("stroke-width", 1.2).style("stroke-dasharray", dash);
      g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(4).tickFormat(d3.timeFormat("%b %-d")).tickSize(0).tickPadding(6)).call(axisClean);
      svg.on("pointermove", (e) => { const [px] = d3.pointer(e, g.node()); const i = d3.bisector((t) => t).center(T, x.invert(px));
        tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `${wd(T[i])} ${md(T[i])}`), tipRow(cssVar("--live"), f1(s.obs[i], " m"), "observed"), tipRow(cssVar("--ink"), f1(s.d1[i], " m"), "day 1"), tipRow(cssVar("--trust"), f1(s.d3[i], " m"), "day 3"), tipRow(cssVar("--muted"), f1(s.d5[i], " m"), "day 5"))); })
        .on("pointerleave", () => tip.hide());
    },
  };
}
