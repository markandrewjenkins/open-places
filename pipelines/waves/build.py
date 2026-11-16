"""West Coast Water: hourly spot ratings for the next 7 days, tiered best windows, calm-water windows, a forecast-vs-buoy
backtest by lead time, and a monthly climatology.

  python -m pipelines.waves.build

Ratings
    Per surf spot: score = 100 × size × period × direction × wind × tide (pipelines/waves/model.py, numbers in
    config.SPOTS). Swell inputs are the forecast AT THE DRIVER BUOY (total Hs, ECMWF WAM peak period, mean wave
    direction) so the same rule can be checked against the buoy. Wind is forecast at the beach; tide is the DFO
    prediction at the nearest station. Daylight (civil dawn to dusk) hours only count towards windows.
Backtest
    Open-Meteo's previous-runs archive gives, for every past hour, what each of the last 8 daily runs predicted.
    Lead N = the run from N days before. Compared with the buoys (Hs, peak period, mean period, direction) and the
    ECCC coastal wind stations (speed, direction): bias, MAE, RMSE, n, and Hs persistence as a no-skill baseline.
    Go/no-go: the spot rule (tide left out: predictions add no forecast error) applied to forecast and observed
    inputs; a GO day has ≥ 2 daylight hours at B or better. Accuracy, probability of detection, false-alarm ratio.
Outputs (site/public/data/waves/)
    waves.json (page data), forecast.json (hourly arrays), tides.json, obs_recent.json (14 days of buoy and wind
    observations), backtest.json (metrics + chart series), obs_archive.json (durable copy of the Canadian buoys'
    hourly record, which has no long online archive; read back by fetch.py on a fresh checkout, not by the page).
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from .config import (ARCHIVE_DAYS, BACKTEST_START, BUOYS, GO_SCORE, LEADS, LICENCES, MARINE_MODEL, OUT, PADDLE,
                     PERIOD_MODEL, RAW, SPOTS, TIDES, TIERS, TZ, WIND_CALM, WIND_K_OFF, WIND_K_ON, WIND_STATIONS,
                     WINDOW_MIN, WINDOW_MIN_HOURS)
from .model import angdiff, daylight_mask, onshore_share, paddle_factors, surf_factors, tier

HORIZON_H = 168


# ============================================================================= helpers

def clean(o):
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return clean(o.tolist())
    if isinstance(o, (bool, np.bool_)):
        return bool(o)
    if isinstance(o, (float, np.floating)):
        return None if not np.isfinite(o) else round(float(o), 4)
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, (pd.Timestamp, datetime)):
        return o.isoformat()
    if o is pd.NA or o is pd.NaT:
        return None
    return o


def dump(name, obj):
    f = OUT / name
    f.parent.mkdir(parents=True, exist_ok=True)
    with open(f, "w", encoding="utf-8") as fh:
        json.dump(clean(obj), fh, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    print(f"  wrote {name} ({f.stat().st_size / 1024:,.0f} KB)")


def read_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default
    except ValueError:
        return default


def col(a, nd=1):
    """Array → JSON list, rounded, NaN → None."""
    a = np.asarray(a, dtype=float)
    return [None if not np.isfinite(v) else (round(float(v), nd) if nd else int(round(float(v)))) for v in a]


def iso(t) -> str:
    return pd.Timestamp(t).strftime("%Y-%m-%dT%H:%MZ")


def wind_label(spd, wdir, facing) -> str:
    if spd is None or not np.isfinite(spd):
        return "unknown"
    if spd <= WIND_CALM:
        return "light"
    if wdir is None or not np.isfinite(wdir):
        return "unknown direction"
    o = float(onshore_share(wdir, facing))
    return "offshore" if o < 0.25 else ("cross-shore" if o < 0.75 else "onshore")


def compass(d) -> str | None:
    if d is None or not np.isfinite(d):
        return None
    return "N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW".split()[int((d % 360) / 22.5 + 0.5) % 16]


# ============================================================================= inputs

def load_obs(bid: str) -> pd.DataFrame:
    f = RAW / "obs" / f"{bid}.parquet"
    if not f.exists():
        return pd.DataFrame(columns=["time"])
    df = pd.read_parquet(f)
    df["time"] = pd.to_datetime(df.time, utc=True)
    # sanity limits (sensor glitches)
    for c, lo, hi in (("hs", 0, 20), ("tp", 1, 30), ("tm", 1, 25), ("wspd", 0, 200), ("gust", 0, 250)):
        if c in df:
            df.loc[~df[c].between(lo, hi), c] = np.nan
    return df.set_index("time").sort_index()


def load_wind_obs(cid: str) -> pd.DataFrame:
    if WIND_STATIONS.get(cid, {}).get("kind") == "buoy":
        o = load_obs(cid)
        return o[["wspd", "wdir"]] if "wspd" in o else pd.DataFrame(columns=["wspd", "wdir"])
    f = RAW / "wind_obs" / f"{cid}.parquet"
    if not f.exists():
        return pd.DataFrame(columns=["wspd", "wdir"])
    df = pd.read_parquet(f)
    df["time"] = pd.to_datetime(df.time, utc=True)
    return df.set_index("time").sort_index()


def load_fc_hist(kind: str) -> dict[str, pd.DataFrame]:
    """{point: DataFrame(time × variables)} from the cached monthly previous-runs files."""
    parts: dict[str, list] = {}
    for f in sorted((RAW / "fc_hist").glob(f"{kind}_*.json")):
        d = read_json(f, {})
        for pt, v in (d.get("points") or {}).items():
            h = pd.DataFrame(v["hourly"])
            h["time"] = pd.to_datetime(h.time, utc=True)
            parts.setdefault(pt, []).append(h.set_index("time"))
    return {pt: pd.concat(fr).sort_index().loc[lambda x: ~x.index.duplicated(keep="last")] for pt, fr in parts.items()}


def lead_col(var: str, lead: int) -> str:
    return var if lead == 0 else f"{var}_previous_day{lead}"


def hourly_frame(resp: dict) -> pd.DataFrame:
    h = pd.DataFrame(resp["hourly"])
    h["time"] = pd.to_datetime(h.time, utc=True)
    return h.set_index("time")


def tide_frames(tdoc: dict) -> dict:
    out = {}
    for code, st in (tdoc or {}).get("stations", {}).items():
        h = pd.DataFrame(st["hourly"], columns=["time", "level"])
        h["time"] = pd.to_datetime(h.time, utc=True)
        h = h.set_index("time").sort_index()
        lo, hi = h.level.min(), h.level.max()
        h["p"] = (h.level - lo) / (hi - lo) if hi > lo else 0.5
        h["rising"] = h.level.diff().shift(-1) > 0
        out[code] = {"hourly": h, "hilo": st["hilo"]}
    return out


def tide_state(p, rising) -> str | None:
    if p is None or not np.isfinite(p):
        return None
    lvl = "low" if p < 0.33 else ("mid" if p < 0.67 else "high")
    return f"{lvl}, {'rising' if rising else 'falling'}"


# ============================================================================= live ratings

def live_spot(key: str, spot: dict, fc: dict, tides: dict, hours: pd.DatetimeIndex) -> pd.DataFrame:
    m = hourly_frame(fc["marine"][f"buoy:{spot['buoy']}"]).reindex(hours)
    near = hourly_frame(fc["marine"][f"spot:{key}"]).reindex(hours)
    w = hourly_frame(fc["wind"][f"spot:{key}"]).reindex(hours)
    df = pd.DataFrame(index=hours)
    df["hs"], df["dir"] = m.wave_height, m.wave_direction
    df["tp"] = m.wave_peak_period.fillna(m.swell_wave_period)       # ECMWF peak period; MFWAM swell period if absent
    df["swh"], df["swp"], df["swd"] = m.swell_wave_height, m.swell_wave_period, m.swell_wave_direction
    df["wwh"], df["wwp"] = m.wind_wave_height, m.wind_wave_period
    df["sw2h"], df["sw2p"], df["sw2d"] = m.secondary_swell_wave_height, m.secondary_swell_wave_period, m.secondary_swell_wave_direction
    df["hs_near"], df["sst"] = near.wave_height, near.sea_surface_temperature
    df["wspd"], df["wdir"], df["gust"] = w.wind_speed_10m, w.wind_direction_10m, w.wind_gusts_10m
    df["temp"], df["precip"], df["wcode"] = w.temperature_2m, w.precipitation, w.weather_code
    t = tides.get(spot["tide"])
    if t:
        th = t["hourly"].reindex(hours)
        df["tide"], df["tide_p"], df["rising"] = th.level, th.p, th.rising
    else:
        df["tide"], df["tide_p"], df["rising"] = np.nan, np.nan, np.nan
    fac = surf_factors(spot, df.hs, df.tp, df.dir, df.wspd, df.wdir, df.tide_p.to_numpy(dtype=float))
    for k, v in fac.items():
        df[k if k == "score" else f"f_{k}"] = v
    df["day"] = daylight_mask(hours, spot["lat"], spot["lon"], TZ)
    return df


def live_paddle(key: str, p: dict, fc: dict, tides: dict, hours: pd.DatetimeIndex) -> pd.DataFrame:
    w = hourly_frame(fc["wind"][f"paddle:{key}"]).reindex(hours)
    df = pd.DataFrame(index=hours)
    df["wspd"], df["wdir"], df["gust"] = w.wind_speed_10m, w.wind_direction_10m, w.wind_gusts_10m
    df["temp"], df["precip"], df["wcode"] = w.temperature_2m, w.precipitation, w.weather_code
    if p["marine"]:
        m = hourly_frame(fc["marine"][f"paddle:{key}"]).reindex(hours)
        df["hs"], df["sst"] = m.wave_height, m.sea_surface_temperature
    else:
        df["hs"], df["sst"] = np.nan, np.nan
    t = tides.get(p["tide"])
    df["tide"] = t["hourly"].level.reindex(hours) if t else np.nan
    fac = paddle_factors(p, df.wspd, df.gust, df.hs)
    for k, v in fac.items():
        df[k if k == "score" else f"f_{k}"] = v
    df["day"] = daylight_mask(hours, p["lat"], p["lon"], TZ)
    return df


def windows(key: str, df: pd.DataFrame, now: pd.Timestamp, kind: str, meta: dict, trust: dict) -> list[dict]:
    """Contiguous daylight runs at C or better (≥ WINDOW_MIN) lasting ≥ WINDOW_MIN_HOURS."""
    ok = (df.day & (df.score >= WINDOW_MIN)).to_numpy()
    out, i, n = [], 0, len(df)
    while i < n:
        if not ok[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and ok[j + 1]:
            j += 1
        seg = df.iloc[i:j + 1]
        if len(seg) >= WINDOW_MIN_HOURS:
            pk = seg.score.idxmax()
            r = seg.loc[pk]
            top = float(np.sort(seg.score.to_numpy())[-3:].mean())
            lead = int((seg.index[0].tz_convert(TZ).normalize() - now.tz_convert(TZ).normalize()).days)
            tr = trust.get(lead) or {}
            w = {"kind": kind, "spot": key, "name": meta["name"], "region": meta.get("region") or meta.get("area"),
                 "start": iso(seg.index[0]), "end": iso(seg.index[-1] + pd.Timedelta(hours=1)), "hours": len(seg),
                 "peak": round(float(r.score), 1), "peak_time": iso(pk), "score": round(top, 1), "tier": tier(top),
                 "go_hours": int((seg.score >= GO_SCORE).sum()), "lead_days": lead,
                 "trust": {k: tr.get(k) for k in ("accuracy", "hss", "pod", "far", "n_days")}}
            if kind == "surf":
                w |= {"hs": r.hs, "tp": r.tp, "dir": r.dir, "dir_compass": compass(r.dir), "swh": r.swh, "swp": r.swp,
                      "swd": r.swd, "wspd": r.wspd, "wdir": r.wdir, "wind": wind_label(r.wspd, r.wdir, meta["facing"]),
                      "tide": tide_state(r.tide_p, bool(r.rising) if pd.notna(r.rising) else False), "drive": meta["drive"],
                      "limiting": min(("size", "period", "dir", "wind", "tide"), key=lambda k: r[f"f_{k}"])}
            else:
                w |= {"wspd_max": seg.wspd.max(), "gust_max": seg.gust.max(),
                      "hs_max": seg.hs.max() if seg.hs.notna().any() else None}
            out.append(w)
        i = j + 1
    return out


def daily(df: pd.DataFrame, now: pd.Timestamp, trust: dict, days: int = 7) -> list[dict]:
    d = df[df.day].copy()
    d["date"] = d.index.tz_convert(TZ).date
    today = now.tz_convert(TZ).date()
    out = []
    for k in range(days):
        day = (pd.Timestamp(today) + pd.Timedelta(days=k)).date()
        g = d[d.date == day]
        if g.empty or g.score.isna().all():
            out.append({"date": str(day), "lead": k, "best": None, "tier": None})
            continue
        pk = g.score.idxmax()
        tr = trust.get(k) or {}
        out.append({"date": str(day), "lead": k, "best": round(float(g.score.max()), 1), "tier": tier(g.score.max()),
                    "best_time": iso(pk), "go_hours": int((g.score >= GO_SCORE).sum()), "ok_hours": int((g.score >= WINDOW_MIN).sum()),
                    "go": bool((g.score >= GO_SCORE).sum() >= WINDOW_MIN_HOURS), "trust": tr.get("accuracy")})
    return out


# ============================================================================= backtest

def metrics(fc: pd.Series, ob: pd.Series, circular: bool = False) -> dict:
    j = pd.concat([fc.rename("f"), ob.rename("o")], axis=1).dropna()
    if len(j) < 24:
        return {"n": int(len(j))}
    if circular:
        e = ((j.f - j.o + 180) % 360) - 180
        return {"n": int(len(j)), "bias": float(e.mean()), "mae": float(e.abs().mean()), "rmse": float(np.sqrt((e ** 2).mean()))}
    e = j.f - j.o
    return {"n": int(len(j)), "bias": float(e.mean()), "mae": float(e.abs().mean()), "rmse": float(np.sqrt((e ** 2).mean())),
            "rel_bias": float(e.mean() / j.o.mean()) if j.o.mean() else None, "corr": float(j.f.corr(j.o)), "obs_mean": float(j.o.mean())}


def go_days(score: pd.Series, day: pd.Series) -> pd.DataFrame:
    """Per local date: matched daylight hours, best score, GO (≥ WINDOW_MIN_HOURS daylight hours ≥ GO_SCORE)."""
    s = score[day.reindex(score.index).fillna(False).to_numpy(dtype=bool)].dropna()
    key = s.index.tz_convert(TZ).normalize().tz_localize(None).date
    g = pd.DataFrame({"s": s.to_numpy(), "go": (s >= GO_SCORE).to_numpy()}, index=key).groupby(level=0)
    return pd.DataFrame({"n": g.s.size(), "best": g.s.max(), "go": g.go.sum() >= WINDOW_MIN_HOURS})


def contingency(f: pd.Series, o: pd.Series) -> dict:
    hits = int((f & o).sum())
    miss = int((~f & o).sum())
    fa = int((f & ~o).sum())
    cn = int((~f & ~o).sum())
    n = hits + miss + fa + cn
    return {"n_days": n, "hits": hits, "misses": miss, "false_alarms": fa, "correct_no": cn,
            "accuracy": (hits + cn) / n if n else None,
            # Heidke skill score: accuracy above what random guessing at the same rates would get (0 = no skill, 1 = perfect)
            "hss": (2 * (hits * cn - fa * miss) / ((hits + miss) * (miss + cn) + (hits + fa) * (fa + cn)))
                   if ((hits + miss) * (miss + cn) + (hits + fa) * (fa + cn)) else None, "pod": hits / (hits + miss) if hits + miss else None,
            "far": fa / (hits + fa) if hits + fa else None, "base_rate": (hits + miss) / n if n else None,
            "fc_rate": (hits + fa) / n if n else None}


def backtest(now: pd.Timestamp) -> dict:
    mar, peak, wnd = load_fc_hist("marine"), load_fc_hist("peak"), load_fc_hist("wind")
    t0 = pd.Timestamp(BACKTEST_START, tz="UTC")
    obs = {b: load_obs(b) for b in BUOYS}
    wobs = {c: load_wind_obs(c) for c in WIND_STATIONS}
    res = {"start": BACKTEST_START, "leads": LEADS, "buoys": {}, "wind": {}, "spots": {}, "paddle": {}, "series": {}, "spot_days": {}}

    # ---- variables at the buoys
    for bid, b in BUOYS.items():
        o = obs[bid].loc[lambda x: (x.index >= t0) & (x.index <= now)]
        fm, fp = mar.get(bid), peak.get(bid)
        if fm is None or o.empty:
            res["buoys"][bid] = {"name": b["name"], "n_obs": int(len(o)), "note": "no overlap"}
            continue
        per = {}
        for L in LEADS:
            f = fm.reindex(o.index)
            fpk = fp.reindex(o.index) if fp is not None else None
            lag = 24 * L + 12
            persist = o.hs.shift(lag, freq="h").reindex(o.index)
            per[L] = {"hs": metrics(f[lead_col("wave_height", L)], o.hs),
                      "hs_persistence": metrics(persist, o.hs),
                      "tp": metrics(fpk[lead_col("wave_peak_period", L)], o.tp) if fpk is not None else {"n": 0},
                      "tm": metrics(f[lead_col("wave_period", L)], o.tm),
                      "dir": metrics(f[lead_col("wave_direction", L)], o.dir, circular=True)}
        ob_hs = o.hs.dropna()
        res["buoys"][bid] = {"name": b["name"], "obs_from": ob_hs.index.min(), "obs_to": ob_hs.index.max(), "n_obs": int(len(ob_hs)),
                             "by_lead": per}
        # chart series: last 60 days, 3-hourly, obs vs lead 1/3/5
        s = o.loc[o.index >= now - pd.Timedelta(days=60)]
        f = fm.reindex(s.index)
        s3 = pd.DataFrame({"obs": s.hs, **{f"d{L}": f[lead_col("wave_height", L)] for L in (1, 3, 5)}})
        s3 = s3[s3.index.hour % 3 == 0]
        res["series"][bid] = {"t0": iso(s3.index[0]) if len(s3) else None, "step_h": 3,
                              "t": [int((t - s3.index[0]).total_seconds() // 3600) for t in s3.index],
                              **{k: col(s3[k], 2) for k in s3.columns}}

    # ---- wind at the coastal stations
    for cid, st in WIND_STATIONS.items():
        o = wobs[cid].loc[lambda x: (x.index >= t0) & (x.index <= now)]
        fw = wnd.get(cid)
        if fw is None or o.empty:
            res["wind"][cid] = {"name": st["name"], "note": "no overlap"}
            continue
        f = fw.reindex(o.index)
        strong = o.wspd > 10
        res["wind"][cid] = {"name": st["name"], "n_obs": int(o.wspd.notna().sum()),
                            "by_lead": {L: {"wspd": metrics(f[lead_col("wind_speed_10m", L)], o.wspd),
                                            "wdir": metrics(f[lead_col("wind_direction_10m", L)][strong], o.wdir[strong], circular=True)}
                                        for L in LEADS}}

    # ---- go/no-go per surf spot
    for key, sp in SPOTS.items():
        o, ow = obs[sp["buoy"]], wobs[sp["wind_station"]]
        fm, fp, fw = mar.get(sp["buoy"]), peak.get(sp["buoy"]), wnd.get(sp["wind_station"])
        if fm is None or fw is None or o.empty or ow.empty:
            res["spots"][key] = {"note": "no overlap"}
            continue
        j = pd.concat([o[["hs", "tp", "dir"]], ow[["wspd", "wdir"]].add_prefix("w_")], axis=1, sort=True)
        j = j[(j.index >= t0) & (j.index <= now)].dropna(subset=["hs", "tp", "dir", "w_wspd"])
        if j.empty:
            res["spots"][key] = {"note": "no matched hours"}
            continue
        day = pd.Series(daylight_mask(j.index, sp["lat"], sp["lon"], TZ), index=j.index)
        ob_score = pd.Series(surf_factors(sp, j.hs, j.tp, j.dir, j.w_wspd, j.w_wdir)["score"], index=j.index)
        od = go_days(ob_score, day)
        od = od[od.n >= 4]
        by, days_tab = {}, {"date": [str(d) for d in od.index], "obs": col(od.best, 0)}
        for L in LEADS:
            f, fpk, fww = fm.reindex(j.index), (fp.reindex(j.index) if fp is not None else None), fw.reindex(j.index)
            tp = fpk[lead_col("wave_peak_period", L)] if fpk is not None else f[lead_col("wave_period", L)]
            fs = pd.Series(surf_factors(sp, f[lead_col("wave_height", L)], tp, f[lead_col("wave_direction", L)],
                                        fww[lead_col("wind_speed_10m", L)], fww[lead_col("wind_direction_10m", L)])["score"],
                           index=j.index)
            fd = go_days(fs.where(ob_score.notna()), day).reindex(od.index)
            ok = fd.best.notna()
            c = contingency(fd.go[ok].astype(bool), od.go[ok].astype(bool))
            c["best_mae"] = float((fd.best[ok] - od.best[ok]).abs().mean()) if ok.any() else None
            c["tier_exact"] = float(np.mean([tier(a) == tier(b) for a, b in zip(fd.best[ok], od.best[ok])])) if ok.any() else None
            hr = pd.concat([fs.rename("f"), ob_score.rename("o")], axis=1)[day.to_numpy()].dropna()
            c["hour_agree"] = float(((hr.f >= GO_SCORE) == (hr.o >= GO_SCORE)).mean()) if len(hr) else None
            by[L] = c
            if L in (1, 3, 5):
                days_tab[f"d{L}"] = col(fd.best, 0)
        res["spots"][key] = {"name": sp["name"], "buoy": sp["buoy"], "wind_station": sp["wind_station"],
                             "matched_hours": int(len(j)), "days": int(len(od)), "by_lead": by}
        res["spot_days"][key] = days_tab

    # ---- go/no-go per paddle spot (wind; waves where a buoy checks them; gusts not observed hourly, so left out)
    for key, p in PADDLE.items():
        ow, fw = wobs[p["wind_station"]], wnd.get(p["wind_station"])
        if fw is None or ow.empty:
            res["paddle"][key] = {"note": "no overlap"}
            continue
        j = ow[["wspd"]].copy()
        has_wave = bool(p.get("wave") and p.get("buoy"))
        if has_wave:
            j["hs"] = obs[p["buoy"]].hs.reindex(j.index)
        j = j[(j.index >= t0) & (j.index <= now)].dropna()
        day = pd.Series(daylight_mask(j.index, p["lat"], p["lon"], TZ), index=j.index)
        pp = {**p, "wave": p["wave"] if has_wave else None}
        nan = np.full(len(j), np.nan)
        ob_score = pd.Series(paddle_factors(pp, j.wspd, nan, j.hs if has_wave else nan)["score"], index=j.index)
        od = go_days(ob_score, day)
        od = od[od.n >= 4]
        by = {}
        for L in LEADS:
            fww = fw.reindex(j.index)
            fhs = mar[p["buoy"]].reindex(j.index)[lead_col("wave_height", L)] if has_wave and p["buoy"] in mar else nan
            fs = pd.Series(paddle_factors(pp, fww[lead_col("wind_speed_10m", L)], nan, fhs)["score"], index=j.index)
            fd = go_days(fs, day).reindex(od.index)
            ok = fd.best.notna()
            by[L] = contingency(fd.go[ok].astype(bool), od.go[ok].astype(bool))
        res["paddle"][key] = {"name": p["name"], "wind_station": p["wind_station"], "waves_checked": has_wave,
                              "matched_hours": int(len(j)), "days": int(len(od)), "by_lead": by}
    return res


def trust_table(bt: dict, group: str) -> dict:
    return {k: {int(L): {kk: v.get(kk) for kk in ("accuracy", "hss", "pod", "far", "n_days")} for L, v in s.get("by_lead", {}).items()}
            for k, s in bt.get(group, {}).items()}


# ============================================================================= climatology

def climatology(prev: dict | None = None, min_years: int = 5) -> dict:
    """Per surf spot, from the driver buoy's long record: share of days per month with ≥ 2 daylight hours of
    B-or-better SWELL (size × period × direction; wind is not in the long record at the beach)."""
    out = {}
    for key, sp in SPOTS.items():
        bid = sp["buoy"]
        src, dir_ok = None, True
        o = load_obs(bid)
        if BUOYS[bid]["history"]:
            src = o[["hs", "tp", "dir"]].dropna(subset=["hs", "tp"])
            label = f"NOAA NDBC {bid}, {src.index.min():%Y}–{src.index.max():%Y}"
        else:
            f = RAW / "meds" / f"{bid}.parquet"
            if not f.exists():
                if prev and prev.get(key):
                    out[key] = {**prev[key], "carried_over": True}
                continue
            m = pd.read_parquet(f)
            m["time"] = pd.to_datetime(m.time, utc=True)
            src = m.set_index("time")[["hs", "tp"]].assign(dir=np.nan)
            dir_ok = False
            label = f"DFO MEDS {bid}, {src.index.min():%Y}–{src.index.max():%Y} (no wave direction in this archive)"
        src = src[~src.index.duplicated()]
        if src.index.year.nunique() < min_years:          # fresh CI checkout without the long record: keep the last result
            if prev and prev.get(key):
                out[key] = {**prev[key], "carried_over": True}
            continue
        day = daylight_mask(src.index, sp["lat"], sp["lon"], TZ)
        s = src[day]
        fac = surf_factors(sp, s.hs, s.tp, s.dir, np.full(len(s), np.nan), np.full(len(s), np.nan))
        sc = pd.Series(fac["size"] * fac["period"] * fac["dir"] * 100, index=s.index)
        loc = s.index.tz_convert(TZ)
        dd = pd.DataFrame({"go": sc >= GO_SCORE, "ok": sc >= WINDOW_MIN, "hs": s.hs.to_numpy()}, index=loc)
        per_day = dd.groupby(dd.index.date).agg(go=("go", "sum"), ok=("ok", "sum"), n=("go", "size"), hs=("hs", "median"))
        per_day = per_day[per_day.n >= 4]
        per_day.index = pd.to_datetime(per_day.index)
        mon = per_day.groupby(per_day.index.month)
        out[key] = {"source": label, "direction_scored": dir_ok, "years": int(per_day.index.year.nunique()),
                    "days": int(len(per_day)),
                    "months": [{"m": int(m), "go_share": float((g.go >= WINDOW_MIN_HOURS).mean()),
                                "ok_share": float((g.ok >= WINDOW_MIN_HOURS).mean()), "hs_median": float(g.hs.median()),
                                "n_days": int(len(g))} for m, g in mon]}
    return out


# ============================================================================= outputs

def obs_recent(now: pd.Timestamp, days: int = 14) -> dict:
    t0 = (now - pd.Timedelta(days=days)).floor("h")
    idx = pd.date_range(t0, now.floor("h"), freq="h")
    out = {"t0": iso(t0), "hours": len(idx), "buoys": {}, "wind": {}}
    for bid in BUOYS:
        o = load_obs(bid).reindex(idx)
        if o.empty or o.hs.notna().sum() == 0:
            continue
        d = {"hs": col(o.hs, 2), "tp": col(o.tp, 1), "dir": col(o.dir, 0), "wspd": col(o.wspd, 0), "wdir": col(o.wdir, 0)}
        if BUOYS[bid]["spec"]:
            d |= {"swh": col(o.swh, 2), "swp": col(o.swp, 1), "swd": col(o.swd, 0), "wwh": col(o.wwh, 2)}
        out["buoys"][bid] = d
    for cid in WIND_STATIONS:
        o = load_wind_obs(cid).reindex(idx)
        if o.wspd.notna().any():
            out["wind"][cid] = {"wspd": col(o.wspd, 0), "wdir": col(o.wdir, 0)}
    return out


def obs_archive(now: pd.Timestamp) -> dict:
    """Durable hourly record of the buoys without a long online archive (scaled integers to keep it small)."""
    fields = {"hs": 100, "tp": 10, "tm": 10, "dir": 1, "wspd": 10, "wdir": 1, "gust": 10}
    start = (now - pd.Timedelta(days=ARCHIVE_DAYS)).floor("D")
    out = {"start": iso(start), "fields": fields, "note": "hours since start; value / scale = physical units (m, s, deg, km/h)",
           "buoys": {}}
    for bid, b in BUOYS.items():
        if b["history"]:
            continue
        o = load_obs(bid)
        o = o[o.index >= start].dropna(how="all", subset=[c for c in fields if c in o])
        if o.empty:
            continue
        rec = {"h": [int((t - start).total_seconds() // 3600) for t in o.index]}
        for c, sc in fields.items():
            rec[c] = [None if not np.isfinite(v) else int(round(v * sc)) for v in o[c].to_numpy(dtype=float)] if c in o else []
        out["buoys"][bid] = rec
    return out


def latest(o: pd.DataFrame, cols: list[str], now: pd.Timestamp, max_age_h: int = 6) -> dict | None:
    """Newest reading; flagged stale after max_age_h, and reduced to its time only after 24 h."""
    o = o.dropna(subset=["hs"]) if "hs" in o else o
    if o.empty:
        return None
    t = o.index.max()
    if (now - t) > pd.Timedelta(hours=24):
        return {"time": iso(t), "age_h": round((now - t).total_seconds() / 3600, 1), "stale": True, "too_old": True}
    r = o.loc[t]
    return {"time": iso(t), "age_h": round((now - t).total_seconds() / 3600, 1), "stale": (now - t) > pd.Timedelta(hours=max_age_h),
            **{c: (float(r[c]) if c in r and pd.notna(r[c]) else None) for c in cols}}


def freshness(status: dict, extra: dict) -> list[dict]:
    labels = {"ndbc_realtime": "NOAA NDBC buoys (realtime)", "swob": "ECCC buoys (MSC Datamart SWOB)",
              "eccc_wind": "ECCC coastal wind stations", "tides": "DFO tide predictions (IWLS)",
              "forecast": "Open-Meteo marine + wind forecast", "forecast_history": "Open-Meteo previous runs (backtest)",
              "ndbc_recent": "NOAA NDBC 46087 (this year's monthly files)",
              "ndbc_history": "NOAA NDBC 46087 history", "meds": "DFO MEDS buoy archive"}
    out = []
    for k, label in labels.items():
        st = status.get(k) or {}
        out.append({"id": k, "label": label, "ok": st.get("ok"), "attempted": st.get("attempted"), "last_ok": st.get("last_ok"),
                    "newest": extra.get(k) or st.get("newest"), "error": st.get("error"), "partial": st.get("partial")})
    return out


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    now = pd.Timestamp.now(tz="UTC").floor("min")
    status = read_json(RAW / "status.json", {})
    fc = read_json(RAW / "forecast.json")
    tdoc = read_json(RAW / "tides.json")
    tides = tide_frames(tdoc)

    import time as _t
    t_start = _t.time()
    print("backtest…")
    bt = backtest(now)
    trust_s, trust_p = trust_table(bt, "spots"), trust_table(bt, "paddle")
    for k, s in bt["spots"].items():
        if s.get("by_lead"):
            print(f"  {k}: {s['days']} days · " + " · ".join(f"d{L} {v['accuracy']:.0%}/{v['hss'] or 0:.2f}" for L, v in s["by_lead"].items()
                                                            if v.get("accuracy") is not None))
    print("climatology…")
    clim = climatology((read_json(OUT / "waves.json", {}) or {}).get("climatology"))

    spots_out, paddle_out, fc_out, all_windows, paddle_windows = {}, {}, {}, [], []
    hours = pd.date_range(now.floor("h"), periods=HORIZON_H, freq="h")
    if fc:
        fc_out = {"generated": now, "fetched": fc["fetched"], "start": iso(hours[0]), "hours": HORIZON_H, "tz": TZ,
                  "marine_model": fc["marine_model"], "period_model": fc["period_model"], "spots": {}, "paddle": {}}
        for key, sp in SPOTS.items():
            df = live_spot(key, sp, fc, tides, hours)
            tr = trust_s.get(key, {})
            fc_out["spots"][key] = {
                "score": col(df.score, 0), "day": [int(x) for x in df.day],
                "hs": col(df.hs, 2), "tp": col(df.tp, 1), "dir": col(df.dir, 0),
                "swh": col(df.swh, 2), "swp": col(df.swp, 1), "swd": col(df.swd, 0), "wwh": col(df.wwh, 2), "wwp": col(df.wwp, 1),
                "sw2h": col(df.sw2h, 2), "sw2p": col(df.sw2p, 1), "sw2d": col(df.sw2d, 0), "hs_near": col(df.hs_near, 2),
                "wspd": col(df.wspd, 0), "wdir": col(df.wdir, 0), "gust": col(df.gust, 0),
                "tide": col(df.tide, 2), "tide_p": col(df.tide_p, 2),
                "f_size": col(df.f_size, 2), "f_period": col(df.f_period, 2), "f_dir": col(df.f_dir, 2),
                "f_wind": col(df.f_wind, 2), "f_tide": col(df.f_tide, 2),
                "temp": col(df.temp, 0), "precip": col(df.precip, 1), "wcode": col(df.wcode, 0), "sst": col(df.sst, 1)}
            all_windows += windows(key, df, now, "surf", sp, tr)
            # nowcast: latest buoy swell + model wind for this hour + predicted tide
            ob = latest(load_obs(sp["buoy"]), ["hs", "tp", "dir", "swh", "swp", "swd"], now)
            now_row = df.iloc[0]
            nowcast = None
            if ob and not ob.get("too_old") and ob.get("hs") is not None:
                f = surf_factors(sp, [ob["hs"]], [ob.get("tp") or np.nan], [ob.get("dir") if ob.get("dir") is not None else np.nan],
                                 [now_row.wspd], [now_row.wdir], [now_row.tide_p])
                nowcast = {"score": round(float(f["score"][0]), 1), "tier": tier(float(f["score"][0])), "buoy": ob,
                           "wspd": now_row.wspd, "wdir": now_row.wdir, "wind": wind_label(now_row.wspd, now_row.wdir, sp["facing"]),
                           "tide": tide_state(now_row.tide_p, bool(now_row.rising) if pd.notna(now_row.rising) else False),
                           "daylight": bool(now_row.day),
                           "factors": {k: round(float(f[k][0]), 2) for k in ("size", "period", "dir", "wind", "tide")}}
            spots_out[key] = {
                "name": sp["name"], "region": sp["region"], "lat": sp["lat"], "lon": sp["lon"], "facing": sp["facing"],
                "offshore_from": (sp["facing"] + 180) % 360, "buoy": sp["buoy"], "wind_station": sp["wind_station"], "tide": sp["tide"],
                "rule": {"size_m": sp["size"], "period_s": sp["period"], "dir_window": sp["dir"], "dir_taper": sp["taper"],
                         "tide_band": sp["tide_band"], "tide_floor": sp["tide_floor"]},
                "notes": sp["notes"], "drive": sp["drive"], "now": nowcast, "daily": daily(df, now, tr), "trust": tr}
        for key, p in PADDLE.items():
            df = live_paddle(key, p, fc, tides, hours)
            tr = trust_p.get(key, {})
            fc_out["paddle"][key] = {"score": col(df.score, 0), "day": [int(x) for x in df.day], "wspd": col(df.wspd, 0),
                                     "wdir": col(df.wdir, 0), "gust": col(df.gust, 0), "hs": col(df.hs, 2), "tide": col(df.tide, 2),
                                     "f_wind": col(df.f_wind, 2), "f_gust": col(df.f_gust, 2), "f_wave": col(df.f_wave, 2),
                                     "temp": col(df.temp, 0), "precip": col(df.precip, 1), "wcode": col(df.wcode, 0), "sst": col(df.sst, 1)}
            paddle_windows += windows(key, df, now, "paddle", p, tr)
            paddle_out[key] = {"name": p["name"], "area": p["area"], "lat": p["lat"], "lon": p["lon"], "wind_station": p["wind_station"],
                               "tide": p["tide"], "buoy": p["buoy"], "sheltered": p["marine"] is None,
                               "rule": {"wind_kmh": p["wind"], "gust_kmh": p["gust"], "wave_m": p["wave"]}, "notes": p["notes"],
                               "daily": daily(df, now, tr), "trust": tr}
        dump("forecast.json", fc_out)
    else:
        print("  no forecast.json in raw/: ratings skipped (run fetch forecast)")

    def tiered(ws, per_tier=8):
        ws = sorted(ws, key=lambda w: -w["score"])
        return {"counts": {t: sum(1 for w in ws if w["tier"] == t) for t, _ in TIERS},
                "items": {t: [w for w in ws if w["tier"] == t][:per_tier] for t, _ in TIERS}}

    tide_out = {"generated": now, "stations": {}}
    for code, t in tides.items():
        h = t["hourly"]
        tide_out["stations"][code] = {"name": TIDES[code]["name"], "lat": TIDES[code]["lat"], "lon": TIDES[code]["lon"],
                                      "note": TIDES[code]["note"], "t0": iso(h.index[0]), "level": col(h.level, 2),
                                      "hilo": [[iso(a), round(b, 2)] for a, b in t["hilo"]]}
    if tide_out["stations"]:
        dump("tides.json", tide_out)

    recent = obs_recent(now)
    dump("obs_recent.json", recent)
    dump("obs_archive.json", obs_archive(now))
    dump("backtest.json", {"generated": now, "marine_model": MARINE_MODEL, "period_model": PERIOD_MODEL,
                           "go_rule": f"GO day = ≥ {WINDOW_MIN_HOURS} daylight hours scoring ≥ {GO_SCORE} (tier B or better); tide not scored",
                           **bt})

    buoys_out = {}
    for bid, b in BUOYS.items():
        o = load_obs(bid)
        buoys_out[bid] = {"name": b["name"], "lat": b["lat"], "lon": b["lon"], "owner": b["owner"], "note": b["note"],
                          "latest": latest(o, ["hs", "tp", "tm", "dir", "wspd", "wdir", "gust", "swh", "swp", "swd", "wwh", "wwp"], now),
                          "record_from": o.dropna(subset=["hs"]).index.min() if "hs" in o and o.hs.notna().any() else None}
    newest_fc = fc["fetched"] if fc else None
    waves = {
        "generated": now, "tz": TZ, "title": "West Coast Water",
        "attribution": "Forecasts: Open-Meteo.com (CC BY 4.0, non-commercial free tier). Buoys: NOAA NDBC, ECCC, DFO MEDS. "
                       "Tides: DFO/CHS (not for navigation). Ratings are an editorial rule, not a surf report.",
        "licences": LICENCES, "freshness": freshness(status, {"forecast": newest_fc}),
        "method": {
            "surf_score": "100 × size × period × direction × wind × tide; each factor 0–1 (see rule per spot)",
            "swell_inputs": f"forecast at the driver buoy: total Hs and mean direction ({MARINE_MODEL}), peak period ({PERIOD_MODEL})",
            "wind": {"calm_kmh": WIND_CALM, "k_offshore": WIND_K_OFF, "k_onshore": WIND_K_ON,
                     "text": "1 when ≤ calm; loses k per km/h above calm, k blends from offshore to onshore by (1 + cos θ)/2"},
            "tide": "normalised level over the 10-day prediction window (0 lowest, 1 highest); floor outside the preferred band",
            "daylight": "civil dawn to dusk at each spot", "tiers": dict(TIERS), "go_score": GO_SCORE,
            "window": f"≥ {WINDOW_MIN_HOURS} consecutive daylight hours at ≥ {WINDOW_MIN} (C or better); window score = mean of its best 3 hours",
            "paddle_score": "100 × wind × gust × wave; each 1 at or under the 'full' threshold, 0 at 'zero'",
        },
        "spots": spots_out, "paddle": paddle_out, "buoys": buoys_out,
        "wind_stations": WIND_STATIONS, "tide_stations": {k: {kk: v[kk] for kk in ("name", "lat", "lon", "note")} for k, v in TIDES.items()},
        "windows": tiered(all_windows), "paddle_windows": tiered(paddle_windows),
        "trust": {"surf": trust_s, "paddle": trust_p,
                  "headline": {k: {L: (bt["spots"][k]["by_lead"].get(L) or {}).get("accuracy") for L in (1, 3, 5)}
                               for k in bt["spots"] if bt["spots"][k].get("by_lead")}},
        "climatology": clim,
    }
    dump("waves.json", waves)
    print(f"  windows: {waves['windows']['counts']} · paddle: {waves['paddle_windows']['counts']} · {_t.time() - t_start:.0f} s")


if __name__ == "__main__":
    main()
