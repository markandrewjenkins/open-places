// Console mockups (review only): fit the 1280×780 design screen to the page, switch states, and draw
// simple SVG charts shaped like the real dashboards' charts. No dependencies.

const NS = "http://www.w3.org/2000/svg";
export const fmt = new Intl.NumberFormat("en-CA");
export const f0 = (v) => fmt.format(Math.round(v));

// ------------------------------------------------------------------ stage: scale-to-fit + states
// states: { key: { view, rail: [topic, sub?], drawer?: true, render?: fn } }
export function stage(states, first) {
  const screen = document.querySelector(".mk-screen"), holder = screen.parentElement;
  const fit = () => { const k = Math.min(1, holder.clientWidth / 1280); screen.style.transform = `scale(${k})`; holder.style.height = `${Math.round(780 * k)}px`; };
  new ResizeObserver(fit).observe(holder); fit();
  function show(key) {
    const st = states[key]; if (!st) return;
    for (const v of screen.querySelectorAll(".mk-view")) v.hidden = v.id !== st.view;
    const main = screen.querySelector(".mk-main"), dr = screen.querySelector(".mk-drawer");
    main.classList.toggle("drawer", !!st.drawer); if (dr) dr.hidden = !st.drawer;
    for (const g of screen.querySelectorAll(".mk-rail .g")) g.classList.toggle("on", g.dataset.t === st.rail[0]);
    for (const li of screen.querySelectorAll(".mk-rail li")) li.classList.toggle("on", li.dataset.s === `${st.rail[0]}/${st.rail[1]}`);
    for (const b of document.querySelectorAll(".mk-toggle [data-go]")) b.setAttribute("aria-pressed", String(b.dataset.go === key));
    requestAnimationFrame(() => st.render?.()); // redraw every time: states can share a view (e.g. topic vs topic + drawer)
    history.replaceState(null, "", `#${key}`);
  }
  document.addEventListener("click", (e) => { const n = e.target.closest("[data-go]"); if (n && states[n.dataset.go]) { e.preventDefault(); show(n.dataset.go); } });
  window.addEventListener("hashchange", () => show(location.hash.slice(1)));
  const start = location.hash.slice(1);
  document.fonts?.ready.then(() => show(states[start] ? start : first)) ?? show(states[start] ? start : first);
}

// ------------------------------------------------------------------ tiny SVG kit
export function canvas(host) {
  const el = typeof host === "string" ? document.getElementById(host) : host;
  const w = el.offsetWidth, h = el.offsetHeight;
  el.replaceChildren();
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", `0 0 ${w} ${h}`);
  el.append(s);
  return { s, w, h };
}
export function add(p, tag, a = {}, text) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(a)) if (v != null) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  p.append(n); return n;
}
export const lin = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);
export function niceMax(v) { const e = 10 ** Math.floor(Math.log10(v || 1)), m = v / e; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * e; }
const kfmt = (v) => (Math.abs(v) >= 1000 ? `${+(v / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1)}k` : `${Math.round(v)}`);
const path = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
// monotone-ish smoothing (Catmull-Rom → Bézier)
const smooth = (pts) => {
  if (pts.length < 3) return path(pts);
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    d += `C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`;
  }
  return d;
};

function yAxis(g, y, x0, x1, ticks, fmtT = kfmt) {
  for (const t of ticks) {
    add(g, "line", { x1: x0, x2: x1, y1: y(t), y2: y(t), class: "gl" });
    add(g, "text", { x: x0 - 6, y: y(t) + 3.5, "text-anchor": "end", class: "ax" }, fmtT(t));
  }
}
const tickList = (lo, hi, n = 4) => { const st = niceMax((hi - lo) / n); const out = []; for (let v = Math.ceil(lo / st) * st; v <= hi + 1e-9; v += st) out.push(+v.toFixed(6)); return out; };

// vertical columns. opt: { color: str | fn(i), labels, sub, top: fmt, min, max, hl, axis, gap, r }
export function cols(host, vals, opt = {}) {
  const { s, w, h } = canvas(host);
  const m = { l: opt.axis ? 34 : 2, r: 2, t: opt.top ? 16 : 4, b: (opt.labels ? 15 : 2) + (opt.sub ? 13 : 0) };
  const iw = w - m.l - m.r, ih = h - m.t - m.b, max = opt.max || niceMax(Math.max(...vals));
  const lo = opt.min ?? 0, y = lin(lo, max, m.t + ih, m.t), bw = iw / vals.length, gap = opt.gap ?? 0.28, cw = Math.min(opt.maxw || 60, bw * (1 - gap));
  if (opt.axis) yAxis(s, y, m.l, w - m.r, tickList(lo, max, 3));
  vals.forEach((v, i) => {
    const x = m.l + i * bw + (bw - cw) / 2, col = typeof opt.color === "function" ? opt.color(i, v) : opt.color || "var(--accent)";
    add(s, "rect", { x, y: y(Math.max(0, v)), width: cw, height: Math.max(1, Math.abs(y(0) - y(v))), rx: opt.r ?? Math.min(4, cw / 3), fill: col, opacity: opt.hl != null && opt.hl !== i ? 0.55 : 1 });
    if (opt.top) add(s, "text", { x: x + cw / 2, y: v < 0 ? y(v) + 12 : y(v) - 4, "text-anchor": "middle", class: "lb s", "font-size": 10.5 }, opt.top(v, i));
    if (opt.labels) add(s, "text", { x: x + cw / 2, y: h - (opt.sub ? 15 : 3), "text-anchor": "middle", class: "lb", "font-size": 10.5, "font-weight": opt.hl === i ? 650 : null }, opt.labels[i]);
    if (opt.sub) add(s, "text", { x: x + cw / 2, y: h - 2, "text-anchor": "middle", class: "ax" }, opt.sub[i]);
  });
  add(s, "line", { x1: m.l, x2: w - m.r, y1: y(0), y2: y(0), stroke: "var(--axis)" });
  return s;
}
// horizontal bars. rows: [label, value, color?]; opt: { fmt, left, max, hl }
export function hbars(host, rows, opt = {}) {
  const { s, w, h } = canvas(host);
  const left = opt.left ?? 120, right = 52, rh = Math.min(opt.rowMax || 30, h / rows.length), bh = Math.min(13, rh * 0.55);
  const max = opt.max || Math.max(...rows.map((r) => r[1]));
  const x = lin(0, max, 0, w - left - right);
  rows.forEach(([l, v, c], i) => {
    const yy = i * rh + rh / 2, dim = opt.hl != null && opt.hl !== i;
    add(s, "text", { x: left - 8, y: yy + 4, "text-anchor": "end", class: dim ? "lb" : opt.hl === i ? "lb s" : "lb", opacity: dim ? 0.7 : 1 }, l);
    add(s, "rect", { x: left, y: yy - bh / 2, width: Math.max(2, x(v)), height: bh, rx: Math.min(4, bh / 2), fill: c || opt.color || "var(--accent)", opacity: dim ? 0.4 : 1 });
    add(s, "text", { x: left + x(v) + 5, y: yy + 4, class: "lb s", "font-size": 11 }, (opt.fmt || f0)(v));
  });
  return s;
}
// lines/areas. series: [{ v, color, w, dash, area, band: [lo, hi], op }]; opt: { xl: [[i, label]], ymin, ymax, yfmt, marks: [{ i, v, label, anchor }], zero }
export function lines(host, series, opt = {}) {
  const { s, w, h } = canvas(host);
  const m = { l: opt.noAxis ? 4 : 38, r: opt.r ?? 8, t: opt.t ?? 10, b: opt.xl ? 18 : 4 };
  const all = series.flatMap((x) => [...x.v, ...(x.band ? [...x.band[0], ...x.band[1]] : [])]);
  const lo = opt.ymin ?? Math.min(0, ...all), hi = opt.ymax ?? niceMax(Math.max(...all));
  const n = Math.max(...series.map((x) => x.v.length));
  const x = lin(0, n - 1, m.l, w - m.r), y = lin(lo, hi, h - m.b, m.t);
  if (!opt.noAxis) yAxis(s, y, m.l, w - m.r, tickList(lo, hi, opt.ticks || 4), opt.yfmt);
  if (opt.zero && lo < 0) add(s, "line", { x1: m.l, x2: w - m.r, y1: y(0), y2: y(0), stroke: "var(--ink-2)", "stroke-dasharray": "3 3" });
  for (const sr of series) {
    const pts = sr.v.map((v, i) => [x(i), y(v)]);
    if (sr.band) add(s, "path", { d: `${path(sr.band[1].map((v, i) => [x(i), y(v)]))}L${path(sr.band[0].map((v, i) => [x(i), y(v)]).reverse()).slice(1)}Z`, fill: sr.color, opacity: 0.16 });
    if (sr.area) add(s, "path", { d: `${smooth(pts)}L${pts.at(-1)[0]},${y(Math.max(lo, 0))}L${pts[0][0]},${y(Math.max(lo, 0))}Z`, fill: sr.color, opacity: sr.area === true ? 0.16 : sr.area });
    add(s, "path", { d: smooth(pts), fill: "none", stroke: sr.color, "stroke-width": sr.w || 2, "stroke-dasharray": sr.dash, opacity: sr.op ?? 1 });
  }
  let lastX = -1e9;
  for (const [i, l] of opt.xl || []) { if (x(i) - lastX < 44) continue; lastX = x(i); add(s, "text", { x: x(i), y: h - 3, "text-anchor": "middle", class: "ax" }, l); }
  for (const mk of opt.marks || []) {
    add(s, "circle", { cx: x(mk.i), cy: y(mk.v), r: 3.5, fill: mk.color || "var(--ink)" });
    add(s, "text", { x: x(mk.i) + (mk.dx ?? 0), y: y(mk.v) + (mk.dy ?? -8), "text-anchor": mk.anchor || "middle", class: "lb s", "font-size": 11 }, mk.label);
  }
  return { s, x, y, w, h, m };
}
// horizontal ranges: rows [{ label, p10, p25, med, p75, p90, color, dots }]; opt: { d0, d1, ticks: [[v, label]], left, hl }
export function ranges(host, rows, opt = {}) {
  const { s, w, h } = canvas(host);
  const left = opt.left ?? 130, rh = Math.min(opt.rowMax || 40, (h - 18) / rows.length);
  const x = lin(opt.d0, opt.d1, left, w - 10);
  let lastT = -1e9; // skip tick labels that would collide at narrow widths
  for (const [v, l] of opt.ticks || []) { add(s, "line", { x1: x(v), x2: x(v), y1: 0, y2: rows.length * rh, class: "gl" }); if (x(v) - lastT < 44) continue; lastT = x(v); add(s, "text", { x: x(v), y: rows.length * rh + 13, "text-anchor": "middle", class: "ax" }, l); }
  if (opt.today != null) { add(s, "line", { x1: x(opt.today[0]), x2: x(opt.today[0]), y1: 0, y2: rows.length * rh, stroke: "var(--ink-2)", "stroke-dasharray": "3 3" }); }
  rows.forEach((r, i) => {
    const yy = i * rh + rh / 2, dim = opt.hl != null && opt.hl !== i;
    const g = add(s, "g", { opacity: dim ? 0.45 : 1 });
    add(g, "text", { x: left - 10, y: yy + 4, "text-anchor": "end", class: opt.hl === i ? "lb s" : "lb" }, r.label);
    add(g, "line", { x1: x(r.p10), x2: x(r.p90), y1: yy, y2: yy, stroke: r.color, "stroke-width": 3, "stroke-linecap": "round", opacity: 0.55 });
    add(g, "rect", { x: x(r.p25), y: yy - 7, width: Math.max(4, x(r.p75) - x(r.p25)), height: 14, rx: 7, fill: r.color, stroke: r.stroke || "none" });
    for (const q of r.dots || []) add(g, "circle", { cx: x(q), cy: yy, r: 1.6, fill: "var(--ink)", opacity: 0.35 });
    add(g, "circle", { cx: x(r.med), cy: yy, r: 5, fill: "var(--surface)", stroke: "var(--ink)", "stroke-width": 2 });
    if (r.tag) add(g, "text", { x: x(r.p90) + 8, y: yy + 4, class: "lb s", "font-size": 11 }, r.tag);
  });
  return s;
}
// scatter of lon/lat-like points into the box (equal-aspect, latitude-corrected)
export function dots(host, pts, colorOf, opt = {}) {
  const { s, w, h } = canvas(host);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), kx = opt.kx ?? 0.65;
  const sc = Math.min((w - 8) / ((x1 - x0) * kx), (h - 8 - (opt.pb || 0)) / (y1 - y0));
  const ox = (w - (x1 - x0) * kx * sc) / 2, oy = (h - (opt.pb || 0) - (y1 - y0) * sc) / 2;
  for (const p of pts) add(s, "circle", { cx: (ox + (p[0] - x0) * kx * sc).toFixed(1), cy: (oy + (y1 - p[1]) * sc).toFixed(1), r: opt.r || 1.5, fill: colorOf(p), opacity: opt.op ?? 0.85 });
  return { s, w, h, px: (p) => [ox + (p[0] - x0) * kx * sc, oy + (y1 - p[1]) * sc] };
}
export function spark(host, v, color, opt = {}) {
  const { s, w, h } = canvas(host);
  const max = Math.max(1, ...v), bw = w / v.length;
  v.forEach((x, i) => { if (x > 0 || opt.zero) add(s, "rect", { x: i * bw + 0.5, y: h - Math.max(1.5, (x / max) * h), width: Math.max(1, bw - 1), height: Math.max(1.5, (x / max) * h), rx: 1, fill: x ? color : "var(--grid)" }); });
  return s;
}
// fake spectrogram: horizontal frequency bands with a few call "strokes"
export function spectro(host, seed = 7, color = "var(--accent)") {
  const { s, w, h } = canvas(host);
  let r = seed; const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
  add(s, "rect", { x: 0, y: 0, width: w, height: h, rx: 8, fill: "color-mix(in oklab, var(--ink) 88%, var(--accent))" });
  const cols = 90, rows = 26, cw = w / cols, chh = h / rows;
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    const base = 0.08 + 0.18 * (j / rows) * rnd();
    if (rnd() < 0.55) add(s, "rect", { x: i * cw, y: j * chh, width: cw + 0.3, height: chh + 0.3, fill: "#9fe3d6", opacity: base.toFixed(2) });
  }
  for (const [x0, len, f0, f1] of [[0.12, 0.1, 0.62, 0.38], [0.3, 0.07, 0.55, 0.3], [0.48, 0.12, 0.66, 0.42], [0.7, 0.08, 0.5, 0.33]]) {
    const pts = []; for (let k = 0; k <= 10; k++) pts.push([w * (x0 + (len * k) / 10), h * (f0 + (f1 - f0) * Math.sin((Math.PI * k) / 10))]);
    add(s, "path", { d: smooth(pts), fill: "none", stroke: "#e9fff9", "stroke-width": 2.6, opacity: 0.9 });
    add(s, "path", { d: smooth(pts.map(([a, b]) => [a, b - h * 0.18])), fill: "none", stroke: "#e9fff9", "stroke-width": 1.4, opacity: 0.5 });
  }
  return s;
}
