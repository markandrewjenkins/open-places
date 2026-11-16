"""Course geometry → per-course measurements.

Input: the raw OpenStreetMap golf extract of one region (osmgolf.extract). Output: one record per course with what's
mapped (holes, greens, tees, fairways, bunkers, water), how complete that mapping is, and measurements from the map
the Copernicus 30 m surface model (climb, relief, water views) and ESA WorldCover 10 m (tree cover). Every course
with an outline also gets `outline`: the same measurements taken from the polygon alone (a grid of points instead of
tees and greens, a back-and-forth walk instead of the holes), used for provisional tiers (build.assign_provisional).

No shapely here: point-in-polygon is a vectorised ray cast, and areas/distances come from rasterising each course
on a 4 m grid in a local metric projection.
"""
from __future__ import annotations

import math
import re

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

from pipelines.common import dem

from .config import COMPLETENESS, DEM_DIR, VAN_PITCH_AND_PUTT

YD = 1.09361
CELL = 4.0           # course raster, m
HAZARD_REACH = 25.0  # a water hazard this close to the playing line is "in play"
OUTLINE_SPACING = 40.0   # outline-only measurements: grid spacing across the course polygon, m (at least)...
OUTLINE_MAX_PTS = 150    # ...widened on big courses to about this many points


# ============================================================================= geometry helpers

class Proj:
    """Local equirectangular projection around the region centre (error < 0.1 % over a city)."""
    def __init__(self, bbox):
        self.lon0, self.lat0 = (bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2
        self.kx, self.ky = 111320 * math.cos(math.radians(self.lat0)), 110540

    def xy(self, pts):
        a = np.asarray(pts, dtype=float).reshape(-1, 2)
        return np.c_[(a[:, 0] - self.lon0) * self.kx, (a[:, 1] - self.lat0) * self.ky]


def ring_area(xy) -> float:
    x, y = xy[:, 0], xy[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def in_ring(px, py, ring) -> np.ndarray:
    """Even-odd ray cast of many points against one ring (n × 2 array)."""
    x, y = ring[:, 0], ring[:, 1]
    x2, y2 = np.roll(x, -1), np.roll(y, -1)
    inside = np.zeros(len(px), dtype=bool)
    for i in range(len(x)):
        cond = (y[i] > py) != (y2[i] > py)
        if not cond.any():
            continue
        xint = (x2[i] - x[i]) * (py - y[i]) / ((y2[i] - y[i]) or 1e-12) + x[i]
        inside ^= cond & (px < xint)
    return inside


def polyline_len(xy) -> float:
    return float(np.hypot(*np.diff(xy, axis=0).T).sum()) if len(xy) > 1 else 0.0


def rdp(xy, eps):
    """Douglas-Peucker simplification of a polyline / ring in metres (iterative, keeps the end points)."""
    n = len(xy)
    if n < 4:
        return xy
    keep = np.zeros(n, dtype=bool); keep[[0, -1]] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        s, e = xy[i], xy[j]
        d = e - s
        L = math.hypot(*d)
        seg = xy[i + 1:j]
        dist = (np.abs(d[0] * (seg[:, 1] - s[1]) - d[1] * (seg[:, 0] - s[0])) / L) if L > 0 else np.hypot(*(seg - s).T)
        k = int(dist.argmax())
        if dist[k] > eps:
            keep[i + 1 + k] = True
            stack += [(i, i + 1 + k), (i + 1 + k, j)]
    return xy[keep]


def densify(xy, step):
    """Points every `step` m along a polyline (always including both ends)."""
    if len(xy) < 2:
        return xy
    seg = np.hypot(*np.diff(xy, axis=0).T)
    cum = np.r_[0, np.cumsum(seg)]
    if cum[-1] == 0:
        return xy[:1]
    d = np.r_[np.arange(0, cum[-1], step), cum[-1]]
    return np.c_[np.interp(d, cum, xy[:, 0]), np.interp(d, cum, xy[:, 1])]


# ============================================================================= course list

def _kind_from_name(name: str, tags: dict) -> str | None:
    n = (name or "").lower()
    gc = tags.get("golf:course", "")
    if tags.get("leisure") == "disc_golf_course" or "disc golf" in n:
        return "disc_golf"
    if gc == "pitch_and_putt" or "pitch" in n and "putt" in n or "par 3" in n or "par-3" in n:
        return "short"
    if gc == "driving_range" or ("driving range" in n and "par 3" not in n) or "family golf centre" in n or "learning academy" in n:
        return "range"
    return None


def assemble(raw, P: Proj):
    """Clean the course list: merge same-name neighbours (one club mapped as two polygons), drop clubhouse polygons
    mapped as courses, and drop point-only courses that duplicate a polygon."""
    areas, points = [], []
    for c in raw["courses"]:
        t = c["tags"]
        if c["kind"] == "point":
            points.append(c)
            continue
        if t.get("golf") == "clubhouse":
            continue
        rings = [P.xy(r) for r in c["rings"]]
        inner = [P.xy(r) for r in c.get("inner", [])]
        areas.append({"osm": [c["id"]], "name": t.get("name"), "tags": t, "rings": rings, "inner": inner})
    merged = []
    for a in sorted(areas, key=lambda a: -sum(ring_area(r) for r in a["rings"])):
        hit = None
        if a["name"]:
            for m in merged:
                if m["name"] == a["name"]:
                    d = min(np.hypot(*(r1[:, None, :] - r2[None, ::4, :]).reshape(-1, 2).T).min() for r1 in m["rings"] for r2 in a["rings"])
                    if d < 250:
                        hit = m
                        break
        if hit:
            hit["rings"] += a["rings"]; hit["inner"] += a["inner"]; hit["osm"] += a["osm"]
            hit["tags"] = {**a["tags"], **hit["tags"]}
        else:
            merged.append(a)
    for a in merged:
        a["area_ha"] = (sum(ring_area(r) for r in a["rings"]) - sum(ring_area(r) for r in a["inner"])) / 1e4
    out = merged
    for p in points:
        xy = P.xy([[p["lon"], p["lat"]]])[0]
        near = [a for a in merged if any(in_ring(np.array([xy[0]]), np.array([xy[1]]), r)[0] or
                                         np.hypot(*(r - xy).T).min() < 400 for r in a["rings"])]
        if not near:
            out.append({"osm": [p["id"]], "name": p["tags"].get("name"), "tags": p["tags"], "rings": [], "inner": [],
                        "point": xy, "area_ha": None})
    return out


def locate(courses, xy) -> np.ndarray:
    """Index of the containing course for each point (smallest course wins when nested), -1 when none."""
    best = np.full(len(xy), -1); best_area = np.full(len(xy), np.inf)
    for i, c in enumerate(courses):
        for r in c["rings"]:
            lo, hi = r.min(0), r.max(0)
            m = (xy[:, 0] >= lo[0]) & (xy[:, 0] <= hi[0]) & (xy[:, 1] >= lo[1]) & (xy[:, 1] <= hi[1])
            if not m.any():
                continue
            idx = np.where(m)[0]
            ins = in_ring(xy[idx, 0], xy[idx, 1], r)
            for h in c["inner"]:
                ins &= ~in_ring(xy[idx, 0], xy[idx, 1], h)
            sel = idx[ins & (c["area_ha"] < best_area[idx])]
            best[sel] = i; best_area[sel] = c["area_ha"]
    return best


# ============================================================================= surface model

class Terrain:
    """Copernicus 30 m surface model for a region, with a bare-ground estimate and an open-water mask.

    ground  grey-scale opening of the surface model over 150 m: removes things narrower than that (tree lines,
            clumps, buildings) while keeping hills and planar slopes exactly, so elevations along the holes are
            closer to the turf than the raw surface (which includes the trees).
    water   the sea (flattened to exactly 0 m in the model) plus OSM lakes and rivers of 2 ha or more."""
    def __init__(self, bbox, water_polys):
        z, (lon0, lat0), (dlon, dlat) = dem.mosaic(bbox, DEM_DIR, margin=0.03)
        self.z, self.lon0, self.lat0, self.dlon, self.dlat = z, lon0, lat0, dlon, dlat
        self.ground = ndimage.grey_opening(z, size=(5, 5))
        lab, _ = ndimage.label(z == 0.0)
        sizes = np.bincount(lab.ravel())
        sea = (lab > 0) & (sizes[lab] >= 20000)
        kx = 111320 * math.cos(math.radians((bbox[0] + bbox[2]) / 2))
        self.cell_m = (dlon * kx, dlat * 110540)
        img = Image.new("L", (z.shape[1], z.shape[0]), 0)
        dr = ImageDraw.Draw(img)
        for ring in water_polys:
            xs = [(p[0] - lon0) / dlon for p in ring]; ys = [(lat0 - p[1]) / dlat for p in ring]
            area = 0.5 * abs(sum(xs[i] * ys[i + 1] - xs[i + 1] * ys[i] for i in range(len(xs) - 1))) * self.cell_m[0] * self.cell_m[1]
            if area >= 20000:
                dr.polygon(list(zip(xs, ys)), fill=1)
        self.water = sea | (np.asarray(img, dtype=np.uint8) > 0)

    def grid(self, lon, lat):
        return (np.asarray(lon) - self.lon0) / self.dlon, (self.lat0 - np.asarray(lat)) / self.dlat

    def sample(self, arr, lon, lat):
        """Bilinear sample."""
        c, r = self.grid(lon, lat)
        return ndimage.map_coordinates(arr.astype(np.float32), [r, c], order=1, mode="nearest")

    def views(self, lon, lat):
        """Water views out to 6 km: golf views are often across a valley to the sea (Olympic View, Bear Mountain)."""
        c, r = self.grid(lon, lat)
        return dem.water_view(self.z, self.water, c, r, self.cell_m, max_m=6000.0, step_m=30.0)


    def vista(self, lon, lat, rays=24, near_m=1500.0, max_m=6000.0, step_m=30.0, eye=1.5):
        """Long views of any kind: the share of `rays` directions in which some surface beyond near_m is in sight
        (same sight-line rule as dem.water_view: a cell is visible when its elevation angle is at least the steepest
        seen so far on that ray). 0 = boxed in by trees or terrain, 1 = open panorama all round."""
        from scipy.ndimage import minimum_filter
        z = self.z
        H, W = z.shape
        c0, r0 = self.grid(lon, lat)
        ci = np.clip(np.round(c0).astype(int), 0, W - 1); ri = np.clip(np.round(r0).astype(int), 0, H - 1)
        z0 = minimum_filter(z, size=3)[ri, ci] + eye
        steps = np.arange(1, int(max_m / step_m) + 1) * step_m
        tot = np.zeros(len(c0), dtype=np.float32)
        for th in np.linspace(0, 2 * np.pi, rays, endpoint=False):
            dx, dy = math.cos(th) / self.cell_m[0], -math.sin(th) / self.cell_m[1]
            best = np.full(len(c0), -np.inf, dtype=np.float32)
            far = np.zeros(len(c0), dtype=bool)
            for d in steps:
                c = np.round(c0 + dx * d).astype(int); r = np.round(r0 + dy * d).astype(int)
                ok = (c >= 0) & (c < W) & (r >= 0) & (r < H)
                ang = (z[np.clip(r, 0, H - 1), np.clip(c, 0, W - 1)] - z0) / d
                vis = ok & (ang >= best)
                if d >= near_m:
                    far |= vis
                best = np.maximum(best, np.where(ok, ang, best))
            tot += far
        return tot / rays


class Cover:
    """ESA WorldCover 10 m crop (worldcover.py): share of tree-cover cells (class 10)."""
    def __init__(self, path):
        d = np.load(path)
        self.cls, self.lon0, self.lat0, self.res = d["cls"], float(d["lon0"]), float(d["lat0"]), float(d["res"])

    def at(self, lon, lat):
        r = np.clip(((self.lat0 - np.asarray(lat)) / self.res).astype(int), 0, self.cls.shape[0] - 1)
        c = np.clip(((np.asarray(lon) - self.lon0) / self.res).astype(int), 0, self.cls.shape[1] - 1)
        return self.cls[r, c]


def outline_grid(rings, inner, area_m2):
    """Points on a square grid across a course outline, for the outline-only (provisional) measurements: spacing at
    least OUTLINE_SPACING m, widened so a big course gets about OUTLINE_MAX_PTS points. Returns the points (n × 2,
    metres) and the spacing."""
    s = max(OUTLINE_SPACING, math.sqrt(max(area_m2, 1.0) / OUTLINE_MAX_PTS))
    allxy = np.vstack(rings)
    lo, hi = allxy.min(0), allxy.max(0)
    gx, gy = np.meshgrid(np.arange(lo[0] + s / 2, hi[0], s), np.arange(hi[1] - s / 2, lo[1], -s))
    px, py = gx.ravel(), gy.ravel()
    ins = np.zeros(len(px), dtype=bool)
    for r in rings:
        ins |= in_ring(px, py, r)
    for h in inner:
        ins &= ~in_ring(px, py, h)
    pts = np.c_[px[ins], py[ins]]
    if len(pts) < 3:                                # a thin sliver: fall back to the outline's own vertices
        pts = np.vstack([densify(r, s) for r in rings])
    return pts, s


def sweep_climb(pts, s, sample):
    """Walking approximation without holes: metres climbed per km walking back and forth across the course in rows
    (east-west) and again in columns (north-south), the same 10 m sampling and 1 m hysteresis as the hole-by-hole
    climb. Steps longer than 1.5 grid cells (across a gap in the outline) are skipped, not walked."""
    up = dist = 0.0
    for ax in (0, 1):
        o = 1 - ax
        lines = np.round(pts[:, o] / s).astype(int)
        for j, ln in enumerate(np.unique(lines)):
            row = pts[lines == ln]
            row = row[np.argsort(row[:, ax] * (1 if j % 2 == 0 else -1))]
            legs = np.split(row, np.where(np.hypot(*np.diff(row, axis=0).T) > 1.5 * s)[0] + 1)
            for leg in legs:
                if len(leg) < 2:
                    continue
                d = densify(leg, 10.0)
                up += climb(sample(d)); dist += polyline_len(leg)
    return (up / (dist / 1000)) if dist > 300 else None


def climb(elev, min_step=1.0) -> float:
    """Total ascent with a 1 m hysteresis, so 30 m surface-model noise doesn't add up to fake climbing."""
    up, ref = 0.0, None
    for e in elev:
        if ref is None:
            ref = e
        elif e - ref >= min_step:
            up += e - ref; ref = e
        elif ref - e >= min_step:
            ref = e
    return up


# ============================================================================= measurements

def _int(v):
    try:
        return int(re.findall(r"\d+", str(v))[0])
    except (IndexError, TypeError):
        return None


def measure(raw, bbox, region, cover_path=None, van_parks=None):
    P = Proj(bbox)
    courses = assemble(raw, P)
    unproj = lambda xy: np.c_[xy[:, 0] / P.kx + P.lon0, xy[:, 1] / P.ky + P.lat0]

    # --- assign features to courses
    holes = [{"xy": P.xy(h["geom"]), "tags": h["tags"], "id": h["id"]} for h in raw["holes"]]
    hmid = np.array([h["xy"][len(h["xy"]) // 2] for h in holes]) if holes else np.zeros((0, 2))
    h_course = locate(courses, hmid)
    # hole lines that stick out of the polygon (common at the edge of the map): try their two ends
    for j in np.where(h_course < 0)[0]:
        ends = locate(courses, holes[j]["xy"][[0, -1]])
        h_course[j] = ends.max()
    areas = [{"xy": [P.xy(r) for r in a["rings"]], "tags": a["tags"]} for a in raw["areas"]]
    a_cent = np.array([a["xy"][0].mean(0) for a in areas]) if areas else np.zeros((0, 2))
    a_course = locate(courses, a_cent)
    pts = raw["points"]
    p_xy = P.xy([[p["lon"], p["lat"]] for p in pts]) if pts else np.zeros((0, 2))
    p_course = locate(courses, p_xy)
    waters = [{"xy": [P.xy(r) for r in w["rings"]], "tags": w["tags"]} for w in raw["water"]]
    w_cent = np.array([w["xy"][0].mean(0) for w in waters]) if waters else np.zeros((0, 2))
    w_course = locate(courses, w_cent)
    woods = [{"xy": [P.xy(r) for r in w["rings"]], "line": w.get("line", False)} for w in raw["wood"]]
    tree_xy = P.xy(raw["trees"]) if raw["trees"] else np.zeros((0, 2))

    print("    surface model…", flush=True)
    T = Terrain(bbox, [r for w in raw["water"] if w["tags"].get("water") not in ("pond", "basin", "wastewater", "reflecting_pool")
                       for r in w["rings"]])

    cover = Cover(cover_path) if cover_path and cover_path.exists() else None
    # water views for every hole in one pass (sample every 40 m along the playing line)
    # plus the tee (start of the playing line) and the green (its end): where golfers stand still and look around
    vpts, vown, vkind = [], [], []
    for j, h in enumerate(holes):
        if h_course[j] >= 0:
            vd = densify(h["xy"], 40.0)
            vpts += [vd, h["xy"][:1], h["xy"][-1:]]; vown += [j] * (len(vd) + 2); vkind += [0] * len(vd) + [1, 2]
    hole_view, tee_view, green_view, tee_vista, green_vista = {}, {}, {}, {}, {}
    if vpts:
        print(f"    water views from {len(vown):,} points on the holes…", flush=True)
        vll = unproj(np.vstack(vpts))
        v = T.views(vll[:, 0], vll[:, 1])
        vown, vkind = np.array(vown), np.array(vkind)
        tg = vkind > 0
        vis_far = np.zeros(len(v), dtype=np.float32)
        vis_far[tg] = T.vista(vll[tg, 0], vll[tg, 1])
        tee_vista, green_vista = {}, {}
        for j in np.unique(vown):
            hid = holes[j]["id"]
            tee_vista[hid] = float(vis_far[(vown == j) & (vkind == 1)][0])
            green_vista[hid] = float(vis_far[(vown == j) & (vkind == 2)][0])
            hole_view[hid] = float(v[(vown == j) & (vkind == 0)].mean())
            tee_view[hid] = float(v[(vown == j) & (vkind == 1)][0])
            green_view[hid] = float(v[(vown == j) & (vkind == 2)][0])

    # outline-only measurements (provisional ranks for courses without mapped holes; on mapped courses they're only the
    # check of that method): sea and lake views and long views from a grid across the course polygon, in one pass
    og = {i: outline_grid(c["rings"], c["inner"], c["area_ha"] * 1e4) for i, c in enumerate(courses) if c["rings"]}
    o_view, o_vista = {}, {}
    if og:
        allp = np.vstack([p for p, _ in og.values()])
        own = np.concatenate([[i] * len(p) for i, (p, _) in og.items()])
        print(f"    outline views from {len(allp):,} grid points…", flush=True)
        ll = unproj(allp)
        v, vf = T.views(ll[:, 0], ll[:, 1]), T.vista(ll[:, 0], ll[:, 1])
        for i in og:
            o_view[i], o_vista[i] = v[own == i], vf[own == i]

    out, geo = [], []
    for i, c in enumerate(courses):
        t = c["tags"]
        name = c["name"] or ("Disc golf course" if t.get("leisure") == "disc_golf_course" else "Unnamed golf course")
        my_h = [holes[j] for j in np.where(h_course == i)[0]]
        disc = t.get("leisure") == "disc_golf_course" or (my_h and all("disc_golf" in h["tags"] for h in my_h))
        my_h = [h for h in my_h if ("disc_golf" in h["tags"]) == bool(disc)]
        my_a = [areas[j] for j in np.where(a_course == i)[0]]
        my_p = [pts[j] for j in np.where(p_course == i)[0]]
        my_w = [waters[j] for j in np.where(w_course == i)[0]]
        cnt = lambda k: sum(a["tags"].get("golf") == k for a in my_a)
        pcnt = lambda k: sum(p["tags"].get("golf") == k for p in my_p)
        greens, fairways = cnt("green"), cnt("fairway")
        tees = cnt("tee") + pcnt("tee")
        pins = pcnt("pin") + sum(p["tags"].get("disc_golf") == "basket" for p in my_p)
        bunk = [a for a in my_a if a["tags"].get("golf") == "bunker"]
        n_bunk = len(bunk) + pcnt("bunker")
        hz = [a for a in my_a if a["tags"].get("golf") in ("water_hazard", "lateral_water_hazard")]
        # natural water inside the course not also drawn as a hazard counts as a hazard
        hz_all = [r for a in hz for r in a["xy"]] + [r for w in my_w for r in w["xy"]]
        n_water = len(hz) + len(my_w)

        # --- holes, ordered by number
        H = []
        for h in my_h:
            L = polyline_len(h["xy"])
            if L < 15:
                continue
            H.append({"ref": _int(h["tags"].get("ref")), "par": _int(h["tags"].get("par")), "hcp": _int(h["tags"].get("handicap")),
                      "m": L, "xy": h["xy"], "id": h["id"]})
        H.sort(key=lambda h: (h["ref"] if h["ref"] is not None else 999, -h["m"]))
        n_holes = len(H)
        yd = [h["m"] * YD for h in H]
        mean_yd = float(np.mean(yd)) if yd else None

        # --- kind and the number of holes it should have
        kind = _kind_from_name(name, t)
        if name in VAN_PITCH_AND_PUTT and van_parks is not None and region == "vancouver":
            kind = kind or "short"
        exp_tag = _int(t.get("holes")) or ({"18_hole": 18, "9_hole": 9}.get(t.get("golf:course")))
        m12 = re.search(r"(\d+)[- ]hole", name.lower())
        if m12:
            exp_tag = exp_tag or int(m12.group(1))
        if kind is None and mean_yd is not None and n_holes >= 6:
            kind = "short" if mean_yd < 140 else None
        kind = kind or "full"
        if exp_tag:
            expected, exp_src = exp_tag, "tag"
        elif n_holes >= 10:
            expected, exp_src = int(math.ceil(n_holes / 9) * 9), "mapped"
        elif kind == "range":
            expected, exp_src = 0, "range"
        elif kind == "short" or kind == "disc_golf":
            expected, exp_src = (9 if n_holes and n_holes <= 9 else 18), "estimate"
        elif c["area_ha"] is not None:
            expected, exp_src = (18 if c["area_ha"] >= 38 else 9), "estimate (area)"
            if n_holes > 9:
                expected = 18
        else:
            expected, exp_src = 18, "estimate"
        expected = max(expected, n_holes if kind != "range" else 0)

        # --- completeness
        if expected:
            r = lambda n, k=1.0: min(1.0, n / max(1, k * expected))
            par3 = sum(1 for h in H if h["par"] == 3)
            fw_need = max(1, expected - (par3 if n_holes >= expected * 0.8 else round(expected * 0.22)))
            hz_ok = 1.0 if (n_bunk + n_water) > 0 or kind in ("short", "disc_golf") else 0.0
            parts = {"holes": r(n_holes), "greens": r(max(greens, pins if kind == "disc_golf" else 0)),
                     "tees": r(tees), "fairways": 1.0 if kind in ("short", "disc_golf") else min(1.0, fairways / fw_need), "hazards": hz_ok}
            if kind in ("short", "disc_golf"):     # no fairways to expect: give the weight to holes and greens
                parts["fairways"] = parts["greens"]
            comp = sum(COMPLETENESS[k] * v for k, v in parts.items())
        else:
            parts, comp = {}, 0.0

        # --- course raster: water hazards in play, bunker and water areas, OSM-mapped woods
        rec = {"id": f"{region}-{c['osm'][0]}", "osm": c["osm"], "region": region, "name": name, "kind": "disc_golf" if disc else kind,
               "area_ha": c["area_ha"], "holes_expected": expected, "holes_expected_from": exp_src, "holes_mapped": n_holes,
               "greens": greens, "tees": tees, "fairways": fairways, "pins": pins, "bunkers": n_bunk, "water_hazards": n_water,
               "access": t.get("access"), "operator": t.get("operator"), "website": t.get("website"),
               "completeness": round(comp, 3), "completeness_parts": {k: round(v, 2) for k, v in parts.items()}}
        if c["rings"]:
            allxy = np.vstack(c["rings"])
            x0, y0 = allxy.min(0) - 30; x1, y1 = allxy.max(0) + 30
            W, Hh = int((x1 - x0) / CELL) + 1, int((y1 - y0) / CELL) + 1
            topx = lambda xy: [((p[0] - x0) / CELL, (y1 - p[1]) / CELL) for p in xy]
            mask_img = Image.new("L", (W, Hh), 0); md = ImageDraw.Draw(mask_img)
            for rr in c["rings"]:
                md.polygon(topx(rr), fill=1)
            for rr in c["inner"]:
                md.polygon(topx(rr), fill=0)
            mask = np.asarray(mask_img, dtype=bool)
            wimg = Image.new("L", (W, Hh), 0); wd = ImageDraw.Draw(wimg)
            for rr in hz_all:
                wd.polygon(topx(rr), fill=1)
            water_r = np.asarray(wimg, dtype=bool)
            bimg = Image.new("L", (W, Hh), 0); bd = ImageDraw.Draw(bimg)
            for a in bunk:
                for rr in a["xy"]:
                    bd.polygon(topx(rr), fill=1)
            rec["bunker_area_m2"] = float((np.asarray(bimg, dtype=bool) & mask).sum() * CELL * CELL)
            rec["water_area_m2"] = float((water_r & mask).sum() * CELL * CELL)
            timg = Image.new("L", (W, Hh), 0); td = ImageDraw.Draw(timg)
            for w in woods:
                for rr in w["xy"]:
                    if w["line"]:
                        td.line(topx(rr), fill=1, width=3)
                    elif len(rr) >= 3:
                        td.polygon(topx(rr), fill=1)
            for p in tree_xy:
                if x0 <= p[0] <= x1 and y0 <= p[1] <= y1:
                    cx, cy = (p[0] - x0) / CELL, (y1 - p[1]) / CELL
                    td.ellipse([cx - 1.5, cy - 1.5, cx + 1.5, cy + 1.5], fill=1)
            rec["tree_osm"] = float((np.asarray(timg, dtype=bool) & mask).sum() / max(1, mask.sum()))
            dist_w = ndimage.distance_transform_edt(~water_r) * CELL if water_r.any() else None
            # tree cover (WorldCover, 12 m sampling) and relief (surface-model ground) over the course polygon
            ys, xs = np.nonzero(mask[::3, ::3])
            if len(xs):
                ll = unproj(np.c_[x0 + xs * 3 * CELL, y1 - ys * 3 * CELL])
                gz = T.sample(T.ground, ll[:, 0], ll[:, 1])
                rec["relief_m"] = float(np.percentile(gz, 98) - np.percentile(gz, 2))
                rec["elev_min"], rec["elev_max"] = float(np.percentile(gz, 2)), float(np.percentile(gz, 98))
                if cover is not None:
                    rec["trees"] = float((cover.at(ll[:, 0], ll[:, 1]) == 10).mean())
        else:
            dist_w = None

        # --- per-hole lengths, elevation, climb, water in play, views
        hole_rows, total_climb, walk_m, views = [], 0.0, 0.0, []
        for k, h in enumerate(H):
            d = densify(h["xy"], 10.0)
            ll = unproj(d)
            z = T.sample(T.ground, ll[:, 0], ll[:, 1])
            up = climb(z)
            wet = False
            if dist_w is not None:
                cc = np.clip(((d[:, 0] - x0) / CELL).astype(int), 0, W - 1); rr_ = np.clip(((y1 - d[:, 1]) / CELL).astype(int), 0, Hh - 1)
                wet = bool((dist_w[rr_, cc] <= HAZARD_REACH).any())
            hv = hole_view.get(h["id"], 0.0)
            views.append(hv)
            hole_rows.append({"ref": h["ref"], "par": h["par"], "hcp": h["hcp"], "yd": round(h["m"] * YD), "tee_z": round(float(z[0]), 1),
                              "green_z": round(float(z[-1]), 1), "drop": round(float(z[0] - z[-1]), 1), "climb": round(up, 1), "water": wet,
                              "view": round(hv, 3),
                              "view_tee": round(tee_view.get(h["id"], 0.0), 3), "view_green": round(green_view.get(h["id"], 0.0), 3)})
            total_climb += up; walk_m += h["m"]
            # walk to the next tee: the next hole number, nearest start, if it's a plausible walk
            nxt = [g for g in H if h["ref"] is not None and g["ref"] == h["ref"] + 1]
            if nxt:
                g = min(nxt, key=lambda g: np.hypot(*(g["xy"][0] - h["xy"][-1])))
                gap = float(np.hypot(*(g["xy"][0] - h["xy"][-1])))
                if gap < 500:
                    seg = densify(np.vstack([h["xy"][-1], g["xy"][0]]), 10.0)
                    sll = unproj(seg)
                    total_climb += climb(T.sample(T.ground, sll[:, 0], sll[:, 1])); walk_m += gap
        pars = [h["par"] for h in H if h["par"]]
        rec.update({
            "holes": hole_rows,
            "yards": round(sum(yd)) if yd else None,
            "mean_yd": round(mean_yd, 1) if mean_yd else None,
            "par": (sum(pars) if len(pars) == n_holes and n_holes else _int(t.get("par"))),
            "par_mapped": len(pars),
            "water_holes": sum(r["water"] for r in hole_rows),
            "climb_m": round(total_climb, 1) if H else None,
            "walk_km": round(walk_m / 1000, 2) if H else None,
            "climb_per_km": round(total_climb / (walk_m / 1000), 1) if walk_m > 500 else None,
            "views": round(float(np.mean(views)), 3) if views else None,
            # long views of anything (not only water), p90 over tees and greens; informational, not in the score:
            # it rewards flat treeless land as much as a mountainside, so it doesn't measure scenery on its own
            "vista": round(float(np.percentile([tee_vista.get(h["id"], 0.0) for h in H] + [green_vista.get(h["id"], 0.0) for h in H], 90)), 3) if H else None,
        })
        # outline-only measurements: what can be said about the course without its holes. Views as at the tees and
        # greens (90th percentile, here over the grid), a back-and-forth walk for the climb, the hole count from a tag
        # or from the area (38 ha or more: 18 holes). Relief and tree cover above are already outline-only.
        if i in og:
            gpts, s = og[i]
            cl = sweep_climb(gpts, s, lambda d: T.sample(T.ground, *unproj(d).T))
            rec["outline"] = {"points": int(len(gpts)), "spacing_m": round(s, 1),
                              "views": round(float(np.percentile(o_view[i], 90)), 4),
                              "vista": round(float(np.percentile(o_vista[i], 90)), 3),
                              "climb_per_km": round(cl, 1) if cl is not None else None,
                              "holes": exp_tag or (18 if c["area_ha"] >= 38 else 9), "holes_from": "tag" if exp_tag else "area"}
        # centre for the map and the weather point
        if c["rings"]:
            big = max(c["rings"], key=ring_area)
            m = mask if c["rings"] else None
            cy_, cx_ = ndimage.center_of_mass(m)
            cen = unproj(np.array([[x0 + cx_ * CELL, y1 - cy_ * CELL]]))[0]
        else:
            cen = unproj(np.array([c["point"]]))[0]
        rec["lon"], rec["lat"] = round(float(cen[0]), 5), round(float(cen[1]), 5)
        out.append(rec)
        # map geometry: lon/lat at 5 dp (~1 m), lines and rings simplified (Douglas-Peucker, 1.5 m; outlines 4 m)
        g = lambda r, eps=1.5: unproj(rdp(r, eps)).round(5).tolist()
        geo.append({"id": rec["id"],
                    "outline": [g(r, 4.0) for r in c["rings"]],
                    "holes": [{"ref": h["ref"], "par": h["par"], "line": g(h["xy"])} for h in H],
                    "greens": [g(r) for a in my_a if a["tags"].get("golf") == "green" for r in a["xy"]],
                    "bunkers": [g(r) for a in bunk for r in a["xy"]],
                    "water": [g(r, 2.5) for r in hz_all],
                    "fairways": [g(r, 2.5) for a in my_a if a["tags"].get("golf") == "fairway" for r in a["xy"]],
                    "tees": [unproj(r).mean(0).round(5).tolist() for a in my_a if a["tags"].get("golf") == "tee" for r in a["xy"]]})
    unassigned = {"holes": int((h_course < 0).sum()), "areas": int((a_course < 0).sum()), "points": int((p_course < 0).sum())}
    return out, geo, unassigned
