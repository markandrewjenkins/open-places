"""Garry Oaks & Arbutus (Open Places, Nature, Greater Victoria): every mapped Garry oak and arbutus, the parks with the
most of them, Saanich's notable ones, Garry oak meadow / woodland polygons and the camas flowering calendar.

Sources (same rules as the blossom and foliage trees, pipelines/common/crowd_trees.py):
- City of Victoria tree inventory (Open Government Licence - Victoria); Township of Esquimalt tree inventory and District
  of Saanich significant trees (no licence stated)
- OpenStreetMap natural=tree points with species (ODbL), and its park polygons for Best Places
- iNaturalist: verifiable records, then casual ones that are casual only for being cultivated (with photo and date), open
  geoprivacy, accuracy 50 m or better, CC0 / CC BY / CC BY-NC, credited per observer; repeats within 10 m collapse
- BC Sensitive Ecosystems Inventory, East Vancouver Island and Gulf Islands, 2002 update (DataBC WFS, Open Government
  Licence - British Columbia): woodland (WD) and terrestrial herbaceous (HT) polygons, the classes that hold Garry oak
  woodlands and meadows. Areas from FEATURE_AREA_SQM (square metres).
- iNaturalist flowering annotations (Plant Phenology = Flowering) of camas (genus Camassia) by week of year, all years

  python -m pipelines.oaks.build [--refresh]      (raw caches in data/oaks/raw; output site/public/data/oaks/)
"""
from __future__ import annotations

import argparse
import json
import math
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from pipelines.common import crowd_trees, osm_pbf, osm_trees
from pipelines.common.http import get_json
from pipelines.foliage.fetch import ESQ_TREES, VIC_TREES, _arcgis, _num

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "oaks" / "raw"
OUT = ROOT / "site" / "public" / "data" / "oaks"
TAXA = {"oak": 68632, "arbutus": 51046}           # iNaturalist: Quercus garryana, Arbutus menziesii
CAMAS = 62219                                     # iNaturalist: genus Camassia
SPECIES = ["oak", "arbutus"]
SEI_WFS = "https://openmaps.gov.bc.ca/geo/pub/wfs"
SEI_LAYER = "pub:WHSE_TERRESTRIAL_ECOLOGY.STE_SEI_ATTRIBUTE_POLYS_SVW"
SEI_PROJECT = "SEI of East Vancouver Island And Gulf Islands 2002 Update"
BOX = (-123.80, 48.30, -123.20, 48.75)
SOURCES = {
    "victoria": ["City of Victoria tree inventory", "Open Government Licence – Victoria"],
    "esquimalt": ["Township of Esquimalt tree inventory", "no licence stated"],
    "saanich": ["District of Saanich significant trees", "no licence stated"],
    "osm": ["Tree mapped in OpenStreetMap", "ODbL 1.0"],
    "inat": ["Tree reported on iNaturalist", "CC0, CC BY or CC BY-NC, per observer"],
}
CITIES = list(SOURCES)
FACTS = [
    {"text": "Less than 5% of Garry oak ecosystems remain in near-natural condition; on Vancouver Island only 1.5% of the original deep-soil sites remain.",
     "src": "Garry Oak Ecosystems Recovery Team", "url": "https://goert.ca/about/what-remains/"},
    {"text": "More than 100 plants and animals of Garry oak ecosystems are officially listed as species at risk.",
     "src": "Garry Oak Ecosystems Recovery Team", "url": "https://goert.ca/about/species-at-risk/"},
    {"text": "Arbutus is the only broad-leaved evergreen tree species in British Columbia.",
     "src": "BC Ministry of Forests, Tree Species Compendium",
     "url": "https://www2.gov.bc.ca/gov/content/industry/forestry/managing-our-forest-resources/silviculture/tree-species-selection/tree-species-compendium-index/arbutus"},
]


def species_of(botanical: str) -> str | None:
    b = (botanical or "").lower()
    return "oak" if b.startswith("quercus garryana") else "arbutus" if b.startswith("arbutus menziesii") else None


def inventories() -> list[dict]:
    out = []
    vic = _arcgis(VIC_TREES, "BotanicalName LIKE 'Quercus garryana%' OR BotanicalName LIKE 'Arbutus%'",
                  "SiteID,Address,OnStreet,Street,BotanicalName,CommonName,DiameterAtBreastHeight,Height")
    for f in vic:
        a, g = f["attributes"], f.get("geometry") or {}
        out.append({"city": "victoria", "lon": g.get("x"), "lat": g.get("y"), "botanical": a.get("BotanicalName") or "",
                    "street": (a.get("OnStreet") or a.get("Street") or "").title(), "address": _num(a.get("Address")), "dbh_cm": a.get("DiameterAtBreastHeight")})
    esq = _arcgis(ESQ_TREES, "SPP_bot LIKE 'Quercus garryana%' OR SPP_bot LIKE 'Arbutus%'", "uniqueid,SPP_bot,DBH,address,onstr,street,suffix,active")
    for f in esq:
        a, g = f["attributes"], f.get("geometry") or {}
        if a.get("active") == 0:
            continue
        st = a.get("onstr") if (a.get("onstr") or "Unassigned") != "Unassigned" else " ".join(x for x in [a.get("street"), a.get("suffix")] if x)
        out.append({"city": "esquimalt", "lon": g.get("x"), "lat": g.get("y"), "botanical": a.get("SPP_bot") or "", "street": (st or "").title(),
                    "address": _num(a.get("address")), "dbh_cm": a.get("DBH")})
    return [r for r in out if r["lon"] and species_of(r["botanical"])]


def trees(refresh: bool) -> list[dict]:
    placed = inventories()
    print(f"  inventories: {len(placed):,}", flush=True)
    for city, get, metres in [("saanich", crowd_trees.saanich_significant, 10), ("osm", lambda: osm_trees.read("Victoria"), 25),
                              ("inat", lambda: crowd_trees.inat(list(TAXA.values()), RAW / "inat_trees.json", refresh), 10),
                              ("inat", lambda: crowd_trees.inat(list(TAXA.values()), RAW / "inat_casual.json", refresh, casual=True), 10)]:
        try:
            rows = [r for r in get() if species_of(r["botanical"])]
        except Exception as e:                  # each source is optional
            print(f"  {city} skipped: {e}", flush=True)
            continue
        rows = osm_trees.far_from(rows, [p["lon"] for p in placed], [p["lat"] for p in placed], metres)
        for r in rows:
            r["city"], r["ref"] = city, crowd_trees.ref(r)
        print(f"  {city}: {len(rows):,}", flush=True)
        placed += rows
    return [r for r in placed if BOX[0] <= r["lon"] <= BOX[2] and BOX[1] <= r["lat"] <= BOX[3]]


# ------------------------------------------------------------------ polygons (OSM parks, SEI) and points inside them
def _inside(rings, x, y):
    res = np.zeros(len(x), bool)
    for r in rings:                             # even-odd over all rings, so holes toggle back out
        xi, yi = r[:, 0], r[:, 1]
        xj, yj = np.roll(xi, 1), np.roll(yi, 1)
        for a, b, c, d in zip(xi, yi, xj, yj):
            if d != b:
                res ^= ((b > y) != (d > y)) & (x < (c - a) * (y - b) / (d - b) + a)
    return res


def parks() -> list[dict]:
    import osmium
    pbf = osm_pbf.download("Victoria", ROOT / "data" / "osm", max_age_days=30)
    out = []

    class H(osmium.SimpleHandler):
        def area(self, a):
            t = a.tags
            if not t.get("name") or not (t.get("leisure") in ("park", "nature_reserve") or t.get("boundary") in ("protected_area", "national_park")):
                return
            rings = []
            try:
                for outer in a.outer_rings():
                    rings.append(np.array([(n.lon, n.lat) for n in outer]))
                    for inner in a.inner_rings(outer):
                        rings.append(np.array([(n.lon, n.lat) for n in inner]))
            except Exception:
                return
            if rings:
                out.append({"name": t["name"], "rings": rings})

    H().apply_file(str(pbf), locations=True)
    return out


def best_places(rows: list[dict]) -> list[dict]:
    x, y = np.array([r["lon"] for r in rows]), np.array([r["lat"] for r in rows])
    sp = np.array([SPECIES.index(species_of(r["botanical"])) for r in rows])
    best = {}
    for p in parks():
        bb = np.vstack(p["rings"])
        w, s, e, n = bb[:, 0].min(), bb[:, 1].min(), bb[:, 0].max(), bb[:, 1].max()
        sel = (x >= w) & (x <= e) & (y >= s) & (y <= n)
        if not sel.any():
            continue
        hit = np.zeros(len(x), bool)
        hit[sel] = _inside(p["rings"], x[sel], y[sel])
        if not hit.any():
            continue
        k = int(math.cos(math.radians((s + n) / 2)) * 111_000 * (e - w) * 111_000 * (n - s))
        o = {"name": p["name"], "oak": int((hit & (sp == 0)).sum()), "arbutus": int((hit & (sp == 1)).sum()),
             "ll": [round(float(x[hit].mean()), 5), round(float(y[hit].mean()), 5)], "bounds": [[round(w, 5), round(s, 5)], [round(e, 5), round(n, 5)]], "_k": k}
        # one entry per name (a park mapped twice, as a park and a protected area): keep the one holding most trees
        if p["name"] not in best or o["oak"] + o["arbutus"] > best[p["name"]]["oak"] + best[p["name"]]["arbutus"]:
            best[p["name"]] = o
    ranked = sorted(best.values(), key=lambda o: -(o["oak"] + o["arbutus"]))
    for o in ranked:
        o.pop("_k")
    return [o for o in ranked if o["oak"] + o["arbutus"] >= 3][:30]


def meadows(refresh: bool) -> dict:
    cache = RAW / "sei.json"
    if refresh or not cache.exists():
        d = get_json(SEI_WFS, {"service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeName": SEI_LAYER, "outputFormat": "json",
                               "srsName": "EPSG:4326", "count": 5000,
                               "propertyName": "GEOMETRY,PROJECT_NAME,SNSTVE_ECOSYSTEM_LBL_CPNT_1,SNSTVE_ECOSYSTEM_CLASS_CPNT_1,SNSTVE_ECOSYSTEM_LBL_CPNT_2,"
                                               "ECOSYSTEM_DECILE_CPNT_1,FEATURE_AREA_SQM,TEIS_ID",
                               "CQL_FILTER": f"BBOX(GEOMETRY,{BOX[0]},{BOX[1]},{BOX[2]},{BOX[3]},'EPSG:4326') AND PROJECT_NAME='{SEI_PROJECT}' "
                                             "AND SNSTVE_ECOSYSTEM_CLASS_CPNT_1 IN ('WD','HT')"}, min_interval=2, timeout=300)
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(d), encoding="utf-8")
    d = json.loads(cache.read_text(encoding="utf-8"))
    rnd = lambda ring: [list(c) for i, c in enumerate([[round(x, 5), round(y, 5)] for x, y, *_ in ring]) if i == 0 or c != [round(ring[i - 1][0], 5), round(ring[i - 1][1], 5)]]
    feats, ha = [], {"WD": 0.0, "HT": 0.0}
    for f in d["features"]:
        p, g = f["properties"], f["geometry"]
        cls = p["SNSTVE_ECOSYSTEM_CLASS_CPNT_1"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        a = (p.get("FEATURE_AREA_SQM") or 0) / 1e4
        ha[cls] += a
        feats.append({"type": "Feature", "geometry": {"type": "MultiPolygon", "coordinates": [[rnd(r) for r in poly] for poly in polys]},
                      "properties": {"id": f"sei{p['TEIS_ID']}", "c": cls, "lbl": p.get("SNSTVE_ECOSYSTEM_LBL_CPNT_1") or cls,
                                     "lbl2": p.get("SNSTVE_ECOSYSTEM_LBL_CPNT_2") or "", "dec": p.get("ECOSYSTEM_DECILE_CPNT_1"), "ha": round(a, 2)}})
    return {"type": "FeatureCollection", "features": feats, "ha": {k: round(v) for k, v in ha.items()}}


def camas(refresh: bool) -> dict:
    cache = RAW / "camas_weeks.json"
    if refresh or not cache.exists():
        d = get_json("https://api.inaturalist.org/v1/observations/histogram",
                     {**crowd_trees.CRD_BOX, "taxon_id": CAMAS, "term_id": 12, "term_value_id": 13, "interval": "week_of_year", "verifiable": "true"},
                     min_interval=1.1)
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(d), encoding="utf-8")
    wk = json.loads(cache.read_text(encoding="utf-8"))["results"]["week_of_year"]
    weeks = [int(wk.get(str(i), 0)) for i in range(1, 54)]
    n = sum(weeks)
    cum = np.cumsum(weeks) / max(1, n)
    q = lambda p: int(np.searchsorted(cum, p)) + 1      # week of year (1-53)
    return {"weeks": weeks, "n": n, "p10": q(0.1), "p50": q(0.5), "p90": q(0.9)}


def build(refresh: bool = False) -> None:
    rows = trees(refresh)
    rows.sort(key=lambda r: (r["city"] != "victoria", r["lat"]))
    out_rows = [[round(r["lon"], 5), round(r["lat"], 5), SPECIES.index(species_of(r["botanical"])), CITIES.index(r["city"]),
                 int(r["dbh_cm"]) if isinstance(r.get("dbh_cm"), (int, float)) and r["dbh_cm"] == r["dbh_cm"] and r["dbh_cm"] >= 5 else 0,
                 r.get("address") or "", r.get("street") or "", r.get("ref") or "", r.get("common") or ""] for r in rows]
    counts = {sp: {c: sum(1 for r in rows if species_of(r["botanical"]) == sp and r["city"] == c) for c in CITIES} for sp in SPECIES}
    sig = sorted((r for r in rows if r["city"] == "saanich"), key=lambda r: -(r.get("dbh_cm") or 0))
    notable = [{"sp": species_of(r["botanical"]), "name": f"{(r.get('common') or '').strip() or r['botanical']}", "address": r.get("address") or "",
                "dbh": int(r["dbh_cm"]) if r.get("dbh_cm") else None, "ll": [round(r["lon"], 5), round(r["lat"], 5)]} for r in sig[:12]]
    places = best_places(rows)
    m = meadows(refresh)
    cm = camas(refresh)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "meadows.json").write_text(json.dumps({k: v for k, v in m.items() if k != "ha"}, separators=(",", ":")), encoding="utf-8")
    doc = {"generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M+00:00"), "region": "victoria",
           "cols": ["lon", "lat", "species", "source", "dbh_cm", "house", "street", "ref", "common"], "species": SPECIES, "cities": CITIES,
           "sources": SOURCES, "rows": out_rows, "counts": counts, "places": places, "notable": notable,
           "meadows": {"n": len(m["features"]), "ha": m["ha"], "source": "BC Sensitive Ecosystems Inventory, East Vancouver Island and Gulf Islands (2002 update)",
                       "licence": "Open Government Licence – British Columbia", "url": "https://catalogue.data.gov.bc.ca/dataset/sensitive-ecosystems-inventory-sei-detailed-polygons-with-short-attribute-table-spatial-view"},
           "camas": cm, "facts": FACTS}
    (OUT / "oaks.json").write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  wrote oaks.json ({(OUT / 'oaks.json').stat().st_size // 1024} KB): {len(out_rows):,} trees, {len(places)} places;"
          f" meadows.json ({(OUT / 'meadows.json').stat().st_size // 1024} KB): {len(m['features'])} polygons; camas n={cm['n']}", flush=True)
    print("  counts", counts, flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="re-download the iNaturalist, SEI and camas caches")
    build(ap.parse_args().refresh)
