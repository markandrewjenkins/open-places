// Open Places: the small visuals on the overview tiles and the extra charts in the detail panes.
// d3, theme tokens only (--s1…--s3 series, --live/--warn/--bad status, --grid/--axis/--muted/--ink/--surface); styles in
// civic-charts.css. Every helper sizes to its host box and adapts: a host under ~40 px tall gets a sparkline-sized form
// (no labels), a taller one gets labels, a pane-sized one gets axes. Mock charts fill their marks with a 45° hatch and
// carry a "mock" chip, so they never read as real data. No transitions (nothing to switch off for reduced motion).
import * as d3 from "d3";
import { el, tooltip, tipRow, cssVar } from "../src/shared/ui.js";

const tip = tooltip();
const $ = (t) => (typeof t === "string" ? document.getElementById(t) : t);
let uid = 0;

// ------------------------------------------------------------------ plumbing
export const size = (host) => { host = $(host); return { W: host.clientWidth, H: host.clientHeight }; };
export function box(host, m) {
  host = $(host);
  const w = Math.max(60, host.clientWidth), h = Math.max(20, host.clientHeight || 120);
  host.replaceChildren();
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${w} ${h}`).attr("width", w).attr("height", h);
  return { host, svg, g: svg.append("g").attr("transform", `translate(${m.l},${m.t})`), iw: Math.max(8, w - m.l - m.r), ih: Math.max(6, h - m.t - m.b), w, h };
}
/** a 45° hatch in a token colour: the fill of every mock mark */
export function hatch(svg, color = "var(--s1)") {
  const id = `civ-h${++uid}`;
  const p = svg.append("defs").append("pattern").attr("id", id).attr("patternUnits", "userSpaceOnUse").attr("width", 5).attr("height", 5).attr("patternTransform", "rotate(45)");
  p.append("rect").attr("width", 5).attr("height", 5).style("fill", color).style("opacity", 0.16);
  p.append("rect").attr("width", 2).attr("height", 5).style("fill", color);
  return `url(#${id})`;
}
/** re-fill an already drawn chart's marks with the hatch and add the chip (for charts drawn by the older helpers) */
export function mockMarks(host, sel = "rect.c, path.c", color = "var(--s1)") {
  const svg = d3.select($(host)).select("svg"); if (svg.empty()) return;
  svg.selectAll(sel).style("fill", hatch(svg, color)).style("opacity", null);
  mockChip(host);
}
export const mockChip = (host, text = "mock") => $(host).append(el("em", { class: "civ-tag civ-xmock", "data-kind": "mock" }, text));
export const emptyNote = (host, text) => $(host).replaceChildren(el("p", { class: "note civ-empty" }, text));
const col = (c) => (c.startsWith("var(") ? c : `var(--${c})`);
/** tooltip: title + rows of [token|null, value, label] */
function tt(host, t, title, rows) {
  t.append(el("div", { class: "t-title" }, title));
  for (const r of rows) if (r) t.append(tipRow(r[0] ? cssVar(r[0].replace(/^var\((--[\w-]+)\)$/, "$1"), host) || null : null, r[1], r[2] || ""));
}
const onTip = (sel, host, build) => sel.on("pointermove", (e, d) => tip.show(e.clientX, e.clientY, (t) => build(t, d))).on("pointerleave", () => tip.hide());
/** crosshair + tooltip over x-ordered points */
function hoverX(svg, g, x, ih, pts, build) {
  const rule = g.append("line").attr("class", "civ-xh").attr("y1", 0).attr("y2", ih).style("display", "none");
  const bis = d3.bisector((d) => d.x).center;
  svg.on("pointermove", (e) => {
    const [px] = d3.pointer(e, g.node()), p = pts[bis(pts, x.invert(px))]; if (!p) return;
    rule.attr("x1", x(p.x)).attr("x2", x(p.x)).style("display", null);
    tip.show(e.clientX, e.clientY, (t) => build(t, p));
  }).on("pointerleave", () => { rule.style("display", "none"); tip.hide(); });
}
const hm = (d) => `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${d.getHours() < 12 ? "am" : "pm"}`;
const fHour = d3.timeFormat("%a %-I %p");

// ------------------------------------------------------------------ day and night
/** night spans [a, b] (ms) inside [t0, t1], from Open-Meteo's daily sunrise / sunset strings */
export function nightSpans(rises, sets, t0, t1) {
  const R = rises.map((s) => new Date(s)), S = sets.map((s) => new Date(s));
  const spans = R.map((r, k) => [k ? +S[k - 1] : +r - 864e5, +r]);
  spans.push([+S.at(-1), +S.at(-1) + 864e5]);
  return spans.map(([a, b]) => [Math.max(a, +t0), Math.min(b, +t1)]).filter(([a, b]) => b > a);
}
/** hours of daylight at a latitude on a day of the year (sunrise to sunset, with refraction) */
export function dayLength(lat, doy) {
  const r = Math.PI / 180, dec = 23.44 * r * Math.sin(((2 * Math.PI) / 365) * (doy - 81)), phi = lat * r;
  const c = (Math.sin(-0.833 * r) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  return c >= 1 ? 0 : c <= -1 ? 24 : (2 * Math.acos(c)) / r / 15;
}
const fH = (h) => `${Math.floor(h)}h ${String(Math.round((h % 1) * 60)).padStart(2, "0")}m`;

/** next 24 h of temperature as a sparkline over shaded nights (the tile's daylight bar). w = Open-Meteo forecast */
export function daySpark(host, w, i, hours = 24) {
  const t = w.hourly.time.slice(i, i + hours).map((s) => new Date(s)), v = w.hourly.temperature_2m.slice(i, i + hours);
  if (t.length < 2) return;
  const { H } = size(host), lab = H >= 34;
  const { svg, g, iw, ih } = box(host, { l: 2, r: 2, t: 4, b: lab ? 12 : 2 });
  const x = d3.scaleTime(d3.extent(t), [0, iw]), y = d3.scaleLinear(d3.extent(v), [ih - 2, 2]);
  const nights = nightSpans(w.daily.sunrise, w.daily.sunset, t[0], t.at(-1));
  for (const [a, b] of nights) g.append("rect").attr("class", "civ-night").attr("x", x(a)).attr("width", Math.max(0, x(b) - x(a))).attr("y", 0).attr("height", ih).attr("rx", 2);
  const pts = t.map((x_, k) => ({ x: x_, y: v[k] }));
  g.append("path").datum(pts).attr("class", "civ-area").attr("d", d3.area().x((d) => x(d.x)).y0(ih).y1((d) => y(d.y)).curve(d3.curveMonotoneX));
  g.append("path").datum(pts).attr("class", "civ-line").attr("d", d3.line().x((d) => x(d.x)).y((d) => y(d.y)).curve(d3.curveMonotoneX));
  if (lab) {
    const sets = w.daily.sunset.map((s) => new Date(s)).filter((d) => d > t[0] && d < t.at(-1));
    const rises = w.daily.sunrise.map((s) => new Date(s)).filter((d) => d > t[0] && d < t.at(-1));
    const marks = [...sets.map((d) => ({ d, k: "sets" })), ...rises.map((d) => ({ d, k: "rises" }))].sort((a, b) => a.d - b.d);
    let last = -99;
    for (const mk of marks) {
      const px = x(mk.d); if (px - last < 52) continue; last = px;
      g.append("text").attr("class", "axis-t").attr("x", Math.max(0, Math.min(iw, px))).attr("y", ih + 10).attr("text-anchor", px < 24 ? "start" : px > iw - 24 ? "end" : "middle").text(`${mk.k === "sets" ? "↓" : "↑"} ${hm(mk.d)}`);
    }
  }
  hoverX(svg, g, x, ih, pts, (tp, p) => tt(host, tp, fHour(p.x), [["--s1", `${Math.round(p.y)}°`, nights.some(([a, b]) => +p.x >= a && +p.x <= b) ? "night" : "daylight"]]));
}

// ------------------------------------------------------------------ weather glyphs and the 7-day strip
export const wxKind = (c) => (c == null ? "cloud" : c <= 1 ? "sun" : c === 2 ? "part" : c === 3 ? "cloud" : c <= 48 ? "fog" : c <= 57 ? "drizzle" : c <= 67 ? "rain" : c <= 77 ? "snow" : c <= 82 ? "rain" : c <= 86 ? "snow" : "storm");
const CLOUD = "M-5.5,3.5H5A3,3 0 0 0 5,-2.5A4.5,4.5 0 0 0 -3.6,-3.2A3.3,3.3 0 0 0 -5.5,3.5Z";
function sun(G, cx, cy, r) {
  G.append("circle").attr("class", "sun").attr("cx", cx).attr("cy", cy).attr("r", r);
  for (let k = 0; k < 8; k++) { const a = (k * Math.PI) / 4; G.append("line").attr("class", "ray").attr("x1", cx + Math.cos(a) * (r + 1.6)).attr("y1", cy + Math.sin(a) * (r + 1.6)).attr("x2", cx + Math.cos(a) * (r + 3.2)).attr("y2", cy + Math.sin(a) * (r + 3.2)); }
}
/** a 16-unit weather glyph centred on the group's origin, scaled to `s` px */
export function glyph(g, kind, s) {
  const G = g.append("g").attr("class", "civ-wx").attr("transform", `scale(${s / 16})`);
  if (kind === "sun") return sun(G, 0, 0, 3.6);
  if (kind === "fog") { for (const yy of [-3, 0, 3]) G.append("line").attr("class", "fogl").attr("x1", -6).attr("x2", 6).attr("y1", yy).attr("y2", yy); return; }
  if (kind === "part") sun(G, -2.6, -2.8, 2.6);
  const up = kind === "part" || kind === "cloud" ? 1.5 : -1.5;
  G.append("path").attr("class", "cl").attr("d", CLOUD).attr("transform", `translate(0.5,${up})`);
  if (kind === "rain" || kind === "drizzle") for (const xx of kind === "rain" ? [-3, 0, 3] : [-1.5, 1.5]) G.append("line").attr("class", "drop").attr("x1", xx).attr("y1", 4).attr("x2", xx - 1.2).attr("y2", 7);
  if (kind === "snow") for (const [xx, yy] of [[-3, 5], [0, 6.6], [3, 5]]) G.append("circle").attr("class", "flake").attr("cx", xx).attr("cy", yy).attr("r", 0.95);
  if (kind === "storm") G.append("path").attr("class", "bolt").attr("d", "M0.6,2.2L-1.6,5.4H0.2L-0.6,8L2.4,4.4H0.6L1.6,2.2Z");
}
/** seven days as columns: weekday, glyph, a min–max temperature bar on a shared scale (+ labels and rain when tall).
 *  days: [{ d: Date, hi, lo, code, mm, text }] */
export function wxStrip(host, days, o = {}) {
  const { H } = size(host), full = H >= 120;
  const showDay = H >= 50, showT = H >= 84, showMm = full;
  const { svg, g, iw, ih } = box(host, { l: 1, r: 1, t: 1, b: 1 });
  const x = d3.scaleBand(d3.range(days.length), [0, iw]).paddingInner(0.14), bw = x.bandwidth();
  const dayH = showDay ? (full ? 16 : 11) : 0, ic = Math.max(10, Math.min(bw * 0.8, full ? 28 : 17, ih * 0.34));
  const tH = showT ? (full ? 14 : 11) : 0, mmH = showMm ? 15 : 0;
  const yTop = dayH + ic + 5 + tH, yBot = Math.max(yTop + 4, ih - tH - mmH - 1);
  const y = d3.scaleLinear([d3.min(days, (d) => d.lo), d3.max(days, (d) => d.hi)], [yBot, yTop]);
  const rw = Math.max(3, Math.min(full ? 10 : 6, bw * 0.34));
  const cols = g.selectAll("g.d").data(days).join("g").attr("class", "d").attr("transform", (_, i) => `translate(${x(i) + bw / 2},0)`);
  if (showDay) cols.append("text").attr("class", "axis-t").attr("y", dayH - 3).attr("text-anchor", "middle").classed("hl", (_, i) => i === 0)
    .text((d) => d3.timeFormat("%a")(d.d).slice(0, bw < 20 ? 1 : 3));
  cols.each(function (d) { glyph(d3.select(this).append("g").attr("transform", `translate(0,${dayH + ic / 2 + 1})`), wxKind(d.code), ic); });
  cols.append("rect").attr("class", "civ-range").attr("x", -rw / 2).attr("width", rw).attr("y", (d) => y(d.hi)).attr("height", (d) => Math.max(rw, y(d.lo) - y(d.hi))).attr("rx", rw / 2);
  if (showT) {
    cols.append("text").attr("class", "axis-t civ-v-hi").attr("y", (d) => y(d.hi) - 3).attr("text-anchor", "middle").text((d) => `${Math.round(d.hi)}°`);
    cols.append("text").attr("class", "axis-t").attr("y", (d) => Math.max(y(d.lo), y(d.hi) + rw) + tH - 1).attr("text-anchor", "middle").text((d) => `${Math.round(d.lo)}°`);
  }
  if (showMm) cols.append("text").attr("class", "axis-t civ-mm").attr("y", ih - 3).attr("text-anchor", "middle").text((d) => (d.mm >= 0.5 ? `${Math.round(d.mm)} mm` : ""));
  onTip(cols.append("rect").attr("class", "civ-hit").attr("x", -bw / 2).attr("width", bw).attr("y", 0).attr("height", ih), host,
    (t, d) => tt(host, t, d3.timeFormat("%A %b %-d")(d.d), [["--s1", `${Math.round(d.hi)}° / ${Math.round(d.lo)}°`, "high / low"], [null, d.text || "", ""], d.mm >= 0.1 ? [null, `${d.mm.toFixed(1)} mm`, "precipitation"] : null]));
}

/** the next hours in two stacked panels on one time axis: temperature (line) over chance of precipitation (columns),
 *  nights shaded. Two panels, not two y-scales on one plot. */
export function comboHourly(host, w, i, n = 72) {
  const t = w.hourly.time.slice(i, i + n).map((s) => new Date(s)), T = w.hourly.temperature_2m.slice(i, i + n), P = w.hourly.precipitation_probability.slice(i, i + n);
  const pts = t.map((x_, k) => ({ x: x_, y: T[k], p: P[k] ?? 0 }));
  const { svg, g, iw, ih } = box(host, { l: 40, r: 12, t: 8, b: 22 });
  const gap = 16, h2 = Math.max(28, Math.round(ih * 0.3)), h1 = Math.max(30, ih - h2 - gap);
  const x = d3.scaleTime(d3.extent(t), [0, iw]);
  const [t0, t1] = d3.extent(T), y1 = d3.scaleLinear([t0, t1 + (t1 - t0) * 0.18], [h1, 0]).nice(4), y2 = d3.scaleLinear([0, 100], [h2, 0]);
  const nights = nightSpans(w.daily.sunrise, w.daily.sunset, t[0], t.at(-1));
  const p1 = g.append("g"), p2 = g.append("g").attr("transform", `translate(0,${h1 + gap})`);
  for (const [p, h] of [[p1, h1], [p2, h2]]) for (const [a, b] of nights) p.append("rect").attr("class", "civ-night").attr("x", x(a)).attr("width", x(b) - x(a)).attr("y", 0).attr("height", h);
  const n1 = h1 < 140 ? 3 : 5;
  p1.append("g").attr("class", "grid").selectAll("line").data(y1.ticks(n1)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y1).attr("y2", y1);
  p1.append("g").attr("class", "axis").call(d3.axisLeft(y1).ticks(n1).tickFormat((v) => `${v}°`).tickSize(0).tickPadding(6)).call((s) => s.select(".domain").remove());
  p2.append("g").attr("class", "grid").selectAll("line").data([0, 50, 100]).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y2).attr("y2", y2);
  p2.append("g").attr("class", "axis").call(d3.axisLeft(y2).tickValues([0, 50, 100]).tickFormat((v) => `${v}%`).tickSize(0).tickPadding(6)).call((s) => s.select(".domain").remove());
  p1.append("path").datum(pts).attr("class", "civ-line").attr("d", d3.line().x((d) => x(d.x)).y((d) => y1(d.y)).curve(d3.curveMonotoneX));
  const cw = Math.max(1, iw / n - 1);
  p2.selectAll("rect.c").data(pts.filter((d) => d.p > 0)).join("rect").attr("class", "c civ-col2").attr("x", (d) => x(d.x) - cw / 2).attr("width", cw).attr("y", (d) => y2(d.p)).attr("height", (d) => h2 - y2(d.p)).attr("rx", Math.min(2, cw / 2));
  p1.append("text").attr("class", "axis-t halo civ-plab").attr("x", 6).attr("y", 11).text("Temperature");
  p2.append("text").attr("class", "axis-t halo civ-plab").attr("x", 6).attr("y", 11).text("Chance of precipitation");
  const byDay = iw < 520;
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(d3.timeHour.every(byDay ? 24 : 12)).tickFormat(d3.timeFormat(byDay ? "%a" : "%a %-I %p")).tickSize(0).tickPadding(6)).call((s) => s.select(".domain").remove());
  hoverX(svg, g, x, ih, pts, (tp, p) => tt(host, tp, fHour(p.x), [["--s1", `${Math.round(p.y)}°`, "temperature"], [null, `${Math.round(p.p)}%`, "chance of precipitation"]]));
}

/** hours of daylight through the year at this latitude (computed), today marked */
export function dayCurve(host, lat, today) {
  const yr = today.getFullYear(), days = d3.timeDay.range(new Date(yr, 0, 1), new Date(yr + 1, 0, 1));
  const pts = days.map((d, k) => ({ x: d, y: dayLength(lat, k + 1) }));
  const { H } = size(host), mini = H < 90;
  const { svg, g, iw, ih } = box(host, mini ? { l: 2, r: 2, t: 4, b: 3 } : { l: 34, r: 12, t: 12, b: 22 });
  const x = d3.scaleTime([days[0], new Date(yr, 11, 31)], [0, iw]), [lo, hi] = d3.extent(pts, (p) => p.y);
  const y = d3.scaleLinear([Math.max(0, Math.floor(lo) - 1), Math.min(24, Math.ceil(hi) + 1)], [ih, 0]);
  if (!mini) {
    g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(4)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
    g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4).tickFormat((v) => `${v} h`).tickSize(0).tickPadding(6)).call((s) => s.select(".domain").remove());
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(d3.timeMonth.every(iw < 360 ? 2 : 1)).tickFormat(d3.timeFormat("%b")).tickSize(0).tickPadding(6)).call((s) => s.select(".domain").remove());
  }
  g.append("path").datum(pts).attr("class", "civ-area").attr("d", d3.area().x((d) => x(d.x)).y0(ih).y1((d) => y(d.y)));
  g.append("path").datum(pts).attr("class", "civ-line").attr("d", d3.line().x((d) => x(d.x)).y((d) => y(d.y)));
  const k = d3.timeDay.count(new Date(yr, 0, 1), today), now = pts[Math.min(pts.length - 1, k)];
  g.append("line").attr("class", "civ-ref").attr("x1", x(now.x)).attr("x2", x(now.x)).attr("y1", 0).attr("y2", ih);
  g.append("circle").attr("class", "civ-dot").attr("cx", x(now.x)).attr("cy", y(now.y)).attr("r", 4.5);
  if (!mini) {
    const right = x(now.x) > iw * 0.7;
    g.append("text").attr("class", "axis-t halo civ-strong").attr("x", x(now.x) + (right ? -8 : 8)).attr("y", y(now.y) - 8).attr("text-anchor", right ? "end" : "start").text(`today ${fH(now.y)}`);
    for (const [mo, d, lbl] of [[5, 21, "longest"], [11, 21, "shortest"]]) { const p = pts[d3.timeDay.count(new Date(yr, 0, 1), new Date(yr, mo, d))]; if (Math.abs(x(p.x) - x(now.x)) > 60) g.append("text").attr("class", "axis-t halo").attr("x", x(p.x)).attr("y", y(p.y) + (lbl === "longest" ? -6 : 14)).attr("text-anchor", "middle").text(`${lbl} ${fH(p.y)}`); }
  }
  hoverX(svg, g, x, ih, pts, (tp, p) => tt(host, tp, d3.timeFormat("%b %-d")(p.x), [["--s1", fH(p.y), "of daylight"]]));
}

// ------------------------------------------------------------------ meters and steps
/** a segmented meter: an arc gauge in a squarish box, a bar in a wide or short one.
 *  segs: [{ from, to, c: token }]; v: the value; max: the top of the scale; text: centre label (arc) */
export function meter(host, o) {
  const { W, H } = size(host), arc = !o.bar && H >= 40 && W < H * 2.7;
  const lit = (s) => o.v > s.from;
  if (arc) {
    const r = Math.max(14, Math.min(W / 2 - 4, (H - (o.text ? 4 : 6)) * (o.text ? 0.92 : 1))), th = Math.max(5, r * 0.24);
    const { svg, g } = box(host, { l: 0, t: 0, r: 0, b: 0 });
    g.attr("transform", `translate(${Math.max(60, W) / 2},${Math.min(H - 4, r + 4)})`);
    const a = d3.scaleLinear([0, o.max], [-Math.PI / 2, Math.PI / 2]).clamp(true);
    const pad = o.segs.length > 6 ? 0.035 : 0.05;
    g.selectAll("path.seg").data(o.segs).join("path").attr("class", "seg")
      .attr("d", (s) => d3.arc().innerRadius(r - th).outerRadius(r).startAngle(a(s.from) + pad / 2).endAngle(a(s.to) - pad / 2).cornerRadius(1.5)())
      .style("fill", (s) => col(s.c)).style("opacity", (s) => (lit(s) ? 1 : 0.2));
    const av = a(Math.min(o.v, o.max)), nr = r - th - 3;
    g.append("line").attr("class", "civ-needle").attr("x1", 0).attr("y1", 0).attr("x2", Math.sin(av) * nr).attr("y2", -Math.cos(av) * nr);
    g.append("circle").attr("class", "civ-hub").attr("r", Math.max(2.5, r * 0.07));
    if (o.text && r >= 40) g.append("text").attr("class", "civ-gv").attr("y", -r * 0.28).attr("text-anchor", "middle").style("font-size", `${Math.round(r * 0.36)}px`).text(o.text);
    if (o.sub && r >= 40) g.append("text").attr("class", "axis-t").attr("y", 16).attr("text-anchor", "middle").text(o.sub);
    onTip(svg, host, (t) => tt(host, t, o.title || "", [[null, o.text || `${o.v}`, o.sub || ""]]));
    return;
  }
  const lab = H >= 28 && o.ticks;
  const { svg, g, iw, ih } = box(host, { l: 2, r: 2, t: 2, b: lab ? 12 : 2 });
  const x = d3.scaleLinear([0, o.max], [0, iw]).clamp(true), bh = Math.min(10, Math.max(5, ih * 0.5)), yy = (ih - bh) / 2;
  g.selectAll("rect.seg").data(o.segs).join("rect").attr("class", "seg").attr("x", (s) => x(s.from) + 1).attr("width", (s) => Math.max(1, x(s.to) - x(s.from) - 2))
    .attr("y", yy).attr("height", bh).attr("rx", Math.min(3, bh / 2)).style("fill", (s) => col(s.c)).style("opacity", (s) => (lit(s) ? 1 : 0.2));
  const vx = x(Math.min(o.v, o.max));
  g.append("path").attr("class", "civ-mk").attr("d", `M${vx - 4},${yy - 5}L${vx + 4},${yy - 5}L${vx},${yy - 0.5}Z`);
  if (lab) g.selectAll("text.tk").data(o.ticks).join("text").attr("class", "axis-t").attr("x", (d) => x(d)).attr("y", ih + 10).attr("text-anchor", (d, k) => (k === 0 ? "start" : k === o.ticks.length - 1 ? "end" : "middle")).text((d) => o.tickFmt ? o.tickFmt(d) : d);
  onTip(svg, host, (t) => tt(host, t, o.title || "", [[null, o.text || `${o.v}`, o.sub || ""]]));
}
export const AQHI_SEGS = d3.range(0, 11).map((k) => ({ from: k, to: k + 1, c: k < 3 ? "live" : k < 6 ? "warn" : "bad" }));
export const USAQI_SEGS = [[0, 50, "live"], [50, 100, "warn"], [100, 150, "bad"], [150, 200, "bad"], [200, 300, "bad"]].map(([from, to, c]) => ({ from, to, c }));

/** escalation steps in a row (e.g. information → watch → advisory → warning), lit up to `active` (-1: none) */
export function steps(host, levels, active, o = {}) {
  const { H } = size(host), lab = H >= 26;
  const { svg, g, iw, ih } = box(host, { l: 1, r: 1, t: 2, b: lab ? 13 : 2 });
  const fills = o.mock ? Object.fromEntries(levels.map((l) => [l.c, hatch(svg, col(l.c))])) : null;
  const x = d3.scaleBand(levels.map((_, k) => k), [0, iw]).paddingInner(0.05), bh = Math.min(o.full ? 30 : 12, ih), yy = (ih - bh) / 2;
  const s = g.selectAll("g.s").data(levels).join("g").attr("class", "s").attr("transform", (_, k) => `translate(${x(k)},0)`);
  s.append("rect").attr("y", yy).attr("width", x.bandwidth()).attr("height", bh).attr("rx", 3)
    .style("fill", (l, k) => (k <= active ? (fills ? fills[l.c] : col(l.c)) : "var(--surface-2)"));
  const fit = (t) => t.length * 5.6 + 4 <= x.bandwidth();
  if (lab && levels.every((l) => fit(l.short || l.label))) s.append("text").attr("class", "axis-t").classed("civ-strong", (_, k) => k === active).attr("x", x.bandwidth() / 2).attr("y", yy + bh + 12).attr("text-anchor", "middle").text((l) => (fit(l.label) ? l.label : l.short || l.label));
  if (active < 0 && o.none && bh >= 10) g.append("text").attr("class", "axis-t halo civ-strong").attr("x", iw / 2).attr("y", yy + bh / 2).attr("dy", "0.35em").attr("text-anchor", "middle").text(o.none);
  onTip(s, host, (t, l) => tt(host, t, l.label, [[null, levels.indexOf(l) === active ? "in effect" : "not in effect", o.mock ? "(mock)" : ""], l.note ? [null, l.note, ""] : null]));
  if (o.mock && o.chip) mockChip(host);
}

/** a strip of on/off cells with names (pattern lights). cells: [{ label, short, on, c, mock, title }] */
export function lights(host, cells, o = {}) {
  const { H } = size(host), lab = H >= 24;
  const { svg, g, iw, ih: full } = box(host, { l: 1, r: 1, t: 1, b: 1 });
  const ih = Math.min(full, o.maxH || full);
  const x = d3.scaleBand(cells.map((_, k) => k), [0, iw]).paddingInner(0.05), bw = x.bandwidth();
  const c = g.selectAll("g.l").data(cells).join("g").attr("class", "l").attr("transform", (_, k) => `translate(${x(k)},${(full - ih) / 2})`);
  c.append("rect").attr("width", bw).attr("height", ih).attr("rx", 3)
    .style("fill", (d) => (!d.on ? "var(--surface-2)" : d.mock ? hatch(svg, col(d.c)) : `color-mix(in oklab, ${col(d.c)} 30%, var(--surface))`));
  c.filter((d) => d.on && !d.mock).append("rect").attr("width", bw).attr("height", Math.min(3, ih / 4)).attr("rx", 1.5).style("fill", (d) => col(d.c));
  if (lab) c.append("text").attr("class", "axis-t halo civ-lt").classed("civ-strong", (d) => d.on).attr("x", bw / 2).attr("y", ih / 2).attr("dy", "0.35em").attr("text-anchor", "middle")
    .text((d) => (bw >= d.label.length * 6 + 8 ? d.label : d.short && bw >= d.short.length * 6 + 4 ? d.short : ""));
  onTip(c, host, (t, d) => tt(host, t, d.title || d.label, [[null, d.text || (d.on ? "active" : "quiet"), d.on ? (d.mock ? "mock" : "live") : ""]]));
}

// ------------------------------------------------------------------ time and distance strips
/** marks along one axis, optionally in rows. items: [{ x, x2?, row?, tone?, r?, label?, title, note? }]
 *  o: { domain, time?, rows?, now?, fmt, ticks?, mock?, chip?, unit? } */
export function strip(host, items, o = {}) {
  const { W, H } = size(host), rows = o.rows || [null], mini = H < 70;
  const left = !mini && o.rows ? Math.round(Math.min(150, W * 0.3)) : 0, lab = H >= 30;
  const { svg, g, iw, ih } = box(host, { l: left + (mini ? 4 : 10), r: mini ? 4 : 14, t: mini ? 3 : 8, b: lab ? (mini ? 12 : 22) : 3 });
  const x = (o.time ? d3.scaleTime() : d3.scaleLinear()).domain(o.domain).range([0, iw]).clamp(true);
  const yb = d3.scaleBand(rows.map((_, k) => k), [0, ih]).padding(mini ? 0.1 : 0.22), cy = (k) => yb(k || 0) + yb.bandwidth() / 2;
  const tks = o.ticks || x.ticks(Math.max(2, Math.floor(iw / (mini ? 60 : 90))));
  if (!mini) g.append("g").attr("class", "grid").selectAll("line").data(tks).join("line").attr("x1", x).attr("x2", x).attr("y1", 0).attr("y2", ih);
  g.selectAll("line.tr").data(rows).join("line").attr("class", "tr civ-track").attr("x1", 0).attr("x2", iw).attr("y1", (_, k) => cy(k)).attr("y2", (_, k) => cy(k));
  if (lab) g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickValues(mini ? [o.domain[0], o.domain[1]] : tks).tickFormat(o.fmt || null).tickSize(0).tickPadding(mini ? 3 : 6))
    .call((s) => s.select(".domain").remove()).call((s) => { if (mini) s.selectAll("text").attr("text-anchor", (_, k) => (k ? "end" : "start")); });
  if (!mini && o.rows) g.selectAll("text.rl").data(rows).join("text").attr("class", "axis-t lbl").attr("x", -10).attr("y", (_, k) => cy(k)).attr("dy", "0.35em").attr("text-anchor", "end").text((r) => r);
  if (o.now != null) g.append("line").attr("class", "civ-ref civ-now").attr("x1", x(o.now)).attr("x2", x(o.now)).attr("y1", 0).attr("y2", ih);
  const fills = {};
  const fillOf = (tone) => (o.mock ? (fills[tone] ??= hatch(svg, col(tone))) : col(tone));
  const rr = (d) => d.r || Math.max(3, Math.min(mini ? 4.5 : 6, yb.bandwidth() / 2.2));
  const m = g.selectAll("g.m").data(items).join("g").attr("class", "m");
  m.filter((d) => d.x2 != null).append("rect").attr("x", (d) => x(d.x)).attr("width", (d) => Math.max(4, x(d.x2) - x(d.x))).attr("y", (d) => cy(d.row) - rr(d)).attr("height", (d) => 2 * rr(d)).attr("rx", (d) => Math.min(4, rr(d)))
    .style("fill", (d) => fillOf(d.tone || "s1"));
  m.filter((d) => d.x2 == null).append("circle").attr("class", "civ-pt").attr("cx", (d) => x(d.x)).attr("cy", (d) => cy(d.row)).attr("r", rr).style("fill", (d) => fillOf(d.tone || "s1"));
  if (!mini || o.labels) m.filter((d) => d.label).append("text").attr("class", "axis-t halo").attr("x", (d) => x(d.x) + (d.x2 != null ? 4 : 0)).attr("y", (d) => cy(d.row) - rr(d) - 4)
    .attr("text-anchor", (d) => (d.x2 != null ? "start" : x(d.x) > iw - 30 ? "end" : x(d.x) < 30 ? "start" : "middle")).text((d) => d.label);
  m.append("rect").attr("class", "civ-hit").attr("x", (d) => x(d.x) - 7).attr("width", (d) => (d.x2 != null ? Math.max(4, x(d.x2) - x(d.x)) : 0) + 14).attr("y", (d) => cy(d.row) - rr(d) - 4).attr("height", (d) => 2 * rr(d) + 8);
  onTip(m, host, (t, d) => tt(host, t, d.title, [[d.tone ? col(d.tone) : "--s1", d.note || "", o.mock ? "mock" : ""]]));
  if (o.mock && o.chip) mockChip(host);
}

/** earthquakes as dots: x = time (or distance), y = magnitude, area ∝ magnitude. qs: [{ t, km, mag, place, tsu? }] */
export function quakeDots(host, qs, o = {}) {
  const { H } = size(host), mini = H < 90, key = o.key || "t", lab = H >= 34;
  const { svg, g, iw, ih } = box(host, mini ? { l: 5, r: 5, t: 5, b: lab ? 12 : 4 } : { l: 36, r: 16, t: 14, b: 22 });
  const x = (key === "t" ? d3.scaleTime() : d3.scaleLinear()).domain(o.domain).range([0, iw]).clamp(true);
  const lo = o.min ?? 2.5, y = d3.scaleLinear([lo, Math.max(o.top ?? lo + 2.5, d3.max(qs, (q) => q.mag) ?? 0)], [ih, 0]).nice();
  const r = d3.scaleSqrt([lo, y.domain()[1]], mini ? [2.5, Math.max(3.5, Math.min(7, ih / 2.6))] : [4, 13]).clamp(true);
  if (!mini) {
    g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(Math.min(5, Math.round(y.domain()[1] - y.domain()[0])))).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
    g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(Math.min(5, Math.round(y.domain()[1] - y.domain()[0]))).tickFormat((v) => `M${v}`).tickSize(0).tickPadding(6)).call((s) => s.select(".domain").remove());
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(iw / 90))).tickFormat(o.fmt || null).tickSize(0).tickPadding(6)).call((s) => s.select(".domain").remove());
  } else {
    g.append("line").attr("class", "civ-track").attr("x1", 0).attr("x2", iw).attr("y1", ih).attr("y2", ih);
    if (lab) for (const [v, k] of [[o.domain[0], 0], [o.domain[1], 1]]) g.append("text").attr("class", "axis-t").attr("x", k ? iw : 0).attr("y", ih + 10).attr("text-anchor", k ? "end" : "start").text(o.fmt ? o.fmt(v) : v);
  }
  if (o.now) g.append("line").attr("class", "civ-ref").attr("x1", x(o.now)).attr("x2", x(o.now)).attr("y1", 0).attr("y2", ih);
  if (!qs.length) { g.append("text").attr("class", "axis-t").attr("x", iw / 2).attr("y", ih / 2).attr("dy", "0.35em").attr("text-anchor", "middle").text(o.empty || "none"); return; }
  const top = d3.max(qs, (q) => q.mag);
  const dots = g.selectAll("circle.q").data(qs.slice().sort((a, b) => a.mag - b.mag)).join("circle").attr("class", "q civ-pt").classed("civ-big", (q) => q.mag === top)
    .attr("cx", (q) => x(q[key])).attr("cy", (q) => y(q.mag)).attr("r", (q) => r(q.mag));
  if (!mini) { const q = qs.find((d) => d.mag === top); const px = x(q[key]); g.append("text").attr("class", "axis-t halo civ-strong").attr("x", px + (px > iw - 60 ? -r(q.mag) - 4 : r(q.mag) + 4)).attr("y", y(q.mag)).attr("dy", "0.35em").attr("text-anchor", px > iw - 60 ? "end" : "start").text(`M${q.mag.toFixed(1)}`); }
  onTip(dots, host, (t, q) => tt(host, t, `M${q.mag.toFixed(1)}${q.km != null ? ` · ${Math.round(q.km)} km away` : ""}`, [["--s1", q.place || "", ""], [null, d3.timeFormat("%a %b %-d, %-I:%M %p")(q.t), ""], q.tsu ? [null, "tsunami flag set", "USGS"] : null]));
}

/** a season window as a bar: 80% range (wash), median dot, the date as a tick. s: { lo, hi, p10, p90, mid, now } (Dates) */
export function seasonBar(host, s) {
  const { H } = size(host), lab = H >= 26;
  const { svg, g, iw, ih } = box(host, { l: 3, r: 3, t: 2, b: lab ? 12 : 2 });
  const x = d3.scaleTime([s.lo, s.hi], [0, iw]).clamp(true), bh = Math.min(10, ih * 0.6), yy = (ih - bh) / 2;
  g.append("rect").attr("class", "civ-trackbar").attr("y", yy).attr("width", iw).attr("height", bh).attr("rx", bh / 2);
  g.append("rect").attr("class", "civ-band").attr("x", x(s.p10)).attr("width", Math.max(3, x(s.p90) - x(s.p10))).attr("y", yy).attr("height", bh).attr("rx", bh / 2);
  g.append("circle").attr("class", "civ-dot").attr("cx", x(s.mid)).attr("cy", yy + bh / 2).attr("r", Math.max(3.5, bh / 2));
  g.append("line").attr("class", "civ-ref civ-now").attr("x1", x(s.now)).attr("x2", x(s.now)).attr("y1", yy - 3).attr("y2", yy + bh + 3);
  if (lab) for (const d of x.ticks(d3.timeMonth.every(1))) g.append("text").attr("class", "axis-t").attr("x", x(d)).attr("y", ih + 10).attr("text-anchor", "middle").text(d3.timeFormat("%b")(d));
  onTip(svg, host, (t) => tt(host, t, s.title || "Season", [["--s1", d3.timeFormat("%b %-d")(s.mid), "median peak"], [null, `${d3.timeFormat("%b %-d")(s.p10)} – ${d3.timeFormat("%b %-d")(s.p90)}`, "80% range"]]));
}

// ------------------------------------------------------------------ columns
/** columns on a time axis, each with its own token colour (e.g. an hourly index coloured by risk band). pts: [{ x, v, c, note }] */
export function timeCols(host, pts, o = {}) {
  const { H } = size(host), mini = H < 90;
  const { svg, g, iw, ih } = box(host, mini ? { l: 2, r: 2, t: 4, b: 2 } : { l: 34, r: 12, t: 10, b: 22 });
  const step = pts.length > 1 ? +pts[1].x - +pts[0].x : 36e5;
  const x = d3.scaleTime([pts[0].x, new Date(+pts.at(-1).x + step)], [0, iw]);
  const y = d3.scaleLinear([0, Math.max(o.min || 1, d3.max(pts, (p) => p.v) || 1)], [ih, 0]).nice(mini ? 2 : 4);
  if (!mini) {
    g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(4)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
    g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4).tickFormat(o.yFmt || null).tickSize(0).tickPadding(6)).call((s) => s.select(".domain").remove());
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(iw / 95))).tickFormat(o.xFmt || d3.timeFormat("%a %-I %p")).tickSize(0).tickPadding(6)).call((s) => s.select(".domain").remove());
  }
  const cw = Math.max(1, Math.min(24, iw / pts.length - (iw / pts.length > 4 ? 2 : 0.5)));
  for (const h of o.hlines || []) g.append("line").attr("class", "civ-ref").attr("x1", 0).attr("x2", iw).attr("y1", y(h)).attr("y2", y(h));
  const c = g.selectAll("rect.c").data(pts).join("rect").attr("class", "c").attr("x", (p) => x(p.x) + (x(new Date(+p.x + step)) - x(p.x) - cw) / 2).attr("width", cw)
    .attr("y", (p) => y(p.v)).attr("height", (p) => Math.max(p.v > 0 ? 1 : 0, ih - y(p.v))).attr("rx", Math.min(2, cw / 2)).style("fill", (p) => col(p.c || "s1"))
    .style("opacity", (p) => (o.now && +p.x > +o.now ? 0.55 : 1));
  if (!mini) g.selectAll("text.cl").data(pts.filter((p) => p.label)).join("text").attr("class", "axis-t civ-strong").attr("x", (p) => x(p.x) + (x(new Date(+p.x + step)) - x(p.x)) / 2).attr("y", (p) => y(p.v) - 4).attr("text-anchor", "middle").text((p) => p.label);
  if (o.now) g.append("line").attr("class", "civ-ref civ-now").attr("x1", x(o.now)).attr("x2", x(o.now)).attr("y1", 0).attr("y2", ih);
  if (o.now && !mini) g.append("text").attr("class", "axis-t halo").attr("x", x(o.now) + 4).attr("y", 9).text("now");
  onTip(c, host, (t, p) => tt(host, t, (o.tipX || fHour)(p.x), [[col(p.c || "s1"), o.fmt ? o.fmt(p.v) : `${p.v}`, p.note || o.unit || ""]]));
}

/** columns that grow up or down from zero, two hues (e.g. a warmer / colder tilt). rows: [{ label, v }] */
export function divCols(host, rows, o = {}) {
  const { H } = size(host), mini = H < 90, lab = H >= 30;
  const { svg, g, iw, ih } = box(host, mini ? { l: 2, r: 2, t: 3, b: lab ? 12 : 3 } : { l: 40, r: 12, t: 10, b: 22 });
  const mx = o.max || d3.max(rows, (r) => Math.abs(r.v)) || 1, y = d3.scaleLinear([-mx, mx], [ih, 0]), x = d3.scaleBand(rows.map((_, k) => k), [0, iw]).padding(0.3);
  if (!mini) {
    g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(4)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
    g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4).tickFormat(o.fmt || null).tickSize(0).tickPadding(6)).call((s) => s.select(".domain").remove());
  }
  g.append("line").attr("class", "civ-zero").attr("x1", 0).attr("x2", iw).attr("y1", y(0)).attr("y2", y(0));
  const pos = o.mock ? hatch(svg, "var(--s2)") : "var(--s2)", neg = o.mock ? hatch(svg, "var(--s1)") : "var(--s1)", bw = Math.min(24, x.bandwidth());
  const b = g.selectAll("path.c").data(rows).join("path").attr("class", "c").style("fill", (r) => (r.v >= 0 ? pos : neg))
    .attr("d", (r, k) => { const x0 = x(k) + (x.bandwidth() - bw) / 2, y0 = y(0), y1 = y(r.v), h = Math.abs(y1 - y0), rr = Math.min(3, h, bw / 2), up = r.v >= 0;
      if (h < 0.5) return `M${x0},${y0 - 0.5}h${bw}v1h${-bw}Z`;
      return up ? `M${x0},${y0}V${y1 + rr}Q${x0},${y1} ${x0 + rr},${y1}H${x0 + bw - rr}Q${x0 + bw},${y1} ${x0 + bw},${y1 + rr}V${y0}Z`
        : `M${x0},${y0}V${y1 - rr}Q${x0},${y1} ${x0 + rr},${y1}H${x0 + bw - rr}Q${x0 + bw},${y1} ${x0 + bw},${y1 - rr}V${y0}Z`; });
  if (lab && rows.every((r) => r.label.length * 5.4 <= x.step())) g.selectAll("text.xl").data(rows).join("text").attr("class", "axis-t").attr("x", (_, k) => x(k) + x.bandwidth() / 2).attr("y", ih + (mini ? 10 : 15)).attr("text-anchor", "middle").text((r) => r.label);
  onTip(b, host, (t, r) => tt(host, t, r.title || r.label, [[r.v >= 0 ? "--s2" : "--s1", o.fmt ? o.fmt(r.v) : `${r.v}`, o.unit || ""]]));
  if (o.mock && o.chip) mockChip(host);
}

/** horizontal stacked bars with a legend (2px surface gaps between parts). rows: [{ label, vals }], keys: [{ name, c }]
 *  o: { norm (shares of 100), mock, fmt } */
export function stackBars(host, rows, keys, o = {}) {
  const { W } = size(host), left = Math.round(Math.min(130, W * 0.28));
  const { svg, g, iw, ih } = box(host, { l: left, r: 12, t: 24, b: 4 });
  const fills = keys.map((k) => (o.mock ? hatch(svg, col(k.c)) : col(k.c)));
  const tot = (r) => d3.sum(r.vals), mx = o.norm ? 100 : Math.max(o.max || 1, d3.max(rows, tot) || 1), x = d3.scaleLinear([0, mx], [0, iw]);
  const yb = d3.scaleBand(rows.map((_, k) => k), [0, ih]).padding(0.32), bh = Math.min(22, yb.bandwidth());
  let lx = -left; const lg = svg.append("g").attr("transform", "translate(0,0)");
  for (const [k, key] of keys.entries()) {
    const it = lg.append("g").attr("transform", `translate(${left + lx + (k ? 0 : 0)},8)`);
    it.append("rect").attr("width", 9).attr("height", 9).attr("rx", 2).style("fill", fills[k]);
    const tx = it.append("text").attr("class", "axis-t").attr("x", 13).attr("y", 8).text(key.name);
    lx += 13 + (tx.node().getComputedTextLength?.() || key.name.length * 6) + 14;
  }
  const r_ = g.selectAll("g.r").data(rows).join("g").attr("class", "r").attr("transform", (_, k) => `translate(0,${yb(k) + (yb.bandwidth() - bh) / 2})`);
  r_.append("text").attr("class", "axis-t lbl").attr("x", -10).attr("y", bh / 2).attr("dy", "0.35em").attr("text-anchor", "end").text((r) => r.label);
  r_.each(function (r) {
    let acc = 0; const s = d3.select(this);
    r.vals.forEach((v, k) => {
      const x0 = x(acc), x1 = x(acc + v); acc += v; if (x1 - x0 < 0.5) return;
      const seg = s.append("rect").attr("class", "c").attr("x", x0 + (x0 > 0 ? 1 : 0)).attr("width", Math.max(0.5, x1 - x0 - (x0 > 0 ? 1 : 0) - (acc < (o.norm ? 100 : tot(r)) ? 1 : 0))).attr("height", bh).attr("rx", 3).style("fill", fills[k]);
      onTip(seg, host, (t) => tt(host, t, r.label, [[col(keys[k].c), o.fmt ? o.fmt(v) : `${v}`, keys[k].name]]));
      if (x1 - x0 >= 30 && bh >= 14) s.append("text").attr("class", "axis-t halo civ-strong").attr("x", (x0 + x1) / 2).attr("y", bh / 2).attr("dy", "0.35em").attr("text-anchor", "middle").style("pointer-events", "none").text(o.fmt ? o.fmt(v) : v);
    });
  });
  if (o.mock && o.chip) mockChip(host);
}
