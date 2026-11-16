"""Static network helpers: schedule versions, scheduled stop events per service day, shape projection, corridors."""
from __future__ import annotations

import json
from functools import lru_cache

import numpy as np
import pandas as pd

from .config import GTFS_DIR, RAW, ROUTE_IDS, TZ

LAT0 = 48.44
KX = 111_320 * np.cos(np.radians(LAT0))
KY = 110_540
RID2SHORT = {v: k for k, v in ROUTE_IDS.items()}


def xy(lat, lon):
    return (np.asarray(lon, float) + 123.4) * KX, (np.asarray(lat, float) - LAT0) * KY


# ============================================================================= schedule versions

def versions() -> list[str]:
    if not GTFS_DIR.exists():
        return []
    vs = []
    for d in GTFS_DIR.iterdir():
        if d.is_dir() and (d / "meta.json").exists():
            vs.append((json.loads((d / "meta.json").read_text())["first_seen"], d.name))
    return [v for _, v in sorted(vs)]


def latest_version() -> str:
    vs = versions()
    if not vs:
        raise FileNotFoundError("no static GTFS yet: run `python -m pipelines.blink.fetch gtfs`")
    return vs[-1]


@lru_cache(maxsize=8)
def load_version(v: str) -> dict:
    d = GTFS_DIR / v
    out = {n: pd.read_parquet(d / f"{n}.parquet") for n in ("routes", "trips", "stop_times", "stops", "shapes", "calendar_dates")}
    out["meta"] = json.loads((d / "meta.json").read_text())
    return out


def version_for(day: str) -> str | None:
    """The newest schedule version whose calendar runs on `day` (YYYYMMDD)."""
    for v in reversed(versions()):
        cal = load_version(v)["calendar_dates"]
        if ((cal.date == day) & (cal.exception_type == "1")).any():
            return v
    return None


def _secs(s: pd.Series) -> np.ndarray:
    p = s.str.split(":", expand=True).astype(int)
    return (p[0] * 3600 + p[1] * 60 + p[2]).to_numpy()


def scheduled(days: list[str]) -> pd.DataFrame:
    """Scheduled stop events for the logged routes on each service day (YYYYMMDD), with absolute epoch times.
    GTFS times count from 'noon minus 12 h' of the service day, which is DST-safe and allows times past 24:00."""
    frames = []
    for day in sorted(set(days)):
        v = version_for(day)
        if v is None:
            continue
        g = load_version(v)
        cal = g["calendar_dates"]
        svc = set(cal[(cal.date == day) & (cal.exception_type == "1")].service_id) - \
            set(cal[(cal.date == day) & (cal.exception_type == "2")].service_id)
        trips = g["trips"][g["trips"].service_id.isin(svc)]
        st = g["stop_times"][g["stop_times"].trip_id.isin(set(trips.trip_id))]
        if st.empty:
            continue
        base = (pd.Timestamp(f"{day[:4]}-{day[4:6]}-{day[6:]} 12:00", tz=TZ) - pd.Timedelta(hours=12)).timestamp()
        df = st.merge(trips[["trip_id", "route_id", "direction_id", "shape_id", "trip_headsign", "block_id"]], on="trip_id")
        out = pd.DataFrame({
            "route": df.route_id.map(RID2SHORT), "trip_id": df.trip_id, "start_date": int(day), "dir": df.direction_id.astype(int),
            "shape_id": df.shape_id, "headsign": df.trip_headsign, "block": df.block_id, "seq": df.stop_sequence.astype(int),
            "stop_id": df.stop_id, "timepoint": df.timepoint.fillna("0").astype(int),
            "dist": pd.to_numeric(df.shape_dist_traveled, errors="coerce"),
            "sched_arr": base + _secs(df.arrival_time), "sched_dep": base + _secs(df.departure_time), "version": v})
        frames.append(out)
    if not frames:
        return pd.DataFrame()
    s = pd.concat(frames, ignore_index=True).sort_values(["trip_id", "start_date", "seq"])
    s["last"] = s.groupby(["trip_id", "start_date"]).seq.transform("max") == s.seq
    s["first"] = s.groupby(["trip_id", "start_date"]).seq.transform("min") == s.seq
    return s.reset_index(drop=True)


# ============================================================================= shapes

class Shape:
    """A shape polyline in local metres; distances along it use the feed's shape_dist_traveled (metres)."""

    def __init__(self, pts: pd.DataFrame):
        pts = pts.sort_values("shape_pt_sequence", key=lambda s: s.astype(int))
        self.lat = pts.shape_pt_lat.astype(float).to_numpy()
        self.lon = pts.shape_pt_lon.astype(float).to_numpy()
        self.x, self.y = xy(self.lat, self.lon)
        sdt = pd.to_numeric(pts.shape_dist_traveled, errors="coerce").to_numpy()
        own = np.concatenate([[0], np.cumsum(np.hypot(np.diff(self.x), np.diff(self.y)))])
        self.d = sdt if np.isfinite(sdt).all() and sdt[-1] > 0 else own
        self.length = float(self.d[-1])

    def project(self, lat, lon, chunk: int = 4000) -> tuple[np.ndarray, np.ndarray]:
        """Distance along the shape and perpendicular offset (m) of each point (nearest segment)."""
        px, py = xy(lat, lon)
        ax, ay, bx, by = self.x[:-1], self.y[:-1], self.x[1:], self.y[1:]
        dx, dy = bx - ax, by - ay
        L2 = np.maximum(dx * dx + dy * dy, 1e-9)
        out_d, out_o = np.empty(len(px)), np.empty(len(px))
        for i in range(0, len(px), chunk):
            X, Y = px[i:i + chunk, None], py[i:i + chunk, None]
            t = np.clip(((X - ax) * dx + (Y - ay) * dy) / L2, 0, 1)
            cx, cy = ax + t * dx, ay + t * dy
            dist = np.hypot(X - cx, Y - cy)
            j = dist.argmin(axis=1)
            r = np.arange(len(j))
            out_o[i:i + chunk] = dist[r, j]
            out_d[i:i + chunk] = self.d[j] + t[r, j] * (self.d[j + 1] - self.d[j])
        return out_d, out_o

    def point_at(self, dist: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        return np.interp(dist, self.d, self.lat), np.interp(dist, self.d, self.lon)

    def slice(self, d0: float, d1: float) -> list[list[float]]:
        """[[lat, lon], ...] of the shape between two distances."""
        inner = (self.d > d0) & (self.d < d1)
        la0, lo0 = self.point_at(np.array([d0]))
        la1, lo1 = self.point_at(np.array([d1]))
        lats = np.concatenate([la0, self.lat[inner], la1])
        lons = np.concatenate([lo0, self.lon[inner], lo1])
        return [[round(float(a), 5), round(float(b), 5)] for a, b in zip(lats, lons)]


@lru_cache(maxsize=64)
def shape(version: str, shape_id: str) -> Shape:
    sh = load_version(version)["shapes"]
    return Shape(sh[sh.shape_id == shape_id])


# ============================================================================= corridors (OSM)

class WayIndex:
    """OSM ways densified to points every ~8 m in a KD-tree, for fast 'which road is this' lookups."""

    def __init__(self, ways: pd.DataFrame):
        from scipy.spatial import cKDTree
        xs, ys, idx = [], [], []
        for i, w in enumerate(ways.itertuples(index=False)):
            wx, wy = xy(np.asarray(w.lats), np.asarray(w.lons))
            if len(wx) < 2:
                continue
            seg = np.hypot(np.diff(wx), np.diff(wy))
            for j in range(len(seg)):
                k = max(1, int(seg[j] // 8))
                f = np.arange(k) / k
                xs.append(wx[j] + f * (wx[j + 1] - wx[j]))
                ys.append(wy[j] + f * (wy[j + 1] - wy[j]))
                idx.append(np.full(k, i))
        self.tree = cKDTree(np.column_stack([np.concatenate(xs), np.concatenate(ys)]))
        self.way = np.concatenate(idx)
        self.name = np.array([w.name or w.ref or w.highway or "" for w in ways.itertuples(index=False)], dtype=object)
        self.bus = ways.bus_lane.to_numpy(bool)


@lru_cache(maxsize=1)
def way_index() -> WayIndex | None:
    w = osm_ways()
    return WayIndex(w) if w is not None and len(w) else None


def corridor_tags(sh: Shape, d0: float, d1: float, ways=None, step: float = 25.0) -> dict:
    """Dominant road name and bus/HOV-lane share of a stretch of shape: sample every `step` m and match each sample to
    the nearest OSM way within 20 m (a bus-lane-tagged carriageway wins ties within 4 m)."""
    wi = way_index()
    if wi is None or d1 <= d0:
        return {"road": None, "bus_lane_share": None}
    ds = np.arange(d0, d1, step) + step / 2
    la, lo = sh.point_at(ds)
    sx, sy = xy(la, lo)
    dist, ii = wi.tree.query(np.column_stack([sx, sy]), k=8, distance_upper_bound=20)
    names, bus = [], []
    for drow, irow in zip(dist, ii):
        ok = np.isfinite(drow)
        if not ok.any():
            continue
        ways_ = wi.way[irow[ok]]
        near = drow[ok] <= drow[ok][0] + 4
        names.append(wi.name[ways_[0]])
        bus.append(bool(wi.bus[ways_[near]].any()))
    if not names:
        return {"road": None, "bus_lane_share": None}
    vc = pd.Series(names).value_counts()
    return {"road": vc.index[0], "roads": vc.head(3).index.tolist(), "bus_lane_share": round(float(np.mean(bus)), 2)}


def osm_ways() -> pd.DataFrame | None:
    f = RAW / "osm_ways.parquet"
    return pd.read_parquet(f) if f.exists() else None
