"""Download inputs for West Coast Water.

  python -m pipelines.waves.fetch daily        # the CI set: buoys, wind obs, tides, forecasts, forecast history top-up
  python -m pipelines.waves.fetch all          # daily + the long buoy histories (NDBC annual files, MEDS archive)
  python -m pipelines.waves.fetch tides swob   # any list of sources

Each source runs on its own: a failure is logged to data/waves/raw/status.json (and as a GitHub Actions warning) and
the others still run. Every source is idempotent: finished files (past NDBC years and months, complete SWOB days,
complete forecast-history months) are cached and never fetched twice; "live" files are overwritten.

Observations are kept as hourly parquet archives in data/waves/raw/obs/<buoy>.parquet. The Canadian buoys have no
long online archive (NDBC relays ~1 day, the MSC Datamart keeps ~30 days), so the build also writes them to the
published obs_archive.json, and this script seeds the raw archive from it when raw/ is empty (fresh CI checkout).
"""
from __future__ import annotations

import gzip
import io
import json
import os
import re
import sys
import time
import traceback
import zipfile
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
import requests

from pipelines.common.http import USER_AGENT, get_json

from .config import (ARCHIVE_DAYS, BACKTEST_START, BUOYS, ECCC_API, IWLS, LEADS, MARINE_MODEL, MEDS_CSV, NDBC_HIST,
                     NDBC_MONTH, NDBC_MONTH_PRELIM, NDBC_RT, OM_FORECAST, OM_MARINE, OM_PREVIOUS, OUT, PADDLE, PERIOD_MODEL,
                     RAW, SPOTS, SWOB_DAY, TIDES, WIND_STATIONS)

S = requests.Session()
S.headers["User-Agent"] = USER_AGENT
_last: dict[str, float] = {}
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
OBS_COLS = ["hs", "tp", "tm", "dir", "wspd", "wdir", "gust", "swh", "swp", "swd", "wwh", "wwp"]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="minutes")


def get_raw(url: str, *, min_interval: float = 0.5, retries: int = 4, timeout: int = 90, ok404: bool = False) -> bytes | None:
    """Polite GET for text/binary files: per-host pacing, retries with backoff; None on 404 when ok404."""
    host = url.split("/")[2]
    for attempt in range(retries):
        wait = _last.get(host, 0) + min_interval - time.time()
        if wait > 0:
            time.sleep(wait)
        _last[host] = time.time()
        try:
            r = S.get(url, timeout=timeout)
            if r.status_code == 404 and ok404:
                return None
            if r.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(f"{r.status_code} from {url}")
            r.raise_for_status()
            return r.content
        except requests.RequestException as exc:
            if attempt == retries - 1:
                raise
            backoff = 2 ** attempt * 3
            print(f"  retry {attempt + 1} after {backoff}s: {exc}")
            time.sleep(backoff)
    return None


# ============================================================================= observation archive helpers

def obs_path(bid: str):
    return RAW / "obs" / f"{bid}.parquet"


def load_obs(bid: str) -> pd.DataFrame:
    """Raw hourly archive for one buoy; on a fresh checkout seed it from the published durable copy."""
    f = obs_path(bid)
    if f.exists():
        return pd.read_parquet(f)
    pub = OUT / "obs_archive.json"
    if pub.exists():
        try:
            d = json.loads(pub.read_text(encoding="utf-8"))
            b = d.get("buoys", {}).get(bid)
            if b:
                t0 = pd.Timestamp(d["start"])
                df = pd.DataFrame({"time": t0 + pd.to_timedelta(b["h"], unit="h")})
                for c, scale in d["fields"].items():
                    v = np.asarray(b.get(c, [None] * len(df)), dtype=float)
                    df[c] = v / scale
                print(f"  {bid}: seeded {len(df):,} hours from obs_archive.json")
                return df
        except (ValueError, KeyError) as exc:
            print(f"  {bid}: could not seed from obs_archive.json ({exc})")
    return pd.DataFrame(columns=["time"] + OBS_COLS)


def merge_obs(bid: str, new: pd.DataFrame, source: str) -> pd.DataFrame:
    """Merge hourly rows into the archive; for each hour a non-missing new value replaces an old one."""
    old = load_obs(bid)
    new = new.copy()
    new["time"] = pd.to_datetime(new.time, utc=True)
    if len(old):
        old["time"] = pd.to_datetime(old.time, utc=True)
    for c in OBS_COLS:
        for df in (old, new):
            if c not in df:
                df[c] = np.nan
    both = pd.concat([old[["time"] + OBS_COLS], new[["time"] + OBS_COLS]], ignore_index=True)
    # last non-null per hour per column (new rows come after old rows)
    merged = both.groupby("time", as_index=False).last()
    cut = pd.Timestamp.now(tz="UTC") - pd.Timedelta(days=ARCHIVE_DAYS + 30)
    if not BUOYS[bid]["history"]:                         # the NDBC-history buoy keeps everything it has
        merged = merged[merged.time >= cut]
    merged = merged.sort_values("time").reset_index(drop=True)
    obs_path(bid).parent.mkdir(parents=True, exist_ok=True)
    merged.to_parquet(obs_path(bid), index=False)
    print(f"  {bid} {BUOYS[bid]['name']}: +{len(new):,} hourly rows from {source}; archive {len(merged):,} h "
          f"({merged.time.min():%Y-%m-%d} to {merged.time.max():%Y-%m-%d %H:%M})")
    return merged


def hourly_nearest(df: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
    """One row per UTC hour: for each column, the non-missing reading nearest the top of the hour (within 30 min)."""
    out = None
    for c in cols:
        if c not in df:
            continue
        d = df[["time", c]].dropna()
        if d.empty:
            continue
        hr = d.time.dt.round("h")
        d = d.assign(hr=hr, off=(d.time - hr).abs()).sort_values("off").drop_duplicates("hr")
        part = d[["hr", c]].rename(columns={"hr": "time"})
        out = part if out is None else out.merge(part, on="time", how="outer")
    return out.sort_values("time").reset_index(drop=True) if out is not None else pd.DataFrame(columns=["time"])


# ============================================================================= NOAA NDBC

COMPASS = {k: i * 22.5 for i, k in enumerate("N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW".split())}


def parse_ndbc(text: str) -> pd.DataFrame:
    """Parse an NDBC stdmet / spec text file (realtime or historical) into a raw-resolution frame."""
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        return pd.DataFrame()
    header = lines[0].lstrip("#").split()
    rows = [ln.split() for ln in lines if not ln.startswith("#") and not ln.startswith("YY")]
    rows = [r for r in rows if len(r) == len(header)]
    df = pd.DataFrame(rows, columns=header)
    ycol = "YY" if "YY" in df else "YYYY"
    y = df[ycol].astype(int)
    y = y.where(y > 100, y + 1900)
    mm = df["mm"] if "mm" in df else "00"
    df["time"] = pd.to_datetime(y.astype(str) + "-" + df["MM"] + "-" + df["DD"] + " " + df["hh"] + ":" + mm, utc=True,
                                format="%Y-%m-%d %H:%M", errors="coerce")
    for c in df.columns:
        if c not in ("time", "SwD", "WWD", "STEEPNESS"):
            df[c] = pd.to_numeric(df[c].replace({"MM": None, "99.0": None, "99.00": None, "999": None, "999.0": None,
                                                 "9999.0": None}), errors="coerce")
    return df.dropna(subset=["time"])


def ndbc_frame(std: pd.DataFrame | None, spec: pd.DataFrame | None = None) -> pd.DataFrame:
    parts = []
    if std is not None and len(std):
        w = pd.DataFrame({"time": std.time})
        g = lambda c: std[c] if c in std else np.nan   # noqa: E731
        w["hs"], w["tp"], w["tm"], w["dir"] = g("WVHT"), g("DPD"), g("APD"), g("MWD")
        w["wspd"], w["gust"], w["wdir"] = g("WSPD") * 3.6, g("GST") * 3.6, g("WDIR")
        # NDBC fills: 99 m, 99 s, 999 deg
        for c, bad in (("hs", 98), ("tp", 98), ("tm", 98), ("dir", 361), ("wdir", 361), ("wspd", 300), ("gust", 300)):
            w.loc[w[c] >= bad, c] = np.nan
        parts.append(hourly_nearest(w, ["hs", "tp", "tm", "dir", "wspd", "gust", "wdir"]))
    if spec is not None and len(spec):
        s = pd.DataFrame({"time": spec.time, "swh": spec.get("SwH"), "swp": spec.get("SwP"),
                          "swd": spec.get("SwD").map(COMPASS) if "SwD" in spec else np.nan,
                          "wwh": spec.get("WWH"), "wwp": spec.get("WWP")})
        parts.append(hourly_nearest(s, ["swh", "swp", "swd", "wwh", "wwp"]))
    if not parts:
        return pd.DataFrame(columns=["time"])
    out = parts[0]
    for p in parts[1:]:
        out = out.merge(p, on="time", how="outer")
    return out


def ndbc_realtime() -> dict:
    """Last 45 days (46087) / ~1 day (Canadian buoys relayed by NDBC) of standard met + swell/wind-wave split."""
    newest, failed = {}, []
    for bid, b in BUOYS.items():
        if not b["ndbc"]:
            continue
        try:
            std = parse_ndbc(get_raw(NDBC_RT.format(id=bid, ext="txt"), min_interval=1.0).decode("latin1"))
            spec = None
            if b["spec"]:
                raw = get_raw(NDBC_RT.format(id=bid, ext="spec"), min_interval=1.0, ok404=True)
                spec = parse_ndbc(raw.decode("latin1")) if raw else None
            m = merge_obs(bid, ndbc_frame(std, spec), "NDBC realtime2")
            newest[bid] = m.dropna(subset=["hs"]).time.max()
        except Exception as exc:                               # one buoy down must not stop the others
            print(f"  {bid}: NDBC realtime failed: {exc}")
            failed.append(bid)
    if len(failed) == sum(1 for b in BUOYS.values() if b["ndbc"]):
        raise RuntimeError(f"NDBC realtime failed for every buoy: {failed}")
    return {"newest": max(v for v in newest.values() if pd.notna(v)).isoformat() if newest else None,
            "per_buoy": {k: (v.isoformat() if pd.notna(v) else None) for k, v in newest.items()}, "failed": failed}


def ndbc_recent() -> dict:
    """Just the files the backtest window needs (BACKTEST_START's year onwards): ~12 small files, for the daily CI run."""
    return ndbc_history(start_year=int(BACKTEST_START[:4]))


def ndbc_history(start_year: int = 2004) -> dict:
    """46087's annual files (2004 to last year, final) and this year's monthly files. Cached forever once final."""
    out = {}
    for bid, b in BUOYS.items():
        if not b["history"]:
            continue
        cache = RAW / "ndbc_hist" / bid
        cache.mkdir(parents=True, exist_ok=True)
        this_year = datetime.now(timezone.utc).year
        frames = []
        for y in range(start_year, this_year):
            f = cache / f"{y}.txt.gz"
            miss = cache / f"{y}.missing"
            if not f.exists() and not miss.exists():
                raw = get_raw(NDBC_HIST.format(id=bid, y=y), min_interval=1.0, ok404=True)
                if raw is None:
                    miss.write_text("404", encoding="utf-8")
                    continue
                f.write_bytes(raw)
            if f.exists():
                frames.append(parse_ndbc(gzip.decompress(f.read_bytes()).decode("latin1")))
        for i, mon in enumerate(MONTHS[: datetime.now(timezone.utc).month], start=1):
            code = str(i) if i < 10 else "abc"[i - 10]
            f = cache / f"{this_year}-{i:02d}.txt.gz"
            if not f.exists():
                raw = get_raw(NDBC_MONTH.format(mon=mon, id=bid, m=code, y=this_year), min_interval=1.0, ok404=True)
                if raw is not None:
                    f.write_bytes(raw)                        # gzipped monthly file = final
                else:
                    prelim = get_raw(NDBC_MONTH_PRELIM.format(mon=mon, id=bid), min_interval=1.0, ok404=True)
                    if prelim is not None:                    # preliminary: use, don't cache as final
                        frames.append(parse_ndbc(prelim.decode("latin1")))
                    continue
            frames.append(parse_ndbc(gzip.decompress(f.read_bytes()).decode("latin1")))
        std = pd.concat([x for x in frames if len(x)], ignore_index=True).drop_duplicates("time")
        hist = ndbc_frame(std)
        m = merge_obs(bid, hist, "NDBC history")
        out[bid] = {"from": m.time.min().isoformat(), "to": m.time.max().isoformat(), "hours": len(m)}
    return {"newest": max(v["to"] for v in out.values()) if out else None, "buoys": out}


# ============================================================================= ECCC MSC Datamart SWOB-ML (Canadian buoys)

SWOB_MAP = {"hs": ["spetrl_sig_wave_hgt_pst20mts", "avg_sig_wave_hgt_pst20mts", "sig_wave_hgt_pst20mts"],
            "tp": ["pk_wave_pd_pst20mts"],
            "tm": ["avg_spetrl_wave_pd_pst20mts", "avg_wave_pd_pst20mts"],
            "dir": ["avg_wave_dir_pst20mts", "avg_pk_wave_dir_pst20mts"],
            "wspd": ["avg_wnd_spd_pst10mts"], "wdir": ["avg_wnd_dir_pst10mts"],
            "gust": ["max_wnd_spd_pst10mts", "max_avg_wnd_spd_pst10mts"]}
ELEM = re.compile(r'<element name="([^"]+)" uom="[^"]*" value="([^"]*)"')


def parse_swob(xml: str) -> dict:
    vals = dict(ELEM.findall(xml))
    row = {"time": vals.get("date_tm")}
    for k, names in SWOB_MAP.items():
        row[k] = next((float(vals[n]) for n in names if vals.get(n) not in (None, "", "MSNG")), np.nan)
    return row


def swob(days: int = 30) -> dict:
    """Hourly SWOB-ML records for the Canadian buoys from the Datamart's dated folders (about 30 days online).
    Only the first file of each hour is read (waves are reported hourly). Complete UTC days are cached per buoy."""
    today = datetime.now(timezone.utc).date()
    newest, n_files = {}, 0
    for bid, b in BUOYS.items():
        sid = b.get("swob")
        if not sid:
            continue
        cache = RAW / "swob" / sid
        cache.mkdir(parents=True, exist_ok=True)
        rows = []
        for k in range(days, -1, -1):
            d = today - timedelta(days=k)
            f = cache / f"{d:%Y%m%d}.json"
            if f.exists() and d < today:
                rows += json.loads(f.read_text(encoding="utf-8"))
                continue
            url = SWOB_DAY.format(d=f"{d:%Y%m%d}", sid=sid)
            listing = get_raw(url, min_interval=0.2, ok404=True)
            if listing is None:
                continue
            names = sorted(set(re.findall(r'href="([^"]+-swob\.xml)"', listing.decode("utf-8", "replace"))))
            first = {}
            for nm in names:                                 # 2026-11-11-0005-4600206-AUTO-swob.xml → hour 00
                first.setdefault(nm[11:13], nm)
            day_rows = []
            for nm in first.values():
                xml = get_raw(url + nm, min_interval=0.15, ok404=True)
                n_files += 1
                if xml:
                    day_rows.append(parse_swob(xml.decode("utf-8", "replace")))
            if d < today and (len(day_rows) >= 20 or d < today - timedelta(days=2)):   # complete, or old enough to be final
                f.write_text(json.dumps(day_rows, allow_nan=True), encoding="utf-8")
            rows += day_rows
        if not rows:
            print(f"  {bid}: no SWOB files found")
            continue
        df = pd.DataFrame(rows)
        df["time"] = pd.to_datetime(df.time, utc=True, errors="coerce").dt.round("h")
        df = df.dropna(subset=["time"]).drop_duplicates("time", keep="last")
        m = merge_obs(bid, df, "MSC Datamart SWOB")
        newest[bid] = m.dropna(subset=["hs"]).time.max()
    if not newest:
        raise RuntimeError("no SWOB data for any buoy")
    print(f"  SWOB: {n_files} files fetched this run")
    return {"newest": max(newest.values()).isoformat(), "files_fetched": n_files}


# ============================================================================= DFO MEDS archive (climatology only)

def meds(max_age_days: int = 180) -> dict:
    """Full MEDS wave archive for La Perouse and Halibut Bank (1988/1992 to 2022/2023). Refreshed twice a year."""
    out = {}
    for bid, b in BUOYS.items():
        mid = b.get("meds")
        if not mid:
            continue
        d = RAW / "meds"
        d.mkdir(parents=True, exist_ok=True)
        z = d / f"{mid}_csv.zip"
        if not z.exists() or (time.time() - z.stat().st_mtime) > max_age_days * 86400:
            raw = get_raw(MEDS_CSV.format(id=mid), min_interval=2.0, timeout=600)
            if raw[:2] != b"PK":
                raise RuntimeError(f"MEDS {mid}: not a zip file")
            z.write_bytes(raw)
        with zipfile.ZipFile(z) as zf:
            txt = zf.read(zf.namelist()[0]).decode("latin1")
        df = pd.read_csv(io.StringIO(txt), low_memory=False)
        # duplicate column names (two anemometers): pandas suffixes the second with .1; keep the first
        t = pd.to_datetime(df["DATE"], format="%m/%d/%Y %H:%M", utc=True, errors="coerce")
        res = pd.DataFrame({"time": t.dt.round("h"), "q": pd.to_numeric(df["Q_FLAG"], errors="coerce"),
                            "hs": pd.to_numeric(df["VCAR"], errors="coerce"), "tp": pd.to_numeric(df["VTPK"], errors="coerce"),
                            "wspd": pd.to_numeric(df["WSPD"], errors="coerce") * 3.6, "wdir": pd.to_numeric(df["WDIR"], errors="coerce")})
        res = res[(res.q.isin([0, 1])) & res.hs.between(0, 25) & res.tp.between(1, 30)].dropna(subset=["time"])
        res = res.drop_duplicates("time").sort_values("time").drop(columns="q")
        res.to_parquet(d / f"{bid}.parquet", index=False)
        out[bid] = {"from": res.time.min().isoformat(), "to": res.time.max().isoformat(), "hours": len(res)}
        print(f"  MEDS {mid}: {len(res):,} hourly records {res.time.min():%Y-%m-%d} to {res.time.max():%Y-%m-%d}")
    return {"newest": max(v["to"] for v in out.values()), "buoys": out}


# ============================================================================= ECCC climate-hourly wind

def eccc_wind() -> dict:
    """Hourly wind at the coastal ECCC stations since the backtest start (incremental)."""
    d = RAW / "wind_obs"
    d.mkdir(parents=True, exist_ok=True)
    newest, failed = {}, []
    start = (pd.Timestamp(BACKTEST_START) - pd.Timedelta(days=3)).strftime("%Y-%m-%d")
    for cid, st in WIND_STATIONS.items():
        if st.get("kind") != "eccc":
            continue
        f = d / f"{cid}.parquet"
        old = pd.read_parquet(f) if f.exists() else pd.DataFrame(columns=["time", "wspd", "wdir"])
        since = (pd.to_datetime(old.time, utc=True).max() - pd.Timedelta(days=3)).strftime("%Y-%m-%d") if len(old) else start
        rows, offset = [], 0
        try:
            while True:
                j = get_json(f"{ECCC_API}/climate-hourly/items",
                             {"f": "json", "CLIMATE_IDENTIFIER": cid, "datetime": f"{since}/..", "limit": 5000, "offset": offset,
                              "properties": "UTC_DATE,WIND_SPEED,WIND_DIRECTION", "sortby": "UTC_DATE"}, min_interval=0.5)
                feats = j.get("features", [])
                rows += [x["properties"] for x in feats]
                if len(feats) < 5000:
                    break
                offset += 5000
        except Exception as exc:
            print(f"  {cid} {st['name']}: failed: {exc}")
            failed.append(cid)
            continue
        new = pd.DataFrame(rows)
        if len(new):
            new = pd.DataFrame({"time": pd.to_datetime(new.UTC_DATE, utc=True), "wspd": pd.to_numeric(new.WIND_SPEED, errors="coerce"),
                                "wdir": pd.to_numeric(new.WIND_DIRECTION, errors="coerce") * 10})
            new.loc[new.wdir == 0, "wdir"] = np.nan              # 0 = calm / variable
        if len(old):
            old["time"] = pd.to_datetime(old.time, utc=True)
        allw = pd.concat([old, new], ignore_index=True).drop_duplicates("time", keep="last").sort_values("time")
        allw.to_parquet(f, index=False)
        ok = allw.dropna(subset=["wspd"])
        newest[cid] = ok.time.max() if len(ok) else None
        print(f"  {cid} {st['name']}: {len(allw):,} hours, {len(ok):,} with wind, newest {newest[cid]}")
    if len(failed) == sum(1 for s in WIND_STATIONS.values() if s.get("kind") == "eccc"):
        raise RuntimeError("ECCC climate-hourly failed for every station")
    good = [v for v in newest.values() if v is not None]
    return {"newest": max(good).isoformat() if good else None, "failed": failed}


# ============================================================================= DFO IWLS tides

def tides(days: int = 9) -> dict:
    """Hourly tide predictions and high/low times, from yesterday to `days` ahead, per station."""
    t0 = (datetime.now(timezone.utc) - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    t1 = t0 + timedelta(days=days + 1)
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    out, failed = {}, []
    for code, st in TIDES.items():
        try:
            base = f"{IWLS}/stations/{st['id']}/data"
            hourly = get_json(base, {"time-series-code": "wlp", "from": t0.strftime(fmt), "to": t1.strftime(fmt),
                                     "resolution": "SIXTY_MINUTES"}, min_interval=1.0)
            hilo = get_json(base, {"time-series-code": "wlp-hilo", "from": t0.strftime(fmt), "to": t1.strftime(fmt)}, min_interval=1.0)
            out[code] = {"hourly": [[x["eventDate"], x["value"]] for x in hourly],
                         "hilo": [[x["eventDate"], x["value"]] for x in hilo]}
            print(f"  tides {code} {st['name']}: {len(hourly)} hourly, {len(hilo)} highs/lows")
        except Exception as exc:
            print(f"  tides {code} {st['name']}: failed: {exc}")
            failed.append(code)
    if not out:
        raise RuntimeError("IWLS failed for every station")
    RAW.mkdir(parents=True, exist_ok=True)
    (RAW / "tides.json").write_text(json.dumps({"fetched": now_iso(), "stations": out}), encoding="utf-8")
    return {"newest": now_iso(), "failed": failed}


# ============================================================================= Open-Meteo forecasts

MARINE_VARS = ["wave_height", "wave_direction", "wave_period", "swell_wave_height", "swell_wave_direction", "swell_wave_period",
               "wind_wave_height", "wind_wave_direction", "wind_wave_period", "secondary_swell_wave_height",
               "secondary_swell_wave_period", "secondary_swell_wave_direction", "sea_surface_temperature"]
WIND_VARS = ["wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "temperature_2m", "precipitation", "weather_code"]


def forecast_points() -> dict:
    """Marine points: every buoy (the rules' driver), every surf spot and the exposed paddle spots.
    Wind points: every surf and paddle spot (local wind matters, not the buoy's)."""
    marine = {f"buoy:{k}": (b["lat"], b["lon"]) for k, b in BUOYS.items()}
    marine |= {f"spot:{k}": (s["lat"], s["lon"]) for k, s in SPOTS.items()}
    marine |= {f"paddle:{k}": p["marine"] for k, p in PADDLE.items() if p["marine"]}
    wind = {f"spot:{k}": (s["lat"], s["lon"]) for k, s in SPOTS.items()}
    wind |= {f"paddle:{k}": (p["lat"], p["lon"]) for k, p in PADDLE.items()}
    return {"marine": marine, "wind": wind}


def _multi(url: str, pts: dict, params: dict) -> dict:
    """One Open-Meteo request for many locations (comma-separated lat/lon); returns {name: response}."""
    names = list(pts)
    j = get_json(url, {"latitude": ",".join(f"{pts[n][0]:.4f}" for n in names),
                       "longitude": ",".join(f"{pts[n][1]:.4f}" for n in names), "timezone": "UTC", **params},
                 min_interval=1.0, timeout=120)
    if isinstance(j, dict):
        j = [j]
    return dict(zip(names, j))


def forecast() -> dict:
    """8-day hourly marine + wind forecasts. Each run is also archived (raw/fc_archive/) so later backtests can use
    the swell partitions, which Open-Meteo's previous-runs archive doesn't keep."""
    pts = forecast_points()
    marine = _multi(OM_MARINE, pts["marine"], {"hourly": ",".join(MARINE_VARS), "models": MARINE_MODEL,
                                               "forecast_days": 8, "past_days": 1})
    peak = _multi(OM_MARINE, pts["marine"], {"hourly": "wave_peak_period", "models": PERIOD_MODEL, "forecast_days": 8, "past_days": 1})
    for k in marine:
        marine[k]["hourly"]["wave_peak_period"] = peak[k]["hourly"]["wave_peak_period"]
        marine[k]["peak_grid"] = [peak[k]["latitude"], peak[k]["longitude"]]
    wind = _multi(OM_FORECAST, pts["wind"], {"hourly": ",".join(WIND_VARS), "forecast_days": 8, "past_days": 1,
                                            "wind_speed_unit": "kmh"})
    doc = {"fetched": now_iso(), "marine_model": MARINE_MODEL, "period_model": PERIOD_MODEL, "marine": marine, "wind": wind}
    RAW.mkdir(parents=True, exist_ok=True)
    (RAW / "forecast.json").write_text(json.dumps(doc), encoding="utf-8")
    arch = RAW / "fc_archive"
    arch.mkdir(exist_ok=True)
    with gzip.open(arch / f"{datetime.now(timezone.utc):%Y-%m-%d}.json.gz", "wt", encoding="utf-8") as fh:
        json.dump(doc, fh)                                    # one per UTC day: a re-run the same day overwrites it
    n = len(next(iter(marine.values()))["hourly"]["time"])
    print(f"  forecast: {len(marine)} marine points, {len(wind)} wind points, {n} hours; archived "
          f"({len(list(arch.glob('*.json.gz')))} days in fc_archive)")
    return {"newest": now_iso()}


def _months(start: str) -> list[tuple[str, str, bool]]:
    """(first, last, final) per calendar month from start to today; final = the month (plus 8 days) is over."""
    out, d = [], pd.Timestamp(start).normalize()
    today = pd.Timestamp.now(tz="UTC").tz_localize(None).normalize()
    while d <= today:
        end = min(d + pd.offsets.MonthEnd(0), today)
        out.append((d.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d"), (today - end).days > 8))
        d = end + pd.Timedelta(days=1)
    return out


def forecast_history() -> dict:
    """Open-Meteo previous-runs archive: what the forecast said 0–7 days ahead, hour by hour, since BACKTEST_START.
      marine at each buoy: Hs, mean direction, mean period (best_match) + peak period (ECMWF WAM)
      wind at each ECCC wind station and buoy: speed, direction, gust (best_match)
    Finished months are cached; the current month is re-fetched each run."""
    d = RAW / "fc_hist"
    d.mkdir(parents=True, exist_ok=True)
    mpts = {k: (b["lat"], b["lon"]) for k, b in BUOYS.items()}
    wpts = {k: (s["lat"], s["lon"]) for k, s in WIND_STATIONS.items()}
    lv = lambda v: [v] + [f"{v}_previous_day{n}" for n in LEADS if n > 0]   # noqa: E731
    jobs = [("marine", OM_MARINE, mpts, {"hourly": ",".join(lv("wave_height") + lv("wave_direction") + lv("wave_period")),
                                         "models": MARINE_MODEL}),
            ("peak", OM_MARINE, mpts, {"hourly": ",".join(lv("wave_peak_period")), "models": PERIOD_MODEL}),
            ("wind", OM_PREVIOUS, wpts, {"hourly": ",".join(lv("wind_speed_10m") + lv("wind_direction_10m") + lv("wind_gusts_10m")),
                                         "wind_speed_unit": "kmh"})]
    n_req = 0
    for first, last, final in _months(BACKTEST_START):
        for name, url, pts, params in jobs:
            f = d / f"{name}_{first[:7]}.json"
            if f.exists() and final:
                cached = json.loads(f.read_text(encoding="utf-8"))
                if cached.get("final") and set(cached.get("points", {})) == set(pts):
                    continue                                  # finished month with the current point set
            res = _multi(url, pts, {**params, "start_date": first, "end_date": last})
            n_req += 1
            slim = {k: {"lat": v["latitude"], "lon": v["longitude"], "hourly": v["hourly"]} for k, v in res.items()}
            f.write_text(json.dumps({"final": final, "first": first, "last": last, "points": slim}), encoding="utf-8")
    print(f"  forecast history: {n_req} requests this run; {len(list(d.glob('*.json')))} month files cached")
    return {"newest": now_iso(), "requests": n_req}


# ============================================================================= CLI

SOURCES = {"ndbc_realtime": ndbc_realtime, "ndbc_recent": ndbc_recent, "swob": swob, "eccc_wind": eccc_wind, "tides": tides, "forecast": forecast,
           "forecast_history": forecast_history, "ndbc_history": ndbc_history, "meds": meds}
GROUPS = {"daily": ["ndbc_realtime", "ndbc_recent", "swob", "eccc_wind", "tides", "forecast", "forecast_history"],
          "all": [k for k in SOURCES if k != "ndbc_recent"]}


def record(name: str, ok: bool, info: dict | None = None, error: str | None = None) -> None:
    f = RAW / "status.json"
    RAW.mkdir(parents=True, exist_ok=True)
    st = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
    prev = st.get(name, {})
    info = info or {}
    entry = {"ok": ok, "attempted": now_iso(), "last_ok": now_iso() if ok else prev.get("last_ok"),
             "newest": info.get("newest") or (prev.get("newest") if not ok else None), "error": error}
    if info.get("failed"):
        entry["partial"] = info["failed"]                       # sub-sources (buoys / stations) that failed
    st[name] = entry
    f.write_text(json.dumps(st, indent=1, default=str), encoding="utf-8")


def main(argv: list[str]) -> int:
    for stream in (sys.stdout, sys.stderr):                     # Windows consoles: never die on a non-ASCII log line
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    names = []
    for a in argv or ["daily"]:
        names += GROUPS.get(a, [a])
    failed = []
    for name in names:
        if name not in SOURCES:
            print(f"unknown source {name!r}; choose from {', '.join(SOURCES)} or {', '.join(GROUPS)}")
            return 2
        print(f"{name}…", flush=True)
        try:
            info = SOURCES[name]() or {}
            record(name, True, info)
            if info.get("failed") and os.environ.get("GITHUB_ACTIONS"):
                print(f"::warning title=Waves source partly failed: {name}::{info['failed']}", flush=True)
        except Exception as exc:                                  # keep going: one source must not block the rest
            msg = f"{type(exc).__name__}: {exc}"[:400]
            traceback.print_exc()
            record(name, False, error=msg)
            failed.append(name)
            print(f"::warning title=Waves source failed: {name}::{msg}", flush=True)
    if failed:
        print(f"finished with {len(failed)} failed source(s): {', '.join(failed)} (their last good data is kept)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
