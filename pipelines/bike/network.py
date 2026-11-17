"""Greater Victoria's bike network from OpenStreetMap (ODbL), classified for the Open Places Biking map.

  python -m pipelines.bike.network          # → site/public/data/bike/crd.json (built once; rerun to refresh)

Overpass, tiled and cached (pipelines/common/osm.py: one tile every few seconds, cached under data/bike/raw). Classes, first
match wins:
  trail      the regional multi-use trails by name (Galloping Goose, Lochside, E&N Rail Trail) and other shared-use paths
             (highway=path/footway/cycleway with bicycle=designated and foot=designated|yes)
  protected  separated bike lanes: highway=cycleway, cycleway[:left|:right|:both]=track / opposite_track
  painted    painted bike lanes on the road: cycleway[:side]=lane / opposite_lane
  shared     shared or quiet routes: cycleway[:side]=shared_lane / share_busway, bicycle_road / cyclestreet=yes, and the
             streets of local or regional bike routes (route=bicycle relations, lcn/rcn) not already in a class above
Points: amenity=bicycle_parking (capacity, covered) and amenity=bicycle_repair_station. Lines are simplified to ~4 m and
rounded to 5 decimals (~1 m). Attribution: © OpenStreetMap contributors, ODbL 1.0.
"""
from __future__ import annotations

import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from pipelines.common.osm import fetch_tiled

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "site" / "public" / "data" / "bike"
CACHE = ROOT / "data" / "bike" / "raw"
BBOX = (48.30, -123.80, 48.72, -123.25)          # south, west, north, east: Sooke to Sidney, Metchosin to Oak Bay

LANE = r"^(lane|opposite_lane)$"
TRACK = r"^(track|opposite_track)$"
SHARE = r"^(shared_lane|share_busway|opposite_share_busway)$"
SIDES = ["cycleway", "cycleway:left", "cycleway:right", "cycleway:both"]
WAYS = "".join([
    'way["highway"="cycleway"]({bbox});',
    *[f'way["{k}"~"^(lane|opposite_lane|track|opposite_track|shared_lane|share_busway|opposite_share_busway)$"]({{bbox}});' for k in SIDES],
    'way["highway"~"^(path|footway|track|bridleway|pedestrian)$"]["bicycle"="designated"]({bbox});',
    'way["bicycle_road"="yes"]({bbox});', 'way["cyclestreet"="yes"]({bbox});',
    'way["name"~"Galloping Goose|Lochside|E&N|E & N"]["highway"]({bbox});',
    'node["amenity"~"^(bicycle_parking|bicycle_repair_station)$"]({bbox});',
    'way["amenity"="bicycle_parking"]({bbox});',
])
RELS = 'relation["route"="bicycle"]({bbox});'
TRAIL_NAME = re.compile(r"Galloping Goose|Lochside|E ?& ?N|Rail Trail", re.I)
SKIP_HW = {"construction", "proposed", "abandoned", "platform", "steps", "corridor"}


def tag_is(t: dict, rx: str) -> bool:
    return any(re.match(rx, t.get(k, "")) for k in SIDES)


def classify(t: dict, in_route: bool) -> str | None:
    hw = t.get("highway", "")
    if not hw or hw in SKIP_HW or t.get("access") in ("private", "no") or t.get("bicycle") in ("no", "dismount"):
        return None
    pathy = hw in ("path", "footway", "cycleway", "track", "bridleway", "pedestrian")
    if pathy and TRAIL_NAME.search(t.get("name", "")):
        return "trail"
    if pathy and t.get("bicycle") == "designated" and t.get("foot") in ("designated", "yes") and t.get("segregated") != "yes" and hw != "cycleway":
        return "trail"
    if hw == "cycleway" and t.get("foot") in ("designated", "yes") and t.get("segregated") == "no":
        return "trail"
    if hw == "cycleway" or tag_is(t, TRACK):
        return "protected"
    if tag_is(t, LANE):
        return "painted"
    if tag_is(t, SHARE) or t.get("bicycle_road") == "yes" or t.get("cyclestreet") == "yes":
        return "shared"
    if pathy and t.get("bicycle") == "designated":
        return "trail"
    if in_route and hw not in ("motorway", "motorway_link", "trunk_link", "footway", "steps"):
        return "shared"
    return None


def simplify(pts: list[tuple[float, float]], tol: float = 4.0) -> list[tuple[float, float]]:
    """Douglas–Peucker in local metres."""
    if len(pts) < 3:
        return pts
    kx = 111320 * math.cos(math.radians(48.45)); ky = 110540
    xy = [(p[0] * kx, p[1] * ky) for p in pts]
    keep = [False] * len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        (ax, ay), (bx, by) = xy[a], xy[b]
        L = math.hypot(bx - ax, by - ay) or 1e-9
        best, k = -1.0, a
        for i in range(a + 1, b):
            d = abs((by - ay) * (xy[i][0] - ax) - (bx - ax) * (xy[i][1] - ay)) / L
            if d > best:
                best, k = d, i
        if best > tol:
            keep[k] = True; stack += [(a, k), (k, b)]
    return [p for p, f in zip(pts, keep) if f]


def length_km(pts) -> float:
    kx = 111.32 * math.cos(math.radians(48.45)); ky = 110.54
    return sum(math.hypot((pts[i][0] - pts[i - 1][0]) * kx, (pts[i][1] - pts[i - 1][1]) * ky) for i in range(1, len(pts)))


def main() -> int:
    print("bike network (Overpass, tiled)…", flush=True)
    data = fetch_tiled(WAYS, BBOX, CACHE / "ways", out="geom", recurse=False)
    rels = fetch_tiled(RELS, BBOX, CACHE / "rels", out="body", recurse=False)
    route_ways = {m["ref"] for r in rels["elements"] if r["type"] == "relation" and r.get("tags", {}).get("network") in ("lcn", "rcn", "ncn")
                  for m in r.get("members", []) if m["type"] == "way"}
    # the route streets themselves (ways in those relations that the first query didn't bring): one more tiled pass
    have = {e["id"] for e in data["elements"] if e["type"] == "way"}
    missing = sorted(route_ways - have)
    if missing:
        extra = fetch_tiled("way(id:" + ",".join(map(str, missing)) + ")({bbox});", BBOX, CACHE / f"route_{len(missing)}", out="geom", recurse=False)
        data["elements"] += extra["elements"]
    lines, parking, repair, km = [], [], [], {}
    seen = set()
    for e in data["elements"]:
        t = e.get("tags", {})
        if e["type"] == "node":
            ll = (round(e["lon"], 5), round(e["lat"], 5))
            if t.get("amenity") == "bicycle_parking":
                parking.append([*ll, int(t["capacity"]) if str(t.get("capacity", "")).isdigit() else None, 1 if t.get("covered") == "yes" else 0])
            elif t.get("amenity") == "bicycle_repair_station":
                repair.append([*ll, t.get("name") or t.get("operator") or ""])
            continue
        if e["type"] != "way" or e["id"] in seen or not e.get("geometry"):
            continue
        seen.add(e["id"])
        if t.get("amenity") == "bicycle_parking":
            g = e["geometry"]
            parking.append([round(sum(p["lon"] for p in g) / len(g), 5), round(sum(p["lat"] for p in g) / len(g), 5),
                            int(t["capacity"]) if str(t.get("capacity", "")).isdigit() else None, 1 if t.get("covered") == "yes" else 0])
            continue
        c = classify(t, e["id"] in route_ways)
        if not c:
            continue
        pts = simplify([(p["lon"], p["lat"]) for p in e["geometry"]])
        pts = [(round(x, 5), round(y, 5)) for x, y in pts]
        if len(pts) < 2:
            continue
        km[c] = km.get(c, 0) + length_km(pts)
        lines.append({"c": c, "n": t.get("name", ""), "g": pts, **({"s": t["surface"]} if t.get("surface") else {})})
    lines.sort(key=lambda x: ["shared", "painted", "protected", "trail"].index(x["c"]))   # draw order: trails on top
    lons = [p[0] for x in lines for p in x["g"]]; lats = [p[1] for x in lines for p in x["g"]]
    doc = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "about": "Greater Victoria's bike network from OpenStreetMap, classified as multi-use trails, protected (separated) lanes, "
                 "painted lanes and shared or quiet routes; bike parking and repair stations. Built by pipelines/bike/network.py.",
        "credit": "© OpenStreetMap contributors (ODbL 1.0)",
        "bbox": [min(lons), min(lats), max(lons), max(lats)] if lines else None,
        "km": {k: round(v, 1) for k, v in km.items()},
        "lines": lines, "parking": parking, "repair": repair,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    f = OUT / "crd.json"
    f.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    print(f"  {len(lines)} ways ({', '.join(f'{k} {v:.0f} km' for k, v in sorted(km.items()))}), {len(parking)} parking, {len(repair)} repair stations;"
          f" wrote {f.relative_to(ROOT)} ({f.stat().st_size / 1024:,.0f} KB)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
