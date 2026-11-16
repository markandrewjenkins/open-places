"""Blink 95 Reliability: punctuality, waiting, bunching and lost time for BC Transit Victoria route 95.

  python -m pipelines.blink.build

Inputs: the collector's logs (data/blink/raw/log), the static schedule versions (raw/gtfs), hourly weather and OSM
corridor tags. Every figure carries the hours / days / trips / events behind it.

Definitions (thresholds in config.py)
    delay        observed departure minus scheduled departure at a stop (arrival at the last stop)
    on time      no more than 1 min early and no more than 5 min late, measured at timepoints, excluding each
                 trip's first stop (departure from the terminal)
    headway      time between consecutive buses leaving a stop in the same direction; the scheduled headway is the
                 timetable gap before the same trip
    bunched      headway under max(2 min, 25% of scheduled); gap = headway over 150% of scheduled
    excess wait  AWT - SWT where AWT = sum(h^2) / (2 sum(h)) over actual headways (random arrivals), SWT the same over
                 scheduled headways; only in frequent hours (scheduled headway <= 15 min) and only across stretches
                 the collector watched without a gap. Each stop weighted equally (no boarding counts are open).
    segment      timepoint to timepoint run time (departure to departure; arrival at the last stop) vs scheduled

Model (see model.py): delay and excess wait by direction x hour band x day type x wet/dry, as shrunken cell means,
tested by leaving one service day out at a time against an hour-of-day baseline and the timetable itself.
"""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timezone

import holidays
import numpy as np
import pandas as pd

from . import logio
from .config import (ATTRIBUTION, BUNCH_ABS, BUNCH_RATIO, COMPARE, FREQUENT_HEADWAY, GAP_RATIO, LICENCE, MAIN, ON_TIME_EARLY,
                     ON_TIME_LATE, OUT, RAW, ROUTES, TZ)
from .events import Coverage, stop_events, tu_estimates
from .network import corridor_tags, load_version, osm_ways, scheduled, shape, versions

DERIVED = RAW / "derived"
EVENTS_VERSION = 1
BC_HOL = holidays.Canada(prov="BC", years=range(2025, 2032))
BANDS = [("early", 4, 7), ("am_peak", 7, 9), ("midday", 9, 15), ("pm_peak", 15, 18), ("evening", 18, 22), ("late", 22, 28)]
BAND_LABEL = {"early": "Early (4–7)", "am_peak": "AM peak (7–9)", "midday": "Midday (9–15)", "pm_peak": "PM peak (15–18)",
              "evening": "Evening (18–22)", "late": "Late (22–4)"}
DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
WET_MM = 0.3                 # mm in the hour


# ============================================================================= json

def clean(o):
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return clean(o.tolist())
    if isinstance(o, (float, np.floating)):
        return None if not np.isfinite(o) else round(float(o), 3)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, pd.Timestamp):
        return None if pd.isna(o) else o.isoformat()
    if o is pd.NA or o is pd.NaT:
        return None
    return o


def dump(name: str, obj) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / name, "w", encoding="utf-8") as f:
        json.dump(clean(obj), f, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    print(f"  wrote {name} ({(OUT / name).stat().st_size / 1024:,.1f} KB)", flush=True)


def iso(epoch) -> str | None:
    if epoch is None or not np.isfinite(epoch):
        return None
    return pd.Timestamp(epoch, unit="s", tz="UTC").tz_convert(TZ).isoformat(timespec="seconds")


def band_of(hour: int) -> str:
    h = hour if hour >= 4 else hour + 24
    for k, a, b in BANDS:
        if a <= h < b:
            return k
    return "late"


def daytype(d: pd.Timestamp) -> str:
    if d.date() in BC_HOL or d.dayofweek == 6:
        return "sun_hol"
    return "sat" if d.dayofweek == 5 else "weekday"


# ============================================================================= assemble events

def load_logs():
    vp, tu, trips, polls, alerts = (logio.read_all(k) for k in ("vp", "tu", "trips", "polls", "alerts"))
    for df in (vp, tu, trips):
        if not df.empty:
            df["trip_id"] = df.trip_id.astype(str)
            df["start_date"] = df.start_date.astype(int)
            df["route"] = df.route.astype(str)
    return vp, tu, trips, polls, alerts


def build_events(vp, tu, trips, cov: Coverage) -> tuple[pd.DataFrame, pd.DataFrame]:
    """One row per scheduled stop of every trip on the logged service days, with observed times where known."""
    days = sorted({str(d) for d in vp.start_date.unique()} | ({str(d) for d in trips.start_date.unique()} if not trips.empty else set()))
    # closed service days (2+ days old) are cached; delete raw/derived/ after changing the event logic
    closed = (pd.Timestamp.now(tz=TZ) - pd.Timedelta(days=2)).strftime("%Y%m%d")
    DERIVED.mkdir(parents=True, exist_ok=True)
    cached, todo = [], []
    for d in days:
        f = DERIVED / f"events_v{EVENTS_VERSION}_{d}.parquet"
        (cached if f.exists() else todo).append(d)
    parts = [pd.read_parquet(DERIVED / f"events_v{EVENTS_VERSION}_{d}.parquet") for d in cached]
    sched = scheduled(todo) if todo else pd.DataFrame()
    if not sched.empty:
        sel = vp.start_date.astype(str).isin(todo)
        obs = stop_events(vp[sel], sched)
        tue = tu_estimates(tu[tu.start_date.astype(str).isin(todo)] if not tu.empty else tu)
        new = sched.merge(obs, on=["trip_id", "start_date", "seq"], how="left").merge(tue, on=["trip_id", "start_date", "seq"], how="left")
        for d, g in new.groupby("start_date"):
            if str(d) <= closed:
                g.to_parquet(DERIVED / f"events_v{EVENTS_VERSION}_{d}.parquet", index=False)
        parts.append(new)
    parts = [p_ for p_ in parts if len(p_)]
    if not parts:
        return pd.DataFrame(), pd.DataFrame()
    e = pd.concat(parts, ignore_index=True)
    if "tu_skipped" in e:
        e["tu_skipped"] = e.tu_skipped.astype("boolean")
    # time used for delay/headway: departure, except arrival at the last stop
    e["obs_t"] = np.where(e["last"], e.obs_arr, e.obs_dep)
    e["sched_t"] = np.where(e["last"], e.sched_arr, e.sched_dep)
    tu_t = np.where(e["last"], e.tu_arr, e.tu_dep).astype(float)
    reliable_tu = np.isfinite(tu_t) & (e.tu_lead.fillna(9e9) <= 30) & ~e.tu_skipped.fillna(False).astype(bool)
    e["source"] = np.where(np.isfinite(e.obs_t), "gps", np.where(reliable_tu, "feed", None))
    e["t"] = np.where(np.isfinite(e.obs_t), e.obs_t, np.where(reliable_tu, tu_t, np.nan))
    e["delay"] = e.t - e.sched_t
    e.loc[e["first"], "delay"] = e.loc[e["first"], "obs_dep"] - e.loc[e["first"], "sched_dep"]
    loc = pd.to_datetime(e.sched_t, unit="s", utc=True).dt.tz_convert(TZ)
    e["hour"] = loc.dt.hour
    e["local_hour"] = loc.dt.tz_localize(None).dt.floor("h")
    sd = pd.to_datetime(e.start_date.astype(str))
    e["dow"] = sd.dt.dayofweek
    e["daytype"] = [daytype(d) for d in sd]
    e["band"] = [band_of(h) for h in e.hour]

    # trip-level: was the whole scheduled trip inside watched time? tracked? cancelled?
    tr = e.groupby(["route", "trip_id", "start_date", "dir"]).agg(t0=("sched_dep", "min"), t1=("sched_arr", "max"),
                                                                 n_obs=("obs_t", lambda s: int(np.isfinite(s).sum())),
                                                                 headsign=("headsign", "first"), hour=("hour", "first")).reset_index()
    tr["watched"] = cov.covers(tr.t0 - 120, tr.t1 + 600)
    seen = set(zip(vp.trip_id, vp.start_date))
    tr["tracked"] = [(a, b) in seen for a, b in zip(tr.trip_id, tr.start_date)]
    canc = set()
    if not trips.empty:
        c = trips[trips.sr == 3]
        canc = set(zip(c.trip_id, c.start_date))
    tr["cancelled"] = [(a, b) in canc for a, b in zip(tr.trip_id, tr.start_date)]
    e = e.merge(tr[["trip_id", "start_date", "watched", "tracked", "cancelled"]], on=["trip_id", "start_date"], how="left")
    return e, tr


# ============================================================================= headways and excess wait

def headways(e: pd.DataFrame, cov: Coverage) -> pd.DataFrame:
    """Actual and scheduled headway before each observed bus at each stop (watched stretches only).
    A pair is dropped when it spans a coverage hole, or a tracked bus whose time at that stop is unknown
    (that would double the gap); genuinely missing (untracked / cancelled) trips do widen the gap."""
    keys = ["route", "dir", "stop_id", "start_date"]
    e = e.sort_values(keys + ["sched_t"]).copy()
    e["sched_h"] = e.groupby(keys).sched_t.diff()
    k = e[np.isfinite(e.t)].sort_values(keys + ["t"]).copy()
    if k.empty:
        return pd.DataFrame()
    g = k.groupby(keys)
    k["prev_t"], k["prev_sched_t"] = g.t.shift(), g.sched_t.shift()
    k = k[k.prev_t.notna()]
    k = k[cov.covers(k.prev_t.to_numpy(), k.t.to_numpy())]
    unk = e[~np.isfinite(e.t) & e.tracked.fillna(False).astype(bool)]
    if len(unk) and len(k):
        bad = np.zeros(len(k), bool)
        lo = np.minimum(k.prev_sched_t, k.prev_t).to_numpy()
        hi = np.maximum(k.sched_t, k.t).to_numpy()
        kk = k[keys].apply(tuple, axis=1).to_numpy()
        ug = {key: np.sort(gu.sched_t.to_numpy()) for key, gu in unk.groupby(keys)}
        for i, key in enumerate(kk):
            u = ug.get(key)
            if u is not None and np.searchsorted(u, hi[i], "left") > np.searchsorted(u, lo[i], "right"):
                bad[i] = True
        k = k[~bad]
    h = pd.DataFrame({c: k[c].to_numpy() for c in keys + ["trip_id", "seq", "hour", "band", "daytype", "dow", "local_hour", "timepoint"]})
    h["h"] = (k.t - k.prev_t).to_numpy()
    h["sched_h"] = k.sched_h.to_numpy()
    h = h[h.sched_h.notna() & (h.sched_h > 0)]
    if h.empty:
        return h
    h["ratio"] = h.h / h.sched_h
    h["bunched"] = h.h < np.maximum(BUNCH_ABS, BUNCH_RATIO * h.sched_h)
    h["gap"] = h.h > GAP_RATIO * h.sched_h
    return h.reset_index(drop=True)


def sched_headways(e: pd.DataFrame, cov: Coverage) -> pd.DataFrame:
    """Scheduled headways inside watched stretches (for SWT), every scheduled trip counted."""
    keys = ["route", "dir", "stop_id", "start_date"]
    x = e[keys + ["sched_t"]].sort_values(keys + ["sched_t"]).copy()
    x["prev"] = x.groupby(keys).sched_t.shift()
    x = x[x.prev.notna()]
    x = x[cov.covers(x.prev.to_numpy(), x.sched_t.to_numpy())]
    if x.empty:
        return pd.DataFrame()
    hr = pd.to_datetime(x.sched_t, unit="s", utc=True).dt.tz_convert(TZ)
    return pd.DataFrame({**{c: x[c].to_numpy() for c in keys}, "hs": (x.sched_t - x.prev).to_numpy(),
                         "local_hour": hr.dt.tz_localize(None).dt.floor("h").to_numpy(), "hour": hr.dt.hour.to_numpy()})


def wait_sums(h: pd.DataFrame, hs: pd.DataFrame, keys: list[str]) -> pd.DataFrame:
    """AWT, SWT, EWT per group, restricted to frequent stop-hours, from sums so groups can be pooled."""
    if h.empty or hs.empty:
        return pd.DataFrame()
    unit = ["route", "dir", "stop_id", "local_hour"]
    s = hs.groupby(unit).hs.agg(sh="sum", sh2=lambda x: float((x ** 2).sum()), med="median").reset_index()
    s = s[s.med <= FREQUENT_HEADWAY]
    a = h.assign(h2=h.h ** 2).groupby(unit).agg(ah=("h", "sum"), ah2=("h2", "sum"), n=("h", "size")).reset_index()
    m = s.merge(a, on=unit, how="inner")
    if m.empty:
        return pd.DataFrame()
    lh = pd.to_datetime(m.local_hour)
    m["hour"] = lh.dt.hour
    m["band"] = [band_of(x) for x in m.hour]
    m["dow"] = lh.dt.dayofweek
    m["daytype"] = [daytype(x.normalize()) for x in lh]
    g = m.groupby(keys) if keys else m.assign(_all=1).groupby("_all")
    r = g.agg(ah=("ah", "sum"), ah2=("ah2", "sum"), sh=("sh", "sum"), sh2=("sh2", "sum"), n=("n", "sum"),
              stop_hours=("ah", "size")).reset_index()
    r["awt"] = r.ah2 / (2 * r.ah) / 60
    r["swt"] = r.sh2 / (2 * r.sh) / 60
    r["ewt"] = r.awt - r.swt
    return r.drop(columns=["ah", "ah2", "sh", "sh2"])


# ============================================================================= summaries

def punctuality(df: pd.DataFrame) -> dict:
    """OTP etc. over timepoint events (excluding trip origins) with a known delay."""
    d = df.delay.dropna()
    if d.empty:
        return {"n": 0}
    return {"n": int(len(d)), "trips": int(df.loc[df.delay.notna(), ["trip_id", "start_date"]].drop_duplicates().shape[0]),
            "on_time": float(((d >= -ON_TIME_EARLY) & (d <= ON_TIME_LATE)).mean()),
            "early": float((d < -ON_TIME_EARLY).mean()), "late": float((d > ON_TIME_LATE).mean()),
            "median_delay_min": float(d.median() / 60), "p90_delay_min": float(d.quantile(0.9) / 60),
            "mean_delay_min": float(d.mean() / 60)}


def headway_summary(h: pd.DataFrame) -> dict:
    if h.empty:
        return {"n": 0}
    f = h[h.sched_h <= FREQUENT_HEADWAY]
    return {"n": int(len(h)), "n_frequent": int(len(f)), "bunched": float(h.bunched.mean()), "gap": float(h.gap.mean()),
            "median_ratio": float(h.ratio.median()), "cv": float(h.h.std() / h.h.mean()) if len(h) > 2 else None,
            "within_50pct": float(((h.ratio >= 0.5) & (h.ratio <= 1.5)).mean())}


def wait_dict(w: pd.DataFrame) -> dict:
    if w is None or w.empty:
        return {"n": 0}
    r = w.iloc[0]
    return {"awt_min": r.awt, "swt_min": r.swt, "ewt_min": r.ewt, "n": int(r.n), "stop_hours": int(r.stop_hours)}


def group_table(e_tp, h, w_fn, keys) -> list[dict]:
    out = []
    groups = e_tp.groupby(keys) if len(e_tp) else []
    hw = {k if isinstance(k, tuple) else (k,): g for k, g in h.groupby(keys)} if not h.empty else {}
    w = w_fn(keys)
    wmap = {tuple(r[k] for k in keys): r for _, r in w.iterrows()} if w is not None and not w.empty else {}
    for k, g in groups:
        k = k if isinstance(k, tuple) else (k,)
        row = dict(zip(keys, k))
        row.update(punctuality(g))
        hs = headway_summary(hw.get(k, pd.DataFrame()))
        row.update({"bunched": hs.get("bunched"), "gap": hs.get("gap"), "n_headways": hs.get("n", 0)})
        wr = wmap.get(k)
        if wr is not None:
            row.update({"awt_min": wr.awt, "swt_min": wr.swt, "ewt_min": wr.ewt})
        out.append(row)
    return out


def segments(e: pd.DataFrame, net: dict) -> tuple[list, list]:
    """Timepoint-to-timepoint run times, and stop-to-stop time lost, for route 95 by direction and hour band."""
    m = e[(e.route == MAIN) & np.isfinite(e.t)]
    seg_rows, link_rows = [], []
    for (trip, day), g in m.groupby(["trip_id", "start_date"]):
        g = g.sort_values("seq")
        d = int(g.dir.iloc[0])
        tp = g[(g.timepoint == 1) | g["first"] | g["last"]]
        for a, b in zip(tp.itertuples(), tp.iloc[1:].itertuples()):
            seg_rows.append((d, a.stop_id, b.stop_id, a.band, a.hour, a.daytype, day, b.t - a.t, b.sched_t - a.sched_t))
        for a, b in zip(g.itertuples(), g.iloc[1:].itertuples()):
            if b.seq != a.seq + 1:
                continue
            link_rows.append((d, a.stop_id, b.stop_id, a.band, day, (b.t - a.t) - (b.sched_t - a.sched_t), b.t - a.t))
    S = pd.DataFrame(seg_rows, columns=["dir", "from", "to", "band", "hour", "daytype", "day", "rt", "srt"])
    L = pd.DataFrame(link_rows, columns=["dir", "from", "to", "band", "day", "lost", "rt"])
    segs = []
    for (d, a, b), g in S.groupby(["dir", "from", "to"]) if len(S) else []:
        meta = net["segments"].get((d, a, b), {})
        rec = {"dir": d, "from": a, "to": b, **meta, "n": len(g), "days": g.day.nunique(),
               "sched_min": g.srt.median() / 60, "actual_min": g.rt.median() / 60, "p90_min": g.rt.quantile(0.9) / 60,
               "lost_min": (g.rt - g.srt).median() / 60, "by_band": [], "by_hour": []}
        for band, gb in g.groupby("band"):
            rec["by_band"].append({"band": band, "n": len(gb), "sched_min": gb.srt.median() / 60, "actual_min": gb.rt.median() / 60,
                                   "p90_min": gb.rt.quantile(0.9) / 60, "lost_min": (gb.rt - gb.srt).median() / 60})
        for hr, gh in g.groupby("hour"):
            rec["by_hour"].append({"hour": int(hr), "n": len(gh), "actual_min": gh.rt.median() / 60, "sched_min": gh.srt.median() / 60})
        segs.append(rec)
    links = []
    for (d, a, b), g in L.groupby(["dir", "from", "to"]) if len(L) else []:
        meta = net["links"].get((d, a, b), {})
        rec = {"dir": d, "from": a, "to": b, **meta, "n": len(g), "lost_med_s": g.lost.median(), "lost_p90_s": g.lost.quantile(0.9),
               "by_band": {band: {"n": len(gb), "lost_med_s": gb.lost.median()} for band, gb in g.groupby("band")}}
        links.append(rec)
    return segs, links


# ============================================================================= network geometry

def network() -> dict:
    """Stops, shapes and corridor tags for the main pattern of each direction (latest schedule)."""
    v = versions()[-1]
    g = load_version(v)
    trips, st, stops = g["trips"], g["stop_times"], g["stops"].set_index("stop_id")
    ways = osm_ways()
    out = {"version": v, "routes": {}, "segments": {}, "links": {}}
    for r in ROUTES:
        rt = trips[trips.route_id == f"{r}-VIC"]
        dirs = []
        for d, gd in rt.groupby("direction_id"):
            shp = gd.shape_id.value_counts().index[0]                 # the pattern most trips use
            S = shape(v, shp)
            trip = gd[gd.shape_id == shp].trip_id.iloc[0]
            ss = st[st.trip_id == trip].assign(seq=lambda x: x.stop_sequence.astype(int)).sort_values("seq")
            line = [[round(a, 5), round(b, 5)] for a, b in zip(S.lat, S.lon)]
            entry = {"dir": int(d), "headsign": gd.trip_headsign.value_counts().index[0], "shape_id": shp,
                     "length_km": round(S.length / 1000, 2), "line": line, "trips_in_feed": int(len(gd))}
            if r == MAIN:
                sl = []
                for x in ss.itertuples():
                    s = stops.loc[x.stop_id]
                    sl.append({"id": x.stop_id, "name": s.stop_name, "lat": float(s.stop_lat), "lon": float(s.stop_lon),
                               "seq": x.seq, "dist_m": float(x.shape_dist_traveled), "timepoint": int(x.timepoint or 0)})
                entry["stops"] = sl
                tps = [s for s in sl if s["timepoint"] or s is sl[0] or s is sl[-1]]
                for a, b in zip(tps, tps[1:]):
                    tags = corridor_tags(S, a["dist_m"], b["dist_m"], ways)
                    out["segments"][(int(d), a["id"], b["id"])] = {"from_name": a["name"], "to_name": b["name"],
                                                                     "km": round((b["dist_m"] - a["dist_m"]) / 1000, 2), **tags}
                for a, b in zip(sl, sl[1:]):
                    tags = corridor_tags(S, a["dist_m"], b["dist_m"], ways)
                    out["links"][(int(d), a["id"], b["id"])] = {"km": round((b["dist_m"] - a["dist_m"]) / 1000, 2),
                                                                  "line": S.slice(a["dist_m"], b["dist_m"]), **tags}
            dirs.append(entry)
        out["routes"][r] = {"dirs": dirs, "name": g["routes"].set_index("route_id").route_long_name.get(f"{r}-VIC"),
                            "color": g["routes"].set_index("route_id").route_color.get(f"{r}-VIC")}
    return out


# ============================================================================= timetable summary (known from day 1)

def schedule_summary(net: dict) -> dict:
    """Route 95 timetable for the next weekday, Saturday and Sunday/holiday in the current schedule: trips, scheduled
    headway and run time by hour, and the service span, per direction."""
    v = net["version"]
    cal = load_version(v)["calendar_dates"]
    today = pd.Timestamp.now(tz=TZ).strftime("%Y%m%d")
    pick = {}
    for d in sorted(cal[cal.exception_type == "1"].date.unique()):
        if d >= today:
            pick.setdefault(daytype(pd.Timestamp(d)), d)
    out = {}
    heads = {dd["dir"]: dd["headsign"] for dd in net["routes"][MAIN]["dirs"]}
    for dt, d in pick.items():
        s = scheduled([d])
        s = s[s.route == MAIN]
        if s.empty:
            continue
        dirs = []
        for di, g in s.groupby("dir"):
            trips = g.groupby("trip_id").agg(t0=("sched_dep", "min"), t1=("sched_arr", "max")).sort_values("t0")
            loc = pd.to_datetime(trips.t0, unit="s", utc=True).dt.tz_convert(TZ)
            base = (pd.Timestamp(f"{d[:4]}-{d[4:6]}-{d[6:]}", tz=TZ)).timestamp()
            trips["h"] = ((trips.t0 - base) // 3600).astype(int)                     # hours past midnight (24+ = after)
            trips["hw"] = trips.t0.diff()
            trips["rt"] = trips.t1 - trips.t0
            hours = [{"h": int(h), "trips": int(len(x)), "headway_min": float(x.hw.median() / 60) if x.hw.notna().any() else None,
                      "runtime_min": float(x.rt.median() / 60)} for h, x in trips.groupby("h")]
            dirs.append({"dir": int(di), "headsign": heads.get(int(di)), "trips": int(len(trips)),
                         "first": loc.iloc[0].strftime("%H:%M"), "last": loc.iloc[-1].strftime("%H:%M"),
                         "min_headway_min": float(trips.hw.min() / 60) if len(trips) > 1 else None,
                         "runtime_min": float(trips.rt.median() / 60), "hours": hours})
        out[dt] = {"date": f"{d[:4]}-{d[4:6]}-{d[6:]}", "dirs": dirs}
    return {"version": v, "daytypes": out}


# ============================================================================= trajectories, live

def trajectories(e: pd.DataFrame, n_days: int = 2) -> dict:
    """Route 95 trips of the latest logged days as distance-time strings (scheduled and observed) for a Marey chart."""
    m = e[e.route == MAIN]
    days = sorted(m[np.isfinite(m.t)].start_date.unique())[-n_days:]
    out = {}
    for day in days:
        g = m[m.start_date == day]
        trips = []
        for (trip, d), tg in g.groupby(["trip_id", "dir"]):
            tg = tg.sort_values("seq")
            obs = tg[np.isfinite(tg.t)]
            trips.append({"trip": trip, "dir": int(d), "sched": [[int(a), int(b)] for a, b in zip(tg.sched_t, tg.dist)],
                          "obs": [[int(a), int(b)] for a, b in zip(obs.t, obs.dist)], "cancelled": bool(tg.cancelled.iloc[0])})
        out[str(day)] = trips
    return out


def live(vp: pd.DataFrame, tu: pd.DataFrame, polls: pd.DataFrame) -> dict:
    if vp.empty:
        return {"vehicles": [], "replay": {"tracks": []}}
    ok = polls[polls.ok == 1]
    last = int(ok.obs.max()) if len(ok) else int(vp.obs.max())
    v = vp[(vp.obs >= last - 120)].sort_values("ts").groupby("vehicle").tail(1)
    v = v[v.route == MAIN]
    lastdelay = {}
    if not tu.empty:
        t = tu[tu.route == MAIN].sort_values("obs").groupby(["trip_id", "start_date"]).tail(1)
        lastdelay = {(a, b): (c if pd.notna(c) else dd) for a, b, c, dd in zip(t.trip_id, t.start_date, t.dep_delay, t.arr_delay)}
    rows = []
    for r in v.itertuples():
        dl = lastdelay.get((r.trip_id, r.start_date))
        rows.append({"vehicle": r.vehicle, "trip": r.trip_id, "dir": int(r.dir), "lat": r.lat, "lon": r.lon,
                     "bearing": None if pd.isna(r.bearing) else r.bearing, "speed_kmh": None if pd.isna(r.speed) else r.speed * 3.6,
                     "stop_id": r.stop_id, "seq": None if pd.isna(r.seq) else int(r.seq), "occupancy": None if pd.isna(r.occ) else int(r.occ),
                     "delay_s": None if dl is None or pd.isna(dl) else int(dl), "reported": iso(r.ts)})
    # the last logged hour of route 95 positions, for a replay (the feed itself can't be read from a browser)
    rec = vp[(vp.route == MAIN) & (vp.ts >= last - 3600) & (vp.ts <= last + 60)].sort_values("ts")
    replay = [{"vehicle": str(vid), "dir": int(g.dir.iloc[-1]), "trip": str(g.trip_id.iloc[-1]),
               "pts": [[int(t), round(float(a), 5), round(float(b), 5)] for t, a, b in zip(g.ts, g.lat, g.lon)]}
              for vid, g in rec.groupby("vehicle")]
    return {"as_of": iso(last), "as_of_epoch": last, "vehicles": rows,
            "replay": {"from": iso(last - 3600), "to": iso(last), "from_epoch": last - 3600, "to_epoch": last, "tracks": replay}}


# ============================================================================= main

def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    gen = datetime.now(timezone.utc).isoformat(timespec="minutes")
    status = json.loads((RAW / "status.json").read_text(encoding="utf-8")) if (RAW / "status.json").exists() else {}
    cstat = json.loads((RAW / "collector_status.json").read_text(encoding="utf-8")) if (RAW / "collector_status.json").exists() else {}
    vp, tu, trips, polls, alerts = load_logs()
    if vp.empty or polls.empty:
        print("no logs yet: run `python -m pipelines.blink.collect`", flush=True)
        return 0
    cov = Coverage(polls)
    print(f"  logs: {len(vp):,} positions, {len(tu):,} trip-update rows, {len(polls):,} polls, {cov.hours():.1f} watched hours", flush=True)
    net = network()
    e, tr = build_events(vp, tu, trips, cov)
    if e.empty:
        print("no scheduled trips match the logs yet", flush=True)
        return 0
    print(f"  events: {int(np.isfinite(e.t).sum()):,} stop times of {len(e):,} scheduled ({int(np.isfinite(e.obs_t).sum()):,} from GPS)", flush=True)
    # a stop event counts when that moment was watched (whole-trip coverage only gates delivered/cancelled counts)
    tref = np.where(np.isfinite(e.t), e.t, e.sched_t)
    ew = e[cov.covers(tref - 90, tref + 90)]
    tp = ew[(ew.timepoint == 1) & ~ew["first"]]                  # punctuality base
    h = headways(ew, cov)
    hs = sched_headways(ew, cov)
    wfn = lambda keys: wait_sums(h, hs, keys)                    # noqa: E731

    # weather per local hour
    wx = pd.read_parquet(RAW / "weather_hourly.parquet") if (RAW / "weather_hourly.parquet").exists() else pd.DataFrame()
    if not wx.empty:
        wx = wx.set_index("t")
        e_wet = tp.local_hour.map(wx.precipitation)
        tp = tp.assign(wet=np.where(e_wet.isna(), None, np.where(e_wet >= WET_MM, "wet", "dry")))
        if not h.empty:
            hw_ = h.local_hour.map(wx.precipitation)
            h = h.assign(wet=np.where(hw_.isna(), None, np.where(hw_ >= WET_MM, "wet", "dry")))

    # coverage
    by_day = cov.hours_by(TZ, "D") / 3600
    per_hour = cov.hours_by(TZ, "h") / 3600
    days_logged = sorted({str(x.date()) for x in by_day.index})
    n_full = int((by_day >= 18).sum())
    coverage = {"first": iso(cov.ok[0]), "last": iso(cov.ok[-1]), "watched_hours": cov.hours(), "days_logged": len(days_logged),
                "days_18h_plus": n_full, "polls": int(len(polls)), "polls_ok": int((polls.ok == 1).sum()),
                "outages": [{"from": iso(a), "to": iso(b), "min": (b - a) / 60} for a, b in cov.outages() if b - a > 300][-50:],
                "by_day": [{"date": str(k.date()), "hours": v} for k, v in by_day.items()],
                "watched_hours_by_hour_of_day": per_hour.groupby(per_hour.index.hour).sum().to_dict(),
                "rows": {"positions": int(len(vp)), "trip_update_rows": int(len(tu)), "trip_states": int(len(trips))}}

    # headline per route
    def route_block(r):
        trr = tr[(tr.route == r) & tr.watched]
        tpr, hr = tp[tp.route == r], (h[h.route == r] if not h.empty else h)
        w = wait_sums(hr, hs[hs.route == r] if not hs.empty else hs, []) if not hr.empty else None
        ends = []
        for (trip, day), g in ew[(ew.route == r)].groupby(["trip_id", "start_date"]):
            f, l = g[g["first"]], g[g["last"]]
            if len(f) and len(l) and np.isfinite(f.t.iloc[0]) and np.isfinite(l.t.iloc[0]):
                ends.append((int(g.dir.iloc[0]), l.t.iloc[0] - f.t.iloc[0], l.sched_t.iloc[0] - f.sched_t.iloc[0]))
        E = pd.DataFrame(ends, columns=["dir", "rt", "srt"])
        blk = {"route": r, "trips_scheduled_watched": int(len(trr)), "trips_tracked": int(trr.tracked.sum()),
               "trips_cancelled": int(trr.cancelled.sum()),
               "punctuality": punctuality(tpr), "headways": headway_summary(hr), "wait": wait_dict(w),
               "end_to_end": {"n": len(E), "median_min": E.rt.median() / 60 if len(E) else None,
                              "sched_median_min": E.srt.median() / 60 if len(E) else None,
                              "p90_min": E.rt.quantile(0.9) / 60 if len(E) else None},
               "days": int(tpr.start_date.nunique()), "gps_share": float((ew[ew.route == r].source == "gps").mean())
               if (ew.route == r).any() else None}
        blk["by_dir"] = []
        for d in sorted(ew[ew.route == r].dir.unique()):
            hd = hr[hr.dir == d] if not hr.empty else hr
            wd = wait_sums(hd, hs[(hs.route == r) & (hs.dir == d)], []) if not hd.empty else None
            Ed = E[E.dir == d]
            blk["by_dir"].append({"dir": int(d), "punctuality": punctuality(tpr[tpr.dir == d]), "headways": headway_summary(hd),
                                  "wait": wait_dict(wd), "end_to_end_median_min": Ed.rt.median() / 60 if len(Ed) else None,
                                  "end_to_end_sched_min": Ed.srt.median() / 60 if len(Ed) else None})
        return blk

    routes = {r: route_block(r) for r in ROUTES}
    main95 = routes[MAIN]
    tp95, h95 = tp[tp.route == MAIN], (h[h.route == MAIN] if not h.empty else h)
    w95 = lambda keys: wait_sums(h95, hs[hs.route == MAIN] if not hs.empty else hs, keys) if not h95.empty else None  # noqa: E731

    # cross-check: GPS-derived vs BC Transit's own last prediction at the same stop
    both = ew[np.isfinite(ew.obs_t) & (ew.tu_lead <= 30)]
    tu_t = np.where(both["last"], both.tu_arr, both.tu_dep).astype(float)
    diff = (both.obs_t - tu_t).dropna()
    xcheck = {"n": int(len(diff)), "median_abs_s": float(diff.abs().median()) if len(diff) else None,
              "median_s": float(diff.median()) if len(diff) else None}

    daily = []
    for day, g in tp95.groupby("start_date"):
        hd = h95[h95.start_date == day] if not h95.empty else h95
        wd = wait_sums(hd, hs[(hs.route == MAIN) & (hs.start_date == day)], []) if not hd.empty else None
        daily.append({"date": f"{str(day)[:4]}-{str(day)[4:6]}-{str(day)[6:]}", **punctuality(g),
                      "bunched": headway_summary(hd).get("bunched"), "ewt_min": wait_dict(wd).get("ewt_min"),
                      "watched_hours": float(by_day.get(pd.Timestamp(str(day)), 0.0))})

    al = []
    if not alerts.empty:
        a = alerts.sort_values("obs").groupby("alert_id").tail(1)
        for r in a.itertuples():
            al.append({"id": r.alert_id, "routes": str(r.routes).split(), "effect": r.effect, "cause": r.cause,
                       "text": None if pd.isna(r.header) else r.header, "first_logged": iso(alerts[alerts.alert_id == r.alert_id].obs.min()),
                       "periods": None if pd.isna(r.periods) else r.periods})

    seg, links = segments(ew, net)
    hours_backing = round(cov.hours(), 1)
    note = (f"Based on {hours_backing} watched hours over {len(days_logged)} day(s) "
            f"({coverage['first'][:16].replace('T', ' ')} to {coverage['last'][:16].replace('T', ' ')} Pacific).")

    dump("blink.json", {
        "generated": gen, "title": "Blink 95 Reliability", "route": MAIN, "compare": COMPARE, "note": note,
        "licence": LICENCE, "attribution": ATTRIBUTION,
        "definitions": {"on_time_early_s": ON_TIME_EARLY, "on_time_late_s": ON_TIME_LATE, "bunch_ratio": BUNCH_RATIO,
                        "bunch_abs_s": BUNCH_ABS, "gap_ratio": GAP_RATIO, "frequent_headway_s": FREQUENT_HEADWAY, "wet_mm_per_h": WET_MM,
                        "bands": {k: BAND_LABEL[k] for k, _, _ in BANDS}},
        "coverage": coverage, "headline": main95, "compare_routes": [routes[r] for r in COMPARE],
        "names": {r: net["routes"][r]["name"] for r in ROUTES}, "daily": daily, "cross_check": xcheck, "alerts": al,
        "freshness": {"collector": cstat, "sources": status},
    })
    dump("network.json", {"version": net["version"],
                          "routes": {r: v for r, v in net["routes"].items()},
                          "segments": [{"dir": k[0], "from": k[1], "to": k[2], **v} for k, v in net["segments"].items()]})
    cats = lambda keys: group_table(tp95, h95, w95, keys)          # noqa: E731
    pat = {"note": note, "by_hour": cats(["dir", "hour"]), "by_band": cats(["dir", "band"]), "by_dow": cats(["dir", "dow"]),
           "by_daytype_hour": cats(["daytype", "hour"]), "by_daytype_band": cats(["daytype", "band"]),
           "compare_by_band": group_table(tp[tp.route.isin(ROUTES)], h, wfn, ["route", "band"])}
    if "wet" in tp95:
        pat["by_weather_band"] = group_table(tp95[tp95.wet.notna()], h95[h95.wet.notna()] if "wet" in h95 else h95, lambda k: None, ["wet", "band"])
        pat["by_weather"] = group_table(tp95[tp95.wet.notna()], h95[h95.wet.notna()] if "wet" in h95 else h95, lambda k: None, ["wet"])
    dump("patterns.json", pat)

    # stops
    stops_out = []
    allstop = ew[(ew.route == MAIN)]
    names = {st["id"]: st["name"] for dd in net["routes"][MAIN]["dirs"] for st in dd.get("stops", [])}
    names.update(load_version(net["version"])["stops"].set_index("stop_id").stop_name.to_dict() | names)
    hstop = {k: g for k, g in h95.groupby(["dir", "stop_id"])} if not h95.empty else {}
    wst = w95(["dir", "stop_id"])
    wmap = {(r.dir, r.stop_id): r for r in wst.itertuples()} if wst is not None and not wst.empty else {}
    for (d, sid), g in allstop.groupby(["dir", "stop_id"]):
        g2 = g[~g["first"]]
        p = punctuality(g2) if len(g2) else {"n": 0}
        if g["first"].all():
            p = punctuality(g.assign(delay=g.obs_dep - g.sched_dep))
        hsum = headway_summary(hstop.get((d, sid), pd.DataFrame()))
        wr = wmap.get((d, sid))
        stops_out.append({"dir": int(d), "stop_id": sid, "name": names.get(sid), "seq": int(g.seq.median()), "timepoint": int(g.timepoint.max()),
                          **p, "p10_delay_min": float(g2.delay.quantile(0.1) / 60) if g2.delay.notna().any() else None,
                          "bunched": hsum.get("bunched"), "gap": hsum.get("gap"), "headway_cv": hsum.get("cv"),
                          "n_headways": hsum.get("n", 0), "ewt_min": None if wr is None else wr.ewt,
                          "awt_min": None if wr is None else wr.awt, "swt_min": None if wr is None else wr.swt})
    dump("stops.json", {"note": note, "stops": sorted(stops_out, key=lambda s: (s["dir"], s["seq"]))})
    dump("segments.json", {"note": note, "segments": seg, "links": links})

    bins = [0, .25, .5, .75, 1, 1.25, 1.5, 2, 3, 99]
    hist = []
    if not h95.empty:
        for d, g in h95.groupby("dir"):
            c = pd.cut(g.ratio, bins, right=False).value_counts(sort=False)
            hist.append({"dir": int(d), "bins": bins, "counts": c.tolist(), "n": int(len(g))})
    dump("headways.json", {"note": note, "ratio_hist": hist, "trajectories": trajectories(ew)})
    dump("live.json", live(vp, tu, polls))
    dump("schedule.json", schedule_summary(net))

    from .model import run_model
    mdl = run_model(tp95, h95, hs[hs.route == MAIN] if not hs.empty else hs, wx)
    dump("model.json", mdl)
    print(f"  {note}", flush=True)
    p = main95["punctuality"]
    if p.get("n"):
        print(f"  route 95: on time {p['on_time']:.0%} of {p['n']:,} timepoint departures; median delay {p['median_delay_min']:.1f} min; "
              f"bunched {main95['headways'].get('bunched') or 0:.0%}; EWT {main95['wait'].get('ewt_min')} min; model: {mdl['status']}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
