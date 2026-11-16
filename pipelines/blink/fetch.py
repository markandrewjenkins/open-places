"""Download the slow-changing inputs for Blink 95 Reliability (the realtime feeds are logged by collect.py).

  python -m pipelines.blink.fetch [gtfs|weather|osm|all]

gtfs     BC Transit Victoria static GTFS (~15 MB zip, at most once every 20 h). Only the logged routes are kept, as
         parquet in data/blink/raw/gtfs/<version>/. A new folder is made only when the filtered schedule changes, so
         old logs are always matched to the timetable that was in force; calendar_dates are merged across downloads.
weather  Open-Meteo hourly weather for the logged period (archive + recent + 7-day forecast) at View Royal.
osm      Bus-lane and road-name tags along the logged routes from the BBBike Victoria extract (refreshed monthly).

Each source runs on its own: a failure is written to data/blink/raw/status.json (and as a GitHub Actions warning)
and the others still run; the build keeps the last good data.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import sys
import time
import traceback
import zipfile
from datetime import date, datetime, timedelta, timezone

import pandas as pd
import requests

from pipelines.common.http import USER_AGENT, get_json

from . import logio
from .config import GTFS_DIR, GTFS_STATIC, LAT, LON, RAW, ROOT, ROUTE_IDS, TZ

S = requests.Session()
S.headers["User-Agent"] = USER_AGENT


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="minutes")


# ============================================================================= static GTFS

def _read(z: zipfile.ZipFile, name: str, **kw) -> pd.DataFrame:
    with z.open(name) as f:
        return pd.read_csv(f, encoding="utf-8-sig", dtype=str, **kw)


def gtfs(force: bool = False) -> dict:
    GTFS_DIR.mkdir(parents=True, exist_ok=True)
    zpath = GTFS_DIR / "latest.zip"
    if zpath.exists() and not force and time.time() - zpath.stat().st_mtime < 20 * 3600:
        print("  static GTFS downloaded less than 20 h ago; reusing it", flush=True)
        blob = zpath.read_bytes()
    else:
        r = S.get(GTFS_STATIC, timeout=300)
        r.raise_for_status()
        blob = r.content
        if blob[:2] != b"PK":
            raise ValueError("static GTFS response is not a zip")
        tmp = zpath.with_suffix(".part")
        tmp.write_bytes(blob)
        tmp.replace(zpath)
        print(f"  downloaded static GTFS ({len(blob) / 1e6:.1f} MB)", flush=True)
    z = zipfile.ZipFile(io.BytesIO(blob))
    info = _read(z, "feed_info.txt").iloc[0].to_dict()
    routes = _read(z, "routes.txt")
    routes = routes[routes.route_id.isin(ROUTE_IDS.values())]
    trips = _read(z, "trips.txt")
    trips = trips[trips.route_id.isin(routes.route_id)]
    keep = set(trips.trip_id)
    parts = []
    with z.open("stop_times.txt") as f:                       # ~90 MB: stream in chunks, keep only our trips
        for ch in pd.read_csv(f, encoding="utf-8-sig", dtype=str, chunksize=500_000):
            parts.append(ch[ch.trip_id.isin(keep)])
    st = pd.concat(parts, ignore_index=True)
    stops = _read(z, "stops.txt")
    stops = stops[stops.stop_id.isin(set(st.stop_id))]
    shapes = _read(z, "shapes.txt")
    shapes = shapes[shapes.shape_id.isin(set(trips.shape_id))]
    cal = _read(z, "calendar_dates.txt")
    cal = cal[cal.service_id.isin(set(trips.service_id))]
    if "calendar.txt" in z.namelist():                       # expand weekly calendars into dates if ever published
        c = _read(z, "calendar.txt")
        c = c[c.service_id.isin(set(trips.service_id))]
        days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
        rows = []
        for r_ in c.itertuples(index=False):
            for d in pd.date_range(r_.start_date, r_.end_date):
                if getattr(r_, days[d.dayofweek]) == "1":
                    rows.append({"service_id": r_.service_id, "date": d.strftime("%Y%m%d"), "exception_type": "1"})
        cal = pd.concat([pd.DataFrame(rows), cal], ignore_index=True)

    h = hashlib.sha1()
    for df in (trips.drop(columns=["service_id"]).sort_values("trip_id"), st.sort_values(["trip_id", "stop_sequence"])):
        h.update(pd.util.hash_pandas_object(df, index=False).values.tobytes())
    sig = h.hexdigest()[:10]
    vdir = next((d for d in GTFS_DIR.iterdir() if d.is_dir() and d.name.endswith(sig)), None)
    new = vdir is None
    if new:
        vdir = GTFS_DIR / f"{info.get('feed_start_date', date.today().strftime('%Y%m%d'))}_{sig}"
        vdir.mkdir()
        for name, df in [("routes", routes), ("trips", trips), ("stop_times", st), ("stops", stops), ("shapes", shapes)]:
            df.to_parquet(vdir / f"{name}.parquet", index=False)
    calf = vdir / "calendar_dates.parquet"
    if calf.exists():
        cal = pd.concat([pd.read_parquet(calf), cal]).drop_duplicates(["service_id", "date"], keep="last")
    cal.to_parquet(calf, index=False)
    meta_f = vdir / "meta.json"
    meta = json.loads(meta_f.read_text()) if meta_f.exists() else {"first_seen": now_iso()}
    meta.update({"last_seen": now_iso(), "feed_version": info.get("feed_version"), "feed_start_date": info.get("feed_start_date"),
                 "feed_end_date": info.get("feed_end_date"), "publisher": info.get("feed_publisher_name")})
    meta_f.write_text(json.dumps(meta, indent=1))
    n95 = int((trips.route_id == "95-VIC").sum())
    print(f"  {'new' if new else 'unchanged'} schedule version {vdir.name}: {len(trips):,} trips ({n95:,} on route 95), "
          f"{len(st):,} stop times, service {cal.date.min()}..{cal.date.max()}", flush=True)
    return {"newest": info.get("feed_version"), "version": vdir.name, "new": new}


# ============================================================================= weather

HOURLY = "temperature_2m,precipitation,rain,snowfall,wind_speed_10m,wind_gusts_10m,weather_code,visibility"


def _om_frame(d: dict) -> pd.DataFrame:
    h = d["hourly"]
    df = pd.DataFrame(h).rename(columns={"time": "t"})
    df["t"] = pd.to_datetime(df.t)                           # local wall-clock time (timezone=America/Vancouver)
    return df


def weather() -> dict:
    """Hourly weather from the first logged day to 7 days ahead. Older days come from the ERA5/ECMWF archive
    (about 5 days behind), recent days and the forecast from the forecast API (GEM where available)."""
    ds = logio.days()
    start = date.fromisoformat(ds[0]) if ds else date.today() - timedelta(days=7)
    frames = []
    recent_from = date.today() - timedelta(days=10)
    if start < recent_from:
        a = get_json("https://archive-api.open-meteo.com/v1/archive", {
            "latitude": LAT, "longitude": LON, "hourly": HOURLY, "timezone": TZ,
            "start_date": start.isoformat(), "end_date": (recent_from - timedelta(days=1)).isoformat()}, min_interval=1)
        frames.append(_om_frame(a).assign(src="archive"))
    past = max(1, min(92, (date.today() - max(start, recent_from)).days + 1))
    f = get_json("https://api.open-meteo.com/v1/forecast", {
        "latitude": LAT, "longitude": LON, "hourly": HOURLY, "timezone": TZ, "past_days": past, "forecast_days": 8},
        min_interval=1)
    frames.append(_om_frame(f).assign(src="forecast"))
    df = pd.concat(frames).drop_duplicates("t", keep="last").sort_values("t").reset_index(drop=True)
    old = RAW / "weather_hourly.parquet"
    if old.exists():                                          # keep history beyond the API windows
        prev = pd.read_parquet(old)
        prev = prev[prev.t < df.t.min()]
        df = pd.concat([prev, df]).sort_values("t").reset_index(drop=True)
    RAW.mkdir(parents=True, exist_ok=True)
    df.to_parquet(old, index=False)
    now = pd.Timestamp.now(tz=TZ).tz_localize(None)
    print(f"  weather: {len(df):,} hours {df.t.min():%Y-%m-%d} .. {df.t.max():%Y-%m-%d} "
          f"({int((df.t > now).sum())} forecast hours)", flush=True)
    return {"newest": str(df[df.t <= now].t.max())}


# ============================================================================= OSM corridor tags

def osm() -> dict:
    """Ways near the logged routes with their road name, class and bus-lane tags, from the Victoria extract.
    Uses the shared monorepo cache data/osm/Victoria.osm.pbf when present (read-only), else downloads into raw/."""
    import osmium

    from pipelines.common.osm_pbf import download

    out = RAW / "osm_ways.parquet"
    if out.exists() and time.time() - out.stat().st_mtime < 30 * 86400:
        print("  OSM corridor tags less than 30 days old; reusing them", flush=True)
        return {"newest": datetime.fromtimestamp(out.stat().st_mtime, timezone.utc).isoformat(timespec="minutes")}
    shared = ROOT / "data" / "osm" / "Victoria.osm.pbf"
    pbf = shared if shared.exists() else download("Victoria", RAW)
    from .network import latest_version, load_version
    sh = load_version(latest_version())["shapes"]
    lat, lon = sh.shape_pt_lat.astype(float), sh.shape_pt_lon.astype(float)
    s_, w_, n_, e_ = lat.min() - 0.01, lon.min() - 0.01, lat.max() + 0.01, lon.max() + 0.01
    BUS_KEYS = ("busway", "busway:left", "busway:right", "busway:both", "lanes:bus", "lanes:psv", "bus:lanes",
                "bus:lanes:forward", "bus:lanes:backward", "psv:lanes", "psv:lanes:forward", "psv:lanes:backward",
                "lanes:bus:forward", "lanes:bus:backward", "lanes:psv:forward", "lanes:psv:backward", "hov:lanes",
                "hov:lanes:forward", "hov:lanes:backward")

    rows = []

    class H(osmium.SimpleHandler):
        def way(self, w):
            hw = w.tags.get("highway")
            if hw is None or hw in ("footway", "path", "cycleway", "steps", "pedestrian", "track", "bridleway", "service"):
                if not (hw == "busway" or w.tags.get("highway") == "busway"):
                    return
            try:
                pts = [(n.lat, n.lon) for n in w.nodes]
            except osmium.InvalidLocationError:
                return
            if not pts or not any(s_ <= a <= n_ and w_ <= b <= e_ for a, b in pts):
                return
            tags = {k: w.tags.get(k) for k in BUS_KEYS if w.tags.get(k)}
            bus = hw == "busway" or any(("bus" in v or "designated" in v or "lane" in v) and "no" != v
                                        for k, v in tags.items() if k.startswith(("busway", "lanes:", "bus:", "psv:", "hov:")))
            hov = any(k.startswith("hov") for k in tags)
            rows.append({"way": w.id, "name": w.tags.get("name") or w.tags.get("ref") or "", "ref": w.tags.get("ref") or "",
                         "highway": hw, "bus_lane": bool(bus), "hov": bool(hov), "oneway": w.tags.get("oneway") or "",
                         "tags": json.dumps(tags) if tags else "",
                         "lats": [round(a, 6) for a, _ in pts], "lons": [round(b, 6) for _, b in pts]})

    H().apply_file(str(pbf), locations=True)
    df = pd.DataFrame(rows)
    df.to_parquet(out, index=False)
    print(f"  OSM: {len(df):,} road ways near the routes, {int(df.bus_lane.sum())} tagged with bus/HOV lanes", flush=True)
    return {"newest": now_iso()}


# ============================================================================= main

SOURCES = {"gtfs": gtfs, "weather": weather, "osm": osm}
GROUPS = {"all": ["gtfs", "osm", "weather"], "daily": ["gtfs", "weather"]}


def record(name: str, ok: bool, info: dict | None = None, error: str | None = None) -> None:
    f = RAW / "status.json"
    RAW.mkdir(parents=True, exist_ok=True)
    st = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
    prev = st.get(name, {})
    st[name] = {"ok": ok, "attempted": now_iso(), "last_ok": now_iso() if ok else prev.get("last_ok"),
                "newest": (info or {}).get("newest") or (prev.get("newest") if not ok else None), "error": error}
    f.write_text(json.dumps(st, indent=1), encoding="utf-8")


def main(argv: list[str]) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    names = []
    for a in argv or ["all"]:
        names += GROUPS.get(a, [a])
    failed = []
    for name in names:
        if name not in SOURCES:
            print(f"unknown source {name!r}; choose from {', '.join(SOURCES)} or {', '.join(GROUPS)}")
            return 2
        print(f"{name}…", flush=True)
        try:
            record(name, True, SOURCES[name]() or {})
        except Exception as exc:
            msg = f"{type(exc).__name__}: {exc}"[:400]
            traceback.print_exc()
            record(name, False, error=msg)
            failed.append(name)
            if os.environ.get("GITHUB_ACTIONS"):
                print(f"::warning title=Blink source failed: {name}::{msg}", flush=True)
    if failed:
        print(f"finished with {len(failed)} failed source(s): {', '.join(failed)} (their last good data is kept)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
