"""Single trees mapped in OpenStreetMap (natural=tree nodes) from a BBBike city extract, as a fallback where a
municipality publishes no open street-tree inventory.

Source: © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright). Only trees someone tagged
with a genus, species or taxon are useful here, and coverage depends on local mappers, so it is thin and uneven.
"""
from __future__ import annotations

import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PBF_DIR = ROOT / "data" / "osm"


def read(city: str = "Victoria", max_age_days: float = 30) -> list[dict]:
    """[{id, lon, lat, botanical, common, street, address}] for natural=tree nodes with a genus/species/taxon tag."""
    import osmium

    from . import osm_pbf
    pbf = osm_pbf.download(city, PBF_DIR, max_age_days=max_age_days)
    out = []

    class H(osmium.SimpleHandler):
        def node(self, n):
            t = n.tags
            if t.get("natural") != "tree" or not n.location.valid():
                return
            sp, genus = t.get("species") or t.get("taxon") or "", t.get("genus") or ""
            botanical = sp if sp and (not genus or sp.lower().startswith(genus.lower())) else " ".join(x for x in [genus, sp] if x)
            if not botanical:
                return
            street = t.get("addr:street") or ""
            out.append({"id": f"osm-n{n.id}", "lon": n.location.lon, "lat": n.location.lat, "botanical": botanical.strip(),
                        "common": t.get("species:en") or t.get("taxon:en") or t.get("name") or "", "street": street,
                        "address": " ".join(x for x in [t.get("addr:housenumber") or "", street] if x)})

    H().apply_file(str(pbf))
    return out


def far_from(rows: list[dict], lons, lats, metres: float = 25.0) -> list[dict]:
    """Drop OSM trees within `metres` of a tree already in a municipal inventory (the same tree, mapped twice)."""
    cell = metres / 111_000
    grid: dict[tuple[int, int], list[tuple[float, float]]] = {}
    for lo, la in zip(lons, lats):
        grid.setdefault((int(lo // cell), int(la // cell)), []).append((lo, la))
    keep = []
    for r in rows:
        cx, cy, k = int(r["lon"] // cell), int(r["lat"] // cell), math.cos(math.radians(r["lat"]))
        near = any(((r["lon"] - lo) * k) ** 2 + (r["lat"] - la) ** 2 < cell ** 2
                   for dx in (-1, 0, 1) for dy in (-1, 0, 1) for lo, la in grid.get((cx + dx, cy + dy), ()))
        if not near:
            keep.append(r)
    return keep
