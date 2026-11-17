"""Culture venues and farmers' markets for the Open Places Events page (Lifestyle).

  python -m pipelines.events.build

Writes site/public/data/events/culture_<region>.json from the BBBike city extract already on disk for Sunday Wander,
Golf and Parks & Trails (data/osm/<city>.osm.pbf, downloaded by pipelines/common/osm_pbf.py when missing or old).

Source: OpenStreetMap (© OpenStreetMap contributors, ODbL).
  - Farmers' markets: amenity=marketplace (name, opening_hours, website). Schedules only where someone has mapped them.
  - Venues: amenity=theatre / arts_centre / cinema / library / events_venue / music_venue / concert_hall and
    tourism=museum / gallery. Private or closed places (access=private, disused:*, abandoned:*) are left out.

No event dates: every Greater Victoria event calendar we found (City of Victoria CityVibe, Langford, Saanich, Oak Bay, the
library, the Royal BC Museum, the Art Gallery, Tourism Victoria) is published under "all rights reserved" terms, so the page
links to them instead (marked PLANNED until one is published under an open licence).
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from pipelines.common import osm_pbf

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "site" / "public" / "data" / "events"
PBF = ROOT / "data" / "osm"
REGIONS = {"crd": {"name": "Greater Victoria", "pbf": "Victoria"}}

KINDS = {   # (key, value) → kind
    ("amenity", "marketplace"): "market",
    ("amenity", "theatre"): "theatre", ("amenity", "concert_hall"): "music", ("amenity", "music_venue"): "music",
    ("amenity", "arts_centre"): "arts", ("amenity", "events_venue"): "venue", ("amenity", "cinema"): "cinema",
    ("amenity", "library"): "library", ("tourism", "museum"): "museum", ("tourism", "gallery"): "gallery",
}


def kind_of(t) -> str | None:
    for (k, v), kind in KINDS.items():
        if t.get(k) == v:
            return kind
    return None


def read(path: Path) -> list[dict]:
    import osmium
    out: dict[str, dict] = {}

    def keep(t, ll, oid):
        kind = kind_of(t)
        if not kind or not t.get("name") or t.get("access") in ("private", "no"):
            return
        if kind == "library" and t.get("library") in ("booksharing", "little_free_library") or t.get("amenity") == "public_bookcase":
            return
        p = {"id": oid, "k": kind, "n": t.get("name"), "ll": [round(ll[0], 5), round(ll[1], 5)]}
        for src, dst in (("opening_hours", "oh"), ("website", "web"), ("contact:website", "web"), ("operator", "op"), ("addr:street", "st"), ("addr:housenumber", "no")):
            if t.get(src) and dst not in p:
                p[dst] = t.get(src)
        if kind == "market" and t.get("produce") or t.get("organic"):
            p["farm"] = 1
        out[oid] = p

    class H(osmium.SimpleHandler):
        def node(self, n):
            if n.tags and n.location.valid() and kind_of(n.tags):
                keep(dict(n.tags), (n.location.lon, n.location.lat), f"n{n.id}")

        def area(self, a):
            if not kind_of(a.tags):
                return
            pts = [(nd.lon, nd.lat) for ring in a.outer_rings() for nd in ring if nd.location.valid()]
            if pts:
                keep(dict(a.tags), (sum(x for x, _ in pts) / len(pts), sum(y for _, y in pts) / len(pts)), ("w" if a.from_way() else "r") + str(a.orig_id()))

    H().apply_file(str(path), locations=True)
    # a venue mapped as a node inside its own building outline: keep one (same name and kind within ~80 m)
    seen, rows = {}, []
    for p in sorted(out.values(), key=lambda p: p["id"]):
        key = (p["k"], p["n"].lower(), round(p["ll"][0] * 80), round(p["ll"][1] * 110))
        if key in seen:
            continue
        seen[key] = 1
        rows.append(p)
    return rows


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for key, reg in REGIONS.items():
        pbf = osm_pbf.download(reg["pbf"], PBF, max_age_days=30)
        rows = read(pbf)
        counts = {}
        for r in rows:
            counts[r["k"]] = counts.get(r["k"], 0) + 1
        d = {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "region": key, "name": reg["name"], "counts": counts, "places": rows,
             "sources": [{"name": "OpenStreetMap", "licence": "ODbL 1.0", "url": "https://www.openstreetmap.org/copyright"}]}
        f = OUT / f"culture_{key}.json"
        f.write_text(json.dumps(d, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        print(f"  {key}: {len(rows)} places {counts} → {f.relative_to(ROOT)} ({f.stat().st_size / 1e3:,.0f} kB)", flush=True)


if __name__ == "__main__":
    main()
