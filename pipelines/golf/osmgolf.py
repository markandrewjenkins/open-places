"""Golf features from an OpenStreetMap city extract (.osm.pbf) in one osmium pass.

Collected inside the region box:
  courses   leisure=golf_course / disc_golf_course areas (ways and multipolygons) and point-only courses
  areas     golf=green|tee|fairway|bunker|water_hazard|lateral_water_hazard|rough|driving_range|... polygons
  holes     golf=hole and disc_golf=hole ways (the playing line, tee to green), with ref / par / handicap / dist tags
  points    golf=* and disc_golf=* nodes (pins, tees, baskets, bunkers mapped as points)
  water     natural=water / waterway=riverbank polygons (hazards not tagged golf=*, and lakes for the water views)
  wood      natural=wood|scrub, landuse=forest polygons and natural=tree_row lines (tree cover)
  trees     natural=tree nodes
Water, wood and trees are trimmed afterwards to the neighbourhood of a course (lakes: 2.5 km, for the view model).
"""
from __future__ import annotations

import math

import osmium

GOLF_KEEP = {"name", "holes", "par", "golf:course", "golf", "disc_golf", "leisure", "access", "operator", "ref", "handicap", "dist",
             "length", "golf:par", "website", "fee", "sport", "landuse", "natural", "water", "surface", "description", "start_date"}


def _tags(t) -> dict:
    return {tg.k: tg.v for tg in t if tg.k in GOLF_KEEP}


class _H(osmium.SimpleHandler):
    def __init__(self, bbox):
        super().__init__()
        self.s, self.w, self.n, self.e = bbox
        self.courses, self.areas, self.holes, self.points, self.water, self.wood, self.trees, self.lines = [], [], [], [], [], [], [], []

    def inside(self, lon, lat):
        return self.s <= lat <= self.n and self.w <= lon <= self.e

    def node(self, n):
        if not n.tags or not n.location.valid():
            return
        lon, lat = n.location.lon, n.location.lat
        if not self.inside(lon, lat):
            return
        t = n.tags
        if t.get("leisure") in ("golf_course", "disc_golf_course"):
            self.courses.append({"id": f"n{n.id}", "kind": "point", "lon": lon, "lat": lat, "tags": _tags(t)})
        elif "golf" in t or "disc_golf" in t:
            self.points.append({"id": f"n{n.id}", "lon": round(lon, 6), "lat": round(lat, 6), "tags": _tags(t)})
        elif t.get("natural") == "tree":
            self.trees.append((round(lon, 6), round(lat, 6)))

    def way(self, w):
        t = w.tags
        hole = t.get("golf") == "hole" or t.get("disc_golf") == "hole"
        row = t.get("natural") == "tree_row"
        if not (hole or row or t.get("golf") in ("cartpath", "path")):
            return
        pts = [(nd.location.lon, nd.location.lat) for nd in w.nodes if nd.location.valid()]
        if len(pts) < 2 or not any(self.inside(*p) for p in pts):
            return
        g = [[round(x, 6), round(y, 6)] for x, y in pts]
        if hole:
            self.holes.append({"id": f"w{w.id}", "geom": g, "tags": _tags(t)})
        elif row:
            self.wood.append({"id": f"w{w.id}", "line": True, "rings": [g], "tags": {"natural": "tree_row"}})
        else:
            self.lines.append({"id": f"w{w.id}", "geom": g, "tags": _tags(t)})

    def area(self, a):
        t = a.tags
        lei, golf, nat = t.get("leisure"), t.get("golf"), t.get("natural")
        kind = ("course" if lei in ("golf_course", "disc_golf_course") else
                "golf" if golf and golf != "hole" else
                "water" if nat == "water" or t.get("waterway") == "riverbank" else
                "wood" if nat in ("wood", "scrub") or t.get("landuse") == "forest" else None)
        if not kind:
            return
        rings, inner = [], []
        for ring in a.outer_rings():
            pts = [[round(nd.lon, 6), round(nd.lat, 6)] for nd in ring if nd.location.valid()]
            if len(pts) >= 4:
                rings.append(pts)
            for ir in a.inner_rings(ring):
                ip = [[round(nd.lon, 6), round(nd.lat, 6)] for nd in ir if nd.location.valid()]
                if len(ip) >= 4:
                    inner.append(ip)
        if not rings:
            return
        lons = [p[0] for r in rings for p in r]; lats = [p[1] for r in rings for p in r]
        if max(lats) < self.s or min(lats) > self.n or max(lons) < self.w or min(lons) > self.e:
            return
        oid = ("w" if a.from_way() else "r") + str(a.orig_id())
        rec = {"id": oid, "rings": rings, "tags": _tags(t)}
        if inner:
            rec["inner"] = inner
        {"course": self.courses, "golf": self.areas, "water": self.water, "wood": self.wood}[kind].append(
            {**rec, "kind": "area"} if kind == "course" else rec)


def _bbox(recs):
    out = []
    for r in recs:
        if r.get("kind") == "point":
            out.append((r["lat"], r["lon"], r["lat"], r["lon"]))
        else:
            pts = [p for ring in r["rings"] for p in ring]
            out.append((min(p[1] for p in pts), min(p[0] for p in pts), max(p[1] for p in pts), max(p[0] for p in pts)))
    return out


def _near(rec_pts, boxes, pad_m):
    """True when any of rec_pts lies inside any course box grown by pad_m."""
    for s, w, n, e in boxes:
        dy = pad_m / 110540; dx = pad_m / (111320 * math.cos(math.radians(s)))
        for lon, lat in rec_pts:
            if s - dy <= lat <= n + dy and w - dx <= lon <= e + dx:
                return True
    return False


def extract(pbf, bbox) -> dict:
    h = _H(bbox)
    h.apply_file(str(pbf), locations=True)
    boxes = _bbox(h.courses)
    # water: lakes up to 2.5 km away matter for views; wood and trees only inside or right next to a course
    water = [r for r in h.water if _near([p for ring in r["rings"] for p in ring[::max(1, len(ring) // 40)]], boxes, 2500)]
    wood = [r for r in h.wood if _near([p for ring in r["rings"] for p in ring[::max(1, len(ring) // 40)]], boxes, 50)]
    trees = [p for p in h.trees if _near([p], boxes, 20)]
    print(f"    {pbf.name}: {len(h.courses)} courses, {len(h.holes)} holes, {len(h.areas)} golf areas, {len(h.points)} golf points, "
          f"{len(water)} water, {len(wood)} wood, {len(trees)} trees", flush=True)
    return {"bbox": bbox, "courses": h.courses, "areas": h.areas, "holes": h.holes, "points": h.points, "lines": h.lines,
            "water": water, "wood": wood, "trees": trees}
