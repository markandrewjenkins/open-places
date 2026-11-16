"""Public Transit: every keyless agency's static GTFS → a compact network map and per-stop timetable summary.

  python -m pipelines.blink.static [agency ...] [--force]        # default: every agency in agencies.py

For each agency (pipelines/blink/agencies.py):
  fetch   the GTFS zip into data/blink/raw/agencies/<id>/gtfs.zip, politely: a conditional request (ETag /
          Last-Modified) when the publisher supports it, and never more often than `refresh_h` (20 h by default,
          a week for BC Transit, whose server sends no validators). Victoria reuses route 95's daily download.
  build   only when the zip changed (or --force), into site/public/data/blink/agencies/<id>/:
            network.json  routes (name, mode, colours, headsign per direction, weekday trips by hour, Saturday and
                          Sunday trip counts) and one simplified shape per route and direction (~15 m tolerance,
                          delta-encoded at 1e-5°)
            stops.json    every stop with service, and per route and direction at that stop, for a typical weekday,
                          Saturday and Sunday: departures, first and last time, and the median gap in the peaks
                          (7–9, 15–18), midday (9–15) and evening (18–24). stop_times themselves are not published.
          plus agencies/index.json (name, credit, terms, bbox, schedule version and the dates summarised).

A failure in one agency is logged (a GitHub Actions ::warning) and the others still build; the last good files stay.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import sys
import time
import traceback
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import pyarrow.csv as pacsv
import requests

from pipelines.common.http import USER_AGENT

from .agencies import AGENCIES
from .config import GTFS_DIR, RAW, ROOT

OUTROOT = ROOT / "site" / "public" / "data" / "blink" / "agencies"
RAWROOT = RAW / "agencies"
S = requests.Session()
S.headers["User-Agent"] = USER_AGENT
PAUSE_S = 2.0                     # between downloads from the same host (BC Transit serves 35 systems from one host)
_last_host: dict[str, float] = {}

ROUTE_TYPES = {0: "tram", 1: "subway", 2: "rail", 3: "bus", 4: "ferry", 5: "cable", 6: "gondola", 7: "funicular", 11: "trolleybus", 12: "monorail"}
BANDS = [("peak", [(7 * 60, 9 * 60), (15 * 60, 18 * 60)]), ("mid", [(9 * 60, 15 * 60)]), ("eve", [(18 * 60, 24 * 60)])]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="minutes")


def warn(msg: str) -> None:
    print(f"::warning::{msg}", flush=True)


# ============================================================================= fetch

def fetch(key: str, a: dict, force: bool = False) -> tuple[Path, bool]:
    """→ (zip path, changed since the last build)"""
    d = RAWROOT / key
    d.mkdir(parents=True, exist_ok=True)
    zpath, meta_f = d / "gtfs.zip", d / "meta.json"
    meta = json.loads(meta_f.read_text()) if meta_f.exists() else {}
    age_h = (time.time() - zpath.stat().st_mtime) / 3600 if zpath.exists() else 1e9
    if key == "victoria":           # route 95's pipeline downloads Victoria's schedule daily (pipelines/blink/fetch.py)
        shared = GTFS_DIR / "latest.zip"
        if shared.exists() and (not zpath.exists() or shared.stat().st_mtime > zpath.stat().st_mtime):
            zpath.write_bytes(shared.read_bytes())
            age_h = 0
    if zpath.exists() and not force and age_h < a.get("refresh_h", 20):
        print(f"  {key}: zip is {age_h:.0f} h old; not asking again yet", flush=True)
    else:
        host = a["static"].split("/")[2]
        wait = _last_host.get(host, 0) + PAUSE_S - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_host[host] = time.time()
        h = {}
        if zpath.exists() and not force:
            if meta.get("etag"):
                h["If-None-Match"] = meta["etag"]
            if meta.get("last_modified"):
                h["If-Modified-Since"] = meta["last_modified"]
        r = S.get(a["static"], headers=h, timeout=600)
        if r.status_code == 304:
            print(f"  {key}: not modified", flush=True)
            zpath.touch()
        else:
            r.raise_for_status()
            if r.content[:2] != b"PK":
                raise ValueError(f"{key}: static GTFS response is not a zip")
            tmp = zpath.with_suffix(".part")
            tmp.write_bytes(r.content)
            tmp.replace(zpath)
            meta.update({"etag": r.headers.get("ETag"), "last_modified": r.headers.get("Last-Modified"), "downloaded": now_iso()})
            print(f"  {key}: downloaded {len(r.content) / 1e6:.1f} MB", flush=True)
    sha = hashlib.sha1(zpath.read_bytes()).hexdigest()[:12]
    changed = sha != meta.get("built_sha") or not (OUTROOT / key / "stops.json").exists()
    meta["sha"] = sha
    meta_f.write_text(json.dumps(meta, indent=1))
    return zpath, changed


def mark_built(key: str) -> None:
    meta_f = RAWROOT / key / "meta.json"
    meta = json.loads(meta_f.read_text())
    meta["built_sha"] = meta["sha"]
    meta_f.write_text(json.dumps(meta, indent=1))


# ============================================================================= read

def table(z: zipfile.ZipFile, name: str, cols: list[str] | None = None, required: bool = True) -> pd.DataFrame | None:
    path = next((n for n in z.namelist() if n.split("/")[-1] == name), None)
    if path is None:
        if required:
            raise FileNotFoundError(name)
        return None
    raw = z.read(path)
    if raw[:3] == b"\xef\xbb\xbf":
        raw = raw[3:]
    raw_head = raw[: raw.find(b"\n")].decode("utf-8", "replace").rstrip("\r").replace('"', "").split(",")
    name = {h.strip(): h for h in raw_head}           # some feeds pad header names with spaces (" feed_contact_email")
    use = [name[c] for c in (cols or list(name)) if c in name]
    t = pacsv.read_csv(io.BytesIO(raw), read_options=pacsv.ReadOptions(use_threads=True),
                       convert_options=pacsv.ConvertOptions(include_columns=use, column_types={h: "string" for h in raw_head}, strings_can_be_null=False))
    df = t.to_pandas()
    df.columns = [c.strip() for c in df.columns]
    for c in df.columns:
        df[c] = df[c].str.strip()
    return df


def to_min(s: pd.Series) -> np.ndarray:
    """'HH:MM:SS' (hours may pass 24) → minutes as float; blank → NaN"""
    parts = s.str.split(":", n=2, expand=True)
    if parts.shape[1] < 2:
        return np.full(len(s), np.nan)
    h = pd.to_numeric(parts[0], errors="coerce")
    m = pd.to_numeric(parts[1], errors="coerce")
    sec = pd.to_numeric(parts[2], errors="coerce").fillna(0) if parts.shape[1] > 2 else 0
    return (h * 60 + m + sec / 60).to_numpy(dtype=float)


# ============================================================================= service days

def pick_days(z: zipfile.ZipFile, trips: pd.DataFrame, tz: str) -> dict[str, tuple[str, set]]:
    """Typical weekday / Saturday / Sunday in the next two weeks (or the feed's own period): → {daytype: (yyyymmdd, service ids)}"""
    cal = table(z, "calendar.txt", required=False)
    cd = table(z, "calendar_dates.txt", required=False)
    per_service = trips.groupby("service_id").size()
    days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]

    def active(d: date) -> set:
        ds = d.strftime("%Y%m%d")
        s = set()
        if cal is not None and len(cal):
            c = cal[(cal.start_date <= ds) & (cal.end_date >= ds) & (cal[days[d.weekday()]] == "1")]
            s |= set(c.service_id)
        if cd is not None and len(cd):
            x = cd[cd.date == ds]
            s |= set(x[x.exception_type == "1"].service_id)
            s -= set(x[x.exception_type == "2"].service_id)
        return s

    today = datetime.now(ZoneInfo(tz)).date()
    out = {}
    for span in (14, 60, 400):
        cand = [today + timedelta(days=i) for i in range(span)]
        if span == 400:                                  # an expired or not-yet-started feed: use its own period
            starts = list(cal.start_date) if cal is not None and len(cal) else list(cd.date) if cd is not None else []
            if starts:
                s0 = datetime.strptime(min(starts), "%Y%m%d").date()
                cand = [s0 + timedelta(days=i) for i in range(60)]
        for dt, wds in (("weekday", {0, 1, 2, 3, 4}), ("sat", {5}), ("sun", {6})):
            if dt in out:
                continue
            best = None
            for d in cand:
                if d.weekday() not in wds:
                    continue
                s = active(d)
                n = int(per_service.reindex(list(s)).fillna(0).sum()) if s else 0
                if n and (best is None or n > best[0]):
                    best = (n, d, s)
            if best:
                out[dt] = (best[1].strftime("%Y-%m-%d"), best[2])
        if "weekday" in out:
            break
    return out


# ============================================================================= geometry

def rdp(pts: np.ndarray, eps: float) -> np.ndarray:
    """Douglas–Peucker on an (n, 2) array in a local metric projection (iterative)"""
    n = len(pts)
    if n < 3:
        return pts
    keep = np.zeros(n, bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = pts[i], pts[j]
        seg = pts[i + 1:j]
        ab = b - a
        L = float(np.hypot(*ab))
        if L == 0:
            d = np.hypot(*(seg - a).T)
        else:
            d = np.abs(ab[0] * (seg[:, 1] - a[1]) - ab[1] * (seg[:, 0] - a[0])) / L
        k = int(np.argmax(d))
        if d[k] > eps:
            m = i + 1 + k
            keep[m] = True
            stack += [(i, m), (m, j)]
    return pts[keep]


def encode(lonlat: np.ndarray) -> list[int]:
    """flat [x0, y0, dx1, dy1, …] in 1e-5 degrees"""
    q = np.round(lonlat * 1e5).astype(np.int64)
    d = np.vstack([q[:1], np.diff(q, axis=0)])
    return d.ravel().tolist()


def simplify(lonlat: np.ndarray, tol_m: float = 15) -> np.ndarray:
    lat0 = float(np.nanmean(lonlat[:, 1]))
    kx, ky = 111320 * math.cos(math.radians(lat0)), 110540
    xy = np.column_stack([lonlat[:, 0] * kx, lonlat[:, 1] * ky])
    s = rdp(xy, tol_m)
    return np.column_stack([s[:, 0] / kx, s[:, 1] / ky])


# ============================================================================= build

def hexcol(v: str | None, dflt: str) -> str:
    v = (v or "").strip().lstrip("#")
    return f"#{v.lower()}" if len(v) == 6 and all(c in "0123456789abcdefABCDEF" for c in v) else dflt


def build(key: str, a: dict, zpath: Path) -> dict:
    z = zipfile.ZipFile(zpath)
    agency = table(z, "agency.txt")
    tz = (agency.agency_timezone.iloc[0] if "agency_timezone" in agency else None) or a.get("tz", "UTC")
    info = table(z, "feed_info.txt", required=False)
    routes = table(z, "routes.txt", ["route_id", "route_short_name", "route_long_name", "route_type", "route_color", "route_text_color", "route_sort_order"])
    trips = table(z, "trips.txt", ["route_id", "service_id", "trip_id", "direction_id", "shape_id", "trip_headsign"])
    for c in ("direction_id", "shape_id", "trip_headsign"):
        if c not in trips:
            trips[c] = ""
    trips["direction_id"] = trips.direction_id.replace("", "0")
    days = pick_days(z, trips, tz)
    if not days:
        raise ValueError("no service found in the feed's calendar")
    svc = {dt: s for dt, (_, s) in days.items()}
    dtrips = {dt: set(trips.trip_id[trips.service_id.isin(s)]) for dt, s in svc.items()}
    anyday = set().union(*dtrips.values())

    # stop_times: only trips running on one of the three days, times as minutes, blanks filled within the trip
    st = table(z, "stop_times.txt", ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"])
    st = st[st.trip_id.isin(anyday)].copy()
    tcol = st.departure_time.where(st.departure_time != "", st.get("arrival_time", st.departure_time))
    st["t"] = to_min(tcol)
    st["seq"] = pd.to_numeric(st.stop_sequence, errors="coerce")
    st = st.drop(columns=[c for c in ("arrival_time", "departure_time", "stop_sequence") if c in st]).sort_values(["trip_id", "seq"])
    if st.t.isna().any():
        st["t"] = st.groupby("trip_id", sort=False)["t"].ffill()
        st["t"] = st.t.fillna(st.groupby("trip_id", sort=False)["t"].bfill())
    st = st.dropna(subset=["t"])
    tr = trips.set_index("trip_id")
    st["route_id"] = tr.route_id.reindex(st.trip_id).to_numpy()
    st["dir"] = tr.direction_id.reindex(st.trip_id).to_numpy()

    # ---------------------------------------------------------------- routes
    used = routes[routes.route_id.isin(trips.route_id[trips.trip_id.isin(anyday)])].copy()
    used["rt"] = pd.to_numeric(used.route_type, errors="coerce").fillna(3).astype(int)
    used["rt"] = used.rt.where(used.rt < 100, used.rt.map(lambda v: 2 if 100 <= v < 200 else 3 if 200 <= v < 300 or 700 <= v < 800 else 1 if 400 <= v < 500 else 0 if 900 <= v < 1000 else 4 if 1000 <= v < 1300 else 3))
    so = pd.to_numeric(used.get("route_sort_order", pd.Series(index=used.index, dtype=str)), errors="coerce")
    num = pd.to_numeric(used.route_short_name.str.extract(r"^(\d+)")[0], errors="coerce")
    used = used.assign(_so=so.fillna(1e9), _num=num.fillna(1e9)).sort_values(["_so", "rt", "_num", "route_short_name", "route_long_name"])
    ridx = {rid: i for i, rid in enumerate(used.route_id)}

    first = st.drop_duplicates("trip_id")                     # each trip's first timed stop (sorted by seq above)
    wd = dtrips.get("weekday", set())
    shapes = table(z, "shapes.txt", ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"], required=False)
    if shapes is not None and len(shapes):
        shapes["seq"] = pd.to_numeric(shapes.shape_pt_sequence, errors="coerce")
        shapes = shapes.sort_values(["shape_id", "seq"])
        sgroups = {sid: g for sid, g in shapes.groupby("shape_id", sort=False)}
    else:
        sgroups = {}
    stops = table(z, "stops.txt", ["stop_id", "stop_code", "stop_name", "stop_lat", "stop_lon", "location_type", "parent_station", "platform_code"])
    stops["lat"] = pd.to_numeric(stops.stop_lat, errors="coerce")
    stops["lon"] = pd.to_numeric(stops.stop_lon, errors="coerce")
    sll = stops.set_index("stop_id")[["lon", "lat"]]

    # per-trip flags computed once: isin() on Arrow strings costs ~0.1 s a call, far too slow inside the route loop
    tday = trips[trips.trip_id.isin(anyday)].copy()
    tday["wd"] = tday.trip_id.isin(wd).to_numpy()
    tday["sa"] = tday.trip_id.isin(dtrips.get("sat", set())).to_numpy()
    tday["su"] = tday.trip_id.isin(dtrips.get("sun", set())).to_numpy()
    by_route = {rid: g for rid, g in tday.groupby("route_id", sort=False)}
    fstart = first.set_index("trip_id").t
    tlen = st.groupby("trip_id", sort=False).size()
    out_routes, out_shapes = [], []
    for r in used.itertuples(index=False):
        rtrips = by_route.get(r.route_id, tday.iloc[:0])
        dirs = []
        for dirv, g in rtrips.groupby("direction_id"):
            gw = g[g.wd]
            ref = gw if len(gw) else g
            head = ref.trip_headsign[ref.trip_headsign != ""].mode()
            # the most used shape; without shapes.txt, the stop sequence of the longest trip
            line = None
            sh = ref.shape_id[ref.shape_id != ""].mode()
            if len(sh) and sh.iloc[0] in sgroups:
                sgp = sgroups[sh.iloc[0]]
                line = np.column_stack([pd.to_numeric(sgp.shape_pt_lon, errors="coerce"), pd.to_numeric(sgp.shape_pt_lat, errors="coerce")])
            else:
                lens = tlen.reindex(ref.trip_id.to_numpy()).dropna()
                tid = lens.idxmax() if len(lens) else None
                if tid is not None:
                    seqs = st[st.trip_id == tid].stop_id
                    line = sll.reindex(seqs).to_numpy()
            si = None
            if line is not None:
                line = line[~np.isnan(line).any(axis=1)]
                if len(line) >= 2:
                    si = len(out_shapes)
                    out_shapes.append(encode(simplify(line)))
            starts = fstart.reindex(gw.trip_id.to_numpy()).dropna().to_numpy()
            hours = np.bincount(np.clip((starts // 60).astype(int), 0, 29), minlength=30)[:30].tolist() if len(starts) else [0] * 30
            while len(hours) > 24 and hours[-1] == 0:
                hours.pop()
            dirs.append({"dir": int(dirv) if str(dirv).isdigit() else 0, "h": head.iloc[0] if len(head) else "",
                         "shape": si, "wd": hours,
                         "sa": int(g.sa.sum()), "su": int(g.su.sum())})
        out_routes.append({"id": r.route_id, "s": r.route_short_name or "", "l": r.route_long_name or "", "t": int(r.rt),
                           "c": hexcol(r.route_color, ""), "tc": hexcol(r.route_text_color, ""), "d": dirs})

    # ---------------------------------------------------------------- stops: departures and gaps by day type and band
    rows = []
    for dt in ("weekday", "sat", "sun"):
        ids = dtrips.get(dt)
        if not ids:
            continue
        x = st[st.trip_id.isin(ids)][["stop_id", "route_id", "dir", "t"]].copy()
        x["dt"] = dt
        rows.append(x)
    X = pd.concat(rows, ignore_index=True)
    X = X[X.route_id.isin(ridx)].sort_values(["stop_id", "route_id", "dir", "dt", "t"])
    keys = ["stop_id", "route_id", "dir", "dt"]
    X["gap"] = X.groupby(keys, sort=False)["t"].diff(-1).abs()
    X["band"] = ""
    tt = X.t % 1440
    for name, spans in BANDS:
        m = np.zeros(len(X), bool)
        for lo, hi in spans:
            m |= (tt >= lo).to_numpy() & (tt < hi).to_numpy()
        X.loc[m, "band"] = name
    agg = X.groupby(keys, sort=False).agg(n=("t", "size"), f=("t", "min"), l=("t", "max")).reset_index()
    hw = X[X.band != ""].groupby(keys + ["band"], sort=False)["gap"].median().unstack("band")
    agg = agg.merge(hw, left_on=keys, right_index=True, how="left")
    served = set(agg.stop_id)
    per_stop: dict[str, list] = {}
    for g in agg.itertuples(index=False):
        rec = [int(g.n), int(round(g.f)), int(round(g.l))] + [(int(round(v)) if isinstance(v, float) and not math.isnan(v) else 0) for v in (getattr(g, "peak", np.nan), getattr(g, "mid", np.nan), getattr(g, "eve", np.nan))]
        per_stop.setdefault(g.stop_id, {}).setdefault((ridx[g.route_id], int(g.dir) if str(g.dir).isdigit() else 0), {})[g.dt] = rec
    out_stops = []
    S_ = stops[stops.stop_id.isin(served)].dropna(subset=["lat", "lon"])
    for s in S_.itertuples(index=False):
        rr = per_stop.get(s.stop_id, {})
        out_stops.append([s.stop_id, s.stop_name, round(float(s.lat), 5), round(float(s.lon), 5), s.stop_code if s.stop_code and s.stop_code != s.stop_id else "",
                          [[ri, d, v.get("weekday", 0), v.get("sat", 0), v.get("sun", 0)] for (ri, d), v in sorted(rr.items())]])

    lons, lats = S_.lon.to_numpy(), S_.lat.to_numpy()
    lo, hi = np.nanpercentile(lons, [0.5, 99.5]), np.nanpercentile(lats, [0.5, 99.5])
    od = OUTROOT / key
    od.mkdir(parents=True, exist_ok=True)
    version = (info.feed_version.iloc[0] if info is not None and "feed_version" in info and len(info) else "") or hashlib.sha1(zpath.read_bytes()).hexdigest()[:10]
    common = {"agency": key, "name": a["name"], "generated": now_iso(), "version": version, "tz": tz, "credit": a["credit"]}
    net = {**common, "modes": ROUTE_TYPES, "routes": out_routes, "shapes": out_shapes}
    stp = {**common, "days": {dt: d for dt, (d, _) in days.items()}, "bands": {"peak": "7–9 am & 3–6 pm", "mid": "9 am–3 pm", "eve": "6 pm–midnight"},
           "fields": ["stop_id", "name", "lat", "lon", "code", "routes: [route index, direction, weekday, sat, sun]; day = [departures, first min, last min, peak gap, midday gap, evening gap] or 0"],
           "stops": out_stops}
    for name, obj in (("network", net), ("stops", stp)):
        (od / f"{name}.json").write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    sizes = {n: (od / f"{n}.json").stat().st_size for n in ("network", "stops")}
    print(f"  {key}: {len(out_routes)} routes, {len(out_shapes)} shapes, {len(out_stops):,} stops · network {sizes['network'] / 1e3:.0f} kB, "
          f"stops {sizes['stops'] / 1e3:.0f} kB · days {', '.join(f'{k} {v[0]}' for k, v in days.items())}", flush=True)
    modes = sorted({ROUTE_TYPES.get(r["t"], "bus") for r in out_routes})
    return {"name": a["name"], "operator": a["operator"], "credit": a["credit"], "terms": a["terms"], "tz": tz, "version": version,
            "feed_start": info.feed_start_date.iloc[0] if info is not None and "feed_start_date" in info and len(info) else None,
            "feed_end": info.feed_end_date.iloc[0] if info is not None and "feed_end_date" in info and len(info) else None,
            "bbox": [round(float(lo[0]), 3), round(float(hi[0]), 3), round(float(lo[1]), 3), round(float(hi[1]), 3)],   # west, south, east, north (lo = lon range, hi = lat range)
            "routes": len(out_routes), "stops": len(out_stops), "modes": modes, "days": stp["days"], "bytes": sizes,
            "static_only": bool(a.get("static_only")), "built": now_iso()}


def main(argv: list[str]) -> int:
    force = "--force" in argv
    keys = [a for a in argv if not a.startswith("--")] or list(AGENCIES)
    OUTROOT.mkdir(parents=True, exist_ok=True)
    idx_f = OUTROOT / "index.json"
    idx = json.loads(idx_f.read_text(encoding="utf-8")) if idx_f.exists() else {"agencies": {}}
    bad = 0
    for k in keys:
        a = AGENCIES[k]
        print(f"{k}: {a['name']}", flush=True)
        try:
            zpath, changed = fetch(k, a, force)
            if changed or force or k not in idx["agencies"]:      # a lost index entry is rebuilt from the cached zip
                idx["agencies"][k] = build(k, a, zpath)
                mark_built(k)
            else:
                print(f"  {k}: schedule unchanged; keeping the built files", flush=True)
        except Exception as e:                          # one bad feed never blocks the others
            bad += 1
            warn(f"Public Transit static GTFS {k}: {e}")
            traceback.print_exc()
    idx["generated"] = now_iso()
    idx["note"] = "Built by pipelines/blink/static.py from each agency's open GTFS. bbox = [west, south, east, north]."
    idx["agencies"] = {k: idx["agencies"][k] for k in AGENCIES if k in idx["agencies"]}
    idx_f.write_text(json.dumps(idx, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(keys) - bad}/{len(keys)} agencies ok", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
