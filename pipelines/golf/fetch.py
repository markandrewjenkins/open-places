"""Download raw inputs for Golf Playability & Course Tier List.

  python -m pipelines.golf.fetch [daily|all|<source> ...] [--force]

osm         golf courses, holes, greens, tees, fairways, bunkers, water, woods from the BBBike OpenStreetMap extracts
            (weekly upstream; reused until OSM_MAX_AGE_DAYS old, so the daily run normally skips it)
worldcover  ESA WorldCover 10 m tree cover, cropped per region (one-off: a fixed 2021 product)
vanparks    Vancouver Park Board golf, pitch-and-putt and disc-golf facilities (opendata.vancouver.ca)
forecast    Open-Meteo hourly forecast, 7 days, for every course's weather point
climate     ECCC daily climate since 1991 for the climatology stations (incremental)
obs         ECCC hourly observations since 2016 at the backtest stations (incremental; only the current year refetches)
hindcast    Open-Meteo "previous runs": what the forecast said 1–7 days ahead, hour by hour, for the last year at the
            backtest stations (incremental)

Each source runs on its own: a failure is logged to data/golf/raw/status.json (and as a GitHub Actions warning) and
the others still run, so the page keeps its last good data for that part. No accounts or keys anywhere.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
import time
import traceback

import numpy as np
import osmium
import pandas as pd

from pipelines.common import eccc, osm_pbf
from pipelines.common.http import get_json

from . import osmgolf, worldcover
from .config import (BACKTEST_DAYS, BACKTEST_LEADS, CLIMATE_STATIONS, FORECAST_EXTRA, HOURLY_VARS, OBS_STATIONS, OPEN_METEO,
                     OPEN_METEO_PREV, OSM, OSM_MAX_AGE_DAYS, RAW, REGIONS, VAN_FACILITIES, VAN_PARKS, WEATHER_POINT_GRID)

ECCC = "https://api.weather.gc.ca/collections"
OBS_FIRST_YEAR = 2016
FORCE = False


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes")


# ============================================================================= map data

def osm() -> dict:
    info = {}
    for key, r in REGIONS.items():
        f = RAW / key / "golf.json"
        pbf = OSM / f"{r['pbf']}.osm.pbf"
        if not FORCE and f.exists() and pbf.exists() and time.time() - f.stat().st_mtime < OSM_MAX_AGE_DAYS * 86400 \
                and f.stat().st_mtime >= pbf.stat().st_mtime:
            info[key] = "cached"
            continue
        pbf = osm_pbf.download(r["pbf"], OSM, max_age_days=OSM_MAX_AGE_DAYS)
        d = osmgolf.extract(pbf, r["bbox"])
        hdr = osmium.io.Reader(str(pbf), osmium.osm.osm_entity_bits.NOTHING)
        d["extract_date"] = (hdr.header().get("osmosis_replication_timestamp") or "")[:10] or None
        hdr.close()
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(d), encoding="utf-8")
        info[key] = f"{len(d['courses'])} courses, {len(d['holes'])} holes"
    return {"newest": now_iso(), "regions": info}


def worldcover_() -> dict:
    for key, r in REGIONS.items():
        dest = RAW / key / "worldcover.npz"
        if FORCE or not dest.exists():
            worldcover.crop(r["bbox"], RAW / "worldcover", dest)
    for t in (RAW / "worldcover").glob("*.tif"):          # 125 MB of tiles; only the crops are needed from here on
        t.unlink()
    return {"newest": "2021 (fixed product)"}


def vanparks() -> dict:
    fac = get_json(VAN_FACILITIES, {"where": "facilitytype in ('Golf Courses','Disc Golf Courses')", "limit": 100}, min_interval=1)["results"]
    ids = sorted({r["parkid"] for r in fac})
    parks = get_json(VAN_PARKS, {"where": f"parkid in ({','.join(map(str, ids))})", "limit": 100,
                                 "select": "parkid,name,googlemapdest,hectare,neighbourhoodname"}, min_interval=1)["results"]
    loc = {p["parkid"]: p for p in parks}
    rows = []
    for r in fac:
        p = loc.get(r["parkid"], {})
        g = p.get("googlemapdest") or {}
        rows.append({"park": r["name"], "type": r["facilitytype"], "url": r.get("facilityurl"), "lon": g.get("lon"), "lat": g.get("lat"),
                     "neighbourhood": p.get("neighbourhoodname")})
    (RAW / "vanparks.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")
    return {"newest": now_iso(), "rows": len(rows)}


# ============================================================================= weather

def weather_points() -> list[dict]:
    """One forecast point per ~3 km cell holding at least one course (centre of its mapped outline or point)."""
    pts = {}
    for key in REGIONS:
        f = RAW / key / "golf.json"
        if not f.exists():
            continue
        for c in json.loads(f.read_text(encoding="utf-8"))["courses"]:
            if c["kind"] == "point":
                lon, lat = c["lon"], c["lat"]
            else:
                ring = max(c["rings"], key=len)
                lon, lat = float(np.mean([p[0] for p in ring])), float(np.mean([p[1] for p in ring]))
            g = WEATHER_POINT_GRID
            k = (round(round(lat / g) * g, 3), round(round(lon / g) * g, 3))
            pts.setdefault(k, {"lat": k[0], "lon": k[1], "region": key, "n": 0})["n"] += 1
    return list(pts.values())


def forecast() -> dict:
    pts = weather_points()
    if not pts:
        raise RuntimeError("no courses yet: run `fetch osm` first")
    out = []
    for a in range(0, len(pts), 50):
        chunk = pts[a:a + 50]
        d = get_json(OPEN_METEO, {"latitude": ",".join(str(p["lat"]) for p in chunk), "longitude": ",".join(str(p["lon"]) for p in chunk),
                                  "hourly": ",".join(HOURLY_VARS + FORECAST_EXTRA), "past_days": 1, "forecast_days": 8, "timezone": "UTC",
                                  "wind_speed_unit": "kmh"}, min_interval=1, timeout=180)
        d = d if isinstance(d, list) else [d]
        for p, loc in zip(chunk, d):
            out.append({**p, "model_lat": loc["latitude"], "model_lon": loc["longitude"], "elevation": loc.get("elevation"), "hourly": loc["hourly"]})
    (RAW / "forecast.json").write_text(json.dumps({"fetched": now_iso(), "points": out}), encoding="utf-8")
    return {"newest": now_iso(), "points": len(out)}


def climate() -> dict:
    newest = []
    for key, st in CLIMATE_STATIONS.items():
        for cid in st["ids"]:
            f = RAW / "climate" / f"{cid}.parquet"
            f.parent.mkdir(parents=True, exist_ok=True)
            old = pd.read_parquet(f) if f.exists() else pd.DataFrame()
            start = (old["date"].max() - pd.Timedelta(days=10)).strftime("%Y-%m-%d") if len(old) else st["since"]
            new = eccc.climate_daily(cid, start=start)
            df = pd.concat([old, new]).drop_duplicates("date", keep="last").sort_values("date") if len(old) else new
            df.to_parquet(f, index=False)
            if len(df):
                newest.append(df["date"].max())
            print(f"  {cid}: {len(df):,} days to {df['date'].max():%Y-%m-%d}" if len(df) else f"  {cid}: none", flush=True)
    return {"newest": max(newest).strftime("%Y-%m-%d") if newest else None}


def _hourly(cid: str, start: str, end: str) -> pd.DataFrame:
    rows, offset = [], 0
    props = "UTC_DATE,TEMP,DEW_POINT_TEMP,PRECIP_AMOUNT,WIND_SPEED,RELATIVE_HUMIDITY"
    while True:
        d = get_json(f"{ECCC}/climate-hourly/items", {"f": "json", "CLIMATE_IDENTIFIER": cid, "limit": 10000, "offset": offset,
                                                      "datetime": f"{start} 00:00:00/{end} 23:59:59", "properties": props,
                                                      "sortby": "UTC_DATE"}, min_interval=0.5, timeout=180)
        feats = d.get("features", [])
        rows += [f["properties"] for f in feats]
        if len(feats) < 10000:
            break
        offset += 10000
    df = pd.DataFrame(rows)
    if df.empty:
        return pd.DataFrame(columns=["time", "temp", "dew", "precip", "wind", "rh"])
    df = df.rename(columns={"UTC_DATE": "time", "TEMP": "temp", "DEW_POINT_TEMP": "dew", "PRECIP_AMOUNT": "precip", "WIND_SPEED": "wind",
                            "RELATIVE_HUMIDITY": "rh"})
    df["time"] = pd.to_datetime(df["time"], utc=True)
    return df[["time", "temp", "dew", "precip", "wind", "rh"]].drop_duplicates("time").sort_values("time")


def obs() -> dict:
    """Hourly observations by station and year; past years are fetched once, the current year every run."""
    this = dt.date.today().year
    newest = []
    ids = {s["id"] for s in OBS_STATIONS.values()} | {s["wind_from"] for s in OBS_STATIONS.values() if s.get("wind_from")}
    for cid in sorted(ids):
        for y in range(OBS_FIRST_YEAR, this + 1):
            f = RAW / "obs" / f"{cid}_{y}.parquet"
            f.parent.mkdir(parents=True, exist_ok=True)
            if f.exists() and y < this and not FORCE:
                continue
            df = _hourly(cid, f"{y}-01-01", f"{y}-12-31")
            df.to_parquet(f, index=False)
            if len(df):
                newest.append(df["time"].max())
        print(f"  {cid}: through {max(newest) if newest else '-'}", flush=True)
    return {"newest": max(newest).isoformat() if newest else None}


def hindcast() -> dict:
    """What the forecast said N days before, hour by hour (Open-Meteo previous-runs API, best-match models).

    Stored per station as one parquet; each run refetches only the last 21 days and appends."""
    v = ["temperature_2m", "precipitation", "wind_speed_10m", "wind_gusts_10m"]
    hv = ",".join(v + [f"{x}_previous_day{d}" for x in v for d in BACKTEST_LEADS])
    today = dt.date.today()
    newest = None
    for key, st in OBS_STATIONS.items():
        f = RAW / "hindcast" / f"{key}.parquet"
        f.parent.mkdir(parents=True, exist_ok=True)
        old = pd.read_parquet(f) if f.exists() else pd.DataFrame()
        start = today - dt.timedelta(days=BACKTEST_DAYS)
        if len(old) and not FORCE:
            start = max(start, (old["time"].max() - pd.Timedelta(days=21)).date())
        frames = []
        a = start
        while a <= today:                      # 92-day requests keep each response modest
            b = min(today, a + dt.timedelta(days=91))
            d = get_json(OPEN_METEO_PREV, {"latitude": st["lat"], "longitude": st["lon"], "hourly": hv, "start_date": a.isoformat(),
                                           "end_date": b.isoformat(), "timezone": "UTC", "wind_speed_unit": "kmh"}, min_interval=2, timeout=300)
            h = pd.DataFrame(d["hourly"])
            h["time"] = pd.to_datetime(h["time"], utc=True)
            frames.append(h)
            a = b + dt.timedelta(days=1)
        new = pd.concat(frames)
        df = pd.concat([old, new]).drop_duplicates("time", keep="last").sort_values("time") if len(old) else new
        df = df[df["time"] >= pd.Timestamp(today - dt.timedelta(days=BACKTEST_DAYS + 30), tz="UTC")]
        df.to_parquet(f, index=False)
        newest = df["time"].max()
        print(f"  {key}: {len(df):,} hours to {newest}", flush=True)
    return {"newest": newest.isoformat() if newest is not None else None}


# ============================================================================= CLI

SOURCES = {"osm": osm, "worldcover": worldcover_, "vanparks": vanparks, "forecast": forecast, "climate": climate, "obs": obs,
           "hindcast": hindcast}
GROUPS = {"daily": ["osm", "worldcover", "forecast", "climate", "obs", "hindcast"], "all": list(SOURCES)}


def record(name: str, ok: bool, info: dict | None = None, error: str | None = None) -> None:
    f = RAW / "status.json"
    RAW.mkdir(parents=True, exist_ok=True)
    st = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
    prev = st.get(name, {})
    st[name] = {"ok": ok, "attempted": now_iso(), "last_ok": now_iso() if ok else prev.get("last_ok"),
                "newest": (info or {}).get("newest") if ok else prev.get("newest"), "error": error}
    f.write_text(json.dumps(st, indent=1), encoding="utf-8")


def main(argv: list[str]) -> int:
    global FORCE
    for stream in (sys.stdout, sys.stderr):                 # Windows consoles: never die on a non-ASCII log line
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    FORCE = "--force" in argv                               # ignore caches (OSM age, past years of observations)
    names = []
    for a in [x for x in argv if x != "--force"] or ["daily"]:
        names += GROUPS.get(a, [a])
    if "vanparks" not in names and not (RAW / "vanparks.json").exists():
        names.append("vanparks")
    failed = []
    for name in dict.fromkeys(names):
        if name not in SOURCES:
            print(f"unknown source {name!r}; choose from {', '.join(SOURCES)} or {', '.join(GROUPS)}")
            return 2
        print(f"{name}…", flush=True)
        try:
            info = SOURCES[name]() or {}
            record(name, True, info)
        except Exception as exc:                              # keep going: one source must not block the rest
            msg = f"{type(exc).__name__}: {exc}"[:400]
            traceback.print_exc()
            record(name, False, error=msg)
            failed.append(name)
            if os.environ.get("GITHUB_ACTIONS"):
                print(f"::warning title=Golf source failed: {name}::{msg}", flush=True)
    if failed:
        print(f"finished with {len(failed)} failed source(s): {', '.join(failed)} (their last good data is kept)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
