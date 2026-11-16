// Live conditions: the buoys (last 14 days), the coastal wind stations and the tide predictions.
import {
  W, $, d3, el, tipRow, cssVar, tip, loadLive, wd, hr, hm, md, dayLong, f1, f0, compass, swell, ago, frame, gridY, axisClean,
  BBOX_ALL, clamp01,
} from "./common.js";
import { dStats, dChart, dNote, dHead } from "../shared/console.js";

const go = (...a) => W.ctx.go(...a);
const B = () => W.waves.buoys;
const ECCC_NOTE = "Data provided by Environment and Climate Change Canada. ECCC's station metadata reads \"All rights reserved\"; we are confirming this is covered by its open-data licence.";
const BUOY_EXTRA = {
  "46206": "Mean wave direction here runs about 23° clockwise of the wave model's, consistently. It may be a magnetic-vs-true reference difference in the buoy feed (unverified), so the Tofino direction factor uses a wide window.",
  "46087": "NOAA's realtime file also splits the sea into swell and wind waves (the .spec product), shown below.",
};
const series = (bid) => {
  const o = W.obs, t0 = new Date(o.t0);
  return { T: d3.range(o.hours).map((i) => new Date(+t0 + i * 36e5)), d: o.buoys[bid] };
};

export const live = {
  id: "live", title: "Live conditions", tileTitle: "Live buoys & tides", color: "var(--live)",
  eyebrow: "Buoys · wind · tides", heading: "Live Ocean Conditions",
  // Civic Atlas: the buoy network from Neah Bay to English Bay; more relevant when a big swell is running
  footprint: { bbox: BBOX_ALL, points: ["46087 Neah Bay", "46206 La Perouse Bank", "46146 Halibut Bank", "46304 English Bay"] }, kind: "only-here",
  relevance: () => clamp01(0.35 + (W.waves ? Math.min(0.5, ((B()["46087"].latest?.hs || 0) / 4) * 0.5) : 0)),
  load: loadLive,
  badge: () => { const l = B()["46087"].latest; return l ? [f1(l.hs, " m"), `Neah Bay now: ${swell(l.hs, l.tp, l.dir)}`] : "–"; },
  kpis: () => {
    const nb = B()["46087"].latest, lp = B()["46206"].latest, eb = B()["46304"].latest;
    const nt = nextTide("08615");
    return [
      ["Neah Bay 46087", nb ? swell(nb.hs, nb.tp, nb.dir) : "–", nb ? ago(nb.age_h) : ""],
      ["La Perouse 46206", lp ? swell(lp.hs, lp.tp, lp.dir) : "–", lp ? `${ago(lp.age_h)}${lp.stale ? " · stale" : ""}` : ""],
      ["English Bay 46304", eb ? `${f1(eb.hs, " m")} · ${f0(eb.wspd)} km/h` : "–", eb ? ago(eb.age_h) : ""],
      ["Tofino tide", nt ? `${nt[1] > 2 ? "High" : "Low"} ${hm(nt[0])}` : "–", nt ? `${f1(nt[1], " m")} next` : ""],
    ];
  },
  tile: (t) => {
    const nb = B()["46087"].latest, lp = B()["46206"].latest, nt = nextTide("07120");
    t.kpis([
      [nb ? f1(nb.hs, " m") : "–", nb ? `Neah Bay @ ${f0(nb.tp, " s")} ${compass(nb.dir)}` : "Neah Bay"],
      [lp ? f1(lp.hs, " m") : "–", lp ? `La Perouse${lp.stale ? `, ${ago(lp.age_h)}` : ""}` : "La Perouse"],
      [nt ? hm(nt[0]) : "–", nt ? `Victoria ${nt[1] > 1.8 ? "high" : "low"} tide, ${f1(nt[1], " m")}` : "next tide"],
    ]);
    if (nb) t.status(`${ago(nb.age_h)}`);
    const { T, d } = series("46087");
    lineSeries(t.vis, T.slice(-96), [{ v: d.hs.slice(-96), color: cssVar("--live"), name: "Hs" }, ...(d.swh ? [{ v: d.swh.slice(-96), color: cssVar("--surf"), name: "swell", dash: "3 2" }] : [])],
      { m: { l: 30, r: 8, t: 6, b: 18 }, unit: " m", compact: true });
  },
  subs: [
    { id: "buoys", title: "Buoys", class: "pane-lbuoys",
      view: (host, ctx, r) => renderBuoys(r.item), html: `<div class="ww-buoys" id="lv-buoys"></div>` },
    { id: "wind", title: "Coastal wind", short: "Wind", class: "pane-lwind",
      view: (host, ctx, r) => renderWind(r.item), html: `
      <p class="note cx-lede">Observed hourly wind (ECCC climate stations, 10 m masts; Neah Bay is the buoy's own 3.8 m anemometer). These are the observations the forecast backtest is scored against. ECCC publishes them about a day late.</p>
      <div class="ww-winds cx-grow" id="lv-wind"></div>` },
    { id: "tides", title: "Tides", class: "pane-ltides",
      view: (host, ctx, r) => renderTides(r.item), html: `
      <p class="note cx-lede">DFO / Canadian Hydrographic Service predictions for the next three days. Sheringham Point stands in for Jordan River and Port Renfrew for Sombrio. Not for navigation.</p>
      <div class="ww-tides cx-grow" id="lv-tides"></div>` },
  ],
  drawers: {
    buoys: (host, ctx, item) => buoyDrawer(item),
    wind: (host, ctx, item) => windDrawer(item),
    tides: (host, ctx, item) => tideDrawer(item),
  },
};

function nextTide(code) {
  const s = W.tides?.stations[code]; if (!s) return null;
  const now = Date.now();
  return s.hilo.map(([t, v]) => [new Date(t), v]).find(([t]) => +t > now) || null;
}

// generic hourly line series with optional dashed lines; tooltips per hour
function lineSeries(host, T, lines, opt = {}) {
  const m = opt.m || { l: 36, r: 10, t: 8, b: 20 };
  const { svg, g, iw, ih } = frame(host, m, 160);
  const x = d3.scaleTime(d3.extent(T), [0, iw]);
  const vals = lines.flatMap((l) => l.v).filter((v) => v != null);
  const y = d3.scaleLinear([opt.min ?? 0, opt.max ?? (d3.max(vals) || 1)], [ih, 0]).nice();
  gridY(g, y, iw, ih, (v) => `${v}${opt.unit || ""}`);
  const days = T.filter((t) => hr(t) === "12 am");
  g.append("g").selectAll("line").data(days).join("line").attr("x1", x).attr("x2", x).attr("y1", ih).attr("y2", ih + 4).style("stroke", "var(--axis)");
  g.append("g").selectAll("text").data(days.filter((t, i) => !opt.compact || i % 2 === 0)).join("text").attr("class", "axis-t").attr("x", (t) => x(t) + 3).attr("y", ih + 14)
    .text((t) => (iw / Math.max(1, days.length) > 60 ? `${wd(t)} ${md(t).split(" ")[1]}` : wd(t).slice(0, 2)));
  for (const l of lines) g.append("path").datum(T.map((t, i) => [t, l.v[i]]))
    .attr("d", d3.line().defined(([, v]) => v != null).x(([t]) => x(t)).y(([, v]) => y(v))).style("fill", "none").style("stroke", l.color).style("stroke-width", l.w || 1.7).style("stroke-dasharray", l.dash || null);
  if (opt.now) g.append("line").attr("x1", x(opt.now)).attr("x2", x(opt.now)).attr("y1", 0).attr("y2", ih).style("stroke", "var(--accent-2)").style("stroke-dasharray", "2 3");
  if (opt.marks) g.append("g").selectAll("text").data(opt.marks).join("text").attr("class", "label halo").attr("x", ([t]) => x(t)).attr("y", ([, v]) => y(v) + (v > (y.domain()[1] / 2) ? -6 : 13))
    .attr("text-anchor", "middle").style("font-size", "10px").text(([t, v]) => `${hm(t)} ${v.toFixed(1)}`);
  svg.on("pointermove", (e) => {
    const [px] = d3.pointer(e, g.node()); const i = d3.bisector((t) => t).center(T, x.invert(px));
    tip.show(e.clientX, e.clientY, (tt) => tt.append(el("div", { class: "t-title" }, `${wd(T[i])} ${hm(T[i])}`),
      ...lines.filter((l) => l.v[i] != null).map((l) => tipRow(l.color, `${(+l.v[i]).toFixed(opt.dp ?? 1)}${opt.unit || ""}`, l.name))));
  }).on("pointerleave", () => tip.hide());
}

// ------------------------------------------------------------------ buoys
function renderBuoys(sel) {
  $("lv-buoys").replaceChildren(...Object.entries(B()).map(([id, b]) => {
    const l = b.latest || {};
    const card = el("button", { type: "button", class: `card cx-fill ww-buoy${sel === id ? " sel" : ""}`, "data-pick": "", onclick: () => go("live", "buoys", id) },
      el("div", { class: "ww-buoy-h" }, el("b", {}, `${b.name}`), el("small", {}, `${id} · ${b.owner}`), el("span", { class: `ww-age${l.stale ? " stale" : ""}` }, l.time ? ago(l.age_h) : "no data")),
      el("div", { class: "ww-buoy-v" }, el("b", {}, f1(l.hs, " m")), el("span", {}, `${f0(l.tp, " s")} ${compass(l.dir)} · wind ${f0(l.wspd)} km/h ${compass(l.wdir)}`)),
      el("div", { class: "chart", id: `lv-b-${id}` }));
    return card;
  }));
  requestAnimationFrame(() => {
    for (const id of Object.keys(B())) {
      const { T, d } = series(id); if (!d || !document.getElementById(`lv-b-${id}`)) continue;
      lineSeries(`lv-b-${id}`, T, [{ v: d.hs, color: cssVar("--live"), name: "Hs" }, ...(d.swh ? [{ v: d.swh, color: cssVar("--surf"), name: "swell", dash: "3 2" }] : [])], { unit: " m", m: { l: 32, r: 8, t: 6, b: 18 } });
    }
  });
}
function buoyDrawer(id) {
  const b = B()[id];
  if (!b) return null;
  const l = b.latest || {}, { T, d } = series(id);
  const eccc = b.owner === "ECCC";
  return {
    kicker: `Live · buoy ${id}`, title: b.name,
    body: [
      dStats([[f1(l.hs, " m"), `wave height · ${ago(l.age_h)}${l.stale ? " (stale)" : ""}`], [`${f0(l.tp, " s")} / ${f0(l.tm, " s")}`, "peak / mean period"],
        [`${compass(l.dir)} ${f0(l.dir, "°")}`, "mean wave direction"], [`${f0(l.wspd)} km/h ${compass(l.wdir)}`, `wind, gusts ${f0(l.gust)}`]]),
      l.swh != null ? dStats([[swell(l.swh, l.swp, l.swd), "swell"], [`${f1(l.wwh, " m")} @ ${f0(l.wwp, " s")}`, "wind waves"]]) : null,
      dChart("dr-b-hs", d.swh ? "Wave height and swell, 14 days (m)" : "Wave height, 14 days (m)"),
      dChart("dr-b-tp", "Peak period, 14 days (s)"),
      dNote(b.note), BUOY_EXTRA[id] ? dNote(BUOY_EXTRA[id]) : null,
      dNote(eccc ? `${ECCC_NOTE} History online covers only ~30 days (MSC Datamart), so this dashboard keeps its own hourly archive from ${String(b.record_from).slice(0, 10)}.`
        : `NOAA National Data Buoy Center, public domain. Record here from ${String(b.record_from).slice(0, 4)}.`),
    ],
    after: () => {
      lineSeries("dr-b-hs", T, [{ v: d.hs, color: cssVar("--live"), name: "Hs" }, ...(d.swh ? [{ v: d.swh, color: cssVar("--surf"), name: "swell", dash: "3 2" }, { v: d.wwh, color: cssVar("--muted"), name: "wind waves", dash: "1 2" }] : [])], { unit: " m" });
      lineSeries("dr-b-tp", T, [{ v: d.tp, color: cssVar("--live"), name: "peak period" }, ...(d.swp ? [{ v: d.swp, color: cssVar("--surf"), name: "swell period", dash: "3 2" }] : [])], { unit: " s", dp: 0 });
    },
  };
}

// ------------------------------------------------------------------ wind
function renderWind(sel) {
  const st = W.waves.wind_stations, ids = Object.keys(st).filter((id) => W.obs.wind[id]);
  $("lv-wind").replaceChildren(...ids.map((id) => el("button", { type: "button", class: `card cx-fill ww-wcard${sel === id ? " sel" : ""}`, "data-pick": "", onclick: () => go("live", "wind", id) },
    el("div", { class: "ww-buoy-h" }, el("b", {}, st[id].name), el("small", {}, st[id].kind === "buoy" ? "buoy anemometer" : `ECCC ${id}`), el("span", { class: "ww-age" }, lastWind(id))),
    el("div", { class: "chart", id: `lv-w-${id}` }))));
  requestAnimationFrame(() => {
    const t0 = new Date(W.obs.t0), T = d3.range(W.obs.hours).map((i) => new Date(+t0 + i * 36e5));
    for (const id of ids) if (document.getElementById(`lv-w-${id}`)) lineSeries(`lv-w-${id}`, T, [{ v: W.obs.wind[id].wspd, color: cssVar("--calm"), name: "wind km/h" }], { m: { l: 30, r: 8, t: 6, b: 18 }, dp: 0 });
  });
}
function lastWind(id) {
  const w = W.obs.wind[id], t0 = new Date(W.obs.t0);
  for (let i = w.wspd.length - 1; i >= 0; i--) if (w.wspd[i] != null) return `${w.wspd[i]} km/h ${compass(w.wdir[i])} · ${ago((Date.now() - (+t0 + i * 36e5)) / 36e5)}`;
  return "no data";
}
function windDrawer(id) {
  const st = W.waves.wind_stations[id], w = W.obs.wind[id];
  if (!st || !w) return null;
  const t0 = new Date(W.obs.t0), T = d3.range(W.obs.hours).map((i) => new Date(+t0 + i * 36e5));
  const v = w.wspd.filter((x) => x != null);
  return {
    kicker: "Live · coastal wind", title: st.name,
    body: [
      dStats([[lastWind(id).split(" · ")[0], `latest · ${lastWind(id).split(" · ")[1] || ""}`], [`${d3.max(v) ?? "–"} km/h`, "strongest hour, 14 days"],
        [`${Math.round(d3.mean(v) ?? 0)} km/h`, "average"], [`${Math.round((100 * v.filter((x) => x <= 8).length) / Math.max(1, v.length))}%`, "hours at ≤ 8 km/h"]]),
      dChart("dr-w", "Wind speed, 14 days (km/h)"),
      dNote(st.note),
      st.kind === "eccc" ? dNote("Environment and Climate Change Canada hourly climate data (Open Government Licence – Canada).") : null,
    ],
    after: () => lineSeries("dr-w", T, [{ v: w.wspd, color: cssVar("--calm"), name: "wind km/h" }], { dp: 0 }),
  };
}

// ------------------------------------------------------------------ tides
function tideSeries(code, hoursAhead = 72) {
  const s = W.tides.stations[code], t0 = new Date(s.t0), now = Date.now();
  const all = s.level.map((v, i) => [new Date(+t0 + i * 36e5), v]);
  const from = all.findIndex(([t]) => +t >= now - 6 * 36e5);
  const win = all.slice(Math.max(0, from), Math.max(0, from) + hoursAhead + 6);
  const marks = s.hilo.map(([t, v]) => [new Date(t), v]).filter(([t]) => +t >= +win[0][0] && +t <= +win.at(-1)[0]);
  return { T: win.map((x) => x[0]), v: win.map((x) => x[1]), marks };
}
function renderTides(sel) {
  const S = W.tides.stations;
  $("lv-tides").replaceChildren(...Object.entries(S).map(([code, s]) => {
    const nt = nextTide(code);
    return el("button", { type: "button", class: `card cx-fill ww-tcard${sel === code ? " sel" : ""}`, "data-pick": "", onclick: () => go("live", "tides", code) },
      el("div", { class: "ww-buoy-h" }, el("b", {}, s.name), el("small", {}, code), el("span", { class: "ww-age" }, nt ? `next ${nt[1] > (d3.mean(s.level) || 1.5) ? "high" : "low"} ${hm(nt[0])} · ${f1(nt[1], " m")}` : "")),
      el("div", { class: "chart", id: `lv-t-${code}` }));
  }));
  requestAnimationFrame(() => {
    for (const code of Object.keys(S)) if (document.getElementById(`lv-t-${code}`)) {
      const { T, v, marks } = tideSeries(code);
      lineSeries(`lv-t-${code}`, T, [{ v, color: cssVar("--live"), name: "tide m", w: 2 }], { m: { l: 30, r: 8, t: 10, b: 18 }, unit: " m", dp: 2, now: new Date(), marks });
    }
  });
}
function tideDrawer(code) {
  const s = W.tides?.stations[code];
  if (!s) return null;
  const { T, v, marks } = tideSeries(code, 24 * 9);
  const byDay = d3.groups(s.hilo.map(([t, x]) => [new Date(t), x]).filter(([t]) => +t >= Date.now() - 6 * 36e5), ([t]) => dayLong(t));
  return {
    kicker: "Live · tide predictions", title: s.name,
    body: [
      dChart("dr-t", "Predicted level, next 9 days (m above chart datum)"),
      dHead("Highs and lows"),
      el("div", { class: "ww-hilo" }, ...byDay.map(([dname, rows]) => el("div", {}, el("b", {}, dname), el("span", {}, rows.map(([t, x]) => `${hm(t)} ${x.toFixed(1)} m`).join(" · "))))),
      dNote(`${s.note} Fisheries and Oceans Canada / Canadian Hydrographic Service, Open Government Licence – Canada. Not for navigation.`),
    ],
    after: () => lineSeries("dr-t", T, [{ v, color: cssVar("--live"), name: "tide m" }], { unit: " m", dp: 2, now: new Date(), compact: true, marks: marks.length < 14 ? marks : null }),
  };
}
