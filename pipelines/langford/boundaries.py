"""Municipal outlines for the Open Places Growth & Housing map (Langford Boom Tracker on the map stage).

  python -m pipelines.langford.boundaries

Writes site/public/data/langford/crd_csd.json: the Capital Regional District's census subdivisions that the Boom
Tracker's league table covers (joined later in the browser by CSDUID = league row `sgc`), simplified to ~40 m.

Source: Statistics Canada, 2021 Census cartographic boundary files, census subdivisions (CSD), from StatCan's own
ArcGIS service (geo.statcan.gc.ca). Licence: Statistics Canada Open Licence (the service lists Open Government
Licence – Canada). Boundaries change rarely: run by hand after a census, not daily. Never the City of Langford's layers.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from pipelines.common.http import get_json

URL = "https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/MapServer/9/query"
OUT = Path(__file__).resolve().parents[2] / "site" / "public" / "data" / "langford" / "crd_csd.json"
LEAGUE = OUT.parent / "langford.json"


def main() -> None:
    keep = {r["sgc"] for r in json.loads(LEAGUE.read_text(encoding="utf-8"))["league"]["rows"]}
    fc = get_json(URL, {"where": "CSDUID LIKE '5917%'", "outFields": "CSDUID,CSDNAME,CSDTYPE,LANDAREA", "outSR": 4326,
                        "maxAllowableOffset": 0.0004, "geometryPrecision": 5, "f": "geojson"})
    feats = [{"type": "Feature", "geometry": f["geometry"],
              "properties": {"id": f["properties"]["CSDUID"], "name": f["properties"]["CSDNAME"], "type": f["properties"]["CSDTYPE"],
                             "land_km2": round(f["properties"]["LANDAREA"], 2)}}
             for f in fc["features"] if f["properties"]["CSDUID"] in keep]
    out = {"type": "FeatureCollection", "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
           "source": "Statistics Canada, 2021 Census cartographic boundary files (census subdivisions)",
           "licence": "Statistics Canada Open Licence", "licence_url": "https://www.statcan.gc.ca/en/reference/licence",
           "features": feats}
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT} · {len(feats)} of {len(keep)} league municipalities · {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
