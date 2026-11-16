// Basemap label parity: OpenFreeMap's "dark" style draws place names at a fixed 10 px in capitals, dim grey, and hides
// them past zoom 14, while "positron" (light) scales them up to 14-18 px in mixed case. Importing this module once makes
// every map that loads the dark style use positron's label sizes, case and zoom range, with a legible light ink.
// It wraps Map.prototype.setStyle (the constructor and theme switches both go through it) with a transformStyle.
import maplibregl from "maplibre-gl";

const EXP = (pairs, base = 1.2) => ["interpolate", ["exponential", base], ["zoom"], ...pairs];
const LIN = (pairs) => ["interpolate", ["linear"], ["zoom"], ...pairs];
// dark layer id → [text-size, keep capitals?, ink] (sizes copied from positron's label_* layers)
const CITY = "#d3d9e4", SOFT = "#a3adbd";
const LABELS = {
  place_other: [LIN([8, 9, 12, 10]), true, SOFT],
  place_suburb: [LIN([8, 9, 12, 11]), true, SOFT],
  place_village: [EXP([7, 10, 11, 12]), false, CITY],
  place_town: [EXP([7, 12, 11, 14]), false, CITY],
  place_city: [EXP([4, 11, 7, 13, 11, 18]), false, CITY],
  place_city_large: [EXP([4, 12, 7, 14, 11, 20]), false, CITY],
  place_state: [LIN([5, 10, 8, 14]), true, SOFT],
  place_country_other: [LIN([3, 9, 7, 17]), false, CITY],
  place_country_minor: [LIN([2, 9, 5, 17]), false, CITY],
  place_country_major: [LIN([1, 9, 4, 17]), false, CITY],
};

export function matchLabels(style) {
  if (!style?.layers?.some((l) => l.id === "place_city")) return style;   // only OpenFreeMap "dark"
  for (const l of style.layers) {
    const m = LABELS[l.id]; if (!m || l.type !== "symbol") continue;
    l.layout = { ...l.layout, "text-size": m[0] };
    if (!m[1]) delete l.layout["text-transform"];
    l.paint = { ...l.paint, "text-color": m[2], "text-halo-color": "rgba(8, 13, 26, 0.85)", "text-halo-width": 1.2 };
    delete l.maxzoom;
  }
  return style;
}

const proto = maplibregl.Map.prototype;
if (!proto.__opLabels) {
  const set = proto.setStyle;
  proto.setStyle = function (style, options = {}) {
    if (typeof style === "string" && /openfreemap\.org\/styles\/dark/.test(style)) {
      const user = options?.transformStyle;
      options = { ...options, transformStyle: (prev, next) => matchLabels(user ? user(prev, next) : next) };
    }
    return set.call(this, style, options);
  };
  proto.__opLabels = true;
}
