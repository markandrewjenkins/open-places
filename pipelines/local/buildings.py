"""Open Places, City Notices and Public Safety maps: each Greater Victoria municipality's town hall and the police
station that serves it, from OpenStreetMap (amenity=townhall, amenity=police; © OpenStreetMap contributors, ODbL).

Run by hand when a building moves (it is not part of the daily refresh):
    python -m pipelines.local.buildings              # one Overpass query
    python -m pipelines.local.buildings saved.json   # or a saved Overpass answer

Writes site/public/data/local/buildings.json:
    { townhalls: { <place id>: { name, ll, addr, osm } }, police: { <agency id>: { name, ll, addr, osm } },
      jurisdiction: { <place id>: <agency id> }, licence, generated }
Every building is matched by its OSM name below; a missing match fails the run, so a renamed or deleted feature is
noticed instead of silently dropping a marker. Checked against each municipality's and agency's published address.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

from pipelines.common.http import USER_AGENT

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "site" / "public" / "data" / "local" / "buildings.json"
OVERPASS = "https://overpass-api.de/api/interpreter"
QUERY = """[out:json][timeout:50];
(nwr["amenity"="townhall"](48.28,-124.0,48.75,-123.2);nwr["amenity"="police"](48.28,-124.0,48.75,-123.2););
out center tags;"""

# place id (site/places/civic-data.js) → OSM name of its town hall
TOWNHALLS = {
    "langford": r"^Langford City Hall$", "colwood": r"^Colwood City Hall$", "view-royal": r"^View Royal Town Hall$",
    "highlands": r"^District of Highlands Municipal", "metchosin": r"^District of Metchosin Municipal Hall$",
    "sooke": r"^District of Sooke Municipal Hall$", "victoria-city": r"^Victoria City Hall", "esquimalt": r"^Township of Esquimalt Municipal Hall$",
    "saanich": r"^District of Saanich Municipal Hall$", "oak-bay": r"^District of Oak Bay Municipal Hall$",
    "central-saanich": r"^Central Saanich Municipal Hall$", "north-saanich": r"^North Saanich Municipal Hall$", "sidney": r"^Town of Sidney Municipal Hall$",
}
# agency id (pipelines/local/build.py AGENCIES) → OSM name of its station (the headquarters where an agency has several)
POLICE = {
    "westshore": r"^West Shore RCMP$", "vicpd": r"^Victoria Police Department$", "saanich": r"^Saanich Police Department$",
    "oakbay": r"^Oak Bay Police Department$", "centralsaanich": r"^Central Saanich Police Service$",
    "sidney": r"^Sidney / North Saanich RCMP$", "sooke": r"^Sooke RCMP$",
}
# who polices each municipality
JURISDICTION = {
    "langford": "westshore", "colwood": "westshore", "view-royal": "westshore", "highlands": "westshore", "metchosin": "westshore",
    "victoria-city": "vicpd", "esquimalt": "vicpd", "saanich": "saanich", "oak-bay": "oakbay", "central-saanich": "centralsaanich",
    "sidney": "sidney", "north-saanich": "sidney", "sooke": "sooke",
}


def fetch() -> dict:
    r = requests.post(OVERPASS, data={"data": QUERY}, headers={"User-Agent": USER_AGENT}, timeout=120)
    r.raise_for_status()
    return r.json()


def pick(elements: list[dict], amenity: str, pattern: str) -> dict:
    hits = [e for e in elements if e.get("tags", {}).get("amenity") == amenity and re.search(pattern, e["tags"].get("name", ""))]
    if len(hits) != 1:
        raise SystemExit(f"{amenity} {pattern!r}: {len(hits)} matches in OSM")
    e = hits[0]
    t, c = e["tags"], e.get("center") or {"lon": e["lon"], "lat": e["lat"]}
    addr = " ".join(x for x in (t.get("addr:housenumber"), t.get("addr:street")) if x) or None
    short = t["name"].split(" - ")[0].strip()   # "Victoria City Hall - siʔem tawen’ewtxw": the short name on the map
    return {"name": short, **({"name_full": t["name"]} if short != t["name"] else {}), "ll": [round(c["lon"], 5), round(c["lat"], 5)], "addr": addr, "osm": f"{e['type']}/{e['id']}"}


def main() -> None:
    data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")) if len(sys.argv) > 1 else fetch()
    els = data["elements"]
    out = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "osm_base": data.get("osm3s", {}).get("timestamp_osm_base"),
        "licence": "© OpenStreetMap contributors, ODbL 1.0 (openstreetmap.org/copyright)",
        "townhalls": {k: pick(els, "townhall", p) for k, p in TOWNHALLS.items()},
        "police": {k: pick(els, "police", p) for k, p in POLICE.items()},
        "jurisdiction": JURISDICTION,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {OUT}: {len(out['townhalls'])} town halls, {len(out['police'])} police stations")


if __name__ == "__main__":
    main()
