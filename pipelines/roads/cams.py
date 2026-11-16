"""Build the DriveBC camera list for Open Places (python -m pipelines.roads.cams).

Writes site/public/data/roads/cams.json: every BC highway camera that DriveBC shows, as compact rows
    [id, group, name, caption, highway, orientation, lon, lat, update_period_s]
`group` ties the directions of one camera site together (DriveBC's own grouping).

Sources (both Open Government Licence – British Columbia):
  * BC Data Catalogue "DriveBC HighwayCams" (bc-highwaycams): the licensed list (id, group, name, caption, highway,
    orientation, location, image URL https://www.drivebc.ca/images/<id>.jpg). Updated monthly.
  * DriveBC's site API https://www.drivebc.ca/api/webcams/: adds each camera's mean update period and on/off flag.
    Optional: if it fails, the catalogue list is written on its own (update period left out).
The list changes rarely, so run it weekly at most. The browser reads each image's time from the image host's
`Expires` header (it equals the capture time) and never calls DriveBC's API itself: the API sends no CORS headers.
"""
from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timezone
from pathlib import Path

import requests

from pipelines.common.http import USER_AGENT, get_json

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "site" / "public" / "data" / "roads"
CATALOGUE_CSV = ("https://catalogue.data.gov.bc.ca/dataset/6b39a910-6c77-476f-ac96-7b4f18849b1c/resource/"
                 "a9d52d85-8402-4ce7-b2ac-a2779837c48a/download/webcams.csv")
SITE_API = "https://www.drivebc.ca/api/webcams/"
CREDIT = "Camera images and list: DriveBC, BC Ministry of Transportation and Transit (Open Government Licence – British Columbia)"


def catalogue() -> dict[int, dict]:
    r = requests.get(CATALOGUE_CSV, headers={"User-Agent": USER_AGENT}, timeout=90)
    r.raise_for_status()
    rows = csv.DictReader(io.StringIO(r.content.decode("utf-8-sig")))
    out = {}
    for x in rows:
        try:
            out[int(x["id"])] = {"id": int(x["id"]), "group": int(x["cam_group"] or x["id"]), "name": x["camName"].strip(),
                                 "caption": x["caption"].strip(), "hwy": x["highway_number"].strip(), "ori": x["orientation"].strip(),
                                 "lon": round(float(x["longitude"]), 5), "lat": round(float(x["latitude"]), 5)}
        except (KeyError, ValueError):
            continue
    return out


def main() -> None:
    cams = catalogue()
    print(f"catalogue: {len(cams)} cameras")
    try:
        api = get_json(SITE_API, timeout=120)
        seen = 0
        for c in api:
            if c.get("should_appear") is False or not c.get("location"):
                cams.pop(c.get("id"), None)
                continue
            lon, lat = c["location"]["coordinates"][:2]
            x = cams.setdefault(c["id"], {"id": c["id"], "group": c.get("group") or c["id"], "name": c.get("name", ""),
                                          "caption": c.get("caption", ""), "hwy": c.get("highway_display") or c.get("highway") or "",
                                          "ori": c.get("orientation") or "", "lon": round(lon, 5), "lat": round(lat, 5)})
            x["period"] = int(c.get("update_period_mean") or 0) or None
            x["on"] = bool(c.get("is_on", True))
            seen += 1
        print(f"site API: {seen} cameras matched")
    except Exception as exc:  # the API is optional: the catalogue list alone still works
        print(f"site API skipped: {exc}")
    rows = [[c["id"], c["group"], c["name"], c["caption"], c["hwy"], c["ori"], c["lon"], c["lat"], c.get("period")]
            for c in sorted(cams.values(), key=lambda c: c["id"]) if c.get("on", True)]
    OUT.mkdir(parents=True, exist_ok=True)
    doc = {"generated": datetime.now(timezone.utc).isoformat(timespec="minutes"), "count": len(rows),
           "fields": ["id", "group", "name", "caption", "hwy", "ori", "lon", "lat", "period_s"],
           "image": "https://www.drivebc.ca/images/{id}.jpg", "page": "https://www.drivebc.ca/cameras/{id}",
           "credit": CREDIT, "licence": "https://www2.gov.bc.ca/gov/content?id=A519A56BC2BF44E4A008B33FCF527F61", "cams": rows}
    (OUT / "cams.json").write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"wrote {OUT / 'cams.json'}: {len(rows)} cameras")


if __name__ == "__main__":
    main()
