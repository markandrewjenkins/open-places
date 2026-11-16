"""The playable-hour model, shared by the live forecast, the archived forecasts and the observations.

Input: an hourly frame indexed by UTC time (tz-aware), with columns temp (°C), precip (mm in the hour ending at that
time, the convention of both Open-Meteo and ECCC), wind (km/h), and optionally gust (km/h). Output adds:
  daylight  share of the hour inside [sunrise + pad, sunset − pad]
  frost     True while a morning frost delay is on
  comfort   0–1, the product of the factor ramps in config.PLAYABILITY
  playable  comfort >= PLAYABLE_MIN
  playable_dh  playable × daylight: summed per day this gives playable daylight hours
Sunrise and sunset come from ephem (no API), so the same daylight rule applies to every source.
"""
from __future__ import annotations

import math
from datetime import timedelta

import ephem
import numpy as np
import pandas as pd

from .config import PLAYABILITY, PLAYABLE_MIN, ROUND_HOURS, TZ


def ramp(x, good, bad):
    """1 at `good`, 0 at `bad`, linear between (works whichever way round they are)."""
    x = np.asarray(x, dtype=float)
    return np.clip((x - bad) / (good - bad), 0, 1)


def sun_times(lat: float, lon: float, dates) -> pd.DataFrame:
    """Sunrise and sunset (UTC, tz-aware) for local dates."""
    obs = ephem.Observer()
    obs.lat, obs.lon, obs.pressure, obs.horizon = str(lat), str(lon), 0, "-0:34"
    rows = []
    for d in dates:
        noon = pd.Timestamp(d).tz_localize(TZ) + pd.Timedelta(hours=12)
        obs.date = ephem.Date(noon.tz_convert("UTC").tz_localize(None).to_pydatetime())
        sr = pd.Timestamp(obs.previous_rising(ephem.Sun()).datetime()).tz_localize("UTC")
        ss = pd.Timestamp(obs.next_setting(ephem.Sun()).datetime()).tz_localize("UTC")
        rows.append({"date": pd.Timestamp(d), "sunrise": sr, "sunset": ss})
    return pd.DataFrame(rows).set_index("date")


def score(df: pd.DataFrame, lat: float, lon: float, *, use_gust: bool = True) -> pd.DataFrame:
    P = PLAYABILITY
    out = df.copy()
    local = out.index.tz_convert(TZ)
    out["date"] = local.tz_localize(None).normalize()
    sun = sun_times(lat, lon, sorted(out["date"].unique()))
    pad = pd.Timedelta(minutes=P["daylight_pad_min"])
    start = out["date"].map(sun["sunrise"]) + pad
    end = out["date"].map(sun["sunset"]) - pad
    t1 = pd.Series(out.index, index=out.index)                 # the hour ending at t
    t0 = t1 - pd.Timedelta(hours=1)
    lo = np.maximum(t0.values.astype("datetime64[ns]").astype(np.int64), start.values.astype("datetime64[ns]").astype(np.int64))
    hi = np.minimum(t1.values.astype("datetime64[ns]").astype(np.int64), end.values.astype("datetime64[ns]").astype(np.int64))
    out["daylight"] = np.clip((hi - lo) / 3.6e12, 0, 1)
    # morning frost delay: the night's low (midnight to 10:00 local) at or below frost_tmin delays play until the air
    # warms to frost_clear_c; if it never does, the day is frozen out
    hour = local.hour
    night_min = out["temp"].where(hour < 10).groupby(out["date"]).transform("min")
    warm = (out["temp"] >= P["frost_clear_c"]) & (hour >= 6)
    cleared = warm.groupby(out["date"]).cummax()
    out["frost"] = (night_min <= P["frost_tmin"]) & ~cleared
    f = ramp(out["precip"].fillna(0), *P["rain_mm"]) * ramp(out["wind"].fillna(0), *P["wind_kmh"]) * ramp(out["temp"], *P["temp_c"])
    if use_gust and "gust" in out:
        f = f * ramp(out["gust"].fillna(0), *P["gust_kmh"])
    f = f * np.where(out["frost"], 0, 1) * np.clip(out["daylight"] * 2, 0, 1)    # at least half the hour in daylight
    out["comfort"] = np.round(f, 3)
    out["playable"] = out["comfort"] >= PLAYABLE_MIN
    out["playable_dh"] = out["playable"] * out["daylight"]     # playable daylight hours (edge hours count in part)
    out["wet24"] = out["precip"].fillna(0).rolling(24, min_periods=1).sum() >= P["wet_24h_mm"]
    return out


def daily(scored: pd.DataFrame, round_kind: str = "18") -> pd.DataFrame:
    """Per local date: playable hours, frost-delay end, soggy flag, and the best tee time for a round of this kind
    (the start maximising mean comfort over the round, every hour playable, finishing in daylight)."""
    need = ROUND_HOURS.get(round_kind, 4.5)
    n = int(math.ceil(need))
    rows = []
    for d, g in scored.groupby("date"):
        lt = g.index.tz_convert(TZ)
        best = None
        c = g["comfort"].to_numpy(); ok = g["playable"].to_numpy()
        for i in range(len(g) - n + 1):
            if ok[i:i + n].all():
                m = float(c[i:i + n].mean())
                if best is None or m > best[2]:
                    best = (i, i + n, m)
        fr = g[g["frost"] & (g["daylight"] > 0)]
        rows.append({"date": d, "playable_h": round(float(g["playable_dh"].sum()), 1), "daylight_h": round(float(g["daylight"].sum()), 2),
                     "comfort": round(float(g.loc[g["daylight"] > 0, "comfort"].mean() or 0), 3) if (g["daylight"] > 0).any() else 0,
                     "frost_until": (lt[g.index.get_loc(fr.index[-1])] + timedelta(hours=0)).strftime("%H:%M") if len(fr) else None,
                     "soggy": bool(g["wet24"].where(g["daylight"] > 0).fillna(False).any()),
                     "rain_mm": round(float(g["precip"].where(g["daylight"] > 0).sum()), 1),
                     "best_start": (lt[best[0]] - timedelta(hours=1)).strftime("%H:%M") if best else None,
                     "best_end": (lt[best[1] - 1]).strftime("%H:%M") if best else None,
                     "best_comfort": round(best[2], 3) if best else None})
    return pd.DataFrame(rows).set_index("date")
