"""Parks, their main trails and nearby surf spots for the Open Places Outdoors pages (Trails & Advisories, What's Hot Now).

  python -m pipelines.outdoors.build [--force]

Writes site/public/data/outdoors/parks_<region>.json and surf_spots.json. Everything is fetched once and cached under
data/outdoors/raw/ (git-ignored); a rerun only rebuilds from the cache unless --force.

Sources (each credited on the page, no keys, no accounts)
  BC Parks, ecological reserves and protected areas: BC Data Catalogue WFS layer WHSE_TANTALIS.TA_PARK_ECORES_PA_SVW
      (openmaps.gov.bc.ca), Open Government Licence – British Columbia. One request per region.
  Everything else: OpenStreetMap (© OpenStreetMap contributors, ODbL). The BBBike Victoria extract (data/osm/, shared with
      Sunday Wander and Golf) covers the core; the rest of the region (Sooke, the Juan de Fuca coast, the north Peninsula)
      comes from the Overpass API in tiles of 0.25°, one query per tile, four seconds apart, cached per tile. A tile the
      servers can't answer is listed under "gaps" in the output and filled by the next run.
      - National (Parks Canada): operator / owner "Parks Canada", or boundary=national_park. Parks Canada's own boundary
        files cover national parks only, not the historic sites (Fort Rodd Hill), so OSM is used for both.
      - Regional (CRD Regional Parks): operator "Capital Regional District" or "Regional Park" / "Regional Trail" in the name.
        The CRD publishes park boundaries on its map portal without a stated open licence, so they are taken from OSM.
      - Municipal / local: the remaining leisure=park and nature reserves (public, at least 0.3 ha).
      - Trails: highway=path / footway / track / bridleway / cycleway / steps inside a park (not sidewalks or crossings),
        difficulty from sac_scale (hiking) and mtb:scale (mountain biking), length from the geometry.
      - What to do there: beaches and swimming areas, campsites, dog parks and the park's dog tag, picnic sites, viewpoints and
        peaks, slipways, fishing spots, playgrounds, bridleways, waterfalls, toilets.
  Surf spots: OSM sport=surfing along Vancouver Island's south and west coasts, plus a short hand list for the known public
      breaks OSM doesn't tag (each with its source). Waves come live in the browser from Open-Meteo Marine (CC BY 4.0).
"""
from __future__ import annotations

import json
import math
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from pipelines.common import osm_pbf
from pipelines.common.http import get_json
from pipelines.common.osm import overpass, tiles

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "outdoors" / "raw"
OUT = ROOT / "site" / "public" / "data" / "outdoors"

# (south, west, north, east): Greater Victoria and the Juan de Fuca / Sooke Hills parks to its west
REGIONS = {"crd": {"name": "Greater Victoria", "bbox": (48.28, -124.10, 48.78, -123.20), "pbf": "Victoria"}}
PBF = ROOT / "data" / "osm"   # BBBike city extracts shared with Sunday Wander and Golf (pipelines/common/osm_pbf.py downloads them)
SURF_BBOX = (48.25, -126.10, 49.35, -123.60)   # Jordan River to Tofino

WFS = "https://openmaps.gov.bc.ca/geo/pub/wfs"
WFS_LAYER = "pub:WHSE_TANTALIS.TA_PARK_ECORES_PA_SVW"

FORCE = "--force" in sys.argv


# ============================================================================= fetch (cached)
def fetch_bc(key: str, bbox) -> dict:
    f = RAW / f"bcparks_{key}.json"
    if f.exists() and not FORCE:
        return json.loads(f.read_text(encoding="utf-8"))
    s, w, n, e = bbox
    j = get_json(WFS, {"service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeName": WFS_LAYER, "outputFormat": "application/json",
                       "srsName": "EPSG:4326", "bbox": f"{s},{w},{n},{e},urn:ogc:def:crs:EPSG::4326",
                       "propertyName": "PROTECTED_LANDS_NAME,PROTECTED_LANDS_DESIGNATION,PARK_CLASS,ORCS_PRIMARY,OFFICIAL_AREA_HA,SHAPE"}, min_interval=3)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(j), encoding="utf-8")
    return j


PARK_SEL = ('way["leisure"~"^(park|nature_reserve)$"]({b});relation["leisure"~"^(park|nature_reserve)$"]({b});'
            'way["boundary"~"^(protected_area|national_park)$"]({b});relation["boundary"~"^(protected_area|national_park)$"]({b});')
TRAIL_HW = "^(path|footway|track|bridleway|cycleway|steps)$"
POI_SEL = ('nwr(area.a)["natural"~"^(beach|peak)$"];nwr(area.a)["leisure"~"^(swimming_area|dog_park|playground|slipway|fishing|picnic_table)$"];'
           'nwr(area.a)["tourism"~"^(camp_site|picnic_site|viewpoint)$"];nwr(area.a)["amenity"="toilets"];node(area.a)["waterway"="waterfall"];')


def strips(bbox, inner) -> list[tuple]:
    """the parts of bbox (s, w, n, e) outside inner, as boxes"""
    s, w, n, e = bbox
    S, W, N, E = inner
    out = []
    if W > w:
        out.append((s, w, n, W))
    if E < e:
        out.append((s, E, n, e))
    if S > s:
        out.append((s, max(w, W), S, min(e, E)))
    if N < n:
        out.append((N, max(w, W), n, min(e, E)))
    return out


def fetch_overpass(key: str, boxes) -> tuple[list[dict], list]:
    """parks (out geom), the paths inside them (out geom) and the facilities inside them (out center), per tile.
    A tile the servers can't answer is left out and reported (a rerun fills it from where it stopped)."""
    cache = RAW / f"osm_{key}"
    cache.mkdir(parents=True, exist_ok=True)
    seen: dict[tuple[str, int], dict] = {}
    gaps, down = [], False   # once two tiles in a row fail the servers are down: list the rest as gaps without asking
    fails = 0
    for box in boxes:
        for t in tiles(box, 0.25):
            f = cache / f"{t[0]}_{t[1]}_{t[2]}_{t[3]}.json"
            if f.exists() and not FORCE:
                data = json.loads(f.read_text(encoding="utf-8"))
            elif down:
                gaps.append(t)
                continue
            else:
                bb = ",".join(map(str, t))
                q = (f"[out:json][timeout:120];({PARK_SEL.format(b=bb)})->.p;.p map_to_area->.a;"
                     f'way(area.a)["highway"~"{TRAIL_HW}"]["footway"!~"^(sidewalk|crossing|traffic_island)$"]["access"!~"^(private|no)$"]->.t;'
                     f"({POI_SEL})->.q;.p out geom;.t out geom;.q out center;")
                print(f"  overpass tile {t}", flush=True)
                try:
                    data = overpass(q, timeout=120, tries=2)
                    fails = 0
                except RuntimeError as exc:
                    print(f"    skipped ({exc}); rerun later to fill it", flush=True)
                    gaps.append(t)
                    fails += 1
                    down = fails >= 2
                    continue
                f.write_text(json.dumps(data), encoding="utf-8")
                time.sleep(4)
            for el in data.get("elements", []):
                seen[(el["type"], el["id"])] = el
    return list(seen.values()), gaps


def from_overpass(els: list[dict]) -> dict:
    """Overpass elements → { parks: {key: (tags, polys)}, trails: {key: (tags, coords)}, pois: {key: (tags, lon, lat)} }"""
    out = {"parks": {}, "trails": {}, "pois": {}}
    for el in els:
        t = el.get("tags", {})
        k = f"{el['type'][0]}{el['id']}"
        if el["type"] != "node" and (t.get("leisure") in ("park", "nature_reserve") or t.get("boundary") in ("protected_area", "national_park")):
            polys = polys_of(el)
            if polys:
                out["parks"][k] = (t, polys)
        elif el["type"] == "way" and "highway" in t and el.get("geometry"):
            g = [[q["lon"], q["lat"]] for q in el["geometry"] if q]
            if len(g) >= 2:
                out["trails"][k] = (t, g)
        else:
            c = el.get("center") or ({"lon": el["lon"], "lat": el["lat"]} if "lon" in el else None)
            if c:
                out["pois"][k] = (t, c["lon"], c["lat"])
    return out


POI_TAGS = {"natural": {"beach", "peak"}, "leisure": {"swimming_area", "dog_park", "playground", "slipway", "fishing", "picnic_table"},
            "tourism": {"camp_site", "picnic_site", "viewpoint"}, "amenity": {"toilets"}, "waterway": {"waterfall"}}
SKIP_FOOT = {"sidewalk", "crossing", "traffic_island"}


def read_pbf(path: Path, bbox) -> dict:
    """the same three sets from a city extract (BBBike .osm.pbf, already on disk for Sunday Wander and Golf)"""
    import osmium
    s, w, n, e = bbox
    out = {"parks": {}, "trails": {}, "pois": {}}
    is_poi = lambda t: any(t.get(k) in v for k, v in POI_TAGS.items())

    class H(osmium.SimpleHandler):
        def node(self, nd):
            if nd.tags and is_poi(nd.tags) and nd.location.valid():
                out["pois"][f"n{nd.id}"] = (dict(nd.tags), nd.location.lon, nd.location.lat)

        def way(self, wy):
            t = wy.tags
            hw = t.get("highway")
            if hw not in ("path", "footway", "track", "bridleway", "cycleway", "steps") or t.get("footway") in SKIP_FOOT or t.get("access") in ("private", "no"):
                return
            g = [[nd.lon, nd.lat] for nd in wy.nodes if nd.location.valid()]
            if len(g) >= 2:
                out["trails"][f"w{wy.id}"] = (dict(t), g)

        def area(self, a):
            t = a.tags
            park = t.get("leisure") in ("park", "nature_reserve") or t.get("boundary") in ("protected_area", "national_park")
            if not (park or is_poi(t)):
                return
            polys = []
            for ring in a.outer_rings():
                o = [[nd.lon, nd.lat] for nd in ring if nd.location.valid()]
                if len(o) < 4:
                    continue
                holes = [[[nd.lon, nd.lat] for nd in ir if nd.location.valid()] for ir in a.inner_rings(ring)]
                polys.append([o] + [h for h in holes if len(h) >= 4])
            if not polys:
                return
            k = ("w" if a.from_way() else "r") + str(a.orig_id())
            if park:
                out["parks"][k] = (dict(t), polys)
            else:
                xs = [x for x, _ in polys[0][0]]
                ys = [y for _, y in polys[0][0]]
                out["pois"][k] = (dict(t), sum(xs) / len(xs), sum(ys) / len(ys))

    H().apply_file(str(path), locations=True)
    return out


def fetch_surf() -> list[dict]:
    f = RAW / "surf_osm.json"
    if f.exists() and not FORCE:
        return json.loads(f.read_text(encoding="utf-8"))["elements"]
    s, w, n, e = SURF_BBOX
    try:
        data = overpass(f'[out:json][timeout:120];(nwr["sport"="surfing"]({s},{w},{n},{e}););out center tags;', timeout=120, tries=2)
    except RuntimeError as exc:
        print(f"  surf: OSM skipped ({exc}); the hand list only", flush=True)
        return []
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(data), encoding="utf-8")
    return data["elements"]


# ============================================================================= geometry helpers
def kxy(lat: float) -> tuple[float, float]:
    return 111320 * math.cos(math.radians(lat)), 110540


def rdp(xy: np.ndarray, tol: float) -> np.ndarray:
    """Douglas–Peucker on an (n, 2) array in metres"""
    if len(xy) < 3:
        return xy
    keep = np.zeros(len(xy), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(xy) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        p, q = xy[a], xy[b]
        d = q - p
        seg = xy[a + 1:b] - p
        L = math.hypot(*d)
        dist = np.abs(d[0] * seg[:, 1] - d[1] * seg[:, 0]) / L if L > 0 else np.hypot(seg[:, 0], seg[:, 1])
        i = int(np.argmax(dist))
        if dist[i] > tol:
            m = a + 1 + i
            keep[m] = True
            stack += [(a, m), (m, b)]
    return xy[keep]


def simplify(coords: list, tol_m: float, ring: bool = False) -> list:
    a = np.asarray(coords, float)
    if len(a) < 3:
        return [[round(x, 5), round(y, 5)] for x, y in a]
    kx, ky = kxy(float(a[:, 1].mean()))
    s = rdp(np.column_stack([a[:, 0] * kx, a[:, 1] * ky]), tol_m)
    out = [[round(x / kx, 5), round(y / ky, 5)] for x, y in s]
    if ring and len(out) < 4:
        return []
    return out


def ring_area_m2(r) -> float:
    a = np.asarray(r, float)
    if len(a) < 4:
        return 0.0
    kx, ky = kxy(float(a[:, 1].mean()))
    x, y = a[:, 0] * kx, a[:, 1] * ky
    return abs(float(np.dot(x[:-1], y[1:]) - np.dot(x[1:], y[:-1]))) / 2


def length_m(coords) -> float:
    a = np.asarray(coords, float)
    if len(a) < 2:
        return 0.0
    kx, ky = kxy(float(a[:, 1].mean()))
    return float(np.hypot(np.diff(a[:, 0]) * kx, np.diff(a[:, 1]) * ky).sum())


def in_ring(x: float, y: float, r) -> bool:
    inside = False
    j = len(r) - 1
    for i in range(len(r)):
        xi, yi = r[i]
        xj, yj = r[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def in_poly(x: float, y: float, polys) -> bool:
    """polys: [[outer, *holes], …]"""
    for p in polys:
        if in_ring(x, y, p[0]) and not any(in_ring(x, y, h) for h in p[1:]):
            return True
    return False


def stitch(segs: list[list]) -> list[list]:
    """join way segments (lists of [lon, lat]) end to end into closed rings"""
    segs = [s[:] for s in segs if len(s) >= 2]
    rings = []
    key = lambda p: (round(p[0], 7), round(p[1], 7))
    while segs:
        cur = segs.pop()
        while key(cur[0]) != key(cur[-1]):
            for i, s in enumerate(segs):
                if key(s[0]) == key(cur[-1]):
                    cur += s[1:]
                elif key(s[-1]) == key(cur[-1]):
                    cur += s[::-1][1:]
                elif key(s[-1]) == key(cur[0]):
                    cur = s + cur[1:]
                elif key(s[0]) == key(cur[0]):
                    cur = s[::-1] + cur[1:]
                else:
                    continue
                segs.pop(i)
                break
            else:
                break   # can't close (clipped or broken relation): drop it
        if len(cur) >= 4 and key(cur[0]) == key(cur[-1]):
            rings.append(cur)
    return rings


def polys_of(el: dict) -> list:
    """an OSM way or multipolygon relation (out geom) → [[outer, *holes], …]"""
    g = lambda pts: [[p["lon"], p["lat"]] for p in pts if p]
    if el["type"] == "way":
        r = g(el.get("geometry") or [])
        return [[r]] if len(r) >= 4 and r[0] == r[-1] else []
    outer = stitch([g(m.get("geometry") or []) for m in el.get("members", []) if m["type"] == "way" and m.get("role") in ("outer", "")])
    inner = stitch([g(m.get("geometry") or []) for m in el.get("members", []) if m["type"] == "way" and m.get("role") == "inner"])
    out = [[o] for o in outer]
    for h in inner:
        for p in out:
            if in_ring(h[0][0], h[0][1], p[0]):
                p.append(h)
                break
    return out


def bbox_of(polys) -> tuple:
    xs = [x for p in polys for x, _ in p[0]]
    ys = [y for p in polys for _, y in p[0]]
    return (min(xs), min(ys), max(xs), max(ys))


# ============================================================================= classify
NORM_DROP = re.compile(r"\b(provincial|regional|national|historic|site|park|parks|reserve|ecological|protected|area|the|of|and|marine)\b")
norm = lambda s: re.sub(r"\s+", " ", NORM_DROP.sub(" ", re.sub(r"[^a-z0-9 ]", " ", (s or "").lower()))).strip()


def nice_bc(name: str) -> str:
    """BC's upper-case names → title case; words with non-ASCII letters (SENĆOŦEN names) stay as written"""
    def w(t):
        if not t.isascii():
            return t
        return t.capitalize() if t.isalpha() and len(t) > 2 or t.lower() not in ("of", "and") else t.lower()
    return " ".join(w(t) for t in name.split(" "))


def cls_of(t: dict) -> str | None:
    op = " ".join(t.get(k, "") for k in ("operator", "owner", "operator:en")).lower()
    name = t.get("name", "")
    if "parks canada" in op or t.get("boundary") == "national_park" or re.search(r"National (Historic Site|Park)", name):
        return "national"
    if "bc parks" in op or "province of british columbia" in op or re.search(r"Provincial Park|Ecological Reserve", name):
        return "provincial"
    if "capital regional district" in op or re.search(r"\bCRD\b", t.get("operator", "")) or re.search(r"Regional (Park|Trail)", name):
        return "regional"
    if t.get("leisure") in ("park", "nature_reserve"):
        return "municipal"
    return None   # a protected area that isn't a park (bird sanctuaries, watersheds, conservation covenants)


DOG = {"no": "No dogs", "leashed": "Dogs on leash", "yes": "Dogs allowed", "unleashed": "Dogs off leash"}


def build(key: str, reg: dict) -> dict:
    bbox = reg["bbox"]
    bc = fetch_bc(key, bbox)
    # OSM: the city extract where it reaches, Overpass for the rest of the region (Sooke, the Juan de Fuca coast, the islands)
    pbf = osm_pbf.download(reg["pbf"], PBF, max_age_days=30)
    import osmium
    hb = osmium.io.Reader(str(pbf), osmium.osm.osm_entity_bits.NOTHING).header().box()
    inner = (hb.bottom_left.lat, hb.bottom_left.lon, hb.top_right.lat, hb.top_right.lon)
    osm = read_pbf(pbf, bbox)
    els, gaps = fetch_overpass(key, strips(bbox, inner))
    ov = from_overpass(els)
    for k in ("parks", "trails", "pois"):
        osm[k].update(ov[k])   # Overpass geometry is never clipped at the extract's edge, so it wins
    print(f"  {key}: {len(bc['features'])} BC features; OSM {len(osm['parks'])} parks, {len(osm['trails'])} paths, {len(osm['pois'])} facilities"
          f"{f'; {len(gaps)} Overpass tiles missing' if gaps else ''}", flush=True)

    parks: dict[str, dict] = {}
    # ---- provincial: BC's own boundaries
    for f in bc["features"]:
        p, gm = f["properties"], f.get("geometry")
        if not gm:
            continue
        polys = [[ring for ring in poly] for poly in (gm["coordinates"] if gm["type"] == "MultiPolygon" else [gm["coordinates"]])]
        des = (p.get("PROTECTED_LANDS_DESIGNATION") or "").title()
        pid = f"bc-{p['ORCS_PRIMARY']}"
        parks[pid] = {"id": pid, "name": nice_bc(p["PROTECTED_LANDS_NAME"]), "cls": "provincial", "des": des, "orcs": p["ORCS_PRIMARY"], "polys": polys,
                      "op": "BC Parks", "src": "bc", "tags": {}}
    bc_norm = {norm(v["name"]): k for k, v in parks.items()}

    # ---- OSM parks, merged by class and name (a park often has a leisure=park way and a protected_area relation)
    by_name: dict[tuple, str] = {}
    for ok, (t, polys) in osm["parks"].items():
        if t.get("access") in ("private", "no") or not t.get("name"):
            continue
        c = cls_of(t)
        if not c:
            continue
        nm = norm(t["name"])
        if c == "provincial" or nm in bc_norm:
            k = bc_norm.get(nm)
            if k:   # BC's geometry, OSM's spelling and tags
                parks[k]["name"] = t["name"] if t["name"].isascii() or not parks[k]["name"].isascii() else parks[k]["name"]
                parks[k]["tags"] = {**t, **parks[k]["tags"]}
            continue   # provincial land is BC's layer only
        area = sum(ring_area_m2(p[0]) for p in polys)
        k = by_name.get((c, nm))
        if k and area <= parks[k]["area"]:
            parks[k]["tags"] = {**t, **parks[k]["tags"]}
            continue
        pid = f"osm-{ok}"
        if k:
            old = parks.pop(k)
            t = {**old["tags"], **t}
        by_name[(c, nm)] = pid
        parks[pid] = {"id": pid, "name": t["name"], "cls": c, "polys": polys, "area": area, "tags": t, "src": "osm",
                      "op": t.get("operator") or ("Parks Canada" if c == "national" else "Capital Regional District" if c == "regional" else "")}
    for p in parks.values():
        p["area"] = sum(ring_area_m2(q[0]) - sum(ring_area_m2(h) for h in q[1:]) for q in p["polys"])
        p["bb"] = bbox_of(p["polys"])
    small = [k for k, p in parks.items() if p["cls"] == "municipal" and p["area"] < 3000]
    for k in small:
        parks.pop(k)
    order = sorted(parks.values(), key=lambda p: p["area"])   # smallest first: a point goes to the most specific park

    G = 0.02   # a coarse grid so each point only tests the parks whose box covers its cell
    grid: dict[tuple, list] = {}
    for p in order:
        b = p["bb"]
        for i in range(int(b[0] // G), int(b[2] // G) + 1):
            for j in range(int(b[1] // G), int(b[3] // G) + 1):
                grid.setdefault((i, j), []).append(p)

    def park_at(x, y):
        for p in grid.get((int(x // G), int(y // G)), ()):
            b = p["bb"]
            if b[0] <= x <= b[2] and b[1] <= y <= b[3] and in_poly(x, y, p["polys"]):
                return p
        return None

    def park_near(x, y, m=150):
        """inside, or within ~m of a park's outline (beaches often sit just outside the boundary)"""
        p = park_at(x, y)
        if p:
            return p
        kx, ky = kxy(y)
        dx, dy = m / kx, m / ky
        for p in order:
            b = p["bb"]
            if not (b[0] - dx <= x <= b[2] + dx and b[1] - dy <= y <= b[3] + dy):
                continue
            for q in p["polys"]:
                a = np.asarray(q[0])
                if np.min(np.hypot((a[:, 0] - x) * kx, (a[:, 1] - y) * ky)) <= m:
                    return p
        return None

    # ---- trails
    for p in parks.values():
        p.update(km=0.0, trails={}, acts=set(), pois={})
    for t, g in osm["trails"].values():
        mx, my = g[len(g) // 2]
        p = park_at(mx, my)
        if not p:
            continue
        L = length_m(g)
        p["km"] += L / 1000
        hw, sac, mtb = t["highway"], t.get("sac_scale", ""), t.get("mtb:scale", "")
        bike = hw == "cycleway" or t.get("bicycle") in ("yes", "designated", "permissive") or bool(mtb)
        if bike:
            p["acts"].add("bike")
        if mtb:
            p["acts"].add("mtb")
        if hw == "bridleway" or t.get("horse") in ("yes", "designated"):
            p["acts"].add("horse")
        if sac and sac != "hiking":
            p["acts"].add("hike")
        if not t.get("name") or hw == "steps":
            continue
        tr = p["trails"].setdefault(t["name"], {"n": t["name"], "m": 0.0, "sac": [], "mtb": [], "bike": False, "surf": {}, "g": []})
        tr["m"] += L
        if sac:
            tr["sac"].append(sac)
        if mtb:
            tr["mtb"].append(mtb)
        tr["bike"] = tr["bike"] or bike
        s = t.get("surface") or ("gravel" if hw == "track" else "")
        if s:
            tr["surf"][s] = tr["surf"].get(s, 0) + L
        tr["g"].append(g)

    # ---- facilities → what to do there
    POI = [("natural", "beach", "swim"), ("leisure", "swimming_area", "swim"), ("tourism", "camp_site", "camp"), ("leisure", "dog_park", "dogpark"),
           ("tourism", "picnic_site", "picnic"), ("leisure", "picnic_table", "picnic"), ("tourism", "viewpoint", "view"), ("natural", "peak", "view"),
           ("leisure", "slipway", "paddle"), ("leisure", "fishing", "fish"), ("leisure", "playground", "play"), ("waterway", "waterfall", "falls"),
           ("amenity", "toilets", "toilets")]
    for t, lon, lat in osm["pois"].values():
        hit = next((a for k, v, a in POI if t.get(k) == v), None)
        if not hit:
            continue
        p = park_near(lon, lat) if hit in ("swim", "view") else park_at(lon, lat)
        if not p:
            continue
        p["acts"].add(hit)
        if hit == "view" and t.get("natural") == "peak" and t.get("name"):
            p["pois"].setdefault("peaks", []).append(t["name"] + (f" ({int(float(t['ele']))} m)" if re.match(r"^\d+(\.\d+)?$", t.get("ele", "")) else ""))
        if hit == "swim" and t.get("name"):
            p["pois"].setdefault("beaches", []).append(t["name"])
        if hit == "falls" and t.get("name"):
            p["pois"].setdefault("falls", []).append(t["name"])

    # ---- output
    DIFF = {"hiking": "easy", "mountain_hiking": "moderate"}
    out_parks, feats = {}, []
    for p in sorted(parks.values(), key=lambda p: -p["area"]):
        if p["km"] >= 0.3:
            p["acts"].add("walk")
        if p["km"] >= 4 and p["cls"] in ("provincial", "regional", "national"):
            p["acts"].add("hike")
        trails = []
        for tr in sorted(p["trails"].values(), key=lambda x: -x["m"]):
            if tr["m"] < 200 or len(trails) >= 8:
                continue
            sac = max(tr["sac"], key=lambda s: ["hiking", "mountain_hiking", "demanding_mountain_hiking", "alpine_hiking"].index(s)
                      if s in ("hiking", "mountain_hiking", "demanding_mountain_hiking", "alpine_hiking") else -1, default="")
            mtb = max(tr["mtb"], key=lambda s: int(s[0]) if s[:1].isdigit() else -1, default="")
            diff = DIFF.get(sac, "hard" if sac else "")
            if not diff and mtb[:1].isdigit():
                diff = "easy" if int(mtb[0]) <= 1 else "moderate" if int(mtb[0]) == 2 else "hard"
            surf = max(tr["surf"], key=tr["surf"].get) if tr["surf"] else ""
            trails.append({"n": tr["n"], "km": round(tr["m"] / 1000, 2), "d": diff, "sac": sac, "mtb": mtb, "bike": tr["bike"], "surf": surf,
                           "g": [s for s in (simplify(g, 6) for g in tr["g"]) if len(s) >= 2]})
        t = p["tags"]
        tol = min(40, max(4, math.sqrt(max(p["area"], 1)) / 300))
        polys = []
        for q in p["polys"]:
            o = simplify(q[0], tol, ring=True)
            if not o:
                continue
            polys.append([o] + [h for h in (simplify(h, tol, ring=True) for h in q[1:]) if h])
        if not polys:
            continue
        x0, y0, x1, y1 = p["bb"]
        dog = DOG.get(t.get("dog", ""), "")
        if "dogpark" in p["acts"]:
            dog = "Off-leash dog area"
        rec = {"name": p["name"], "cls": p["cls"], "op": p["op"], "ha": round(p["area"] / 1e4, 1), "c": [round((x0 + x1) / 2, 5), round((y0 + y1) / 2, 5)],
               "acts": sorted(p["acts"]), "km": round(p["km"], 1), "trails": trails, **({"dog": dog} if dog else {}), **{k: v[:4] for k, v in p["pois"].items()}}
        for k in ("website", "url"):
            if t.get(k, "").startswith("http"):
                rec["web"] = t[k]
                break
        if p.get("orcs"):
            rec["orcs"] = p["orcs"]
            rec["des"] = p.get("des", "")
        out_parks[p["id"]] = rec
        feats.append({"type": "Feature", "id": len(feats) + 1, "properties": {"id": p["id"], "label": p["name"], "cls": p["cls"]},
                      "geometry": {"type": "MultiPolygon", "coordinates": polys}})
    n = {c: sum(1 for p in out_parks.values() if p["cls"] == c) for c in ("national", "provincial", "regional", "municipal")}
    print(f"  {key}: {len(out_parks)} parks {n}", flush=True)
    return {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "region": key, "name": reg["name"], "bbox": bbox, "counts": n, "gaps": gaps,
            "sources": [["BC Parks, ecological reserves and protected areas", "BC Data Catalogue (WHSE_TANTALIS.TA_PARK_ECORES_PA_SVW)", "Open Government Licence – British Columbia"],
                        ["National, regional and municipal parks, trails, facilities", "OpenStreetMap via the Overpass API", "© OpenStreetMap contributors, ODbL"]],
            "parks": out_parks, "geo": {"type": "FeatureCollection", "features": feats}}


# ============================================================================= surf spots
# Known public breaks (approximate beach points; facing = the compass direction the beach looks out to, for the swell window).
# Sources: the parks' own pages (BC Parks: Juan de Fuca, Pacific Rim National Park Reserve: Parks Canada) and OSM where tagged.
SURF_HAND = [
    {"id": "jordan-river", "name": "Jordan River", "ll": [-124.054, 48.421], "facing": 240, "area": "Juan de Fuca", "src": "CRD Jordan River Regional Park (crd.ca)"},
    {"id": "sombrio", "name": "Sombrio Beach", "ll": [-124.290, 48.498], "facing": 235, "area": "Juan de Fuca", "src": "BC Parks, Juan de Fuca Provincial Park"},
    {"id": "french-beach", "name": "French Beach", "ll": [-123.941, 48.390], "facing": 225, "area": "Juan de Fuca", "src": "BC Parks, French Beach Provincial Park"},
    {"id": "chesterman", "name": "Chesterman Beach", "ll": [-125.881, 49.118], "facing": 240, "area": "Tofino", "src": "District of Tofino"},
    {"id": "cox-bay", "name": "Cox Bay", "ll": [-125.873, 49.100], "facing": 225, "area": "Tofino", "src": "Pacific Rim National Park Reserve (Parks Canada)"},
    {"id": "long-beach", "name": "Long Beach", "ll": [-125.765, 49.050], "facing": 215, "area": "Pacific Rim", "src": "Pacific Rim National Park Reserve (Parks Canada)"},
    {"id": "wickaninnish", "name": "Wickaninnish Beach", "ll": [-125.698, 49.016], "facing": 205, "area": "Pacific Rim", "src": "Pacific Rim National Park Reserve (Parks Canada)"},
    {"id": "florencia", "name": "Florencia Bay", "ll": [-125.640, 48.980], "facing": 200, "area": "Ucluelet", "src": "Pacific Rim National Park Reserve (Parks Canada)"},
]


def surf() -> dict:
    spots = [dict(s) for s in SURF_HAND]
    for el in fetch_surf():
        t = el.get("tags", {})
        c = el.get("center") or ({"lon": el["lon"], "lat": el["lat"]} if "lon" in el else None)
        if not c or not t.get("name"):
            continue
        ll = [round(c["lon"], 4), round(c["lat"], 4)]
        near = next((s for s in spots if abs(s["ll"][0] - ll[0]) < 0.02 and abs(s["ll"][1] - ll[1]) < 0.015), None)
        if near:
            near["osm"] = f"{el['type']}/{el['id']}"
            continue
        spots.append({"id": re.sub(r"[^a-z0-9]+", "-", t["name"].lower()).strip("-"), "name": t["name"], "ll": ll, "facing": None, "area": "", "src": "OpenStreetMap", "osm": f"{el['type']}/{el['id']}"})
    for s in spots:   # the marine model's point: ~3 km out from the beach, along the way it faces (the model is ocean cells only)
        f = s["facing"] if s["facing"] is not None else 220
        kx, ky = kxy(s["ll"][1])
        s["sea"] = [round(s["ll"][0] + 3000 * math.sin(math.radians(f)) / kx, 4), round(s["ll"][1] + 3000 * math.cos(math.radians(f)) / ky, 4)]
    print(f"  surf: {len(spots)} spots ({sum(1 for s in spots if 'osm' in s)} with an OSM feature)", flush=True)
    return {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "spots": spots,
            "sources": [["Spot list", "OpenStreetMap sport=surfing (ODbL) and the parks' own pages", ""],
                        ["Waves (live, in the browser)", "Open-Meteo Marine API", "CC BY 4.0"]]}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for key, reg in REGIONS.items():
        d = build(key, reg)
        f = OUT / f"parks_{key}.json"
        f.write_text(json.dumps(d, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        print(f"  wrote {f.relative_to(ROOT)} ({f.stat().st_size / 1e3:,.0f} kB)", flush=True)
    s = surf()
    f = OUT / "surf_spots.json"
    f.write_text(json.dumps(s, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"  wrote {f.relative_to(ROOT)}", flush=True)


if __name__ == "__main__":
    main()
