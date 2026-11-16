"""Public Transit: key West Shore roads, and how fast buses usually move along them (the "typical" for the page's
traffic estimate). There is no open traffic-speed feed for Greater Victoria, so the page estimates congestion from
bus movements: consecutive GTFS-Realtime positions of every bus on a corridor give an average bus speed, which it
compares with the typical bus speed for that hour from this file.

  python -m pipelines.blink.traffic          # → site/public/data/blink/corridors.json (~30 KB)

For each corridor (CORRIDORS below):
  spine     the longest stretch of any bus route's GTFS shape that runs along the road (OpenStreetMap ways by name,
            within 30 m), clipped to the West Shore; the page projects bus positions onto it (chainage in metres)
  typical   bus speed per direction, day type (weekday / Saturday / Sunday) and hour, km/h:
              "log"  measured from the Route 95 collector's logged positions (routes 95, 61, 4, 14, 15) with the same
                     rules the page uses, where at least 3 buses and 15 minutes of movement were seen in that hour;
              "tt"   otherwise the timetable's own speed: every trip's scheduled time between its first and last stop
                     on the corridor (dwell included), from BC Transit's static GTFS for a typical day.
Both include stops, so they are bus speeds, not car speeds: the page only compares like with like.

Buses don't run Hwy 1 west of the Millstream interchange (Leigh Rd, Goldstream), so the estimate can't cover it.

Rules shared with site/src/blink/traffic.js (keep them in step):
  a position counts when it is within NEAR_M of the spine; pairs of consecutive positions of the same vehicle on the
  same trip, 5–120 s apart (vehicle timestamps), give distance = |Δchainage| and time = Δt; positions at the first stop
  of a trip (layover) are skipped, and a vehicle standing still for more than 120 s in a row stops counting.
"""
from __future__ import annotations

import json
import sys
import zipfile
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from . import logio
from .config import GTFS_DIR, OUT, RAW, TZ
from .network import xy
from .static import pick_days, table

ZONE = ZoneInfo(TZ)
DOWNTOWN = (48.4245, -123.3655)          # Victoria city hall, for "inbound"
NEAR_M = 60                              # a bus position this close to the spine is on the corridor
TT_STOP_M = 300                          # timetable: stops this close (ramps, stops just off a highway) bracket the corridor
WAY_M = 30                               # a shape point this close to the road's OSM ways runs along it
GAP_CLOSE_M = 400                        # a shape that briefly leaves the road (to a stop off the highway) still counts
MIN_DT, MAX_DT, STILL_MAX, MAX_KMH = 5, 120, 120, 110
LOG_MIN_VEH, LOG_MIN_S = 3, 900

# id, label (headings and alerts), long name, OSM names, kind ("radial": inbound/outbound; "ns"/"ew": compass), clip
CORRIDORS = [
    ("hwy1", "Hwy 1", "Trans-Canada Hwy 1, Millstream Rd to McKenzie Ave", ["Trans-Canada Highway"], "radial", (-123.56, 48.40, -123.37, 48.49)),
    ("veterans", "Veterans Memorial Pkwy", "Veterans Memorial Parkway, Langford", ["Veterans Memorial Parkway"], "ns", (-123.56, 48.40, -123.37, 48.49)),
    ("goldstream", "Goldstream Ave", "Goldstream Avenue, Langford to Colwood", ["Goldstream Avenue"], "ew", (-123.56, 48.40, -123.37, 48.49)),
    ("sooke", "Sooke Rd", "Sooke Road / Hwy 14, Glen Lake to Colwood", ["Sooke Road"], "radial", (-123.545, 48.40, -123.37, 48.49)),
    ("island", "Island Hwy", "Island Highway, Colwood to View Royal (Six Mile)", ["Island Highway"], "radial", (-123.56, 48.40, -123.37, 48.49)),
]


def densify(lats, lons, step=8.0):
    x, y = xy(lats, lons)
    pts = []
    for j in range(len(x) - 1):
        k = max(1, int(np.hypot(x[j + 1] - x[j], y[j + 1] - y[j]) // step))
        f = np.arange(k) / k
        pts.append(np.column_stack([x[j] + f * (x[j + 1] - x[j]), y[j] + f * (y[j + 1] - y[j])]))
    pts.append(np.column_stack([x[-1:], y[-1:]]))
    return np.vstack(pts)


def dense_latlon(la, lo, step=15.0):
    """Shapes have sparse vertices on highways: interpolate so no two points are more than `step` m apart."""
    x, y = xy(la, lo)
    seg = np.hypot(np.diff(x), np.diff(y))
    out_la, out_lo = [], []
    for j in range(len(seg)):
        k = max(1, int(seg[j] // step))
        f = np.arange(k) / k
        out_la.append(la[j] + f * (la[j + 1] - la[j])); out_lo.append(lo[j] + f * (lo[j + 1] - lo[j]))
    out_la.append(la[-1:]); out_lo.append(lo[-1:])
    return np.concatenate(out_la), np.concatenate(out_lo)


class Spine:
    """A polyline in local metres with chainage; project() → (chainage m, distance from the line m)."""

    def __init__(self, lat, lon):
        self.lat, self.lon = np.asarray(lat, float), np.asarray(lon, float)
        self.x, self.y = xy(self.lat, self.lon)
        seg = np.hypot(np.diff(self.x), np.diff(self.y))
        self.c = np.concatenate([[0], np.cumsum(seg)])
        self.length = float(self.c[-1])

    def project(self, lat, lon):
        px, py = xy(lat, lon)
        px, py = np.atleast_1d(px)[:, None], np.atleast_1d(py)[:, None]
        ax, ay, bx, by = self.x[:-1], self.y[:-1], self.x[1:], self.y[1:]
        dx, dy = bx - ax, by - ay
        L2 = np.maximum(dx * dx + dy * dy, 1e-9)
        t = np.clip(((px - ax) * dx + (py - ay) * dy) / L2, 0, 1)
        qx, qy = ax + t * dx, ay + t * dy
        d = np.hypot(px - qx, py - qy)
        i = d.argmin(axis=1)
        r = np.arange(len(i))
        return self.c[i] + t[r, i] * np.sqrt(L2[i]), d[r, i]


def simplify(lat, lon, tol=8.0):
    """Douglas–Peucker in local metres; returns the kept indices."""
    x, y = xy(lat, lon)
    keep = np.zeros(len(x), bool); keep[0] = keep[-1] = True
    stack = [(0, len(x) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        dx, dy = x[b] - x[a], y[b] - y[a]
        L = np.hypot(dx, dy) or 1e-9
        d = np.abs(dy * (x[a + 1:b] - x[a]) - dx * (y[a + 1:b] - y[a])) / L
        k = int(d.argmax())
        if d[k] > tol:
            m = a + 1 + k
            keep[m] = True
            stack += [(a, m), (m, b)]
    return np.flatnonzero(keep)


def monotone_runs(x, y, cum, a, b):
    """Split a run [a, b] where it doubles back (its distance from the start falls 100 m below its best so far)."""
    out, s0 = [], a
    while s0 < b:
        d = np.hypot(x[s0:b + 1] - x[s0], y[s0:b + 1] - y[s0])
        best = np.maximum.accumulate(d)
        rev = np.flatnonzero(best - d > 100)
        e = s0 + (int(rev[0]) - 1 if len(rev) else b - s0)
        e = max(e, s0 + 1)
        top = s0 + int(d[: e - s0 + 1].argmax())
        out.append((s0, top))
        s0 = top if top > s0 else e
        if s0 >= b or (len(rev) == 0):
            break
    return out


def candidate_runs(groups, tree, clip):
    """Every shape's monotone stretches along the road: [(displacement m, shape id, lat, lon)]."""
    res = []
    for sid, (la, lo) in groups.items():
        inb = (lo >= clip[0]) & (lo <= clip[2]) & (la >= clip[1]) & (la <= clip[3])
        if inb.sum() < 2:
            continue
        x, y = xy(la, lo)
        d, _ = tree.query(np.column_stack([x, y]))
        idx = np.flatnonzero((d < WAY_M) & inb)
        if len(idx) < 2:
            continue
        cum = np.concatenate([[0], np.cumsum(np.hypot(np.diff(x), np.diff(y)))])
        runs, s0, prev = [], idx[0], idx[0]
        for i in idx[1:]:
            if cum[i] - cum[prev] > GAP_CLOSE_M:      # close short excursions off the road (a stop off the highway)
                runs.append((s0, prev)); s0 = i
            prev = i
        runs.append((s0, prev))
        for a, b in runs:
            for p, q in monotone_runs(x, y, cum, a, b):
                disp = float(np.hypot(x[q] - x[p], y[q] - y[p]))
                if disp > 300:
                    res.append((disp, sid, la[p:q + 1], lo[p:q + 1]))
    return sorted(res, key=lambda r: -r[0])


def build_spines(z: zipfile.ZipFile) -> list[dict]:
    """Per corridor one spine per carriageway where buses use both (divided highways are 30–80 m apart), each running
    the same way so a positive chainage change means direction 0 on either."""
    ways = pd.read_parquet(RAW / "osm_ways.parquet")
    sh = table(z, "shapes.txt")
    for c in ("shape_pt_lat", "shape_pt_lon"):
        sh[c] = sh[c].astype(float)
    sh["shape_pt_sequence"] = sh.shape_pt_sequence.astype(int)
    sh = sh.sort_values(["shape_id", "shape_pt_sequence"])
    groups = {sid: dense_latlon(g.shape_pt_lat.to_numpy(), g.shape_pt_lon.to_numpy()) for sid, g in sh.groupby("shape_id")}
    out = []
    dx, dy = xy(DOWNTOWN[0], DOWNTOWN[1])
    for cid, label, long, names, kind, clip in CORRIDORS:
        w = ways[ways.name.isin(names)]
        tree = cKDTree(np.vstack([densify(r.lats, r.lons) for r in w.itertuples()]))
        runs = candidate_runs(groups, tree, clip)
        if not runs:
            print(f"  {cid}: no bus route runs along it", flush=True)
            continue
        disp, sid, la, lo = runs[0]
        A = Spine(la, lo)
        # the other carriageway: the longest run going the opposite way along A, reversed to A's orientation
        B, bsid = None, None
        for d2, s2, la2, lo2 in runs[1:]:
            c, dd = A.project(la2[[0, -1]], lo2[[0, -1]])
            if c[1] < c[0] - 300 and d2 > 0.5 * disp:
                B, bsid = (la2[::-1], lo2[::-1]), s2
                break
        spines = []
        for la_, lo_ in [(la, lo)] + ([B] if B else []):
            k = simplify(la_, lo_)
            spines.append(Spine(la_[k], lo_[k]))
        x, y = spines[0].x[[0, -1]], spines[0].y[[0, -1]]
        if kind == "radial":
            first_nearer = np.hypot(x[0] - dx, y[0] - dy) < np.hypot(x[1] - dx, y[1] - dy)
            dirs = ["outbound", "inbound"] if first_nearer else ["inbound", "outbound"]
        elif kind == "ns":
            dirs = ["northbound", "southbound"] if y[1] > y[0] else ["southbound", "northbound"]
        else:
            dirs = ["eastbound", "westbound"] if x[1] > x[0] else ["westbound", "eastbound"]
        # shapes that really run along the corridor (≥ 500 m within NEAR_M of a spine): their trips feed the timetable speed
        S = {"spines": spines}
        runs_along = set()
        bb = (min(sp.lon.min() for sp in spines) - 0.002, min(sp.lat.min() for sp in spines) - 0.002,
              max(sp.lon.max() for sp in spines) + 0.002, max(sp.lat.max() for sp in spines) + 0.002)
        for s2, (la2, lo2) in groups.items():
            m2 = (lo2 >= bb[0]) & (lo2 <= bb[2]) & (la2 >= bb[1]) & (la2 <= bb[3])
            if m2.sum() < 2:
                continue
            la2, lo2 = la2[m2], lo2[m2]
            c2, d2, _ = project_any(S, la2, lo2)
            on = d2 <= NEAR_M
            if on.sum() >= 2 and np.ptp(c2[on]) >= 500 and on.sum() * 15 >= 500:
                runs_along.add(s2)
        out.append({"id": cid, "label": label, "long": long, "kind": kind, "dirs": dirs, "shape": [str(sid)] + ([str(bsid)] if bsid else []),
                    "spines": spines, "spine": spines[0], "len_m": round(disp), "shapes_along": runs_along})
        print(f"  {cid}: {len(spines)} spine(s) from shape(s) {sid}{f', {bsid}' if bsid else ''}, {disp / 1000:.1f} km end to end, dir 0 = {dirs[0]}", flush=True)
    return out


def project_any(S: dict, lat, lon):
    """Chainage and distance on the nearest of a corridor's spines, plus which spine."""
    best = None
    for k, sp in enumerate(S["spines"]):
        c, d = sp.project(lat, lon)
        if best is None:
            best = (c, d, np.zeros(len(c), int))
        else:
            m = d < best[1]
            best = (np.where(m, c, best[0]), np.where(m, d, best[1]), np.where(m, k, best[2]))
    return best


def daytype(ts: pd.Series) -> tuple[pd.Series, pd.Series]:
    t = pd.to_datetime(ts, unit="s", utc=True).dt.tz_convert(TZ)
    wd = t.dt.weekday
    return np.where(wd == 5, "sat", np.where(wd == 6, "sun", "weekday")), t.dt.hour


def logged(spines: list[dict]) -> dict:
    """{(cid, dir, daytype, hour): [dist_m, secs, n_vehicles]} from the collector's vehicle positions."""
    vp = logio.read_all("vp")
    if vp is None or vp.empty:
        print("  no logged positions: typical speeds come from the timetable only", flush=True)
        return {}
    vp = vp.dropna(subset=["lat", "lon", "ts"]).sort_values(["vehicle", "ts"])
    vp = vp.drop_duplicates(["vehicle", "ts"])
    print(f"  logged positions: {len(vp):,} ({vp.ts.min()}–{vp.ts.max()})", flush=True)
    acc: dict = {}
    for S in spines:
        c, d, k = project_any(S, vp.lat.to_numpy(float), vp.lon.to_numpy(float))
        df = pd.DataFrame({"veh": vp.vehicle.astype(str).to_numpy(), "trip": vp.trip_id.astype(str).to_numpy(), "ts": vp.ts.to_numpy(np.int64),
                           "seq": pd.to_numeric(vp.seq, errors="coerce").fillna(99).to_numpy(), "c": c, "k": k, "on": d <= NEAR_M})
        dt_, hr = daytype(df.ts)
        df["dt"], df["hr"] = dt_, hr.to_numpy()
        still = {}
        lastdir = {}
        prev = None
        for r in df.itertuples(index=False):
            if prev is not None and prev.veh == r.veh and prev.trip == r.trip:
                dt = r.ts - prev.ts
                if MIN_DT <= dt <= MAX_DT and prev.on and r.on and prev.k == r.k and prev.seq > 1 and r.seq > 1 and abs(r.c - prev.c) / dt * 3.6 <= MAX_KMH:
                    dc = r.c - prev.c
                    if abs(dc) < 5:
                        still[r.veh] = still.get(r.veh, 0) + dt
                        dr = lastdir.get(r.veh)
                    else:
                        still[r.veh] = 0
                        dr = 0 if dc > 0 else 1
                        lastdir[r.veh] = dr
                    if dr is not None and still[r.veh] <= STILL_MAX:
                        k = (S["id"], dr, prev.dt, int(prev.hr))
                        a = acc.setdefault(k, [0.0, 0, set()])
                        a[0] += abs(dc); a[1] += dt; a[2].add(r.veh)
                elif not (prev.on and r.on):
                    still[r.veh] = 0
            else:
                still[r.veh] = 0
                lastdir.pop(r.veh, None)
            prev = r
    return {k: [v[0], v[1], len(v[2])] for k, v in acc.items()}


def timetable(z: zipfile.ZipFile, spines: list[dict]) -> dict:
    """{(cid, dir, daytype, hour): [dist_m, secs, n_trips]} from scheduled stop times on a typical day."""
    trips = table(z, "trips.txt")
    days = pick_days(z, trips, TZ)
    stops = table(z, "stops.txt")
    stops = stops.assign(lat=stops.stop_lat.astype(float), lon=stops.stop_lon.astype(float))
    print(f"  typical days: {', '.join(f'{k} {v[0]}' for k, v in days.items())}", flush=True)
    import pyarrow.csv as pacsv
    st = pacsv.read_csv(z.open("stop_times.txt"), convert_options=pacsv.ConvertOptions(
        include_columns=["trip_id", "departure_time", "stop_id", "stop_sequence"],
        column_types={"trip_id": "string", "departure_time": "string", "stop_id": "string", "stop_sequence": "int32"})).to_pandas()
    p = st.departure_time.str.split(":", expand=True)
    st["dep"] = p[0].astype(int) * 3600 + p[1].astype(int) * 60 + p[2].astype(int)
    acc: dict = {}
    for dtype, (_, sids) in days.items():
        tids = set(trips[trips.service_id.isin(sids)].trip_id)
        s = st[st.trip_id.isin(tids)].sort_values(["trip_id", "stop_sequence"])
        for S in spines:
            c, d, kk = project_any(S, stops.lat.to_numpy(), stops.lon.to_numpy())
            on = pd.DataFrame({"stop_id": stops.stop_id.astype(str), "c": c, "d": d, "k": kk})
            on = on[on.d <= TT_STOP_M].set_index("stop_id")
            along = set(trips[trips.shape_id.isin(S["shapes_along"])].trip_id)
            x = s[s.stop_id.isin(on.index) & s.trip_id.isin(along)].copy()
            if x.empty:
                continue
            x["c"] = x.stop_id.map(on.c)
            x["k"] = x.stop_id.map(on.k)
            # runs of consecutive on-corridor stops within a trip, on one carriageway, moving one way along it
            x["dc"] = x.c.diff()
            same = (x.trip_id == x.trip_id.shift()) & (x.stop_sequence == x.stop_sequence.shift() + 1) & (x.k == x.k.shift())
            turn = np.sign(x.dc) != np.sign(x.dc.shift())
            x["brk"] = ~same | (same & same.shift(fill_value=False) & turn)
            x["run"] = x.brk.cumsum()
            g = x.groupby("run").agg(c0=("c", "first"), c1=("c", "last"), t0=("dep", "first"), t1=("dep", "last"))
            g = g[(g.t1 - g.t0 >= 60) & ((g.c1 - g.c0).abs() >= 300)]
            g = g[((g.c1 - g.c0).abs() / (g.t1 - g.t0) * 3.6).between(3, MAX_KMH)]
            for r in g.itertuples():
                k = (S["id"], 0 if r.c1 > r.c0 else 1, dtype, int(r.t0 // 3600) % 24)
                a = acc.setdefault(k, [0.0, 0, 0])
                a[0] += abs(r.c1 - r.c0); a[1] += int(r.t1 - r.t0); a[2] += 1
    return acc


def main() -> int:
    zp = GTFS_DIR / "latest.zip"
    if not zp.exists():
        print("no static GTFS yet: run `python -m pipelines.blink.fetch gtfs`", file=sys.stderr)
        return 1
    if not (RAW / "osm_ways.parquet").exists():
        print("no OSM ways yet: run `python -m pipelines.blink.fetch osm`", file=sys.stderr)
        return 1
    z = zipfile.ZipFile(zp)
    print("corridors:", flush=True)
    spines = build_spines(z)
    lg = logged(spines)
    tt = timetable(z, spines)
    out = []
    for S in spines:
        typ = {}
        for dr in (0, 1):
            per = {}
            for dtype in ("weekday", "sat", "sun"):
                hours = []
                for h in range(24):
                    k = (S["id"], dr, dtype, h)
                    a, b = lg.get(k), tt.get(k)
                    if a and a[2] >= LOG_MIN_VEH and a[1] >= LOG_MIN_S:
                        hours.append([round(a[0] / a[1] * 3.6, 1), "log", a[2]])
                    elif b and b[1] > 0:
                        hours.append([round(b[0] / b[1] * 3.6, 1), "tt", b[2]])
                    else:
                        hours.append(None)
                per[dtype] = hours
            typ[S["dirs"][dr]] = per
        nlog = sum(1 for d in typ.values() for hs in d.values() for x in hs if x and x[1] == "log")
        out.append({"id": S["id"], "label": S["label"], "long": S["long"], "dirs": S["dirs"], "len_m": S["len_m"], "from_shape": S["shape"],
                    "spines": [[[round(float(lo), 5), round(float(la), 5)] for la, lo in zip(sp.lat, sp.lon)] for sp in S["spines"]], "typical": typ, "log_hours": nlog})
        print(f"  {S['id']}: {nlog} direction-hours from logs, the rest from the timetable", flush=True)
    doc = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "about": "Key West Shore roads and the typical bus speed along them by direction, day type and hour (km/h, stops included). "
                 "src 'log' = measured from logged BC Transit real-time positions; 'tt' = the timetable's scheduled speed. "
                 "The page compares live bus speeds with these to estimate congestion; it is not a traffic feed.",
        "rules": {"near_m": NEAR_M, "min_dt_s": MIN_DT, "max_dt_s": MAX_DT, "still_max_s": STILL_MAX, "max_kmh": MAX_KMH, "log_min_vehicles": LOG_MIN_VEH, "log_min_s": LOG_MIN_S},
        "credit": "BC Transit GTFS and GTFS-Realtime (BC Transit Open Data Terms of Use); road names © OpenStreetMap contributors (ODbL).",
        "corridors": out,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    f = OUT / "corridors.json"
    f.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    print(f"  wrote corridors.json ({f.stat().st_size / 1024:,.1f} KB)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
