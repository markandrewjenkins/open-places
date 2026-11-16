"""Turn logged vehicle positions into stop arrival/departure times, and measure log coverage.

Each vehicle report is projected onto its trip's shape (distance along the route). Progress is cleaned (outliers
and backward jitter removed, then made non-decreasing) and the moment the bus reached / left each stop is
interpolated between the two reports that bracket the stop's distance. Brackets wider than MAX_BRACKET seconds are
dropped (too uncertain). Typical precision with 30 s polling: about ±15 s.

The last trip-update prediction logged near each stop (BC Transit's own estimate) is kept alongside as a cross-check
and fills stops the position method misses.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .config import MAX_OFFROUTE_M
from .network import shape

MAX_BRACKET = 240          # s
ARR_BEFORE = 15            # m before the stop counts as arrived
DEP_AFTER = 25             # m past the stop counts as departed
DEP_AFTER_FIRST = 60       # terminals: bays are spread out
OUTAGE_GAP = 150           # s between successful polls that counts as a coverage hole


def _clean_track(d: np.ndarray, t: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if len(d) >= 5:
        med = pd.Series(d).rolling(5, center=True, min_periods=3).median().to_numpy()
        ok = np.abs(d - med) <= 400
        d, t = d[ok], t[ok]
    if len(d) == 0:
        return d, t
    keep = d >= np.maximum.accumulate(d) - 60
    d, t = d[keep], t[keep]
    return np.maximum.accumulate(d), t


def _cross(d, t, s, side):
    """Times the track first reaches each distance in s (side='left') or last is at/below it (side='right')."""
    i = np.searchsorted(d, s, side=side)
    ok = (i > 0) & (i < len(d))
    i = np.clip(i, 1, len(d) - 1)
    d0, d1, t0, t1 = d[i - 1], d[i], t[i - 1], t[i]
    ok &= (t1 - t0 <= MAX_BRACKET) & (d1 > d0)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = t0 + (s - d0) / (d1 - d0) * (t1 - t0)
    return np.where(ok, out, np.nan)


def stop_events(vp: pd.DataFrame, sched: pd.DataFrame) -> pd.DataFrame:
    """obs_arr / obs_dep (epoch s) for every scheduled stop of every logged trip that the positions cover."""
    cols = ["trip_id", "start_date", "seq", "obs_arr", "obs_dep"]
    if vp.empty or sched.empty:
        return pd.DataFrame(columns=cols)
    keys = sched[["trip_id", "start_date", "version", "shape_id"]].drop_duplicates(["trip_id", "start_date"])
    v = vp.merge(keys, on=["trip_id", "start_date"], how="inner")
    sched = sched[sched.dist.notna()]
    by_trip = {k: (g.seq.to_numpy(), g.dist.to_numpy(float), g["first"].to_numpy(bool), g["last"].to_numpy(bool))
               for k, g in sched.groupby(["trip_id", "start_date"])}
    out = []
    for (ver, shp), g in v.groupby(["version", "shape_id"]):
        S = shape(ver, shp)
        d, off = S.project(g.lat.to_numpy(), g.lon.to_numpy())
        g = g.assign(d=d, off=off)
        g = g[g.off <= MAX_OFFROUTE_M]
        for key, tg in g.groupby(["trip_id", "start_date"]):
            st = by_trip.get(key)
            if st is None:
                continue
            tg = tg.sort_values("ts")
            dd, tt = _clean_track(tg.d.to_numpy(), tg.ts.to_numpy(float))
            if len(dd) < 2:
                continue
            seq, dist, first, last = st
            arr = _cross(dd, tt, np.maximum(0.0, dist - ARR_BEFORE), "left")
            dep = _cross(dd, tt, np.minimum(S.length, dist + np.where(first, DEP_AFTER_FIRST, DEP_AFTER)), "right")
            arr[first] = np.nan
            dep[last] = np.nan
            dep = np.where(np.isfinite(arr) & np.isfinite(dep) & (dep < arr), arr, dep)
            keep = np.isfinite(arr) | np.isfinite(dep)
            if keep.any():
                out.append(pd.DataFrame({"trip_id": key[0], "start_date": key[1], "seq": seq[keep],
                                         "obs_arr": arr[keep], "obs_dep": dep[keep]}))
    return pd.concat(out, ignore_index=True) if out else pd.DataFrame(columns=cols)


def tu_estimates(tu: pd.DataFrame) -> pd.DataFrame:
    """BC Transit's last logged prediction for each trip stop, and how long before the event it was made."""
    if tu.empty:
        return pd.DataFrame(columns=["trip_id", "start_date", "seq", "tu_arr", "tu_dep", "tu_lead", "tu_skipped"])
    t = tu.sort_values("obs").groupby(["trip_id", "start_date", "seq"]).tail(1).copy()
    ref = t.dep.fillna(t.arr)
    t["tu_lead"] = ref - t.obs                         # <= 0: reported after the event (an actual, not a forecast)
    t["tu_skipped"] = t.sr == 1
    return t.rename(columns={"arr": "tu_arr", "dep": "tu_dep"})[["trip_id", "start_date", "seq", "tu_arr", "tu_dep", "tu_lead", "tu_skipped"]]


# ============================================================================= coverage

class Coverage:
    """Which moments the collector was watching: successful polls no more than OUTAGE_GAP apart."""

    def __init__(self, polls: pd.DataFrame):
        ok = polls[polls.ok == 1].obs.sort_values().to_numpy(float) if not polls.empty else np.array([])
        self.ok = ok
        if len(ok) == 0:
            self.spans = np.empty((0, 2))
            return
        brk = np.where(np.diff(ok) > OUTAGE_GAP)[0]
        starts = np.concatenate([[ok[0]], ok[brk + 1]])
        ends = np.concatenate([ok[brk], [ok[-1]]])
        self.spans = np.stack([starts, ends], axis=1)

    def hours(self) -> float:
        return float((self.spans[:, 1] - self.spans[:, 0]).sum() / 3600) if len(self.spans) else 0.0

    def outages(self) -> list[tuple[float, float]]:
        return [(self.spans[i, 1], self.spans[i + 1, 0]) for i in range(len(self.spans) - 1)]

    def covers(self, t0, t1) -> np.ndarray:
        """True where [t0, t1] lies inside one continuous span."""
        t0, t1 = np.atleast_1d(np.asarray(t0, float)), np.atleast_1d(np.asarray(t1, float))
        if not len(self.spans):
            return np.zeros(len(t0), bool)
        i = np.searchsorted(self.spans[:, 0], t0, side="right") - 1
        ok = i >= 0
        ic = np.clip(i, 0, None)
        return ok & (self.spans[ic, 0] <= t0) & (t1 <= self.spans[ic, 1])

    def hours_by(self, tz: str, freq: str = "h") -> pd.Series:
        """Covered seconds per local hour (or day) bucket."""
        if not len(self.spans):
            return pd.Series(dtype=float)
        secs = {}
        for a, b in self.spans:
            cur = a
            while cur < b:
                ts = pd.Timestamp(cur, unit="s", tz="UTC").tz_convert(tz)
                bucket = ts.floor(freq) if freq == "h" else ts.normalize()
                nxt = (bucket + (pd.Timedelta(hours=1) if freq == "h" else pd.Timedelta(days=1))).timestamp()
                end = min(b, nxt)
                k = bucket.tz_localize(None)
                secs[k] = secs.get(k, 0) + (end - cur)
                cur = end
        return pd.Series(secs).sort_index()
