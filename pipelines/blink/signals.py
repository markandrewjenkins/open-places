"""Public Transit: traffic signals along Greater Victoria's bus routes, for the Live Vehicle Map's motion model.

Between feed refreshes the map moves each bus along its own route line; near a signalised intersection it slows a
little (it can't know the phase, so it never stops there, only eases through). This writes the signals that sit on a
route line:

  .venv/Scripts/python -m pipelines.blink.signals      # → site/public/data/blink/agencies/victoria/signals.json (~10 KB)

Source: OpenStreetMap nodes tagged highway=traffic_signals from the BBBike Victoria extract (data/osm/Victoria.osm.pbf,
downloaded weekly by pipelines/common/osm_pbf.py), kept when within NEAR_M of a route shape in the published
network.json. © OpenStreetMap contributors, ODbL.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import numpy as np
import osmium
from scipy.spatial import cKDTree

from .config import OUT, ROOT
from .network import xy

PBF = ROOT / "data" / "osm" / "Victoria.osm.pbf"
NET = OUT / "agencies" / "victoria" / "network.json"
DEST = OUT / "agencies" / "victoria" / "signals.json"
NEAR_M = 20          # a signal this close to a route line is on it
STEP_M = 10          # route lines are densified to this spacing before the nearest-point test


def decode(flat):
    x = np.cumsum(np.asarray(flat[0::2], float)) / 1e5
    y = np.cumsum(np.asarray(flat[1::2], float)) / 1e5
    return x, y                                         # lon, lat


def route_points():
    net = json.loads(NET.read_text(encoding="utf-8"))
    pts = []
    for flat in net["shapes"]:
        lon, lat = decode(flat)
        X, Y = xy(lat, lon)
        for j in range(len(X) - 1):
            k = max(1, int(np.hypot(X[j + 1] - X[j], Y[j + 1] - Y[j]) // STEP_M))
            f = np.arange(k) / k
            pts.append(np.column_stack([X[j] + f * (X[j + 1] - X[j]), Y[j] + f * (Y[j + 1] - Y[j])]))
    return np.vstack(pts)


class Signals(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.out = []

    def node(self, n):
        if n.tags.get("highway") == "traffic_signals" and n.location.valid():
            self.out.append((n.location.lon, n.location.lat))


def main():
    h = Signals()
    h.apply_file(str(PBF))
    sig = np.array(h.out)
    tree = cKDTree(route_points())
    X, Y = xy(sig[:, 1], sig[:, 0])
    d, _ = tree.query(np.column_stack([X, Y]))
    keep = sig[d <= NEAR_M]
    doc = {"generated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
           "about": "Traffic signals within 20 m of a Greater Victoria bus route line, for the map's motion model (buses ease through them).",
           "credit": "© OpenStreetMap contributors (ODbL), highway=traffic_signals",
           "signals": [[round(float(lo), 5), round(float(la), 5)] for lo, la in keep]}
    DEST.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    print(f"signals: {len(sig)} in the extract, {len(keep)} on bus routes -> {DEST.relative_to(ROOT)} ({DEST.stat().st_size / 1e3:.1f} KB)")


if __name__ == "__main__":
    main()
