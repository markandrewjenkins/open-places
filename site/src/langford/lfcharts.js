// Langford chart helpers (d3), on top of ../shared/charts.js frame(): every chart fills its .chart box.
//   monthCols(target, rows, opt)    monthly columns + optional average line + forecast band; rows = [{ m, v, avg?, fc?, lo?, hi?, seas? }]
//   stackCols(target, rows, keys, opt)   stacked columns (years); rows = [{ x, label, partial?, [key]: v }]
//   lines(target, series, opt)      several lines over a shared x (numbers or Dates); series = [{ key, label, color, pts: [[x, y]], dash? }]
//   ranges(target, rows, opt)       horizontal p25–p75 bars with a median tick; rows = [{ label, p25, median, p75, key, n }]
//   dumbbell(target, rows, opt)     before → after per row; rows = [{ label, a, b, key }]
import * as d3 from "d3";
import { cssVar, el, tipRow, tooltip } from "../shared/ui.js";
import { frame, gridY, colPath, axisClean, barPath } from "../shared/charts.js";

const tip = tooltip();
const col = (c) => (c.startsWith("--") ? `var(${c})` : c);
const ccol = (c) => (c.startsWith("--") ? cssVar(c) : c);
const fm = d3.timeFormat("%b %Y");

export function monthCols(target, rows, opt = {}) {
  const m = { l: opt.left ?? 44, r: 10, t: 12, b: 22 };
  const { svg, g, iw, ih } = frame(target, m, 220);
  const x = d3.scaleBand(rows.map((r) => r.m), [0, iw]).paddingInner(rows.length > 60 ? 0.18 : 0.25);
  const ymax = d3.max(rows, (r) => Math.max(r.v ?? 0, r.hi ?? 0, r.avg ?? 0, r.fc ?? 0, r.seas ?? 0)) || 1;
  const y = d3.scaleLinear([0, ymax], [ih, 0]).nice();
  gridY(g, y, iw, ih, opt.yfmt || d3.format("~s"));
  const years = rows.filter((r) => r.m.endsWith("-01")).map((r) => r.m);
  const every = iw / Math.max(1, years.length) < 34 ? 2 : 1;
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`)
    .call(d3.axisBottom(x).tickValues(years.filter((_, i) => i % every === 0)).tickFormat((s) => s.slice(0, 4)).tickSize(0).tickPadding(6)).call(axisClean);
  // forecast band
  const fc = rows.filter((r) => r.lo != null);
  if (fc.length) {
    const cx = (r) => x(r.m) + x.bandwidth() / 2;
    g.append("rect").attr("class", "lf-fc-zone").attr("x", x(fc[0].m) - 2).attr("width", x(fc.at(-1).m) + x.bandwidth() - x(fc[0].m) + 4).attr("y", 0).attr("height", ih);
    g.append("path").datum(fc).attr("d", d3.area().x(cx).y0((r) => y(r.lo)).y1((r) => y(r.hi)).curve(d3.curveStepAfter))
      .style("fill", col(opt.color || "--tc")).style("opacity", 0.18);
    g.append("text").attr("class", "axis-t").attr("x", x(fc[0].m) + 4).attr("y", 10).text(opt.fcLabel || "Forecast");
  }
  const bw = x.bandwidth();
  const sel = opt.selected;
  g.selectAll("path.b").data(rows.filter((r) => r.v != null)).join("path").attr("class", "b")
    .attr("d", (r) => colPath(x(r.m), bw, y(r.v), ih, Math.min(2, bw / 3)))
    .style("fill", (r) => col(r.color || opt.color || "--tc"))
    .style("opacity", (r) => (sel ? (r.m === sel ? 1 : 0.45) : r.dim ? 0.5 : 0.9));
  // suppressed months: a small "x" on the axis
  g.selectAll("text.sup").data(rows.filter((r) => r.v == null && r.lo == null && !r.future)).join("text").attr("class", "axis-t sup")
    .attr("x", (r) => x(r.m) + bw / 2).attr("y", ih - 3).attr("text-anchor", "middle").text("x");
  const line = (key, cls, dash) => {
    const pts = rows.filter((r) => r[key] != null);
    if (!pts.length) return;
    g.append("path").datum(pts).attr("class", cls).attr("d", d3.line().x((r) => x(r.m) + bw / 2).y((r) => y(r[key])).curve(d3.curveMonotoneX))
      .style("fill", "none").style("stroke", "var(--ink)").style("stroke-width", key === "fc" ? 2.2 : 1.6).style("stroke-dasharray", dash || null);
  };
  line("avg", "avg");
  line("seas", "seas", "2 3");
  line("fc", "fc", "6 3");
  // hit areas + tooltips + pick
  g.selectAll("rect.hit").data(rows).join("rect").attr("class", "hit").attr("x", (r) => x(r.m)).attr("width", bw).attr("y", 0).attr("height", ih)
    .style("fill", "transparent").style("cursor", (r) => (opt.pick && r.v !== undefined && !r.future ? "pointer" : null))
    .on("click", (e, r) => { if (opt.pick && !r.future) { tip.hide(); opt.pick(r.m); } })
    .on("pointermove", (e, r) => tip.show(e.clientX, e.clientY, (t) => {
      t.append(el("div", { class: "t-title" }, fm(new Date(`${r.m}-15T12:00`))));
      if (r.v != null) t.append(tipRow(ccol(opt.color || "--tc"), (opt.fmt || d3.format(",.0f"))(r.v), opt.unit || ""));
      else if (!r.future) t.append(el("div", {}, "Suppressed by BC Stats (x)"));
      if (r.avg != null) t.append(tipRow(cssVar("--ink"), (opt.fmt || d3.format(",.0f"))(r.avg), "12-month average"));
      if (r.fc != null) t.append(tipRow(cssVar("--ink"), (opt.fmt || d3.format(",.0f"))(r.fc), "forecast (12-month mean)"));
      if (r.lo != null) t.append(tipRow(null, `${(opt.fmt || d3.format(",.0f"))(r.lo)}–${(opt.fmt || d3.format(",.0f"))(r.hi)}`, "80% range"));
      if (r.seas != null) t.append(tipRow(null, (opt.fmt || d3.format(",.0f"))(r.seas), "seasonal variant"));
    }))
    .on("pointerleave", () => tip.hide());
}

export function stackCols(target, rows, keys, opt = {}) {
  const m = { l: opt.left ?? 44, r: 8, t: 10, b: 22 };
  const { g, iw, ih } = frame(target, m, 220);
  const x = d3.scaleBand(rows.map((r) => r.x), [0, iw]).padding(0.25);
  const tot = (r) => d3.sum(keys, (k) => r[k.key] || 0);
  const y = d3.scaleLinear([0, d3.max(rows, tot) || 1], [ih, 0]).nice();
  gridY(g, y, iw, ih, opt.yfmt || d3.format("~s"));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickFormat((v) => rows.find((r) => r.x === v)?.label ?? v).tickSize(0).tickPadding(6)).call(axisClean);
  const bw = Math.min(46, x.bandwidth());
  const gg = g.selectAll("g.c").data(rows).join("g").attr("class", "c").attr("transform", (r) => `translate(${x(r.x) + (x.bandwidth() - bw) / 2},0)`);
  gg.each(function (r) {
    let acc = 0;
    const s = d3.select(this);
    const top = keys.map((k) => r[k.key] || 0).findLastIndex((v) => v > 0);
    keys.forEach((k, i) => {
      const v = r[k.key] || 0;
      if (!v) return;
      const y0 = y(acc + v), y1 = y(acc);
      if (i === top) s.append("path").attr("d", colPath(0, bw, y0, y1, 3)).style("fill", col(k.color)).style("opacity", r.partial ? 0.55 : 1);
      else s.append("rect").attr("x", 0).attr("width", bw).attr("y", y0).attr("height", y1 - y0).style("fill", col(k.color)).style("opacity", r.partial ? 0.55 : 1);
      acc += v;
    });
    if (opt.total !== false) s.append("text").attr("class", "label strong").attr("x", bw / 2).attr("y", y(acc) - 4).attr("text-anchor", "middle").style("font-size", "10.5px")
      .text((opt.fmt || d3.format(",.0f"))(acc) + (r.partial ? "*" : ""));
  });
  gg.append("rect").attr("x", -4).attr("width", bw + 8).attr("y", 0).attr("height", ih).style("fill", "transparent").style("cursor", opt.pick ? "pointer" : null)
    .on("click", (e, r) => { if (opt.pick) { tip.hide(); opt.pick(r.x); } })
    .on("pointermove", (e, r) => tip.show(e.clientX, e.clientY, (t) => {
      t.append(el("div", { class: "t-title" }, `${r.label ?? r.x}${r.partial ? " (year to date)" : ""}`));
      for (const k of [...keys].reverse()) if (r[k.key] != null) t.append(tipRow(ccol(k.color), (opt.fmt || d3.format(",.0f"))(r[k.key]), k.label));
      if (r.note) t.append(el("div", { class: "t-note" }, r.note));
    }))
    .on("pointerleave", () => tip.hide());
}

export function lines(target, series, opt = {}) {
  const m = { l: opt.left ?? 44, r: opt.right ?? 70, t: 10, b: 22 };
  const { svg, g, iw, ih } = frame(target, m, 220);
  const all = series.flatMap((s) => s.pts);
  const isDate = all[0]?.[0] instanceof Date;
  const x = (isDate ? d3.scaleTime() : d3.scaleLinear()).domain(opt.xdomain || d3.extent(all, (p) => p[0])).range([0, iw]);
  const ext = d3.extent(all, (p) => p[1]);
  const y = d3.scaleLinear(opt.ydomain || [Math.min(0, ext[0]), ext[1]], [ih, 0]).nice();
  gridY(g, y, iw, ih, opt.yfmt || d3.format("~s"));
  const xa = d3.axisBottom(x).ticks(Math.max(3, Math.floor(iw / 80))).tickSize(0).tickPadding(6);
  if (!isDate) xa.tickFormat(d3.format("d"));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(xa).call(axisClean);
  if (opt.marker != null) {
    g.append("line").attr("x1", x(opt.marker)).attr("x2", x(opt.marker)).attr("y1", 0).attr("y2", ih).style("stroke", "var(--axis)").style("stroke-dasharray", "3 3");
    if (opt.markerLabel) g.append("text").attr("class", "axis-t").attr("x", x(opt.marker) + 4).attr("y", 9).text(opt.markerLabel);
  }
  const lab = [];
  for (const s of series) {
    const pts = s.pts.filter((p) => p[1] != null);
    if (!pts.length) continue;
    g.append("path").datum(pts).attr("d", d3.line().x((p) => x(p[0])).y((p) => y(p[1])).defined((p) => p[1] != null))
      .style("fill", "none").style("stroke", col(s.color)).style("stroke-width", s.width || (s.hl ? 2.6 : 1.6)).style("stroke-dasharray", s.dash || null).style("opacity", s.faint ? 0.55 : 1);
    if (s.dots) g.selectAll(null).data(pts).join("circle").attr("cx", (p) => x(p[0])).attr("cy", (p) => y(p[1])).attr("r", 2.6).style("fill", col(s.color));
    if (s.label && !s.nolabel) lab.push({ y: y(pts.at(-1)[1]), x: x(pts.at(-1)[0]), s });
  }
  // end labels, nudged apart
  lab.sort((a, b) => a.y - b.y);
  for (let i = 1; i < lab.length; i++) if (lab[i].y - lab[i - 1].y < 12) lab[i].y = lab[i - 1].y + 12;
  for (const l of lab) g.append("text").attr("class", "label halo").attr("x", l.x + 5).attr("y", l.y).attr("dy", "0.35em")
    .style("font-size", "10.5px").style("fill", col(l.s.color)).style("font-weight", l.s.hl ? 650 : null).text(l.s.label);
  const bis = d3.bisector((p) => p[0]);
  svg.on("pointermove", (e) => {
    const [px] = d3.pointer(e, g.node());
    const xv = x.invert(px);
    tip.show(e.clientX, e.clientY, (t) => {
      let head = null;
      for (const s of series) {
        const i = bis.center(s.pts, xv); const p = s.pts[i];
        if (!p || p[1] == null) continue;
        if (!head) { head = isDate ? fm(p[0]) : (opt.xfmt ? opt.xfmt(p[0]) : String(p[0])); t.append(el("div", { class: "t-title" }, head)); }
        t.append(tipRow(ccol(s.color), (opt.fmt || d3.format(",.0f"))(p[1]), s.label || ""));
      }
    });
  }).on("pointerleave", () => tip.hide());
  return { x, y, g, iw, ih };
}

export function ranges(target, rows, opt = {}) {
  const left = opt.left ?? 170;
  const m = { l: left, r: 50, t: 4, b: 22 };
  const { g, iw, ih } = frame(target, m, rows.length * 34 + 30);
  const x = d3.scaleLinear([0, opt.max || d3.max(rows, (r) => r.p75 ?? r.median ?? 0) * 1.05 || 1], [0, iw]).nice();
  g.append("g").attr("class", "grid").selectAll("line").data(x.ticks(5)).join("line").attr("x1", x).attr("x2", x).attr("y1", 0).attr("y2", ih);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(5).tickFormat(opt.xfmt || null).tickSize(0).tickPadding(6)).call(axisClean);
  const rh = Math.min(42, ih / rows.length);
  const r_ = g.selectAll("g.r").data(rows).join("g").attr("class", (r) => `brow${opt.pick ? " pick" : ""}${opt.selected != null ? (r.key === opt.selected ? " on" : " off") : ""}`)
    .attr("transform", (_, i) => `translate(0,${i * rh})`);
  r_.append("rect").attr("class", "hit").attr("x", -left).attr("width", left + iw + m.r).attr("height", rh).style("fill", "transparent");
  r_.append("text").attr("class", "label").attr("x", -10).attr("y", rh / 2).attr("dy", "0.35em").attr("text-anchor", "end").text((r) => r.label);
  r_.filter((r) => r.p25 != null).append("path").attr("d", (r) => `M${x(r.p25)},${rh / 2 - 6}h${Math.max(2, x(r.p75 ?? r.p25 * 2) - x(r.p25))}v12h${-Math.max(2, x(r.p75 ?? r.p25 * 2) - x(r.p25))}Z`)
    .style("fill", (r) => col(r.color || opt.color || "--tc")).style("opacity", (r) => (r.p75 == null ? 0.25 : 0.35));
  r_.filter((r) => r.median != null).append("line").attr("x1", (r) => x(r.median)).attr("x2", (r) => x(r.median)).attr("y1", rh / 2 - 9).attr("y2", rh / 2 + 9)
    .style("stroke", (r) => col(r.color || opt.color || "--tc")).style("stroke-width", 3);
  r_.append("text").attr("class", "label strong").attr("x", (r) => x(r.p75 ?? r.median ?? r.p25 ?? 0) + 6).attr("y", rh / 2).attr("dy", "0.35em").style("font-size", "11px")
    .text((r) => (r.median != null ? `${d3.format(",.0f")(r.median)} d` : "not yet"));
  if (opt.pick) r_.on("click", (e, r) => opt.pick(r.key));
  r_.on("pointermove", (e, r) => tip.show(e.clientX, e.clientY, (t) => {
    t.append(el("div", { class: "t-title" }, r.label));
    t.append(tipRow(null, r.median != null ? `${d3.format(",.0f")(r.median)} days` : "not reached", "median (Kaplan–Meier)"));
    if (r.p25 != null) t.append(tipRow(null, `${r.p25 ?? "–"}–${r.p75 ?? "…"} days`, "middle half"));
    if (r.n != null) t.append(tipRow(null, `${r.n}`, `files${r.censored ? `, ${r.censored} still waiting` : ""}`));
  })).on("pointerleave", () => tip.hide());
}

export function dumbbell(target, rows, opt = {}) {
  const left = opt.left ?? 150;
  const m = { l: left, r: 46, t: 16, b: 4 };
  const { g, iw, ih } = frame(target, m, rows.length * 24 + 20);
  const x = d3.scaleLinear([0, 1], [0, iw]);
  const rh = Math.min(30, ih / rows.length);
  if (opt.legend !== false) {
    g.append("text").attr("class", "axis-t").attr("x", 0).attr("y", -5).text(opt.aLabel || "before");
    g.append("text").attr("class", "axis-t").attr("x", iw).attr("y", -5).attr("text-anchor", "end").text(opt.bLabel || "after");
  }
  const r_ = g.selectAll("g.r").data(rows).join("g").attr("class", (r) => `brow${opt.pick ? " pick" : ""}${opt.selected ? (r.key === opt.selected ? " on" : " off") : ""}`)
    .attr("transform", (_, i) => `translate(0,${i * rh})`);
  r_.append("rect").attr("class", "hit").attr("x", -left).attr("width", left + iw + m.r).attr("height", rh).style("fill", "transparent");
  r_.append("text").attr("class", "label").attr("x", -8).attr("y", rh / 2).attr("dy", "0.35em").attr("text-anchor", "end").style("font-size", rh < 20 ? "11px" : null)
    .text((r) => (r.label.length > left / 6.4 ? r.label.slice(0, Math.floor(left / 6.4) - 1) + "…" : r.label)).append("title").text((r) => r.label);
  r_.append("line").attr("x1", (r) => x(r.a)).attr("x2", (r) => x(r.b)).attr("y1", rh / 2).attr("y2", rh / 2).style("stroke", "var(--axis)").style("stroke-width", 3);
  r_.append("circle").attr("cx", (r) => x(r.a)).attr("cy", rh / 2).attr("r", 4.5).style("fill", col(opt.aColor || "--g-green"));
  r_.append("circle").attr("cx", (r) => x(r.b)).attr("cy", rh / 2).attr("r", 4.5).style("fill", col(opt.bColor || "--tc"));
  r_.append("text").attr("class", "label strong").attr("x", (r) => x(Math.max(r.a, r.b)) + 8).attr("y", rh / 2).attr("dy", "0.35em").style("font-size", "10.5px")
    .text((r) => `${Math.round(r.a * 100)}→${Math.round(r.b * 100)}%`);
  if (opt.pick) r_.on("click", (e, r) => { e.stopPropagation(); opt.pick(r.key); }).attr("data-pick", "");
  r_.on("pointermove", (e, r) => tip.show(e.clientX, e.clientY, (t) => {
    t.append(el("div", { class: "t-title" }, r.label));
    t.append(tipRow(ccol(opt.aColor || "--g-green"), `${Math.round(r.a * 100)}%`, `${opt.aLabel || "before"} vegetation`));
    t.append(tipRow(ccol(opt.bColor || "--tc"), `${Math.round(r.b * 100)}%`, `${opt.bLabel || "after"} vegetation`));
  })).on("pointerleave", () => tip.hide());
}

export { barPath };
