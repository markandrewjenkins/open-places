"""Langford Boom Tracker: permits, population, a seasonal housing-units forecast with rolling-origin backtests,
the development-application pipeline and aerial-photo hotspots.

  python -m pipelines.langford.build

Forecast (open data only)
    Target: monthly residential units (and total permit value) in BC Stats building permits, for Langford and the
    CRD, 12 months ahead. Headline: the trailing-12-month mean, the pre-registered baseline that won. Planned model
    "seasonal variant": the deseasonalised mean of the last 12 months times a monthly seasonal index from the whole
    CRD, shrunk halfway towards 1; permit seasonality turned out too weak to help, so it is shown as a comparison.
    Other baseline: seasonal naive (same month last year). Every month from Dec 2020 is a
    forecast origin; each model is refitted on data up to that origin only and scored on the next 1–12 months.
    The 80% band comes from the empirical spread of backtest errors (actual ÷ forecast); its coverage is checked
    out of sample (band from origins before 2024-09, scored on later origins).
Pipeline (UNLICENSED source)
    City of Langford Development Tracker: applications by stage, monthly intake, and typical time between stages
    (Kaplan–Meier medians, so files still waiting count as censored rather than being dropped).
Outputs (site/public/data/langford/)
    langford.json   OPEN: permits, population, census, forecast, freshness          (publishable)
    backtest.json   OPEN: every backtest origin × horizon × model                    (publishable)
    tracker.json    UNLICENSED (City of Langford): applications, stages, durations   (langford_unlicensed: true)
    orthos.json     UNLICENSED (City of Langford): ortho services, hotspots          (langford_unlicensed: true)
"""
from __future__ import annotations

import json
import math
import re
from datetime import datetime

import numpy as np
import pandas as pd
from PIL import Image

from .config import CRD_PREFIX, GEOS, HOTSPOTS, LICENCES, OUT, RAW, THUMB_HALF_M, TRACKER

SERIES = ["units_total", "units_single", "units_row", "units_apt", "value_total", "value_res", "value_ind", "value_com", "value_inst"]
FIRST_ORIGIN = pd.Timestamp("2020-12-01")       # ≥ 36 months of training data at the first backtest origin
COVERAGE_SPLIT = pd.Timestamp("2024-09-01")     # band fitted on origins before this, coverage scored on origins from it
SHRINK = 0.5                                    # seasonal index shrinkage towards 1
H = 12


# ============================================================================= helpers

def clean(o):
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return clean(o.tolist())
    if isinstance(o, (float, np.floating)):
        return None if not np.isfinite(o) else round(float(o), 4)
    if isinstance(o, (bool, np.bool_)):
        return bool(o)
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, pd.Timestamp):
        return None if pd.isna(o) else (o.strftime("%Y-%m-%d") if o == o.normalize() and o.tzinfo is None else o.isoformat())
    if o is pd.NA or o is pd.NaT:  # before datetime: NaT is a datetime whose isoformat() is "NaT"
        return None
    if isinstance(o, datetime):
        return o.isoformat()
    return o


def dump(name, obj):
    f = OUT / name
    f.parent.mkdir(parents=True, exist_ok=True)
    with open(f, "w", encoding="utf-8") as fh:
        json.dump(clean(obj), fh, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    print(f"  wrote {name} ({f.stat().st_size / 1024:,.0f} KB)")


def read_json(name, default=None):
    f = OUT / name
    try:
        return json.loads(f.read_text(encoding="utf-8")) if f.exists() else default
    except ValueError:
        return default


def ym(t) -> str:
    return pd.Timestamp(t).strftime("%Y-%m")


def utm10_to_lonlat(x: float, y: float) -> tuple[float, float]:
    """Inverse transverse Mercator, UTM zone 10N on GRS80 (NAD83 ≈ WGS84 at this scale)."""
    a, f, k0 = 6378137.0, 1 / 298.257222101, 0.9996
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    x -= 500000.0
    m = y / k0
    mu = m / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu) \
        + (151 * e1 ** 3 / 96) * math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * math.sin(8 * mu)
    c1, t1 = ep2 * math.cos(p1) ** 2, math.tan(p1) ** 2
    n1 = a / math.sqrt(1 - e2 * math.sin(p1) ** 2)
    r1 = a * (1 - e2) / (1 - e2 * math.sin(p1) ** 2) ** 1.5
    d = x / (n1 * k0)
    lat = p1 - (n1 * math.tan(p1) / r1) * (d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4 / 24
                                           + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6 / 720)
    lon = (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5 / 120) / math.cos(p1)
    return round(-123 + math.degrees(lon), 6), round(math.degrees(lat), 6)


def metres(lon1, lat1, lon2, lat2):
    return np.hypot((np.asarray(lon2) - lon1) * 111320 * math.cos(math.radians(lat1)), (np.asarray(lat2) - lat1) * 110540)


# ============================================================================= permits (open)

def load_permits() -> tuple[pd.DataFrame, dict]:
    b = pd.read_parquet(RAW / "bper.parquet")
    names = b.drop_duplicates("sgc").set_index("sgc").name.to_dict()
    return b, names


def geo_frame(b: pd.DataFrame, sgc: str) -> pd.DataFrame:
    """month × series table for one geography (NaN = suppressed or not reported)."""
    return b[b.sgc == sgc].pivot_table(index="month", columns="series", values="value", aggfunc="first", dropna=False).reindex(columns=SERIES)


def permits_block(b, months, pop) -> dict:
    out = {"months": [ym(m) for m in months], "unit_value": "$000 (current dollars, not seasonally adjusted)", "geos": {}}
    for key, (label, sgc, _) in GEOS.items():
        g = geo_frame(b, sgc).reindex(months)
        # trailing 12 months; suppressed months count as missing (a lower bound), and ≥10 reported months are required
        ttm = {s: g[s].rolling(12, min_periods=10).sum() for s in ("units_total", "value_total")}
        ttm_x = g["units_total"].isna().astype(int).rolling(12, min_periods=1).sum()
        out["geos"][key] = {"label": label, "sgc": sgc,
                            **{s: g[s].tolist() for s in SERIES},
                            "units_ttm": ttm["units_total"].tolist(), "value_ttm": ttm["value_total"].tolist(),
                            "units_ttm_suppressed": ttm_x.astype(int).tolist()}
    # annual totals and per-capita (complete years only for rates; the current year is year-to-date)
    last = months[-1]
    annual = {}
    for key, (label, sgc, _) in GEOS.items():
        g = geo_frame(b, sgc)
        rows = []
        for yr, gy in g.groupby(g.index.year):
            p = pop.get(key, {}).get(int(yr))
            u = gy.units_total.sum(min_count=1)
            rows.append({"year": int(yr), "months": int(len(gy)), "units": u, "value": gy.value_total.sum(min_count=1),
                         "units_suppressed_months": int(gy.units_total.isna().sum()),
                         "single": gy.units_single.sum(min_count=1), "row": gy.units_row.sum(min_count=1), "apt": gy.units_apt.sum(min_count=1),
                         "pop": p, "units_per_1000": (u / p * 1000) if p and len(gy) == 12 else None,
                         "partial": int(len(gy)) < 12})
        annual[key] = rows
    out["annual"] = annual
    out["latest_month"] = ym(last)
    return out


def league_table(b, names, popraw) -> dict:
    """Every CRD municipality: units per 1,000 residents, last 12 months and 2018–latest full year."""
    last = b.month.max()
    p = popraw[popraw.kind == "Estimate"]
    latest_pop_year = int(p.year.max())
    rows = []
    for sgc in sorted(c for c in names if c.startswith(CRD_PREFIX) and len(c) == 7):
        code = int(sgc[2:])                                    # 5917044 → 17044 (BC Stats region code)
        pp = p[p.region == code]
        if pp.empty:
            continue
        g = geo_frame(b, sgc)
        ttm = g.units_total[g.index > last - pd.DateOffset(months=12)]
        full = g[g.index.year <= last.year - 1].units_total
        pop_now = float(pp[pp.year == latest_pop_year]["pop"].iloc[0])
        pop16 = pp[pp.year == 2016]["pop"]
        rows.append({"sgc": sgc, "name": names[sgc], "pop": pop_now, "pop_year": latest_pop_year,
                     "pop_growth_since_2016": (pop_now / float(pop16.iloc[0]) - 1) if len(pop16) else None,
                     "units_ttm": ttm.sum(min_count=1), "units_ttm_suppressed": int(ttm.isna().sum()),
                     "units_ttm_per_1000": ttm.sum(min_count=1) / pop_now * 1000,
                     "units_2018_on": full.sum(min_count=1), "units_2018_on_per_1000": full.sum(min_count=1) / pop_now * 1000})
    rows.sort(key=lambda r: -(r["units_ttm_per_1000"] or 0))
    return {"through": ym(last), "full_years": f"2018–{last.year - 1}", "rows": rows}


# ============================================================================= population (open)

def population_block(popraw, census) -> tuple[dict, dict]:
    pop_by_geo = {}
    series = {}
    for key, (label, sgc, code) in GEOS.items():
        if key == "crd":
            d = popraw[popraw.region // 1000 == 17].groupby(["year", "kind"])["pop"].sum().reset_index()
        else:
            d = popraw[popraw.region == code]
        d = d.sort_values("year")
        pop_by_geo[key] = dict(zip(d.year.astype(int), d["pop"].astype(float)))
        est = d[d.kind == "Estimate"]
        growth = est.set_index("year")["pop"].pct_change()
        series[key] = {"label": label, "years": d.year.astype(int).tolist(), "pop": d["pop"].tolist(),
                       "kind": ["E" if k == "Estimate" else "P" for k in d.kind],
                       "growth": [growth.get(y) for y in d.year], "cagr_2016_2025": None}
        e = est.set_index("year")["pop"]
        if 2016 in e and e.index.max() > 2016:
            n = int(e.index.max()) - 2016
            series[key]["cagr_2016_2025"] = (e.iloc[-1] / e[2016]) ** (1 / n) - 1
    cen = {}
    for _, r in census.iterrows():
        cen[r.geo] = {k: r.get(k) for k in ("pop_2016", "pop_2021", "pct_change", "dwellings", "dwellings_occupied", "density_km2", "land_km2")}
    crd_csd = census[census.geo.str.len() == 7].sort_values("pct_change", ascending=False)
    rank = list(crd_csd.geo).index("5917044") + 1 if "5917044" in set(crd_csd.geo) else None
    return pop_by_geo, {"estimates": series, "census_2021": cen, "langford_census_rank_in_crd": rank,
                        "note": "BC Stats July-1 estimates include a census undercount adjustment, so they run higher than census counts "
                                "(Langford 2021: estimate 49,191 vs census 46,584). Projections (kind P) are BC Stats P.E.O.P.L.E."}


# ============================================================================= forecast model and backtests (open)

def seasonal_index(ref: pd.Series) -> np.ndarray:
    """Monthly ratio-to-annual-mean index from a reference series (years with ≥10 reported months), shrunk to 1."""
    ratios = []
    for _, g in ref.groupby(ref.index.year):
        if g.notna().sum() >= 10 and g.mean() > 0:
            r = (g / g.mean()).groupby(g.index.month).first()
            ratios.append(r.reindex(range(1, 13)))
    if not ratios:
        return np.ones(12)
    raw = pd.concat(ratios, axis=1).mean(axis=1).fillna(1).to_numpy()
    s = 1 + SHRINK * (raw - 1)
    return s / s.mean()


def forecasts(y: pd.Series, ref: pd.Series, origin: pd.Timestamp) -> dict[str, np.ndarray]:
    """1..H-step forecasts from data up to and including `origin` (no look-ahead)."""
    hist, refh = y[y.index <= origin], ref[ref.index <= origin]
    targets = pd.date_range(origin + pd.DateOffset(months=1), periods=H, freq="MS")
    last12 = hist.iloc[-12:]
    mean12 = float(np.nanmean(last12)) if last12.notna().any() else 0.0
    snaive = []
    for t in targets:
        v = np.nan
        for k in (12, 24):
            p = t - pd.DateOffset(months=k)
            if p in hist.index and pd.notna(hist[p]):
                v = hist[p]
                break
        snaive.append(v if pd.notna(v) else mean12)
    s = seasonal_index(refh)
    level = np.nanmean(last12.to_numpy() / s[last12.index.month - 1]) if last12.notna().any() else 0.0
    return {"targets": targets, "snaive": np.array(snaive, float), "mean12": np.full(H, mean12),
            "seasonal": level * s[targets.month - 1], "index": s}


MODELS = ["mean12", "seasonal", "snaive"]
MODEL_LABELS = {"mean12": "Last-12-month mean (headline)", "seasonal": "Seasonal variant (12-month level × CRD seasonal index)",
                "snaive": "Seasonal naive (same month last year)"}
# Headline = the pre-registered baseline that won the backtest. The seasonal variant was the planned model but permit
# seasonality is too weak to help (it is slightly worse at every horizon), so it is shown only as a comparison.
# Nothing here is tuned on the backtest period: window lengths and the shrinkage were fixed beforehand.
HEADLINE = "mean12"


def backtest(y: pd.Series, ref: pd.Series) -> tuple[pd.DataFrame, pd.DataFrame]:
    last = y.index.max()
    rows, totals = [], []
    for origin in pd.date_range(FIRST_ORIGIN, last - pd.DateOffset(months=1), freq="MS"):
        f = forecasts(y, ref, origin)
        act = y.reindex(f["targets"])
        for h, t in enumerate(f["targets"], 1):
            if t > last:
                break
            rows.append({"origin": origin, "target": t, "h": h, "actual": act[t], **{m: f[m][h - 1] for m in MODELS}})
        if f["targets"][-1] <= last and act.notna().all():
            totals.append({"origin": origin, "actual": act.sum(), **{m: f[m].sum() for m in MODELS}})
    return pd.DataFrame(rows), pd.DataFrame(totals)


def scores(bt: pd.DataFrame, tot: pd.DataFrame) -> dict:
    ok = bt.dropna(subset=["actual"])
    out = {}
    for m in MODELS:
        e = ok[m] - ok.actual
        te = (tot[m] - tot.actual) if len(tot) else pd.Series(dtype=float)
        out[m] = {"label": MODEL_LABELS[m], "mae": e.abs().mean(), "rmse": float(np.sqrt((e ** 2).mean())), "bias": e.mean(),
                  "mae_by_h": ok.assign(ae=e.abs()).groupby("h").ae.mean().reindex(range(1, H + 1)).tolist(),
                  "total12_mae": te.abs().mean() if len(te) else None,
                  "total12_mape": (te.abs() / tot.actual).mean() if len(te) else None,
                  "n": int(len(ok)), "n_total12": int(len(tot))}
    base = out["snaive"]["mae"]
    for m in MODELS:
        out[m]["skill_vs_snaive"] = 1 - out[m]["mae"] / base if base else None
        out[m]["skill_vs_mean12"] = 1 - out[m]["mae"] / out["mean12"]["mae"] if out["mean12"]["mae"] else None
    return out


def band(bt: pd.DataFrame, model: str) -> tuple[float, float]:
    ok = bt.dropna(subset=["actual"])
    ok = ok[ok[model] > 0]
    r = ok.actual / ok[model]
    return float(r.quantile(0.10)), float(r.quantile(0.90))


def forecast_block(b, key: str, target: str) -> tuple[dict, dict]:
    label, sgc, _ = GEOS[key]
    y = geo_frame(b, sgc)[target]
    y = y.reindex(pd.date_range(y.index.min(), y.index.max(), freq="MS"))
    ref = geo_frame(b, GEOS["crd"][1])[target].reindex(y.index)
    bt, tot = backtest(y, ref)
    sc = scores(bt, tot)
    best = min(MODELS, key=lambda m: sc[m]["mae"])
    # out-of-sample band coverage for the model
    lo_e, hi_e = band(bt[bt.origin < COVERAGE_SPLIT], HEADLINE)
    late = bt[(bt.origin >= COVERAGE_SPLIT)].dropna(subset=["actual"])
    cover = float(((late.actual >= lo_e * late[HEADLINE]) & (late.actual <= hi_e * late[HEADLINE])).mean()) if len(late) else None
    lo, hi = band(bt, HEADLINE)
    tr = tot.assign(r=tot.actual / tot[HEADLINE]) if len(tot) else None
    tlo, thi = (float(tr.r.quantile(0.1)), float(tr.r.quantile(0.9))) if tr is not None and len(tr) >= 10 else (None, None)
    f = forecasts(y, ref, y.index.max())
    cal_year = y.index.max().year
    ytd = y[y.index.year == cal_year].sum(min_count=1)
    head = f[HEADLINE]
    rest = head[f["targets"].year == cal_year].sum()
    fc = {
        "geo": key, "label": label, "target": target, "origin": ym(y.index.max()),
        "months": [ym(t) for t in f["targets"]],
        **{m: f[m].tolist() for m in MODELS},
        "headline": HEADLINE, "comparison": "seasonal",
        "lo80": (head * lo).tolist(), "hi80": (head * hi).tolist(),
        "total12": float(head.sum()), "total12_seasonal": float(f["seasonal"].sum()),
        "total12_lo80": float(head.sum() * tlo) if tlo else None, "total12_hi80": float(head.sum() * thi) if thi else None,
        "calendar_year": {"year": cal_year, "actual_ytd": ytd, "forecast_rest": rest, "projected": ytd + rest,
                          "months_actual": int(y[y.index.year == cal_year].notna().sum())},
        "seasonal_index": f["index"].tolist(),
        "scores": sc, "best_by_mae": best,
        "band_coverage": {"nominal": 0.8, "empirical": cover, "fit_origins_before": ym(COVERAGE_SPLIT), "n_scored": int(len(late))},
        "n_origins": int(bt.origin.nunique()), "first_origin": ym(FIRST_ORIGIN),
        "backtest_totals": [{"origin": ym(r.origin), "actual": r.actual, **{m: getattr(r, m) for m in MODELS}} for r in tot.itertuples()],
    }
    unit = "units" if target.startswith("units") else "$000"
    print(f"  forecast {key}/{target}: origins {fc['n_origins']}, MAE " + ", ".join(f"{m} {sc[m]['mae']:,.1f}" for m in MODELS)
          + f" {unit}; 12-mo total MAPE " + ", ".join(f"{m} {sc[m]['total12_mape']:.0%}" for m in MODELS if sc[m]['total12_mape'] is not None)
          + f"; band coverage {cover:.0%}" + f"; next 12 mo {fc['total12']:,.0f}")
    rows = {"geo": key, "target": target, "models": MODELS,
            "rows": [[ym(r.origin), ym(r.target), int(r.h), r.actual, *[getattr(r, m) for m in MODELS]] for r in bt.itertuples()],
            "columns": ["origin", "target", "h", "actual", *MODELS]}
    return fc, rows


# ============================================================================= freshness

def freshness(status: dict, ids: tuple[str, ...]) -> list[dict]:
    labels = {"permits": ("BC Stats building permits (monthly)", True), "population": ("BC Stats population estimates", True),
              "census": ("Statistics Canada 2021 census", True), "tracker": ("City of Langford Development Tracker", False),
              "orthos": ("City of Langford aerial photos", False)}
    return [{"id": k, "label": lab, "open": op, **{f: (status.get(k) or {}).get(f) for f in ("ok", "attempted", "last_ok", "newest", "error", "skipped", "release")}}
            for k, (lab, op) in labels.items() if k in ids]


# ============================================================================= Development Tracker (UNLICENSED)

STAGE = {  # (Type, Status) → pipeline stage
    "In review": {"Open", "Under Review"},
    "Approved": {"Adopted"},                                   # + planning permits with Status Issued (below)
    "Under construction": set(),                               # building permits with Status Issued
    "Complete": {"Closed"},
}
PRIVATE_WORK = {"SFD with Suite", "SFD (without Sec Suite)", "Duplex", "Duplex with Suite", "Additions and Alterations",
                "Accessory Building", "Foundation", ""}


def stage_of(r) -> str:
    if r.Status in ("Open", "Under Review"):
        return "In review"
    if r.Status == "Closed":
        return "Complete"
    if r.Type == "Building Permit" and r.Status == "Issued":
        return "Under construction"
    return "Approved"


def units_est(r) -> tuple[float | None, str]:
    """Dwelling units from the work code and description; None when the description doesn't say."""
    if r.Type != "Building Permit":
        return None, "planning file"
    d = (r.Description or "").lower()
    m = re.search(r"(\d{1,4})\s*-?\s*(?:units?|unit townhouse|townhouses)", d) or re.search(r"\(\s*(\d{1,3})\s*-?\s*units?\s*\)", d) \
        or re.search(r"block of (\d{1,3})", d)
    wc = r.WorkCode
    if wc in ("Multi Family", "Townhouse") and m:
        return float(m.group(1)), "description"
    if wc == "Townhouse":
        return None, "unknown"
    if wc == "SFD (without Sec Suite)":
        return 1.0, "work code"
    if wc == "SFD with Suite":
        return 2.0, "work code (house + suite)"
    if wc == "Duplex":
        return 2.0, "work code"
    if wc == "Duplex with Suite":
        return (4.0 if "suites" in d else 3.0), "work code (duplex + suite(s))"
    if wc == "Multi Family":
        return None, "unknown"
    return 0.0, "non-residential"


def km(durations: np.ndarray, observed: np.ndarray) -> dict:
    """Kaplan–Meier quartiles (days) with right-censoring."""
    if len(durations) == 0:
        return {"n": 0}
    order = np.argsort(durations, kind="stable")
    d, o = durations[order], observed[order]
    surv, n_at = 1.0, len(d)
    q = {}
    for t in np.unique(d):
        at = d == t
        events = int(o[at].sum())
        if events:
            surv *= 1 - events / n_at
        n_at -= int(at.sum())
        for p, name in ((0.75, "p25"), (0.5, "median"), (0.25, "p75")):
            if name not in q and surv <= p:
                q[name] = float(t)
    return {"n": int(len(d)), "events": int(o.sum()), "censored": int((~o.astype(bool)).sum()), **{k: q.get(k) for k in ("p25", "median", "p75")}}


def tracker_block(fetched_at: pd.Timestamp) -> tuple[dict, pd.DataFrame] | tuple[None, None]:
    f = RAW / "tracker.parquet"
    if not f.exists():
        return None, None
    t = pd.read_parquet(f)
    asof = pd.Timestamp(t.fetched.iloc[0]).tz_convert(None).normalize() if "fetched" in t else fetched_at
    t["stage"] = [stage_of(r) for r in t.itertuples()]
    ue = [units_est(r) for r in t.itertuples()]
    t["units_est"] = [u for u, _ in ue]
    t["units_basis"] = [b for _, b in ue]
    t["class"] = t.TypeOfBuilding.str.split(r"[;,]", n=1).str[0].str.strip()
    t["new_build"] = t.TypeOfWork.str.startswith("New")
    private = (t.Type == "Building Permit") & t.WorkCode.isin(PRIVATE_WORK)
    apps = []
    for r, priv in zip(t.to_dict("records"), private):
        apps.append({"id": r["PermitNumber"], "type": r["Type"], "status": r["Status"], "stage": r["stage"],
                     "entered": r["Entered"], "issued": r["Issued"], "closed": r["FinalledORClosed"], "status_changed": r["StatusChanged"],
                     "work": r["WorkCode"] or None, "class": r["class"] or None,
                     "work_type": r["TypeOfWork"] or None, "new_build": bool(r["new_build"]), "valuation": r["TotalValuation"],
                     "units_est": r["units_est"], "units_basis": r["units_basis"], "zoning": r["Zoning"] or None,
                     "description": None if priv else (r["Description"] or r["PermitDescription"] or None),
                     "address": None if priv else (r["Full_Address"] or None),
                     # private homes: ~100 m position and no address; everything else ~10 m
                     "lon": round(r["lon"], 3 if priv else 4) if pd.notna(r["lon"]) else None,
                     "lat": round(r["lat"], 3 if priv else 4) if pd.notna(r["lat"]) else None})
    stage_order = ["In review", "Approved", "Under construction", "Complete"]
    by_stage = t.groupby(["Type", "stage"]).size().unstack(fill_value=0).reindex(columns=stage_order, fill_value=0)
    # time between stages
    dur = {}
    for typ, g in t.groupby("Type"):
        issued = g.Issued.notna().to_numpy()
        end = g.Issued.where(g.Issued.notna(), asof)
        dur[typ] = {"entered_to_issued": km((end - g.Entered).dt.days.clip(lower=0).to_numpy(float), issued)}
    bp = t[t.Type == "Building Permit"]
    closed = bp.FinalledORClosed.notna().to_numpy()
    end = bp.FinalledORClosed.where(bp.FinalledORClosed.notna(), asof)
    dur["Building Permit"]["issued_to_closed"] = km((end - bp.Issued).dt.days.clip(lower=0).to_numpy(float), closed)
    # cross-type links at the same address: planning approval → building permit application
    links = []
    plan = t[t.Type.isin(["Development Permit", "Rezoning"]) & t.Issued.notna() & (t.Full_Address != "")]
    for r in plan.itertuples():
        nxt = bp[(bp.Full_Address == r.Full_Address) & (bp.Entered >= r.Entered)]
        if len(nxt):
            links.append({"from": r.Type, "days": int((nxt.Entered.min() - r.Issued).days)})
    ln = pd.DataFrame(links)
    link_stats = {typ: {"n": int(len(g)), "median_days": float(g.days.median()), "p25": float(g.days.quantile(.25)), "p75": float(g.days.quantile(.75))}
                  for typ, g in ln.groupby("from")} if len(ln) else {}
    # monthly flows
    months = pd.date_range(t.Entered.min().to_period("M").to_timestamp(), asof.to_period("M").to_timestamp(), freq="MS")
    def per_month(col, mask=None, agg="size", val=None):
        g = t if mask is None else t[mask]
        s = g.groupby(g[col].dt.to_period("M").dt.to_timestamp())
        s = s.size() if agg == "size" else s[val].sum()
        return s.reindex(months, fill_value=0).tolist()
    flows = {"months": [ym(m) for m in months],
             "entered_by_type": {typ: per_month("Entered", t.Type == typ) for typ in sorted(t.Type.unique())},
             "bp_issued": per_month("Issued", t.Type == "Building Permit"),
             "bp_issued_value": per_month("Issued", t.Type == "Building Permit", "sum", "TotalValuation"),
             "bp_issued_units_est": per_month("Issued", t.Type == "Building Permit", "sum", "units_est")}
    nb = bp[bp.new_build]
    by_class = nb.groupby("class").agg(n=("PermitNumber", "size"), valuation=("TotalValuation", "sum"), units_est=("units_est", "sum")) \
                 .sort_values("valuation", ascending=False).reset_index().to_dict("records")
    by_work = bp.groupby("WorkCode").agg(n=("PermitNumber", "size"), valuation=("TotalValuation", "sum"), units_est=("units_est", "sum")) \
                .sort_values("valuation", ascending=False).reset_index().rename(columns={"WorkCode": "work"}).to_dict("records")
    unknown_units = int(((bp.units_basis == "unknown")).sum())
    coverage = None
    if (RAW / "bper.parquet").exists():
        bb = pd.read_parquet(RAW / "bper.parquet")
        bs = bb[(bb.sgc == GEOS["langford"][1]) & (bb.series.isin(["units_total", "value_total"]))].pivot_table(index="month", columns="series", values="value")
        tk = bp.assign(m=bp.Issued.dt.to_period("M").dt.to_timestamp()).groupby("m").agg(units=("units_est", "sum"), value=("TotalValuation", "sum"))
        j = bs.join(tk, how="inner").dropna(subset=["units_total"])
        j = j[j.index >= pd.Timestamp("2025-07-01")]                  # the tracker's dense period
        if len(j):
            coverage = {"from": ym(j.index.min()), "to": ym(j.index.max()), "months": int(len(j)),
                        "tracker_units_est": float(j.units.sum()), "bcstats_units": float(j.units_total.sum()),
                        "tracker_value": float(j.value.sum()), "bcstats_value": float(j.value_total.sum() * 1000)}
    block = {
        "langford_unlicensed": True,
        "source": {"name": "City of Langford Development Tracker", "url": TRACKER, **LICENCES["tracker"]},
        "fetched": t.fetched.iloc[0] if "fetched" in t else None, "city_last_updated": t.LastUpdated.max(),
        "n": int(len(t)), "entered_range": [t.Entered.min(), t.Entered.max()],
        "caveats": [
            "The tracker is a rolling public list, not the full permit register: it holds ~470 files entered since Jan 2024, "
            "most of them since mid-2025, and building permits appear only once issued (none are listed as in review).",
            "Time-to-issue for building permits is therefore measured only on permits that were issued; planning files "
            "(DP, DVP, TUP, rezoning) include those still open, as censored observations (Kaplan–Meier).",
            "Unit counts are estimates from the work code and description (house + suite = 2, duplex with suites = 4); "
            f"{unknown_units} residential building permit(s) don't state a count.",
            "Single-family, duplex and alteration permits are shown without address and at ~100 m precision.",
        ],
        "stage_order": stage_order,
        **({"coverage_note": f"Building permits issued {coverage['from']} – {coverage['to']}: the tracker's estimated units are "
                             f"{coverage['tracker_units_est'] / coverage['bcstats_units']:.0%} of BC Stats' count and its valuations "
                             f"{coverage['tracker_value'] / coverage['bcstats_value']:.0%} of BC Stats' value, so recent months look near-complete."}
           if coverage and coverage["bcstats_units"] else {}),
        "by_stage": {typ: row.to_dict() for typ, row in by_stage.iterrows()},
        "stage_totals": t.stage.value_counts().reindex(stage_order, fill_value=0).to_dict(),
        "durations_days": dur, "planning_to_bp_days": link_stats,
        "flows": flows, "bp_new_by_class": by_class, "bp_by_work": by_work,
        "coverage_vs_bcstats": coverage,
        "bp_units_est_total": float(bp.units_est.sum()), "bp_valuation_total": float(bp.TotalValuation.sum()),
        "applications": apps,
    }
    print(f"  tracker: {len(t)} files; stages " + ", ".join(f"{k} {v}" for k, v in block["stage_totals"].items())
          + f"; BP entered→issued median {dur['Building Permit']['entered_to_issued'].get('median')} d"
          + f"; DP {dur.get('Development Permit', {}).get('entered_to_issued', {}).get('median')} d"
          + f"; rezoning {dur.get('Rezoning', {}).get('entered_to_issued', {}).get('median')} d")
    return block, t


# ============================================================================= orthos and hotspots (UNLICENSED)

HOTSPOT_NOTES = {   # one line each, from the 2007 vs 2026 orthos and the tracker's 2024–26 files
    "downtown": "Low-rise shops and older houses in 2007; now 5–6 storey rental and condo blocks (120- and 75-unit permits on Hockley Ave, 2025).",
    "city_gate": "A wooded block beside the Millstream big-box strip, cleared by 2021; 80 + 90-unit buildings permitted at City Gate Blvd in 2025.",
    "westhills": "Unbroken forest on Langford Lake's shore until ~2015; blasted terraces by 2019 and dense townhouse streets (Atlas Dr, Cosmos Bend) by 2026.",
    "jacklin_rita": "An established grid around the ballfields; change is infill: a 77-unit, 6-storey building on Rita Rd and townhouse DPs (2025).",
    "happy_valley": "Forest and acreages in 2007; subdivisions from ~2015 (Olympian Way, Bramley Run) still filling with houses-with-suites and duplexes.",
    "skirt_mtn": "Forested slope above Hwy 1 until 2013; rock blasted bare by 2019, now terraced housing and a sports field.",
    "florence_north": "A gravel pit through 2019; now a new subdivision of duplexes and townhouses (Madrona Pl, Plover Crt, Kingbird Dr).",
    "westshore_pkwy": "Forest in 2007, first clearing by 2013, a school by 2019, and a large commercial and light-industrial strip by 2026.",
    "isabell_luxton": "Older lots south of Glen Lake turning into townhouses and rezonings: infill rather than greenfield, subtle from the air.",
}


def vegetation_share(path) -> float | None:
    """Share of pixels that read as vegetation (excess-green index 2g − r − b > 0.05 on chromatic coordinates)."""
    try:
        a = np.asarray(Image.open(path).convert("RGB"), dtype=float)
    except Exception:
        return None
    s = a.sum(axis=2) + 1e-6
    r, g, b = a[..., 0] / s, a[..., 1] / s, a[..., 2] / s
    return float(((2 * g - r - b) > 0.05).mean())


def orthos_block(t: pd.DataFrame | None) -> dict | None:
    f = RAW / "orthos_services.json"
    if not f.exists():
        return None
    meta = json.loads(f.read_text(encoding="utf-8"))
    services = []
    for s in meta["services"]:
        mm = re.search(r"(January|February|March|April|May|June|July|August|September|October|November|December)", s.get("image_layer") or "")
        e = s.get("extent") or {}
        bbox = None
        if all(e.get(k) is not None for k in ("xmin", "ymin", "xmax", "ymax")) and s.get("extent_wkid") == 26910:
            w, so = utm10_to_lonlat(e["xmin"], e["ymin"])
            ea, n = utm10_to_lonlat(e["xmax"], e["ymax"])
            bbox = [w, so, ea, n]
        lods = s.get("lods") or []
        services.append({"year": s["year"], "month": mm.group(1) if mm else None, "name": s["name"], "ok": s.get("ok"), "url": s["url"],
                         "tile_url": f"{s['url']}/tile/{{z}}/{{y}}/{{x}}" if s.get("cached") else None,
                         "export_url": f"{s['url']}/export", "raster_layer": s.get("raster_layer"),
                         "wkid": s.get("wkid"), "tile_origin": s.get("tile_origin"), "tile_size": s.get("tile_size"), "tile_format": s.get("tile_format"),
                         "resolutions": [l["resolution"] for l in lods], "max_level": lods[-1]["level"] if lods else None,
                         "extent_utm10": e, "bbox_lonlat": bbox})
    years = [s["year"] for s in services if s["ok"]]
    hs = []
    for h in HOTSPOTS:
        veg = {}
        for y in years:
            p = RAW / "thumbs" / f"{h['id']}_{y}.jpg"
            if p.exists():
                veg[y] = vegetation_share(p)
        stats = None
        if t is not None:
            d = metres(h["lon"], h["lat"], t.lon, t.lat)
            near = t[d <= 400]
            stats = {"radius_m": 400, "n": int(len(near)), "by_type": near.Type.value_counts().to_dict(),
                     "valuation": float(near.TotalValuation.sum()), "units_est": float(near.units_est.sum())}
        before, after = h["before"], h["after"]
        hs.append({**h, "note": HOTSPOT_NOTES.get(h["id"]), "box_m": 2 * THUMB_HALF_M, "vegetation_share": veg,
                   "vegetation_change": (veg[after] - veg[before]) if before in veg and after in veg and veg[before] is not None and veg[after] is not None else None,
                   "tracker_400m": stats})
    print("  hotspots: " + ", ".join(f"{h['id']} veg {h['vegetation_share'].get(h['before'], 0):.0%}→{h['vegetation_share'].get(h['after'], 0):.0%}" for h in hs))
    return {
        "langford_unlicensed": True,
        "source": {"name": "City of Langford ORTHOS map services", "url": "https://arcex.langford.ca/server/rest/services/ORTHOS", **LICENCES["orthos"]},
        "fetched": meta.get("fetched"),
        "tiling": {"wkid": 26910, "crs": "NAD83 / UTM zone 10N (EPSG:26910)", "note":
                   "Cached tiles are in UTM 10N, not Web Mercator: use Leaflet + Proj4Leaflet with the origin and resolutions "
                   "below, or request /export with bboxSR=3857&imageSR=3857&layers=show:<raster_layer> (server-side reprojection; "
                   "the raster sublayer avoids the Boundary/Footprint outlines). CORS: the server echoes the page's Origin."},
        "services": services,
        "hotspots": hs,
        "vegetation_method": "Excess-green share of a 256 px, 600 m export per hotspot and year. Leaf-off April flights (2021, 2023, 2024) "
                             "read browner, so compare 2007 with May 2025/2026 rather than year to year.",
        "alternatives": [{"name": "CRD OrthoImagery 2015–2025", "url": "https://mapservices.crd.bc.ca/arcgis/rest/services",
                          "licence": "Not open: CRD terms require attribution and forbid redistribution or granting rights; no OGL/CC licence stated.",
                          "years": [2015, 2017, 2019, 2021, 2023, 2025], "wkid": 26910}],
    }


# ============================================================================= main

def main():
    import sys
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    gen = pd.Timestamp.now(tz="UTC").floor("min")
    status = json.loads((RAW / "status.json").read_text(encoding="utf-8")) if (RAW / "status.json").exists() else {}
    prev = read_json("langford.json") or {}

    # ---- open data: langford.json + backtest.json
    if (RAW / "bper.parquet").exists() and (RAW / "population.parquet").exists():
        b, names = load_permits()
        popraw = pd.read_parquet(RAW / "population.parquet")
        census = pd.read_parquet(RAW / "census.parquet") if (RAW / "census.parquet").exists() else pd.DataFrame(columns=["geo"])
        months = pd.date_range(b.month.min(), b[(b.sgc == GEOS["langford"][1]) & b.value.notna()].month.max(), freq="MS")
        pop_by_geo, popblock = population_block(popraw, census)
        for sgc, c in popblock["census_2021"].items():
            c["name"] = "Capital Regional District" if sgc == "5917" else "British Columbia" if sgc == "59" else names.get(sgc, sgc)
        perm = permits_block(b, months, pop_by_geo)
        fcs, bts = {}, []
        for key in ("langford", "crd"):
            for target in ("units_total", "value_total"):
                fc, rows = forecast_block(b[b.month <= months[-1]], key, target)
                fcs[f"{key}:{target}"] = fc
                bts.append(rows)
        lf = perm["geos"]["langford"]
        crd = perm["geos"]["crd"]
        last = months[-1]
        ytd = [i for i, m in enumerate(months) if m.year == last.year]
        ytd_prev = [i for i, m in enumerate(months) if m.year == last.year - 1 and m.month <= last.month]
        s = lambda arr, idx: float(np.nansum([arr[i] for i in idx if arr[i] is not None]))
        est_years = popblock["estimates"]["langford"]
        pop_now_year = max(y for y, k in zip(est_years["years"], est_years["kind"]) if k == "E")
        kpis = {
            "latest_month": ym(last),
            "units_ttm": lf["units_ttm"][-1], "units_ttm_suppressed_months": lf["units_ttm_suppressed"][-1],
            "value_ttm_k": lf["value_ttm"][-1],
            "units_ytd": s(lf["units_total"], ytd), "units_ytd_prev": s(lf["units_total"], ytd_prev),
            "value_ytd_k": s(lf["value_total"], ytd), "value_ytd_prev_k": s(lf["value_total"], ytd_prev),
            "share_of_crd_units_ttm": (lf["units_ttm"][-1] / crd["units_ttm"][-1]) if lf["units_ttm"][-1] and crd["units_ttm"][-1] else None,
            "pop_estimate": pop_by_geo["langford"].get(pop_now_year), "pop_year": pop_now_year,
            "pop_projection_next": pop_by_geo["langford"].get(pop_now_year + 1),
            "census_2016": 35342, "census_2021": 46584, "census_growth": 0.318,
            "forecast_next12_units": fcs["langford:units_total"]["total12"],
        }
        if "5917044" in popblock["census_2021"]:
            c = popblock["census_2021"]["5917044"]
            kpis.update({"census_2016": c["pop_2016"], "census_2021": c["pop_2021"], "census_growth": c["pct_change"] / 100,
                         "dwellings_2021": c["dwellings"]})
            since = [i for i, m in enumerate(months) if m >= pd.Timestamp("2021-06-01")]      # census day was 11 May 2021
            kpis["units_since_census_from"] = "2021-06"
            kpis["units_since_census"] = s(lf["units_total"], since)
            kpis["units_since_census_vs_stock"] = kpis["units_since_census"] / c["dwellings"] if c["dwellings"] else None
        missing_lf = [perm["months"][i] for i, v in enumerate(lf["units_total"]) if v is None]
        dump("langford.json", {
            "generated": gen, "project": "langford", "langford_unlicensed": False,
            "licences": {k: LICENCES[k] for k in ("bper", "population", "census")},
            "freshness": freshness(status, ("permits", "population", "census")),
            "kpis": kpis,
            "permits": perm,
            "league": league_table(b, names, popraw),
            "population": popblock,
            "forecast": {k: {kk: vv for kk, vv in v.items()} for k, v in fcs.items()},
            "notes": [
                "BC Stats building permits are values and units at permit issue, in current dollars, not seasonally adjusted.",
                "Trailing-12-month sums skip suppressed months (so they are lower bounds) and need ≥10 reported months.",
                "Units permitted are not completions: some permitted projects are delayed or never built.",
                "x (suppressed) months are null. Langford housing units are suppressed in " + (", ".join(missing_lf) or "no months") + ".",
                "Nov 2025 Langford total value is $13k: almost certainly incomplete reporting that month, kept as published.",
                "The 2003–2017 series uses a different method and isn't comparable, so the series starts in Jan 2018.",
            ],
        })
        dump("backtest.json", {"generated": gen, "langford_unlicensed": False, "first_origin": ym(FIRST_ORIGIN), "horizon": H,
                               "model_labels": MODEL_LABELS, "series": bts})
    else:
        print("  open inputs missing: run `python -m pipelines.langford.fetch daily` first; langford.json left as is")

    # ---- unlicensed: tracker.json + orthos.json (separate files so the page can ship without them)
    trk, t = tracker_block(gen.tz_convert(None))
    if trk:
        dump("tracker.json", {"generated": gen, **trk, "freshness": freshness(status, ("tracker",))})
    orth = orthos_block(t)
    if orth:
        dump("orthos.json", {"generated": gen, **orth, "freshness": freshness(status, ("orthos",))})


if __name__ == "__main__":
    main()
