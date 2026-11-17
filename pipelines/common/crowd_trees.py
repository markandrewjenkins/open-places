"""Tree points from outside the open municipal inventories, for Greater Victoria's blossom and foliage maps.

- District of Saanich "Significant Trees" (map.saanich.ca, SaanichMapService_External layer 21): 138 notable trees with
  species. The layer states no licence (Saanich's data licence covers only its open data catalogue), so every tree is
  labelled "no licence stated", as Esquimalt's inventory is.
- iNaturalist observations as reported trees: verifiable (research grade or needs ID) records, open location (not obscured
  or private), positional accuracy within 50 m, licensed CC0, CC BY or CC BY-NC (each credited to its observer). Cultivated
  street trees are "casual" on iNaturalist; those casual only for being captive / cultivated, with a photo and a date, are
  added too, marked as an unverified ID. Repeat observations of one tree (same taxon
  within 10 m) collapse to one point. Shrubby taxa in the tree genera are left out (SHRUBS). API: ~1 request a second, no key (https://api.inaturalist.org/v1/docs/).

Checked and not used: OpenTreeMap (no Greater Victoria instance), Falling Fruit (community data CC BY-NC-SA by default, and
the API needs a key), City of Langford layers (excluded), Colwood/Langford/Sidney LiDAR tree points (no species).
"""
from __future__ import annotations

import json
import math
from pathlib import Path

from .http import get_json

SAANICH_SIG = "https://map.saanich.ca/server/rest/services/MAPS/SaanichMapService_External/MapServer/21/query"
INAT_OBS = "https://api.inaturalist.org/v1/observations"
CRD_BOX = {"swlat": 48.30, "swlng": -123.80, "nelat": 48.75, "nelng": -123.20}
LICENCES = {"cc0": "CC0", "cc-by": "CC BY", "cc-by-nc": "CC BY-NC"}
# shrubs and shrub-like taxa in the tree genera (red-osier dogwood, shrub willows, Sitka alder, saskatoon), and genus-only
# records of genera that are mostly shrubs here: not tree points
SHRUBS = {"Cornus", "Cornus sericea", "Cornus sericea occidentalis", "Cornus alba", "Cornus sanguinea", "Cornus unalaschkensis", "Cornus canadensis",
          "Salix", "Salix hookeriana", "Salix sitchensis", "Salix geyeriana", "Salix exigua", "Alnus alnobetula", "Alnus alnobetula sinuata",
          "Amelanchier", "Amelanchier alnifolia", "Amelanchier alnifolia semi-integrifolia", "Amelanchier cusickii"}


def saanich_significant() -> list[dict]:
    """[{id, lon, lat, botanical, common, street, address, dbh_cm}] (one request)."""
    d = get_json(SAANICH_SIG, {"where": "1=1", "outFields": "TAGID,LATINNAME,COMMONNAME,ADDRESS,DIAMETERINCM", "outSR": 4326, "f": "json",
                               "returnGeometry": "true"}, min_interval=3)
    out = []
    for f in d.get("features", []):
        a, g = f["attributes"], f.get("geometry") or {}
        if not g.get("x") or not a.get("LATINNAME"):
            continue
        addr = (a.get("ADDRESS") or "").strip().title()
        parts = addr.split()
        street = " ".join(parts[1:]) if parts and parts[0].replace("-", "").isdigit() else addr
        out.append({"id": f"saa-{a.get('TAGID')}", "lon": g["x"], "lat": g["y"], "botanical": a["LATINNAME"], "common": (a.get("COMMONNAME") or "").title(),
                    "street": street, "address": addr, "dbh_cm": a.get("DIAMETERINCM")})
    return out


def inat(taxon_ids: list[int], cache: Path, refresh: bool = False, casual: bool = False) -> list[dict]:
    """Every qualifying observation of the taxa in the CRD box, cached raw at `cache` (JSON list of API results).
    casual=True takes instead the casual records that are casual only for being captive / cultivated (planted trees):
    with a photo and a date, same location, accuracy and licence rules; their ids are unverified ("u" in ref)."""
    grade = {"quality_grade": "casual", "captive": "true", "photos": "true"} if casual else {"verifiable": "true"}
    if cache.exists() and not refresh:
        res = json.loads(cache.read_text(encoding="utf-8"))
    else:
        res, id_above = [], 0
        while True:
            d = get_json(INAT_OBS, {**CRD_BOX, "taxon_id": ",".join(map(str, taxon_ids)), **grade, "geoprivacy": "open",
                                    "taxon_geoprivacy": "open", "acc_below": 51, "license": ",".join(LICENCES), "per_page": 200,
                                    "order_by": "id", "order": "asc", "id_above": id_above}, min_interval=1.1, timeout=120)
            page = d.get("results", [])
            res += [{"id": o["id"], "taxon": (o.get("taxon") or {}).get("name"), "common": (o.get("taxon") or {}).get("preferred_common_name"),
                     "rank": (o.get("taxon") or {}).get("rank"), "location": o.get("location"), "acc": o.get("positional_accuracy"),
                     "obscured": o.get("obscured"), "geoprivacy": o.get("geoprivacy"), "taxon_geoprivacy": o.get("taxon_geoprivacy"),
                     "license": o.get("license_code"), "login": (o.get("user") or {}).get("login"), "observed_on": o.get("observed_on"),
                     "quality": o.get("quality_grade"), "captive": o.get("captive"), "photos": len(o.get("photos") or [])} for o in page]
            if len(page) < 200:
                break
            id_above = page[-1]["id"]
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(res), encoding="utf-8")
    out = []
    for o in res:
        if o.get("obscured") or (o.get("geoprivacy") or "open") != "open" or (o.get("taxon_geoprivacy") or "open") != "open":
            continue
        if o.get("license") not in LICENCES or not o.get("location") or o.get("acc") is None or o["acc"] > 50 or not o.get("taxon") or o["taxon"] in SHRUBS:
            continue
        if casual and not (o.get("quality") == "casual" and o.get("captive") and o.get("photos") and o.get("observed_on")):
            continue
        lat, lon = map(float, o["location"].split(","))
        out.append({"id": f"inat-{o['id']}", "obs": o["id"], "lon": lon, "lat": lat, "botanical": o["taxon"], "common": o.get("common") or "",
                    "street": "", "address": "", "login": o.get("login") or "", "licence": LICENCES[o["license"]], "date": o.get("observed_on") or "", "unverified": casual})
    return collapse(out)


def collapse(rows: list[dict], metres: float = 10.0) -> list[dict]:
    """One point per tree: repeat observations of the same taxon within `metres` keep the newest."""
    cell, keep, grid = metres / 111_000, [], {}
    for r in sorted(rows, key=lambda r: r.get("date") or "", reverse=True):
        cx, cy, k = int(r["lon"] // cell), int(r["lat"] // cell), math.cos(math.radians(r["lat"]))
        near = any(q["botanical"] == r["botanical"] and ((q["lon"] - r["lon"]) * k) ** 2 + (q["lat"] - r["lat"]) ** 2 < cell ** 2
                   for dx in (-1, 0, 1) for dy in (-1, 0, 1) for q in grid.get((cx + dx, cy + dy), ()))
        if not near:
            grid.setdefault((cx, cy), []).append(r)
            keep.append(r)
    return keep


def ref(r: dict) -> str:
    """compact provenance for a reported tree: 'obs id|observer login|licence', plus '|u' when the id is unverified (casual)"""
    return f"{r['obs']}|{r['login']}|{r['licence']}{'|u' if r.get('unverified') else ''}" if r.get("obs") else ""
