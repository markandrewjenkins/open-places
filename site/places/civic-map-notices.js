// Open Places: notices on the map, for City Notices and Public Safety (civic-mod-local.js).
//
// Each notice sits at a place: its own spot when it names one (a street closure, a project, an incident's intersection),
// otherwise the building it comes from (the City Hall for a City notice, the police station that serves the place for a
// police release). Notices at one place share one marker: a generic icon (a civic building for the City, a shield for
// the police; never an agency's crest or logo) with a count badge when several stack there.
//   * click a marker → the panel lists that place's notices; click it again → all notices again
//   * click a notice in the panel → its marker is ringed; click it again → the ring goes
// The markers are a custom stage layer (civic-stage.js `custom`), so the clicks and the selection stay here; `rerun: true`
// redraws them after a theme change. The panel list is built by list() and re-rendered on every ctx.refresh().
//
//   const nm = noticeMap({ id, color, glyph: "shield" | "landmark" })
//   nm.layer                         → the stage layer spec
//   nm.sync(ctx, groups)             → draw these groups: [{ key, kind: "building" | "spot", ll, name, sub?, items: [{ id }] }]
//   nm.list({ groups, row, empty })  → the panel's list element (row(item) → { title, meta, href, pin? })
//   nm.state                         → { sel: group key | null, item: item id | null }
import { el } from "../src/shared/ui.js";
import { icon } from "./civic-icons.js";
import { color } from "./civic-stage.js";

const S = 2;   // images are drawn at 2x
/** a pale fill (the dark theme's colours) takes a dark glyph */
const light = (rgb) => { const [r, g, b] = (String(rgb).match(/[\d.]+/g) || [0, 0, 0]).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150; };
const glyphPath = (name) => { try { return icon(name, { size: 24 }).querySelector("path")?.getAttribute("d") || ""; } catch { return ""; } };

/** one marker picture: a filled disc with the white glyph, a ring when selected, a count badge over 1 */
function markerImage({ fill, ink, surf, glyph, big, n, on }) {
  const W = 44 * S, c = W / 2, r = (big ? 13 : 9) * S;
  const cv = document.createElement("canvas"); cv.width = cv.height = W;
  const g = cv.getContext("2d");
  if (on) { g.beginPath(); g.arc(c, c, r + 5 * S, 0, 2 * Math.PI); g.fillStyle = surf; g.globalAlpha = 0.85; g.fill(); g.globalAlpha = 1; g.lineWidth = 2.4 * S; g.strokeStyle = fill; g.stroke(); }
  g.beginPath(); g.arc(c, c, r, 0, 2 * Math.PI); g.fillStyle = fill; g.fill(); g.lineWidth = 1.6 * S; g.strokeStyle = surf; g.stroke();
  const d = glyphPath(glyph);
  if (d) {
    const k = (r * 1.15) / 24;   // the 24-unit icon inside the disc
    g.save(); g.translate(c - 12 * k, c - 12 * k); g.scale(k, k);
    g.strokeStyle = light(fill) ? "rgb(15, 23, 36)" : "#fff"; g.lineWidth = big ? 2.1 : 2.6; g.lineCap = "round"; g.lineJoin = "round"; g.stroke(new Path2D(d)); g.restore();
  }
  if (n > 1) {
    const t = n > 99 ? "99+" : String(n), bx = c + r * 0.85, by = c - r * 0.85, br = 7.5 * S;
    g.font = `700 ${10 * S}px system-ui, sans-serif`;
    const w = Math.max(br * 2, g.measureText(t).width + 7 * S);
    g.beginPath(); g.roundRect(bx - w / 2, by - br, w, br * 2, br); g.fillStyle = ink; g.fill(); g.lineWidth = 1.4 * S; g.strokeStyle = surf; g.stroke();
    g.fillStyle = surf; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(t, bx, by + 0.5 * S);
  }
  return g.getImageData(0, 0, W, W);
}

export function noticeMap({ id, color: col, glyph }) {
  const state = { sel: null, item: null };
  let live = null;   // { map, ctx } while the layer is on the map
  let groups = [];
  const src = `nm-${id}`, LI = `nm-${id}-i`, LT = `nm-${id}-t`;

  function features() {
    const fill = color(col), ink = color("var(--ink)"), surf = color("var(--surface)");
    const map = live?.map;
    return { type: "FeatureCollection", features: groups.map((g) => {
      const on = state.sel === g.key || (state.item != null && g.items.some((x) => x.id === state.item));
      const big = g.kind === "building", n = g.items.length;
      const img = `${src}|${big ? "b" : "s"}|${n}|${on ? 1 : 0}|${fill}|${surf}`;
      if (map && !map.hasImage(img)) map.addImage(img, markerImage({ fill, ink, surf, glyph, big, n, on }), { pixelRatio: S });
      return { type: "Feature", geometry: { type: "Point", coordinates: g.ll },
        properties: { key: g.key, img, label: big ? g.name : "", z: on ? 2 : big ? 1 : 0 } };
    }) };
  }
  /** new data; the markers stay over the page's other layers (the stage adds the place's own dot after them) */
  function draw() {
    const m = live?.map, s = m?.getSource(src); if (!s) return;
    s.setData(features());
    try { for (const l of [LT, LI]) if (m.getLayer(l)) m.moveLayer(l); } catch { /* style reloading */ }
  }

  function toggleGroup(key) {
    if (state.sel === key) { state.sel = null; state.item = null; } else { state.sel = key; state.item = null; }
    draw(); live?.ctx?.refresh?.();
  }

  const layer = {
    id: `nm-${id}`, rerun: true,
    custom(map, ctx) {
      live = { map, ctx };
      const surf = color("var(--surface)"), ink = color("var(--ink)");
      map.addSource(src, { type: "geojson", data: features() });
      // the building's name in a layer of its own, so the markers never wait for the basemap's glyphs
      map.addLayer({ id: LT, type: "symbol", source: src, filter: ["!=", ["get", "label"], ""], layout: {
        "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-offset": [0, 1.75], "text-anchor": "top" },
        paint: { "text-color": ink, "text-halo-color": surf, "text-halo-width": 1.5 } });
      map.addLayer({ id: LI, type: "symbol", source: src, layout: {
        "icon-image": ["get", "img"], "icon-allow-overlap": true, "icon-ignore-placement": true, "symbol-sort-key": ["get", "z"] } });
      const click = (e) => { const f = e.features?.[0]; if (f) toggleGroup(f.properties.key); };
      let ours = false;
      const move = (e) => { const c = map.getCanvas().style; const over = map.getLayer(LI) && map.queryRenderedFeatures(e.point, { layers: [LI] }).length > 0;
        if (over) { c.cursor = "pointer"; ours = true; } else if (ours) { c.cursor = ""; ours = false; } };
      map.once("idle", draw);   // after the stage has added the rest of the page's layers
      map.on("click", LI, click);
      map.on("mousemove", move);
      return () => {
        map.off("click", LI, click); map.off("mousemove", move);
        if (ours) map.getCanvas().style.cursor = "";
        if (map.getLayer(LI)) map.removeLayer(LI);
        if (map.getLayer(LT)) map.removeLayer(LT);
        if (map.getSource(src)) map.removeSource(src);
        live = null;
      };
    },
  };

  /** new groups (from the page's need()); a selection whose place or notice has gone is dropped */
  function sync(ctx, gs) {
    groups = gs || [];
    if (state.sel && !groups.some((g) => g.key === state.sel)) state.sel = null;
    if (state.item != null && !groups.some((g) => g.items.some((x) => x.id === state.item))) state.item = null;
    if (live) live.ctx = ctx;
    draw();
  }

  /** the panel list: every notice, or the selected place's; a row selects its notice, ↗ opens the source */
  function list({ row, empty = "Nothing to show.", cls = "" }) {
    const g = state.sel ? groups.find((x) => x.key === state.sel) : null;
    const items = g ? g.items : groups.flatMap((x) => x.items).sort((a, b) => (b.t || 0) - (a.t || 0));
    const head = g ? el("div", { class: "nm-head" },
      el("span", { class: "nm-head-t" }, icon(glyph, { size: 13 }), el("b", {}, g.name), g.sub ? el("span", {}, ` · ${g.sub}`) : null),
      el("button", { type: "button", class: "nm-all", title: "Show every notice again" }, `All ${groups.reduce((s, x) => s + x.items.length, 0)}`)) : null;
    head?.querySelector(".nm-all").addEventListener("click", () => toggleGroup(g.key));
    const rows = items.map((x) => {
      const r = row(x), on = state.item === x.id;
      const open = r.href ? el("a", { class: "nm-open", href: r.href, target: "_blank", rel: "noopener", title: "Open the original", "aria-label": "Open the original" }, "↗") : null;
      const node = el("div", { class: `nm-row${on ? " on" : ""}${r.fresh ? " new" : ""}`, role: "button", tabindex: "0", "aria-pressed": String(on), title: r.tip || r.title },
        el("span", { class: "nm-t" }, r.title),
        el("span", { class: "nm-m" }, r.pin ? el("i", { class: "nm-pin", title: "At its own spot on the map" }) : null, r.meta), open);
      const pick = () => { state.item = on ? null : x.id; draw(); live?.ctx?.refresh?.(); };
      node.addEventListener("click", (e) => { if (!e.target.closest(".nm-open")) pick(); });
      node.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
      return node;
    });
    return el("div", { class: `nm-list ${cls}` }, head, ...(rows.length ? rows : [el("p", { class: "note civ-empty" }, empty)]));
  }

  return { layer, sync, list, state, get groups() { return groups; } };
}

/** notices → marker groups: at their own spot when they have one (`spot(x)` → { ll, name } | null), else at a building
 *  (`building(x)` → { key, ll, name, sub } | null; null = not on the map) */
export function groupNotices(items, { spot, building }) {
  const by = new Map();
  for (const x of items) {
    const s = spot(x);
    const b = s ? { key: `s:${s.ll[0].toFixed(4)},${s.ll[1].toFixed(4)}`, kind: "spot", ll: s.ll, name: s.name } : building(x);
    if (!b) continue;
    const k = b.key, g = by.get(k) || { kind: "building", ...b, items: [] };
    g.items.push(x); by.set(k, g);
  }
  return [...by.values()];
}
