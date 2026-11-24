// Airports: who is arriving and departing right now at YYJ and the harbour (from the live feed), runway diagrams with
// the current wind, radio frequencies and every aerodrome nearby (OurAirports).
import * as d3 from "d3";
import { cssVar, el, tipRow } from "../shared/ui.js";
import { frame, gridY, axisClean, colPath } from "../shared/charts.js";
import { href } from "../shared/console.js";
import { A, $, tip, fmt0, allAircraft, whenTxt, isLive, loadCore, loadWorld, startLive, onLive, aeroZones, fTime } from "./common.js";
import { typeInfo, callsign, fAlt, nearestAirports, windOn, compass, distKm } from "./feed.js";

const TYPE_LABEL = { large_airport: "Airports", medium_airport: "Airports", small_airport: "Small airfields", seaplane_base: "Seaplane bases (water aerodromes)", heliport: "Heliports", balloonport: "Other" };
const idOf = (a) => a.hex || `p${a.lat},${a.lon}`;
let pick = null;                     // aerodrome shown in Runways & radio

const inZones = () => allAircraft().filter((a) => a.at);
const localAero = () => (A.place.home ? (A.airports?.airports || []) : []);
function runwayAeros() {
  if (A.place.home) return localAero().filter((x) => x.icao === "CYWH" || (x.type !== "heliport" && x.km <= 45 && x.runways.some((r) => r.le_lat != null))).slice(0, 8);
  return [];
}
const metarFor = (id) => A.wx?.metar?.[id] || null;
const nearestMetar = (lat, lon) => {
  const m = Object.values(A.wx?.metar || {}).map((x) => ({ x, d: distKm(lat, lon, x.lat, x.lon) })).sort((a, b) => a.d - b.d)[0];
  return m && m.d < 40 ? m.x : null;
};

export const airports = {
  id: "airports", title: "Airports", tileTitle: "Arrivals & runways", color: "var(--t-air)",
  eyebrow: "Airports & aerodromes", heading: "Arrivals, Departures & Runways",
  load: (ctx) => loadCore().then(() => (A.place.home ? null : loadWorld())).then(() => startLive(ctx)),
  badge: () => [`${inZones().length}`, "aircraft arriving, departing or low near an aerodrome"],
  kpis: () => {
    const Z = aeroZones();
    return [
      ...Z.map((z) => { const n = inZones().filter((a) => a.at.id === z.id); return [`${z.short} right now`, `${n.length}`, n.length ? n.map((a) => `${callsign(a)} ${a.at.move}`).slice(0, 2).join(", ") : `nothing within ${z.zone_km} km below ${fmt0(z.ceiling_ft)} ft`]; }),
      ["Aerodromes nearby", `${A.place.home ? localAero().length : nearestAirports(A.world, A.place.lat, A.place.lon, 50, A.place.r * 1.852).length}`, A.place.home ? "within 60 km, incl. seaplane bases and helipads" : "large and medium airports in the circle"],
    ].filter(Boolean);
  },
  tile: (t) => {
    const Z = aeroZones(), nAero = A.place.home ? localAero().length : nearestAirports(A.world, A.place.lat, A.place.lon, 50, A.place.r * 1.852).length;
    t.kpis([...Z.slice(0, 2).map((z) => [`${inZones().filter((a) => a.at.id === z.id).length}`, `near ${z.short} now`]), [`${nAero}`, "aerodromes nearby"]]);
    t.status(isLive() ? "Live" : "");
    const yyj = localAero().find((x) => x.icao === "CYYJ");
    if (yyj) runwayDiagram(t.vis, yyj, metarFor("CYYJ"), { mini: true });
    else nearList(t.vis, true);
  },
  subs: [
    { id: "moves", title: "Arrivals & departures", short: "Moves", class: "pane-ovmoves",
      view: () => renderZones(),
      html: `<div class="card cx-fill"><h3 class="cx-card-title">Right now near each aerodrome</h3><p class="note cx-card-sub" id="ov-mv-sub"></p><div class="ov-zones cx-grow" id="ov-zones"></div></div>` },
    { id: "runways", title: "Runways & radio", short: "Runways", class: "pane-ovrwy",
      view: () => renderRunways(),
      html: `<div class="ov-seg seg" id="ov-rw-seg"></div>
      <div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title" id="ov-rw-t"></h3><p class="note cx-card-sub" id="ov-rw-sub"></p><div class="chart" id="ov-rw"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">Runway ends and the wind</h3><div class="ov-rwtab cx-grow" id="ov-rw-tab"></div><h3 class="cx-card-title ov-mt">Radio</h3><div class="ov-freqs cx-grow" id="ov-freqs"></div></div>
      </div>` },
    { id: "nearby", title: "Aerodromes nearby", short: "Nearby", class: "pane-ovnear",
      view: () => nearList($("ov-near")),
      html: `<div class="card cx-fill"><h3 class="cx-card-title">Every aerodrome in reach</h3><p class="note cx-card-sub" id="ov-near-sub"></p><div class="ov-near cx-grow" id="ov-near"></div></div>` },
  ],
};
onLive(() => { const r = A.ctx?.route; if (r?.topic === "airports" && r.sub === "moves" && $("ov-zones")?.isConnected) renderZones(); });

// ------------------------------------------------------------------ arrivals & departures
function renderZones() {
  const Z = aeroZones();
  $("ov-mv-sub").textContent = `Aircraft inside each aerodrome's watch zone, ${whenTxt()}: arriving = descending, departing = climbing, from the live vertical rate.`;
  $("ov-zones").replaceChildren(...(Z.length ? Z.map((z) => {
    const L = inZones().filter((a) => a.at.id === z.id).sort((a, b) => a.at.d - b.at.d);
    return el("section", { class: "ov-zone" }, el("h4", {}, z.name || z.short, el("small", {}, ` within ${z.zone_km} km, below ${fmt0(z.ceiling_ft)} ft`)),
      L.length ? el("ul", {}, ...L.map((a) => el("li", {}, el("a", { href: href("now", "map", idOf(a)) }, el("b", { class: `mv-${a.at.move.split(" ")[0]}` }, a.at.move),
        el("span", {}, `${callsign(a)} · ${typeInfo(a.type, a.cat).name}`), el("small", {}, `${fAlt(a.alt)} · ${a.at.d.toFixed(1)} km`)))))
        : el("p", { class: "note" }, "Nothing low in the zone right now."));
  }) : [el("p", { class: "note" }, "No aerodrome zones for this place yet.")]));
}
// ------------------------------------------------------------------ runways & radio
function renderRunways() {
  const list = runwayAeros();
  if (!list.length) {
    $("ov-rw-seg").replaceChildren();
    $("ov-rw-t").textContent = "Runway diagrams";
    $("ov-rw-sub").textContent = "Runway geometry is loaded for Greater Victoria's aerodromes. Elsewhere, see the nearby list.";
    nearList($("ov-rw"), true); $("ov-rw-tab").replaceChildren(); $("ov-freqs").replaceChildren();
    return;
  }
  if (!pick || !list.some((x) => x.ident === pick)) pick = list.find((x) => x.icao === "CYYJ")?.ident || list[0].ident;
  $("ov-rw-seg").replaceChildren(...list.map((x) => el("button", { type: "button", "aria-pressed": String(x.ident === pick), onclick: () => { pick = x.ident; renderRunways(); } }, shortName(x))));
  const ap = list.find((x) => x.ident === pick), m = metarFor(ap.icao) || nearestMetar(ap.lat, ap.lon);
  $("ov-rw-t").textContent = `${ap.name} (${ap.icao || ap.ident}${ap.iata ? ` / ${ap.iata}` : ""})`;
  $("ov-rw-sub").textContent = m ? `Wind ${m.wdir === "VRB" ? "variable" : `from ${m.wdir}° (${compass(+m.wdir)})`} at ${m.wspd} kt${m.wgst ? ` gusting ${m.wgst}` : ""}, from ${m.icaoId}'s report at ${fTime((m.obsTime || 0) * 1000)}${A.wx?.live ? "" : " (logged)"} · runway headings are true, as METAR winds are`
    : "No current weather report for this aerodrome.";
  runwayDiagram($("ov-rw"), ap, m);
  const rows = [];
  for (const r of ap.runways) {
    if (r.le_hdg == null) { rows.push([`${r.le}/${r.he}`, `${fmt0(r.length_ft || 0)} ft · ${r.surface || ""}`, ""]); continue; }
    for (const [end, hdg] of [[r.le, r.le_hdg], [r.he, (r.le_hdg + 180) % 360]]) {
      const w = m ? windOn(hdg, m.wdir, m.wspd) : null;
      rows.push([`Runway ${end}`, `${Math.round(hdg)}° true · ${fmt0(r.length_ft || 0)} ft`, w ? `${w.head >= 0 ? "head" : "tail"} ${Math.abs(w.head)} kt · cross ${Math.abs(w.cross)} kt` : "–", w]);
    }
  }
  const best = rows.filter((r) => r[3]).sort((a, b) => b[3].head - a[3].head)[0];
  $("ov-rw-tab").replaceChildren(
    ...(ap.icao === "CYWH" ? [el("p", { class: "note" }, "A water aerodrome: floatplanes take off and land on marked water lanes in the outer and inner harbour, not runways, so there is nothing to draw.")] : []),
    ...rows.map(([a, b, c, w]) => el("div", { class: `ov-rwrow${best && best[0] === a ? " best" : ""}` }, el("b", {}, a), el("span", {}, b), el("small", {}, c))),
    best ? el("p", { class: "note" }, `Most headwind: ${best[0]}. Pilots usually take off and land into the wind, but the tower picks the runway (noise, traffic, works).`) : null);
  $("ov-freqs").replaceChildren(...(ap.freqs.length ? ap.freqs.map((f) => el("div", { class: "ov-freq" }, el("b", {}, f.mhz ? f.mhz.toFixed(3) : "–"), el("span", {}, `${f.type}${f.desc && f.desc !== f.type ? ` · ${f.desc}` : ""}`)))
    : [el("p", { class: "note" }, "No frequencies listed in OurAirports.")]),
    el("p", { class: "note" }, "From OurAirports (volunteer-maintained): not for navigation. Listening to air traffic control is legal in Canada; recording or sharing what you hear is not."));
}
const shortName = (x) => (x.icao === "CYYJ" ? "YYJ" : x.icao === "CYWH" ? "Harbour" : x.name.replace(/ (Airport|Seaplane Base|Water Aerodrome)$/, "").replace(/^Victoria /, ""));

/** runway diagram: runways from their end coordinates, the wind as an arrow blowing across it */
function runwayDiagram(host, ap, m, { mini = false } = {}) {
  const pad = mini ? 16 : 34;
  const { svg, g, iw, ih } = frame(host, { l: 4, r: 4, t: 4, b: 4 }, mini ? 170 : 340);
  const rw = ap.runways.filter((r) => r.le_lat != null && r.he_lat != null);
  if (!rw.length) { g.append("text").attr("class", "axis-t").attr("x", iw / 2).attr("y", ih / 2).attr("text-anchor", "middle").text(ap.icao === "CYWH" ? "Water lanes: no runways" : "No runway coordinates in OurAirports"); return; }
  const kx = Math.cos((ap.lat * Math.PI) / 180);
  const pts = rw.flatMap((r) => [[r.le_lon * kx, -r.le_lat], [r.he_lon * kx, -r.he_lat]]);
  const [x0, x1] = d3.extent(pts, (p) => p[0]), [y0, y1] = d3.extent(pts, (p) => p[1]);
  const s = Math.min((iw - 2 * pad) / (x1 - x0 || 1e-3), (ih - 2 * pad) / (y1 - y0 || 1e-3));
  const P = (lat, lon) => [pad + (lon * kx - x0) * s + (iw - 2 * pad - (x1 - x0) * s) / 2, pad + (-lat - y0) * s + (ih - 2 * pad - (y1 - y0) * s) / 2];
  const ftPx = s / (111320 * 3.2808 / 1);           // px per foot (1° ≈ 111.32 km)
  for (const r of rw) {
    const [ax, ay] = P(r.le_lat, r.le_lon), [bx, by] = P(r.he_lat, r.he_lon);
    const w = Math.max(mini ? 4 : 7, Math.min(18, (r.width_ft || 150) * ftPx * 3));
    g.append("line").attr("x1", ax).attr("y1", ay).attr("x2", bx).attr("y2", by).style("stroke", "var(--ink-2)").style("stroke-width", w).style("stroke-linecap", "butt").style("opacity", 0.85);
    g.append("line").attr("x1", ax).attr("y1", ay).attr("x2", bx).attr("y2", by).style("stroke", "var(--surface)").style("stroke-width", 1).style("stroke-dasharray", "6 5").style("opacity", 0.8);
    const ang = Math.atan2(by - ay, bx - ax);
    for (const [x, y, lbl, dir] of [[ax, ay, r.le, -1], [bx, by, r.he, 1]]) {
      g.append("text").attr("class", "axis-t halo ov-rwlbl").attr("x", x + dir * Math.cos(ang) * (mini ? 9 : 14)).attr("y", y + dir * Math.sin(ang) * (mini ? 9 : 14)).attr("dy", "0.35em").attr("text-anchor", "middle").text(lbl);
    }
  }
  if (m && m.wdir != null && m.wdir !== "VRB" && m.wspd) {
    const a = ((+m.wdir + 180) * Math.PI) / 180;            // blowing towards
    const cx = iw - (mini ? 26 : 50), cy = mini ? 26 : 50, L = mini ? 18 : 34;
    const dx = Math.sin(a) * L, dy = -Math.cos(a) * L;
    svg.append("defs").html(`<marker id="ov-wa-${mini ? "m" : "b"}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--t-wx)"/></marker>`);
    g.append("circle").attr("cx", cx).attr("cy", cy).attr("r", L + 4).style("fill", "var(--surface-2)").style("opacity", 0.7);
    g.append("line").attr("x1", cx - dx).attr("y1", cy - dy).attr("x2", cx + dx).attr("y2", cy + dy).style("stroke", "var(--t-wx)").style("stroke-width", 2.4).attr("marker-end", `url(#ov-wa-${mini ? "m" : "b"})`);
    g.append("text").attr("class", "axis-t halo").attr("x", cx).attr("y", cy + L + (mini ? 12 : 16)).attr("text-anchor", "middle").text(`${m.wdir}° ${m.wspd} kt`);
  } else if (m) g.append("text").attr("class", "axis-t").attr("x", iw - 4).attr("y", 12).attr("text-anchor", "end").text(m.wspd ? "wind variable" : "calm");
  if (!mini) g.append("text").attr("class", "axis-t").attr("x", 4).attr("y", ih - 4).text("North up · runway widths exaggerated");
}

// ------------------------------------------------------------------ aerodromes nearby
function nearList(host, mini = false) {
  host = $(host);
  let rows;
  if (A.place.home && A.airports) {
    rows = A.airports.airports.map((x) => ({ name: x.name, id: x.icao || x.ident, iata: x.iata, type: x.type, km: x.km, rw: x.runways.length, sched: x.scheduled }));
  } else {
    rows = nearestAirports(A.world, A.place.lat, A.place.lon, 40, Math.max(80, A.place.r * 1.852 * 1.5)).map((x) => ({ name: x.name, id: x.ident, iata: x.iata, type: x.size === "L" ? "large_airport" : "medium_airport", km: x.km, rw: x.runways, sched: !!x.scheduled }));
  }
  const sub = $("ov-near-sub");
  if (sub && !mini) sub.textContent = A.place.home ? `${rows.length} aerodromes within ${A.airports?.radius_km} km of ${A.place.short}'s centre, from OurAirports: airports, airfields, seaplane bases and helipads (hospital pads included).`
    : `Large and medium airports near ${A.place.name}, from OurAirports. Smaller aerodromes are listed for Greater Victoria only.`;
  if (!rows.length) { host.replaceChildren(el("p", { class: "note" }, A.world || A.airports ? "No aerodromes listed nearby." : "Loading…")); return; }
  if (mini) {
    const big = rows.filter((r) => /large|medium/.test(r.type)).slice(0, 6);
    host.replaceChildren(el("div", { class: "ov-mini-list" }, ...big.map((r) => el("div", {}, el("b", {}, r.iata || r.id), el("span", {}, r.name), el("small", {}, `${Math.round(r.km)} km`)))));
    return;
  }
  const groups = d3.groups(rows, (r) => TYPE_LABEL[r.type] || "Other");
  host.replaceChildren(...groups.map(([g, L]) => el("section", { class: "ov-ngroup" }, el("h4", {}, `${g} · ${L.length}`),
    el("ul", {}, ...L.map((r) => el("li", {}, el("b", {}, r.iata || r.id), el("span", {}, r.name, r.sched ? el("em", { class: "ov-sched" }, "scheduled") : null), el("small", {}, `${r.km.toFixed(0)} km${r.rw ? ` · ${r.rw} runway${r.rw === 1 ? "" : "s"}` : ""}`)))))));
}
