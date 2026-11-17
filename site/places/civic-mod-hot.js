// Open Places: What's Hot Now (Lifestyle, first). Picks what's in season for the place and the date and puts the map on it:
// cherry blossoms in spring, fall colour in autumn, surf and storm watching in winter, plus the salmon run, the eagles and
// the whales when they're on. One hero card says what's hot and why; the map zooms to the best spots with markers; a second
// panel lists the spots (the surf forecast per break, the best streets, the forecast sites). Click another season's row to
// put the map on it; click it again to go back to the pick of the day. Wrapped by mod() in civic-modules.js (block `hot`).
//
// Sources (each named on the page)
//   Surf and storm watching: Open-Meteo Marine API (CC BY 4.0), live from the browser, one request per hour for every spot:
//       swell height, period and direction for 3 days, at a sea point ~3 km off each beach. Spots: outdoors/surf_spots.json
//       (pipelines/outdoors: OSM sport=surfing, ODbL, plus a short hand list of public breaks with their sources).
//       Rating per hour, daylight only: the swell that reaches the beach (height × how squarely it comes from the way the
//       beach faces) and its period. good: ≥ 1 m and ≥ 10 s · fair: ≥ 0.6 m and ≥ 7 s · flat: less · big: ≥ 4.5 m (for
//       watching, not surfing). Waves only: wind and tide aren't in it, so it's a first look, not a surf report.
//   Cherry blossoms, fall colour, whales: the same published data and models as those pages (civic-stage-nature.js).
//   Salmon run and eagles at Goldstream: a calendar from BC Parks' own description of the park (chum salmon spawn from late
//       October into December; bald eagles gather from mid-December to February). Shown as "Calendar", not live data.
import * as d3 from "d3";
import maplibregl from "maplibre-gl";
import { el } from "../src/shared/ui.js";
import { addAreaLayers } from "../src/shared/area.js";
import { file, km, chainOf, fDate } from "./civic-data.js";
import { color } from "./civic-stage.js";
import { float } from "./civic-float.js";
import { blossomModel, foliageModel, salishModel, WHALE_SPECIES, dateOfDoy, fDate0, stName } from "./civic-stage-nature.js";
import { parksData } from "./civic-mod-trails.js";
import "./civic-mod-hot.css";

const MARINE = "https://marine-api.open-meteo.com/v1/marine";
const TZ = "America/Vancouver";
const inCRD = (ctx) => chainOf(ctx.place).some((n) => n.id === "crd");
const regionOf = (ctx) => (inCRD(ctx) ? "crd" : chainOf(ctx.place).some((n) => n.id === "metrovan") ? "metrovan" : null);
const fc = (features) => ({ type: "FeatureCollection", features });
const pt = (ll, properties) => ({ type: "Feature", geometry: { type: "Point", coordinates: ll }, properties });
const doy = (d) => d3.timeDay.count(d3.timeYear(d), d) + 1;
const inWin = (d, [m0, d0], [m1, d1]) => { const x = d.getMonth() * 100 + d.getDate(), a = (m0 - 1) * 100 + d0, b = (m1 - 1) * 100 + d1; return a <= b ? x >= a && x <= b : x >= a || x <= b; };
const hhmm = d3.timeFormat("%a %-I %p");
/** "today at 4 pm", "tomorrow at 9 am", "on Wednesday at 2 pm" */
const when = (d) => { const n = d3.timeDay.count(d3.timeDay(new Date()), d); return `${n <= 0 ? "today" : n === 1 ? "tomorrow" : `on ${d3.timeFormat("%A")(d)}`} at ${d3.timeFormat("%-I %p")(d).toLowerCase()}`; };
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

// ================================================================== surf: Open-Meteo Marine per spot (own hourly cache)
const marine = new Map();
function marineFor(spots, ctx) {
  const k = spots.map((s) => s.id).join(",");
  let c = marine.get(k);
  if (!c || (Date.now() - c.at > 60 * 60e3 && !c.busy)) {
    c = { data: c?.data || null, err: null, at: Date.now(), busy: true };
    marine.set(k, c);
    const q = new URLSearchParams({ latitude: spots.map((s) => s.sea[1]).join(","), longitude: spots.map((s) => s.sea[0]).join(","), timezone: TZ, forecast_days: "3", cell_selection: "sea",
      hourly: "wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period,swell_wave_direction" });
    fetch(`${MARINE}?${q}`).then((r) => { if (!r.ok) throw new Error(`Open-Meteo Marine ${r.status}`); return r.json(); })
      .then((j) => { c.data = Array.isArray(j) ? j : [j]; c.busy = false; ctx?.refresh?.(); }, (e) => { c.err = e; c.busy = false; console.warn("[hot] marine:", e?.message || e); ctx?.refresh?.(); });
  }
  return c;
}
const RATE = { big: ["Big", 4], good: ["Good", 3], fair: ["Fair", 2], flat: ["Flat", 1] };
/** one hour at one spot → "big" | "good" | "fair" | "flat" */
function rate(h, T, dir, facing) {
  if (h == null || T == null) return null;
  const diff = facing == null || dir == null ? 30 : Math.abs((((dir - facing) % 360) + 540) % 360 - 180);
  const f = diff <= 40 ? 1 : diff <= 70 ? 0.65 : diff <= 100 ? 0.3 : 0.1, e = h * f;
  if (h >= 4.5 && f >= 0.3) return "big";
  if (e >= 1 && T >= 10) return "good";
  if (e >= 0.6 && T >= 7) return "fair";
  return "flat";
}
function surfModel(ctx) {
  const S = file("outdoors/surf_spots.json", ctx).data;
  if (!S) return null;
  const spots = S.spots.filter((s) => s.sea);
  const c = marineFor(spots, ctx);
  if (!c.data) return { spots: spots.map((s) => ({ ...s, km: km(s.ll, ctx.place.ll) })), loading: !c.err, err: c.err, S };
  const now = Date.now();
  const out = spots.map((s, i) => {
    const m = c.data[i]?.hourly; if (!m) return { ...s, km: km(s.ll, ctx.place.ll) };
    const hours = m.time.map((t, k) => {
      const at = new Date(t), h = m.swell_wave_height[k] ?? m.wave_height[k], T = m.swell_wave_period[k] ?? m.wave_period[k], dir = m.swell_wave_direction[k] ?? m.wave_direction[k];
      return { at, h, T, dir, wh: m.wave_height[k], r: rate(h, T, dir, s.facing), day: at.getHours() >= 7 && at.getHours() <= 17 };
    });
    const nowI = Math.max(0, hours.findIndex((x) => +x.at > now - 36e5));
    const ahead = hours.slice(nowI).filter((x) => x.day && x.r);
    const best = ahead.slice().sort((a, b) => (RATE[b.r][1] === 4 ? 2.5 : RATE[b.r][1]) - (RATE[a.r][1] === 4 ? 2.5 : RATE[a.r][1]) || b.h - a.h)[0] || null;
    const peak = hours.slice(nowI).reduce((a, b) => (b.wh > (a?.wh ?? -1) ? b : a), null);
    return { ...s, km: km(s.ll, ctx.place.ll), hours, now: hours[nowI], best, peak };
  });
  return { spots: out, S, at: c.at };
}
const surfScore = (r) => (r === "good" ? 0.92 : r === "fair" ? 0.68 : r === "big" ? 0.6 : 0.2);

// ================================================================== the season's candidates
// Each: { id, title, tag ("Live" | "Data" | "Calendar"), score 0–1, why, short, color, href?, markers: [{ id, ll, label, sub, c, r }],
//         area?: park id to highlight, rows: [[name, value, onclick?]] for the spots panel, src }
function candidates(ctx) {
  const d = ctx.date, out = [], pending = [];
  // ---------------------------------------------------------------- surf + storm watching (winter swell season)
  const sm = surfModel(ctx);
  if (!sm) pending.push("surf spots");
  else if (!sm.spots[0]?.hours) { if (sm.loading) pending.push("wave forecast"); }
  else {
    const winter = inWin(d, [10, 1], [4, 15]);
    const ok = sm.spots.filter((s) => s.best);
    const ranked = ok.slice().sort((a, b) => RATE[b.best.r][1] - RATE[a.best.r][1] || a.km - b.km);
    const top = ranked.find((s) => s.best.r === "good" || s.best.r === "fair") || ranked[0];
    const near = ranked.filter((s) => s.km < 120 && (s.best.r === "good" || s.best.r === "fair"));
    const focus = (near.length ? near : ranked.filter((s) => s.best.r === "good" || s.best.r === "fair")).slice(0, 5);
    const sc = top ? surfScore(top.best.r) * (winter ? 1 : 0.7) : 0.1;
    const col = (r) => (r === "good" ? "var(--live, #2f8f45)" : r === "fair" ? "var(--warn)" : r === "big" ? "var(--bad)" : "var(--muted)");
    out.push({ id: "surf", title: "Surf Season", tag: "Live", score: sc, color: "var(--m-hot)", href: "#nature/surf",
      why: top ? `${winter ? "Winter swell is in. " : ""}${top.name} looks ${RATE[top.best.r][0].toLowerCase()} ${when(top.best.at)}: ${top.best.h.toFixed(1)} m at ${Math.round(top.best.T)} s from the ${compass(top.best.dir)}.`
        : "No forecast for the breaks yet.",
      short: top ? `${top.name}: ${RATE[top.best.r][0].toLowerCase()}` : "—",
      markers: (focus.length ? focus : ranked.slice(0, 4)).concat(ranked.filter((s) => !focus.includes(s))).map((s) => ({ id: s.id, ll: s.ll, label: s.name, sub: `${RATE[s.best.r][0]} · ${s.best.h.toFixed(1)} m ${Math.round(s.best.T)} s`, c: col(s.best.r), r: focus.includes(s) ? 8 : 5.5, dim: !focus.includes(s) })),
      fit: (focus.length ? focus : ranked.slice(0, 4)).map((s) => s.ll),
      spots: ranked, src: "Waves: Open-Meteo Marine (CC BY 4.0) · spots: OpenStreetMap (ODbL) and park pages", kind: "surf" });
    // storm watching: big Pacific swell on the open coast in the storm months
    const big = sm.spots.filter((s) => s.peak && s.peak.wh >= 4).sort((a, b) => b.peak.wh - a.peak.wh);
    if (big.length) {
      const b = big[0], storms = inWin(d, [11, 1], [2, 28]);
      out.push({ id: "storm", title: "Storm Watching", tag: "Live", score: Math.min(0.9, (storms ? 0.62 : 0.4) + (b.peak.wh - 4) * 0.06), color: "var(--m-tsunami, #1d5fa0)",
        why: `Waves up to ${b.peak.wh.toFixed(1)} m at ${b.name} ${when(b.peak.at)}: the open Pacific coast at its wildest. Watch from the headlands and stay off logs and rocks.`,
        short: `${b.peak.wh.toFixed(1)} m at ${b.name}`,
        markers: big.slice(0, 6).map((s) => ({ id: s.id, ll: s.ll, label: s.name, sub: `up to ${s.peak.wh.toFixed(1)} m`, c: "var(--m-tsunami, #1d5fa0)", r: 7 })), fit: big.slice(0, 6).map((s) => s.ll),
        spots: big, src: "Waves: Open-Meteo Marine (CC BY 4.0)", kind: "storm" });
    }
  }
  // ---------------------------------------------------------------- cherry blossoms (spring)
  const b = loaded(ctx, "blossom/forecast.json", "blossom/meta.json", "blossom/streets.json") ? safe(() => blossomModel(ctx)) : (pending.push("blossom"), null);
  if (b) {
    const first = b.groups[0], last = b.groups.at(-1), y = b.y;
    const now = ctx.date, from = d3.timeDay.offset(first.p10, -21), to = last.p90;
    if (now >= from && now <= to) {
      const days = Math.round((first.mid - now) / 864e5);
      out.push({ id: "blossom", title: "Cherry Blossoms", tag: "Data", score: b.inBloom ? 0.95 : 0.55, color: "var(--m-blossom)", href: "#nature/blossom",
        why: b.inBloom ? `Trees are in bloom now. ${stName(b.streets[0].street)} leads with about ${Math.round(b.streets[0].out)} trees out today.` : `First peak ${fDate(first.mid)}${days > 0 ? `, in ${days} days` : ""}; Yoshino and the Japanese cherries follow.`,
        short: b.inBloom ? "in bloom now" : `peak ${fDate(first.mid)}`,
        markers: b.streets.slice(0, 8).map((s, i) => ({ id: s.id, ll: [s.lon, s.lat], label: `${i + 1}  ${stName(s.street)}`, sub: b.inBloom ? `${Math.round(s.out)} in bloom` : `best ${fDate(dateOfDoy(s.day, y))}`, c: "var(--m-blossom)", r: 8 - i * 0.4 })),
        rows: b.streets.slice(0, 8).map((s) => [stName(s.street), b.inBloom ? `${Math.round(s.out)} out` : fDate(dateOfDoy(s.day, y))]), src: "Street trees (city inventories) · ECCC weather · Open Places forecast", kind: "blossom" });
    }
  }
  // ---------------------------------------------------------------- fall colour (autumn)
  const f = loaded(ctx, "foliage/foliage.json") ? safe(() => foliageModel(ctx)) : (pending.push("foliage"), null);
  if (f && f.raw >= 250 && f.raw <= 335) {
    const sites = Object.entries(f.F.sites).filter(([, s]) => s.region === f.k).map(([id, s]) => ({ id, ...s }));
    const pc = f.city.colour, bare = f.city.bare;
    out.push({ id: "foliage", title: "Fall Colour", tag: "Data", score: Math.min(0.9, 0.25 + pc * 1.1) * (bare > 0.6 ? 0.6 : 1), color: "var(--m-foliage)", href: "#nature/foliage",
      why: `${Math.round(pc * 100)}% of ${f.c.name}'s street trees are showing colour and ${Math.round(bare * 100)}% are mostly bare (modelled for ${fDate(fDate0(f.d, f.y))}).`,
      short: `${Math.round(pc * 100)}% colour`,
      markers: sites.map((s) => ({ id: s.id, ll: [s.lon, s.lat], label: s.name, sub: s.forecast ? `peak ${fDate(fDate0(Math.round(s.forecast.p50), f.y))}` : "", c: "var(--m-foliage)", r: 7 })),
      rows: sites.map((s) => [s.name, s.forecast ? `peak ${fDate(fDate0(Math.round(s.forecast.p50), f.y))}` : "no forecast"]), src: "Street trees (city open data) · MODIS green-down · Open Places model", kind: "foliage" });
  }
  // ---------------------------------------------------------------- Goldstream: salmon run, then the eagles (calendar)
  if (inCRD(ctx)) {
    const GOLD = [-123.5528, 48.4797];
    if (inWin(d, [10, 15], [12, 15])) {
      const peak = inWin(d, [11, 1], [11, 30]);
      out.push({ id: "salmon", title: "Salmon Run", tag: "Calendar", score: peak ? 0.8 : 0.45, color: "var(--m-salish)", href: "https://bcparks.ca/goldstream-park/",
        why: `Chum salmon are spawning in the Goldstream River${peak ? ", at its peak in November" : ""}, ${Math.round(km(GOLD, ctx.place.ll))} km from ${ctx.place.short || ctx.place.name}. Watch from the riverside trail by the visitor centre; keep dogs leashed and out of the water.`,
        short: peak ? "peak spawning" : "spawning", area: "bc-0096",
        markers: [{ id: "goldstream", ll: GOLD, label: "Goldstream River", sub: "visitor centre trail", c: "var(--m-salish)", r: 8 }], fit: [GOLD, [-123.565, 48.47], [-123.545, 48.495]],
        rows: [["Where", "Goldstream Provincial Park"], ["When", "late October to early December"], ["Best", "mid-November, mornings"]], src: "Calendar from BC Parks' description of Goldstream Park", kind: "cal" });
    }
    if (inWin(d, [12, 10], [2, 20])) {
      out.push({ id: "eagles", title: "Bald Eagles", tag: "Calendar", score: inWin(d, [12, 20], [1, 31]) ? 0.6 : 0.4, color: "var(--m-darksky)", href: "https://bcparks.ca/goldstream-park/",
        why: "Bald eagles gather along the Goldstream River to feed on the spent salmon, most from late December through January.", short: "at Goldstream", area: "bc-0096",
        markers: [{ id: "eagles", ll: [-123.551, 48.475], label: "Goldstream estuary", sub: "eagle viewing", c: "var(--m-darksky)", r: 8 }], fit: [[-123.565, 48.465], [-123.545, 48.5]],
        rows: [["Where", "Goldstream Provincial Park"], ["When", "mid-December to February"]], src: "Calendar from BC Parks' description of Goldstream Park", kind: "cal" });
    }
  }
  // ---------------------------------------------------------------- whales (the Salish Sea page's reports)
  const w = loaded(ctx, "salish/salish.json", "salish/sightings.json") ? safe(() => salishModel(ctx)) : (pending.push("whales"), null);
  if (w) {
    const n = w.wk.length, summer = inWin(d, [5, 15], [10, 15]), greys = inWin(d, [3, 1], [4, 30]);
    if (n || summer || greys) {
      const by = d3.rollups(w.wk, (v) => v.length, (x) => x.sp).sort((a, b2) => b2[1] - a[1]);
      // the closest encounters first: the ones within a day trip, then the rest of the Salish Sea
      const near = w.enc.filter((r) => km(r.ll, ctx.place.ll) <= 60), enc = (near.length >= 3 ? near : w.enc).slice(0, 10);
      const sp = (k, pl) => { const n = WHALE_SPECIES[k]?.[0]; return !n || k === 6 ? (pl ? "unidentified whales" : "Whale") : k === 5 ? (pl ? "porpoises and dolphins" : n) : k === 1 ? (pl ? "other orcas" : "Orca (other)") : pl ? `${n.replace(" / ", " and ").toLowerCase().replace(/^southern resident/, "Southern Resident")}${/s$/.test(n) ? "" : "s"}` : n; };
      out.push({ id: "whales", title: greys && !summer ? "Grey Whale Migration" : "Whale Watching", tag: "Data", score: Math.min(0.85, (summer ? 0.4 : greys ? 0.35 : 0.15) + n / 90), color: "var(--m-salish)", href: "#nature/salish",
        why: n ? `${n} whale reports in the past week, mostly ${sp(by[0][0], true)}${by[1] ? ` and ${sp(by[1][0], true)}` : ""}.${near.length >= 3 ? ` ${near.length} sightings within 60 km of ${ctx.place.name}.` : ""}` : "Whale season: the Southern Residents and humpbacks are most often seen now.",
        short: `${n} reports this week`,
        markers: enc.map((r) => ({ id: `w${r.id}`, ll: r.ll, label: sp(r.sp), sub: new Date(r.at).toLocaleDateString("en-CA", { month: "short", day: "numeric" }), c: WHALE_SPECIES[r.sp]?.[1] || "var(--m-salish)", r: 6 })),
        rows: enc.slice(0, 8).map((r) => [sp(r.sp), `${new Date(r.at).toLocaleDateString("en-CA", { month: "short", day: "numeric" })} · ${Math.round(km(r.ll, ctx.place.ll))} km`]), src: "Acartia, iNaturalist (© observers), Orcasound", kind: "whales" });
    }
  }
  out.sort((a, b2) => b2.score - a.score);
  return { items: out, pending };
}
const loaded = (ctx, ...ps) => ps.every((p) => file(p, ctx).data);
function safe(f) { try { return f(); } catch (e) { console.warn("[hot]", e?.message || e); return null; } }

// ================================================================== the page
const HOT = { pick: null, map: null, layer: null, els: null, ctx: null, d: null };
const INPUTS = ["blossom/forecast.json", "blossom/meta.json", "blossom/streets.json", "foliage/foliage.json", "salish/salish.json", "salish/sightings.json", "outdoors/surf_spots.json"];
const memo = { k: null, v: null };
function need(ctx) {
  const r = regionOf(ctx); if (!r) return { none: true, items: [] };
  // start every input the candidates read (each lands with ctx.refresh); recompute only when one of them changed
  const have = INPUTS.map((p) => (file(p, ctx).data ? 1 : 0)).join("");
  if (inCRD(ctx)) parksData(ctx);
  const k = `${ctx.place.id}|${d3.timeFormat("%Y-%m-%d %H")(ctx.date)}|${have}|${[...marine.values()].map((c) => `${c.at}:${!!c.data}`).join(",")}`;
  if (memo.k === k) return memo.v;
  const c = candidates(ctx);
  const v = !c.items.length ? (c.pending.length ? null : { items: [], pending: [] }) : { ...c, hero: c.items[0] };
  memo.k = k; memo.v = v;
  return v;
}
const focused = (d) => (d?.items.find((x) => x.id === HOT.pick) || d?.hero || null);
function choose(id) {
  HOT.pick = HOT.pick === id || id === HOT.d?.hero?.id ? null : id;
  paint(); fitTo(focused(HOT.d));
}

// ---------------------------------------------------------------- map: the focused item's markers (and its park outlined)
function fitTo(it) {
  const map = HOT.map; if (!map || !it) return;
  const pts = [...(it.fit || it.markers.map((m) => m.ll))];
  if (!pts.length) return;
  const b = pts.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
  map.fitBounds(b, { padding: 70, maxZoom: it.kind === "cal" ? 13.5 : 13, duration: 800 });
}
function hotLayer(map, ctx) {
  const S = "hot-pts", A = "hot-area", ids = { c: "hot-c", sel: "hot-sel", t: "hot-t" };
  let alive = true, pop = null, sel = null, areaIds = [];
  const data = () => { const it = focused(HOT.d); return fc((it?.markers || []).map((m) => pt(m.ll, { id: m.id, label: m.label, sub: m.sub || "", c: color(m.c), r: m.r || 6, op: m.dim ? 0.55 : 1 }))); };
  const areaFC = () => { const it = focused(HOT.d), P = parksData(ctx); const f = it?.area && P?.geo.features.find((x) => x.properties.id === it.area); return fc(f ? [f] : []); };
  function add() {
    if (!alive || !map.getStyle() || map.getSource(S)) return;
    const before = map.getLayer("st-place-p") ? "st-place-p" : undefined, surf = color("var(--surface)"), ink = color("var(--ink)");
    map.addSource(A, { type: "geojson", data: areaFC() });
    areaIds = addAreaLayers(map, "hot-a", A, color("var(--pk-provincial, #2f7d5b)"), { halo: surf, before });
    map.addSource(S, { type: "geojson", data: data() });
    map.addLayer({ id: ids.sel, type: "circle", source: S, filter: ["==", ["get", "id"], "__none"], paint: { "circle-radius": ["+", ["get", "r"], 7], "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ink, "circle-stroke-width": 2 } }, before);
    map.addLayer({ id: ids.c, type: "circle", source: S, paint: { "circle-color": ["get", "c"], "circle-radius": ["get", "r"], "circle-opacity": ["get", "op"], "circle-stroke-color": surf, "circle-stroke-width": 2 } }, before);
    map.addLayer({ id: ids.t, type: "symbol", source: S, layout: { "text-field": ["format", ["get", "label"], {}, "\n", {}, ["get", "sub"], { "font-scale": 0.86 }], "text-size": 12, "text-font": ["Noto Sans Regular"],
      "text-offset": [0, 1.25], "text-anchor": "top", "text-optional": true, "text-max-width": 12 }, paint: { "text-color": ink, "text-halo-color": surf, "text-halo-width": 1.5, "text-opacity": ["get", "op"] } }, before);
  }
  const close = () => { const p = pop; pop = null; sel = null; p?.remove(); if (map.getLayer(ids.sel)) map.setFilter(ids.sel, ["==", ["get", "id"], "__none"]); };
  const onClick = (e) => {
    const f = map.getLayer(ids.c) ? map.queryRenderedFeatures([[e.point.x - 5, e.point.y - 5], [e.point.x + 5, e.point.y + 5]], { layers: [ids.c] })[0] : null;
    if (!f) { close(); return; }
    if (sel === f.properties.id) { close(); return; }   // click again → deselect
    close(); sel = f.properties.id; map.setFilter(ids.sel, ["==", ["get", "id"], sel]);
    const it = focused(HOT.d), m = it?.markers.find((x) => x.id === sel), sp = it?.spots?.find((s) => s.id === sel);
    const node = el("div", { class: "civ-popc", style: `--lc: ${m?.c || "var(--accent)"}` }, el("div", { class: "civ-popk" }, it?.title || ""), el("b", { class: "civ-popt" }, m?.label.replace(/^\d+\s+/, "") || ""),
      m?.sub ? el("p", { class: "civ-popb" }, m.sub) : null,
      sp ? el("p", { class: "civ-popb" }, `Now ${sp.now?.h?.toFixed(1) ?? "—"} m at ${Math.round(sp.now?.T ?? 0)} s from the ${compass(sp.now?.dir ?? 0)}; best ${sp.best ? `${RATE[sp.best.r][0].toLowerCase()} ${when(sp.best.at)}` : "—"}.`) : null,
      sp ? el("p", { class: "civ-popm" }, `${sp.area ? `${sp.area} · ` : ""}${Math.round(sp.km)} km away · spot: ${sp.src}`) : null);
    pop = new maplibregl.Popup({ className: "civ-pop", closeButton: true, closeOnClick: false, maxWidth: "300px", offset: 12 }).setLngLat(f.geometry.coordinates).setDOMContent(node).addTo(map);
    const me = pop; me.on("close", () => { if (pop === me) { pop = null; sel = null; if (map.getLayer(ids.sel)) map.setFilter(ids.sel, ["==", ["get", "id"], "__none"]); } });
  };
  const onMove = (e) => { if (map.getLayer(ids.c) && map.queryRenderedFeatures([[e.point.x - 5, e.point.y - 5], [e.point.x + 5, e.point.y + 5]], { layers: [ids.c] }).length) map.getCanvas().style.cursor = "pointer"; };
  const onStyle = () => { close(); add(); };
  map.on("click", onClick); map.on("mousemove", onMove); map.on("style.load", onStyle);
  add();
  return {
    update() { if (!map.getSource(S)) add(); map.getSource(S)?.setData(data()); map.getSource(A)?.setData(areaFC()); },
    close,
    destroy() {
      alive = false; close(); map.off("click", onClick); map.off("mousemove", onMove); map.off("style.load", onStyle);
      for (const l of [ids.t, ids.c, ids.sel, ...areaIds.slice().reverse()]) if (map.getLayer(l)) map.removeLayer(l);
      for (const s of [S, A]) if (map.getSource(s)) map.removeSource(s);
    },
  };
}

// ---------------------------------------------------------------- panels
const tagEl = (t) => el("em", { class: "civ-tag hot-tag", "data-kind": t === "Live" ? "live" : t === "Calendar" ? "calendar" : "data" }, t);
const pill = (r) => el("span", { class: "hot-r", "data-r": r || "na" }, r ? RATE[r][0] : "—");
/** a 3-day wave-height sparkline (daylight shaded), with the best hour marked */
function spark(s, W = 92, H = 22) {
  const hs = s.hours || []; if (!hs.length) return el("span");
  const x = d3.scaleLinear([0, hs.length - 1], [1, W - 1]), y = d3.scaleLinear([0, Math.max(2, d3.max(hs, (h) => h.wh) || 1)], [H - 2, 2]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H).attr("class", "hot-spark").attr("role", "img").attr("aria-label", `Wave height, next 3 days, peak ${(d3.max(hs, (h) => h.wh) || 0).toFixed(1)} m`);
  hs.forEach((h, i) => { if (h.day && (i === 0 || !hs[i - 1].day)) { const j = hs.findIndex((g, k) => k > i && !g.day); svg.append("rect").attr("x", x(i)).attr("width", x(j < 0 ? hs.length - 1 : j) - x(i)).attr("y", 0).attr("height", H).attr("class", "hot-day"); } });
  svg.append("path").attr("d", d3.area().x((_, i) => x(i)).y0(H - 1).y1((h) => y(h.wh ?? 0))(hs)).attr("class", "hot-wa");
  svg.append("path").attr("d", d3.line().x((_, i) => x(i)).y((h) => y(h.wh ?? 0))(hs)).attr("class", "hot-wl");
  const nowI = hs.indexOf(s.now); if (nowI >= 0) svg.append("line").attr("x1", x(nowI)).attr("x2", x(nowI)).attr("y1", 0).attr("y2", H).attr("class", "hot-now");
  return svg.node();
}
/** the breaks as a table: name, now, 3-day sparkline, best rating (or the peak for storm watching); onPick(spot) per row */
export function surfTable(spots, { kind = "surf", onPick, sel = null } = {}) {
  return el("div", { class: "hot-surf flt-scroll" }, el("div", { class: "hot-sh" }, el("span", {}, "Break"), el("span", {}, "Now"), el("span", {}, "3 days"), el("span", {}, kind === "storm" ? "Peak" : "Best")),
    ...spots.map((s) => el("button", { type: "button", class: "hot-s" + (sel === s.id ? " on" : ""), "aria-pressed": sel != null ? String(sel === s.id) : null, title: sel === s.id ? "Click again to clear" : `Show ${s.name}`, onclick: () => onPick?.(s) },
      el("span", { class: "hot-sn" }, el("b", {}, s.name), el("small", {}, `${s.area || "coast"} · ${Math.round(s.km)} km`)),
      el("span", { class: "hot-now-v" }, s.now ? `${s.now.h.toFixed(1)} m ${Math.round(s.now.T)} s ${compass(s.now.dir)}` : "—"),
      spark(s),
      el("span", { class: "hot-best" }, pill(kind === "storm" ? null : s.best?.r), kind === "storm" ? el("small", {}, s.peak ? `${s.peak.wh.toFixed(1)} m ${hhmm(s.peak.at)}` : "") : el("small", {}, s.best ? hhmm(s.best.at) : "")))));
}
export { surfModel, RATE, pill, spark, compass, when, hhmm, rate };
function heroPanel() {
  const d = HOT.d, b = HOT.els.hero, ctx = HOT.ctx;
  if (!d) { b.replaceChildren(el("p", { class: "note civ-empty" }, "Checking the season…")); return; }
  if (!d.items.length) { b.replaceChildren(el("p", { class: "note civ-empty" }, d.none ? `No seasonal picks for ${ctx.place.name} yet.` : "Nothing in season right now.")); return; }
  const it = focused(d), auto = !HOT.pick;
  b.replaceChildren(...[
    el("div", { class: "hot-hero", style: `--hc: ${it.color}` },
      el("div", { class: "hot-k" }, tagEl(it.tag), el("span", {}, auto ? `Top pick · ${d3.timeFormat("%B %-d")(ctx.date)}` : "Your pick"), !auto ? el("button", { type: "button", class: "hot-reset", onclick: () => choose(null) }, "Back to the top pick") : null),
      el("h3", { class: "hot-t" }, it.title),
      el("p", { class: "hot-why" }, it.why),
      it.href ? el("a", { class: "hot-go", href: it.href, ...(it.href.startsWith("http") ? { target: "_blank", rel: "noopener" } : {}) }, it.href.startsWith("#") ? "Open the full page →" : "Park page ↗") : null),
    el("h4", { class: "nt-h" }, "In Season Now"),
    el("div", { class: "hot-list" }, ...d.items.map((x) => {
      const on = x === it;
      return el("button", { type: "button", class: "hot-i" + (on ? " on" : ""), "aria-pressed": String(on), title: on && !auto ? "Click again for the top pick" : `Show ${x.title.toLowerCase()} on the map`, style: `--hc: ${x.color}`, onclick: () => choose(x.id) },
        el("i", {}), el("b", {}, x.title), el("small", {}, x.short), el("span", { class: "hot-bar" }, el("span", { style: `width:${Math.round(x.score * 100)}%` })));
    })),
    d.pending?.length ? el("p", { class: "nt-cred" }, `Still loading: ${d.pending.join(", ")}.`) : null,
    el("p", { class: "nt-cred" }, "Ranked by season and today's data: live waves, the blossom and colour forecasts, this week's whale reports, and the Goldstream calendar.")].filter(Boolean));
}
function spotsPanel() {
  const d = HOT.d, b = HOT.els.spots, it = focused(d);
  if (!it) { b.replaceChildren(el("p", { class: "note civ-empty" }, "…")); return; }
  let list;
  if (it.kind === "surf" || it.kind === "storm") {
    list = surfTable(it.spots, { kind: it.kind, onPick: (s) => HOT.map?.flyTo({ center: s.ll, zoom: Math.max(HOT.map.getZoom(), 11), duration: 700 }) });
  } else {
    list = el("div", { class: "nt-rows flt-scroll" }, ...(it.rows || []).map(([n, v], i) => el("div", { class: "nt-row" }, el("b", {}, `${i + 1}`), el("span", { class: "nt-n" }, n), el("small", {}, v))));
  }
  b.replaceChildren(...[
    it.kind === "surf" ? el("p", { class: "nt-lead" }, "Swell at each break for the next 3 days (daylight shaded). ", el("b", {}, "Good"), " ≥ 1 m at ≥ 10 s reaching the beach, ", el("b", {}, "fair"), " ≥ 0.6 m at ≥ 7 s. Waves only: check wind and tide before you go.")
      : it.kind === "storm" ? el("p", { class: "nt-lead" }, "Biggest waves forecast at each open-coast spot in the next 3 days.") : null,
    list,
    el("div", { class: "civ-fp-foot" }, el("span", {}, it.src || ""), it.href?.startsWith("#") ? el("a", { class: "civ-open", href: it.href }, "Full page →") : null)].filter(Boolean));
}
function paint() {
  if (!HOT.els) return;
  heroPanel(); spotsPanel();
  HOT.layer?.update();
}

const stage = {
  layout: "map", pane: "none",
  view: (ctx) => {
    const it = focused(HOT.d || need(ctx)); if (!it) return null;
    const pts = [...(it.fit || it.markers.map((m) => m.ll))]; if (!pts.length) return null;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]), pad = 0.03;
    const b = [[Math.min(...xs) - pad, Math.min(...ys) - pad], [Math.max(...xs) + pad, Math.max(...ys) + pad]];
    return { center: [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2], zoom: it.kind === "cal" ? 12.5 : 9, bounds: b };
  },
  layers: (map, ctx) => {
    HOT.map = map; HOT.ctx = ctx;
    const h = hotLayer(map, ctx); HOT.layer = h;
    return () => { h.destroy(); if (HOT.layer === h) { HOT.layer = null; HOT.map = null; } };
  },
  panels: (ctx) => {
    HOT.ctx = ctx;
    const was = focused(HOT.d)?.id;
    HOT.d = need(ctx);
    if (!HOT.els) HOT.els = { hero: el("div", { class: "hot-body" }), spots: el("div", { class: "hot-body" }) };
    float(HOT.els.hero, "hot:hero", { keep: true }); float(HOT.els.spots, "hot:spots", { keep: true });
    paint();
    // the pick of the day can change as data lands (the wave forecast after the calendar): follow it on the map
    const now = focused(HOT.d)?.id; if (now && was && now !== was) fitTo(focused(HOT.d));
    const it = focused(HOT.d);
    return [
      { id: "hot-hero", title: "What's Hot", place: "left", el: HOT.els.hero },
      { id: "hot-spots", title: it?.kind === "surf" ? "Surf Forecast" : it?.kind === "storm" ? "Biggest Waves" : "Where to Go", place: "right", el: HOT.els.spots },
    ];
  },
};

/** the module definition (wrapped by mod() in civic-modules.js). h: { LIVE, DATA, PLANNED, rowsList } */
export function hotDef(h) {
  return {
    id: "hot", title: "What's Hot Now", tileTitle: "What's Hot Now", scale: "region", at: "*", only: (ctx) => !!regionOf(ctx), reach: 3, eyebrow: "Region", heading: "What's Hot Now",
    color: "var(--m-hot)",
    stage,
    need,
    // always first in Lifestyle: the highest reach and a flat relevance of 1 (it is the season, whatever the season)
    season: () => 1, seasonal: false,
    // live while the hourly wave forecast is in: it re-ranks the picks through the day (surf, storms)
    // in swell season (October to mid-April) the picks are ranked on the live wave forecast, so the topic counts as live from
    // the start (the Overview picks its tiles once per place, before the waves are in); a failed forecast drops it to data
    status: (ctx) => { const d = need(ctx), errs = [...marine.values()].some((c) => c.err && !c.data);
      return d?.hero?.tag === "Live" || (!errs && inWin(ctx.date || new Date(), [10, 1], [4, 15])) ? { kind: h.LIVE, text: "Live", long: "Open-Meteo Marine waves (CC BY 4.0), live; blossom, foliage and whale data from those pages; the Goldstream calendar from BC Parks" }
      : { kind: h.DATA, text: "Data", long: "Seasonal picks from the blossom, foliage and whale data, live waves from Open-Meteo Marine (CC BY 4.0), and the Goldstream calendar (BC Parks)" }; },
    source: () => "Open-Meteo Marine + seasonal data",
    badge: (d) => d.hero?.title || "",
    tileKpis: (d) => d.hero ? [[d.hero.title, d.hero.short], ...(d.items[1] ? [[d.items[1].title, d.items[1].short]] : [])] : [["—", "nothing in season"]],
    kpis: (d) => d.hero ? [["Top pick", d.hero.title, d.hero.short], ...d.items.slice(1, 4).map((x) => [x.tag === "Calendar" ? "Also on" : "Also hot", x.title, x.short])] : [],
    // tile: the season's picks as bars (strongest first); a click opens the page
    mini: (host, d) => h.rowsList(host, d.items.slice(0, 4).map((x) => [x.title, x.short, x.score]), { fit: true, bars: true }),
  };
}
