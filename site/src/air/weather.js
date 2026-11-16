// Airport weather: the latest METAR at each nearby station (flight category, wind, visibility, cloud base) and the TAF
// forecasts as a timeline. NOAA Aviation Weather Center via the relay; logged copy for Greater Victoria as a fallback.
import * as d3 from "d3";
import { cssVar, el, tipRow } from "../shared/ui.js";
import { frame, axisClean } from "../shared/charts.js";
import { dStats, dNote, dHead, href } from "../shared/console.js";
import { A, $, tip, fmt0, loadCore, startLive, onLive, legendKey, fTime, ago, selected, ampm } from "./common.js";
import { FLT_CAT, fltCat, ceilingOf, compass, distKm } from "./feed.js";

const CAT_VAR = { VFR: "--fc-vfr", MVFR: "--fc-mvfr", IFR: "--fc-ifr", LIFR: "--fc-lifr" };
const ORDER = ["CYYJ", "CYWH", "CYVR", "CYCD", "CYXX", "KBLI"];
const stations = () => {
  const M = Object.values(A.wx?.metar || {});
  const P = A.place;
  return M.map((m) => ({ ...m, km: distKm(P.lat, P.lon, m.lat, m.lon), cat: m.fltCat || fltCat(m.visib, m.clouds) }))
    .sort((a, b) => (A.place.home ? (ORDER.indexOf(a.icaoId) + 99) % 99 - (ORDER.indexOf(b.icaoId) + 99) % 99 : a.km - b.km)).slice(0, 8);
};
const main = () => stations()[0] || null;
const wind = (m) => (m.wspd == null ? "–" : m.wspd === 0 ? "calm" : `${m.wdir === "VRB" ? "variable" : `${m.wdir}° ${compass(+m.wdir)}`} ${m.wspd} kt${m.wgst ? ` G${m.wgst}` : ""}`);
const vis = (v) => (v == null ? "–" : `${v} mi`);          // statute miles, as reported
const ceil = (m) => { const c = ceilingOf(m.clouds); return c == null ? (m.clouds?.length ? `none (${m.clouds.map((x) => x.cover).join(" ")})` : "clear") : `${fmt0(c)} ft`; };
const hpa = (v) => (v == null ? "–" : `${Math.round(v)} hPa`);
const srcNote = () => (A.wx?.live ? `Live from NOAA's Aviation Weather Center, checked ${fTime(A.wx.fetched)}.` : A.wx ? `Logged copy from ${fTime(A.wx.fetched)}: the relay's weather route isn't answering.` : "Loading…");
const nameOf = (m) => (m.name || m.icaoId).replace(/, (BC|WA|ON), (CA|US)$/, "").replace(/ Arpt$/, "").replace(/ Intl$/, " International");

export const weather = {
  id: "wx", title: "Airport weather", tileTitle: "Airport weather", color: "var(--t-wx)",
  eyebrow: "METAR & TAF", heading: "Airport Weather",
  load: (ctx) => loadCore().then(() => startLive(ctx)),
  badge: () => { const m = main(); return m ? [m.cat || "–", `${m.icaoId}: ${FLT_CAT[m.cat] || "no category"}`] : ""; },
  kpis: () => {
    const m = main();
    if (!m) return [["Stations", "–", A.wxErr ? "weather not reachable" : "loading"]];
    return [[`${m.icaoId} conditions`, m.cat || "–", FLT_CAT[m.cat] || ""], ["Wind", wind(m), `${m.icaoId}, ${ago((m.obsTime || 0) * 1000)}`],
      ["Cloud base (ceiling)", ceil(m), "lowest broken or overcast layer"], ["Visibility", vis(m.visib), `${m.temp ?? "–"}° / dew point ${m.dewp ?? "–"}°`]];
  },
  tile: (t) => {
    const m = main(), S = stations();
    t.kpis(m ? [[m.cat || "–", `${m.icaoId} · ${(FLT_CAT[m.cat] || "").replace(/ \(.*/, "").toLowerCase()}`], [wind(m), "wind"], [ceil(m), "ceiling"]] : [["–", "loading"]]);
    t.status(A.wx?.live ? "Live" : A.wx ? "Logged" : "");
    t.vis.replaceChildren(el("div", { class: "ov-wxchips" }, ...S.slice(0, 6).map((s) => el("div", { class: "ov-wxchip", style: { "--fc": `var(${CAT_VAR[s.cat] || "--muted"})` } },
      el("b", {}, s.icaoId), el("span", { class: "ov-cat" }, s.cat || "–"), el("small", {}, `${s.wspd === 0 ? "calm" : `${s.wdir === "VRB" ? "VRB" : s.wdir}/${s.wspd} kt`} · ${s.temp ?? "–"}°`)))));
  },
  subs: [
    { id: "now", title: "Conditions", short: "Now", class: "pane-ovwx",
      view: () => renderNow(),
      html: `<div class="ov-wxhead"><p class="note" id="ov-wx-sub"></p><div class="legend" id="ov-wx-legend"></div></div><div class="ov-wxgrid" id="ov-wx"></div>` },
    { id: "taf", title: "Forecast (TAF)", short: "TAF", class: "pane-ovtaf",
      view: () => renderTaf(),
      html: `<div class="card cx-fill"><h3 class="cx-card-title">The next 30 hours, airport by airport</h3><p class="note cx-card-sub" id="ov-taf-sub"></p><div class="legend" id="ov-taf-legend"></div><div class="chart" id="ov-taf"></div></div>` },
  ],
  drawers: {
    now: (host, ctx, item) => {
      const m = A.wx?.metar?.[item]; if (!m) return null;
      const t = A.wx?.taf?.[item], cat = m.fltCat || fltCat(m.visib, m.clouds);
      return { kicker: `METAR · ${item}`, title: nameOf(m), body: [
        dStats([[cat || "–", FLT_CAT[cat] || "flight category"], [wind(m), "wind (true)"], [ceil(m), "ceiling"], [vis(m.visib), "visibility"],
          [`${m.temp ?? "–"}° / ${m.dewp ?? "–"}°`, "temperature / dew point"], [hpa(m.altim), "altimeter"]], true),
        el("pre", { class: "ov-raw" }, m.rawOb || ""),
        dNote(`Observed ${fTime((m.obsTime || 0) * 1000)} (${ago((m.obsTime || 0) * 1000)}). ${srcNote()}`),
        t ? dHead("Forecast (TAF)") : dNote("This station issues no TAF."),
        t ? el("pre", { class: "ov-raw" }, t.rawTAF) : null,
      ] };
    },
  },
};
onLive(() => { const r = A.ctx?.route; if (r?.topic === "wx" && $("ov-wx")?.isConnected) (r.sub === "taf" ? renderTaf : renderNow)(); });

function catLegend(host) {
  $(host).replaceChildren(...Object.entries(FLT_CAT).map(([k, l]) => legendKey(CAT_VAR[k], l, "band")));
}
function renderNow() {
  const S = stations(), sel = selected("wx", "now");
  $("ov-wx-sub").textContent = `${srcNote()} Flight categories follow visibility and cloud base: VFR is good flying weather, LIFR is fog-bound.`;
  catLegend("ov-wx-legend");
  $("ov-wx").replaceChildren(...(S.length ? S.map((m) => el("a", { class: `card ov-wxcard${sel === m.icaoId ? " on" : ""}`, href: href("wx", "now", m.icaoId), style: { "--fc": `var(${CAT_VAR[m.cat] || "--muted"})` } },
    el("header", {}, el("b", {}, m.icaoId), el("span", { class: "ov-cat" }, m.cat || "–"), el("small", {}, `${nameOf(m)} · ${Math.round(m.km)} km`)),
    el("dl", {}, el("dt", {}, "Wind"), el("dd", {}, wind(m)), el("dt", {}, "Ceiling"), el("dd", {}, ceil(m)), el("dt", {}, "Visibility"), el("dd", {}, vis(m.visib)),
      el("dt", {}, "Temp / dew"), el("dd", {}, `${m.temp ?? "–"}° / ${m.dewp ?? "–"}°`), el("dt", {}, "Altimeter"), el("dd", {}, hpa(m.altim)), el("dt", {}, "Observed"), el("dd", {}, ago((m.obsTime || 0) * 1000))),
    el("code", {}, (m.rawOb || "").replace(/^(METAR|SPECI) /, ""))))
    : [el("p", { class: "note" }, A.wxErr ? `Weather isn't reachable: ${A.wxErr.message}.` : "Loading…")]));
}

function renderTaf() {
  const S = stations().filter((m) => A.wx?.taf?.[m.icaoId]);
  $("ov-taf-sub").textContent = `Each bar is a forecast period coloured by its flight category (visibility and cloud base); thinner striped bars underneath are TEMPO or PROB changes. ${srcNote()}`;
  catLegend("ov-taf-legend");
  const t0 = new Date(), t1 = new Date(Date.now() + 30 * 3600e3);
  const { g, iw, ih } = frame("ov-taf", { l: 70, r: 12, t: 8, b: 24 }, 260);
  if (!S.length) { g.append("text").attr("class", "axis-t").attr("x", iw / 2).attr("y", ih / 2).attr("text-anchor", "middle").text(A.wx ? "No TAFs for these stations" : "Loading…"); return; }
  const x = d3.scaleTime([t0, t1], [0, iw]), y = d3.scaleBand(S.map((s) => s.icaoId), [0, ih]).padding(0.25);
  g.append("g").attr("class", "grid").selectAll("line").data(x.ticks(d3.timeHour.every(6))).join("line").attr("x1", x).attr("x2", x).attr("y1", 0).attr("y2", ih);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(d3.timeHour.every(6)).tickFormat((d) => ampm(d.toLocaleTimeString("en-CA", { weekday: "short", hour: "numeric", timeZone: A.place.home ? "America/Vancouver" : undefined }))).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickSize(0).tickPadding(8)).call(axisClean);
  for (const s of S) {
    const T = A.wx.taf[s.icaoId], yb = y(s.icaoId), bh = y.bandwidth();
    // base periods: initial + FM / BECMG carry forward the previous values that a change group doesn't restate
    let cur = {};
    const base = [], temp = [];
    for (const f of T.fcsts || []) {
      if (f.fcstChange === "TEMPO" || f.fcstChange === "PROB") { temp.push({ ...cur, ...strip(f), timeFrom: f.timeFrom, timeTo: f.timeTo, kind: f.fcstChange === "PROB" ? `PROB${f.probability || ""}` : "TEMPO" }); continue; }
      cur = f.fcstChange === "BECMG" ? { ...cur, ...strip(f) } : { ...strip(f) };
      base.push({ ...cur, timeFrom: f.timeFrom, timeTo: f.timeTo, kind: f.fcstChange || "initial" });
    }
    const bar = (p, yy, hh, striped) => {
      const a = x(new Date(Math.max(+t0, p.timeFrom * 1000))), b = x(new Date(Math.min(+t1, p.timeTo * 1000)));
      if (b <= a) return;
      const cat = fltCat(p.visib, p.clouds) || "VFR";
      g.append("rect").attr("x", a).attr("y", yy).attr("width", Math.max(1, b - a - 1)).attr("height", hh).attr("rx", 2)
        .style("fill", `var(${CAT_VAR[cat]})`).style("opacity", striped ? 0.55 : 0.9).style("stroke", striped ? `var(${CAT_VAR[cat]})` : null).style("stroke-dasharray", striped ? "3 2" : null)
        .on("pointermove", (e) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `${s.icaoId} · ${p.kind}`),
          tipRow(cssVar(CAT_VAR[cat]), cat, FLT_CAT[cat]), tipRow(null, p.wspd != null ? `${p.wdir ?? "–"}° ${p.wspd} kt${p.wgst ? ` G${p.wgst}` : ""}` : "–", "wind"),
          tipRow(null, `${p.visib ?? "–"} SM · ceiling ${ceilingOf(p.clouds) ?? "none"}`, p.wxString || ""),
          el("div", { class: "note" }, `${new Date(p.timeFrom * 1000).toLocaleString("en-CA", { weekday: "short", hour: "numeric", minute: "2-digit" })} – ${new Date(p.timeTo * 1000).toLocaleString("en-CA", { weekday: "short", hour: "numeric", minute: "2-digit" })}`))))
        .on("pointerleave", () => tip.hide());
      if (!striped && b - a > 60 && p.wspd != null) g.append("text").attr("class", "axis-t ov-onbar").attr("x", a + 5).attr("y", yy + hh / 2).attr("dy", "0.35em").text(`${p.wdir === "VRB" ? "VRB" : p.wdir ?? ""} ${p.wspd} kt`);
    };
    for (const p of base) bar(p, yb, bh * 0.66, false);
    for (const p of temp) bar(p, yb + bh * 0.72, bh * 0.28, true);
  }
}
const strip = (f) => Object.fromEntries(Object.entries(f).filter(([k, v]) => v != null && !(Array.isArray(v) && !v.length) && !["timeFrom", "timeTo", "fcstChange", "probability"].includes(k)));
