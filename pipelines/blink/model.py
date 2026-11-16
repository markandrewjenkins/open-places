"""Expected delay and excess wait for route 95 by direction x hour band x day type x wet/dry.

With weeks rather than years of history, a flexible model would mostly memorise individual days. This uses
shrunken cell means instead (partial pooling, i.e. empirical Bayes):

    cell (dir, band, daytype, wet)  ->  shrinks towards  (dir, band)  ->  shrinks towards  (dir)

each level weighted by n / (n + K) where n is the number of service-hours behind it. A cell with little data
therefore falls back to "what this time of day is usually like". It is tested by leaving one service day out at a
time (every hour of that day is predicted from the other days only) against two baselines:
    timetable   the bus is exactly on schedule (delay 0, excess wait 0)
    time of day the (dir, band) average from the other days, ignoring day type and weather
The weather effect is credible only if the model beats the time-of-day baseline on held-out days.
"""
from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import pandas as pd

from .config import FREQUENT_HEADWAY, MODEL_MIN_DAYS, MODEL_MIN_WET_DAYS, TZ

K = 6.0          # pseudo service-hours of shrinkage per level
WET_MM = 0.3


def _band(h):
    from .build import band_of
    return band_of(int(h))


def _daytype(ts):
    from .build import daytype
    return daytype(pd.Timestamp(ts).normalize())


def units(tp: pd.DataFrame, h: pd.DataFrame, hs: pd.DataFrame, wx: pd.DataFrame) -> pd.DataFrame:
    """One row per (service day, local hour, direction): mean timepoint delay (min) and excess wait (min)."""
    if tp.empty:
        return pd.DataFrame()
    d = tp.dropna(subset=["delay"]).groupby(["start_date", "local_hour", "dir"]).agg(
        delay=("delay", lambda s: s.mean() / 60), n=("delay", "size")).reset_index()
    if not h.empty and not hs.empty:
        a = h.assign(h2=h.h ** 2).groupby(["start_date", "local_hour", "dir"]).agg(ah=("h", "sum"), ah2=("h2", "sum")).reset_index()
        s = hs.assign(h2=hs.hs ** 2).groupby(["start_date", "local_hour", "dir"]).agg(sh=("hs", "sum"), sh2=("h2", "sum"),
                                                                                    med=("hs", "median")).reset_index()
        w = a.merge(s, on=["start_date", "local_hour", "dir"])
        w = w[w.med <= FREQUENT_HEADWAY]
        w["ewt"] = (w.ah2 / (2 * w.ah) - w.sh2 / (2 * w.sh)) / 60
        d = d.merge(w[["start_date", "local_hour", "dir", "ewt"]], on=["start_date", "local_hour", "dir"], how="left")
    else:
        d["ewt"] = np.nan
    lh = pd.to_datetime(d.local_hour)
    d["band"] = [_band(x) for x in lh.dt.hour]
    d["daytype"] = [_daytype(x) for x in pd.to_datetime(d.start_date.astype(str))]
    if wx is not None and not wx.empty:
        p = lh.map(wx.precipitation)
        d["precip"] = p
        d["wet"] = np.where(p.isna(), "dry", np.where(p >= WET_MM, "wet", "dry"))
        d["temp"] = lh.map(wx.temperature_2m)
    else:
        d["wet"], d["precip"], d["temp"] = "dry", np.nan, np.nan
    return d


LEVELS = [["dir"], ["dir", "band"], ["dir", "band", "daytype", "wet"]]


def fit(train: pd.DataFrame, target: str) -> dict:
    t = train.dropna(subset=[target])
    tables = {}
    for lv in LEVELS:
        tables[tuple(lv)] = t.groupby(lv)[target].agg(["mean", "size"])
    return {"tables": tables, "overall": float(t[target].mean()) if len(t) else 0.0}


def predict(m: dict, rows: pd.DataFrame) -> np.ndarray:
    out = np.empty(len(rows))
    for i, r in enumerate(rows.itertuples(index=False)):
        est = m["overall"]
        for lv in LEVELS:
            tab = m["tables"][tuple(lv)]
            key = tuple(getattr(r, c) for c in lv)
            key = key[0] if len(key) == 1 else key
            if key in tab.index:
                mu, n = tab.loc[key, "mean"], tab.loc[key, "size"]
                w = n / (n + K)
                est = w * mu + (1 - w) * est
        out[i] = est
    return out


def baseline_tod(train: pd.DataFrame, rows: pd.DataFrame, target: str) -> np.ndarray:
    t = train.dropna(subset=[target])
    tab = t.groupby(["dir", "band"])[target].mean()
    overall = t[target].mean() if len(t) else 0.0
    return np.array([tab.get((r.dir, r.band), overall) for r in rows.itertuples(index=False)])


def lodo(u: pd.DataFrame, target: str) -> dict | None:
    u = u.dropna(subset=[target])
    days = sorted(u.start_date.unique())
    if len(days) < 2:
        return None
    rows = []
    for d in days:
        tr, te = u[u.start_date != d], u[u.start_date == d]
        m = fit(tr, target)
        rows.append(pd.DataFrame({"y": te[target].to_numpy(), "w": te.n.to_numpy(), "model": predict(m, te),
                                  "tod": baseline_tod(tr, te, target), "timetable": 0.0, "wet": te.wet.to_numpy()}))
    r = pd.concat(rows)
    mae = lambda col, sub=r: float(np.average(np.abs(sub.y - sub[col]), weights=sub.w))    # noqa: E731
    res = {"days": len(days), "units": int(len(r)), "mae": {k: mae(k) for k in ("model", "tod", "timetable")}}
    res["skill_vs_tod"] = 1 - res["mae"]["model"] / res["mae"]["tod"] if res["mae"]["tod"] > 0 else None
    wet = r[r.wet == "wet"]
    if len(wet) >= 5:
        res["wet_hours"] = {"units": int(len(wet)), "mae": {k: mae(k, wet) for k in ("model", "tod", "timetable")}}
    return res


def run_model(tp: pd.DataFrame, h: pd.DataFrame, hs: pd.DataFrame, wx: pd.DataFrame) -> dict:
    gen = datetime.now(timezone.utc).isoformat(timespec="minutes")
    u = units(tp, h, hs, wx)
    n_days = int(u.start_date.nunique()) if len(u) else 0
    wet_days = int(u[u.wet == "wet"].groupby("start_date").size().ge(2).sum()) if len(u) else 0
    needs = {"days": max(0, MODEL_MIN_DAYS - n_days), "wet_days": max(0, MODEL_MIN_WET_DAYS - wet_days)}
    status = "ready" if not any(needs.values()) else ("provisional" if n_days >= 3 else "collecting")
    out = {"generated": gen, "status": status, "usable": status != "collecting", "service_days": n_days, "wet_days": wet_days, "units": int(len(u)),
           "requires": {"days": MODEL_MIN_DAYS, "wet_days": MODEL_MIN_WET_DAYS}, "needs": needs,
           "method": "Shrunken cell means (dir x hour band x day type x wet/dry -> dir x band -> dir), K=6 service-hours; "
                     "leave-one-service-day-out test vs time-of-day average and timetable.",
           "message": None, "targets": {}}
    if status == "collecting":
        out["message"] = (f"Collecting: {n_days} service day(s) logged, {wet_days} with rain. The model needs about "
                          f"{MODEL_MIN_DAYS} days including {MODEL_MIN_WET_DAYS} wet days before its numbers mean anything; "
                          f"the code runs on every build and switches itself on.")
    elif status == "provisional":
        out["message"] = f"Provisional: {n_days} days, {wet_days} wet. Treat differences between cells as noise until 'ready'."
    # forecast hours (next 48 h) from the weather forecast; published even while the model is collecting
    fut = pd.DataFrame()
    if wx is not None and not wx.empty:
        now = pd.Timestamp.now(tz=TZ).tz_localize(None).floor("h")
        f = wx[(wx.index >= now) & (wx.index < now + pd.Timedelta(hours=48))]
        if len(f):
            fut = pd.DataFrame({"t": f.index, "precip": f.precipitation.to_numpy(), "temp": f.temperature_2m.to_numpy()})
            fut["band"] = [_band(x.hour) for x in fut.t]
            fut["daytype"] = [_daytype(x) for x in fut.t]
            fut["wet"] = np.where(fut.precip >= WET_MM, "wet", "dry")
            out["weather_48h"] = [{"t": t.isoformat(), "precip": float(pr), "temp": float(tt), "band": b, "wet": w == "wet"}
                                  for t, pr, tt, b, w in zip(fut.t, fut.precip, fut.temp, fut.band, fut.wet)]
            fut = fut[fut.t.dt.hour.isin(list(range(5, 24)) + [0])]
    if u.empty:
        return out
    for target, label in (("delay", "mean delay at timepoints (min)"), ("ewt", "excess wait, frequent hours (min)")):
        uu = u.dropna(subset=[target])
        if uu.empty:
            continue
        m = fit(uu, target)
        grid = []
        for d in sorted(uu.dir.unique()):
            for band in ["early", "am_peak", "midday", "pm_peak", "evening", "late"]:
                for dt in ["weekday", "sat", "sun_hol"]:
                    for wet in ["dry", "wet"]:
                        row = pd.DataFrame([{"dir": d, "band": band, "daytype": dt, "wet": wet}])
                        cell = uu[(uu.dir == d) & (uu.band == band) & (uu.daytype == dt) & (uu.wet == wet)]
                        grid.append({"dir": int(d), "band": band, "daytype": dt, "wet": wet, "pred": float(predict(m, row)[0]),
                                     "n_hours": int(len(cell)), "observed_mean": float(cell[target].mean()) if len(cell) else None})
        fc = []
        for d in sorted(uu.dir.unique()):
            if len(fut):
                p = predict(m, fut.assign(dir=d))
                fc.append({"dir": int(d), "hours": [{"t": t.isoformat(), "pred": float(v), "precip": float(pr), "band": b}
                                                    for t, v, pr, b in zip(fut.t, p, fut.precip, fut.band)]})
        out["targets"][target] = {"label": label, "cv": lodo(uu, target), "grid": grid, "forecast_48h": fc,
                                  "overall_mean": float(uu[target].mean())}
    return out
