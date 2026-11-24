// Open Places: every module the console can show, written to the shared console's module contract
// (../src/shared/console.js) plus the fields the Open Places shell needs:
//   scale: "alerts" | "basic" | "muni" | "region" | "province" | "country" | "world"   (which step of the ladder)
//   at:    node ids it covers at that scale, or "*" for every node at that scale
//   reach: 1–3, how many people it helps (orders tiles within a step, before seasonal relevance)
//   season(m) → 0–1 relevance for a month float (1.0 = Jan 1); seasonal modules out of season drop a tier
//   status(ctx) → { kind: "live" | "data" | "mock" | "planned", text, long }   (the source tag on every tile)
// Live feeds (CORS-open, open licences, no keys): Open-Meteo, USGS, ECCC GeoMet alerts, NWS alerts, DriveBC Open511.
// "Data" tiles read the projects' published JSON in site/public/data/<proj>/. Everything else is tagged MOCK or PLANNED.
import * as d3 from "d3";
import { el, tooltip, tipRow, cssVar } from "../src/shared/ui.js";
import { renderBars } from "../src/shared/charts.js";
import * as C from "./civic-charts.js";
import {
  PLACES, LEVELS, byId, file, weather, moisture, air, quakesWeek, quakesMonth, ecccAlerts, nwsPoint, nwsCount, open511, aqhi, aqhiRisk, usaqiRisk,
  WMO, MONTHS, bump, monthly, doyToDate, fDate, dayDiff, f0, parseDay, inYear, km, inGeom, dataKey, inherit, countryOf, provinceOf, chainOf,
} from "./civic-data.js";
import { get as cached } from "./civic-data.js";
import { withFreshness } from "./civic-sources.js";   // live / stale / down from each feed's age
import { hubSetFor, hubAirCovers } from "../src/shared/livehub.js";   // which places the relay's live hub serves
import { REGIONS, UNCOVERED, SPOTLIGHT_PLACES, regionForPlace, regionAt } from "../src/blink/regions.js";
import * as TR from "../src/blink/transit.js";
import { fetchPoint, nearestAirports, typeInfo, airborne, callsign, fAlt, distKm as airKm, glyphPath, kindOf, kindColor, sizeOf, rareOf, closestApproach, compass as airCompass, lookupRoute, routeFits } from "../src/air/feed.js";
import { followButton, followHint, toggleFollow, stopFollow } from "./civic-follow.js";   // Focus & follow the selected aircraft (Air Traffic page)
import { addTrail, remember, historyOf, relayTrack, mergeTracks, greatCircle, ahead as aheadOf } from "./civic-trail.js";   // its wake + probable route
import { airFeed, feedText as airFeedText, feedReason as airFeedReason, addAirLayers, feedStrip as airStrip, overheadList as airList, aircraftCard as airCard, idOf as airId } from "../src/air/layer.js";   // Air traffic: shared feed + map layer
import * as R from "./civic-mod-roads.js";   // Traffic (events, cameras) + Malahat (DriveBC)
import { busSummary, crdWide, inCRDBox, crdCams, NEAR_KM } from "./civic-mod-traffic.js";   // Traffic: bus speeds, Greater Victoria-wide events and cameras
import * as RS from "./civic-mod-roadsigns.js";   // road-event signs (Vehicle Traffic: map, strip, list)
import { rainCard } from "./civic-mod-weather.js";   // Rain Map card in Forecast
import { trailsDef } from "./civic-mod-trails.js";   // Parks & Trails (BC Parks advisories, parks map)
import { bikeDef } from "./civic-mod-bike.js";   // Biking (OSM bike network, riding conditions, parking and repair)
import { gooseDef } from "./civic-mod-goose.js";   // Galloping Goose (Biking inset: the trail end to end, km markers, profile)
import { hotDef } from "./civic-mod-hot.js";   // What's Hot Now (seasonal pick, live surf)
import { surfDef } from "./civic-mod-surf.js";   // Surf (Nature: the breaks and their live wave forecast)
import { oaksDef, wildDef } from "./civic-stage-wild.js";   // Garry Oaks & Arbutus, Wildlife Sightings (Nature, their own maps)
import { eventsDef } from "./civic-mod-events.js";   // Events (Lifestyle: holidays, markets, culture venues)
import { golfDef } from "./civic-mod-golf.js";   // Golfing (Things to Do): a live Good / Fair / Poor verdict per course
import * as CL from "./civic-mod-climate.js";   // tsunami, ENSO, seasonal outlook, ocean snapshots
import * as HZ from "./civic-mod-hazards.js";   // Wildfires, the Earthquakes map stage, Weather Patterns (live)
import * as FER from "./civic-mod-ferries.js";   // BC Ferries / Washington State Ferries (live AIS, Sea Traffic)
import { seaStage } from "./civic-mod-sea.js";   // Sea Traffic: every ship by class on the map, legend, card
import { addAirfields } from "../src/air/airfields.js";   // Air Traffic: airport outlines (OSM) with codes
import { circleFeature as airCircle } from "./civic-stage.js";   // Air Traffic: the aircraft search circle (coverage)
import { airportFacts, airportCard } from "./civic-poi.js";   // Air Traffic: the airport card (what it is, arrivals / departures)
import * as L from "./civic-mod-local.js";   // Municipal Notices, Police News, NRCan earthquakes
import * as GR from "./civic-mod-growth.js";   // Growth & Building: every CRD municipality, choropleth, ranking, Langford forecast
import * as WS from "./civic-mod-transit.js";   // Local Stops + West Shore road speeds from bus movements (transit)

const tip = tooltip();
const $ = (t) => (typeof t === "string" ? document.getElementById(t) : t);

// ================================================================== small chart kit (sizes to its box, theme colours only)
function svgBox(host, m) {
  host = $(host);
  const w = Math.max(80, host.clientWidth), h = Math.max(28, host.clientHeight || 140);
  host.replaceChildren();
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${w} ${h}`).attr("width", w).attr("height", h);
  return { svg, g: svg.append("g").attr("transform", `translate(${m.l},${m.t})`), iw: w - m.l - m.r, ih: h - m.t - m.b, w, h };
}
const axisClean = (a) => a.call((s) => s.select(".domain").remove());
const tall = (host) => $(host).clientHeight >= 150;

/** lines over x. series: [{ values: [{x, y}], color, width?, dash?, area?, name, cssVar }] */
function lineChart(host, series, o = {}) {
  const mini = o.mini && !tall(host);
  const m = mini ? { l: 2, r: 2, t: 6, b: 3 } : { l: 40, r: 14, t: 12, b: 22 };
  const { svg, g, iw, ih } = svgBox(host, m);
  const all = series.flatMap((s) => s.values).concat(o.band ? o.band.values.flatMap((v) => [{ x: v.x, y: v.lo }, { x: v.x, y: v.hi }]) : []);
  if (!all.length) return;
  const x = (o.time ? d3.scaleTime() : d3.scaleLinear()).domain(o.xDomain || d3.extent(all, (d) => d.x)).range([0, iw]);
  const [y0, y1] = d3.extent(all.concat((o.hlines || []).map((h) => ({ y: h.y }))), (d) => d.y);
  const y = d3.scaleLinear().domain([o.yZero ? Math.min(0, y0) : y0, y1]).nice(mini ? 2 : 5).range([ih, 0]);
  if (!mini) {
    g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(ih < 140 ? 3 : 5)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
    g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(ih < 140 ? 3 : 5).tickFormat(o.yFmt || null).tickSize(0).tickPadding(6)).call(axisClean);
    const ax = d3.axisBottom(x).ticks(Math.max(2, Math.floor(iw / 90))).tickSize(0).tickPadding(5);
    if (o.xFmt) ax.tickFormat(o.xFmt);
    if (o.xTicks) ax.tickValues(o.xTicks);
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(ax).call(axisClean);
  }
  for (const h of o.hlines || []) {
    g.append("line").attr("x1", 0).attr("x2", iw).attr("y1", y(h.y)).attr("y2", y(h.y)).style("stroke", h.color || "var(--bad)").style("stroke-width", 1).style("opacity", h.color ? 0.6 : 0.85);
    if (h.label && !mini) g.append("text").attr("class", "axis-t halo").attr("x", iw - 4).attr("y", y(h.y) - 4).attr("text-anchor", "end").text(h.label);
  }
  if (o.band) g.append("path").datum(o.band.values).attr("d", d3.area().x((d) => x(d.x)).y0((d) => y(d.lo)).y1((d) => y(d.hi)).curve(d3.curveMonotoneX)).style("fill", o.band.color).style("opacity", 0.18);
  for (const s of series) {
    if (s.area) g.append("path").datum(s.values).attr("d", d3.area().x((d) => x(d.x)).y0(ih).y1((d) => y(d.y)).curve(d3.curveMonotoneX)).style("fill", s.color).style("opacity", 0.12);
    g.append("path").datum(s.values).attr("d", d3.line().x((d) => x(d.x)).y((d) => y(d.y)).curve(d3.curveMonotoneX))
      .style("fill", "none").style("stroke", s.color).style("stroke-width", s.width || (mini ? 1.5 : 1.8)).style("stroke-dasharray", s.dash || null);
  }
  for (const mk of o.marks || []) {
    const px = x(mk.x); if (px < 0 || px > iw) continue;
    g.append("line").attr("x1", px).attr("x2", px).attr("y1", 0).attr("y2", ih).style("stroke", "var(--ink)").style("stroke-width", 1).style("opacity", 0.6);
    if (mk.label && !mini) g.append("text").attr("class", "axis-t halo civ-mk").attr("x", px > iw * 0.82 ? px - 4 : px + 4).attr("text-anchor", px > iw * 0.82 ? "end" : "start").attr("y", 9).text(mk.label);
  }
  const s0 = series[0].values, bis = d3.bisector((d) => d.x).center;
  svg.on("pointermove", (e) => {
    const [px] = d3.pointer(e, g.node()), p = s0[bis(s0, x.invert(px))]; if (!p) return;
    tip.show(e.clientX, e.clientY, (t) => {
      t.append(el("div", { class: "t-title" }, o.tipX ? o.tipX(p.x) : String(p.x)));
      for (const s of series) { const q = s.values[bis(s.values, p.x)]; if (q) t.append(tipRow(cssVar(s.cssVar || "--ink"), (o.yFmt || f0)(q.y), s.name || o.unit || "")); }
    });
  }).on("pointerleave", () => tip.hide());
}

/** vertical columns. rows: [{ label, v, hl?, title? }] */
function colChart(host, rows, o = {}) {
  const mini = o.mini && !tall(host);
  const m = mini ? { l: 2, r: 2, t: 4, b: o.labels ? 13 : 2 } : { l: 40, r: 10, t: 12, b: 22 };
  const { g, iw, ih } = svgBox(host, m);
  const x = d3.scaleBand(rows.map((_, i) => i), [0, iw]).padding(mini ? 0.25 : 0.3);
  const y = d3.scaleLinear([o.min || 0, o.max || d3.max(rows, (r) => r.v) || 1], [ih, 0]).nice(mini ? 2 : 4);
  if (!mini) {
    g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(4)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
    g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4).tickFormat(o.yFmt || d3.format("~s")).tickSize(0).tickPadding(6)).call(axisClean);
  }
  const anyHl = rows.some((r) => r.hl), bw = Math.min(o.maxW || 30, x.bandwidth());
  g.selectAll("rect.c").data(rows).join("rect").attr("class", "c").attr("x", (_, i) => x(i) + (x.bandwidth() - bw) / 2).attr("width", bw)
    .attr("y", (r) => y(Math.max(y.domain()[0], r.v))).attr("height", (r) => Math.max(1, ih - y(Math.max(y.domain()[0], r.v)))).attr("rx", Math.min(2, bw / 3))
    .style("fill", (r) => r.color || o.color).style("opacity", (r) => (anyHl && !r.hl ? 0.45 : 1))
    .on("pointermove", (e, r) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, r.title || r.label), tipRow(cssVar(o.cssVar || "--s1"), (o.fmt || f0)(r.v), o.unit || ""))))
    .on("pointerleave", () => tip.hide());
  if (o.labels !== false && (!mini || o.labels)) {
    const lw = Math.max(mini ? 20 : 34, (d3.max(rows, (r) => String(r.label).length) || 1) * (mini ? 5.6 : 6.4) + 6);
    const every = Math.max(1, Math.ceil(rows.length / Math.max(1, Math.floor(iw / lw))));
    g.selectAll("text.xl").data(rows).join("text").attr("class", "axis-t").attr("x", (_, i) => x(i) + x.bandwidth() / 2).attr("y", ih + (mini ? 10 : 15))
      .attr("text-anchor", "middle").style("font-weight", (r) => (r.hl ? 600 : null)).text((r, i) => (i % every === 0 || r.hl ? r.label : ""));
  }
}

/** forecast ranges per group on a date axis. rows: [{ label, p10, p25, mid, p75, p90 (Dates), op }] */
function rangeChart(host, rows, o = {}) {
  const mini = o.mini && !tall(host);
  const m = mini ? { l: 2, r: 4, t: 4, b: 13 } : { l: Math.min(190, $(host).clientWidth * 0.36), r: 16, t: 8, b: 22 };
  const { g, iw, ih } = svgBox(host, m);
  const x = d3.scaleTime(o.domain, [0, iw]), y = d3.scaleBand(rows.map((_, i) => i), [0, ih]).padding(0.3);
  g.append("g").attr("class", "grid").selectAll("line").data(x.ticks(d3.timeMonth.every(1))).join("line").attr("x1", x).attr("x2", x).attr("y1", 0).attr("y2", ih);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(d3.timeMonth.every(1)).tickFormat(d3.timeFormat("%b")).tickSize(0).tickPadding(4)).call(axisClean);
  const bh = Math.min(mini ? 6 : 12, y.bandwidth());
  const r_ = g.selectAll("g.r").data(rows).join("g").attr("class", "r").attr("transform", (_, i) => `translate(0,${y(i) + y.bandwidth() / 2})`)
    .on("pointermove", (e, r) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, r.label), tipRow(cssVar("--s1"), fDate(r.mid), "median peak"), tipRow(null, `${fDate(r.p10)} – ${fDate(r.p90)}`, "80% range"))))
    .on("pointerleave", () => tip.hide());
  r_.append("line").attr("x1", (r) => x(r.p10)).attr("x2", (r) => x(r.p90)).style("stroke", o.color).style("stroke-width", 1.2).style("opacity", (r) => r.op);
  r_.append("rect").attr("x", (r) => x(r.p25)).attr("width", (r) => Math.max(2, x(r.p75) - x(r.p25))).attr("y", -bh / 2).attr("height", bh).attr("rx", 2).style("fill", o.color).style("opacity", (r) => r.op);
  r_.append("circle").attr("cx", (r) => x(r.mid)).attr("r", mini ? 2.4 : 4).style("fill", "var(--surface)").style("stroke", "var(--ink)").style("stroke-width", 1.3);
  if (!mini) r_.append("text").attr("class", "axis-t lbl").attr("x", -10).attr("dy", "0.35em").attr("text-anchor", "end").text((r) => r.label);
  if (o.mark && o.mark >= o.domain[0] && o.mark <= o.domain[1]) {
    const px = x(o.mark);
    g.append("line").attr("x1", px).attr("x2", px).attr("y1", 0).attr("y2", ih).style("stroke", "var(--ink)").style("opacity", 0.6);
    if (!mini) g.append("text").attr("class", "axis-t halo civ-mk").attr("x", px + 4).attr("y", 9).text(fDate(o.mark));
  }
}

/** histogram of day-of-year values with the median and the pretend date */
function histChart(host, doys, o = {}) {
  const mini = o.mini && !tall(host), year = o.year;
  const m = mini ? { l: 2, r: 2, t: 4, b: 13 } : { l: 40, r: 12, t: 12, b: 22 };
  const { g, iw, ih } = svgBox(host, m);
  const [lo, hi] = o.domain, x = d3.scaleLinear([lo, hi], [0, iw]);
  const bins = d3.bin().domain([lo, hi]).thresholds(d3.range(lo, hi, mini ? 3 : 2))(doys);
  const y = d3.scaleLinear([0, d3.max(bins, (b) => b.length) || 1], [ih, 0]);
  const ticks = d3.range(0, 12).map((mo) => d3.timeDay.count(new Date(year, 0, 0), new Date(year, mo, 1))).filter((d) => d >= lo && d <= hi);
  g.append("g").attr("class", "grid").selectAll("line").data(ticks).join("line").attr("x1", x).attr("x2", x).attr("y1", 0).attr("y2", ih);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickValues(ticks).tickFormat((d) => MONTHS[doyToDate(d, year).getMonth()]).tickSize(0).tickPadding(4)).call(axisClean);
  g.selectAll("rect").data(bins).join("rect").attr("x", (b) => x(b.x0) + 0.5).attr("width", (b) => Math.max(1, x(b.x1) - x(b.x0) - 1))
    .attr("y", (b) => y(b.length)).attr("height", (b) => ih - y(b.length)).attr("rx", 1).style("fill", o.color).style("opacity", 0.85);
  const p50 = d3.median(doys);
  g.append("line").attr("x1", x(p50)).attr("x2", x(p50)).attr("y1", 0).attr("y2", ih).style("stroke", "var(--ink)").style("stroke-width", 1.3);
  if (!mini) g.append("text").attr("class", "axis-t halo").attr("x", x(p50) + 4).attr("y", 22).text(`median ${fDate(doyToDate(p50, year))}`);
  if (o.mark != null && o.mark >= lo && o.mark <= hi) g.append("line").attr("x1", x(o.mark)).attr("x2", x(o.mark)).attr("y1", 0).attr("y2", ih).style("stroke", "var(--ink)").style("opacity", 0.6);
}

/** HTML rows: [[label, value, frac?, extra?]]; frac draws a fill bar; extra: { hl, title, tag } */
function rowsList(host, rows, o = {}) {
  host = $(host);
  if (o.fit && host.clientHeight) rows = rows.slice(0, Math.max(1, Math.floor((host.clientHeight + 2) / 19)));
  host.replaceChildren(el("div", { class: `civ-rows${o.bars ? " bars" : ""}` },
    ...rows.map(([l, v, frac, extra]) => el("div", { class: "civ-row" + (extra?.hl ? " hl" : ""), title: extra?.title || null },
      el("span", { class: "civ-row-l" }, extra?.sev ? el("i", { class: "civ-sev", "data-sev": extra.sev }) : null, l),
      o.bars ? el("span", { class: "civ-row-bar" }, el("i", { style: { width: `${Math.max(2, Math.min(1, frac || 0) * 100)}%` } })) : null,
      el("b", { class: "civ-row-v" }, v, extra?.tag ? el("em", { class: "civ-tag", "data-kind": extra.tag }, extra.tag) : null)))));
}

/** the 12-month relevance curve for the "In Open Places" card */
function seasonChart(host, mod, ctx) {
  colChart(host, MONTHS.map((_, i) => ({ label: MONTHS[i][0], v: Math.round(mod.season(i + 1.5, ctx) * 100), hl: i === ctx.date.getMonth(), title: MONTHS[i] })),
    { color: "var(--s1)", max: 100, fmt: (v) => `${v}`, unit: "relevance", yFmt: (v) => v, maxW: 22 });
}

// ================================================================== shared scaffolding
export const LIVE = "live", DATA = "data", MOCK = "mock", PLANNED = "planned";
const asOf = (s) => (s ? `Data · ${fDate(parseDay(s))}` : "Data");
const SCALE_LABEL = { alerts: "Alerts", basic: "Basic · every place", muni: "Municipality", region: "Region", province: "Province / state", country: "Country", world: "Planet" };

/** the node of the selected place's chain that this module covers (null = not shown here) */
export function nodeFor(m, ctx) {
  if (m.only && ctx.place && !m.only(ctx)) return null;   // narrowed to some places (Route 95's set piece)
  if (m.scale === "basic" || m.scale === "alerts") return ctx.place;
  return ctx.chain.find((n) => n.level === m.scale && (m.at === "*" || m.at.includes(n.id))) || null;
}
export const relevance = (m, ctx) => Math.max(0, Math.min(1, m.season(ctx.month, ctx)));
export const inSeason = (m, ctx) => m.seasonal && relevance(m, ctx) >= 0.6;
/** order within a step: reach (1–3) + seasonal relevance (0–1); out-of-season seasonal topics drop a tier; urgent ones jump */
export function score(m, ctx) {
  const r = relevance(m, ctx);
  let s = m.reach + r - (m.seasonal && r < 0.2 ? 1 : 0);
  if (m.planned) s -= 10;
  try { if (m.urgent?.(ctx)) s += 10; } catch { /* data not in yet */ }
  return s;
}
const where = (m) => {
  const ids = m.at === "*" ? null : m.at;
  return ids ? ids.map((id) => byId.get(id)?.short).filter(Boolean).join(", ") : `every ${SCALE_LABEL[m.scale].toLowerCase()}`;
};

function both(...cs) {
  const e = cs.find((c) => c.err); if (e) return { err: e.err };
  return cs.every((c) => c.data) ? cs.map((c) => c.data) : null;
}

// tile body = plot (fills) + foot (source · full-dashboard link)
function tileBody(t, m, ctx) {
  if (!t.vis.classList.contains("civ-v")) {
    t.vis.classList.add("civ-v");
    t.vis.replaceChildren(el("div", { class: "civ-plot" }), el("div", { class: "civ-tfoot" }));
  }
  const plot = t.vis.firstElementChild, foot = t.vis.lastElementChild;
  const st = m.status(ctx), chip = t.el.querySelector(".cx-tile-live");
  t.status(st.text); chip.dataset.kind = st.kind; chip.title = st.long || "";
  t.el.dataset.kind = st.kind;
  foot.replaceChildren(el("span", { class: "civ-src" }, m.source ? m.source(ctx) : st.long || ""));   // no link out: the detail lives here
  t.el.classList.toggle("civ-hot", inSeason(m, ctx));
  return {
    plot,
    wait: (c) => { t.kpis([[c?.err ? "—" : "…", c?.err ? "couldn't load" : "loading"]]); plot.replaceChildren(el("p", { class: "note cx-status" }, c?.err ? `Couldn't load: ${c.err.message || c.err}` : "Loading…")); },
  };
}

// one pane per module: main chart card (+ a row of one or two extra chart cards under it, from def.extra) + a list card
// + the "In Open Places" card (scale, footprint, season, source)
const paneHtml = (id) => `
  <div class="civ-pane">
    <div class="civ-col">
      <div class="card cx-fill civ-main"><h3 class="cx-card-title" id="${id}-mt"></h3><p class="note cx-card-sub" id="${id}-ms"></p><div class="chart" id="${id}-main"></div></div>
      <div class="civ-xrow" id="${id}-x" hidden></div>
    </div>
    <div class="civ-side">
      <div class="card cx-fill civ-listcard"><h3 class="cx-card-title" id="${id}-lt"></h3><div class="cx-grow civ-scroll" id="${id}-list"></div></div>
      <div class="card cx-fill civ-atlas"><h3 class="cx-card-title">In Open Places</h3><div class="civ-meta" id="${id}-meta"></div>
        <div class="chart civ-season" id="${id}-season"></div><div class="civ-meta-foot" id="${id}-link"></div></div>
    </div>
  </div>`;

// which open data each basic would use, by place
const BASIC_SRC = {
  weather: [["Canada", "ECCC + Open-Meteo"], ["USA", "NWS + Open-Meteo"], ["Anywhere", "Open-Meteo (live here)"]],
  air: [["Canada", "ECCC AQHI stations"], ["USA", "AirNow (key needed)"], ["Anywhere", "Open-Meteo air quality (live here)"]],
  transit: [["Greater Victoria + 34 BC systems", "BC Transit GTFS + realtime, no key"], ["Toronto · Calgary · Edmonton", "city open data, no key (live)"], ["Seattle · Sacramento · Boston · BART", "agency open feeds, no key (live)"], ["Vancouver · LA · San Diego · Las Vegas", "realtime needs a key: timetables or none"]],
  roads: [["BC", "DriveBC Open511 + highway cameras (live here)"], ["Toronto", "City cameras, Ontario 511 (planned)"], ["Washington · California", "WSDOT, Caltrans (planned)"], ["Anywhere", "Not available"]],
};
function fillAtlasCard(m, ctx) {
  const st = m.status(ctx), sc = $(`${m.id}-season`), node = nodeFor(m, ctx);
  if (!sc) return;
  rowsList(`${m.id}-meta`, [
    ["Step", SCALE_LABEL[m.scale] + (node && m.scale !== "basic" ? ` · ${node.name}` : "")],
    ["Shows up in", m.scale === "basic" ? "Every place" : where(m)],
    m.scale === "basic" ? null : ["Order today", `reach ${m.reach}/3 · relevance ${Math.round(relevance(m, ctx) * 100)}${inSeason(m, ctx) ? " · in season" : ""}`],
    ["Source", st.long || st.text, 0, { tag: st.kind }],
  ].filter(Boolean));
  if (m.scale === "basic") {
    sc.classList.remove("chart"); sc.classList.add("civ-srcs");
    rowsList(sc, [["Source by place", ""], ...(BASIC_SRC[m.id] || [])]);
    $(`${m.id}-link`).replaceChildren(el("span", { class: "note" }, "Each country plugs its own source into the same tile."));
    return;
  }
  seasonChart(sc, m, ctx);
  $(`${m.id}-link`).replaceChildren(m.planned ? el("span", { class: "note" }, "Planned.") : "");
}

// ------------------------------------------------------------------ standalone dashboards, rendered natively
// Open Places no longer inlays standalone pages as iframes: every leaf draws in the shell (its pane over the map stage,
// civic-stage.js / civic-layers.js). Nothing links out to the old standalone dashboards.
// A module without a pane of its own (no main(), e.g. Transit, Air Traffic, Sea Traffic) gets an empty native slot; the
// shell fills it with the stage panels from civic-layers.js STAGES, or from the module's own `stage` (see there).
const nativeHtml = (id) => `<div class="civ-native" id="${id}-native"></div>`;

/** build a console module from a compact definition */
function mod(def) {
  const applies = (ctx) => !!ctx.place && !!nodeFor(m, ctx);
  const need = (ctx) => def.need(ctx);
  const m = {
    reach: 1, ...def,
    color: def.color || `var(--m-${def.id}, var(--accent))`, // each topic has its own colour (civic.css --m-<id>)
    html: def.html || (def.main ? paneHtml(def.id) : nativeHtml(def.id)),
    rows: "minmax(0, 1fr)",
    badge: (ctx) => { if (!applies(ctx)) return ""; const d = need(ctx); return d && !d.err && def.badge ? def.badge(d, ctx) : ""; },
    kpis: (ctx) => { if (!applies(ctx)) return []; const d = need(ctx); return d && !d.err && def.kpis ? def.kpis(d, ctx) : []; },
    tile: def.scale === "alerts" ? undefined : (t, ctx) => {
      if (!applies(ctx)) return; // hidden here (GAP: the console renders every tile, even hidden ones)
      const b = tileBody(t, m, ctx), d = need(ctx);
      if (!d || d.err) return b.wait(d);
      t.kpis(def.tileKpis(d, ctx));
      def.mini(b.plot, d, ctx);
    },
    view: def.view || (!def.main ? (() => {}) : (host, ctx) => {
      fillAtlasCard(m, ctx);
      if (!applies(ctx)) { if ($(`${def.id}-x`)) $(`${def.id}-x`).hidden = true; $(`${def.id}-main`).replaceChildren(el("p", { class: "note civ-empty" }, `${def.title} doesn't cover ${ctx.place.name}. It shows up in: ${where(m)}.`)); $(`${def.id}-list`).replaceChildren(); return; }
      const d = need(ctx), xrow = $(`${def.id}-x`);
      if (!d || d.err) { if (xrow) xrow.hidden = true; $(`${def.id}-main`).replaceChildren(el("p", { class: "note cx-status" }, d?.err ? "Couldn't load the data." : "Loading…")); return; }
      const v = def.main(d, ctx);
      // extra charts first, so the main chart draws into the space they leave it
      const xs = (def.extra?.(d, ctx) || []).filter(Boolean);
      if (xrow) {
        xrow.hidden = !xs.length;
        xrow.style.setProperty("--xcols", xs.map((x) => `minmax(0, ${x.w || 1}fr)`).join(" "));
        // a main card that is only a short list gives the extra charts the larger share
        xrow.parentElement.style.setProperty("--crows", def.xBig ? "minmax(0, 0.8fr) minmax(0, 1fr)" : "");
        xrow.replaceChildren(...xs.map((x) => el("div", { class: "card cx-fill civ-xcard" }, el("h3", { class: "cx-card-title" }, x.title), x.sub ? el("p", { class: "note cx-card-sub" }, x.sub) : null, el("div", { class: "chart" }))));
      }
      $(`${def.id}-mt`).textContent = v.title; $(`${def.id}-ms`).textContent = v.sub || "";
      v.draw($(`${def.id}-main`));
      if (xrow) xs.forEach((x, k) => x.draw(xrow.children[k].querySelector(".chart")));
      $(`${def.id}-lt`).textContent = v.listTitle;
      v.list($(`${def.id}-list`));
    }),
  };
  // the frame's colours: a live status turns stale (amber) or down (red) from its feeds' age (civic-sources.js withFreshness)
  const st0 = def.status || (() => ({ kind: DATA, text: "Data" }));
  m.status = (ctx) => withFreshness(def.id, st0(ctx), def.interval);
  m.season = def.season || (() => 0.5);
  m.seasonal = !!def.season && def.seasonal !== false;
  m.applies = applies;
  return m;
}

/** a planned module: a placeholder tile that says what it will show and where the data would come from */
function planned(def) {
  const items = def.plan;
  return mod({
    ...def, planned: true, need: () => ({}),
    status: () => ({ kind: PLANNED, text: "Planned", long: `Planned: ${def.src}` }),
    source: () => def.src,
    badge: () => "planned",
    tileKpis: () => [[def.promise, def.promiseL]],
    mini: (host) => rowsList(host, items.map(([l, v]) => [l, v]), { fit: true }),
    main: () => ({
      title: `${def.title} (planned)`, sub: `Planned, not built. Source: ${def.src}.`,
      draw: (host) => rowsList(host, items.map(([l, v]) => [l, v])),
      listTitle: "Ranking factors",
      list: (host) => host.replaceChildren(el("p", { class: "civ-why" }, def.why)),
    }),
  });
}

const relDays = (n) => (n === 0 ? "today" : n > 0 ? `in ${n} d` : `${-n} d ago`);
const ll = (ctx) => ctx.place.ll;
const isBC = (ctx) => provinceOf(ctx.place)?.id === "bc";
const isCA = (ctx) => countryOf(ctx.place)?.id === "ca";
const isUS = (ctx) => countryOf(ctx.place)?.id === "us";
const hhmm = (s) => { const d = new Date(s); return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${d.getHours() < 12 ? "am" : "pm"}`; };
const hm = (s) => `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, "0")}m`;
const localHourIdx = (wx) => { const now = wx.current.time.slice(0, 13); return Math.max(0, wx.hourly.time.findIndex((t) => t.slice(0, 13) === now)); };
const ago = (t) => { const h = (Date.now() - t) / 36e5; return h < 1 ? "just now" : h < 24 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} d ago`; };
const DAYS = (n) => d3.range(n).map((i) => d3.timeFormat("%a")(d3.timeDay.offset(new Date(), i)));
const pretendIn = (ctx, year) => inYear(ctx.date, year);

// ================================================================== BASICS (same four tiles in every place)
const wxNeed = (ctx) => { const c = weather(ll(ctx), ctx); return c.err ? { err: c.err } : c.data; };
const aqNeed = (ctx) => { const c = air(ll(ctx), ctx); return c.err ? { err: c.err } : c.data; };
const aqKind = (ctx) => (ctx.place.aq || inherit(ctx.place, "aq")) === "aqhi";
const wxDays = (w) => w.daily.time.map((s, k) => ({ d: parseDay(s), hi: w.daily.temperature_2m_max[k], lo: w.daily.temperature_2m_min[k], code: w.daily.weather_code[k], mm: w.daily.precipitation_sum[k] ?? 0, text: WMO[w.daily.weather_code[k]] || "" }));
/** AQHI at hour i from 3-hour means of the model's NO₂, O₃ (ppb) and PM2.5 (same formula as aqhi() in civic-data.js) */
const aqhiAt = (h, i) => {
  if (i < 2) return null;
  const m = (k) => { const a = [h[k][i], h[k][i - 1], h[k][i - 2]]; return a.some((v) => v == null) ? null : (a[0] + a[1] + a[2]) / 3; };
  const no2 = m("nitrogen_dioxide"), o3 = m("ozone"), pm = m("pm2_5"); if (no2 == null || o3 == null || pm == null) return null;
  return Math.max(1, Math.round((1000 / 10.4) * ((Math.exp(0.000871 * (no2 / 1.88)) - 1) + (Math.exp(0.000537 * (o3 / 1.96)) - 1) + (Math.exp(0.000487 * pm) - 1))));
};
const aqBand = (v, k) => (k ? (v <= 3 ? "live" : v <= 6 ? "warn" : "bad") : v <= 50 ? "live" : v <= 100 ? "warn" : "bad");
const aqMeter = (a, ctx, big) => {
  if (aqKind(ctx)) { const v = aqhi(a); return { v, max: 11, segs: C.AQHI_SEGS, ticks: [0, 3, 6, 11], tickFmt: (d) => ({ 0: "1", 3: "4", 6: "7", 11: "10+" })[d], title: "AQHI (estimated)", text: big ? `${v}` : `AQHI ${v}`, sub: aqhiRisk(v) }; }
  const v = a.current.us_aqi; return { v, max: 300, segs: C.USAQI_SEGS, ticks: [0, 50, 100, 150, 200, 300], title: "US AQI", text: big ? `${v}` : `AQI ${v}`, sub: usaqiRisk(v) };
};

export const wx = mod({
  id: "weather", xBig: true, title: "Forecast", tileTitle: "Forecast", scale: "basic", eyebrow: "The basics", heading: "Forecast", need: wxNeed,
  status: () => ({ kind: LIVE, text: "Live", long: "Open-Meteo forecast API (CC BY 4.0), called from the browser" }),
  source: () => "Open-Meteo",
  badge: (w) => `${Math.round(w.current.temperature_2m)}°`,
  tileKpis: (w) => [[`${Math.round(w.current.temperature_2m)}°`, WMO[w.current.weather_code] || "—"], [`${Math.round(w.daily.temperature_2m_max[0])}° / ${Math.round(w.daily.temperature_2m_min[0])}°`, "high / low"],
    [hm(w.daily.daylight_duration[0]), `daylight · sets ${hhmm(w.daily.sunset[0])}`]],
  kpis: (w) => [["Now", `${Math.round(w.current.temperature_2m)}°`, WMO[w.current.weather_code]], ["Feels like", `${Math.round(w.current.apparent_temperature)}°`],
    ["Wind", `${Math.round(w.current.wind_speed_10m)} km/h`], ["Sunrise", hhmm(w.daily.sunrise[0])], ["Sunset", hhmm(w.daily.sunset[0])], ["Daylight", hm(w.daily.daylight_duration[0])]],
  // tile: the 7-day strip when there's room, else the next 24 h over shaded nights (sunrise / sunset marked)
  mini: (host, w) => { const { W, H } = C.size(host); if (H >= 44 && W >= 150) C.wxStrip(host, wxDays(w)); else C.daySpark(host, w, localHourIdx(w)); },
  // alerts (civic-alerts.js), from the forecast already fetched: rain or snow starting within the hour, a drop of 5° or more
  // in 3 h, gusts of 60 km/h or more (hourly wind_gusts_10m when the request carries it, else the current wind), first frost
  detect: (w, ctx) => {
    const h = w.hourly, i = localHourIdx(w), p = ctx.place.short, out = [], day = w.current.time.slice(0, 10);
    const wet = (c) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95, snowy = (c) => (c >= 71 && c <= 77) || c === 85 || c === 86;
    const k = i + 1, pp = h.precipitation_probability?.[k] ?? 0, code = h.weather_code?.[k];
    const now = w.current.weather_code, dry = !((w.current.precipitation ?? 0) > 0 || wet(now) || snowy(now));
    if (dry && k < h.time.length && (pp >= 60 || ((wet(code) || snowy(code)) && pp >= 40))) {
      const what = snowy(code) ? "snow" : "rain";
      out.push({ id: `${what}:${h.time[k]}`, level: "notice", title: `${what === "snow" ? "Snow" : "Rain"} within the hour`, href: "#weather",
        body: `${pp}% chance of ${what} by ${hhmm(h.time[k])} in ${p} (${WMO[code] || "forecast"}, Open-Meteo).` });
    }
    const t0 = h.temperature_2m[i], next = h.temperature_2m.slice(i + 1, i + 4), lo = Math.min(...next);
    if (next.length && t0 - lo >= 5) { const j = i + 1 + next.indexOf(lo);
      out.push({ id: `drop:${day}`, level: "notice", title: `Temperature falling ${Math.round(t0 - lo)}°`, href: "#weather", body: `From ${Math.round(t0)}° now to ${Math.round(lo)}° by ${hhmm(h.time[j])} in ${p} (Open-Meteo).` }); }
    const g = h.wind_gusts_10m;
    if (g) { const win = g.slice(i, i + 7), mx = Math.max(...win);
      if (mx >= 60) out.push({ id: `gust:${day}`, level: mx >= 90 ? "warn" : "notice", title: `Gusts to ${Math.round(mx)} km/h`, href: "#weather", body: `Wind gusts of ${Math.round(mx)} km/h forecast around ${hhmm(h.time[i + win.indexOf(mx)])} in ${p} (Open-Meteo).` }); }
    else if (w.current.wind_speed_10m >= 60) out.push({ id: `wind:${day}`, level: w.current.wind_speed_10m >= 90 ? "warn" : "notice", title: `Wind ${Math.round(w.current.wind_speed_10m)} km/h`, href: "#weather", body: `Sustained wind of ${Math.round(w.current.wind_speed_10m)} km/h now in ${p} (Open-Meteo).` });
    // first frost: the season runs from July; remembered per place in this browser so it fires once a season
    const lows = w.daily.temperature_2m_min.slice(0, 2), d = lows.findIndex((v) => v != null && v <= 0);
    if (d >= 0) {
      const dt = new Date(), season = dt.getMonth() >= 6 ? dt.getFullYear() : dt.getFullYear() - 1, key = `${ctx.place.id}:${season}`;
      let seen = {}; try { seen = JSON.parse(localStorage.getItem("odp-frost") || "{}"); } catch { /* ignore */ }
      if (!seen[key] || seen[key] === day) {
        if (!seen[key]) { seen[key] = day; try { localStorage.setItem("odp-frost", JSON.stringify(seen)); } catch { /* ignore */ } }
        out.push({ id: `frost:${season}`, level: "notice", title: "First frost of the season", href: "#weather",
          body: `Low of ${Math.round(lows[d])}° forecast ${d ? "tomorrow" : "tonight"} in ${p}: the first frost this browser has seen here since July (Open-Meteo).` });
      }
    }
    return out;
  },
  main: (w, ctx) => ({
    title: "Next three days, hour by hour", sub: `Temperature (top, °C) and chance of precipitation (bottom), ${ctx.place.name}, local time. Shaded: night.`,
    draw: (host) => C.comboHourly(host, w, localHourIdx(w)),
    listTitle: "Seven days",
    list: (host) => rowsList(host, w.daily.time.map((s, k) => [d3.timeFormat("%a %b %-d")(parseDay(s)),
      `${Math.round(w.daily.temperature_2m_max[k])}° / ${Math.round(w.daily.temperature_2m_min[k])}° · ${WMO[w.daily.weather_code[k]] || ""}${w.daily.precipitation_sum[k] >= 1 ? ` · ${w.daily.precipitation_sum[k].toFixed(0)} mm` : ""}`])),
  }),
  extra: (w, ctx) => [
    rainCard(ctx),   // the seven-day strip lives on the tile and in the side list
    { title: "Daylight through the year", sub: `Sunrise to sunset at ${Math.abs(ll(ctx)[1]).toFixed(1)}°${ll(ctx)[1] >= 0 ? "N" : "S"}, computed from the latitude.`, draw: (h) => C.dayCurve(h, ll(ctx)[1], new Date()) },
  ],
});

export const aq = mod({
  id: "air", title: "Air Quality", scale: "basic", eyebrow: "The basics", heading: "Air Quality", need: aqNeed,
  status: (ctx) => ({ kind: LIVE, text: "Live", long: aqKind(ctx) ? "Open-Meteo air quality (CC BY 4.0); AQHI estimated from its NO₂, O₃ and PM2.5" : "Open-Meteo air quality (CC BY 4.0), US AQI" }),
  source: (ctx) => (aqKind(ctx) ? "Open-Meteo · AQHI estimated" : "Open-Meteo"),
  badge: (a, ctx) => (aqKind(ctx) ? `AQHI ${aqhi(a)}` : `AQI ${a.current.us_aqi}`),
  tileKpis: (a, ctx) => aqKind(ctx) ? [[`${aqhi(a)}`, `AQHI · ${aqhiRisk(aqhi(a)).replace(" risk", "").toLowerCase()} risk`], [`${a.current.pm2_5.toFixed(0)}`, "PM2.5 µg/m³"]]
    : [[`${a.current.us_aqi}`, `US AQI · ${usaqiRisk(a.current.us_aqi).replace(/ \(.*/, "").toLowerCase()}`], [`${a.current.pm2_5.toFixed(0)}`, "PM2.5 µg/m³"]],
  kpis: (a, ctx) => [aqKind(ctx) ? ["AQHI (estimated)", `${aqhi(a)}`, aqhiRisk(aqhi(a))] : ["US AQI", `${a.current.us_aqi}`, usaqiRisk(a.current.us_aqi)],
    ["PM2.5", `${a.current.pm2_5.toFixed(1)} µg/m³`], ["Ozone", `${a.current.ozone.toFixed(0)} µg/m³`], ["NO₂", `${a.current.nitrogen_dioxide.toFixed(0)} µg/m³`]],
  // tile: the index on a segmented meter (an arc gauge in a squarish box, a bar in a wide or short one)
  mini: (host, a, ctx) => C.meter(host, aqMeter(a, ctx)),
  // alert (civic-alerts.js) when the index changes category; a state, so going back to low is reported too (quietly)
  detect: (a, ctx) => {
    const k = aqKind(ctx), v = k ? aqhi(a) : a.current.us_aqi;
    if (v == null) return [];
    const cat = k ? (v <= 3 ? 0 : v <= 6 ? 1 : v <= 10 ? 2 : 3) : (v <= 50 ? 0 : v <= 100 ? 1 : v <= 150 ? 2 : v <= 200 ? 3 : 4);
    const name = (k ? aqhiRisk(v) : usaqiRisk(v)).toLowerCase();
    return [{ id: `${k ? "aqhi" : "aqi"}:${cat}`, state: true, level: cat >= 2 ? "warn" : cat === 1 ? "notice" : "info", href: "#air",
      title: `${k ? "AQHI" : "Air quality"} now ${name}`, body: `${k ? "AQHI (estimated)" : "US AQI"} ${v} in ${ctx.place.short}, from Open-Meteo's air-quality model.` }];
  },
  main: (a, ctx) => ({
    title: "Pollutants, yesterday to tomorrow", sub: "PM2.5, ozone and nitrogen dioxide (µg/m³), hourly model values. The vertical line is now.",
    draw: (host) => {
      const t = a.hourly.time.map((s) => new Date(s)), s = (k, c, n) => ({ values: a.hourly[k].map((y, i) => ({ x: t[i], y: y ?? 0 })), color: `var(${c})`, cssVar: c, name: n });
      lineChart(host, [s("pm2_5", "--s1", "PM2.5"), s("ozone", "--s2", "Ozone"), s("nitrogen_dioxide", "--s3", "NO₂")],
        { time: true, marks: [{ x: new Date(a.current.time), label: "now" }], tipX: d3.timeFormat("%a %-I %p"), xFmt: d3.timeFormat("%a %-I%p"), yFmt: (y) => y.toFixed(0), yZero: true });
    },
    listTitle: "Index guide",
    list: (host) => rowsList(host, aqKind(ctx)
      ? [["1–3", "Low risk"], ["4–6", "Moderate risk"], ["7–10", "High risk"], ["10+", "Very high risk"], ["Note", "Estimated from Open-Meteo's model; the real tile uses ECCC's stations"]]
      : [["0–50", "Good"], ["51–100", "Moderate"], ["101–150", "Unhealthy for sensitive groups"], ["151–200", "Unhealthy"], ["201+", "Very unhealthy"]]),
  }),
  extra: (a, ctx) => {
    const k = aqKind(ctx), risk = k ? aqhiRisk : usaqiRisk;
    const pts = a.hourly.time.map((s, i) => { const v = k ? aqhiAt(a.hourly, i) : a.hourly.us_aqi[i]; return v == null ? null : { x: new Date(s), v, c: aqBand(v, k), note: risk(v) }; }).filter(Boolean);
    return [
      { w: 1.7, title: k ? "Health index, hour by hour" : "US AQI, hour by hour", sub: k ? "AQHI estimated from the model's NO₂, O₃ and PM2.5 (3-hour means). Colour = risk band; paler = forecast." : "Open-Meteo's US AQI. Colour = category; paler = forecast.",
        draw: (h) => (pts.length ? C.timeCols(h, pts, { now: new Date(a.current.time), unit: k ? "AQHI (est.)" : "US AQI", min: k ? 4 : 60 }) : C.emptyNote(h, "No hourly values.")) },
      { title: "Right now", sub: aqMeter(a, ctx).sub, draw: (h) => C.meter(h, aqMeter(a, ctx, true)) },
    ];
  },
});

// transit: any place an agency's open GTFS covers: the next departures at the nearest stops (live predictions where the
// feed is open, else what the timetable promises), every live vehicle in the region (and how many are near the place)
// and the agency's service alerts, through the relay. Places whose live feed needs a key, or that have no open feed,
// say so. The map (civic-transit-stage.js) draws the region's whole network and fleet, opening on the place.
const TR_WIDE = { world: () => true, ca: (r) => r.group === "BC Transit" || r.group === "Canada", us: (r) => r.group === "United States",
  bc: (r) => r.group === "BC Transit" || r.id === "vancouver", on: (r) => r.id === "toronto", wa: (r) => r.id === "seattle", cal: (r) => r.id === "sfbay" || r.id === "sacramento" };
const trWide = (p) => ["world", "country", "province"].includes(p.level);
const trKey = (p) => `${p.ll[1].toFixed(3)},${p.ll[0].toFixed(3)}`;
function trRegion(p, index) {
  if (UNCOVERED[p.id]) return { none: UNCOVERED[p.id], keyed: /key/.test(UNCOVERED[p.id]) };
  const r = regionForPlace(p.id) || regionAt(index, p.ll[0], p.ll[1]);
  return r ? { r } : { none: "No open transit feed is wired for this spot yet." };
}
const trNeed = (ctx) => {
  const p = ctx.place, ix = file("blink/agencies/index.json", ctx);
  if (ix.err) return { err: ix.err }; if (!ix.data) return null;
  if (trWide(p)) {
    const f = TR_WIDE[p.id] || (() => false);
    return { p, wide: true, regs: REGIONS.filter(f), unc: Object.keys(UNCOVERED).filter((id) => byId.get(id) && chainOf(byId.get(id)).some((n) => n.id === p.id)) };
  }
  const hit = trRegion(p, ix.data);
  if (!hit.r) return { p, none: hit.none, keyed: hit.keyed };
  const r = hit.r, [lon, lat] = p.ll, k = trKey(p);
  const st = r.agencies.map((a) => cached(`tr:stops:${a}`, () => TR.loadStops(a), ctx));
  const bad = st.find((c) => c.err); if (bad) return { err: bad.err };
  if (st.some((c) => !c.data)) return null;
  const near = st.flatMap((c) => TR.nearestStops(c.data, lon, lat, 4, p.level === "region" ? 600 : 1500)).sort((a, b) => a.m - b.m).slice(0, 4);
  const relay = TR.hasRelay(), now = TR.localNow(r.tz);
  // live: the region's whole fleet, one-shot per visit (the map keeps polling); the tile shows what has arrived and
  // never waits on it. "Near" = within 5 km of the place.
  const veh = r.live === "rt" && relay ? r.agencies.map((a) => cached(`tr:veh:${a}`, () => TR.vehicles(a), ctx)) : [];
  const vs = veh.length && veh.every((c) => c.data) ? veh.flatMap((c) => c.data.vehicles || []) : null;
  const al = r.live !== "static" && relay ? r.agencies.map((a) => cached(`tr:al:${a}`, () => TR.alerts(a), ctx)) : [];
  const pr = r.live !== "static" && relay && near.length ? r.agencies.map((a) => cached(`tr:pr:${a}:${k}`, () => TR.predictions(a, near.filter((x) => x.stop.agency === a).map((x) => x.stop.id)), ctx)) : [];
  const preds = pr.flatMap((c) => c.data?.departures || []), t0 = Date.now() / 1000;
  const rows = [];
  for (const { stop, m } of near) for (const sv of stop.serves) {
    const head = sv.route.d.find((d) => d.dir === sv.dir)?.h || sv.route.l || "";
    const lv = preds.filter((x) => x.stop_id === stop.id && x.route_id === sv.route.id && !x.skipped && x.time && x.time > t0 - 30).map((x) => Math.max(0, Math.round((x.time - t0) / 60)));
    const sch = TR.scheduled(sv, now);
    rows.push({ stop, m, route: sv.route, head, live: lv[0] ?? null, sch, sort: lv.length ? lv[0] : sch.running ? (sch.gap || 30) / 2 + 0.5 : sch.wait != null ? sch.wait + 60 : 9e3 });
  }
  const seen = new Set();
  const D = rows.sort((a, b) => a.sort - b.sort).filter((x) => { const id = `${x.route.agency}:${x.route.id}:${x.head}`; if (seen.has(id)) return false; seen.add(id); return true; });
  return { p, r, near, D, relay,
    veh: vs ? vs.length : null, vehNear: vs ? vs.filter((v) => v.lat != null && km([v.lon, v.lat], p.ll) <= 5).length : null, vehErr: veh.find((c) => c.err)?.err,
    alerts: al.length && al.every((c) => c.data) ? al.reduce((s, c) => s + (c.data.alerts?.length || 0), 0) : null,
    agencies: r.agencies.map((a) => ix.data.agencies?.[a]?.operator || ix.data.agencies?.[a]?.name || a) };
};
const trWhen = (x) => (x.live != null ? (x.live <= 0 ? "now" : `${x.live} min`) : x.sch.text);
const trRow = (x) => [`${x.route.name}${x.head ? ` → ${x.head}` : ""}`, trWhen(x), 0, { title: `${x.stop.name} · ${Math.round(x.m)} m${x.live != null ? " · live prediction" : " · timetable"}`, tag: x.live != null ? LIVE : null }];
const trNoun = (d) => (d.r.group === "BC Transit" ? "buses" : "vehicles");
/** "buses in Greater Victoria · 9 near Langford" (the near count only for a place inside the region) */
const trFleet = (d) => `${trNoun(d)} in ${d.r.name}${d.vehNear != null && d.p.level !== "region" ? ` · ${d.vehNear} near ${d.p.short || d.p.name}` : ""}, live`;
const trLiveNote = (d) => d.r.live === "static" ? (d.r.missing || "The live feed needs a key (owner's choice): timetables only.") : !d.relay ? "Live data needs the relay." : d.r.live === "trips" ? "Predictions and alerts are live; no vehicle positions are published." : "";
export const transit = mod({
  id: "transit", title: "Transit", scale: "basic", eyebrow: "The basics", heading: "Transit",
  need: trNeed,
  status: (ctx) => { const d = trNeed(ctx);
    if (!d || d.err) return { kind: LIVE, text: "Live", long: "Agencies' open GTFS timetables and GTFS-Realtime through the relay" };
    if (d.wide) return { kind: DATA, text: "Data", long: "Transit regions with open feeds (Public Transit's network pipeline)" };
    if (d.none) return { kind: MOCK, text: d.keyed ? "Needs key" : "None", long: d.none };
    const live = d.r.live !== "static" && d.relay;
    return { kind: live ? LIVE : DATA, text: live ? "Live" : "Timetable", long: `${d.agencies.join(", ")}: open GTFS timetable${live ? (d.r.live === "rt" ? " + GTFS-Realtime vehicles, predictions and alerts through the relay" : " + GTFS-Realtime predictions and alerts through the relay") : ""}. ${trLiveNote(d)}`.trim() }; },
  source: (ctx) => { const d = trNeed(ctx); return !d || d.err ? "Open GTFS" : d.wide ? "Open GTFS · regions" : d.none ? (d.keyed ? "Live feed needs a key" : "No open feed here") : `${d.agencies.join(", ")} · ${d.r.live !== "static" && d.relay ? "live" : "timetable"}`; },
  badge: (d) => (d.wide ? `${d.regs.length}` : d.none ? "—" : d.D[0]?.live != null ? `${d.D[0].live} min` : d.veh != null ? `${d.veh}` : ""),
  tileKpis: (d) => {
    if (d.wide) return [[`${d.regs.length}`, "transit regions with open data"], [`${d.regs.filter((r) => r.live === "rt").length}`, "with live vehicles"]];
    if (d.none) return [["—", d.keyed ? "live feed needs a key" : "no open live feed here"], ["—", "no timetable wired"]];
    const x = d.D[0];
    return [[x ? trWhen(x) : "—", x ? `${x.route.name} at ${x.stop.name}` : d.near.length ? "no service now" : "no stop within walking distance"],
      d.r.live === "rt" && d.relay ? [d.veh == null ? (d.vehErr ? "—" : "…") : `${d.veh}`, d.vehErr ? "live feed not answering" : trFleet(d)] : [d.r.live === "trips" ? "predictions" : "timetable", d.r.live === "static" ? "live feed needs a key" : d.relay ? "no vehicle positions published" : "live data needs the relay"]];
  },
  kpis: (d) => d.wide ? [["Regions", `${d.regs.length}`, "with open transit data"], ["Live vehicles", `${d.regs.filter((r) => r.live === "rt").length}`, "regions"], ["Not wired", `${d.unc.length}`, "need a key or have no open feed"]]
    : d.none ? [["Feed", d.keyed ? "Needs a key" : "None", d.none]]
    : [["Next departure", d.D[0] ? trWhen(d.D[0]) : "—", d.D[0] ? `${d.D[0].route.name} · ${d.D[0].stop.name}` : ""], [d.r.live === "rt" ? `Live ${trNoun(d)}` : "Vehicles", d.veh == null ? "–" : `${d.veh}`, d.r.live === "rt" ? trFleet(d) : d.r.live === "static" ? "live feed needs a key" : "not published"],
      ["Service alerts", d.alerts == null ? "–" : `${d.alerts}`, d.r.live === "static" ? "live feed needs a key" : d.agencies.join(", ")], ["Agency", d.agencies.join(", ")]],
  mini: (host, d) => {
    if (d.wide) return rowsList(host, d.regs.slice(0, 12).map((r) => [r.name, r.live === "rt" ? "live" : r.live === "trips" ? "predictions" : "timetable"]), { fit: true });
    if (d.none) return host.replaceChildren(el("p", { class: "note civ-empty" }, d.none));
    if (!d.near.length) return host.replaceChildren(el("p", { class: "note civ-empty" }, `No ${d.agencies.join(" / ")} stop within ${d.p.level === "region" ? "600 m" : "1.5 km"} of ${d.p.short || d.p.name}'s centre. Open the map for the whole network.`));
    rowsList(host, d.D.slice(0, 8).map(trRow), { fit: true });
  },
});

// roads: BC places read DriveBC live (Open511 events + highway cameras, see civic-mod-roads.js); elsewhere PLANNED: no events
// or cameras are shown until that place's open feed is wired (never invented counts)
const evRoad = R.evRoad, evClosed = R.evClosed;
export function roadEvents(ctx, radius = 40) {
  if (!isBC(ctx)) return null;
  const c = R.drivebcEvents(ctx, () => isBC(ctx)); if (c.err) return { err: c.err }; if (!c.data) return null;
  return c.data.map((e) => ({ e, ll: R.evLL(e) })).filter((x) => x.ll).map((x) => ({ ...x, km: km(x.ll, ll(ctx)) })).filter((x) => x.km <= radius).sort((a, b) => a.km - b.km);
}
const roadNeed = (ctx) => {
  if (!isBC(ctx)) return { p: ctx.place, ev: null };
  // Greater Victoria places: every event and camera in the region (nearest first); elsewhere within 40 km
  const wide = crdWide(ctx), ev0 = roadEvents(ctx, wide ? 250 : 40), list = R.camList(ctx);
  if (!ev0 && !list?.cams) return null;
  const ev = ev0 && !ev0.err && wide ? ev0.filter((x) => inCRDBox(x.ll)) : ev0;
  const near = list?.cams ? (wide ? crdCams(R.nearCams(list, ll(ctx), 250)) : R.nearCams(list, ll(ctx))) : null;
  if (ev && !ev.err) R.roadAlerts(ctx.place, ev.filter((x) => x.km <= 40), R.drivebcEvents(ctx).at);   // alerts: still only nearby events
  return { p: ctx.place, bc: true, wide, ev: ev && !ev.err ? ev : null, evErr: !!ev?.err, cams: near, camErr: !!list?.err, bus: busSummary(ctx) };
};
const roadSign = (x) => ({ x: x.km, kind: RS.evKind(x.e), tone: RS.evTone(x.e), title: `${R.hwy(evRoad(x.e))} · ${Math.round(x.km)} km`, note: evClosed(x.e) ? "closed" : `${RS.KIND_LABEL[RS.evKind(x.e)].toLowerCase()} · ${String(x.e.severity || "unknown").toLowerCase()} severity` });
const roadsrc = (p) => inherit(p, "roadsrc");
const evN = (d) => (d.ev ? `${d.ev.length}` : d.evErr ? "—" : "…");
const evArea = (d) => (d.wide ? "in Greater Victoria" : "within 40 km");
const nearTxt = (d, xs) => (d.wide && d.p.level === "muni" ? ` · ${xs.length} near ${d.p.short || d.p.name}` : "");
const nearEv = (d) => (d.ev || []).filter((x) => x.km <= NEAR_KM), nearSites = (d) => (d.cams?.sites || []).filter((s) => s.km <= NEAR_KM);
/** the distance axis for the event strips: 0–40 km, or out to the region's farthest event */
const evDom = (d) => [0, d.wide && d.ev?.length ? Math.max(40, Math.ceil(d3.max(d.ev, (x) => x.km) / 20) * 20) : 40];
export const roads = mod({
  id: "roads", title: "Vehicle Traffic", tileTitle: "Vehicle Traffic", scale: "basic", eyebrow: "The basics", heading: "Vehicle Traffic", need: roadNeed,
  status: (ctx) => isBC(ctx) ? { kind: LIVE, text: "Live", long: "DriveBC Open511 events and highway camera images (Open Government Licence – BC), live; camera list from the BC Data Catalogue" }
    : { kind: PLANNED, text: ctx.place.anywhere || !roadsrc(ctx.place) ? "None" : "Planned", long: ctx.place.anywhere || !roadsrc(ctx.place) ? "No open road feed known for this spot, so no events or cameras are shown"
      : `Planned, not wired: road events and cameras here would come from ${roadsrc(ctx.place)}, whose feeds and terms still need checking (WSDOT, Caltrans, Ontario 511 and city camera feeds). Nothing is shown until then.` },
  source: (ctx) => (isBC(ctx) ? "DriveBC Open511 + cameras · OGL-BC" : roadsrc(ctx.place) ? `${roadsrc(ctx.place)} · planned` : "No open feed here"),
  badge: (d) => (d.bc ? evN(d) : "—"),
  tileKpis: (d) => d.bc ? [[evN(d), d.ev ? `events ${evArea(d)}${nearTxt(d, nearEv(d))}${d.ev.some((x) => evClosed(x.e)) ? " · closures" : ""}` : d.evErr ? "events unavailable" : "events"], [d.cams ? `${d.cams.count}` : "—", `cameras ${evArea(d)}${d.cams ? nearTxt(d, nearSites(d)) : ""}`]]
    : [["—", roadsrc(d.p) && !d.p.anywhere ? "road events planned" : "no road feed"], ["—", roadsrc(d.p) && !d.p.anywhere ? `cameras planned · ${roadsrc(d.p)}` : "no cameras"]],
  kpis: (d) => d.bc ? [...(d.bus ? [["Bus speeds", d.bus.measured ? `${d.bus.slow + d.bus.congested} slow` : "—", d.bus.measured ? `of ${d.bus.measured} stretches measured · ${d.bus.congested} congested` : "too few recent buses"]] : []),
      [d.wide ? "Events" : "Events nearby", evN(d), d.wide ? `Greater Victoria${nearTxt(d, nearEv(d))} · DriveBC, live` : "DriveBC, live"], ["Closures", d.ev ? `${d.ev.filter((x) => evClosed(x.e)).length}` : "—"], ["Cameras", d.cams ? `${d.cams.count}` : "—", d.cams ? `${d.cams.sites.length} sites ${evArea(d)}${nearTxt(d, nearSites(d))}` : "list unavailable"]]
    : [["Road feed", d.p.anywhere || !roadsrc(d.p) ? "None known" : "Planned", d.p.anywhere || !roadsrc(d.p) ? "" : `${roadsrc(d.p)}, not wired yet`]],
  // tile: the nearest camera pictures (live); without cameras, DriveBC events as dots by distance (0–40 km)
  mini: (host, d) => d.cams?.sites.length ? R.camStrip(host, d.cams.sites)
    : d.ev?.length ? RS.signStrip(host, d.ev.map(roadSign), { domain: evDom(d), fmt: (v) => `${v} km` })
    : rowsList(host, d.bc ? [[d.ev ? `No DriveBC events ${evArea(d)}` : "DriveBC unavailable", d.ev ? "clear" : "—"]]
      : [[d.p.anywhere || !roadsrc(d.p) ? "No open road feed here" : `Planned: ${roadsrc(d.p)}`, "—"]], { fit: true }),
  main: (d) => d.bc ? {
    title: "Traffic Cameras",
    sub: d.cams ? `${d.cams.count} DriveBC cameras at ${d.cams.sites.length} sites ${evArea(d)}; the nearest ${Math.min(8, d.cams.sites.length)}. Click one for its other directions. Each picture reloads only when DriveBC posts a new one (about every ${Math.round(d3.median(d.cams.sites, (s) => s.main.period) / 60 || 15)} min).` : "The DriveBC camera list didn't load.",
    draw: (host) => d.cams?.sites.length ? R.camGrid(host, d.cams.sites.slice(0, 8)) : host.replaceChildren(el("p", { class: "note civ-empty" }, d.cams ? `No DriveBC camera ${evArea(d)}.` : "Couldn't load the camera list.")),
    listTitle: "Road Events",
    list: (host) => d.ev?.length ? RS.signRows(host, d.ev.map((x) => ({ kind: RS.evKind(x.e), tone: RS.evTone(x.e), label: `${R.hwy(evRoad(x.e))} · ${Math.round(x.km)} km`,
      value: evClosed(x.e) ? "closed" : RS.KIND_LABEL[RS.evKind(x.e)].toLowerCase(), title: x.e.description }))) : host.replaceChildren(el("p", { class: "note civ-empty" }, d.ev ? `No DriveBC events ${evArea(d)}.` : "Couldn't load DriveBC's events.")),
  } : {
    title: "Road Feed", sub: d.p.anywhere || !roadsrc(d.p) ? "No open road feed is known for this spot." : `Planned, not wired: ${roadsrc(d.p)}'s events and cameras, once their feeds and terms are checked.`,
    draw: (host) => host.replaceChildren(el("p", { class: "note civ-empty" }, d.p.anywhere || !roadsrc(d.p) ? "No open road feed known for this spot, so nothing is shown." : `No road events or cameras are shown for ${d.p.name} yet: the ${roadsrc(d.p)} feed isn't wired. Nothing here is invented.`)),
    listTitle: "Cameras",
    list: (host) => host.replaceChildren(el("p", { class: "note civ-empty" }, "None shown: no camera feed wired here.")),
  },
  extra: (d) => { if (!d.ev?.length) return [];
    const kinds = RS.SIGN_KINDS.map((k) => k.k).filter((k) => d.ev.some((x) => RS.evKind(x.e) === k)), types = kinds.map((k) => RS.KIND_LABEL[k]);
    return [{ title: "Events by Distance", sub: "Each sign is one DriveBC event, by distance from the place (live), coloured by severity.",
      draw: (h) => { const box = el("div", { class: "civ-sstrip-box" }); h.replaceChildren(RS.signLegend(kinds), box);
        const dom = evDom(d), step = dom[1] / 4;
        RS.signStrip(box, d.ev.map((x) => ({ ...roadSign(x), row: kinds.indexOf(RS.evKind(x.e)) })), { domain: dom, rows: types, ticks: [0, 1, 2, 3, 4].map((i) => i * step), fmt: (v) => `${v} km` }); } }]; },
});

export const BASICS = [wx, aq, transit, roads];

// ================================================================== ALERTS: merged from every scale
// item: { sev 1 info · 2 advisory/watch · 3 warning, title, where, until, src, kind, level, href }
const ECCC_SEV = { warning: 3, watch: 2, advisory: 2, statement: 1 };
const NWS_SEV = { Extreme: 3, Severe: 3, Moderate: 2, Minor: 1 };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fWhen = (s) => (s ? d3.timeFormat("%a %-I %p")(new Date(s)) : "");

/** atmospheric-river estimate for the place: IVT ≈ IWV × 850 hPa wind (Open-Meteo), CW3E-style 1–5 scale */
export function arEstimate(ctx) {
  const c = moisture(ll(ctx), ctx); if (c.err) return { err: c.err }; const w = c.data; if (!w) return null;
  return arSeries(w, ll(ctx)[0]);
}
/** IVT series, events and the top event from an Open-Meteo hourly moisture answer (lon: for the Pineapple Express test) */
export function arSeries(w, lon) {
  const h = w.hourly, t = h.time.map((s) => new Date(s)), now = Date.now(), i0 = Math.max(0, t.findIndex((x) => +x > now - 36e5));
  const ivt = h.total_column_integrated_water_vapour.map((v, i) => (v ?? 0) * (h.wind_speed_850hPa[i] ?? 0));
  const series = ivt.slice(i0).map((y, k) => ({ x: t[i0 + k], y, iwv: h.total_column_integrated_water_vapour[i0 + k], dir: h.wind_direction_850hPa[i0 + k] }));
  const events = []; let cur = null;
  for (const p of series) {
    if (p.y >= 250) { if (!cur) events.push(cur = { start: p.x, pts: [] }); cur.pts.push(p); } else cur = null;
  }
  for (const e of events) {
    e.max = d3.max(e.pts, (p) => p.y); e.hours = e.pts.length; e.peak = e.pts.find((p) => p.y === e.max).x;
    const base = e.max >= 1250 ? 5 : e.max >= 1000 ? 4 : e.max >= 750 ? 3 : e.max >= 500 ? 2 : 1;
    e.cat = Math.max(0, Math.min(5, base + (e.hours >= 48 ? 1 : e.hours < 24 ? -1 : 0)));
    const dir = d3.mean(e.pts, (p) => p.dir), iwv = d3.mean(e.pts, (p) => p.iwv);
    e.pineapple = lon < -115 && iwv >= 25 && dir >= 190 && dir <= 260;
  }
  const top = events.slice().sort((a, b) => b.cat - a.cat || b.max - a.max)[0] || null;
  return { series, events, top, max: d3.max(series, (p) => p.y) || 0 };
}

export function collectAlerts(ctx) {
  const p = ctx.place, out = [], checked = [], here = p.short;
  const prov = provinceOf(p);
  // weather warnings: ECCC (polygons cover the point) for Canada and clicked spots in a rough Canada box; NWS for US places.
  // Elsewhere no national warning feed is wired yet (say so rather than imply "all clear").
  const [lon, lat] = p.ll || [0, 0];
  const nearCA = isCA(ctx) || (p.anywhere && lat >= 41.5 && lon >= -141 && lon <= -52);
  if (!isUS(ctx) && !nearCA) checked.push(["National weather warnings", "not wired here"]);
  else if (!isUS(ctx)) {
    const c = ecccAlerts(ctx); checked.push(["ECCC weather alerts", c.data ? LIVE : c.err ? "error" : "…"]);
    if (c.data) {
      const seen = new Set();
      for (const f of c.data) {
        const a = f.properties, k = `${a.alert_name_en}|${a.event_end_datetime}`;
        if (!inGeom(f.geometry, p.ll) || seen.has(k)) continue;
        seen.add(k);
        out.push({ sev: ECCC_SEV[a.alert_type] || 1, title: cap(a.alert_name_en), where: a.feature_name_en, until: a.event_end_datetime, since: a.validity_datetime || a.publication_datetime, src: "ECCC", kind: LIVE, level: p.level === "muni" ? "muni" : p.level, here: true, scaleName: here, text: a.alert_text_en, href: "#now/alerts", id: `eccc:${a.feature_id}:${a.alert_code}`, geo: f.geometry, zoom: 10 });
      }
      if (prov) {
        const others = new Set(c.data.filter((f) => f.properties.province === prov.code && f.properties.alert_type === "warning" && !inGeom(f.geometry, p.ll)).map((f) => f.properties.alert_name_en));
        if (others.size && p.level !== "province") out.push({ sev: 1, title: `${others.size} other warning type${others.size === 1 ? "" : "s"} in ${prov.short}`, where: [...others].join(", "), text: `Elsewhere in ${prov.short}, not covering ${here}.`, src: "ECCC", kind: LIVE, level: "province", scaleName: prov.short, href: "#now/natalerts" });
      }
    }
  } else {
    const c = nwsPoint(p.ll, ctx); checked.push(["NWS alerts", c.data ? LIVE : c.err ? "error" : "…"]);
    for (const f of c.data || []) { const a = f.properties; out.push({ sev: NWS_SEV[a.severity] || 1, title: a.event, where: a.areaDesc?.split(";")[0], until: a.ends || a.expires, since: a.onset || a.effective || a.sent, src: "NWS", kind: LIVE, level: p.level, here: true, scaleName: here, text: a.headline, href: "#now/alerts", id: `nws:${f.id || a.id}`, geo: f.geometry || null, zoom: 10 }); }
  }
  // earthquakes: M4.5+ within 300 km in 48 h (region), M7+ anywhere in 72 h (planet)
  const qw = quakesWeek(ctx); checked.push(["USGS earthquakes", qw.data ? LIVE : qw.err ? "error" : "…"]);
  for (const f of qw.data?.features || []) {
    const pr = f.properties, d = km(f.geometry.coordinates.slice(0, 2), p.ll), age = Date.now() - pr.time;
    if (pr.mag >= 4.5 && d <= 300 && age < 48 * 36e5) out.push({ sev: pr.mag >= 6 ? 3 : 2, title: `M${pr.mag.toFixed(1)} earthquake, ${Math.round(d)} km away`, where: pr.place, until: null, since: pr.time, text: pr.tsunami ? "The tsunami centres flagged it: check Tsunami Status." : "Felt reports and aftershocks on the earthquakes page.", src: "USGS", kind: LIVE, level: p.level === "muni" ? "muni" : "region", here: true, scaleName: "Nearby", href: "#hazard/quakes", id: `usgs:${f.id}`, geo: { type: "Point", coordinates: f.geometry.coordinates.slice(0, 2) }, zoom: 8.5 });
  }
  const qm = quakesMonth(ctx);
  for (const f of qm.data?.features || []) {
    const pr = f.properties;
    if (pr.mag >= 7 && Date.now() - pr.time < 72 * 36e5) out.push({ sev: 1, title: `M${pr.mag.toFixed(1)} earthquake`, where: pr.place, since: pr.time, src: "USGS", kind: LIVE, level: "world", scaleName: "World", href: "#hazard/quakes/world", id: `usgs:${f.id}`, geo: { type: "Point", coordinates: f.geometry.coordinates.slice(0, 2) }, zoom: 5 });
  }
  // road closures nearby (DriveBC, BC only)
  if (isBC(ctx)) {
    const ev = roadEvents(ctx, 50); checked.push(["DriveBC road events", ev && !ev.err ? LIVE : ev?.err ? "error" : "…"]);
    for (const x of (ev && !ev.err ? ev : []).filter((x) => evClosed(x.e)).slice(0, 2)) out.push({ sev: 2, title: `${R.hwy(evRoad(x.e))} closed`, where: `${Math.round(x.km)} km away`, since: x.e.created || x.e.updated, src: "DriveBC", kind: LIVE, level: x.km <= 15 ? (p.level === "muni" ? "muni" : p.level) : "region", here: x.km <= 15, scaleName: "Vehicle Traffic", text: x.e.description, href: "#getting-around/roads", id: `drivebc:${x.e.id}:closed`, geo: x.e.geography || null, zoom: 14 });
  }
  // atmospheric river estimate (west-coast provinces/states)
  if (["bc", "wa", "cal"].includes(prov?.id) || (p.anywhere && p.ll[0] < -115)) {
    const ar = arEstimate(ctx); checked.push(["Atmospheric rivers (estimate)", ar && !ar.err ? LIVE : "…"]);
    const e = ar && !ar.err ? ar.top : null;
    if (e && e.cat >= 2) out.push({ sev: e.cat >= 4 ? 3 : 2, title: `AR${e.cat} atmospheric river${e.pineapple ? " · Pineapple Express" : ""}`, where: `peaks ${fWhen(e.peak)} (estimate)`, since: e.start, text: "Moisture aloft and 850 hPa wind over this spot (Open-Meteo); an estimate, not an official forecast.", src: "Open-Meteo estimate", kind: LIVE, level: p.level === "muni" ? "muni" : p.level, here: true, scaleName: prov?.short || "Coast", href: "#weather/ar" });
  }
  // tsunami: NWS tsunami alerts on this coast (live) + NTWC / PTWC messages (relay or daily snapshot): civic-mod-climate.js
  if (prov && ["bc", "wa", "cal"].includes(prov.id)) { const t = CL.tsunamiData(ctx, prov.id); checked.push(["Tsunami (NWS / NTWC)", t?.nwsOk ? LIVE : t ? DATA : "…"]);
    if (t && t.level >= 1) out.push({ sev: t.level >= 3 ? 3 : 2, title: `Tsunami ${["", "watch", "advisory", "warning"][t.level]}`, where: t.nws[0]?.areaDesc?.split(";")[0] || `${prov.short} coast · NTWC region`, text: "Follow local officials; details on Tsunami Status.", src: t.nws.length ? "NWS" : "NTWC", kind: LIVE, level: "province", here: true, scaleName: prov.short, href: "#hazard/tsunami" }); }
  out.sort((a, b) => b.sev - a.sev || LEVELS.findIndex((l) => l.id === a.level) - LEVELS.findIndex((l) => l.id === b.level));
  const at = weather(ll(ctx), ctx).at || qw.at;
  return { items: out, checked, at, loading: checked.some(([, k]) => k === "…") };
}

export const alerts = mod({
  id: "alerts", title: "Alerts", tileTitle: "Alerts", scale: "alerts", eyebrow: "Alerts · every scale", heading: "Alerts",
  need: (ctx) => collectAlerts(ctx),
  status: () => ({ kind: LIVE, text: "Live", long: "ECCC / NWS weather alerts, USGS, DriveBC, NWS tsunami alerts and an atmospheric-river estimate live; tsunami.gov messages via the relay or daily snapshot" }),
  badge: (d) => (d.items.length ? `${d.items.length}` : "clear"),
  kpis: (d) => [["Active here", `${d.items.filter((x) => x.sev >= 2).length}`, "warnings, watches, closures"], ["For info", `${d.items.filter((x) => x.sev < 2).length}`], ["Sources checked", `${d.checked.length}`]],
  // right column: the Alert Feed (what changed this session, filled by civic-alerts.js into #alerts-feed) over the sources
  html: `<div class="civ-pane civ-alerts-pane">
    <div class="card cx-fill"><h3 class="cx-card-title">Active Alerts</h3><div class="chart civ-alchart" id="alerts-chart"></div><div class="cx-grow civ-scroll" id="alerts-list"></div></div>
    <div class="civ-side">
      <div class="card cx-fill"><h3 class="cx-card-title">Alert Feed</h3><div class="cx-grow civ-scroll" id="alerts-feed"></div></div>
      <div class="card cx-fill"><h3 class="cx-card-title">Sources Checked</h3><div class="cx-grow civ-scroll" id="alerts-src"></div>
        <p class="note civ-why">Every scale feeds this list: the place itself, its region, province or state, country and the planet. Each step outwards only adds what is serious enough to matter here. The same list drives the strip under the top bar.</p></div>
    </div>
  </div>`,
  view: (host, ctx) => {
    const d = collectAlerts(ctx);
    const L = $("alerts-list"), ch = $("alerts-chart");
    ch.hidden = !d.items.length;
    if (d.items.length) {
      const lv = [["muni", "Here"], ["region", "Region"], ["province", "Province / state"], ["country", "Country"], ["world", "World"]];
      const at = (x) => (lv.some(([k]) => k === x.level) ? x.level : "muni");
      C.stackBars(ch, lv.map(([k, label]) => ({ label, vals: [3, 2, 1].map((sv) => d.items.filter((x) => at(x) === k && (sv === 1 ? x.sev <= 1 : x.sev === sv)).length) })).filter((r) => d3.sum(r.vals)),
        [{ name: "Warning", c: "bad" }, { name: "Watch / advisory", c: "warn" }, { name: "Information", c: "s3" }], { fmt: (v) => `${v}`, max: 5 });
    }
    if (!d.items.length) L.replaceChildren(el("p", { class: "civ-clear" }, d.loading ? "Checking…" : `All clear for ${ctx.place.name}.`), el("p", { class: "note" }, "Warnings, watches, closures and nearby earthquakes land here as soon as a source posts them."));
    else L.replaceChildren(...d.items.map((x) => el("a", { class: "civ-alert", href: x.href, "data-sev": x.sev },
      el("div", { class: "civ-alert-h" }, el("i", { class: "civ-sev", "data-sev": x.sev }), el("b", {}, x.title), el("em", { class: "civ-tag", "data-kind": x.kind }, x.kind)),
      el("div", { class: "civ-alert-s" }, [x.where, x.until ? `until ${fWhen(x.until)}` : null, `${x.src} · ${x.scaleName}`].filter(Boolean).join(" · ")),
      x.text ? el("p", { class: "civ-alert-t" }, x.text.split("\n").filter(Boolean).slice(0, 2).join(" ").slice(0, 260)) : null)));
    if (d.items.length) [...L.querySelectorAll(":scope > .civ-alert")].forEach((n, i) => { n.opAlert = d.items[i]; n.dataset.alert = ""; });   // a click fits the map to it (civic-alerts.js tagAlert)
    rowsList("alerts-src", d.checked.map(([n, k]) => [n, k === "…" ? "checking" : k === LIVE || k === MOCK ? "" : k, 0, { tag: k === LIVE || k === MOCK ? k : null }]));
  },
});

// ================================================================== REGION: Growth & Building (Greater Victoria)
// Every CRD municipality on a choropleth with a metric switch, the place outlined, a ranked list, housing starts and,
// for Langford, the 12-month forecast panel: data, layers and panels in civic-mod-growth.js (id kept as "langford")
export const langford = mod({
  id: "langford", title: "Growth & Building", tileTitle: "Growth & Building", scale: "region", at: ["crd"], reach: 2, tag: "Greater Victoria",
  eyebrow: "Greater Victoria", heading: "Growth & Building",
  ...GR.growthDef({ lineChart, colChart }),
});
// Local Stops (Langford): the busiest stops nearest the centre with live departures (else the timetable), a small map
// with live buses, and West Shore road speeds estimated from bus movements. Data and pollers: civic-mod-transit.js
const lsLevel = (r) => (r.level === "slow" ? 2 : r.level === "busy" ? 1 : 0);
const lsRow = (g, r) => [`${r.route.name} → ${r.head}`, WS.whenTxt(r), 0, { title: `${g.name}${r.live.length ? ` · live prediction${r.live[0].delay != null ? `, ${Math.round(r.live[0].delay / 60)} min vs timetable` : ""}` : " · timetable"}`, tag: r.live.length ? LIVE : null }];
const lsFirst = (d) => d.groups.flatMap((g) => g.rows.slice(0, 1).map((r) => ({ g, r }))).sort((a, b) => a.r.sort - b.r.sort)[0];
// roads with a live speed, those resting on two or more buses first (one bus waiting at a stop says little)
const lsSpeeds = (d) => { const r = (d.traffic?.rows() || []).filter((x) => x.ratio != null); return [...r.filter((x) => x.n >= 2), ...r.filter((x) => x.n < 2)]; };
const lsShort = (g) => `${g.n} · ${g.name.replace(/ at /, " / ").replace(/\b(Ave|Rd|St|Pky|Pkwy|Dr|Blvd)\b\.?/g, "").replace(/\s+/g, " ").replace(/ \//, " /").trim()}`;
export const lstops = mod({
  id: "lstops", xBig: true, title: "Local stops", scale: "muni", at: ["langford"], reach: 2, eyebrow: "Langford", heading: "Local Stops",
  need: (ctx) => WS.localStops(ctx),
  status: (ctx) => { const d = WS.localStops(ctx); const live = !!d?.predAt;
    return { kind: live || !d ? LIVE : DATA, text: live || !d ? "Live" : "Timetable",
      long: `${WS.STOPS_CREDIT}: stops and timetable (GTFS), live predictions and bus positions (GTFS-Realtime) through the relay${d?.predErr ? "; predictions not answering, showing the timetable" : ""}. Road speeds are estimated from bus movements.` }; },
  source: () => WS.STOPS_CREDIT,
  badge: (d) => { const f = lsFirst(d); return f ? WS.whenTxt(f.r) : ""; },
  tileKpis: (d) => { const f = lsFirst(d), sp = lsSpeeds(d)[0];
    return [[f ? WS.whenTxt(f.r) : "—", f ? `${f.r.route.name} at ${f.g.name}` : "no service now"],
      sp ? [`${Math.round(sp.kmh)} km/h`, `${sp.title} buses · typical ${Math.round(sp.typical)} (estimate)`] : [`${d.nLive}`, d.predAt ? "live predictions" : "live predictions loading"]]; },
  kpis: (d) => { const f = lsFirst(d), sp = lsSpeeds(d);
    return [["Next departure", f ? WS.whenTxt(f.r) : "—", f ? `${f.r.route.name} → ${f.r.head} · ${f.g.name}` : ""], ["Stops", `${d.groups.length}`, `busiest within 1.5 km of ${d.p.short || d.p.name}'s centre`],
      ["Live predictions", `${d.nLive}`, d.predAt ? `updated ${d3.timeFormat("%-I:%M %p")(d.predAt)}` : d.predErr ? "not answering: timetable shown" : "loading…"],
      sp[0] ? ["Slowest road", `${Math.round(sp[0].kmh)} km/h`, `${sp[0].title} · typical ${Math.round(sp[0].typical)} · estimated from buses`] : ["Road speeds", "measuring", "estimated from bus movements"]]; },
  // tile: the stops on a small map with live buses (a strip of next departures when the tile is short)
  mini: (host, d) => (host.clientHeight >= 100 ? WS.localMap(host, d, { mini: true })
    : C.strip(host, d.groups.map((g) => g.rows[0]).filter((r) => r && (r.live.length || r.sch.running)).map((r) => ({ x: Math.min(30, r.live[0]?.min ?? (r.sch.gap || 30) / 2), title: `${r.route.name} → ${r.head}`, note: WS.whenTxt(r) })), { domain: [0, 30], now: 0, fmt: (v) => (v ? `${v} min` : "now") })),
  main: (d) => ({ title: "Next Departures", sub: `The ${d.groups.length} busiest stops nearest ${d.p.short || d.p.name}'s centre, numbered as on the map. LIVE marks a real-time prediction; the others are what the timetable promises.`,
    draw: (host) => rowsList(host, d.groups.flatMap((g) => [[`${g.n} · ${g.name}`, `${Math.round(g.m / 10) * 10} m`, 0, { hl: true, title: `${g.stops.length} stop${g.stops.length > 1 ? "s" : ""} · ${g.deps} weekday departures` }],
      ...g.rows.filter((r) => r.live.length || r.sch.running).slice(0, 5).map((r) => lsRow(g, r))])),
    listTitle: "Road Speeds",
    list: (host) => { const rows = d.traffic?.rows() || [], live = lsSpeeds(d);
      rowsList(host, [...(live.length ? live : rows.filter((r) => r.typical).slice(0, 6)).map((r) => [r.title, r.kmh == null ? `– · typical ${Math.round(r.typical)}` : `${Math.round(r.kmh)} km/h · typical ${Math.round(r.typical)} · ${r.n} bus${r.n === 1 ? "" : "es"}`, 0,
        { sev: lsLevel(r), title: `${r.long}: ${r.n} bus${r.n === 1 ? "" : "es"} in the last 10 min; typical from ${r.typSrc === "log" ? "logged bus speeds" : r.typSrc === "tt" ? "the timetable" : "this browser's record"} for this hour` }]),
        ["Estimated from bus movements, not a traffic feed", "estimate", 0, { title: "Average speed of buses along each road over the last 10 minutes (stops included), against the usual bus speed there at this hour. An alert is raised when buses fall below half the typical speed with at least two buses seen." }]]); } }),
  extra: (d) => [
    { w: 1.3, title: "Stop Map", sub: `Numbered stops, the routes serving them and live buses (${WS.STOPS_CREDIT}).`, draw: (h) => WS.localMap(h, d, { tip, el, tipRow }) },
    { title: "Next 30 Minutes", sub: "Filled: live predictions. Hollow: the timetable's usual gap (an estimate, not a scheduled time).",
      draw: (h) => { const rows = d.groups.map(lsShort);
        C.strip(h, d.groups.flatMap((g, row) => g.rows.flatMap((r) => (r.live.length ? r.live.filter((x) => x.min <= 30).map((x) => ({ x: x.min, row, title: `${r.route.name} → ${r.head}`, note: x.min <= 0 ? "due (live)" : `in ${x.min} min (live)` }))
          : r.sch.running && r.sch.gap ? d3.range(Math.round(r.sch.gap / 2), 31, r.sch.gap).map((m) => ({ x: m, row, tone: "s3", r: 3, title: `${r.route.name} → ${r.head}`, note: `about every ${r.sch.gap} min (timetable)` })) : []))),
        { domain: [0, 30], rows, now: 0, ticks: [0, 10, 20, 30], fmt: (v) => (v ? `+${v} min` : "now") }); } },
  ],
});
// City Notices (City of Langford news, pages, council and committee meetings on eSCRIBE) and Public Safety (West Shore
// RCMP, plus other agencies' releases that concern Langford, mapped incidents, StatCan Crime Severity Index): both
// Langford only. Data, panels and alert detectors in civic-mod-local.js, drawn with this file's chart kit
export const lnotices = mod({
  id: "lnotices", xBig: true, title: "City Notices", tileTitle: "City Notices", scale: "muni", at: ["langford"], reach: 1, tag: "Langford", eyebrow: "Langford", heading: "City Notices",
  ...L.notices({ rowsList, lineChart, colChart }),
});
export const crime = mod({
  id: "crime", xBig: true, title: "Public Safety", tileTitle: "Public Safety", scale: "muni", at: L.PS_PLACES, reach: 2, eyebrow: "Municipality", heading: "Public Safety",
  ...L.police({ rowsList, lineChart, colChart }),
});

// ================================================================== REGION
const quakeNeed = (ctx) => {
  const c = L.quakesNear(ctx); if (c.err) return { err: c.err }; if (!c.data) return null;
  const qs = c.data.features.map((f) => ({ mag: f.properties.mag, place: f.properties.place, t: new Date(f.properties.time), ll: f.geometry.coordinates.slice(0, 2), src: f.properties.src }))
    .map((q) => ({ ...q, km: km(q.ll, ll(ctx)) })).filter((q) => q.km <= 300).sort((a, b) => b.t - a.t);
  return { qs };
};
export const quakes = mod({
  id: "quakes", title: "Earthquakes", tileTitle: "Earthquakes", scale: "region", at: "*", reach: 2, eyebrow: "Region", heading: "Earthquakes", need: quakeNeed,
  // one page for nearby quakes and the world's M6+ (#hazard/quakes/world): map stage and panels in civic-mod-hazards.js
  stage: HZ.quakeStage({ quakeNeed, bigNeed: (ctx) => bigNeed(ctx) }),
  urgent: (ctx) => { const d = quakeNeed(ctx); return !!d?.qs?.some((q) => q.mag >= 4.5 && Date.now() - q.t < 48 * 36e5); },
  status: L.quakeStatus,   // USGS, merged with Natural Resources Canada's catalogue for Canadian places (civic-mod-local.js)
  source: L.quakeSource,
  badge: (d) => `${d.qs.length}`,
  tileKpis: (d) => [[`${d.qs.length}`, "M2.5+ within 300 km, 7 d"], [d.qs.length ? `M${d3.max(d.qs, (q) => q.mag).toFixed(1)}` : "—", "largest"]],
  kpis: (d, ctx) => { const b = bigNeed(ctx), w = b && !b.err ? b.qs : null;
    return [["Quakes nearby", `${d.qs.length}`, "M2.5+, 300 km, 7 days"], ["Largest", d.qs.length ? `M${d3.max(d.qs, (q) => q.mag).toFixed(1)}` : "—"], ["Latest", d.qs.length ? ago(d.qs[0].t) : "—"],
      ["Worldwide M6+", w ? `${w.length}` : "…", w?.length ? `past 30 days · largest M${d3.max(w, (q) => q.mag).toFixed(1)}` : "past 30 days"]]; },
  // tile: the week's quakes as dots, when (across) and how big (up and dot size)
  mini: (host, d) => C.quakeDots(host, d.qs, { domain: weekAgo(7), fmt: (v) => (+v > Date.now() - 36e5 ? "now" : "7 d ago"), empty: "quiet week" }),
  // alerts (civic-alerts.js): each new M2.5+ within 300 km in the past day; M4+ (a size people feel) is a warning.
  // Worldwide (was the Big earthquakes leaf): a new M6+ anywhere in the past day (information), M7+ a notice.
  detect: (d, ctx) => [
    ...d.qs.filter((q) => Date.now() - q.t < 24 * 36e5).map((q) => ({ id: `${+q.t}:${q.mag}`, level: q.mag >= 4 ? "warn" : "notice", href: "#hazard/quakes",
      title: `M${q.mag.toFixed(1)} earthquake, ${Math.round(q.km)} km away`, body: `${q.place}, ${hhmm(q.t)} (${q.src || "USGS · NRCan"}).`, geo: { type: "Point", coordinates: q.ll }, zoom: 8.5 })),
    ...((bigNeed(ctx) || {}).qs || []).filter((q) => Date.now() - q.t < 24 * 36e5).map((q) => ({ id: `w:${+q.t}:${q.mag}`, level: q.mag >= 7 ? "notice" : "info", href: "#hazard/quakes/world",
      title: `M${q.mag.toFixed(1)} earthquake`, body: `${q.place}${q.tsu ? "; USGS has set its tsunami flag (check local warnings)" : ""} (USGS).` })),
  ],
  main: (d) => ({
    title: "Earthquakes within 300 km, past week", sub: "USGS and, in Canada, Natural Resources Canada, live. Each dot is one quake: when it happened (across) and its magnitude (up, and dot size).",
    draw: (host) => d.qs.length ? C.quakeDots(host, d.qs, { domain: weekAgo(7), fmt: d3.timeFormat("%a %-d"), top: 4.5 }) : host.replaceChildren(el("p", { class: "note civ-empty" }, "No M2.5+ earthquakes within 300 km this week.")),
    listTitle: "Every quake",
    list: (host) => rowsList(host, d.qs.map((q) => [`M${q.mag.toFixed(1)} ${q.place}`, ago(q.t)])),
  }),
  extra: (d) => d.qs.length ? [{ title: "How far away", sub: "The same quakes by distance from the place (across) and magnitude (up). Close and big is what you'd feel.",
    draw: (h) => C.quakeDots(h, d.qs, { key: "km", domain: [0, 300], fmt: (v) => `${v} km`, top: 4.5 }) }] : [],
});
const weekAgo = (n) => [new Date(Date.now() - n * 864e5), new Date()];

const GROUPS = ["plum", "early", "yoshino", "japanese", "wild", "bitter"];
const blossomNeed = (ctx) => { const d = both(file("blossom/forecast.json", ctx), file("blossom/meta.json", ctx)); if (!d || d.err) return d; const [f, meta] = d; const k = dataKey(ctx.place, "blossom"); return { f, meta, r: f.regions[k], k }; };
const blossomRows = (d) => GROUPS.filter((g) => d.r.groups[g]).map((g, i, a) => { const x = d.r.groups[g]; return { label: d.meta.groups[g].label.split(" (")[0], p10: parseDay(x.p10), p25: parseDay(x.p25), mid: parseDay(x.median), p75: parseDay(x.p75), p90: parseDay(x.p90), op: 1 - (i / a.length) * 0.55 }; });
const blossomState = (d, ctx) => {
  const rows = blossomRows(d), season = d.f.season, now = ctx.date.getMonth() < 7 ? pretendIn(ctx, season) : pretendIn(ctx, season - 1);
  const head = rows.find((r) => r.label.startsWith("Yoshino")) || rows[0], open = rows.filter((r) => now >= r.p10 && now <= r.p90), n = dayDiff(now, head.mid);
  return { rows, head, now, open, text: open.length ? `${open.length} in bloom` : n > 0 ? `peak in ${n} d` : "done for the year" };
};
const trees = (d) => { const by = d.meta.counts.trees_by_city, cs = Object.keys(d.meta.cities || {}).filter((c) => d.meta.cities[c].region === d.k); return cs.length ? cs.reduce((n, c) => n + (by[c] || 0), 0) : by[d.k]; };
export const blossom = mod({
  id: "blossom", title: "Cherry Blossom Watch", tileTitle: "Cherry Blossom Watch", scale: "region", at: ["crd", "metrovan"], reach: 2, eyebrow: "Region", heading: "Cherry Blossom Watch", need: blossomNeed,
  season: (m) => bump(m, 3.75, 0.62),
  status: (ctx) => { const c = file("blossom/forecast.json", ctx).data; return { kind: DATA, text: c ? asOf(c.issued) : "Data", long: `Published forecast (blossom/forecast.json), issued ${c?.issued || "…"}` }; },
  source: () => "Street-tree inventories + forecast",
  badge: (d, ctx) => fDate(blossomState(d, ctx).head.mid),
  tileKpis: (d, ctx) => { const s = blossomState(d, ctx); return [[fDate(s.head.mid), "Yoshino peak (median)"], [s.text, `on ${fDate(ctx.date)}`], [f0(trees(d)), "mapped trees"]]; },
  kpis: (d, ctx) => { const s = blossomState(d, ctx); return [["Yoshino peak", fDate(s.head.mid), `80%: ${fDate(s.head.p10)}–${fDate(s.head.p90)}`], ["First to open", fDate(s.rows[0].mid), s.rows[0].label], ["Right now", s.text], ["Trees mapped", f0(trees(d))]]; },
  // tile: the forecast ranges per tree group; at sparkline size, just the Yoshino window with the date
  mini: (host, d, ctx) => { const s = blossomState(d, ctx), y = d.f.season, dom = [new Date(y, 1, 20), new Date(y, 4, 12)];
    if (C.size(host).H < 40) return C.seasonBar(host, { lo: dom[0], hi: dom[1], p10: s.head.p10, p90: s.head.p90, mid: s.head.mid, now: s.now, title: `${s.head.label} peak` });
    rangeChart(host, s.rows, { mini: true, color: "var(--s1)", domain: dom, mark: s.now }); },
  main: (d, ctx) => { const s = blossomState(d, ctx), y = d.f.season; return {
    title: `${y} peak-bloom forecast by tree group`, sub: "Bar = middle 50%, line = 80% range, dot = median peak. Dashed = the date.",
    draw: (host) => rangeChart(host, s.rows, { color: "var(--s1)", domain: [new Date(y, 1, 15), new Date(y, 4, 15)], mark: s.now }),
    listTitle: "Median peak by group",
    list: (host) => rowsList(host, s.rows.map((r) => [r.label, `${fDate(r.mid)} · ${relDays(dayDiff(s.now, r.mid))}`, 0, { hl: s.open.includes(r) }])),
  }; },
});

const foliageNeed = (ctx) => { const c = file("foliage/foliage.json", ctx); if (c.err) return { err: c.err }; if (!c.data) return null; const k = dataKey(ctx.place, "foliage"); return { fo: c.data, c: c.data.cities[k], k }; };
const foliageState = (d, ctx) => {
  const y = d.fo.season, g = d.c.mgd, now = pretendIn(ctx, y), doyNow = d3.timeDay.count(new Date(y, 0, 0), now), p50 = doyToDate(g.p50, y), n = dayDiff(now, p50);
  return { y, g, now, doyNow, p50, text: doyNow >= g.p10 && doyNow <= g.p90 ? "turning now" : n > 0 ? `peak in ${n} d` : `peaked ${-n} d ago` };
};
export const foliage = mod({
  id: "foliage", title: "Fall Foliage Watch", tileTitle: "Fall Foliage Watch", scale: "region", at: ["crd", "metrovan", "toronto"], reach: 2, eyebrow: "Region", heading: "Fall Foliage Watch", need: foliageNeed,
  season: (m) => bump(m, 10.35, 0.7),
  status: (ctx) => { const c = file("foliage/foliage.json", ctx).data; return { kind: DATA, text: c ? asOf(c.generated) : "Data", long: `Published forecast (foliage/foliage.json), ${c?.season || ""} season` }; },
  source: () => "Mapped trees + degree-day model",
  badge: (d, ctx) => fDate(foliageState(d, ctx).p50),
  tileKpis: (d, ctx) => { const s = foliageState(d, ctx); return [[fDate(s.p50), `peak colour ${s.y}`], [s.text, `on ${fDate(ctx.date)}`], [f0(d.c.n_trees), "mapped trees"]]; },
  kpis: (d, ctx) => { const s = foliageState(d, ctx); return [["Peak colour", fDate(s.p50), `${s.y} median`], ["80% range", `${fDate(doyToDate(s.g.p10, s.y))}–${fDate(doyToDate(s.g.p90, s.y))}`], ["Right now", s.text], ["Mapped trees", f0(d.c.n_trees)]]; },
  mini: (host, d, ctx) => { const s = foliageState(d, ctx);
    if (C.size(host).H < 40) return C.seasonBar(host, { lo: doyToDate(250, s.y), hi: doyToDate(312, s.y), p10: doyToDate(s.g.p10, s.y), p90: doyToDate(s.g.p90, s.y), mid: s.p50, now: s.now, title: "Peak colour" });
    histChart(host, s.g.sims, { mini: true, year: s.y, color: "var(--s1)", domain: [250, 312], mark: s.doyNow }); },
  main: (d, ctx) => { const s = foliageState(d, ctx); const sites = Object.values(d.fo.sites).filter((x) => x.region === d.k); return {
    title: `${d.c.name} peak colour, ${s.y}`, sub: "Each bar counts simulated peak dates from the model; the solid line is the median.",
    draw: (host) => histChart(host, s.g.sims, { year: s.y, color: "var(--s1)", domain: [250, 312], mark: s.doyNow }),
    listTitle: "Peaks nearby",
    list: (host) => rowsList(host, sites.map((x) => [x.name, x.forecast ? fDate(doyToDate(x.forecast.p50, s.y)) : "no forecast"])),
  }; },
});

const sundayNeed = (ctx) => { const c = file("sunday/sunday.json", ctx); if (c.err) return { err: c.err }; if (!c.data) return null; const r = c.data.regions[dataKey(ctx.place, "sunday")]; return { r, routes: r.routes.slice().sort((a, b) => b.score - a.score) }; };
export const sunday = mod({
  id: "sunday", title: "Sunday Wanders", tileTitle: "Sunday Wanders", scale: "region", at: ["crd", "metrovan"], reach: 1, eyebrow: "Region", heading: "Sunday Wanders", need: sundayNeed,
  season: (m) => 0.25 + 0.7 * bump(m, 7, 2.4),
  status: (ctx) => { const c = file("sunday/sunday.json", ctx).data; return { kind: DATA, text: c ? asOf(c.generated) : "Data", long: "Published routes (sunday/sunday.json)" }; },
  source: () => "OpenStreetMap routes",
  badge: (d) => `${d.routes.length} loops`,
  tileKpis: (d) => [[`${d.routes.length}`, "curated loops"], [d.routes[0].name, `best ${d.routes[0].mode} loop`]],
  kpis: (d) => [["Curated loops", `${d.routes.length}`], ["Best rated", d.routes[0].name, `${d.routes[0].mode} · ${Math.round(d.routes[0].km)} km`], ["Stops mapped", f0(d.r.n_stops)]],
  // tile: loops with a bar for their scenic score; at sparkline size, the scores as columns (best first)
  mini: (host, d) => { const mx = d.routes[0].score || 1;
    if (C.size(host).H < 60) return colChart(host, d.routes.slice(0, 10).map((r, i) => ({ label: "", v: r.score, hl: i === 0, title: `${r.name} (${r.mode}, ${Math.round(r.km)} km)` })), { mini: true, labels: false, color: "var(--s1)", unit: "scenic score", fmt: d3.format(".2f") });
    rowsList(host, d.routes.slice(0, 6).map((r) => [`${r.name}`, `${r.mode} · ${Math.round(r.km)} km`, r.score / mx]), { fit: true, bars: true }); },
  main: (d) => ({
    title: `Loops in ${d.r.name}, by scenic score`, sub: "Score blends water, green, farm and sights along the way, minus busy roads.",
    draw: (host) => renderBars(host, d.routes.map((r) => [`${r.name} (${r.mode})`, r.score, r.id, r.blurb]), "--s1", d3.format(".2f"), 230),
    listTitle: "Tier S loops",
    list: (host) => rowsList(host, d.routes.filter((r) => r.tier === "S").map((r) => [r.name, `${Math.round(r.km)} km · ${Math.round(r.minutes)} min`, 0, { title: r.blurb }])),
  }),
});

const ORCA_MONTHS = [79, 104, 285, 394, 512, 738, 882, 920, 782, 338, 167, 101];
const salishNeed = (ctx) => { const c = file("salish/salish.json", ctx); if (c.err) return { err: c.err }; if (!c.data) return null; return { s: c.data, node: chainOf(ctx.place).some((n) => n.id === "seattle") ? "rpi_sunset_bay" : "rpi_orcasound_lab" }; };
export const salish = mod({
  id: "salish", title: "Whale Watching", tileTitle: "Whale Watching", tag: "Salish Sea", scale: "region", at: ["crd", "metrovan", "seattle"], reach: 1, eyebrow: "Salish Sea", heading: "Whale Watching", need: salishNeed,
  season: monthly(ORCA_MONTHS),
  status: (ctx) => { const c = file("salish/salish.json", ctx).data; return { kind: DATA, text: c ? asOf(c.generated) : "Data", long: "Published data (salish/salish.json): hydrophone reports, sightings, outlook" }; },
  source: () => "Orcasound + iNaturalist",
  badge: (d) => `${d.s.tiers.counts.S} calls`,
  tileKpis: (d) => [[`${d.s.tiers.counts.S}`, "top-tier calls, 30 d"], [`${d.s.sightings_7d.n}`, "whale reports, 7 d"], [`${Math.round(d.s.outlook.forecast[d.node].p * 100)}%`, "heard next week"]],
  kpis: (d) => [["Top-tier calls", `${d.s.tiers.counts.S}`, "last 30 days"], ["Whale reports", `${d.s.sightings_7d.n}`, "last 7 days"], ["Next week", `${Math.round(d.s.outlook.forecast[d.node].p * 100)}%`, `chance heard · ${d.s.hydrophones[d.node].name}`]],
  mini: (host, d, ctx) => colChart(host, d.s.inat_season.Orca.map((v, i) => ({ label: MONTHS[i][0], v, hl: i === ctx.date.getMonth(), title: `${MONTHS[i]}: orca observations` })), { mini: true, labels: true, color: "var(--s1)", unit: "orca observations" }),
  main: (d, ctx) => ({
    title: "When whales are seen, by month", sub: "iNaturalist observations in the Salish Sea, all years.",
    draw: (host) => lineChart(host, Object.entries(d.s.inat_season).filter(([k]) => k !== "Minke whale").map(([k, v], i) => ({ name: k, values: v.map((y, m) => ({ x: m + 1, y })),
      color: `var(--s${i + 1})`, cssVar: `--s${i + 1}`, area: i === 0 })), { xTicks: d3.range(1, 13), xFmt: (m) => MONTHS[m - 1], marks: [{ x: ctx.month, label: "now" }], tipX: (m) => MONTHS[Math.round(m) - 1], yZero: true }),
    listTitle: "Latest confirmed calls",
    list: (host) => rowsList(host, d.s.recent_confirmed.slice(0, 10).map((c) => [`${c.name} · ${String(c.tags || "").replaceAll(";", ", ").replace("srkw", "Southern Residents")}`, d3.timeFormat("%b %-d, %-I:%M %p")(new Date(c.time)), 0, { title: c.tags }])),
  }),
});

// Golfing (Things to Do): "should I play, and where, right now?" (civic-mod-golf.js)
export const golf = mod(golfDef({ LIVE, DATA, PLANNED, rowsList }));

// Parks & Trails (Nature): civic-mod-trails.js
export const trails = mod(trailsDef({ LIVE, DATA, PLANNED, rowsList }));
// What's Hot Now (Lifestyle, first): civic-mod-hot.js
export const hot = mod(hotDef({ LIVE, DATA, PLANNED, rowsList }));
export const surf = mod(surfDef({ LIVE, DATA, PLANNED, rowsList }));
export const oaks = mod(oaksDef({ DATA, rowsList, bump }));
export const wildlife = mod(wildDef({ LIVE, rowsList }));
export const events = mod(eventsDef({ LIVE, DATA, PLANNED, rowsList }));

const r95Need = (ctx) => { WS.touch(ctx); const c = file("blink/blink.json", ctx); if (c.err) return { err: c.err }; return c.data ? { b: c.data } : null; };   // touch: West Shore road-speed alerts
const pct = (v) => `${Math.round(v * 100)}%`;
export const route95 = mod({
  // a set piece of Public Transit for Langford and the West Shore (and the CRD as a whole), not for the rest of the region
  id: "route95", title: "Route 95 Spotlight", scale: "region", at: ["crd"], reach: 2, eyebrow: "Region", heading: "Route 95 Spotlight", need: r95Need,
  only: (ctx) => SPOTLIGHT_PLACES.has(ctx.place.id),
  status: (ctx) => { const c = file("blink/blink.json", ctx).data; return { kind: DATA, text: c ? asOf(c.generated) : "Data", long: `Published data (blink/blink.json): BC Transit GTFS-Realtime vs schedule${c ? `, ${c.headline.days} day(s) tracked so far` : ""}` }; },
  source: (ctx) => { const c = file("blink/blink.json", ctx).data; return c ? `BC Transit realtime · ${c.headline.days} day tracked` : "BC Transit realtime"; },
  badge: (d) => pct(d.b.headline.punctuality.on_time),
  tileKpis: (d) => [[pct(d.b.headline.punctuality.on_time), "trips on time"], [`${d.b.headline.punctuality.median_delay_min.toFixed(1)} min`, "median delay"], [`${d.b.headline.wait.ewt_min.toFixed(1)} min`, "extra wait"]],
  kpis: (d) => [["On time", pct(d.b.headline.punctuality.on_time), `${d.b.headline.punctuality.trips} trips`], ["Median delay", `${d.b.headline.punctuality.median_delay_min.toFixed(1)} min`], ["Extra wait", `${d.b.headline.wait.ewt_min.toFixed(1)} min`, "vs a perfect schedule"], ["Tracked", `${d.b.headline.days} day${d.b.headline.days === 1 ? "" : "s"}`]],
  mini: (host, d) => { const rows = [{ route: "95", p: d.b.headline.punctuality }, ...d.b.compare_routes.map((r) => ({ route: r.route, p: r.punctuality }))];
    colChart(host, rows.map((r) => ({ label: r.route, v: Math.round(r.p.on_time * 100), hl: r.route === "95", title: `Route ${r.route}` })), { mini: true, labels: true, color: "var(--s1)", unit: "% on time", min: 0, max: 100 }); },
  main: (d) => ({ title: "Share of trips on time, by route", sub: "On time = between 1 min early and 5 min late at timing points. Early data: few days tracked.",
    draw: (host) => { const rows = [{ route: "95", p: d.b.headline.punctuality }, ...d.b.compare_routes.map((r) => ({ route: r.route, p: r.punctuality }))];
      colChart(host, rows.map((r) => ({ label: `Route ${r.route}`, v: Math.round(r.p.on_time * 100), hl: r.route === "95" })), { color: "var(--s1)", unit: "% on time", max: 100, yFmt: (v) => `${v}%` }); },
    listTitle: "Definitions", list: (host) => rowsList(host, Object.entries(d.b.definitions || {}).slice(0, 6).map(([k, v]) => [k.replaceAll("_", " "), String(v).slice(0, 60), 0, { title: String(v) }])) }),
});

// ------------------------------------------------------------------ air traffic (Air Traffic)
// Any place: aircraft within 40 km of it from adsb.lol through the relay (ODbL), coloured by kind of flight and sized by
// weight class as on the Air Traffic radar, the next close pass and any rare aircraft, plus the nearest airports
// (OurAirports). Greater Victoria adds the logged busy hours and YYJ / harbour movements, and falls back to the last
// logged poll until the relay answers. The page is the map stage below: aircraft, airports (click one for its card) and the panel.
// The feed is the page's (src/air/layer.js airFeed): the same 22 nm circle, so tile and page share the relay's cached
// snapshot and agree on the count (40 km, the page's widest ring); polled every 30 s with retries and backoff; aircraft
// held (fading) for a minute when they drop out of a report and moved on along their track between reports; and the
// status says "Delayed" / "Feed down" from the newest report's age instead of flipping to "No feed" on one failure.
const AIR_NM = 22, AIR_KM = 40;
const airIsCRD = (p) => chainOf(p).some((n) => n.id === "crd");
/** the feed's circle (nm): in Greater Victoria the relay's hub already holds every aircraft within 46 nm of 48.5,-123.5,
 *  so the feed takes the widest circle around the place that fits inside it (no extra upstream calls: livehub.js cuts it
 *  from the same snapshot); elsewhere 22 nm from /air/point.json. Tiles and alerts still count within AIR_KM. */
const airNmFor = (lat, lon, place) => { if (!hubSetFor(place)) return AIR_NM; for (let nm = 40; nm > AIR_NM; nm -= 2) if (hubAirCovers(lat, lon, nm)) return nm; return AIR_NM; };
const airMapKm = (p) => airNmFor(p.ll[1], p.ll[0], p) * 1.852;
let airW = null;   // { key, feed, seen }: one live feed, for the place on screen; dropped 2 min after nobody asks
export function airWatch(lat, lon, crd, ctx) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (airW?.key !== key) {
    airW?.feed.stop();
    const feed = airFeed({ lat, lon, nm: airNmFor(lat, lon, ctx?.place), every: 30000, common: crd ? ["DHC2", "DHC3"] : [], set: hubSetFor(ctx?.place) });   // CRD: the relay hub's /live (livehub.js)
    let sig = "";
    feed.on(() => { const s = feed.state(), n = `${s.level}|${feed.track().asOf}|${s.err ? s.err.message : ""}`; if (n !== sig) { sig = n; ctx?.refresh?.(); } });
    airW = { key, feed, seen: Date.now() };
  }
  airW.seen = Date.now();
  return airW.feed;
}
setInterval(() => { if (airW && Date.now() - airW.seen > 120000) { airW.feed.stop(); airW = null; } }, 30000);
const airNeed = (ctx) => {
  const p = ctx.place, [lon, lat] = p.ll, crd = airIsCRD(p);
  const feed = airWatch(lat, lon, crd, ctx), fs = feed.state();
  const snap = crd ? file("air/air.json", ctx) : null;
  const ap = crd ? file("air/airports.json", ctx) : file("air/world.json", ctx);
  if ((fs.level === "connecting" && !fs.err) || (crd && !snap.data && !snap.err) || (!ap.data && !ap.err)) return null;
  let list = null, kind = LIVE, asOf = null;
  const R = AIR_KM;
  if (fs.level !== "connecting") { list = feed.list().filter((a) => !/^C/.test(a.cat || "") && a.km <= R); asOf = new Date(feed.track().asOf * 1000); }
  else {
    if (snap?.data?.latest?.epoch) { list = snap.data.latest.aircraft; kind = DATA; asOf = new Date(snap.data.latest.epoch * 1000); }
    else kind = MOCK;
    const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
    list = (list || []).filter((a) => !/^C/.test(a.cat || "")).map((a) => {
      const e = (a.lon - lon) * kx, n = (a.lat - lat) * 110.57;
      return { ...a, km: Math.hypot(e, n), kind: kindOf(a), rare: rareOf(a, crd ? ["DHC2", "DHC3"] : []), pass: airborne(a) ? closestApproach(e, n, a.gs, a.track) : null };
    }).filter((a) => a.km <= R);
  }
  const airports = !ap.data ? [] : crd
    ? ap.data.airports.filter((x) => /large|medium/.test(x.type) || x.icao === "CYWH").map((x) => ({ id: x.iata || x.icao || x.ident, name: x.name, km: airKm(lat, lon, x.lat, x.lon) })).sort((a, b) => a.km - b.km)
    : nearestAirports(ap.data, lat, lon, 5, 200).map((x) => ({ id: x.iata || x.ident, name: x.name, km: x.km, lat: x.lat, lon: x.lon }));
  return { p, lat, lon, R, list, up: list.filter(airborne), kind, asOf, airports, crd, busy: snap?.data?.busy, cov: snap?.data?.coverage, err: null, fs: kind === LIVE ? fs : null };
};
const airSrc = (d) => (d?.fs?.source === "adsb_fi" ? "adsb.fi" : "adsb.lol");
// the map stage (civic-stage.js): the Air Traffic page's own aircraft layer (silhouettes, contrails, fading when held or
// stale) over the airports (OSM outlines, the area convention), fed by the tile's feed out to the feed's whole circle
// (airMapKm), and a left panel with the feed's state, the selected aircraft's card and the nearest aircraft.
// Selection lives in the URL (#getting-around/airtraffic/<hex>): an alert about one aircraft links there, and the page
// eases to it, rings it and shows its card; clicking it again (map, list or alert) clears it.
const AIR_LEAF = "#getting-around/airtraffic";
// an airport (outline click) is selected the same way, as apt-<ICAO or IATA> (#getting-around/airtraffic/apt-CYYJ)
const airStage = { layer: null, apt: null, map: null, sel: "", poi: "", route: undefined, fly: false, relay: null, rt: null };
function airHash() {
  const item = airStage.sel || (airStage.poi ? `apt-${airStage.poi}` : "");
  airStage.route = item || null;
  try { history.replaceState(null, "", item ? `${AIR_LEAF}/${encodeURIComponent(item)}` : AIR_LEAF); } catch { /* ignore */ }
  airStage.apt?.select(airStage.poi);
}
function airPick(id, ctx, { fly = false } = {}) {
  const was = airStage.sel;
  airStage.sel = id && id !== airStage.sel ? id : "";
  if (was && was !== airStage.sel) stopFollow(`air:${was}`);
  airStage.wake?.();
  if (airStage.sel) airStage.poi = "";
  airHash();
  airStage.layer?.select(airStage.sel); airStage.fly = fly && !!airStage.sel; airFly();
  ctx.refresh?.();
}
/** pick an airport by its code (or clear it: the same airport again) */
function airPickApt(code, ctx) {
  airStage.poi = code && code !== airStage.poi ? code : "";
  if (airStage.poi) { if (airStage.sel) stopFollow(`air:${airStage.sel}`); airStage.sel = ""; airStage.wake?.(); }
  airHash(); airStage.layer?.select("");
  ctx.refresh?.();
}
/** the URL's aircraft wins when it changes (an alert link, a deep link, back / forward); read from location.hash, as
 *  airPick() rewrites it with replaceState, which the console doesn't re-parse */
function airSyncRoute() {
  const m = /^#getting-around\/airtraffic\/([^/]+)/.exec(location.hash), item = m ? decodeURIComponent(m[1]) : null;
  if (item !== airStage.route) {
    airStage.route = item;
    const apt = item && /^apt-/.test(item) ? item.slice(4) : "";
    const next = apt ? "" : item || "";
    if (airStage.sel && airStage.sel !== next) stopFollow(`air:${airStage.sel}`);
    airStage.poi = apt; airStage.sel = next; airStage.fly = !!airStage.sel;
    airStage.layer?.select(airStage.sel); airStage.apt?.select(airStage.poi); airFly();
  }
}
function airFly() {
  const m = airStage.map; if (!airStage.fly || !airStage.sel || !airStage.layer || !m) return;
  const ll = airStage.layer.where(airStage.sel); if (!ll) return;
  airStage.fly = false; m.easeTo({ center: ll, zoom: Math.max(m.getZoom(), 11), duration: 900 });
}
/** the follow options for an aircraft (civic-follow.js): where it is drawn now (dead-reckoned along its track between
 *  reports), when it last reported, and a quick redraw of the aircraft layer so the glyph moves with the map */
function airFollow(id) {
  const a = airStage.layer?.aircraft().find((x) => airId(x) === id);
  return { map: airStage.map, key: `air:${id}`, name: a ? callsign(a) : id, minZoom: 10.5, where: () => airStage.layer?.where(id) || null,
    seen: () => { const x = airStage.layer?.aircraft().find((y) => airId(y) === id); return x ? Date.now() - (x.age ?? 0) * 1000 : null; },
    redraw: () => airStage.layer?.update(), redrawMs: 250, lostMs: 90000, giveUpMs: 300000 };
}
/** a click on an aircraft (map, list, airport card): select it; on the selected one, focus and follow it (or stop) */
function airClick(id, ctx, opts) {
  if (id && id === airStage.sel && airStage.map) toggleFollow(airFollow(id));
  else airPick(id, ctx, opts);
}
/** { line, label, text } or null: the selected aircraft's probable route: a great circle to the destination its callsign's
 *  usual route names (adsbdb.com, looked up for the selected aircraft only and never stored; trusted only when the aircraft
 *  is near that route, routeFits), else 5 minutes along its track */
function airProbable(a) {
  if (!a || !airborne(a)) return null;
  const lat = a.nlat ?? a.lat, lon = a.nlon ?? a.lon, id = airId(a);
  if (a.flight && airStage.rt?.id !== id) {
    airStage.rt = { id, rt: null };
    lookupRoute(a.flight).then((rt) => { if (airStage.rt?.id === id) { airStage.rt.rt = rt; airStage.wake?.(); } }, () => {});
  }
  const rt = airStage.rt?.id === id ? airStage.rt.rt : null, fit = rt && routeFits(rt, lat, lon);
  // near the route's origin and heading back towards it: an arrival on a reused callsign (or the return flight), not this route
  const brg = (la1, lo1, la2, lo2) => (Math.atan2((lo2 - lo1) * Math.cos((la1 * Math.PI) / 180), la2 - la1) * 180) / Math.PI;
  const back = rt?.from?.lat != null && a.track != null && airKm(lat, lon, rt.from.lat, rt.from.lon) < 30
    && Math.abs(((brg(lat, lon, rt.from.lat, rt.from.lon) - a.track + 540) % 360) - 180) < 90;
  if (fit?.ok && !back && rt.to?.lat != null && airKm(lat, lon, rt.to.lat, rt.to.lon) > 3) {
    const code = rt.to.iata || rt.to.icao || "";
    return { line: greatCircle([lon, lat], [rt.to.lon, rt.to.lat], 48), label: `probable route${code ? ` to ${code}` : ""}`,
      text: `to ${rt.to.city || rt.to.name || code}${code ? ` (${code})` : ""}, from the callsign's usual route (adsbdb.com)` };
  }
  if (a.track != null && (a.gs ?? 0) >= 60) return { line: aheadOf([lon, lat], a.track, (a.gs * 1.852 * 5) / 60), label: "probable course", text: "5 minutes along its track" };
  return null;
}
function airStageLayer(map, ctx) {
  const [lon, lat] = ctx.place.ll, R = airMapKm(ctx.place), feed = airWatch(lat, lon, airIsCRD(ctx.place), ctx);
  airStage.layer?.destroy(); airStage.apt?.destroy();
  airStage.map = map; airSyncRoute(ctx);
  airStage.apt = addAirfields(map, { prefix: "apt", center: [lon, lat], km: R + 20, beforeId: ["air-vte", "air-vt", "air-hear", "air-parked", "st-place-p"],
    color: () => cssVar("--m-airtraffic") || "#8b7cf6", ink: () => cssVar("--ink-2") || "#9aa6b8", halo: () => cssVar("--surface") || "rgba(0,0,0,0.6)", above: ["air-ac", "air-parked"], popupClass: "civ-pop", onPick: (p) => airPickApt(p.icao || p.iata || p.code, ctx) });
  airStage.apt.select(airStage.poi);
  airStage.layer = addAirLayers(map, { feed, rangeKm: AIR_KM, filter: (a) => a.km == null || a.km <= R, beforeId: map.getLayer("st-place-p") ? "st-place-p" : undefined,
    onSelect: (a) => airClick(airId(a), ctx) });
  // Esc deselects (and so stops following), unless the user is typing
  const onKey = (e) => { if (e.key === "Escape" && airStage.sel && !/input|textarea|select/i.test(e.target?.tagName || "")) airPick(null, ctx); };
  addEventListener("keydown", onKey);
  airStage.layer.select(airStage.sel);
  // the selected aircraft's wake (this session's fixes and the relay's last 90 min) and its probable route, under the aircraft
  const trail = addTrail(map, "air-trail", { beforeId: () => (map.getLayer("air-sele") ? "air-sele" : "st-place-p") }), set = hubSetFor(ctx.place);
  const note = () => { for (const a of feed.list()) if (a.hex) remember(`air:${a.hex}`, a.lon, a.lat, a.fix); };
  const wake = () => {
    const a = airStage.sel && feed.list().find((x) => airId(x) === airStage.sel);
    if (!a || !airborne(a)) { trail.clear(); return; }
    if (a.hex && airStage.relay?.id !== a.hex) { airStage.relay = { id: a.hex, pts: [] }; relayTrack(set, "air", a.hex).then((pts) => { if (airStage.relay?.id === a.hex) { airStage.relay.pts = pts; wake(); } }); }
    const past = mergeTracks(a.hex && airStage.relay?.id === a.hex ? airStage.relay.pts : [], historyOf(`air:${a.hex}`));
    past.push([a.nlon ?? a.lon, a.nlat ?? a.lat, Date.now() / 1000]);
    const next = airProbable(a);
    trail.set({ past, ahead: next?.line, label: next?.label });
  };
  airStage.wake = wake;
  const fly = () => { airFly(); note(); wake(); };
  feed.on(fly); setTimeout(fly, 800);
  const tick = setInterval(() => { if (!document.hidden && airStage.sel) wake(); }, 2000);   // the wake keeps up with the moving aircraft
  // the hub paces adsb.lol to its daily allowance whatever the page asks; 10 s only while this page is open
  feed.setEvery(10000);
  return () => { feed.off(fly); clearInterval(tick); trail.remove(); stopFollow("air:"); removeEventListener("keydown", onKey); if (airStage.wake === wake) airStage.wake = null;
    feed.setEvery(30000); airStage.layer?.destroy(); airStage.layer = null; airStage.apt?.destroy(); airStage.apt = null; airStage.map = null; };
}
function airStagePanel(ctx) {
  airSyncRoute(ctx);
  const d = airNeed(ctx);
  if (!d) return el("p", { class: "note civ-empty" }, "Waiting for aircraft positions…");
  const R = airMapKm(ctx.place);
  const wide = d.kind === LIVE ? airWatch(d.lat, d.lon, d.crd, ctx).list().filter((a) => !/^C/.test(a.cat || "") && a.km <= R) : d.list;
  const sel = airStage.sel && wide.find((a) => airId(a) === airStage.sel);
  const local = file("air/airports.json", ctx).data, world = file("air/world.json", ctx).data;
  const apt = airStage.poi && (local || world) ? airportFacts({ icao: /^[A-Z]{4}$/.test(airStage.poi) ? airStage.poi : "", iata: /^[A-Z0-9]{3}$/.test(airStage.poi) ? airStage.poi : "", name: airStage.poi }, local, world) : null;
  return el("div", { class: "civ-fp-body" },
    d.fs ? airStrip(d.fs) : el("p", { class: "note" }, d.kind === DATA ? `Last logged poll, ${hhmm(d.asOf)}: the live feed is connecting or retrying.` : "Live aircraft need the relay; retrying."),
    sel ? el("div", { class: "air-selcard" }, airCard(sel, { place: ctx.place.short }),
      airStage.map ? el("div", { class: "air-selfollow" }, followButton(airFollow(airId(sel)))) : null,
      airStage.map ? followHint(`air:${airId(sel)}`) : null,
      (() => { const pr = airProbable(sel); return pr ? el("p", { class: "air-next" }, el("b", {}, "Probable route "), `${pr.text} (inferred)`) : null; })(),
      el("button", { type: "button", class: "air-selx", title: "Clear the selection", "aria-label": "Clear the selection", onclick: () => airPick(null, ctx) }, "×"))
      : airStage.sel ? el("p", { class: "note" }, `Aircraft ${airStage.sel} isn't in the live feed right now.`) : null,
    apt ? el("div", { class: "air-selcard" }, airportCard(apt, wide, { onClose: () => airPickApt(null, ctx), onPick: (a) => airClick(airId(a), ctx, { fly: true }), idOf: airId, sel: airStage.sel, color: (a) => kindColor(a.kind || "other") }))
      : airStage.poi && (local || world) ? el("p", { class: "note" }, `Airport ${airStage.poi} isn't in the airport list.`) : null,
    apt ? null : airList(wide.filter(airborne), { limit: sel ? 5 : 8, selected: airStage.sel, onPick: (a) => airClick(airId(a), ctx, { fly: true }), range: R }),
    el("p", { class: "note" }, `${d.kind === LIVE ? `${airSrc(d)} through the relay` : "adsb.lol, logged"} · within ${Math.round(R)} km · select an airport for its traffic · airports © OpenStreetMap (ODbL), OurAirports (public domain)`));
}
const airWord = (d) => (d?.fs?.level === "down" ? "feed down" : d?.fs?.level === "delayed" ? "delayed" : "live");
const airLow = (d) => d.up.filter((a) => a.alt != null).sort((a, b) => a.alt - b.alt)[0];
/** the next aircraft to pass within 2.5 km of the place's centre in the next 15 minutes (as on the Air Traffic radar) */
const airNext = (d) => d.up.filter((a) => a.pass && a.pass.d < 2.5 && a.pass.t < 900).sort((a, b) => a.pass.t - b.pass.t)[0];
const airClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
/** mini radar: the circle, the nearest airports as squares, aircraft as silhouettes turned to their track */
function airRadar(host, d) {
  host = $(host);
  const w = Math.max(80, host.clientWidth), h = Math.max(60, host.clientHeight || 120);
  host.replaceChildren();
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${w} ${h}`).attr("width", w).attr("height", h);
  const Rp = Math.min(w, h) / 2 - 3, cx = w / 2, cy = h / 2, kx = Math.cos((d.lat * Math.PI) / 180);
  const P = (lat, lon) => [cx + ((lon - d.lon) * 111.32 * kx * Rp) / d.R, cy - ((lat - d.lat) * 110.57 * Rp) / d.R];
  for (const f of [0.5, 1]) svg.append("circle").attr("cx", cx).attr("cy", cy).attr("r", Rp * f).style("fill", "none").style("stroke", "var(--grid, var(--border))").style("stroke-dasharray", f < 1 ? "2 3" : null);
  for (const a of d.airports.filter((x) => x.km < d.R).slice(0, 3)) {
    const src = (d.crd ? file("air/airports.json").data?.airports.find((x) => (x.iata || x.icao || x.ident) === a.id) : a);
    if (!src) continue;
    const [x, y] = P(src.lat, src.lon);
    svg.append("rect").attr("x", x - 2.5).attr("y", y - 2.5).attr("width", 5).attr("height", 5).style("fill", "none").style("stroke", "var(--ink-2)");
  }
  for (const a of d.up) {
    const [x, y] = P(a.nlat ?? a.lat, a.nlon ?? a.lon);      // dead-reckoned to now when live
    svg.append("path").attr("d", glyphPath(typeInfo(a.type, a.cat).shape)).attr("transform", `translate(${x},${y}) rotate(${a.track || 0}) scale(${(h < 90 ? 0.34 : 0.44) * sizeOf(a)}) translate(-16,-16)`)
      .style("fill", kindColor(a.kind)).style("stroke", "var(--surface)").style("stroke-width", 1.5).style("paint-order", "stroke").style("opacity", a.fade ?? 1)
      .on("pointermove", (e) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `${callsign(a)} · ${typeInfo(a.type, a.cat).name}`), tipRow(null, fAlt(a.alt), `${a.km.toFixed(0)} km away`))))
      .on("pointerleave", () => tip.hide());
  }
  svg.append("circle").attr("cx", cx).attr("cy", cy).attr("r", 2).style("fill", "var(--ink)");
  if (d.kind === MOCK) svg.append("text").attr("class", "axis-t").attr("x", cx).attr("y", cy + 14).attr("text-anchor", "middle").text("live feed not reachable");
}
/** where Air Traffic opens: the nearest major airport with scheduled flights inside the search circle, plus every
 *  aerodrome with scheduled service at most a little further away than it (Langford: YYJ and the Victoria Harbour water
 *  aerodrome), with the place itself; null until the airport list has loaded, or with no such airport */
function airViewBox(ctx) {
  const p = ctx.place, [lon, lat] = p.ll, R = airMapKm(p), crd = airIsCRD(p);
  const ap = (crd ? file("air/airports.json", ctx) : file("air/world.json", ctx)).data;
  if (!ap) return null;
  let rows;
  if (crd) rows = ap.airports.map((a) => ({ lat: a.lat, lon: a.lon, major: /^(large|medium)_airport$/.test(a.type), sched: !!a.scheduled }));
  else { const ix = Object.fromEntries(ap.fields.map((f, i) => [f, i]));
    rows = ap.rows.filter((r) => Math.abs(r[ix.lat] - lat) < 1.2).map((r) => ({ lat: r[ix.lat], lon: r[ix.lon], major: true, sched: !!r[ix.scheduled] })); }
  for (const a of rows) a.km = airKm(lat, lon, a.lat, a.lon);
  const major = rows.filter((a) => a.major && a.sched && a.km <= R).sort((a, b) => a.km - b.km)[0];
  if (!major) return null;
  const reach = Math.max(15, major.km * 1.1), pts = [[lon, lat], ...rows.filter((a) => a.sched && a.km <= reach).map((a) => [a.lon, a.lat])];
  const m = 3 / 110.57, mx = 3 / (111.32 * Math.cos((lat * Math.PI) / 180));   // a 3 km margin round the points
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  return [[Math.min(...xs) - mx, Math.min(...ys) - m], [Math.max(...xs) + mx, Math.max(...ys) + m]];
}
export const airtraffic = mod({
  id: "airtraffic", title: "Air Traffic", tileTitle: "Air Traffic", scale: "region", at: "*", reach: 2, eyebrow: "Region", heading: "Air Traffic",
  need: airNeed,
  // the view: the place's airports (airViewBox), fitted inside the floating panels; until their list loads, the feed's whole circle
  stage: { layout: "map", dz: -0.8, layers: airStageLayer, panels: (ctx) => [{ id: "air", title: "Aircraft Nearby", place: "left", el: airStagePanel(ctx) }],
    // the dotted outline: the circle the aircraft are fetched and drawn in (airMapKm), around the place
    coverage: (ctx) => { const R = airMapKm(ctx.place); return { feature: airCircle(ctx.place.ll, R, { id: "cov:air", title: "Aircraft search area" }), label: `Aircraft search area · ${Math.round(R)} km` }; },
    view: (ctx) => { const box = airViewBox(ctx);
      if (box) return { center: [(box[0][0] + box[1][0]) / 2, (box[0][1] + box[1][1]) / 2], zoom: 11, bounds: box };
      const [lon, lat] = ctx.place.ll, R = airMapKm(ctx.place), dy = (0.62 * R) / 110.57, dx = (0.95 * R) / (111.32 * Math.cos((lat * Math.PI) / 180));
      return { center: [lon, lat], zoom: 9, bounds: [[lon - dx, lat - dy], [lon + dx, lat + dy]] }; } },
  status: (ctx) => { const d = airNeed(ctx); const k = d?.kind || LIVE, lv = d?.fs?.level;
    // behind or down: say since when and why (civic-sources.js shows "Delayed · 4 min ago · adsb.lol rate-limited …")
    const fs = airWatch(ctx.place.ll[1], ctx.place.ll[0], airIsCRD(ctx.place), ctx).state(), why = airFeedReason(fs);
    if (d && (k !== LIVE || lv === "delayed" || lv === "down") && (fs.err || lv !== "live")) {
      const since = fs.asOf ? fs.asOf * 1000 : d.asOf ? +d.asOf : undefined, down = k !== LIVE || lv === "down";
      return { kind: down ? "down" : "stale", text: down ? "Feed down" : "Delayed", since, reason: why,
        long: `${k === DATA ? "Showing the last logged poll (air/air.json). " : "Aircraft are moved on along their track and fade. "}adsb.lol positions (ODbL) through the relay; it retries on its own.` };
    }
    return { kind: k, text: k === LIVE ? (lv === "down" ? "Feed down" : lv === "delayed" ? "Delayed" : "Live") : k === DATA ? "Logged" : "No feed",
      long: k === LIVE ? `${airFeedText(d?.fs)} ${airSrc(d)} aircraft positions (${airSrc(d) === "adsb.fi" ? "adsb.fi open data, non-commercial" : "ODbL"}) through the relay every 30 s, moved on along their track between reports; airports from OurAirports (public domain)`
        : k === DATA ? "Last logged poll (air/air.json) while the live feed connects or retries; adsb.lol data (ODbL)"
        : "Live aircraft need the relay's air routes (adsb.lol has no CORS); retrying. Nearest airports from OurAirports are real" }; },
  source: (ctx) => { const d = airNeed(ctx); return d?.kind === LIVE ? `${airSrc(d)} · ${airWord(d)}` : d?.kind === DATA ? "adsb.lol · last logged poll" : "OurAirports · aircraft need the relay"; },
  badge: (d) => (d.kind === MOCK ? "—" : `${d.up.length}`),
  tileKpis: (d) => { const low = airLow(d), ap = d.airports[0], np = airNext(d);
    return [[d.kind === MOCK ? "—" : `${d.up.length}`, `in the air within ${Math.round(d.R)} km`],
      np ? [airClock(np.pass.t), `next pass · ${callsign(np)}`] : [low ? fAlt(low.alt) : "—", low ? `lowest · ${typeInfo(low.type, low.cat).name}` : "lowest"],
      [ap ? ap.id : "—", ap ? `nearest airport · ${Math.round(ap.km)} km` : "no airport nearby"]]; },
  kpis: (d) => { const low = airLow(d), np = airNext(d), rare = d.list.filter((a) => a.rare).sort((a, b) => a.rare.rank - b.rare.rank)[0];
    return [["In the air", d.kind === MOCK ? "—" : `${d.up.length}`, `within ${Math.round(d.R)} km${d.asOf ? `, ${d.kind === LIVE ? airWord(d) : "logged"} ${hhmm(d.asOf)}` : ""}`],
      np ? ["Next pass", airClock(np.pass.t), `${callsign(np)} within ${np.pass.d.toFixed(1)} km ${airCompass(np.pass.brg)} of the centre`]
        : ["Lowest", low ? fAlt(low.alt) : "—", low ? `${callsign(low)} · ${typeInfo(low.type, low.cat).name}` : ""],
      rare ? ["Rare", rare.rare.name, `${callsign(rare)} · ${Math.round(rare.km)} km away`] : null,
      ["Nearest airport", d.airports[0]?.id || "—", d.airports[0] ? `${d.airports[0].name}, ${Math.round(d.airports[0].km)} km` : ""],
      d.kind === LIVE && airMapKm(d.p) > d.R + 1 ? ["On the map", `${airWatch(d.lat, d.lon, d.crd).list().filter((a) => airborne(a) && !/^C/.test(a.cat || "") && a.km <= airMapKm(d.p)).length}`, `in the air within ${Math.round(airMapKm(d.p))} km`] : null,
      d.crd && d.cov ? ["Logged", `${f0(d.cov.polls_ok)} poll${d.cov.polls_ok === 1 ? "" : "s"}`, "busy hours for Greater Victoria"] : null].filter(Boolean); },
  mini: (host, d) => airRadar(host, d),
  // alerts (civic-alerts.js), live positions only: an emergency squawk, a military aircraft (adsb.lol's database flag), a
  // helicopter or aircraft below ~1,500 ft within 8 km (fixed-wing only when no airport is within 8 km), a rare or giant
  // type, and the first wide-body of the day. Each aircraft once per reason per day. Type and altitude, no operator names.
  detect: (d, ctx) => {
    if (d.kind !== LIVE) return { items: [], summary: null };
    const day = new Date().toDateString(), out = [], SQ = { 7500: "unlawful-interference code", 7600: "radio-failure code", 7700: "general emergency code" };
    const WIDE = /A330|A340|A350|A380|Boeing 7[4678]7|Tri-jet/, nearAp = (d.airports[0]?.km ?? 99) < 8, p = ctx.place.short;
    const where = (a) => `${fAlt(a.alt)}, ${Math.round(a.km)} km from ${p}`;
    const go = (a) => `${AIR_LEAF}/${encodeURIComponent(airId(a))}`;   // the Air Traffic page with this aircraft selected
    let wide = false;
    for (const a of d.up.slice().sort((x, y) => x.km - y.km)) {
      const id = a.hex || callsign(a), ti = typeInfo(a.type, a.cat), sq = String(a.sq || "");
      if (SQ[sq] || a.emerg) out.push({ id: `${id}:emerg:${day}`, level: "warn", href: go(a), title: `Squawk ${SQ[sq] ? sq : a.emerg} · ${ti.name}`, body: `${SQ[sq] ? `Transponder set to ${sq}, the ${SQ[sq]}` : `Emergency status "${a.emerg}"`}; ${where(a)} (adsb.lol).` });
      if (a.mil) out.push({ id: `${id}:mil:${day}`, level: "notice", href: go(a), title: `Military aircraft · ${ti.name}`, body: `${where(a)} (adsb.lol military flag).` });
      else if (a.rare && a.rare.name !== "Military aircraft") out.push({ id: `${id}:rare:${day}`, level: "notice", href: go(a), title: `${a.rare.name} overhead`, body: `${where(a)} (adsb.lol).` });
      const heli = a.kind === "heli";
      if (!a.mil && a.alt != null && a.alt > 0 && a.alt < 1500 && a.km <= 8 && (heli || !nearAp)) out.push({ id: `${id}:low:${day}`, level: "notice", href: go(a), title: `${heli ? "Low helicopter" : "Low aircraft"} · ${fAlt(a.alt)}`, body: `${ti.name}, ${Math.round(a.km)} km from ${p} (adsb.lol).` });
      if (!wide && (a.cat === "A5" || WIDE.test(ti.name)) && !a.rare) { wide = true; out.push({ id: `wide:${day}`, level: "info", href: go(a), title: `First wide-body today · ${ti.name}`, body: `${where(a)} (adsb.lol).` }); }
    }
    return out;
  },
});

// ------------------------------------------------------------------ Sea Traffic (module id "waterways": ships, ferries, tugs, rivers)
// Greater Victoria, Greater Vancouver and Seattle: one real week of US Coast Guard AIS (NOAA Marine Cadastre, public
// domain) counted by named stretch of water (ships/typical.json). The tile shows this hour of that week on the busiest
// local stretch; the page is the live AIS map stage (civic-mod-sea.js: ships, harbours and terminals, cards).
// Other coastal places get a planned tile (the same NOAA AIS covers US coasts and the Great Lakes); inland places
// (Las Vegas, Phoenix, Tucson) don't show it at all.
const WW_REGION = { crd: "victoria", metrovan: "vancouver", seattle: "seattle" };
const WW_AREA = { victoria: "vic-harbour", vancouver: "burrard", seattle: "elliott" };
const wwRegion = (ctx) => WW_REGION[chainOf(ctx.place).find((n) => WW_REGION[n.id])?.id];
const WW_DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const wwNow = () => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Vancouver", weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { dow: Math.max(0, WW_DOW.indexOf(p.weekday)), hour: +p.hour % 24 }; };
const wwH = (h) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`);
const wwNeed = (ctx) => {
  const c = file("ships/typical.json", ctx); if (c.err) return { err: c.err }; if (!c.data) return null;
  const r = wwRegion(ctx), t = c.data, areas = t.areas.filter((a) => a.group === r), a = areas.find((x) => x.id === WW_AREA[r]) || areas[0];
  if (!a) return { err: new Error("no Sea Traffic region here") };
  const { dow, hour } = wwNow(), passenger = Math.round(a.by_cat[0]), cruise = a.cruise_calls?.length ? new Set(a.cruise_calls.map((x) => x[1])).size : 0;
  return { t, r, areas, a, dow, hour, now: a.grid[dow][hour], passenger, cruise };
};
const wwDays = (t) => `${d3.timeFormat("%b %-d")(parseDay(t.days[0]))} – ${d3.timeFormat("%b %-d, %Y")(parseDay(t.days.at(-1)))}`;
export const waterways = mod({
  id: "waterways", title: "Sea Traffic", tileTitle: "Sea Traffic", scale: "region", at: Object.keys(WW_REGION), reach: 2,
  color: "var(--m-waterways, var(--m-ferries, var(--accent)))", eyebrow: "Region", heading: "Sea Traffic",
  stage: seaStage,   // live AIS: every ship by class, BC Ferries focus, legend and card (civic-mod-sea.js)
  tag: "Salish Sea",   // the tab names the water the map shows (civic.js scaleTag), not the place's region
  need: wwNeed, season: (m) => 0.35 + 0.55 * bump(m, 7.3, 1.9), seasonal: false,
  status: (ctx) => { const c = file("ships/typical.json", ctx).data, ais = FER.aisState();
    // the live list behind (older than 5 min, the relay polls every minute) or gone: say since when and why
    if (ais.n && Date.now() - ais.asOf >= 5 * 60e3 || (!ais.n && ais.err)) {
      const why = /AISSTREAM_API_KEY|needs_key/i.test(ais.why || ais.err?.message || "") ? "live ships not set up on the relay" : /failed to fetch|networkerror/i.test(ais.err?.message || ais.why || "") ? "relay unreachable"
        : /aisstream/i.test(ais.why || "") ? ais.why.slice(0, 80) : ais.why || (ais.err ? String(ais.err.message || ais.err).slice(0, 80) : "no new ship reports");
      return { kind: ais.n ? "stale" : "down", text: ais.n ? "Delayed" : "Feed down", since: ais.asOf || undefined, reason: why,
        long: `${ais.n ? `${ais.n} ships from the last good AIS snapshot (aisstream.io through the relay), drawn faded where old` : "No live ships yet"}; not for navigation. The typical week is US Coast Guard AIS (NOAA / BOEM Marine Cadastre, public domain).` };
    }
    if (ais.n && Date.now() - ais.asOf < 15 * 60e3) return { kind: LIVE, text: "Live", long: `${ais.n} ships live from aisstream.io through the relay (not for navigation); the typical week is US Coast Guard AIS (NOAA / BOEM Marine Cadastre, public domain).` };
    return { kind: DATA, text: "Typical week", long: `Published data (ships/typical.json): one week of US Coast Guard AIS${c ? `, ${wwDays(c)}` : ""} (NOAA / BOEM Marine Cadastre, public domain). Live ships (aisstream.io, through the relay) appear on the map when the relay answers.` }; },
  source: (ctx) => { const c = file("ships/typical.json", ctx).data; return c ? `NOAA AIS · week of ${d3.timeFormat("%b %-d")(parseDay(c.days[0]))}` : "NOAA AIS"; },
  badge: (d) => f0(d.now),
  tileKpis: (d) => [[f0(d.now), `vessels · ${d.a.name.split(" & ")[0]}, this hour`], [`${d.a.busiest.dow} ${wwH(d.a.busiest.hour)}`, "busiest hour"]],
  kpis: (d) => [["This hour", f0(d.now), `${d.a.name}, ${WW_DOW[d.dow]} ${wwH(d.hour)} in the AIS week`], ["Busiest hour", `${d.a.busiest.dow} ${wwH(d.a.busiest.hour)}`, `${f0(d.a.busiest.n)} vessels`],
    ["Ferries & passenger", f0(d.passenger), "vessels in an average hour"], d.cruise ? ["Cruise ships", f0(d.cruise), "different ships that week"] : null].filter(Boolean),
  // the day's 24 hours on the local stretch; labels every 6 h plus the current hour (dropping a neighbour it would overlap)
  mini: (host, d) => colChart(host, d.a.grid[d.dow].map((v, h) => ({ label: h === d.hour || (h % 6 === 0 && Math.abs(h - d.hour) > 2) ? wwH(h) : "", v, hl: h === d.hour, title: `${WW_DOW[d.dow]} ${wwH(h)}, ${d.a.name}` })),
    { mini: true, labels: true, color: "var(--s1)", unit: "vessels in the hour", maxW: 10 }),
});
export const waterwaysNext = planned({
  id: "waterways-next", title: "Sea Traffic", scale: "region", at: ["toronto", "sfbay", "sacramento", "la", "sandiego"], reach: 1,
  color: "var(--m-waterways, var(--m-ferries, var(--accent)))", eyebrow: "Region", heading: "Sea Traffic",
  src: "NOAA / BOEM Marine Cadastre AIS (public domain; covers US coasts and the Great Lakes) + NOAA CO-OPS tides", promise: "Planned", promiseL: "ships, ferries and tugs by hour, from US Coast Guard AIS",
  plan: [["Busy times", "vessels by hour on named stretches of water"], ["Ships by type", "ferries, cargo, tankers, tugs, pleasure"], ["Tides", "NOAA CO-OPS predictions vs observed"], ["Live ships", "through the relay, once it has an AIS key"]],
  why: "The Sea Traffic pipeline is built for the Salish Sea; adding a port is a bounding box and a set of named areas, since NOAA's AIS already covers these waters. Ranks low until it's built.",
});

// BC Ferries / Washington State Ferries: live AIS through the relay (aisstream.io); logic, map, list and alerts in
// civic-mod-ferries.js. Independent (no operator marks, no endorsement). BC Ferries has no open sailing/capacity API
// (and we don't scrape it), so capacity stays unavailable.
export const ferries = mod({
  id: "ferries", title: "BC Ferries", tileTitle: "BC Ferries", scale: "region", at: ["crd", "metrovan"], reach: 3, eyebrow: "Region", heading: "BC Ferries",
  color: "var(--m-ferries, var(--accent))", ...FER.parts("bc"),
});
export const wsferries = mod({
  id: "wsferries", title: "Washington State Ferries", tileTitle: "Washington State Ferries", scale: "region", at: ["seattle"], reach: 3, eyebrow: "Region", heading: "Washington State Ferries",
  color: "var(--m-ferries, var(--accent))", ...FER.parts("wa"),
});
// Malahat: Hwy 1 from West Shore Parkway to Mill Bay, from the same DriveBC fetch as Traffic (civic-mod-roads.js); an inset
// of Traffic whose page is the map and two compact panels (civic-mod-traffic.js, STAGES.malahat)
const malNeed = (ctx) => {
  if (!isBC(ctx)) return null;   // urgent() runs for every place: never ask DriveBC about Los Angeles
  const c = R.drivebcEvents(ctx, () => isBC(ctx)); if (c.err) return { err: c.err }; if (!c.data) return null;
  const list = R.camList(ctx), m = R.malahat(c.data, list?.cams ? list : null);
  R.malahatAlerts(m, ctx.place);
  return { ...m, at: c.at };
};
const MAL_BADGE = { closed: "closed", alternating: "1 lane", lanes: "lanes", incident: "incident", open: "open" };
const MAL_SHORT = { closed: "Closed", alternating: "Alternating", lanes: "Lane closure", incident: "Incident", open: "Open" };
export const malahat = mod({
  id: "malahat", title: "Malahat Corridor", scale: "region", at: ["crd"], reach: 3, eyebrow: "Region", heading: "Malahat Corridor", need: malNeed,
  urgent: (ctx) => { const d = malNeed(ctx); return !!d && !d.err && d.status.sev >= 2; },
  status: () => ({ kind: LIVE, text: "Live", long: "DriveBC Open511 events and highway cameras on Highway 1, West Shore Parkway to Mill Bay (Open Government Licence – BC), live" }),
  source: () => "DriveBC Open511 + cameras · OGL-BC",
  badge: (d) => MAL_BADGE[d.status.key],
  tileKpis: (d) => [[MAL_SHORT[d.status.key], d.status.x ? R.firstLine(d.status.x.e.description) : `no incidents${d.evs.length ? ` · ${d.evs.length} event${d.evs.length > 1 ? "s" : ""} listed` : ""}`], [`${d.sites.length}`, "camera sites"]],
  kpis: (d) => [["Status", d.status.text, "DriveBC, live"], ["Events", `${d.evs.length}`, `${d.evs.filter((x) => x.live).length} in effect now`], ["Cameras", `${d.sites.length} sites`, `${d3.sum(d.sites, (s) => s.cams.length)} views`]],
  // tile: the corridor strip (cameras as squares, events as dots)
  mini: (host, d) => R.corridorStrip(host, d, { mini: true }),
  main: (d) => ({
    title: "Corridor Map", sub: `Highway 1, West Shore Parkway to Mill Bay (${R.MAL_LEN.toFixed(0)} km). Squares: DriveBC cameras (click for the views). Dots: events, amber in effect now, grey scheduled, red closed.`,
    draw: (host) => {
      host.replaceChildren(el("div", { class: "civ-malbox" },
        el("div", { class: "civ-malhead" }, el("span", { class: "civ-malst", "data-sev": d.status.sev }, d.status.text), el("span", { class: "note" }, `DriveBC · checked ${hhmm(d.at)}`)),
        el("p", { class: "civ-malev" }, d.latest ? `${d.latest.live ? "" : "Scheduled, not in effect now: "}${d.latest.e.description}` : "DriveBC lists no events on this stretch."),
        el("div", { class: "civ-malmap" })));
      R.corridorStrip(host.querySelector(".civ-malmap"), d, { click: true });
    },
    listTitle: "Road Events",
    list: (host) => d.evs.length ? rowsList(host, d.evs.map((x) => [`${cap(String(x.e.event_type).toLowerCase())} · ${x.at.toFixed(1)} km`, x.live ? (evClosed(x.e) ? "Closed" : "in effect") : "scheduled", 0, { title: x.e.description, sev: R.evSev(x) }]))
      : host.replaceChildren(el("p", { class: "note civ-empty" }, "No DriveBC events on Highway 1 between West Shore Parkway and Mill Bay.")),
  }),
  extra: (d) => d.sites.length ? [{ title: "Traffic Cameras", sub: `${d.sites.length} DriveBC camera sites along the corridor, south to north. Click one for its other directions.`, draw: (h) => R.camGrid(h, d.sites) }] : [],
  xBig: true,
});
// Biking (Greater Victoria): the OSM bike network, riding conditions from the page's forecast, parking and repair stations.
// It replaces the planned "Galloping Goose & bike counters" leaf; the counters stay planned inside it (no open licence).
export const biking = mod(bikeDef({ LIVE, DATA, PLANNED, rowsList }));
// Galloping Goose (an inset of Biking): the regional trail from the Johnson Street Bridge to Leechtown.
export const galloping = mod(gooseDef({ LIVE, DATA, PLANNED, rowsList }));

const torNeed = (ctx) => { const c = file("toronto/toronto.json", ctx); if (c.err) return { err: c.err }; return c.data ? { t: c.data } : null; };
const torStatus = (ctx) => { const c = file("toronto/toronto.json", ctx).data; return { kind: DATA, text: c ? asOf(c.generated) : "Data", long: "Published data (toronto/toronto.json)" }; };
const fDay = (s) => d3.timeFormat("%a %b %-d")(parseDay(s));
export const ferry = mod({
  id: "ferry", title: "Island Ferry", scale: "region", at: ["toronto"], reach: 2, eyebrow: "Region", heading: "Island Ferry",
  need: torNeed, season: (m) => 0.15 + 0.85 * bump(m, 7.4, 1.3), status: torStatus, source: () => "City of Toronto ticket counts",
  badge: (d) => f0(d.t.ferry.forecast[0].pred),
  tileKpis: (d) => [[f0(d.t.ferry.forecast[0].pred), `riders · ${fDay(d.t.ferry.forecast[0].date)}`], [`${(d.t.ferry.yearly[2026] / 1e6).toFixed(2)} M`, "riders in 2026"]],
  kpis: (d) => [["First forecast day", f0(d.t.ferry.forecast[0].pred), fDay(d.t.ferry.forecast[0].date)], ["2026 riders", `${(d.t.ferry.yearly[2026] / 1e6).toFixed(2)} M`], ["Busiest day ever", f0(d.t.ferry.records[0][1]), fDay(d.t.ferry.records[0][0])]],
  mini: (host, d) => colChart(host, d.t.ferry.forecast.map((f, i) => ({ label: d3.timeFormat("%a")(parseDay(f.date))[0], v: f.pred, hl: i === 0, title: fDay(f.date) })), { mini: true, labels: true, color: "var(--s1)", unit: "riders" }),
  main: (d) => ({ title: "Seven-day ridership forecast", sub: "Tickets redeemed at Jack Layton Ferry Terminal, forecast from the weather.",
    draw: (host) => colChart(host, d.t.ferry.forecast.map((f) => ({ label: d3.timeFormat("%a %-d")(parseDay(f.date)), v: f.pred, title: fDay(f.date) })), { color: "var(--s1)", unit: "riders" }),
    listTitle: "Busiest days on record", list: (host) => rowsList(host, d.t.ferry.records.slice(0, 8).map(([day, n]) => [fDay(day), f0(n)])) }),
});
export const bike = mod({
  id: "bike", title: "Bike Share", scale: "region", at: ["toronto"], reach: 2, eyebrow: "Region", heading: "Bike Share",
  need: torNeed, season: (m) => 0.15 + 0.8 * bump(m, 7.2, 1.8), status: torStatus, source: () => "Bike Share Toronto ridership",
  badge: (d) => f0(d.t.bike.forecast[0].pred),
  tileKpis: (d) => [[f0(d.t.bike.forecast[0].pred), `trips · ${fDay(d.t.bike.forecast[0].date)}`], [`${(d.t.bike.total_trips / 1e6).toFixed(1)} M`, "trips since 2023"]],
  kpis: (d) => [["Trips forecast", f0(d.t.bike.forecast[0].pred), fDay(d.t.bike.forecast[0].date)], ["Since 2023", `${(d.t.bike.total_trips / 1e6).toFixed(1)} M`], ["Busiest station", d.t.bike.stations[0][0]]],
  mini: (host, d) => lineChart(host, [{ values: d.t.bike.monthly.map(([m, y]) => ({ x: parseDay(m), y })), color: "var(--s1)", area: true, cssVar: "--s1", name: "trips" }], { mini: true, time: true, tipX: d3.timeFormat("%b %Y") }),
  main: (d) => ({ title: "Trips per month", sub: "Bike Share Toronto ridership files.",
    draw: (host) => lineChart(host, [{ values: d.t.bike.monthly.map(([m, y]) => ({ x: parseDay(m), y })), color: "var(--s1)", area: true, cssVar: "--s1", name: "trips" }], { time: true, tipX: d3.timeFormat("%b %Y"), yFmt: d3.format("~s"), yZero: true }),
    listTitle: "Busiest stations", list: (host) => rowsList(host, d.t.bike.stations.slice(0, 8).map(([n, v]) => [n, f0(v)])) }),
});
export const ttc = mod({
  id: "ttc", title: "TTC Subway Delays", scale: "region", at: ["toronto"], reach: 3, eyebrow: "Region", heading: "TTC Subway Delays",
  need: torNeed, status: torStatus, source: () => "TTC delay log",
  badge: (d) => f0(d.t.ttc.n),
  tileKpis: (d) => [[f0(d.t.ttc.n), "delays since 2022"], [d.t.ttc.causes[0][1], "top cause"]],
  kpis: (d) => [["Delays", f0(d.t.ttc.n), "since 2022"], ["Time lost", `${f0(d.t.ttc.minutes / 60)} h`], ["Top cause", d.t.ttc.causes[0][1]]],
  mini: (host, d) => { const mo = d.t.ttc.monthly; lineChart(host, [{ values: mo.months.map((m, i) => ({ x: parseDay(m), y: mo.YU[i] + mo.BD[i] + mo.SHP[i] + (mo.SRT[i] || 0) })), color: "var(--s1)", cssVar: "--s1", name: "delays" }], { mini: true, time: true, tipX: d3.timeFormat("%b %Y") }); },
  main: (d) => ({ title: "Delays by cause", sub: "TTC subway delay log, 2022 onward.",
    draw: (host) => renderBars(host, d.t.ttc.causes.slice(0, 10).map((c) => [c[1], c[2], c[0]]), "--s1", f0, 200),
    listTitle: "Stations with most delays", list: (host) => rowsList(host, d.t.ttc.stations.slice(0, 8).map(([n, v]) => [n, f0(v)])) }),
});

const waterNeed = (ctx) => { const c = file("water/water.json", ctx); if (c.err) return { err: c.err }; if (!c.data) return null; const w = c.data;
  const res = w.california.reservoirs, caPct = d3.sum(res, (r) => r.storage) / d3.sum(res, (r) => r.capacity);
  return { w, ca: dataKey(ctx.place, "water") === "ca", caPct, mead: w.projections.mead.elev_now, t1: w.risk.mead.find((r) => r.elev === 1075) };
};
export const water = mod({
  id: "water", title: "Water Supply", tileTitle: "Water Supply", scale: "region", at: ["la", "sandiego", "lasvegas", "phoenix", "tucson"], reach: 2, eyebrow: "Region", heading: "Water Supply",
  need: waterNeed, season: (m) => Math.max(0.3, bump(m, 3.0, 1.4)),
  status: (ctx) => { const c = file("water/water.json", ctx).data; return { kind: DATA, text: c ? asOf(c.generated) : "Data", long: "Published data (water/water.json): snowpack, reservoirs, Lake Mead projections" }; },
  source: () => "CDEC + USBR",
  badge: (d) => `${Math.round(d.mead)} ft`,
  tileKpis: (d) => d.ca ? [[`${Math.round(d.caPct * 100)}%`, "CA reservoirs full"], [`${Math.round(d.mead)} ft`, "Lake Mead"]] : [[`${Math.round(d.mead)} ft`, "Lake Mead (Tier 1 < 1,075)"], [`${Math.round(d.t1.p_below_jan1 * 100)}%`, "odds below 1,075 Jan 1"]],
  kpis: (d) => [["Lake Mead", `${Math.round(d.mead)} ft`, "Tier 1 below 1,075"], ["CA reservoirs", `${Math.round(d.caPct * 100)}%`, "of capacity"], ["Sierra precip", `${Math.round(d.w.status.sierra.prec_pct * 100)}%`, `water year ${d.w.status.sierra.wy}`]],
  mini: (host, d) => lineChart(host, [{ values: d.w.lake_history.mead.slice(-180).map(([t, y]) => ({ x: parseDay(t), y })), color: "var(--s1)", cssVar: "--s1", name: "ft" }], { mini: true, time: true, hlines: [{ y: 1075 }], tipX: d3.timeFormat("%b %Y"), yFmt: (y) => `${Math.round(y)} ft` }),
  main: (d) => ({ title: "Lake Mead elevation, last 15 years", sub: "The dashed line is the Tier 1 shortage trigger (1,075 ft).",
    draw: (host) => lineChart(host, [{ values: d.w.lake_history.mead.slice(-180).map(([t, y]) => ({ x: parseDay(t), y })), color: "var(--s1)", cssVar: "--s1", name: "ft", area: true }], { time: true, hlines: [{ y: 1075, label: "Tier 1 shortage · 1,075 ft" }], tipX: d3.timeFormat("%b %Y"), yFmt: (y) => `${Math.round(y)}` }),
    listTitle: "California reservoirs", list: (host) => rowsList(host, d.w.california.reservoirs.map((r) => [r.name, `${Math.round(r.pct_capacity * 100)}%`, r.pct_capacity]), { bars: true }) }),
});

// ================================================================== PROVINCE / STATE
const TSU_LEVELS = [{ label: "Information", short: "Info", c: "s3", note: "a quake happened; no threat" }, { label: "Watch", c: "warn", note: "a threat is possible; stay alert" }, { label: "Advisory", short: "Advis.", c: "warn", note: "strong currents; stay off beaches" }, { label: "Warning", short: "Warn", c: "bad", note: "inundation possible; move to high ground" }];
// live: NWS tsunami alerts on this coast (CORS-open) + NTWC / PTWC messages (relay, else the daily snapshot): civic-mod-climate.js
const tsuNeed = (ctx) => {
  const prov = provinceOf(ctx.place), d = CL.tsunamiData(ctx, prov?.id); if (!d) return null;
  return { ...d, prov };   // real messages only: no preview or mock advisory, ever
};
const tsuName = (lv) => (lv >= 1 ? TSU_LEVELS[lv].label : "No threat");
const tsuMsg = (m) => `${m.center} ${String(m.category || "message").toLowerCase()}${m.mag ? ` · M${m.mag}` : ""} · ${m.title}`;
const tsuWhen = (s) => d3.timeFormat("%b %-d, %-I:%M %p")(new Date(s));
export const tsunami = mod({
  id: "tsunami", xBig: true, title: "Tsunamis", tileTitle: "Tsunamis", scale: "province", at: ["bc", "wa", "cal"], reach: 3, eyebrow: "Province / state", heading: "Tsunamis",
  need: tsuNeed,
  urgent: (ctx) => (tsuNeed(ctx)?.level ?? -1) >= 1,
  status: (ctx) => { const d = tsuNeed(ctx);
    return { kind: LIVE, text: "Live", long: `Live: NWS tsunami watches, advisories and warnings for US coastal zones (api.weather.gov, public domain), every 5 min; NTWC / PTWC messages (tsunami.gov, public domain) ${d?.relay ? "via the relay, every 5 min" : "from the daily snapshot until the relay's /tsunami route is deployed"}. Emergency Info BC: its feed stopped in 2024, so linked only.` }; },
  source: (ctx) => (provinceOf(ctx.place)?.id === "bc" ? "NTWC · NWS · tsunami.gov" : "NWS · NTWC"),
  badge: (d) => (d.level >= 1 ? tsuName(d.level).toLowerCase() : "none"),
  tileKpis: (d) => { const m = d.msgs.find((x) => x.center === "NTWC") || d.msgs[0];
    return d.level >= 1 ? [[tsuName(d.level), d.nws[0]?.areaDesc?.split(";")[0] || `${d.prov.short} coast · NTWC region`], [m?.mag ? `M${m.mag}` : "—", m?.title || ""]]
      : [["No threat", `for the ${d.prov.short} coast`], [m ? d3.timeFormat("%b %-d")(new Date(m.updated)) : "—", m ? `latest NTWC message: ${String(m.category || "").toLowerCase()}${m.mag ? `, M${m.mag}` : ""}` : "latest message"]]; },
  kpis: (d) => { const m = d.msgs.find((x) => x.center === "NTWC");
    return [["Status", tsuName(d.level), d.nws.length ? "NWS, live" : "NTWC + NWS"], ["Latest NTWC message", m ? d3.timeFormat("%b %-d")(new Date(m.updated)) : "—", m ? `${m.category || ""}${m.mag ? ` · M${m.mag}` : ""} · ${m.title}` : ""],
      ["US coastal alerts", `${d.nws.length}`, "NWS tsunami alerts on this coast"]]; },
  // tile: the four message levels, lit up to the one in effect
  mini: (host, d) => C.steps(host, TSU_LEVELS, d.level, { none: "no threat" }),
  main: (d) => ({ title: "Latest Tsunami Messages", sub: "NWS tsunami alerts for coastal zones on this coast (live), then each warning centre's newest message: NTWC (Alaska, BC and the US west coast) and PTWC (the Pacific basin).",
    draw: (host) => rowsList(host, [
      ...d.nws.map((p) => [`${p.event} · ${p.areaDesc?.split(";")[0] || ""}`, tsuWhen(p.sent), 0, { sev: /Warning/.test(p.event) ? 3 : 2, title: p.headline, tag: LIVE }]),
      ...(d.level < 1 ? [[`No tsunami threat for the ${d.prov.short} coast`, "", 0, { sev: 0 }]] : []),
      ...d.msgs.map((m) => [tsuMsg(m), tsuWhen(m.updated), 0, { sev: CL.TSU_RANK[m.category] >= 1 ? 2 : 1, title: m.note || m.bulletin, tag: d.relay ? LIVE : DATA }])]),
    listTitle: d.prov.id === "bc" ? "Zones (Emergency Info BC)" : "Where to Check",
    list: (host) => rowsList(host, d.prov.id === "bc" ? [["Zone A", "outer coast"], ["Zone B", "Juan de Fuca Strait"], ["Zone C", "Greater Victoria, Strait of Georgia"], ["Zone D", "Haida Gwaii"], ["Zone E", "Central / north coast"], ["Official", "emergencyinfobc.gov.bc.ca · tsunami.gov"]]
      : [["Official", "tsunami.gov"], ["Local alerts", "weather.gov"], ["Zones", "the state's tsunami evacuation maps"]]) }),
  extra: (d) => { const now = new Date(), day = d3.timeDay.floor(now);
    const seen = new Set(), all = [...d.msgs, ...d.hist].filter((m) => m.updated && !seen.has(m.id) && seen.add(m.id));
    const msgs = all.map((m) => ({ x: new Date(m.updated), row: Math.max(0, CL.TSU_RANK[m.category] ?? 0), title: `${m.center} ${m.category || "message"}`, note: `${m.mag ? `M${m.mag} · ` : ""}${m.title}`, tone: TSU_LEVELS[Math.max(0, CL.TSU_RANK[m.category] ?? 0)].c }))
      .concat(d.nws.map((p) => ({ x: new Date(p.sent), row: /Warning/.test(p.event) ? 3 : /Advisory/.test(p.event) ? 2 : 1, title: p.event, note: p.areaDesc?.split(";")[0] || "", tone: /Warning/.test(p.event) ? "bad" : "warn" })));
    return [
      { title: "Level in Effect", sub: d.level >= 1 ? "A tsunami message is in effect on this coast: follow local officials." : "No tsunami watch, advisory or warning in effect for this coast.",
        draw: (h) => C.steps(h, TSU_LEVELS, d.level, { full: true, none: "No threat for this coast" }) },
      { w: 1.4, title: "Messages, Last 60 Days", sub: `One dot per message, by level. NTWC and PTWC keep only their newest message online; this history is gathered by the daily snapshot${d.snapGen ? ` (last ${d3.timeFormat("%b %-d")(new Date(d.snapGen))})` : ""}.`,
        draw: (h) => C.strip(h, msgs, { domain: [d3.timeDay.offset(day, -60), d3.timeDay.offset(day, 1)], time: true, rows: TSU_LEVELS.map((l) => l.label), now, fmt: d3.timeFormat("%b %-d") }) },
    ]; },
  // alerts (civic-alerts.js): every new message (warning-centre messages under a day old; NWS tsunami alerts on this coast)
  detect: (d) => [
    ...d.msgs.filter((m) => Date.now() - Date.parse(m.updated) < 24 * 36e5).map((m) => ({ id: `tsu:${m.id}`, level: (CL.TSU_RANK[m.category] || 0) >= 1 ? "warn" : "info", href: "#hazard/tsunami",
      title: `Tsunami ${String(m.category || "message").toLowerCase()} (${m.center})`, body: `${m.mag ? `M${m.mag}, ` : ""}${m.title}. ${m.note || ""}`.trim() })),
    ...d.nws.map((p) => ({ id: `nws:${p.id}`, level: "warn", href: "#hazard/tsunami", title: p.event, body: p.headline || p.areaDesc || "" })),
  ],
});

// Wildfires (was Fire, Water & Rock): live BC Wildfire Service / NIFC WFIGS data, defined in civic-mod-hazards.js
export const hazards = mod(HZ.wildfiresDef({ LIVE, DATA, rowsList, colChart }));

const AR_NAMES = ["below AR scale", "weak", "moderate", "strong", "extreme", "exceptional"];
export const ar = mod({
  id: "ar", title: "Atmospheric Rivers", tileTitle: "Atmospheric Rivers", scale: "province", at: ["bc", "wa", "cal"], reach: 2, eyebrow: "Province / state", heading: "Atmospheric Rivers",
  need: (ctx) => arEstimate(ctx),
  season: (m) => Math.max(0.1, bump(m, 12, 1.6)),
  urgent: (ctx) => (arEstimate(ctx)?.top?.cat || 0) >= 2,
  status: () => ({ kind: LIVE, text: "Estimate", long: "Live estimate: water-vapour transport ≈ total column water vapour × 850 hPa wind (Open-Meteo GFS), scored on the CW3E 1–5 scale. CW3E's own AR forecasts in the real build." }),
  source: () => "Open-Meteo estimate · CW3E scale",
  badge: (d) => (d.top ? `AR${d.top.cat}` : "none"),
  tileKpis: (d) => d.top ? [[`AR${d.top.cat}`, `${AR_NAMES[d.top.cat]} · ${d3.timeFormat("%a")(d.top.peak)}`], [`${f0(d.top.max)}`, "peak kg/m/s (est.)"], [d.top.pineapple ? "Yes" : "No", "Pineapple Express?"]]
    : [["None", "in the next 7 days"], [`${f0(d.max)}`, "peak kg/m/s (est.)"]],
  kpis: (d) => [["Next AR", d.top ? `AR${d.top.cat}` : "None", d.top ? `${AR_NAMES[d.top.cat]}, ${d.top.hours} h` : "7-day outlook"], ["Peak transport", `${f0(d.max)}`, "kg/m/s, estimated"], ["Pineapple Express", d.top?.pineapple ? "Likely" : "No", "subtropical plume from the southwest (heuristic)"]],
  mini: (host, d) => lineChart(host, [{ values: d.series.map((p) => ({ x: p.x, y: p.y })), color: "var(--s1)", area: true, cssVar: "--s1", name: "kg/m/s" }], { mini: true, time: true, hlines: [{ y: 250, color: "var(--muted)" }], tipX: d3.timeFormat("%a %-I %p"), yZero: true }),
  main: (d) => ({ title: "Water-vapour transport over this place, next 7 days", sub: "Estimated IVT (kg/m/s). 250 starts an atmospheric river; 500, 750, 1,000 and 1,250 step up the scale. Lasting 48 h adds a category; under 24 h drops one.",
    draw: (host) => lineChart(host, [{ values: d.series.map((p) => ({ x: p.x, y: p.y })), color: "var(--s1)", area: true, cssVar: "--s1", name: "kg/m/s" }],
      { time: true, hlines: [250, 500, 750, 1000].filter((y) => y <= Math.max(600, d.max * 1.2)).map((y) => ({ y, color: "var(--muted)", label: y === 250 ? "AR threshold 250" : `${y}` })), tipX: d3.timeFormat("%a %-I %p"), xFmt: d3.timeFormat("%a"), yFmt: d3.format("~s"), yZero: true }),
    listTitle: "Events in the next week", list: (host) => rowsList(host, d.events.length ? d.events.map((e) => [`${d3.timeFormat("%a %-I %p")(e.start)} · ${e.hours} h`, `AR${e.cat} · ${f0(e.max)}${e.pineapple ? " · Pineapple" : ""}`]) : [["No transport above 250 kg/m/s", "quiet"]]) }),
  extra: (d, ctx) => {
    const days = d3.rollups(d.series, (v) => d3.max(v, (p) => p.y), (p) => +d3.timeDay.floor(p.x)).sort((a, b) => a[0] - b[0]);
    const peaks = new Map(d.events.map((e) => [+d3.timeDay.floor(e.peak), e]));
    const ivt = days.map(([t, v]) => ({ x: new Date(t), v, c: v >= 250 ? "s1" : "s3", label: peaks.has(t) && peaks.get(t).cat ? `AR${peaks.get(t).cat}` : null, note: v >= 250 ? "kg/m/s, AR threshold passed" : "kg/m/s, below the AR threshold" }));
    const wx = weather(ll(ctx), ctx).data;
    const rain = wx ? wx.daily.time.map((s, k) => ({ x: parseDay(s), v: wx.daily.precipitation_sum[k] ?? 0, c: "s1", note: WMO[wx.daily.weather_code[k]] || "" })) : null;
    const day = { xFmt: d3.timeFormat("%a"), tipX: d3.timeFormat("%a %b %-d") };
    return [
      { title: "Peak transport by day (estimate)", sub: "Highest estimated IVT each day; muted below the 250 kg/m/s AR threshold, labelled with the AR category on an event's peak day.",
        draw: (h) => C.timeCols(h, ivt, { ...day, hlines: [250], min: 300, unit: "kg/m/s (est.)", fmt: f0 }) },
      { title: "Precipitation by day", sub: "Rain and melted snow (mm), Open-Meteo daily forecast, live.",
        draw: (h) => (rain ? C.timeCols(h, rain, { ...day, min: 5, fmt: (v) => `${v.toFixed(1)} mm` }) : C.emptyNote(h, "Loading the forecast…")) },
    ];
  },
});

const PATTERNS = [
  { id: "heat", name: "Heat dome", re: /heat/i, quiet: "none forecast" },
  { id: "blob", name: "Marine heatwave (“the Blob”)" },
  { id: "tides", name: "King tides & storm surge", re: /coastal flood|storm surge/i },
  { id: "smoke", name: "Wildfire smoke", re: /air quality|smoke/i, quiet: "none" },
  { id: "snow", name: "Snow event", re: /snow|winter storm|blizzard/i, quiet: "none" },
];
const fWin = (w) => { const a = parseDay(w.start), b = parseDay(w.end); return `${d3.timeFormat("%b %-d")(a)}${+a === +b ? "" : `–${a.getMonth() === b.getMonth() ? b.getDate() : d3.timeFormat("%b %-d")(b)}`}`; };
const sgnC = (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)} °C`;
const unusualNeed = (ctx) => {
  const prov = provinceOf(ctx.place), c = isCA(ctx) ? ecccAlerts(ctx) : isUS(ctx) ? nwsPoint(ll(ctx), ctx) : null;
  if (c && !c.data && !c.err) return null;
  const al = isCA(ctx) ? (c?.data || []).filter((f) => f.properties.province === prov?.code).map((f) => ({ name: f.properties.alert_name_en, src: "ECCC" }))
    : (c?.data || []).map((f) => ({ name: f.properties.event, src: "NWS" }));
  const oc = CL.oceanData(ctx, prov?.id), ocean = oc && !oc.err ? oc : null;
  return { al, prov, ocean, rows: PATTERNS.map((p) => {
    const hit = p.re && al.find((a) => p.re.test(a.name));
    const kt = p.id === "tides" && ocean?.next ? `${ocean.soon ? "king tides" : "next king tides"} ${fWin(ocean.next)}` : "";
    if (hit) return { ...p, live: true, on: true, text: `${cap(hit.name)} (${hit.src})${kt ? ` · ${kt}` : ""}` };
    if (p.id === "blob") return !ocean?.last ? { ...p, on: false, text: oc?.err ? "SST snapshot unavailable" : "loading" }
      : { ...p, data: true, on: ocean.heat, text: `NE Pacific ${sgnC(ocean.last.mean)} · coast ${sgnC(ocean.coast?.mean ?? 0)} (${d3.timeFormat("%b %-d")(parseDay(ocean.last.t))})` };
    if (p.id === "tides") return !ocean?.next ? { ...p, on: false, text: ocean?.tide ? "no window ahead" : "no tide station wired" }
      : { ...p, data: true, on: !!ocean.soon, text: `${ocean.soon ? "" : "next "}${fWin(ocean.next)} · ${ocean.next.peak_m.toFixed(2)} m at ${ocean.tide.name.split(",")[0]}` };
    return { ...p, on: false, text: p.quiet };
  }) };
};
export const unusual = mod({
  id: "unusual", xBig: true, title: "Unusual Weather", tileTitle: "Unusual Weather", scale: "province", at: ["bc", "wa"], reach: 2, eyebrow: "Province / state", heading: "Unusual Weather", need: unusualNeed,
  urgent: (ctx) => !!unusualNeed(ctx)?.rows?.some((r) => r.live),
  status: (ctx) => { const o = unusualNeed(ctx)?.ocean;
    return { kind: LIVE, text: o ? `Live · ${asOf(o.gen)}` : "Live", long: `Live ${isCA(ctx) ? "ECCC" : "NWS"} alerts flag storm surge, smoke, snow and heat; marine heat from NOAA OISST v2.1 SST anomalies and king tides from NOAA CO-OPS predictions, both in the daily snapshot (climate/ocean.json, public domain)` }; },
  source: (ctx) => `${isCA(ctx) ? "ECCC" : "NWS"} alerts · NOAA OISST · NOAA tides`,
  badge: (d) => `${d.rows.filter((r) => r.on).length} active`,
  tileKpis: (d) => { const on = d.rows.filter((r) => r.on); return [[`${on.length}`, "patterns active"], [on[0]?.name.split(" (")[0] || "None", on[0]?.text || "all quiet"]]; },
  kpis: (d) => { const on = d.rows.filter((r) => r.on); return on.length ? on.slice(0, 3).map((r) => [r.name.split(" (")[0], r.live ? "Live" : "Data", r.text]) : [["Patterns", "Quiet", "nothing unusual flagged"]]; },
  // tile: five pattern lights: solid = active (an alert names it, or the SST / tide snapshot crosses its line), grey = quiet
  mini: (host, d) => C.lights(host, patternCells(d)),
  main: (d) => ({ title: "Unusual Weather", sub: "Heat domes, marine heatwaves, king tides with storm surge, wildfire smoke and snow events: from live weather alerts, the NE Pacific sea-surface temperature anomaly and the year's highest predicted tides.",
    draw: (host) => rowsList(host, d.rows.map((r) => [r.name, r.text, 0, { sev: r.live ? 2 : r.on ? 1 : 0, tag: r.live ? LIVE : r.data ? DATA : null }])),
    listTitle: "Sources", list: (host) => rowsList(host, [["Heat, smoke, snow", `${d.al[0]?.src || (d.prov?.id === "bc" ? "ECCC" : "NWS")} alerts (live)`], ["Storm surge", "coastal flood statements (live)"],
      ["Marine heatwave", "NOAA OISST v2.1 (estimate)", 0, { title: "Weekly SST anomaly vs 1991–2020. Flagged when a third of 40–56°N, 160–124°W is at +1.5 °C or more, or the BC / Washington shelf averages that. An estimate, not NOAA's own heatwave product." }],
      ["King tides", d.ocean?.tide ? `NOAA tides, ${d.ocean.tide.name.split(",")[0]} (≥ ${d.ocean.tide.threshold_m.toFixed(2)} m)` : "NOAA tide predictions", 0,
        { title: d.ocean?.tide ? `NOAA CO-OPS station ${d.ocean.tide.station} ${d.ocean.tide.name}, ${d.ocean.tide.note}. King tides: the top 5% of the year's daily highest high tides, above MLLW. CHS Victoria predictions aren't used: their licence isn't open.` : "" }]]) }),
  extra: (d) => { const o = d.ocean; if (!o?.sst) return [];
    const ne = o.sst.series.map((p) => ({ x: parseDay(p.t), y: p.mean })), co = (o.sst.coast || []).map((p) => ({ x: parseDay(p.t), y: p.mean }));
    const thr = o.tide?.threshold_m, days = (o.tide?.daily || []).map(([t, v]) => ({ x: parseDay(t), v, c: v >= thr ? "warn" : "s1", note: v >= thr ? "king-tide range" : "highest high of the day" }));
    return [
      { title: "Sea-Surface Temperature Anomaly", sub: "Weekly mean anomaly vs 1991–2020 (°C), NOAA OISST: NE Pacific (solid) and the BC / Washington shelf (dashed). Data.",
        draw: (h) => lineChart(h, [{ values: ne, color: "var(--s1)", cssVar: "--s1", name: "NE Pacific °C" }, { values: co, color: "var(--s2)", cssVar: "--s2", dash: "4 3", name: "shelf °C" }],
          { time: true, hlines: [{ y: 1.5, color: "var(--muted)", label: "+1.5 °C" }, { y: 0, color: "var(--muted)" }], tipX: d3.timeFormat("%b %-d"), xFmt: d3.timeFormat("%b %-d"), yFmt: (v) => v.toFixed(1) }) },
      days.length ? { title: "Highest Tide by Day", sub: `Next 60 days, predicted (m above MLLW), ${o.tide.name}. King-tide range in the caution colour. Data.`,
        draw: (h) => C.timeCols(h, days, { xFmt: d3.timeFormat("%b %-d"), tipX: d3.timeFormat("%a %b %-d"), hlines: [thr], min: thr, unit: "m", fmt: (v) => `${v.toFixed(2)} m` }) } : null,
    ]; },
  // alerts: a king-tide window starting within 3 days; the marine-heatwave estimate switching on
  detect: (d) => { const o = d.ocean, out = []; if (!o) return out;
    if (o.next && (parseDay(o.next.start) - Date.now()) / 864e5 <= 3) out.push({ id: `tides:${o.tide.station}:${o.next.start}`, level: "info", href: "#weather/unusual", title: `King tides ${fWin(o.next)}`, body: `Highest predicted tides of the year: ${o.next.peak_m.toFixed(2)} m above MLLW at ${o.tide.name} (NOAA). Storm surge on top raises the water further.` });
    if (o.heat) out.push({ id: "blob", state: true, level: "notice", href: "#weather/unusual", title: "Marine heatwave in the NE Pacific", body: `Sea-surface temperature ${sgnC(o.last.mean)} above normal on average (NOAA OISST, ${o.last.t}).` });
    return out; },
});
const patternCells = (d) => d.rows.map((r) => ({ label: r.name.split(" (")[0].replace("Marine heatwave", "Marine heat").replace("King tides & storm surge", "King tides"), short: { heat: "Heat", blob: "Blob", tides: "Tides", smoke: "Smoke", snow: "Snow" }[r.id],
  on: r.on, mock: false, c: r.live ? "warn" : "s1", title: r.name, text: r.text }));

const darkNeed = (ctx) => { const c = file("darksky/sites.json", ctx); if (c.err) return { err: c.err }; if (!c.data) return null;
  const v = provinceOf(ctx.place)?.id === "az" ? "az" : "bc", all = c.data.filter((s) => s.view === v).map((s) => ({ ...s, km: km([s.lon, s.lat], ll(ctx)) })).sort((a, b) => a.km - b.km);
  const dark = all.filter((s) => s.bortle <= 3);
  // the night lights around the place, then and now (model.json towns; the page samples the sky-brightness model itself)
  const m = file("darksky/model.json", ctx).data, town = m?.towns.filter((t) => t.view === v).map((t) => ({ ...t, km: km([t.lon, t.lat], ll(ctx)) })).sort((a, b) => a.km - b.km)[0];
  return { all, dark, best: dark[0], city: all.find((s) => /downtown/.test(s.name)), town: town && town.km < 12 ? town : null, years: m?.years || [2014, 2025] };
};
const lpChange = (d) => (d.town ? `${d.town.change_pct >= 0 ? "+" : "−"}${Math.abs(d.town.change_pct).toFixed(0)}%` : "—");
export const darksky = mod({
  id: "darksky", title: "Light Pollution", tileTitle: "Light Pollution", scale: "province", at: ["bc", "az"], reach: 1, eyebrow: "Province / state", heading: "Light Pollution", need: darkNeed,
  season: (m) => Math.max(0.3, bump(m, 8.2, 1.0), 0.75 * bump(m, 12.5, 0.8)),
  status: () => ({ kind: DATA, text: "Data", long: "Published light-pollution model (darksky/model.json, sqm and change images) from NASA Black Marble night lights, and the dark-sky site list (darksky/sites.json)" }),
  source: () => "NASA Black Marble + Globe at Night",
  badge: (d) => (d.town ? `${lpChange(d)} lights` : `${Math.round(d.best.km)} km`),
  tileKpis: (d) => [...(d.town ? [[lpChange(d), `night lights since ${d.years[0]} · ${d.town.name}`]] : []), [`${Math.round(d.best.km)} km`, `to a Bortle 3 sky · ${d.best.name}`]],
  kpis: (d) => [...(d.town ? [["Night lights", lpChange(d), `${d.town.name}, ${d.years[0]}–${d.years[1]}`]] : []), ["Nearest dark sky", d.best.name, `Bortle ${d.best.bortle} · ${Math.round(d.best.km)} km`], ["Downtown sky", d.city ? d.city.sqm.toFixed(2) : "—", "mag/arcsec²"]],
  mini: (host, d) => { const near = d.all.filter((s) => !/downtown/.test(s.name)).slice(0, 8);
    if (C.size(host).H < 60) return colChart(host, near.map((s) => ({ label: "", v: s.sqm, hl: s === d.best, title: `${s.name} · ${Math.round(s.km)} km` })), { mini: true, labels: false, min: 17, max: 22, color: "var(--s1)", unit: "SQM (higher is darker)", fmt: (v) => v.toFixed(2) });
    rowsList(host, near.slice(0, 6).map((s) => [s.name, `${s.sqm.toFixed(1)} · ${Math.round(s.km)} km`, (s.sqm - 18.5) / 3.5]), { bars: true, fit: true }); },
  main: (d) => ({ title: "Sky brightness at the nearest sites", sub: "SQM in mag/arcsec²: higher is darker (22 is pristine). Nearest first.",
    draw: (host) => renderBars(host, d.all.slice(0, 10).map((s) => [`${s.name} · ${Math.round(s.km)} km`, s.sqm, s.name]), "--s1", (v) => v.toFixed(2), 230),
    listTitle: "Bortle 3 or darker", list: (host) => rowsList(host, d.dark.slice(0, 8).map((s) => [s.name, `${Math.round(s.km)} km`])) }),
});

const gridNeed = (ctx) => { const c = file("grid/grid.json", ctx); if (c.err) return { err: c.err }; if (!c.data) return null; const g = c.data;
  const net = g.net.forecast.map(([t, p, lo, hi]) => ({ x: new Date(t), y: p, lo, hi })), dem = g.demand.forecast.map(([t, p]) => ({ x: new Date(t), y: p }));
  const belly = d3.min(net, (d) => d.y), i0 = net.findIndex((d) => d.y === belly), peak = d3.max(net.slice(i0), (d) => d.y);
  return { g, net, dem, belly, ramp: peak - belly };
};
export const grid = mod({
  id: "grid", title: "Electricity Grid", tileTitle: "Electricity Grid", scale: "province", at: ["cal"], reach: 2, eyebrow: "State", heading: "Electricity Grid", need: gridNeed,
  season: (m) => Math.max(0.3, bump(m, 4.2, 1.1), 0.85 * bump(m, 8.8, 0.9)),
  status: (ctx) => { const c = file("grid/grid.json", ctx).data; return { kind: DATA, text: c ? asOf(c.generated) : "Data", long: "Published forecast (grid/grid.json), CAISO" }; },
  source: () => "CAISO OASIS",
  badge: (d) => `${(d.belly / 1000).toFixed(1)} GW`,
  tileKpis: (d) => [[`${(d.belly / 1000).toFixed(1)} GW`, "net-load belly"], [`${(d.ramp / 1000).toFixed(1)} GW`, "evening ramp"]],
  kpis: (d) => [["Belly (net load)", `${(d.belly / 1000).toFixed(1)} GW`, fDay(d.g.tomorrow)], ["Evening ramp", `${(d.ramp / 1000).toFixed(1)} GW`], ["Renewables", `${Math.round(d.g.ren_share[2026] * 100)}%`, "share in 2026"]],
  mini: (host, d) => lineChart(host, [{ values: d.net, color: "var(--s1)", area: true, cssVar: "--s1", name: "net load MW" }, { values: d.dem, color: "var(--s3)", dash: "3 3", width: 1.2, cssVar: "--s3", name: "demand MW" }], { mini: true, time: true, tipX: d3.timeFormat("%-I %p") }),
  main: (d) => ({ title: `The duck, ${fDay(d.g.tomorrow)}`, sub: "Net load (demand minus solar and wind) with its 80% range, against total demand (dashed).",
    draw: (host) => lineChart(host, [{ values: d.net, color: "var(--s1)", cssVar: "--s1", name: "net load MW" }, { values: d.dem, color: "var(--s3)", dash: "4 3", width: 1.4, cssVar: "--s3", name: "demand MW" }],
      { time: true, band: { values: d.net, color: "var(--s1)" }, tipX: d3.timeFormat("%-I %p"), xFmt: d3.timeFormat("%-I %p"), yFmt: d3.format("~s") }),
    listTitle: "Belly depth by year", list: (host) => { const mins = Object.entries(d.g.duck).map(([y, v]) => [y, d3.min(v)]), [lo, hi] = d3.extent(mins, (x) => x[1]);
      rowsList(host, mins.map(([y, v]) => [`${y} · lowest typical hour`, `${(v / 1000).toFixed(1)} GW`, 0.08 + (0.92 * (v - lo)) / (hi - lo || 1)]), { bars: true }); } }),
});

// ================================================================== COUNTRY
const PROV_NAMES = { AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick", NL: "Newfoundland and Labrador", NS: "Nova Scotia", NT: "Northwest Territories", NU: "Nunavut", ON: "Ontario", PE: "PEI", QC: "Quebec", SK: "Saskatchewan", YT: "Yukon" };
const natNeed = (ctx) => {
  if (isUS(ctx)) { const c = nwsCount(ctx); if (c.err) return { err: c.err }; if (!c.data) return null;
    const rows = Object.entries(c.data.areas || {}).filter(([k]) => k.length === 2 && /^[A-Z]{2}$/.test(k)).sort((a, b) => b[1] - a[1]); return { us: true, total: c.data.land, rows, warn: null }; }
  const c = ecccAlerts(ctx); if (c.err) return { err: c.err }; if (!c.data) return null;
  const types = new Map(); for (const f of c.data) { const a = f.properties; types.set(`${a.province}|${a.alert_name_en}`, a); }
  const list = [...types.values()];
  const rows = d3.rollups(list, (v) => v.length, (a) => a.province).sort((a, b) => b[1] - a[1]);
  return { us: false, total: list.length, warn: list.filter((a) => a.alert_type === "warning").length, rows, list };
};
export const natalerts = mod({
  id: "natalerts", title: "Weather Warnings", tileTitle: "Weather Warnings", scale: "country", at: ["ca", "us"], reach: 3, eyebrow: "Country", heading: "Weather Warnings", need: natNeed,
  status: (ctx) => ({ kind: LIVE, text: "Live", long: isUS(ctx) ? "NWS active-alert counts (public domain), live" : "ECCC weather alerts via MSC GeoMet (Open Government Licence – Canada), live" }),
  source: (ctx) => (isUS(ctx) ? "NWS" : "ECCC · GeoMet"),
  badge: (d) => `${d.total}`,
  tileKpis: (d) => d.us ? [[f0(d.total), "land alerts active"], [d.rows[0]?.[0] || "—", `most alerts · ${d.rows[0]?.[1] || 0}`]]
    : [[`${d.warn}`, "warnings active in Canada"], [`${d.total}`, "alerts of any kind"], [d.rows[0] ? PROV_NAMES[d.rows[0][0]] || d.rows[0][0] : "—", "most alerts"]],
  kpis: (d) => [["Active alerts", f0(d.total), d.us ? "land, NWS" : "distinct, ECCC"], d.us ? null : ["Warnings", `${d.warn}`], ["Most alerts", d.rows[0] ? (PROV_NAMES[d.rows[0][0]] || d.rows[0][0]) : "—"]].filter(Boolean),
  mini: (host, d) => colChart(host, d.rows.slice(0, 10).map(([k, v]) => ({ label: k, v, title: PROV_NAMES[k] || k })), { mini: true, labels: true, color: "var(--s1)", unit: "alerts" }),
  // alerts (civic-alerts.js): a new warning for the place's province (ECCC) or at the place (NWS). No seed: the strip's own
  // first-load line already says what is active.
  detect: (d, ctx) => {
    if (d.us) {
      const c = nwsPoint(ll(ctx), ctx);
      return { summary: null, items: (c.data || []).filter((f) => /warning/i.test(f.properties.event || "")).map((f) => ({ id: `nws:${f.properties.id || `${f.properties.event}:${f.properties.onset}`}`, level: "warn", href: "#natalerts",
        title: f.properties.event, body: `${f.properties.areaDesc?.split(";")[0] || ctx.place.short}${f.properties.ends ? `, until ${fWhen(f.properties.ends)}` : ""} (NWS).` })) };
    }
    const prov = provinceOf(ctx.place), all = ecccAlerts(ctx).data || [];
    if (!prov?.code) return { items: [], summary: null };
    return { summary: null, items: d.list.filter((a) => a.province === prov.code && a.alert_type === "warning").map((a) => {
      const areas = [...new Set(all.filter((f) => f.properties.province === prov.code && f.properties.alert_name_en === a.alert_name_en).map((f) => f.properties.feature_name_en).filter(Boolean))];
      return { id: `eccc:${prov.code}:${a.alert_name_en}`, level: "warn", href: "#natalerts", title: `${cap(a.alert_name_en)} · ${prov.short}`,
        body: `In effect for ${areas.length ? `${areas.slice(0, 3).join(", ")}${areas.length > 3 ? ` and ${areas.length - 3} more area${areas.length - 3 === 1 ? "" : "s"}` : ""}` : prov.name} (ECCC).` };
    }) };
  },
  main: (d) => ({ title: d.us ? "Active alerts by state" : "Active alerts by province and territory", sub: d.us ? "NWS, land and marine areas." : "Distinct alert types per province, ECCC.",
    draw: (host) => renderBars(host, d.rows.slice(0, 14).map(([k, v]) => [PROV_NAMES[k] || k, v, k]), "--s1", f0, 160),
    listTitle: d.us ? "Counts" : "Warnings in effect",
    list: (host) => rowsList(host, d.us ? d.rows.slice(0, 20).map(([k, v]) => [k, f0(v)]) : d.list.filter((a) => a.alert_type !== "statement").map((a) => [`${cap(a.alert_name_en)} · ${a.province}`, a.feature_name_en || "", 0, { sev: ECCC_SEV[a.alert_type] }])) }),
  extra: (d) => d.us ? [] : [{ title: "By level", sub: "Distinct alerts in Canada by level, ECCC, live. Warnings in the danger colour, watches and advisories in the caution colour.",
    draw: (h) => colChart(h, [["warning", "bad"], ["watch", "warn"], ["advisory", "warn"], ["statement", "s3"]].map(([k, c]) => ({ label: `${cap(k)}s`, v: d.list.filter((a) => a.alert_type === k).length, color: `var(--${c})` })),
      { unit: "alerts", yFmt: (v) => v, maxW: 24 }) }],
});
// seasonal outlook: ECCC CanSIPS (Canada) or NOAA CPC (US) tercile probabilities by region, from the daily snapshot
const tiltOf = (r) => (r.above - r.below) / 100;
const outNeed = (ctx) => CL.outlookData(ctx, isUS(ctx));
export const outlook = mod({
  id: "outlook", title: "Seasonal Outlook", tileTitle: "Seasonal Outlook", scale: "country", at: ["ca", "us"], reach: 1, eyebrow: "Country", heading: "Seasonal Outlook",
  need: outNeed, season: (m) => Math.max(0.15, bump(m, 11.5, 1.8)),
  status: (ctx) => { const d = outNeed(ctx); return { kind: DATA, text: d && !d.err ? asOf(d.gen) : "Data", long: d?.o?.source || (isUS(ctx) ? "NOAA CPC seasonal outlook (public domain)" : "ECCC CanSIPS seasonal forecast (Open Government Licence – Canada)") }; },
  source: (ctx) => (isUS(ctx) ? "NOAA CPC" : "ECCC CanSIPS · GeoMet"),
  badge: (d) => `${d.here.above}% warmer`,
  tileKpis: (d) => [[d.here.above >= 50 ? "Warmer" : d.here.below >= 50 ? "Colder" : "Near normal", `${d.o.label} temperature, ${d.here.title}`], [`${d.here.above}%`, "chance warmer than normal"]],
  kpis: (d) => [[`${d.o.label}, ${d.here.title}`, `${d.here.above}% warmer`, `${d.here.near}% near normal · ${d.here.below}% colder`], ["Normal", "1991–2020", d.us ? "CPC" : "CanSIPS"],
    ["Issued", d.us ? (d.o.issued ? fDate(parseDay(d.o.issued)) : "—") : d.o.ref ? fDate(parseDay(d.o.ref)) : "—", d.us ? "CPC, third Thursday" : "CanSIPS run, monthly"]],
  // tile: warmer (up) / colder (down) tilt by region
  mini: (host, d) => C.divCols(host, d.rows.map((r) => ({ label: r.label, title: r.title, v: tiltOf(r) })), { max: 1, fmt: (v) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}`, unit: "points, warmer minus colder" }),
  main: (d) => ({ title: `Odds by Region, ${d.o.label}`, sub: `Chance of a colder, near-normal or warmer ${d.o.label} than the 1991–2020 normal. ${d.us ? "CPC shows only the favoured category; the other two follow CPC's convention." : "ECCC's CanSIPS multi-model forecast, at a point in each region."}`,
    draw: (host) => C.stackBars(host, d.rows.map((r) => ({ label: r.title, vals: [r.below, r.near, r.above] })), [{ name: "Colder", c: "s1" }, { name: "Near normal", c: "s3" }, { name: "Warmer", c: "s2" }], { norm: true, fmt: (v) => `${v}%` }),
    listTitle: "Typical El Niño / La Niña Effects", list: (host) => { const e = CL.ensoData({ refresh: () => {} });
      rowsList(host, [...(e && !e.err ? [["Now", `${e.e.status} (CPC)`, 0, { hl: true }]] : []), ["El Niño", d.us ? "warmer north, wetter south" : "milder, drier BC winter"], ["La Niña", d.us ? "colder north, drier south" : "colder, snowier BC winter"], ["Neutral", "no strong tilt"]]); } }),
  extra: (d) => [{ title: "Tilt by Region", sub: "Chance warmer minus chance colder, in percentage points: up is warmer than normal, down colder.",
    draw: (h) => C.divCols(h, d.rows.map((r) => ({ label: r.label, title: r.title, v: tiltOf(r) })), { max: 1, fmt: (v) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}`, unit: "points" }) }],
});

// ================================================================== PLANET
const bigNeed = (ctx) => { const c = quakesMonth(ctx); if (c.err) return { err: c.err }; if (!c.data) return null;
  const qs = c.data.features.filter((f) => f.properties.mag >= 6).map((f) => ({ mag: f.properties.mag, place: f.properties.place, t: new Date(f.properties.time), tsu: f.properties.tsunami, ll: f.geometry.coordinates.slice(0, 2), depth: f.geometry.coordinates[2], id: f.id, url: f.properties.url })).sort((a, b) => b.t - a.t);
  return { qs };
};
export const bigquakes = mod({
  id: "bigquakes", title: "Major Earthquakes", scale: "world", at: ["world"], reach: 2, eyebrow: "Planet", heading: "Major Earthquakes", need: bigNeed,
  urgent: (ctx) => !!bigNeed(ctx)?.qs?.some((q) => q.mag >= 7 && Date.now() - q.t < 72 * 36e5),
  status: () => ({ kind: LIVE, text: "Live", long: "USGS M4.5+ feed (public domain), past 30 days, filtered to M6+" }),
  source: () => "USGS",
  badge: (d) => `${d.qs.length}`,
  tileKpis: (d) => [[`${d.qs.length}`, "M6+ in 30 days"], [d.qs.length ? `M${d3.max(d.qs, (q) => q.mag).toFixed(1)}` : "—", "largest"]],
  kpis: (d) => [["M6+ quakes", `${d.qs.length}`, "past 30 days"], ["Largest", d.qs.length ? `M${d3.max(d.qs, (q) => q.mag).toFixed(1)}` : "—"], ["Latest", d.qs.length ? ago(d.qs[0].t) : "—", d.qs[0]?.place || ""]],
  // tile: the month's M6+ quakes as dots over 30 days
  mini: (host, d) => C.quakeDots(host, d.qs, { domain: weekAgo(30), min: 6, top: 7, fmt: (v) => (+v > Date.now() - 36e5 ? "now" : "30 d ago"), empty: "none this month" }),
  // alerts (civic-alerts.js): a new M6+ anywhere in the past day (information), M7+ a notice; no seed
  detect: (d) => ({ summary: null, items: d.qs.filter((q) => Date.now() - q.t < 24 * 36e5).map((q) => ({ id: `${+q.t}:${q.mag}`, level: q.mag >= 7 ? "notice" : "info", href: "#bigquakes",
    title: `M${q.mag.toFixed(1)} earthquake`, body: `${q.place}${q.tsu ? "; USGS has set its tsunami flag (check local warnings)" : ""} (USGS).` })) }),
  main: (d) => ({ title: "M6+ earthquakes, past 30 days", sub: "USGS, live. Each dot is one quake: when (across) and magnitude (up, and dot size).",
    draw: (host) => C.quakeDots(host, d.qs, { domain: weekAgo(30), min: 6, top: 7, fmt: d3.timeFormat("%b %-d") }),
    listTitle: "Every M6+", list: (host) => rowsList(host, d.qs.map((q) => [`M${q.mag.toFixed(1)} ${q.place}`, ago(q.t)])) }),
  extra: (d) => [{ title: "By size", sub: "M6+ quakes in the past 30 days by magnitude band. Each whole step releases about 32 times the energy.",
    draw: (h) => colChart(h, [[6, 6.5, "6.0–6.4"], [6.5, 7, "6.5–6.9"], [7, 7.5, "7.0–7.4"], [7.5, 10, "7.5+"]].map(([a, b, label]) => ({ label: `M${label}`, v: d.qs.filter((q) => q.mag >= a && q.mag < b).length })),
      { color: "var(--s1)", unit: "quakes", yFmt: (v) => v, maxW: 24 }) }],
});
// El Niño / La Niña: NOAA CPC's status, RONI and ONI history, official probabilities and RONI outlook (daily snapshot)
const sgn1 = (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)} °C`;
const ensoNeed = (ctx) => CL.ensoData(ctx);
export const enso = mod({
  id: "enso", title: "El Niño / La Niña", scale: "world", at: ["world"], reach: 1, eyebrow: "Planet", heading: "El Niño / La Niña",
  need: ensoNeed,
  status: (ctx) => { const d = ensoNeed(ctx); return { kind: DATA, text: d && !d.err ? asOf(d.e.generated) : "Data", long: d?.e?.source || "NOAA CPC ENSO status, RONI / ONI and outlook (public domain), daily snapshot" }; },
  source: () => "NOAA CPC",
  badge: (d) => d.phase,
  tileKpis: (d) => [[d.phase, d.e.status || "ENSO status"], [sgn1(d.now.y), `RONI, ${d.now.s}`]],
  kpis: (d) => [["Status", d.e.status || d.phase, d.e.issued ? `CPC, ${fDate(parseDay(d.e.issued))}` : "CPC"], ["RONI", sgn1(d.now.y), `relative Niño 3.4, ${d.now.s}`], ["ONI", sgn1(d.oniNow.y), "traditional index"],
    ["Next update", d.e.next ? fDate(parseDay(d.e.next)) : "—", "CPC discussion"]],
  mini: (host, d) => lineChart(host, [{ values: d.roni.slice(-24), color: "var(--s1)", cssVar: "--s1", name: "RONI °C" }, { values: [d.now, ...d.fc.map((f) => ({ x: f.x, y: f.p50 }))], color: "var(--s2)", cssVar: "--s2", dash: "3 3", name: "outlook °C" }],
    { mini: true, time: true, hlines: [{ y: 0.5, color: "var(--muted)" }, { y: -0.5, color: "var(--muted)" }], tipX: d3.timeFormat("%b %Y"), yFmt: (v) => v.toFixed(1) }),
  main: (d) => ({ title: "Relative Oceanic Niño Index", sub: "3-month mean Niño 3.4 sea-surface temperature anomaly relative to the tropics (RONI, solid) and the traditional ONI (dashed), then CPC's official outlook: median with its 50% range. Above +0.5 °C is El Niño, below −0.5 °C La Niña.",
    draw: (host) => lineChart(host, [{ values: d.roni, color: "var(--s1)", cssVar: "--s1", name: "RONI °C" }, { values: d.oni, color: "var(--s3)", cssVar: "--s3", dash: "4 3", width: 1.3, name: "ONI °C" },
      { values: [d.now, ...d.fc.map((f) => ({ x: f.x, y: f.p50 }))], color: "var(--s2)", cssVar: "--s2", dash: "2 3", name: "outlook median °C" }],
      { time: true, band: { values: d.fc.map((f) => ({ x: f.x, lo: f.p25, hi: f.p75 })), color: "var(--s2)" }, marks: [{ x: new Date(), label: "now" }],
        hlines: [{ y: 0.5, color: "var(--muted)", label: "El Niño +0.5" }, { y: -0.5, color: "var(--muted)", label: "La Niña −0.5" }], tipX: d3.timeFormat("%b %Y"), yFmt: (v) => v.toFixed(1) }),
    listTitle: "What It Means Here", list: (host) => rowsList(host, [["CPC", d.e.status || "—", 0, { hl: true, title: d.e.synopsis || "" }], ["El Niño winter", "milder, less snow on the BC coast"], ["La Niña winter", "colder, more snow, stormier"], ["Neutral", "no strong push either way"],
      ["Strong events", "raise the odds, never guarantee the impact"]]) }),
  extra: (d) => [{ title: "Phase Odds by Season", sub: `CPC's official probabilities for the next ${d.e.probs.length} overlapping 3-month seasons${d.e.issued ? `, issued ${fDate(parseDay(d.e.issued))}` : ""}.`,
    draw: (h) => C.stackBars(h, d.e.probs.map(([label, la, ne, el_]) => ({ label, vals: [la, ne, el_] })), [{ name: "La Niña", c: "s1" }, { name: "Neutral", c: "s3" }, { name: "El Niño", c: "s2" }], { norm: true, fmt: (v) => `${v}%` }) }],
});

// Weather Patterns (Hazards): atmospheric rivers / Pineapple Express, El Niño / La Niña, polar vortex & Arctic air, bomb
// cyclones, hurricanes, heat domes, each with a status card; live data and map in civic-mod-hazards.js. The AR and ENSO
// pages above open from it as insets.
export const patterns = mod(HZ.patternsDef({ LIVE, DATA, rowsList, lineChart, colChart, arEstimate: (ctx) => arEstimate(ctx) }));

export const SPECIALS = [langford, lnotices, crime, quakes, blossom, foliage, sunday, salish, golf, trails, hot, surf, events, route95, airtraffic, waterways, waterwaysNext, ferries, wsferries, malahat, biking, galloping, ferry, bike, ttc, water,
  tsunami, hazards, ar, unusual, darksky, grid, natalerts, outlook, enso, patterns, oaks, wildlife];   // bigquakes: merged into quakes (its alerts too)
export const ALL = [alerts, ...BASICS, ...SPECIALS];

// ------------------------------------------------------------------ navigation: main topics (rail) → leaves (tabs above the content)
// Each leaf is one module above. A topic lists its leaves; on a page the tabs are re-ordered by scale (here → planet) and
// tagged with the place they cover, and leaves that don't reach the place are hidden. Deep links: #<topic>/<leaf>.
// The rail order is most-useful-to-most-people first; `h` starts a rail section.
export const TOPICS = [
  { id: "now", title: "Right now", color: "var(--m-alerts)", h: "Every day", badgeFrom: "alerts", leaves: [alerts, natalerts] },
  { id: "weather", title: "Weather", color: "var(--m-weather)", badgeFrom: "weather", fixed: true, leaves: [wx, aq, unusual, outlook, patterns, ar, enso], insets: { ar: "patterns", enso: "patterns" } },
  // fixed: tabs keep this order (not re-sorted by scale). insets: a leaf with no tab of its own, opened from a button on
  // its parent page (Route 95 inside Transit, the Malahat inside Traffic); its tab shows only while it is open.
  { id: "getting-around", title: "Getting around", color: "var(--m-transit)", badgeFrom: "transit", fixed: true,
    leaves: [transit, roads, biking, ferries, waterways, waterwaysNext, airtraffic, wsferries, ferry, bike, ttc, route95, malahat, galloping],
    insets: { route95: "transit", malahat: "roads", galloping: "biking" } },
  { id: "hazard", title: "Hazards", color: "var(--m-hazards)", fixed: true, leaves: [hazards, quakes, tsunami] },
  { id: "civic", title: "Civic", color: "var(--m-lnotices)", h: "This place", leaves: [lnotices, crime, langford, water, grid] },
  // Nature: the natural world and its seasons. Things to Do (id "lifestyle", so old links hold): events and outings.
  // What's Hot Now (civic-mod-hot.js) has no tab any more; Surf still uses its surf table.
  { id: "nature", title: "Nature", color: "var(--m-sunday)", leaves: [salish, blossom, foliage, oaks, wildlife, darksky] },
  { id: "lifestyle", title: "Things to Do", color: "var(--m-blossom)", fixed: true, sumAll: true, leaves: [events, trails, surf, golf, sunday] },
];
// earlier topic ids → their replacement (old links to a summary land on the new topic; links to a leaf follow the leaf)
export const TOPIC_ALIAS = { "weather-air": "weather", climate: "weather", local: "civic", safety: "civic", growth: "civic", "water-power": "civic", seasons: "nature", outdoors: "nature" };
export { PLACES };
