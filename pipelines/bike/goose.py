"""The Galloping Goose Regional Trail for Open Places' Galloping Goose inset (Biking): the trail end to end, km markers,
segments with surfaces, access / parking / washrooms / repair stations along it, its Lochside and E&N junctions, and an
elevation profile.

  python -m pipelines.bike.goose          # → site/public/data/bike/goose.json (after pipelines.bike.network)

Sources, all cached under data/bike/raw (rerun reuses them):
  * the trail: OpenStreetMap route relation 2202881 ("Galloping Goose Regional Trail") and its member ways, from the bike
    network's Overpass cache (ways/, route_*/, rels/); chained from the Victoria end (Johnson Street Bridge) into one line
  * points along it (within 150 m): one Overpass query (amenity toilets / parking / bicycle_repair_station / drinking_water,
    highway=trailhead), cached as goose_pois.json
  * junctions: where the Lochside Regional Trail and the E&N Rail Trail (in site/public/data/bike/crd.json) meet it
  * elevation: Natural Resources Canada's CDEM elevation service (geogratis.gc.ca, no key, Open Government Licence –
    Canada), sampled every 250 m in a few polite requests, cached as goose_elev.json
© OpenStreetMap contributors (ODbL 1.0); elevation © NRCan (OGL – Canada).
"""
from __future__ import annotations

import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

from pipelines.common.http import USER_AGENT
from pipelines.common.osm import overpass

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "bike" / "raw"
NET = ROOT / "site" / "public" / "data" / "bike" / "crd.json"
OUT = ROOT / "site" / "public" / "data" / "bike" / "goose.json"
REL = 2202881
VIC_END = (-123.3722, 48.4284)          # the Johnson Street Bridge's west end, where the trail starts
KX, KY = 111.32 * math.cos(math.radians(48.43)), 110.54
PAVED = {"asphalt", "concrete", "paved", "concrete:plates", "paving_stones", "wood", "metal"}
GRAVEL = {"gravel", "fine_gravel", "compacted", "unpaved", "dirt", "ground", "pebblestone", "earth"}
# segment ends (the nearest trail point to each): Langford (Jacklin Rd area), Sooke (the trail's nearest point to the town)
SPLITS = [("Victoria", None), ("Langford", (-123.505, 48.449)), ("Sooke", (-123.726, 48.374)), ("Leechtown", None)]


def d_km(a, b):
    return math.hypot((a[0] - b[0]) * KX, (a[1] - b[1]) * KY)


def load(pattern: str):
    for f in RAW.glob(pattern):
        yield from json.loads(f.read_text(encoding="utf-8")).get("elements", [])


def trail_ways():
    G = {e["id"]: e for e in list(load("ways/*.json")) + list(load("route_*/*.json")) if e["type"] == "way" and e.get("geometry")}
    rel = max((e for e in load("rels/*.json") if e["type"] == "relation" and e["id"] == REL), key=lambda e: len(e.get("members", [])))
    ws = [G[m["ref"]] for m in rel["members"] if m["type"] == "way" and m["ref"] in G]
    print(f"  relation {REL}: {len(ws)} member ways with geometry", flush=True)
    return [{"id": w["id"], "pts": [(p["lon"], p["lat"]) for p in w["geometry"]], "tags": w.get("tags", {})} for w in ws]


def chain(ways):
    """the main line from the Victoria end: repeatedly take the unused way with an end nearest the current end (< 80 m);
    each point carries its way's surface"""
    left = list(ways)
    start = min(left, key=lambda w: min(d_km(w["pts"][0], VIC_END), d_km(w["pts"][-1], VIC_END)))
    if d_km(start["pts"][-1], VIC_END) < d_km(start["pts"][0], VIC_END):
        start["pts"] = start["pts"][::-1]
    line, surf = list(start["pts"]), [start["tags"].get("surface", "")] * len(start["pts"])
    left.remove(start)
    while left:
        end = line[-1]
        best = min(left, key=lambda w: min(d_km(w["pts"][0], end), d_km(w["pts"][-1], end)))
        a, b = d_km(best["pts"][0], end), d_km(best["pts"][-1], end)
        if min(a, b) > 0.08:
            break
        pts = best["pts"] if a <= b else best["pts"][::-1]
        line += pts[1:]; surf += [best["tags"].get("surface", "")] * (len(pts) - 1)
        left.remove(best)
    print(f"  chained {len(ways) - len(left)} ways; {len(left)} left over (side links, the other side of a divided stretch)", flush=True)
    return line, surf


def chainage(line):
    c = [0.0]
    for i in range(1, len(line)):
        c.append(c[-1] + d_km(line[i - 1], line[i]))
    return c


def at_km(line, C, k):
    i = next((j for j in range(1, len(C)) if C[j] >= k), len(C) - 1)
    t = (k - C[i - 1]) / ((C[i] - C[i - 1]) or 1)
    return (line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t)


def nearest(line, C, p):
    """(km along the trail, distance km) of the trail point nearest p (vertex-level, the line is dense enough)"""
    j = min(range(len(line)), key=lambda i: d_km(line[i], p))
    return C[j], d_km(line[j], p)


def thin(line, C, step=0.005):
    out, last = [], -1.0
    for p, c in zip(line, C):
        if c - last >= step or p is line[-1]:
            out.append([round(p[0], 5), round(p[1], 5)]); last = c
    return out


def pois(line, C):
    f = RAW / "goose_pois.json"
    if f.exists():
        data = json.loads(f.read_text(encoding="utf-8"))
    else:
        q = (f"[out:json][timeout:180];rel({REL});way(r)->.w;"
             '(nwr(around.w:150)["amenity"~"^(toilets|parking|bicycle_repair_station|drinking_water)$"];'
             'nwr(around.w:150)["highway"="trailhead"];);out center tags;')
        print("  points along the trail (Overpass, one query)…", flush=True)
        data = overpass(q)
        f.write_text(json.dumps(data), encoding="utf-8")
    out = []
    for e in data.get("elements", []):
        t = e.get("tags", {})
        ll = (e.get("lon") or e.get("center", {}).get("lon"), e.get("lat") or e.get("center", {}).get("lat"))
        if ll[0] is None or t.get("access") in ("private", "no", "customers"):
            continue
        a = t.get("amenity")
        k = "trailhead" if t.get("highway") == "trailhead" else {"toilets": "toilets", "parking": "parking", "bicycle_repair_station": "repair", "drinking_water": "water"}.get(a)
        if not k:
            continue
        km, d = nearest(line, C, ll)
        if d > 0.16 or (k == "parking" and d > 0.1):
            continue
        out.append({"k": k, "ll": [round(ll[0], 5), round(ll[1], 5)], "km": round(km, 1), "n": t.get("name") or "",
                    **({"fee": t["fee"]} if t.get("fee") else {}), **({"cap": t["capacity"]} if t.get("capacity") else {})})
    # parking: one per 600 m of trail (the nearest lots to the trail win)
    park, rest = [p for p in out if p["k"] == "parking"], [p for p in out if p["k"] != "parking"]
    keep = []
    for p in sorted(park, key=lambda p: (bool(not p["n"]), p["km"])):
        if all(abs(p["km"] - q["km"]) >= 0.6 for q in keep):
            keep.append(p)
    # one marker per kind per spot (a block of four toilets is one washroom)
    one = []
    for p in sorted(rest, key=lambda p: (not p["n"], p["km"])):
        if all(q["k"] != p["k"] or d_km(q["ll"], p["ll"]) > 0.15 for q in one):
            one.append(p)
    return sorted(one + keep, key=lambda p: p["km"])


def junctions(line, C):
    net = json.loads(NET.read_text(encoding="utf-8"))
    out = []
    for name, rx in (("Lochside Regional Trail", "Lochside"), ("E&N Rail Trail", "E&N")):
        best = None
        for l in net["lines"]:
            if rx not in (l.get("n") or ""):
                continue
            for p in l["g"]:
                km, d = nearest(line, C, p)
                if best is None or d < best[1]:
                    best = (km, d, p)
        if best and best[1] < 0.3:
            ll = at_km(line, C, best[0])
            out.append({"name": name, "km": round(best[0], 1), "ll": [round(ll[0], 5), round(ll[1], 5)]})
    return out


def elevation(line, C, step=0.25):
    f = RAW / "goose_elev.json"
    if f.exists():
        return json.loads(f.read_text(encoding="utf-8"))
    ks = [i * step for i in range(int(C[-1] / step) + 1)] + [C[-1]]
    pts = [at_km(line, C, k) for k in ks]
    alt = []
    S = requests.Session(); S.headers["User-Agent"] = USER_AGENT
    for i in range(0, len(pts), 60):
        part = pts[i:i + 60]
        path = "LINESTRING(" + ",".join(f"{x:.5f} {y:.5f}" for x, y in part) + ")"
        r = S.get("https://geogratis.gc.ca/services/elevation/cdem/profile", params={"path": path, "steps": 1}, timeout=120)
        r.raise_for_status()
        alt += [round(v["altitude"], 1) if v.get("altitude") is not None else None for v in r.json() if v.get("vertex")]
        time.sleep(3)
    if len(alt) != len(pts):
        print(f"  elevation: {len(alt)} heights for {len(pts)} points; left out", flush=True)
        return None
    doc = {"step_km": step, "km": [round(k, 2) for k in ks], "m": alt, "src": "NRCan CDEM (geogratis.gc.ca), Open Government Licence – Canada"}
    f.write_text(json.dumps(doc), encoding="utf-8")
    return doc


def buffer_ring(line, r_km=1.0, cell=0.04):
    """the outline of everything within r_km of the trail (the page's coverage), without shapely: rasterise the line on a
    40 m grid, take the distance transform, trace the outer edge of the d <= r mask (Moore neighbours), simplify (25 m)"""
    import numpy as np
    from scipy.ndimage import distance_transform_edt
    pad = r_km + 4 * cell
    x0, y0 = min(p[0] for p in line) - pad / KX, max(p[1] for p in line) + pad / KY
    W = int((max(p[0] for p in line) - min(p[0] for p in line)) * KX / cell + 2 * pad / cell) + 2
    H = int((max(p[1] for p in line) - min(p[1] for p in line)) * KY / cell + 2 * pad / cell) + 2
    occ = np.ones((H, W), bool)
    for a, b in zip(line, line[1:]):
        n = max(1, int(d_km(a, b) / (cell / 2)))
        for t in range(n + 1):
            x, y = a[0] + (b[0] - a[0]) * t / n, a[1] + (b[1] - a[1]) * t / n
            occ[int((y0 - y) * KY / cell), int((x - x0) * KX / cell)] = False
    m = distance_transform_edt(occ) * cell <= r_km
    m[0, :] = m[-1, :] = m[:, 0] = m[:, -1] = False
    D = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)]   # clockwise from north
    rs, cs = np.nonzero(m)
    start = (int(rs[0]), int(cs[0])); cur, back = start, 6          # entered from the west (background)
    ring = [start]
    for _ in range(4 * H * W):
        for k in range(1, 9):
            d = (back + k) % 8
            n = (cur[0] + D[d][0], cur[1] + D[d][1])
            if m[n]:
                p = (cur[0] + D[(d - 1) % 8][0], cur[1] + D[(d - 1) % 8][1])
                back = D.index((p[0] - n[0], p[1] - n[1])); cur = n
                break
        if cur == start:
            break
        ring.append(cur)
    pts = [(x0 + (c + 0.5) * cell / KX, y0 - (r + 0.5) * cell / KY) for r, c in ring]

    def dp(P, tol):
        if len(P) < 3:
            return P
        a, b = P[0], P[-1]
        ax, ay, bx, by = a[0] * KX, a[1] * KY, b[0] * KX, b[1] * KY
        L = math.hypot(bx - ax, by - ay) or 1e-9
        dist = [abs((bx - ax) * (ay - p[1] * KY) - (ax - p[0] * KX) * (by - ay)) / L for p in P[1:-1]]
        i = max(range(len(dist)), key=dist.__getitem__)
        if dist[i] <= tol:
            return [a, b]
        return dp(P[:i + 2], tol)[:-1] + dp(P[i + 1:], tol)
    sys.setrecursionlimit(20000)
    h = len(pts) // 2                       # split so the closed ring has two distinct ends
    out = dp(pts[:h + 1], 0.025)[:-1] + dp(pts[h:] + [pts[0]], 0.025)
    return [[round(x, 5), round(y, 5)] for x, y in out]


def segments(line, C, surf):
    cuts = [0.0] + [nearest(line, C, ll)[0] for _, ll in SPLITS[1:-1]] + [C[-1]]
    out = []
    for (a, b), (n0, _), (n1, _) in zip(zip(cuts, cuts[1:]), SPLITS, SPLITS[1:]):
        s = {"paved": 0.0, "gravel": 0.0, "unknown": 0.0}
        for i in range(1, len(line)):
            if a <= C[i] <= b:
                v = surf[i]
                s["paved" if v in PAVED else "gravel" if v in GRAVEL else "unknown"] += C[i] - C[i - 1]
        out.append({"name": f"{n0}–{n1}", "from": round(a, 1), "to": round(b, 1), "km": round(b - a, 1), "surface": {k: round(v, 1) for k, v in s.items()}})
    return out


def main() -> int:
    if not NET.exists():
        print("no bike network yet: run `python -m pipelines.bike.network` first", file=sys.stderr)
        return 1
    print("Galloping Goose…", flush=True)
    line, surf = chain(trail_ways())
    C = chainage(line)
    print(f"  {C[-1]:.1f} km from the Johnson Street Bridge to {line[-1][1]:.4f}, {line[-1][0]:.4f}", flush=True)
    marks = [[k, *[round(v, 5) for v in at_km(line, C, k)]] for k in range(5, int(C[-1]) + 1, 5)]
    P, J = pois(line, C), junctions(line, C)
    try:
        E = elevation(line, C)
    except Exception as e:      # an elevation hiccup never blocks the rest
        print(f"  elevation unavailable: {e}", flush=True); E = None
    xs = [p[0] for p in line]; ys = [p[1] for p in line]
    doc = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "about": "The Galloping Goose Regional Trail from OpenStreetMap (relation 2202881), chained from the Johnson Street Bridge; points within "
                 "150 m; elevation from NRCan's CDEM. Built by pipelines/bike/goose.py.",
        "credit": "© OpenStreetMap contributors (ODbL 1.0); elevation © Natural Resources Canada (Open Government Licence – Canada)",
        "len_km": round(C[-1], 1), "bbox": [min(xs), min(ys), max(xs), max(ys)],
        "line": thin(line, C), "markers": marks, "segments": segments(line, C, surf), "pois": P, "junctions": J, "profile": E,
        "buffer": buffer_ring(line),
    }
    OUT.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    from collections import Counter
    print(f"  {len(marks)} km markers, {dict(Counter(p['k'] for p in P))}, junctions {[(j['name'], j['km']) for j in J]}, "
          f"profile {'yes' if E else 'no'}; wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1024:,.0f} KB)", flush=True)
    for s in doc["segments"]:
        print(f"  {s['name']}: {s['km']} km {s['surface']}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
