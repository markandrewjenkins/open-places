"""Road networks for the Open Places "Plan a Route" tool on the tree pages (blossom, foliage, Garry oaks).

  python -m pipelines.common.plan_graph

One network per travel mode for Greater Victoria (Langford and Colwood to Saanich and Oak Bay), cut from the cached
BBBike OpenStreetMap extract (data/osm/Victoria.osm.pbf, ODbL). No trees are attached: the page scores today's best
trees itself and snaps them to the network, so one set of files serves all three pages.

Writes site/public/data/routes/gvic_<mode>.json (same format as the trip_* files read by src/shared/route.js).
"""
from __future__ import annotations

import json
from pathlib import Path

from . import osm_pbf
from . import roadgraph as rg

ROOT = Path(__file__).resolve().parents[2]
PBF = ROOT / "data" / "osm" / "Victoria.osm.pbf"
RAW = ROOT / "data" / "routes" / "raw"
OUT = ROOT / "site" / "public" / "data" / "routes"
BBOX = (48.400, -123.560, 48.560, -123.300)       # s, w, n, e


def main():
    cache = RAW / "gvic_roads.json"
    if cache.exists():
        els = json.loads(cache.read_text(encoding="utf-8"))["elements"]
    else:
        d = osm_pbf.extract(PBF, BBOX)["roads"]
        RAW.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(d), encoding="utf-8")
        els = d["elements"]
    G = rg.build(els, BBOX)
    for mode in rg.MODES:
        info = rg.write(G, mode, OUT / f"gvic_{mode}.json",
                        extra={"area": "Greater Victoria", "bbox": [BBOX[1], BBOX[0], BBOX[3], BBOX[2]],
                               "credit": "Roads © OpenStreetMap contributors (ODbL)"})
        print(f"  gvic {mode}: {info['edges']:,} edges, {info['nodes']:,} nodes, {info['kb']:,} KB", flush=True)


if __name__ == "__main__":
    main()
