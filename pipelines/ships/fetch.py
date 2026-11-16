"""Download inputs for Waterways.

  python -m pipelines.ships.fetch daily          # the CI set: navwarns, hope (both cheap; skipped when unchanged)
  python -m pipelines.ships.fetch ais            # NOAA AIS days (reuses Salish Sea Live's cache when it has them)
  python -m pipelines.ships.fetch all

Each source runs on its own: a failure is printed (and raised as a GitHub Actions warning) and the others still run.
Live data (tides, the Fraser at Hope right now, live ships through the relay) is read by the page itself, not here.
"""
from __future__ import annotations

import json
import re
import sys
import time
import traceback
from datetime import datetime, timezone

import pandas as pd
import requests

from pipelines.common.http import USER_AGENT, get_json

from .config import (AIS_DAYS, AIS_INDEX, AIS_URL, GEOMET, HOME_BBOX, HOPE, NORMAL_YEARS, OUT, RAW, S124_URL, SALISH_AIS)

S = requests.Session()
S.headers["User-Agent"] = USER_AGENT


def clip(df: pd.DataFrame) -> pd.DataFrame:
    s, w, n, e = HOME_BBOX
    return df[df.LAT.between(s, n) & df.LON.between(w, e)].reset_index(drop=True)


# ============================================================================= NOAA AIS
def ais_available() -> list[str]:
    days = []
    y = datetime.now(timezone.utc).year
    for yy in (y - 1, y):
        r = S.get(AIS_INDEX.format(y=yy), timeout=60)
        if r.status_code == 200:
            days += re.findall(r'href="ais-(\d{4}-\d{2}-\d{2})\.csv\.zst"', r.text)
    return sorted(set(days))


def _stream_day(day: str) -> pd.DataFrame:
    """Stream one national day (~320 MB zstd CSV) and keep only the home-waters rows (no temp file)."""
    import pyarrow as pa
    import pyarrow.compute as pc
    import pyarrow.csv as pcsv
    s, w, n, e = HOME_BBOX
    cols = ["mmsi", "base_date_time", "longitude", "latitude", "sog", "vessel_name", "vessel_type", "length"]
    types = {"mmsi": pa.int64(), "base_date_time": pa.string(), "longitude": pa.float64(), "latitude": pa.float64(), "sog": pa.float64(),
             "vessel_name": pa.string(), "vessel_type": pa.float64(), "length": pa.float64()}
    with S.get(AIS_URL.format(y=day[:4], d=day), stream=True, timeout=600) as r:
        r.raise_for_status()
        stream = pa.CompressedInputStream(pa.PythonFile(r.raw, mode="r"), "zstd")
        reader = pcsv.open_csv(stream, read_options=pcsv.ReadOptions(block_size=1 << 24),
                               convert_options=pcsv.ConvertOptions(include_columns=cols, column_types=types))
        parts = []
        for batch in reader:
            m = pc.and_(pc.and_(pc.greater_equal(batch["latitude"], s), pc.less_equal(batch["latitude"], n)),
                        pc.and_(pc.greater_equal(batch["longitude"], w), pc.less_equal(batch["longitude"], e)))
            sub = batch.filter(m)
            if sub.num_rows:
                parts.append(sub)
    return pa.Table.from_batches(parts).to_pandas().rename(columns={
        "mmsi": "MMSI", "base_date_time": "BaseDateTime", "longitude": "LON", "latitude": "LAT", "sog": "SOG",
        "vessel_name": "VesselName", "vessel_type": "VesselType", "length": "Length"})


def ais(cached_only: bool = False) -> dict:
    """The latest AIS_DAYS days NOAA has published, clipped to home waters, cached as data/ships/raw/ais/<day>.parquet.
    Salish Sea Live caches a larger area for the same days; when it has a day, that copy is clipped instead of
    downloading again. Skips everything when the built page already covers the newest days.
    cached_only (`fetch ais-cached`): use only the days Salish Sea Live already has, with no download at all."""
    days = sorted(p.stem for p in SALISH_AIS.glob("*.parquet"))[-AIS_DAYS:] if cached_only else ais_available()[-AIS_DAYS:]
    if not days:
        raise RuntimeError("no AIS days found on NOAA's index pages")
    built = OUT / "typical.json"
    if built.exists() and json.loads(built.read_text(encoding="utf-8")).get("days") == days:
        print(f"  AIS: page already covers {days[0]} to {days[-1]}; nothing to do")
        return {"n": len(days), "newest": days[-1], "skipped": True}
    (RAW / "ais").mkdir(parents=True, exist_ok=True)
    got = 0
    for day in days:
        f = RAW / "ais" / f"{day}.parquet"
        if f.exists():
            continue
        t0 = time.time()
        shared = SALISH_AIS / f"{day}.parquet"
        df = clip(pd.read_parquet(shared)) if shared.exists() else _stream_day(day)
        df.to_parquet(f, index=False)
        got += 1
        print(f"  AIS {day}: {len(df):,} positions, {df.MMSI.nunique():,} vessels ({'from Salish cache' if shared.exists() else 'downloaded'}, {time.time() - t0:.0f} s)", flush=True)
    for old in (RAW / "ais").glob("*.parquet"):
        if old.stem not in days:
            old.unlink()
    print(f"  AIS: {got} new day(s); window {days[0]} to {days[-1]}", flush=True)
    return {"n": len(days), "newest": days[-1]}


# ============================================================================= Canadian Coast Guard NAVWARNs (S-124)
def navwarns() -> dict:
    """The CCG's S-124 exchange set of every active Canadian NAVWARN (~3 MB zip, refreshed about weekly). Re-downloaded
    only when its Last-Modified changes."""
    RAW.mkdir(parents=True, exist_ok=True)
    f, meta = RAW / "s124.zip", RAW / "s124.json"
    head = S.head(S124_URL, timeout=60)
    head.raise_for_status()
    lm = head.headers.get("Last-Modified")
    old = json.loads(meta.read_text(encoding="utf-8")) if meta.exists() else {}
    if f.exists() and lm and old.get("last_modified") == lm:
        print(f"  NAVWARNs: unchanged since {lm}")
        return {"last_modified": lm, "skipped": True}
    r = S.get(S124_URL, timeout=180)
    r.raise_for_status()
    f.write_bytes(r.content)
    meta.write_text(json.dumps({"last_modified": lm, "fetched": datetime.now(timezone.utc).isoformat(timespec="minutes")}), encoding="utf-8")
    print(f"  NAVWARNs: {len(r.content) / 1e6:.1f} MB, last modified {lm}")
    return {"last_modified": lm}


# ============================================================================= Fraser River at Hope (daily means)
def hope() -> dict:
    """Daily mean discharge of the Fraser at Hope for the normal period (for "how high is the river for the date").
    Refetched at most monthly: the normals barely move."""
    RAW.mkdir(parents=True, exist_ok=True)
    f = RAW / "hope_daily.parquet"
    if f.exists() and time.time() - f.stat().st_mtime < 30 * 86400:
        print("  Hope: normals cached")
        return {"skipped": True}
    rows, offset = [], 0
    y0, y1 = NORMAL_YEARS
    while True:
        j = get_json(f"{GEOMET}/hydrometric-daily-mean/items", {"f": "json", "STATION_NUMBER": HOPE, "datetime": f"{y0}-01-01/{y1}-12-31",
                                                                 "limit": 5000, "offset": offset, "properties": "DATE,DISCHARGE"}, min_interval=1.0)
        feats = j.get("features", [])
        rows += [{"date": x["properties"]["DATE"], "q": x["properties"]["DISCHARGE"]} for x in feats]
        if len(feats) < 5000:
            break
        offset += 5000
    df = pd.DataFrame(rows).dropna()
    df.to_parquet(f, index=False)
    print(f"  Hope: {len(df):,} daily means {y0}–{y1}")
    return {"n": len(df)}


SOURCES = {"ais": ais, "ais-cached": lambda: ais(cached_only=True), "navwarns": navwarns, "hope": hope}
SETS = {"daily": ["navwarns", "hope"], "all": ["navwarns", "hope", "ais"]}

if __name__ == "__main__":
    want = [s for a in (sys.argv[1:] or ["daily"]) for s in SETS.get(a, [a])]
    for name in want:
        print(f"[{name}]", flush=True)
        try:
            SOURCES[name]()
        except Exception as exc:                      # keep going: one bad source must not block the others
            traceback.print_exc()
            print(f"::warning title=Waterways {name}::{exc}")
