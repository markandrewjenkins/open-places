// Best months: how many playable daylight hours a typical day gives, month by month, from ten years of hourly
// Environment Canada observations put through the same rules as the forecast, plus the 1991–2025 daily climate record.
import * as d3 from "d3";
import { el } from "../shared/ui.js";
import { dStats, dNote, dHead } from "../shared/console.js";
import { G, $, tip, fmt0, fmt1, fH, pct, R, FOOTPRINT, clamp01, MONTHS, MONTHS_LONG, loadCore, loadClimate, route } from "./common.js";

const go = (...a) => G.ctx.go(...a);
const reg = () => G.CL.regions[G.region];
const stations = () => Object.entries(reg().observed || {});
const obs0 = () => stations()[0]?.[1];
const nowM = () => new Date().getMonth() + 1;
const monthRange = (ms) => { const s = [...ms].sort((a, b) => a - b); return s.every((m, i) => !i || m === s[i - 1] + 1) ? `${MONTHS[s[0] - 1]}–${MONTHS[s.at(-1) - 1]}` : s.map((m) => MONTHS[m - 1]).join(", "); };
const STN_COL = ["--g-months", "--g-months-2"];
const selM = () => { const r = route(); return r.topic === "months" && r.item ? +r.item : null; };

export const months = {
  id: "months", title: "Best months", color: "var(--g-months)",
  eyebrow: "Through the year", heading: "Season by Month",
  footprint: FOOTPRINT, kind: "only-here",
  // Civic Atlas: most useful while people plan the season (late winter and spring), least in high summer
  relevance: (ctx, date = new Date()) => clamp01([0.6, 0.75, 0.8, 0.7, 0.5, 0.35, 0.3, 0.3, 0.4, 0.45, 0.4, 0.5][date.getMonth()]),
  load: () => Promise.all([loadCore(), loadClimate()]),
  badge: () => [monthRange(obs0()?.best_months || []), "most playable daylight per day"],
  kpis: () => {
    const o = obs0(), m = nowM(), om = o.months[m - 1], cm = reg().months[m - 1];
    return [
      ["Best months", monthRange(o.best_months), `${fH(d3.max(o.months, (x) => x.playable_h))} playable on a typical day`],
      [`${MONTHS_LONG[m - 1]}, typically`, fH(om.playable_h), `playable of ${fH(cm.daylight_h)} daylight`],
      ["Frosty mornings", pct(om.frost_delay_pct), `of ${MONTHS[m - 1]} days start with a frost delay`],
      ["Dry, 12 °C+ days", pct(cm.good_days_pct), `of ${MONTHS[m - 1]} days, ${reg().period}`],
    ];
  },
  tile: (t) => {
    const o = obs0(), m = nowM();
    const lo = o.months.reduce((a, b) => ((b.playable_h ?? 99) < (a.playable_h ?? 99) ? b : a));
    t.kpis([[fH(o.months[m - 1].playable_h), `playable on a typical ${MONTHS[m - 1]} day`], [monthRange(o.best_months), "best months"], [fH(lo.playable_h), `in ${MONTHS_LONG[lo.month - 1]}, the low`]]);
    monthCols(t.vis, [o], { compact: true, pick: (mm) => go("months", "year", mm) });
  },
  subs: [
    { id: "year", title: "Through the year", short: "Year", class: "pane-mo-year", rows: "minmax(0, 1.3fr) minmax(0, 1fr)",
      view: () => yearView(), html: `
      <div class="card cx-fill"><h3 class="cx-card-title">Playable daylight hours on a typical day</h3><p class="note cx-card-sub" id="mo-year-sub"></p><div class="legend" id="mo-year-legend"></div><div class="chart" id="mo-year"></div></div>
      <div class="cx-row cols-2">
        <div class="card cx-fill"><h3 class="cx-card-title">Dry, 12 °C+ days</h3><p class="note cx-card-sub" id="mo-good-sub"></p><div class="chart" id="mo-good"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">Frost delays</h3><p class="note cx-card-sub">Share of days with frost on the course after sunrise (night low ≤ 1 °C, play waits until the air reaches 3 °C); the label is the usual first tee time.</p><div class="chart" id="mo-frost"></div></div>
      </div>` },
    { id: "normals", title: "Climate table", short: "Table", class: "pane-mo-table",
      view: () => tableView(), html: `
      <div class="card cx-fill"><h3 class="cx-card-title" id="mo-t-h">Month by month</h3><p class="note cx-card-sub" id="mo-t-sub"></p><div class="cx-grow g-scroll" id="mo-table"></div></div>` },
  ],
  drawers: { year: (h, c, item) => monthDrawer(+item), normals: (h, c, item) => monthDrawer(+item) },
};

// ------------------------------------------------------------------ charts
function monthCols(target, obs, opt = {}) {
  const host = $(target), m = { l: opt.compact ? 6 : 36, r: 6, t: opt.compact ? 6 : 10, b: 20 };
  const W = Math.max(160, host.clientWidth), H = Math.max(60, host.clientHeight || 180);
  host.replaceChildren();
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H);
  const g = svg.append("g").attr("transform", `translate(${m.l},${m.t})`), iw = W - m.l - m.r, ih = H - m.t - m.b;
  const cm = reg().months, best = new Set(obs[0].best_months), sel = selM(), cur = nowM();
  const x = d3.scaleBand(d3.range(1, 13), [0, iw]).padding(0.22), xi = d3.scaleBand(obs.map((_, i) => i), [0, x.bandwidth()]).padding(0.08);
  const y = d3.scaleLinear([0, d3.max(cm, (c) => c.daylight_h) + 0.5], [ih, 0]).nice();
  if (!opt.compact) {
    g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(4)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
    g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4).tickFormat((v) => `${v} h`).tickSize(0).tickPadding(6)).call((a) => a.select(".domain").remove());
  }
  const col = g.selectAll("g.c").data(d3.range(1, 13)).join("g").attr("class", (mm) => `c${opt.pick ? " pick" : ""}${sel === mm ? " on" : ""}`).attr("transform", (mm) => `translate(${x(mm)},0)`);
  col.append("rect").attr("class", "wk-day").attr("width", x.bandwidth()).attr("y", (mm) => y(cm[mm - 1].daylight_h - 2 * 20 / 60)).attr("height", (mm) => ih - y(cm[mm - 1].daylight_h - 2 * 20 / 60)).attr("rx", 3);
  obs.forEach((o, i) => col.append("rect").attr("x", xi(i)).attr("width", xi.bandwidth()).attr("y", (mm) => y(o.months[mm - 1].playable_h || 0)).attr("height", (mm) => ih - y(o.months[mm - 1].playable_h || 0)).attr("rx", 2)
    .style("fill", `var(${STN_COL[i]})`).style("opacity", (mm) => (best.has(mm) || !opt.compact ? 1 : 0.6)));
  col.append("text").attr("class", "label").attr("x", x.bandwidth() / 2).attr("y", ih + 13).attr("text-anchor", "middle").style("font-size", "10.5px")
    .style("font-weight", (mm) => (mm === cur || mm === sel ? 700 : null)).text((mm) => (opt.compact && W < 360 ? MONTHS[mm - 1][0] : MONTHS[mm - 1]));
  if (!opt.compact) col.filter((mm) => best.has(mm)).append("text").attr("class", "wk-flag").attr("x", x.bandwidth() / 2).attr("y", (mm) => y(cm[mm - 1].daylight_h - 2 / 3) - 4).attr("text-anchor", "middle").text("⛳");
  col.append("rect").attr("width", x.bandwidth()).attr("y", -m.t).attr("height", ih + m.t + m.b).style("fill", "transparent").style("cursor", opt.pick ? "pointer" : null)
    .on("click", (e, mm) => { if (opt.pick) { tip.hide(); opt.pick(mm); } })
    .on("pointermove", (e, mm) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, MONTHS_LONG[mm - 1]),
      ...obs.map((o, i) => el("div", { class: "t-row" }, el("i", { class: "t-key", style: { background: `var(${STN_COL[i]})` } }), el("b", {}, fH(o.months[mm - 1].playable_h)), el("span", {}, o.station))),
      el("div", { class: "t-row" }, el("b", {}, fH(cm[mm - 1].daylight_h - 2 / 3)), el("span", {}, "usable daylight")))))
    .on("pointerleave", () => tip.hide());
}
function pctCols(target, vals, color, label, sub) {
  const host = $(target), m = { l: 30, r: 6, t: 14, b: 20 };
  const W = Math.max(160, host.clientWidth), H = Math.max(60, host.clientHeight || 150);
  host.replaceChildren();
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H);
  const g = svg.append("g").attr("transform", `translate(${m.l},${m.t})`), iw = W - m.l - m.r, ih = H - m.t - m.b, sel = selM();
  const x = d3.scaleBand(d3.range(1, 13), [0, iw]).padding(0.25), y = d3.scaleLinear([0, 100], [ih, 0]);
  g.append("g").attr("class", "grid").selectAll("line").data([0, 50, 100]).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickValues([0, 50, 100]).tickFormat((v) => `${v}%`).tickSize(0).tickPadding(4)).call((a) => a.select(".domain").remove());
  const col = g.selectAll("g.c").data(d3.range(1, 13)).join("g").attr("class", (mm) => `c pick${sel === mm ? " on" : ""}`).attr("transform", (mm) => `translate(${x(mm)},0)`);
  col.append("rect").attr("width", x.bandwidth()).attr("y", (mm) => y(vals[mm - 1] || 0)).attr("height", (mm) => ih - y(vals[mm - 1] || 0)).attr("rx", 2).style("fill", `var(${color})`);
  if (sub) col.append("text").attr("class", "axis-t").attr("x", x.bandwidth() / 2).attr("y", (mm) => y(vals[mm - 1] || 0) - 3).attr("text-anchor", "middle").text((mm) => sub(mm));
  col.append("text").attr("class", "label").attr("x", x.bandwidth() / 2).attr("y", ih + 13).attr("text-anchor", "middle").style("font-size", "10px").text((mm) => (W < 380 ? MONTHS[mm - 1][0] : MONTHS[mm - 1]));
  col.append("rect").attr("width", x.bandwidth()).attr("y", -m.t).attr("height", ih + m.t + m.b).style("fill", "transparent").style("cursor", "pointer")
    .on("click", (e, mm) => { tip.hide(); go("months", "year", mm); })
    .on("pointermove", (e, mm) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, MONTHS_LONG[mm - 1]), el("div", { class: "t-row" }, el("b", {}, pct(vals[mm - 1])), el("span", {}, label)))))
    .on("pointerleave", () => tip.hide());
}

function yearView() {
  const obs = stations().map(([, o]) => o);
  $("mo-year-sub").textContent = `Mean daily playable daylight hours, ${obs.map((o) => `${o.station} (${o.period.slice(0, 4)}–${o.period.slice(14, 18)})`).join(" and ")}, with the same rules as the forecast (no gust record at these stations). Pale column = usable daylight. ⛳ = the four best months. Click a month.`;
  $("mo-year-legend").replaceChildren(...obs.map((o, i) => el("span", { class: "key" }, el("i", { class: "band", style: { background: `var(${STN_COL[i]})` } }), o.station)),
    el("span", { class: "key" }, el("i", { class: "band wk-day-key" }), "usable daylight"));
  monthCols("mo-year", obs, { pick: (mm) => go("months", "year", mm) });
  $("mo-good-sub").textContent = `Days under 1 mm of rain with a high of at least 12 °C, ${reg().stations}, ${reg().period}.`;
  pctCols("mo-good", reg().months.map((x) => x.good_days_pct), "--g-good", "of days dry and 12 °C or warmer");
  const o = obs[0];
  pctCols("mo-frost", o.months.map((x) => x.frost_delay_pct), "--g-frost", `of days with a frost delay (${o.station})`,
    (mm) => { const h = o.months[mm - 1].frost_until_median_h; return h != null && o.months[mm - 1].frost_delay_pct >= 3 ? `${h % 12 || 12}${h < 12 ? "a" : "p"}` : ""; });
}

function tableView() {
  const cm = reg().months, obs = stations().map(([, o]) => o), sel = selM(), cur = nowM();
  $("mo-t-h").textContent = `${R().name}, month by month`;
  $("mo-t-sub").textContent = `Climate: ${reg().stations}, ${reg().period}. Playable hours: ${obs.map((o) => o.station).join(" and ")}, hourly observations since 2016. Click a month for the detail.`;
  const cols = [["High", (m) => `${fmt1(cm[m].tmax)}°`], ["Low", (m) => `${fmt1(cm[m].tmin)}°`], ["Rain", (m) => `${fmt0(cm[m].precip_mm)} mm`], ["Wet days", (m) => pct(cm[m].wet_days_pct)],
    ["Frost nights", (m) => pct(cm[m].frost_days_pct)], ["Dry, 12°+", (m) => pct(cm[m].good_days_pct)], ["Daylight", (m) => fH(cm[m].daylight_h)],
    ...obs.map((o) => [`Playable, ${o.station.replace(/ CS$/, "").replace("Victoria University", "UVic")}`, (m) => fH(o.months[m].playable_h)]),
    ["Frost delay", (m) => pct(obs[0].months[m].frost_delay_pct)]];
  const best = new Set(obs[0].best_months);
  const t = el("table", { class: "data g-mtable" }, el("thead", {}, el("tr", {}, el("th", {}, "Month"), ...cols.map(([h]) => el("th", { class: "num" }, h)))),
    el("tbody", {}, ...d3.range(12).map((m) => el("tr", { class: [sel === m + 1 ? "on" : "", cur === m + 1 ? "now" : "", best.has(m + 1) ? "best" : ""].join(" ").trim() || null, "data-m": m + 1 },
      el("td", {}, el("a", { href: `#months/normals/${m + 1}` }, MONTHS_LONG[m]), best.has(m + 1) ? " ⛳" : "", cur === m + 1 ? el("small", { class: "g-now" }, " now") : ""),
      ...cols.map(([, f]) => el("td", { class: "num" }, f(m)))))));
  t.addEventListener("click", (e) => { if (e.target.closest("a")) return; const tr = e.target.closest("tr[data-m]"); if (tr) go("months", "normals", tr.dataset.m); });
  $("mo-table").replaceChildren(t);
}

function monthDrawer(mm) {
  if (!(mm >= 1 && mm <= 12) || !G.CL) return null;
  const cm = reg().months[mm - 1], obs = stations().map(([, o]) => o), o = obs[0].months[mm - 1];
  const rank = [...obs[0].months].sort((a, b) => (b.playable_h || 0) - (a.playable_h || 0)).findIndex((x) => x.month === mm) + 1;
  return {
    kicker: `${R().name} · #${rank} of 12 for playable hours`, title: MONTHS_LONG[mm - 1],
    body: [
      dStats([[fH(o.playable_h), `playable on a typical day (${obs[0].station})`], [pct(o.playable_day_pct), "of days give 4+ playable hours"],
        [pct(cm.good_days_pct), "of days dry and 12 °C+"], [pct(o.frost_delay_pct), o.frost_until_median_h != null && o.frost_delay_pct >= 3 ? `frost delays, usually clear by ${o.frost_until_median_h % 12 || 12} ${o.frost_until_median_h < 12 ? "am" : "pm"}` : "of days with a frost delay"]]),
      dHead("Climate"),
      dStats([[`${fmt1(cm.tmax)}° / ${fmt1(cm.tmin)}°`, "average high / low"], [`${fmt0(cm.precip_mm)} mm`, `rain; ${pct(cm.wet_days_pct)} of days wet`], [pct(cm.soaking_days_pct), "soaking days (10 mm+)"], [fH(cm.daylight_h), "sunrise to sunset"]]),
      obs.length > 1 ? dHead("Each station") : null,
      obs.length > 1 ? el("ul", { class: "g-dlist" }, ...obs.map((x) => el("li", {}, el("span", {}, x.station), el("b", {}, fH(x.months[mm - 1].playable_h)), el("span", {}, `${pct(x.months[mm - 1].playable_day_pct)} of days 4 h+`), el("span", {}, `frost ${pct(x.months[mm - 1].frost_delay_pct)}`)))) : null,
      dNote(`Playable hours are averages over ${fmt0(o.days)} observed ${MONTHS[mm - 1]} days since 2016 at ${obs[0].station}, through the same rules as the 7-day forecast. Courses near the water run a little milder than inland ones.`),
    ],
  };
}
