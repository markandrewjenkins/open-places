// Open Places (Nature): Garry Oaks & Arbutus and Wildlife Sightings. Each exports its leaf definition (wrapped by mod() in
// civic-modules.js) with its own map stage, built on the nature pages' kit (civic-stage-nature.js: mount, cards, panels).
//  - Garry Oaks & Arbutus (Greater Victoria): every mapped Garry oak and arbutus (oaks/oaks.json from pipelines/oaks), the
//    BC Sensitive Ecosystems Inventory's woodland and herbaceous polygons (oaks/meadows.json) as a toggle, a calendar of
//    what each is doing now, the parks with the most of them, Saanich's notable ones and a few facts.
//  - Wildlife Sightings (any place): live iNaturalist observations of animals around the place, the past 7 or 30 days.
//    Fetched from the browser (CORS-open, no key), two requests per place and window, cached in sessionStorage 15 min.
import * as d3 from "d3";
import { el } from "../src/shared/ui.js";
import { file, get, MONTHS } from "./civic-data.js";
import { color, circleFeature } from "./civic-stage.js";
import { mount, whenFile, live, NT } from "./civic-stage-nature.js";
import { photo, photoStrip, thumb, planPanel, planAttach } from "./civic-plan.js";
import "./civic-stage-wild.css";

const { fc, pt, f0, ago, card, meta, tag, lead, sub, rows, cred, foot, body, wait, surf, ink, focus, floated, treeKind, treeSource } = NT;
const monthNow = (dt) => dt.getMonth() + (dt.getDate() - 1) / new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
const until = (getC) => new Promise((res, rej) => { const tick = () => { const c = getC(); if (c.data) res(c.data); else if (c.err) rej(c.err); else setTimeout(tick, 150); }; tick(); });
const hdpi = 2;
/** a map icon drawn on a canvas (size × size CSS px), added to the map once per style */
function addIcon(map, name, size, draw) {
  if (map.hasImage(name)) map.removeImage(name);
  const cv = document.createElement("canvas"); cv.width = cv.height = size * hdpi;
  const g = cv.getContext("2d"); g.scale(hdpi * size / 24, hdpi * size / 24); draw(g);
  map.addImage(name, g.getImageData(0, 0, cv.width, cv.height), { pixelRatio: hdpi });
  return cv;
}
const disc = (g, x, y, r) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); };
const blob = (g, x, y, rx, ry, rot = 0) => { g.beginPath(); g.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); g.fill(); };

// ================================================================== Garry Oaks & Arbutus
const SPC = { oak: ["Garry oak", "var(--ow-oak)"], arbutus: ["Arbutus", "var(--ow-arb)"] };
// what each is doing through the year: [label, [[from, to] in months from Jan 1 (0–12, may run past 12 into January)]]
const PHASES = {
// label, spans, what the tree is doing (card), the same as a clause for the panel's lead, the short form for the KPI
  oak: [["Leaf-out", [[3.5, 5]], "new leaves unfolding", "Garry oaks leafing out", "Oak leaf-out"], ["Acorns", [[8, 10]], "acorns ripening and dropping", "Garry oak acorns ripening", "Acorns"],
    ["Leaf-fall", [[10, 11]], "leaves browning and dropping", "Garry oak leaves browning and dropping", "Oak leaf-fall"]],
  arbutus: [["Flowers", [[3, 5]], "white bell flowers out", "arbutus in flower", "Arbutus flowers"], ["Bark peels", [[6, 8]], "red bark peeling to green", "arbutus bark peeling", "Bark peeling"],
    ["Red berries", [[9, 13]], "red berries ripe", "arbutus berries ripe", "Red berries"]],
};
const OK = { sp: "all", meadows: true, left: null, right: null, ctx: null };
const oaksModel = (ctx) => file("oaks/oaks.json", ctx).data;
// example photos (oaks/photos.json, from pipelines/common/tree_photos.py): each phase row's thumbnail, and the card's strip
const OPH = (ctx) => file("oaks/photos.json", ctx || {}).data?.photos || {};
const PH_OF = { "Leaf-out": "oak-leaves", Acorns: "oak-acorns", "Leaf-fall": "oak-fall", Flowers: "arb-flowers", "Bark peels": "arb-bark", "Red berries": "arb-berries" };
function cardPhotos(sp, m) {
  const P = OPH(OK.ctx), get = (k, label) => ({ ph: photo(P[k]), label });
  return sp === "oak" ? photoStrip([m >= 9.5 && m < 11.5 ? get("oak-fall", "Fall leaves") : get("oak-leaves", "Leaves"), get("oak-bark", "Bark"), get("oak-acorns", "Acorns")])
    : photoStrip([get("arb-leaves", "Leaves"), get("arb-bark", "Bark"), m >= 2.5 && m < 5.5 ? get("arb-flowers", "Flowers") : get("arb-berries", "Berries")]);
}
const wkMonth = (w) => { const d = new Date(2026, 0, 1 + (w - 1) * 7 + 3); return monthNow(d); };
const camasPhase = (d) => d?.camas?.n ? ["Camas in flower", [[wkMonth(d.camas.p10), wkMonth(d.camas.p90) + 0.25]], "camas in flower", "camas in flower in the meadows", "Camas"] : null;
const inSpan = (m, spans) => spans.some(([a, b]) => (m >= a && m < b) || (m + 12 >= a && m + 12 < b));
/** the phases going on today ([kind, phase]) */
const activeNow = (d, m) => [...PHASES.oak.map((p) => ["oak", p]), ...(camasPhase(d) ? [["meadow", camasPhase(d)]] : []), ...PHASES.arbutus.map((p) => ["arbutus", p])].filter(([, p]) => inSpan(m, p[1]));
const nowLine = (sp, m) => { const p = PHASES[sp].find((x) => inSpan(m, x[1])); return p ? `Now: ${p[2]}.` : `Next: ${PHASES[sp].map((x) => x[0].toLowerCase()).find((_, i) => PHASES[sp][i][1][0][0] > m) || PHASES[sp][0][0].toLowerCase()}.`; };
const nowKpi = (d, m) => { const a = activeNow(d, m).map(([, p]) => p[4]); return ["Now", a[0] || "Between seasons", a.length > 1 ? `and ${a.slice(1).join(", ").toLowerCase()}` : "typical timing"]; };
const phaseShort = (d, m) => { const a = activeNow(d, m); return a.length ? a.map(([, p]) => p[4]).join(" · ") : "Between seasons"; };

/** a 12-month strip with the phase's span(s) filled and today's mark */
function strip(spans, m, c, on) {
  const segs = spans.flatMap(([a, b]) => (b > 12 ? [[a, 12], [0, b - 12]] : [[a, b]]));
  return el("div", { class: "ow-strip" + (on ? " on" : "") }, ...segs.map(([a, b]) => el("i", { style: `left:${(a / 12) * 100}%;width:${((b - a) / 12) * 100}%;background:${c}` })),
    el("b", { style: `left:${(m / 12) * 100}%` }));
}
function oaksLeft(d, ctx) {
  const m = monthNow(ctx.date || new Date()), act = activeNow(d, m), n = (sp) => d3.sum(Object.values(d.counts[sp]));
  const P = OPH(ctx);
  const row = (kind, [label, spans], c) => { const on = inSpan(m, spans), ph = photo(P[PH_OF[label]]);
    return el("div", { class: "ow-ph ph" + (on ? " on" : "") }, thumb(ph, `${kind === "oak" ? "Garry oak" : kind === "arbutus" ? "arbutus" : "camas"}: ${label.toLowerCase()}`), el("span", {}, label, on ? el("em", {}, "now") : null), strip(spans, m, c, on)); };
  const setSp = (sp) => { OK.sp = OK.sp === sp || sp === "all" ? "all" : sp; live.oaks?.redraw(); paintOaks(); };
  const cm = camasPhase(d);
  return [
    lead(tag("data", "Calendar"), ` ${MONTHS[Math.floor(m)]}: `, act.length ? el("b", {}, cap(act.map(([, p]) => p[3]).join("; "))) : "between seasons for both", "."),
    el("div", { class: "nt-seg", role: "group", "aria-label": "Show trees" },
      el("button", { type: "button", "aria-pressed": String(OK.sp === "all"), onclick: () => setSp("all") }, "All"),
      ...Object.entries(SPC).map(([sp, [label, c]]) => el("button", { type: "button", "aria-pressed": String(OK.sp === sp), style: `--tc:${c}`, title: OK.sp === sp ? "Click again for both" : `Only ${label.toLowerCase()}s`, onclick: () => setSp(sp) },
        ICONS[sp] ? el("img", { class: "ow-ic", src: ICONS[sp], alt: "" }) : el("i", { style: `background:${c}` }), label, el("b", {}, f0(n(sp))))),
      el("button", { type: "button", "aria-pressed": String(OK.meadows), style: "--tc: var(--ow-mead)", title: "Garry oak meadow and woodland habitat (BC Sensitive Ecosystems Inventory)",
        onclick: () => { OK.meadows = !OK.meadows; live.oaks?.redraw(); paintOaks(); } }, el("i", { style: "background: var(--ow-mead); border-radius: 2px" }), "Oak Meadows")),
    sub("Garry Oak"), ...PHASES.oak.map((p) => row("oak", p, "var(--ow-oak)")),
    cm ? sub("Oak Meadows") : null, cm ? row("meadow", cm, "var(--ow-mead)") : null,
    sub("Arbutus"), ...PHASES.arbutus.map((p) => row("arbutus", p, "var(--ow-arb)")),
    el("div", { class: "ow-months ph" }, ...MONTHS.map((x) => el("span", {}, x[0]))),
    cred(`Typical timing in Greater Victoria. Thumbnails: example photos (iNaturalist; author and licence on hover).${cm ? ` Camas: weeks ${d.camas.p10}–${d.camas.p90} hold 80% of ${f0(d.camas.n)} flowering records on iNaturalist (all years), peak week ${d.camas.p50}.` : ""}`
      + ` Meadows: BC Sensitive Ecosystems Inventory woodland and herbaceous polygons (${f0(d.meadows.ha.WD + d.meadows.ha.HT)} ha; OGL-BC), the classes that hold Garry oak woodland and meadow; not every polygon has oaks.`),
  ];
}
function oaksRight(d) {
  const by = (o) => (OK.sp === "all" ? o.oak + o.arbutus : o[OK.sp]);
  const places = d.places.slice().sort((a, b) => by(b) - by(a)).filter((o) => by(o) > 0).slice(0, 8);
  const idx = new Map(d.rows.map((r, i) => [`${r[0]},${r[1]}`, i]));
  const notable = d.notable.filter((t) => OK.sp === "all" || t.sp === OK.sp).slice(0, 5);
  const fit = (o) => () => live.oaks?.fit(o.bounds, 16);
  return [
    lead(tag("data", "Data"), " Parks with the most mapped trees, counted inside their OpenStreetMap outlines. Click one to zoom there."),
    rows(places.map((o, i) => [i + 1, o.name, OK.sp === "all" ? `${f0(o.oak)} oaks · ${f0(o.arbutus)} arbutus` : `${f0(o[OK.sp])} ${OK.sp === "oak" ? "oaks" : "arbutus"}`, fit(o)])),
    notable.length ? sub("Notable Trees") : null,
    notable.length ? rows(notable.map((t, i) => [i + 1, `${SPC[t.sp][0]}${t.dbh ? ` · ${t.dbh} cm trunk` : ""}`, t.address,
      idx.has(`${t.ll[0]},${t.ll[1]}`) ? focus("oaks", { layer: "trees", props: treeProps(d, idx.get(`${t.ll[0]},${t.ll[1]}`)), ll: t.ll, zoom: 16.5 }) : null, "District of Saanich significant tree"])) : null,
    sub("Facts"),
    ...d.facts.slice(0, 3).map((x) => el("p", { class: "ow-fact" }, x.text, " ", el("a", { href: x.url, target: "_blank", rel: "noopener" }, x.src))),
    cred(`Trees: City of Victoria (OGL-Victoria), Township of Esquimalt and District of Saanich significant trees (no licence stated), OpenStreetMap (ODbL) and trees reported on iNaturalist (CC0, CC BY or CC BY-NC, per observer; IDs of planted trees unverified). Crowd-sourced trees are outlined. Parks: OpenStreetMap (ODbL).`),
  ];
}
function paintOaks() {
  const d = oaksModel(OK.ctx || {});
  if (!OK.left) OK.left = body(); if (!OK.right) OK.right = body();
  if (!d) { OK.left.replaceChildren(el("p", { class: "note civ-empty" }, "Loading the published data…")); OK.right.replaceChildren(); return; }
  OK.left.replaceChildren(...oaksLeft(d, OK.ctx).filter(Boolean), foot(`${f0(d.rows.length)} trees · ${d.meadows.n} meadow polygons`));
  OK.right.replaceChildren(...oaksRight(d).filter(Boolean));
}

// icons: an oak leaf (lobed, olive) and an arbutus berry cluster with its leaf; drawn with a halo in the map's surface colour
const ICONS = {};
function oakLeaf(g, c, halo) {
  const lobes = [[12, 4.2, 3.2], [8.2, 7.4, 3.3], [15.8, 7.4, 3.3], [7.6, 12, 3.4], [16.4, 12, 3.4], [8.6, 16.2, 2.9], [15.4, 16.2, 2.9]];
  for (const [col, grow] of [[halo, 1.6], [c, 0]]) { g.fillStyle = col; lobes.forEach(([x, y, r]) => disc(g, x, y, r + grow)); blob(g, 12, 11.5, 3.6 + grow, 8 + grow); }
  g.strokeStyle = halo; g.lineWidth = 1.1; g.lineCap = "round"; g.beginPath(); g.moveTo(12, 4.5); g.lineTo(12, 22.5); g.stroke();
}
function arbutusBerries(g, c, leaf, halo) {
  const berries = [[9, 14, 3], [14.5, 13, 3], [11.5, 18.4, 3], [16.5, 18, 2.8], [6.8, 19, 2.6]];
  g.fillStyle = halo; blob(g, 14, 6.5, 6.6, 3.6, -0.5); berries.forEach(([x, y, r]) => disc(g, x, y, r + 1.5));
  g.fillStyle = leaf; blob(g, 14, 6.5, 5.4, 2.5, -0.5);
  g.fillStyle = c; berries.forEach(([x, y, r]) => disc(g, x, y, r));
  g.fillStyle = "rgba(255,255,255,.55)"; berries.forEach(([x, y, r]) => disc(g, x - r * 0.35, y - r * 0.35, r * 0.28));
}
function addOakIcons(map) {
  const halo = surf();
  ICONS.oak = addIcon(map, "ow-oak", 24, (g) => oakLeaf(g, color("var(--ow-oak)"), halo)).toDataURL();
  ICONS.arbutus = addIcon(map, "ow-arbutus", 24, (g) => arbutusBerries(g, color("var(--ow-arb)"), color("var(--ow-leaf)"), halo)).toDataURL();
}
const treeProps = (d, i) => { const r = d.rows[i]; return { id: i, sp: d.species[r[2]], city: d.cities[r[3]], crowd: NT.CROWD.includes(d.cities[r[3]]) ? 1 : 0, dbh: r[4], h: r[5], st: r[6], ref: r[7], cn: r[8] }; };
const oaksStage = {
  layout: "map",
  view: () => ({ center: [-123.39, 48.47], zoom: 11.2 }),
  layers: (map, ctx) => { const off = mount("oaks", map, ctx, {
    load: async (c) => { const [d, m] = await Promise.all([whenFile("oaks/oaks.json", c), whenFile("oaks/meadows.json", c), whenFile("oaks/photos.json", c).catch(() => null)]); return { d, m }; },
    sources: ({ d, m }) => {
      addOakIcons(map);
      return {
        trees: { type: "geojson", data: fc(d.rows.map((r, i) => pt([r[0], r[1]], treeProps(d, i)))) },
        meadows: { type: "geojson", data: m },
      };
    },
    layers: () => [
      ...(OK.meadows ? [
        { id: "mfill", type: "fill", source: "meadows", paint: { "fill-color": ["match", ["get", "c"], "WD", color("var(--ow-oak)"), color("var(--ow-mead)")], "fill-opacity": 0.26 } },
        { id: "mline", type: "line", source: "meadows", paint: { "line-color": ["match", ["get", "c"], "WD", color("var(--ow-oak)"), color("var(--ow-mead)")], "line-width": 1, "line-opacity": 0.7 } },
        { id: "sel", type: "line", source: "meadows", filter: ["==", ["get", "id"], "__none"], paint: { "line-color": ink(), "line-width": 2.4 } }] : []),
      // crowd-sourced trees get an ink ring underneath, as on the blossom and foliage maps
      { id: "ring", type: "circle", source: "trees", minzoom: 13, filter: ["all", ["==", ["get", "crowd"], 1], ...(OK.sp === "all" ? [] : [["==", ["get", "sp"], OK.sp]])],
        paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 6, 17, 12], "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ink(), "circle-stroke-width": 1.2, "circle-stroke-opacity": 0.75 } },
      { id: "trees", type: "symbol", source: "trees", ...(OK.sp === "all" ? {} : { filter: ["==", ["get", "sp"], OK.sp] }),
        layout: { "icon-image": ["match", ["get", "sp"], "oak", "ow-oak", "ow-arbutus"], "icon-allow-overlap": true, "icon-ignore-placement": true,
          "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.42, 12, 0.6, 15, 0.9, 18, 1.3], "symbol-sort-key": ["get", "id"] } },
      { id: "tsel", type: "circle", source: "trees", filter: ["==", ["get", "id"], "__none"], paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 8, 16, 15], "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ink(), "circle-stroke-width": 2.2 } },
    ],
    click: ["trees", "mfill"],
    popup: (f, { d }) => {
      const p = f.properties;
      if (f.layer.id.endsWith("mfill")) {
        const wd = p.c === "WD";
        return card("oaks", "Oak meadow habitat · SEI", wd ? "Woodland" : "Terrestrial herbaceous",
          [`${p.ha >= 1 ? f0(p.ha) : p.ha} ha mapped${p.dec ? `, about ${p.dec * 10}% of it this class` : ""}.`,
            wd ? "Open woodland: the class that holds Garry oak and arbutus woodland (and some Douglas-fir)." : "Grassy and mossy openings on shallow soil: the class that holds Garry oak meadows, where camas flowers in spring.",
            meta(`SEI code ${p.lbl}${p.lbl2 ? ` · second component ${p.lbl2}` : ""} · mapped 1993–97, updated 2002`), meta(`Source: ${d.meadows.source} (${d.meadows.licence})`)]);
      }
      const s = SPC[p.sp], src = d.sources[p.city] || [p.city, ""], [lon, lat] = f.geometry.coordinates, m = monthNow(OK.ctx?.date || new Date());
      const where = (p.h && p.st && p.h.includes(p.st) ? p.h : [p.h, p.st].filter(Boolean).join(" ")) || `${p.city === "inat" ? "Reported" : "Mapped"} at ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
      const [srcLine, href, link] = treeSource(p.city, p.ref, [lon, lat], src[0], src[1]);
      return card("oaks", treeKind(p.city, p.ref), s[0], [nowLine(p.sp, m), p.sp === "oak" ? "Quercus garryana, BC's only native oak." : "Arbutus menziesii, BC's only broad-leaved evergreen tree.",
        meta(`${where}${p.dbh ? ` · ${p.dbh} cm trunk` : ""}`), cardPhotos(p.sp, m), srcLine], href, link);
    },
  }); const offPlan = planAttach("oaks", map); return () => { offPlan(); off(); }; },
  panels: (ctx) => {
    OK.ctx = ctx; paintOaks();
    const d = oaksModel(ctx);
    return [{ id: "ow-now", title: "Now", place: "left", el: OK.left }, ...(d ? [{ id: "ow-plan", title: "Plan a Route", place: "left", el: planPanel("oaks", oaksPlan(ctx, d)) }] : []),
      { id: "ow-best", title: "Best Places", place: "right", el: OK.right }];
  },
};

// ---- Plan a Route on the oak map: every tree counts, more when it's doing something now (berries, flowers, acorns),
// and Saanich's notable trees count extra; stops are named after the park they're in, else the main street.
const inBox = ([x, y], b) => b && x >= b[0][0] && x <= b[1][0] && y >= b[0][1] && y <= b[1][1];
function oaksPlan(ctx, d) {
  const m = monthNow(ctx.date || new Date()), act = (sp) => PHASES[sp].find((x) => inSpan(m, x[1]));
  const big = new Set(d.notable.map((t) => `${t.ll[0]},${t.ll[1]}`));
  const parks = d.places.filter((o) => o.bounds).sort((a, b) => (a.bounds[1][0] - a.bounds[0][0]) * (a.bounds[1][1] - a.bounds[0][1]) - (b.bounds[1][0] - b.bounds[0][0]) * (b.bounds[1][1] - b.bounds[0][1]));
  const most = (items, f) => [...d3.rollup(items.filter(f), (v) => v.length, f)].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const nowTxt = ["oak", "arbutus"].filter((sp) => act(sp)).map((sp) => act(sp)[3]);
  return {
    ctx, noun: OK.sp === "all" ? "Garry oaks or arbutus" : OK.sp === "oak" ? "Garry oaks" : "arbutus", net: () => "gvic", home: () => ctx.place.ll, homeName: () => ctx.place.short || ctx.place.name,
    points: () => d.rows.filter((r) => OK.sp === "all" || d.species[r[2]] === OK.sp).map((r) => { const sp = d.species[r[2]], nb = big.has(`${r[0]},${r[1]}`);
      return { ll: [r[0], r[1]], w: (act(sp) ? 1.5 : 1) + (nb ? 6 : 0), kind: sp === "oak" ? "Garry oaks" : "arbutus", sp, nb, dbh: r[4], st: r[6] || "" }; }),
    describe: (c) => {
      const park = parks.find((o) => inBox(c.ll, o.bounds)), nb = c.items.filter((x) => x.nb).sort((a, b) => (b.dbh || 0) - (a.dbh || 0))[0];
      const sps = [...new Set(c.items.map((x) => x.sp))].filter((sp) => act(sp));
      return { title: park?.name || most(c.items, (x) => x.st) || "",
        text: `${c.kinds.map(([k, n]) => `${f0(n)} ${n === 1 && k === "Garry oaks" ? "Garry oak" : k}`).join(", ")}${nb ? ` · notable ${nb.dbh ? `${nb.dbh} cm ` : ""}${nb.sp === "oak" ? "oak" : "arbutus"}` : ""}${sps.length ? ` · ${act(sps[0])[2]}` : ""}` };
    },
    thin: "Outside Victoria, Esquimalt and Saanich's inventories, trees are crowd-reported only.",
    how: `Stops: the spots with the most ${OK.sp === "all" ? "Garry oaks and arbutus" : OK.sp === "oak" ? "Garry oaks" : "arbutus"} (the map's tree filter applies); Saanich's notable trees count extra${nowTxt.length ? `, and trees in season count more now (${nowTxt.join("; ")})` : ""}.`,
  };
}

/** the Garry Oaks & Arbutus leaf (wrapped by mod() in civic-modules.js); h: { DATA, rowsList, bump } */
export function oaksDef(h) {
  const n = (d, sp) => d3.sum(Object.values(d.counts[sp]));
  const m = (ctx) => monthNow(ctx.date || new Date());
  return {
    id: "oaks", title: "Garry Oaks & Arbutus", tileTitle: "Garry Oaks & Arbutus", scale: "region", at: ["crd"], reach: 2, eyebrow: "Greater Victoria", heading: "Garry Oaks & Arbutus",
    need: (ctx) => { const c = file("oaks/oaks.json", ctx); return c.err ? { err: c.err } : c.data; },
    // camas in spring, acorns and berries in the fall: in season most of the year
    season: (mo) => Math.max(0.45, h.bump(mo, 4.7, 0.7), 0.8 * h.bump(mo, 10.5, 1.3)),
    status: () => ({ kind: h.DATA, text: "Data", long: "Published data (oaks/oaks.json, meadows.json): council inventories, OpenStreetMap, iNaturalist and the BC Sensitive Ecosystems Inventory" }),
    source: () => "Councils + OSM + iNaturalist + BC SEI",
    badge: (d) => `${f0(n(d, "oak"))} oaks`,
    tileKpis: (d, ctx) => [[f0(n(d, "oak")), "Garry oaks mapped"], [f0(n(d, "arbutus")), "arbutus mapped"], [phaseShort(d, m(ctx)), "now"]],
    kpis: (d, ctx) => [["Garry oaks", f0(n(d, "oak")), "mapped in Greater Victoria"], ["Arbutus", f0(n(d, "arbutus")), "mapped"],
      ["Oak meadows", `${f0(d.meadows.ha.WD + d.meadows.ha.HT)} ha`, "SEI woodland + herbaceous"], nowKpi(d, m(ctx))],
    mini: (host, d) => h.rowsList(host, d.places.slice(0, 6).map((o) => [o.name, `${f0(o.oak)} · ${f0(o.arbutus)}`, (o.oak + o.arbutus) / (d.places[0].oak + d.places[0].arbutus)]), { fit: true, bars: true }),
    stage: floated("oaks", oaksStage),
  };
}

// ================================================================== Wildlife Sightings
const API = "https://api.inaturalist.org/v2";
const WG = { bird: ["Birds", "var(--m-weather)"], mammal: ["Mammals", "var(--m-foliage)"], herp: ["Reptiles & amphibians", "var(--m-sunday)"], fish: ["Fish", "var(--m-salish)"],
  insect: ["Insects & spiders", "var(--m-blossom)"], other: ["Other invertebrates", "var(--m-darksky)"] };
const ICONIC = { Aves: "bird", Mammalia: "mammal", Reptilia: "herp", Amphibia: "herp", Actinopterygii: "fish", Insecta: "insect", Arachnida: "insect" };
const groupOf = (icon) => ICONIC[icon] || "other";
const LIC = { cc0: "CC0", "cc-by": "CC BY", "cc-by-nc": "CC BY-NC" };
const RADIUS = { muni: 8, region: 25, province: 150, country: 400, world: 400 };
const CETACEA = 152871;
const OBS_FIELDS = "id,observed_on,time_observed_at,location,positional_accuracy,obscured,license_code,user.login,taxon.id,taxon.name,taxon.preferred_common_name,taxon.iconic_taxon_name,taxon.ancestor_ids,photos.url,photos.license_code,photos.attribution";
const SC_FIELDS = "count,taxon.id,taxon.name,taxon.preferred_common_name,taxon.iconic_taxon_name,taxon.threatened,taxon.conservation_status.status_name,taxon.conservation_status.iucn,taxon.conservation_status.authority";
const W = { days: 7, sp: null, left: null, right: null, ctx: null, shown: null };
const radiusOf = (p) => RADIUS[p.level] || 25;
const json = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(`iNaturalist: ${r.status}`); return r.json(); });

async function wildFetch(p, days) {
  const sk = `op-wild:${p.id}:${days}`;
  try { const c = JSON.parse(sessionStorage.getItem(sk) || "null"); if (c && Date.now() - c.at < 15 * 60e3) return c.d; } catch { /* storage blocked */ }
  const d1 = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const q = new URLSearchParams({ lat: p.ll[1], lng: p.ll[0], radius: radiusOf(p), iconic_taxa: "Aves,Mammalia,Reptilia,Amphibia,Actinopterygii,Insecta,Arachnida,Mollusca,Animalia",
    without_taxon_id: CETACEA, verifiable: "true", geoprivacy: "open", taxon_geoprivacy: "open", acc_below: 101, license: Object.keys(LIC).join(","), d1, locale: "en" });
  const [o, s] = await Promise.all([json(`${API}/observations?${q}&per_page=200&order_by=observed_on&order=desc&fields=${OBS_FIELDS}`),
    json(`${API}/observations/species_counts?${q}&per_page=500&fields=${SC_FIELDS}`)]);
  const species = (s.results || []).map((r) => ({ id: r.taxon.id, sci: r.taxon.name, cn: r.taxon.preferred_common_name || "", g: groupOf(r.taxon.iconic_taxon_name), n: r.count,
    st: r.taxon.conservation_status?.status_name || (r.taxon.threatened ? "threatened" : ""), iucn: r.taxon.conservation_status?.iucn || 0, auth: r.taxon.conservation_status?.authority || "" }));
  const ids = new Set(species.map((x) => x.id));
  const obs = (o.results || []).filter((x) => !x.obscured && x.location && x.positional_accuracy != null && x.positional_accuracy <= 100 && LIC[x.license_code] && x.taxon).map((x) => {
    const [lat, lon] = x.location.split(",").map(Number), ph = (x.photos || []).find((f) => LIC[f.license_code]);
    return { id: x.id, t: Date.parse(x.time_observed_at || `${x.observed_on}T12:00:00`), tt: !!x.time_observed_at, ll: [lon, lat], login: x.user?.login || "", lic: LIC[x.license_code],
      tx: x.taxon.id, sp: [x.taxon.id, ...(x.taxon.ancestor_ids || []).slice().reverse()].find((i) => ids.has(i)) ?? x.taxon.id,
      sci: x.taxon.name, cn: x.taxon.preferred_common_name || "", g: groupOf(x.taxon.iconic_taxon_name),
      ph: ph ? { url: ph.url.replace("/square.", "/small."), attr: ph.attribution, lic: LIC[ph.license_code] } : null };
  });
  const d = { at: Date.now(), total: o.total_results || 0, obs, species, nsp: s.total_results || species.length, days, r: radiusOf(p) };
  try { sessionStorage.setItem(sk, JSON.stringify({ at: Date.now(), d })); } catch { /* full or blocked: fine */ }
  return d;
}
const wildData = (ctx, days = W.days) => get(`inat-wild:${ctx.place.id}:${days}`, () => wildFetch(ctx.place, days), ctx);
// sightings per group: every sighting when the map holds them all, else the species tallies (species-level ids only)
const groupCounts = (d) => { const by = Object.fromEntries(Object.keys(WG).map((g) => [g, 0]));
  if (d.obs.length >= d.total) for (const o of d.obs) by[o.g] += 1; else for (const s of d.species) by[s.g] += s.n; return by; };
// at risk: IUCN-equivalent near threatened or worse, or flagged threatened (not "apparently secure" and the like)
const notable = (d) => d.species.filter((s) => s.st && (s.iucn >= 20 || s.st === "threatened" || (!s.iucn && !/secure|least concern|not at risk/i.test(s.st)))).sort((a, b) => b.iucn - a.iucn || b.n - a.n);

// icons: a coloured disc with a white figure per group
const FIG = {
  bird: (g) => { blob(g, 11, 13.5, 5.8, 3.8, -0.35); disc(g, 15.8, 9.4, 2.7); g.beginPath(); g.moveTo(18, 8.6); g.lineTo(20.8, 9.6); g.lineTo(18, 10.6); g.fill(); g.beginPath(); g.moveTo(6.2, 14.6); g.lineTo(2.8, 12.4); g.lineTo(3.8, 17.4); g.fill(); },
  mammal: (g) => { [[7, 10, 2], [10.4, 6.8, 2.1], [14.4, 6.8, 2.1], [17.6, 10, 2]].forEach(([x, y, r]) => disc(g, x, y, r)); blob(g, 12.4, 15.4, 4.6, 3.6); },
  herp: (g) => { blob(g, 12, 14.5, 6, 4.2); disc(g, 8.6, 9.4, 2.2); disc(g, 15.4, 9.4, 2.2); g.lineWidth = 1.8; g.lineCap = "round"; g.beginPath(); g.moveTo(6.5, 17); g.lineTo(3.6, 19.6); g.moveTo(17.5, 17); g.lineTo(20.4, 19.6); g.stroke(); },
  fish: (g) => { blob(g, 10.5, 12, 6.6, 3.8); g.beginPath(); g.moveTo(16, 12); g.lineTo(21, 7.8); g.lineTo(21, 16.2); g.fill(); },
  insect: (g) => { blob(g, 8.2, 9.4, 3.8, 3, -0.6); blob(g, 15.8, 9.4, 3.8, 3, 0.6); blob(g, 8.8, 15, 2.8, 2.3, 0.5); blob(g, 15.2, 15, 2.8, 2.3, -0.5); g.lineWidth = 1.6; g.lineCap = "round"; g.beginPath(); g.moveTo(12, 7); g.lineTo(12, 18.5); g.stroke(); },
  other: (g) => { g.lineWidth = 1.8; g.beginPath(); g.arc(11, 12.4, 5, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.arc(11, 12.4, 2, 0, Math.PI * 2); g.stroke(); g.lineCap = "round"; g.beginPath(); g.moveTo(4, 18.2); g.lineTo(20.5, 18.2); g.lineTo(19.5, 14.5); g.stroke(); },
};
const WICON = {};
function addWildIcons(map) {
  for (const [k, [, c]] of Object.entries(WG)) WICON[k] = addIcon(map, `wl-${k}`, 24, (g) => {
    g.fillStyle = surf(); disc(g, 12, 12, 11.6); g.fillStyle = color(c); disc(g, 12, 12, 10.4);
    g.fillStyle = "#fff"; g.strokeStyle = "#fff"; FIG[k](g);
  }).toDataURL();
}
const ageOf = (d, o) => Math.max(0, Math.min(1, (Date.now() - o.t) / (d.days * 864e5)));
function setWildSp(id) { W.sp = W.sp === id ? null : id; live.wildlife?.redraw(); paintWild(); }
function paintWild() {
  const ctx = W.ctx; if (!ctx) return;
  if (!W.left) W.left = body(); if (!W.right) W.right = body();
  const c = wildData(ctx), d = c.data;
  const seg = el("div", { class: "nt-seg", role: "group", "aria-label": "Time window" }, ...[7, 30].map((n) => el("button", { type: "button", "aria-pressed": String(W.days === n),
    title: W.days === n && n === 30 ? "Click again for the past 7 days" : `The past ${n} days`, onclick: () => { W.days = W.days === n ? 7 : n; W.sp = null; paintWild(); ctx.refresh?.(); until(() => wildData(ctx)).then(() => { live.wildlife?.redraw(); paintWild(); ctx.refresh?.(); }, () => paintWild()); } }, `${n} days`)));
  if (!d) {
    W.left.replaceChildren(seg, el("p", { class: "note civ-empty" }, c.err ? "Couldn't reach iNaturalist. Try again later." : "Asking iNaturalist…"));
    W.right.replaceChildren(el("p", { class: "note civ-empty" }, c.err ? "—" : "Asking iNaturalist…")); return;
  }
  if (W.shown !== d) { W.shown = d; live.wildlife?.redraw(); }
  const by = groupCounts(d), top = d.species.slice(0, 10), nb = notable(d);
  const whales = (ctx.chain || []).some((n) => ["crd", "metrovan", "seattle"].includes(n.id));
  W.left.replaceChildren(
    lead(tag("live", "Live"), " ", el("b", {}, f0(d.total)), ` animal sightings within ${d.r} km of ${ctx.place.short || ctx.place.name} in the past ${d.days} days, `, el("b", {}, f0(d.nsp)), " species."),
    seg,
    el("div", { class: "nt-key" }, ...Object.entries(WG).map(([g, [label, c]]) => el("div", { class: "nt-k ow-wk" }, WICON[g] ? el("img", { src: WICON[g], alt: "" }) : el("i", { style: `background:${c}` }), el("span", {}, label), el("span", {}, f0(by[g]))))),
    top.length ? picked(rows(top.map((s, i) => [i + 1, s.cn ? cap(s.cn) : s.sci, f0(s.n), () => setWildSp(s.id), `${s.sci}: click to pick it out on the map, again to show all`])), top) : el("p", { class: "note civ-empty" }, "No sightings in this window."),
    foot(d.total > d.obs.length ? `Map: the latest ${d.obs.length} of ${f0(d.total)} sightings` : `${f0(d.obs.length)} sightings on the map`));
  W.right.replaceChildren(
    lead(tag("data", "iNaturalist"), " Species seen here with a conservation status on iNaturalist. iNaturalist hides the exact location of the most sensitive ones, so some have no point on the map."),
    nb.length ? picked(rows(nb.slice(0, 8).map((s, i) => [i + 1, s.cn ? cap(s.cn) : s.sci, `${s.st} · ${f0(s.n)}`, () => setWildSp(s.id), `${s.sci}: ${s.st}${s.auth ? ` (${s.auth})` : ""}`])), nb.slice(0, 8)) : el("p", { class: "note civ-empty" }, "None in this window."),
    ...(whales ? [el("p", { class: "ow-fact" }, "Whales and dolphins are left out here: see ", el("a", { href: "#nature/salish" }, "Whale Watching"), ".")] : []),
    cred("iNaturalist observations (api.inaturalist.org, no key): verifiable, open location, accuracy within 100 m, observation licence CC0, CC BY or CC BY-NC, credited per observer; photos shown only under those licences. Cached for 15 minutes."));
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** mark the row of the species picked out on the map (click again shows all) */
const picked = (list, items) => { [...list.children].forEach((r, i) => { r.classList.toggle("on", items[i]?.id === W.sp); r.setAttribute("aria-pressed", String(items[i]?.id === W.sp)); }); return list; };
const wildStage = {
  layout: "map",
  view: (ctx) => ({ center: ctx.place.ll, zoom: { muni: 11.6, region: 9.8, province: 6.6, country: 4.6 }[ctx.place.level] ?? 4 }),
  coverage: (ctx) => ({ feature: circleFeature(ctx.place.ll, radiusOf(ctx.place)), label: `Sightings area · ${radiusOf(ctx.place)} km` }),
  layers: (map, ctx) => mount("wildlife", map, ctx, {
    load: (c) => until(() => wildData(c)).then(() => ({})),
    sources: () => {
      addWildIcons(map);
      const d = wildData(W.ctx || ctx).data || { obs: [], days: 7 };
      return { obs: { type: "geojson", data: fc(d.obs.slice().reverse().map((o) => pt(o.ll, { id: o.id, g: o.g, sp: o.sp, a: ageOf(d, o) }))) } };
    },
    layers: () => [
      { id: "obs", type: "symbol", source: "obs", layout: { "icon-image": ["concat", "wl-", ["get", "g"]], "icon-allow-overlap": true, "icon-ignore-placement": true,
        "icon-size": ["interpolate", ["linear"], ["zoom"], 8, W.sp ? ["case", ["==", ["get", "sp"], W.sp], 0.85, 0.5] : 0.6, 14, W.sp ? ["case", ["==", ["get", "sp"], W.sp], 1.25, 0.8] : 0.95] },
        paint: { "icon-opacity": W.sp ? ["case", ["==", ["get", "sp"], W.sp], 1, 0.12] : ["interpolate", ["linear"], ["get", "a"], 0, 1, 1, 0.35] } },
      { id: "tsel", type: "circle", source: "obs", filter: ["==", ["get", "id"], "__none"], paint: { "circle-radius": 15, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ink(), "circle-stroke-width": 2.2 } },
    ],
    click: ["obs"],
    popup: (f) => {
      const d = wildData(W.ctx || ctx).data, o = d?.obs.find((x) => x.id === f.properties.id); if (!o) return null;
      const when = new Date(o.t);
      return card("wildlife", `${WG[o.g][0]} · ${ago(o.t)}`, o.cn ? cap(o.cn) : o.sci, [
        el("p", { class: "civ-popb" }, el("i", {}, o.sci)),
        o.ph ? el("figure", { class: "ow-photo" }, el("img", { src: o.ph.url, alt: o.cn || o.sci, loading: "lazy" }), el("figcaption", {}, o.ph.attr)) : null,
        meta(`Seen ${when.toLocaleDateString("en-CA", { month: "short", day: "numeric" })}${!o.tt ? "" : `, ${when.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}`}`),
        meta(`iNaturalist observer ${o.login}, ${o.lic}`)], `https://www.inaturalist.org/observations/${o.id}`, "Observation ↗");
    },
  }),
  panels: (ctx) => {
    W.ctx = ctx; paintWild();
    return [{ id: "wl-most", title: "Most Seen", place: "left", el: W.left }, { id: "wl-notable", title: "Notable", place: "right", el: W.right }];
  },
};

/** the Wildlife Sightings leaf (wrapped by mod() in civic-modules.js); h: { LIVE, rowsList } */
export function wildDef(h) {
  const topG = (d) => Object.entries(groupCounts(d)).sort((a, b) => b[1] - a[1])[0];
  return {
    id: "wildlife", title: "Wildlife Sightings", tileTitle: "Wildlife Sightings", scale: "basic", reach: 2, eyebrow: "Live", heading: "Wildlife Sightings",
    need: (ctx) => { const c = wildData(ctx); return c.err ? { err: c.err } : c.data; },
    status: () => ({ kind: h.LIVE, text: "Live", long: "iNaturalist observations (CC0, CC BY or CC BY-NC records), fetched live from the browser, cached 15 minutes" }),
    source: () => "iNaturalist",
    badge: (d) => `${f0(d.total)} sightings`,
    tileKpis: (d) => [[f0(d.total), `sightings, ${d.days} d`], [f0(d.nsp), "species"]],
    kpis: (d) => { const [g, n] = topG(d); return [["Sightings", f0(d.total), `past ${d.days} days · ${d.r} km`], ["Species", f0(d.nsp), "seen"], ["Top group", WG[g][0], `${f0(n)} sightings`]]; },
    mini: (host, d) => { const by = Object.entries(groupCounts(d)).sort((a, b) => b[1] - a[1]), mx = by[0][1] || 1; h.rowsList(host, by.map(([g, n]) => [WG[g][0], f0(n), n / mx]), { fit: true, bars: true }); },
    stage: floated("wildlife", wildStage),
  };
}
