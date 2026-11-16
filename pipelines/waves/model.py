"""Transparent spot ratings for West Coast Water.

Surf score (0–100) = 100 × size × period × direction × wind × tide, each factor in [0, 1] (see config.SPOTS for the
per-spot numbers). Multiplying means any single deal-breaker (flat, short-period, wrong direction, blown out) sinks
the hour, which is how surfers actually decide. Calm-water score = 100 × wind × gust × wave.

All functions are vectorised over numpy arrays and treat NaN inputs as "unknown": an unknown factor is neutral (1)
except swell height, without which there is no score.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np

from .config import TIERS, WIND_CALM, WIND_K_OFF, WIND_K_ON


def _arr(x):
    return np.asarray(x, dtype=float)


def ramp(x, x0, x1):
    """0 at x0, 1 at x1, linear between, clipped."""
    return np.clip((_arr(x) - x0) / (x1 - x0), 0.0, 1.0)


def angdiff(a, b):
    """Smallest absolute angle between two bearings, degrees."""
    return np.abs((_arr(a) - _arr(b) + 180.0) % 360.0 - 180.0)


SWEET = 0.15        # headroom inside the ideal bands, so only sweet-spot hours reach 1 (keeps S rare)


def f_size(h, size):
    """0 below min → 0.85 at ideal_lo → 1 at the middle of the ideal band → 0.85 at ideal_hi → 0 at max."""
    mn, lo, hi, mx = size
    h = _arr(h)
    mid, half = (lo + hi) / 2.0, (hi - lo) / 2.0
    inside = 1.0 - SWEET * np.clip(np.abs(h - mid) / half, 0.0, 1.0)
    f = np.where(h < lo, (1 - SWEET) * ramp(h, mn, lo), np.where(h > hi, (1 - SWEET) * (1.0 - ramp(h, hi, mx)), inside))
    return np.where(np.isnan(h), np.nan, f)


def f_period(t, period):
    """0 at min → 0.85 at ideal → 1 at ideal + 3 s (longer-period swell is more powerful and better groomed)."""
    mn, ideal = period
    t = _arr(t)
    return np.where(np.isnan(t), 1.0, (1 - SWEET) * ramp(t, mn, ideal) + SWEET * ramp(t, ideal, ideal + 3))


def f_dir(d, window, taper):
    lo, hi = window
    d = _arr(d)
    centre = (lo + hi) / 2.0
    half = (hi - lo) / 2.0
    outside = np.maximum(angdiff(d, centre) - half, 0.0)
    return np.where(np.isnan(d), 1.0, np.clip(1.0 - outside / taper, 0.0, 1.0))


def onshore_share(wdir, facing):
    """0 = dead offshore, 1 = dead onshore. Wind blowing FROM `facing` is onshore."""
    ang = angdiff(wdir, facing)                         # 0 → wind comes from the sea straight onto the beach
    return (1.0 + np.cos(np.radians(ang))) / 2.0


def f_wind(spd, wdir, facing):
    """Light offshore = 1; calm = 0.95; above WIND_CALM km/h the score drops faster the more onshore the wind."""
    spd = _arr(spd)
    o = np.where(np.isnan(_arr(wdir)), 0.5, onshore_share(wdir, facing))
    light = np.where(spd <= WIND_CALM, 0.95 + 0.05 * (1.0 - o) * np.clip(spd / WIND_CALM, 0, 1), 1.0)
    f = np.minimum(light, 1.0 - np.maximum(spd - WIND_CALM, 0.0) * (WIND_K_OFF + WIND_K_ON * o))
    return np.where(np.isnan(spd), 1.0, np.clip(f, 0.0, 1.0))


def f_tide(p, band, floor):
    lo, hi = band
    p = _arr(p)
    if floor >= 1.0:
        return np.ones_like(p)
    dist = np.maximum(np.maximum(lo - p, p - hi), 0.0)
    f = floor + (1.0 - floor) * np.clip(1.0 - dist / 0.25, 0.0, 1.0)
    return np.where(np.isnan(p), 1.0, f)


def surf_factors(spot: dict, hs, tp, sdir, wspd, wdir, tide_p=None) -> dict:
    fac = {"size": f_size(hs, spot["size"]), "period": f_period(tp, spot["period"]),
           "dir": f_dir(sdir, spot["dir"], spot["taper"]), "wind": f_wind(wspd, wdir, spot["facing"])}
    fac["tide"] = f_tide(tide_p, spot["tide_band"], spot["tide_floor"]) if tide_p is not None else np.ones_like(_arr(hs))
    score = 100.0 * fac["size"] * fac["period"] * fac["dir"] * fac["wind"] * fac["tide"]
    fac["score"] = score
    return fac


def _calm(x, full, zero):
    """1 at 0 → 0.85 at `full` → 0 at `zero` (glassy beats merely acceptable)."""
    x = _arr(x)
    return np.where(x <= full, 1.0 - SWEET * np.clip(x / full, 0, 1), (1 - SWEET) * (1.0 - ramp(x, full, zero)))


def paddle_factors(p: dict, wspd, gust, hs) -> dict:
    fac = {"wind": np.where(np.isnan(_arr(wspd)), np.nan, _calm(wspd, *p["wind"])),
           "gust": np.where(np.isnan(_arr(gust)), 1.0, 1.0 - ramp(gust, *p["gust"]))}
    fac["wave"] = (np.where(np.isnan(_arr(hs)), 1.0, _calm(hs, *p["wave"])) if p.get("wave")
                   else np.ones_like(_arr(wspd)))
    fac["score"] = 100.0 * fac["wind"] * fac["gust"] * fac["wave"]
    return fac


def tier(score) -> str | None:
    if score is None or not np.isfinite(score):
        return None
    return next(t for t, th in TIERS if score >= th)


# ----------------------------------------------------------------------------------------------- daylight

def civil_twilight_utc(dates, lat: float, lon: float):
    """Civil dawn and dusk (sun 6° below the horizon) in UTC for local calendar dates, vectorised (NOAA solar
    equations, accurate to about a minute at these latitudes). `dates`: tz-naive midnights. Returns two
    datetime64[ns] arrays. Solar noon here is ~20:00 UTC, so the local date and the UTC date of noon coincide."""
    import pandas as pd

    d = pd.DatetimeIndex(dates)
    n = d.dayofyear.to_numpy(dtype=float)
    g = 2 * np.pi / 365.0 * (n - 1)
    eqt = 229.18 * (0.000075 + 0.001868 * np.cos(g) - 0.032077 * np.sin(g) - 0.014615 * np.cos(2 * g) - 0.040849 * np.sin(2 * g))
    decl = (0.006918 - 0.399912 * np.cos(g) + 0.070257 * np.sin(g) - 0.006758 * np.cos(2 * g) + 0.000907 * np.sin(2 * g)
            - 0.002697 * np.cos(3 * g) + 0.00148 * np.sin(3 * g))
    phi = np.radians(lat)
    cos_ha = np.cos(np.radians(96.0)) / (np.cos(phi) * np.cos(decl)) - np.tan(phi) * np.tan(decl)
    ha = np.degrees(np.arccos(np.clip(cos_ha, -1, 1)))
    base = d.to_numpy(dtype="datetime64[ns]")
    rise = base + ((720 - 4 * (lon + ha) - eqt) * 60e9).astype("timedelta64[ns]")
    sett = base + ((720 - 4 * (lon - ha) - eqt) * 60e9).astype("timedelta64[ns]")
    return rise, sett


def daylight_mask(times, lat: float, lon: float, tz: str) -> np.ndarray:
    """True for hours (UTC pandas DatetimeIndex) between civil dawn and dusk at the spot."""
    import pandas as pd

    times = pd.DatetimeIndex(times)
    if len(times) == 0:
        return np.zeros(0, dtype=bool)
    local_mid = times.tz_convert(tz).normalize().tz_localize(None)
    rise, sett = civil_twilight_utc(local_mid, lat, lon)
    t = times.tz_convert("UTC").tz_localize(None).to_numpy(dtype="datetime64[ns]")
    return (t >= rise) & (t <= sett)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


__all__ = ["surf_factors", "paddle_factors", "tier", "daylight_mask", "civil_twilight_utc", "angdiff", "onshore_share", "utc_now", "timedelta"]
