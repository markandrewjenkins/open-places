// The "highlighted area" convention, shared by every map on the site: a place of interest drawn as an outline (airports,
// golf courses, parks, protected areas, ferry terminals, campuses). One look everywhere, so a reader learns it once:
//   - a dotted outline in the layer's colour (round dots, 1.8 px), never a solid border (solid = boundaries and hazards)
//   - a faint fill of the same colour (7%), stronger on hover (18%) so it reads as clickable
//   - the name inside the area from zoom 11, in the layer's colour with a surface halo
// Points of interest that have no outline (a trailhead, a camera) stay icons; areas use this.
// The stage (places/civic-stage.js, kind: "area") and owners that draw their own layers (air/layer.js) both call
// addAreaLayers, so the dash, widths and opacities live only here.

export const AREA = { dash: [0.1, 2.2], width: 1.8, lineOpacity: 0.95, fill: 0.07, hoverFill: 0.18, labelMinZoom: 11 };

/**
 * Add the fill, dotted outline and label layers for one GeoJSON source of polygons.
 * color: a colour string or a MapLibre expression (e.g. ["get", "color"]). Returns the layer ids (fill first: the hit target).
 * Features may carry `label` (else `title`) for the name. Set feature-state { hover: true } to brighten the fill.
 */
export function addAreaLayers(map, id, source, color, { label = true, minzoom, labelColor, halo = "rgba(0,0,0,0.6)", before } = {}) {
  const mz = minzoom != null ? { minzoom } : {};
  const ids = [`${id}-af`, `${id}-al`];
  map.addLayer({ id: ids[0], type: "fill", source, ...mz,
    paint: { "fill-color": color, "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], AREA.hoverFill, AREA.fill] } }, before);
  map.addLayer({ id: ids[1], type: "line", source, ...mz, layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": color, "line-width": AREA.width, "line-opacity": AREA.lineOpacity, "line-dasharray": AREA.dash } }, before);
  if (label) {
    ids.push(`${id}-at`);
    map.addLayer({ id: ids[2], type: "symbol", source, minzoom: Math.max(minzoom ?? 0, AREA.labelMinZoom),
      layout: { "text-field": ["coalesce", ["get", "label"], ["get", "title"]], "text-size": 11.5, "text-font": ["Noto Sans Regular"], "text-max-width": 9 },
      paint: { "text-color": labelColor || color, "text-halo-color": halo, "text-halo-width": 1.4 } }, before);
  }
  return ids;
}
