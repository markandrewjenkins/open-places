"""Golf Playability & Course Tier List: courses, tiers, 7-day playability, climatology and the forecast backtest.

  python -m pipelines.golf.build [courses|forecast|climate|backtest|all]

Writes site/public/data/golf/:
  courses.json        every course with what's mapped, completeness, measurements, 0–100 features, default score/tier
                      (provisional tiers for outlined but unmapped courses, and the leave-one-out check of that method)
  geo_<region>.json   course outlines, hole lines, greens, bunkers, water, fairways, tees for the map
  playability.json    hourly comfort and daily playable hours / best tee time per weather point, next 7 days
  climate.json        month-by-month climate and observed playable hours, frost-delay odds, "best months"
  backtest.json       forecast playable hours vs observed, by lead day 0–7 (MAE, bias, hit rate, skill vs climatology)
  status.json         per-source freshness (from data/golf/raw/status.json)
Each part runs on its own; if its inputs are missing the old output is kept and the failure is logged.
"""
from __future__ import annotations

import bisect
import functools
import json
import math
import sys
import traceback
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from pipelines.common import eccc

from . import courses as C
from . import weather as Wx
from .config import (LOCALITIES, NAME_HINTS, NAME_OVERRIDES, BACKTEST_LEADS, CLIMATE_STATIONS, COMPLETENESS, FEATURE_RAMPS, FEATURE_RAMPS_SHORT, OBS_STATIONS, OUT, PLAYABILITY, PLAYABLE_DAY_HOURS, GOOD_DAY_SHARE,
                     PLAYABLE_MIN, PROVISIONAL_FEATURES, PROVISIONAL_MIN_CHECK, PROVISIONAL_MIN_RHO, RANK_MIN_COMPLETENESS, RAW, REGIONS,
                     ROUND_HOURS, SHORT_HA_PER_HOLE, TIERS, TZ, WEIGHTS)

FEATURE_NOTES = {
    "length": "Mean hole length from the mapped playing lines (tee to green, back tees), yards per hole",
    "par": "Total par scaled to 18 holes (only where every hole's par is mapped)",
    "bunkers": "Bunkers per hole",
    "water": "Share of holes with a water hazard within 25 m of the playing line",
    "trees": "Share of the course under tree cover (ESA WorldCover 10 m)",
    "views": "Line-of-sight sea and lake views (30 m surface model, out to 6 km) from the tees and greens: 90th percentile over them",
    "relief": "Elevation range across the course (2nd–98th percentile), m",
    "climb": "Metres climbed per km walked, tee to green to next tee (counts against: walkability)",
    "holes": "Number of holes (9 = 0, 18 or more = 100)",
}


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="minutes")


def clean(o):
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return clean(o.tolist())
    if isinstance(o, (float, np.floating)):
        return None if not np.isfinite(o) else round(float(o), 4)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, pd.Timestamp):
        return o.isoformat()
    return o


def dump(name, obj):
    path = OUT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(clean(obj), separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"  wrote {name} ({path.stat().st_size / 1024:,.0f} KB)", flush=True)


def ramp100(v, lo, hi):
    return None if v is None else float(100 * np.clip((v - lo) / (hi - lo), 0, 1))


# ============================================================================= courses

def features(r) -> dict:
    """0–100 feature values for one course (None where it can't be measured)."""
    n = r["holes_mapped"]
    if not n:
        return {k: None for k in FEATURE_RAMPS}
    # water views where golfers stand still and look: the 90th percentile over every tee and green (the hole's ends)
    tg = [h["view_tee"] for h in r["holes"]] + [h["view_green"] for h in r["holes"]]
    v = float(np.percentile(tg, 90)) if tg else None
    par18 = r["par"] * 18 / n if r["par"] and r["par_mapped"] == n else None
    raw = {"length": r["mean_yd"], "par": par18, "bunkers": r["bunkers"] / n, "water": r["water_holes"] / n, "trees": r.get("trees"),
           "views": v, "relief": r.get("relief_m"), "climb": r["climb_per_km"], "holes": min(18, r["holes_expected"])}
    r["feature_raw"] = {k: (round(x, 3) if x is not None else None) for k, x in raw.items()}
    ramps = {**FEATURE_RAMPS, **(FEATURE_RAMPS_SHORT if r["group"] == "short" else {})}
    return {k: ramp100(raw[k], *ramps[k]) for k in FEATURE_RAMPS}


def score(f: dict, w: dict = WEIGHTS) -> float | None:
    """Weighted index 0–100. Missing features drop out and the positive weights are rescaled. Mirrors the page."""
    have = {k: wt for k, wt in w.items() if f.get(k) is not None}
    pos = sum(wt for wt in have.values() if wt > 0)
    if not pos:
        return None
    return float(np.clip(sum(wt * f[k] / 100 for k, wt in have.items()) / pos, 0, 1) * 100)


def assign_tiers(recs):
    """Tier and rank within region × group (short courses: both regions together); rank_all across both regions."""
    for group in ("course", "short"):
        allg = sorted([r for r in recs if r["ranked"] and r["group"] == group], key=lambda r: -r["score"])
        for i, r in enumerate(allg):
            r["rank_all"] = i + 1
        # full courses: tiers within each region; short courses are few, so they're tiered across both regions
        for key in (REGIONS if group == "course" else [None]):
            rs = [r for r in allg if key is None or r["region"] == key]
            for i, r in enumerate(rs):
                q = (i + 0.5) / len(rs)
                r["tier"] = next(t for t, cut in TIERS if q <= cut)
                r["rank"] = i + 1
                r["rank_of"] = len(rs)


FEATURE_NAMES = {"length": "hole length", "par": "par", "bunkers": "bunkers", "water": "water in play", "trees": "tree cover",
                 "views": "sea and lake views", "relief": "relief", "climb": "climb", "holes": "number of holes"}


def highlights(r):
    """What drives the default score, for the drawer."""
    contrib = {k: WEIGHTS[k] * v / 100 for k, v in r["features"].items() if v is not None and k in WEIGHTS}
    if not contrib:
        return
    r["highlights"] = [k for k, _ in sorted(contrib.items(), key=lambda kv: -kv[1])[:3] if contrib[k] > 0]
    r["drag"] = min(contrib, key=contrib.get) if min(contrib.values()) < 0 else None


def outline_features(r):
    """0–100 features from the course outline alone (courses.measure's `outline`), with the raw values; hole-based
    features are None. The hole count is left out for short courses: their area doesn't tell 9 holes from 18."""
    o = r.get("outline")
    if not o:
        return None, None
    raw = {k: None for k in FEATURE_RAMPS}
    raw.update({"views": o["views"], "trees": r.get("trees"), "relief": r.get("relief_m"), "climb": o["climb_per_km"],
                "holes": min(18, o["holes"]) if r["group"] == "course" else None})
    raw = {k: (v if k in PROVISIONAL_FEATURES else None) for k, v in raw.items()}
    ramps = {**FEATURE_RAMPS, **(FEATURE_RAMPS_SHORT if r["group"] == "short" else {})}
    return ({k: ramp100(v, *ramps[k]) for k, v in raw.items()}, {k: (round(v, 3) if v is not None else None) for k, v in raw.items()})


def qmap(x, outline_scores, full_scores):
    """Quantile mapping: the full score at the place x takes among the outline-only scores (both lists from the same
    ranked courses, sorted separately); past either end, shifted by the distance beyond it. Mirrors common.js."""
    o, f = sorted(outline_scores), sorted(full_scores)
    if x >= o[-1]:
        return min(100.0, f[-1] + x - o[-1])
    if x <= o[0]:
        return max(0.0, f[0] + x - o[0])
    i = bisect.bisect_right(o, x)
    t = (x - o[i - 1]) / ((o[i] - o[i - 1]) or 1)
    return f[i - 1] + t * (f[i] - f[i - 1])


def place(est, peers):
    """Tier of an estimated score among ranked peers' scores, as if it were one more course in the list, and how many
    of them score higher."""
    k = sum(p > est for p in peers)
    q = (k + 0.5) / (len(peers) + 1)
    return next(t for t, cut in TIERS if q <= cut), k


def assign_provisional(recs):
    """Provisional tiers for courses with an outline but too few holes (config.py: provisional tiers). Returns the
    leave-one-out check per group: each ranked course put through the outline-only method against the others."""
    from scipy.stats import spearmanr
    checks = {}
    for group in ("course", "short"):
        mapped = [r for r in recs if r["ranked"] and r["group"] == group and r.get("features_outline")]
        os_all = {r["id"]: score(r["features_outline"]) for r in mapped}
        mapped = [r for r in mapped if os_all[r["id"]] is not None]
        rows = []
        for r in mapped:
            others = [x for x in mapped if x is not r]
            if len(others) < 2:
                continue
            est = qmap(os_all[r["id"]], [os_all[x["id"]] for x in others], [x["score"] for x in others])
            t, _ = place(est, [x["score"] for x in others if group == "short" or x["region"] == r["region"]])
            rows.append({"id": r["id"], "name": r["name"], "region": r["region"], "score": r["score"], "outline_score": os_all[r["id"]],
                         "estimate": est, "tier": r["tier"], "tier_estimate": t, "tier_off": abs("SABCD".index(t) - "SABCD".index(r["tier"]))})
        err = np.array([x["estimate"] - x["score"] for x in rows])
        off = np.array([x["tier_off"] for x in rows])
        full = np.array([x["score"] for x in rows])
        rho = float(spearmanr(full, [x["outline_score"] for x in rows])[0]) if len(rows) > 2 else None
        ok = len(rows) >= PROVISIONAL_MIN_CHECK and rho is not None and rho >= PROVISIONAL_MIN_RHO
        what = "short courses" if group == "short" else "courses"
        c = checks[group] = {
            "courses": len(rows), "mae": float(np.abs(err).mean()) if len(rows) else None,
            "median_abs": float(np.median(np.abs(err))) if len(rows) else None, "max_abs": float(np.abs(err).max()) if len(rows) else None,
            "bias": float(err.mean()) if len(rows) else None, "rank_corr": rho,
            "mae_if_average": float(np.abs(full - full.mean()).mean()) if len(rows) else None,   # baseline: guess the average
            "same_tier_pct": float(100 * (off == 0).mean()) if len(rows) else None,
            "within_one_tier_pct": float(100 * (off <= 1).mean()) if len(rows) else None,
            "used": ok, "rows": rows,
            "reason": None if ok else "; ".join(
                ([f"only {len(rows)} fully mapped {what} to test the method on (needs {PROVISIONAL_MIN_CHECK})"] if len(rows) < PROVISIONAL_MIN_CHECK else []) +
                ([f"on the fully mapped {what} the outline-only scores don't keep their order (rank correlation {rho:.2f}, needs {PROVISIONAL_MIN_RHO})"]
                 if rho is not None and rho < PROVISIONAL_MIN_RHO else []))}
        os_, fs_ = [os_all[r["id"]] for r in mapped], [r["score"] for r in mapped]
        for r in recs:
            if r["ranked"] or r["group"] != group or not r.get("outline") or r.get("not_in_osm"):
                continue
            f, raw = outline_features(r)
            so = score(f)
            if so is None:
                continue
            if not ok:
                r["provisional_withheld"] = f"No provisional tier: {c['reason']}."
                continue
            est = qmap(so, os_, fs_)
            peers = [x["score"] for x in recs if x["ranked"] and x["group"] == group and (group == "short" or x["region"] == r["region"])]
            t, k = place(est, peers)
            known = [FEATURE_NAMES[k2] for k2 in PROVISIONAL_FEATURES if f[k2] is not None]
            if "number of holes" in known and r["outline"]["holes_from"] == "area":
                known[known.index("number of holes")] = "number of holes (from its area)"
            r.update({"provisional": True, "score": est, "score_outline": so, "tier": t, "provisional_above": k, "provisional_of": len(peers),
                      "features": f, "feature_raw": raw,
                      "provisional_note": (
                          f"Provisional: OpenStreetMap has this course's outline but only {r['holes_mapped']} of ~{r['holes_expected']} holes. "
                          f"Estimated from the outline: {', '.join(known)}. Not known without the holes, so left out with the weights "
                          f"rescaled: hole length, par, bunkers and water in play. Tested on the {c['courses']} fully mapped courses, "
                          f"the method is off by {c['mae']:.0f} points on average and lands within one tier "
                          f"{c['within_one_tier_pct']:.0f}% of the time.")})
            highlights(r)
    return checks


def match_vanparks(recs):
    f = RAW / "vanparks.json"
    if not f.exists():
        return []
    added = []
    for row in json.loads(f.read_text(encoding="utf-8")):
        if row["lon"] is None:
            continue
        disc = row["type"].startswith("Disc")
        cand = [r for r in recs if r["region"] == "vancouver" and ((r["kind"] == "disc_golf") == disc)]
        d = lambda r: math.hypot((r["lon"] - row["lon"]) * 72800, (r["lat"] - row["lat"]) * 111200)
        best = min(cand, key=d) if cand else None
        if best and d(best) < 900:
            best["park_board"] = {"park": row["park"], "type": row["type"]}
        elif disc:
            added.append({"id": f"vancouver-park-{row['park'].lower().replace(' ', '-')}-disc", "osm": [], "region": "vancouver",
                          "name": f"{row['park']} Disc Golf", "kind": "disc_golf", "area_ha": None, "holes_expected": 9,
                          "holes_expected_from": "Park Board (hole count not published)", "holes_mapped": 0, "greens": 0, "tees": 0,
                          "fairways": 0, "pins": 0, "bunkers": 0, "water_hazards": 0, "completeness": 0.0, "completeness_parts": {},
                          "holes": [], "yards": None, "mean_yd": None, "par": None, "par_mapped": 0, "water_holes": 0, "climb_m": None,
                          "walk_km": None, "climb_per_km": None, "views": None, "lon": row["lon"], "lat": row["lat"],
                          "park_board": {"park": row["park"], "type": row["type"]}, "not_in_osm": True})
    return added


def pbf_date(city):
    try:
        import osmium
        r = osmium.io.Reader(str(RAW.parents[1] / "osm" / f"{city}.osm.pbf"), osmium.osm.osm_entity_bits.NOTHING)
        ts = r.header().get("osmosis_replication_timestamp") or r.header().get("timestamp")
        r.close()
        return ts[:10] if ts else None
    except Exception:
        return None


def build_courses():
    allrecs, regions = [], {}
    for key, reg in REGIONS.items():
        f = RAW / key / "golf.json"
        if not f.exists():
            raise FileNotFoundError(f"{f} missing: run `python -m pipelines.golf.fetch osm`")
        raw = json.loads(f.read_text(encoding="utf-8"))
        print(f"{reg['name']}…", flush=True)
        recs, geo, unassigned = C.measure(raw, reg["bbox"], key, RAW / key / "worldcover.npz")
        # drop unnamed fragments (a practice green or a stray polygon tagged as a course)
        keep = [r["name"] != "Unnamed golf course" or (r["area_ha"] or 0) >= 3 or r["holes_mapped"] >= 3 for r in recs]
        dropped = [r["id"] for r, k in zip(recs, keep) if not k]
        recs = [r for r, k in zip(recs, keep) if k]
        geo = [g for g in geo if g["id"] not in dropped]
        dump(f"geo_{key}.json", {"region": key, "courses": geo})
        regions[key] = {"name": reg["name"], "center": reg["center"], "zoom": reg["zoom"], "bbox": reg["bbox"],
                        "osm_extract": raw.get("extract_date") or pbf_date(reg["pbf"]), "unassigned_features": unassigned, "dropped_fragments": len(dropped)}
        allrecs += recs
    allrecs += match_vanparks(allrecs)
    for r in allrecs:
        k = r["kind"]
        if k == "full" and r["mean_yd"] and r["mean_yd"] < 230:
            k = r["kind"] = "executive"
        # an unmapped "golf course" too small for its holes to be anything but a pitch & putt or par 3
        if k == "full" and not r["mean_yd"] and r["area_ha"] and r["area_ha"] / max(9, r["holes_expected"] or 9) < SHORT_HA_PER_HOLE:
            k = r["kind"] = "short"
            r["kind_note"] = f"Counted as a pitch & putt or par-3 course from its size ({r['area_ha']:.0f} ha), as no holes are mapped."
        r["group"] = {"full": "course", "executive": "course", "short": "short"}.get(k, "other")
        r["name_missing"] = r["name"] == "Unnamed golf course"
        if r["name_missing"] and r["id"] in NAME_OVERRIDES:
            r["name"] = NAME_OVERRIDES[r["id"]]
            r["name_note"] = "OpenStreetMap has no name for this course; the name was added locally."
        elif r["name_missing"]:
            loc = min(LOCALITIES[r["region"]].items(), key=lambda kv: math.hypot(kv[1][0] - r["lat"], (kv[1][1] - r["lon"]) * 0.66))[0]
            r["name"] = f"Unnamed course, {loc}"
            r["name_note"] = "OpenStreetMap has no name for this course."
            if r["id"] in NAME_HINTS:
                r["name_hint"] = NAME_HINTS[r["id"]]
        r["holes_label"] = (f"{r['holes_expected']} holes" if r["holes_expected"] else "range")
        r["features"] = features(r)
        r["score"] = score(r["features"]) if r["holes_mapped"] else None
        full_holes = r["holes_expected"] and r["holes_mapped"] >= 0.85 * r["holes_expected"]
        r["ranked"] = bool(r["group"] in ("course", "short") and r["completeness"] >= RANK_MIN_COMPLETENESS and full_holes and r["score"] is not None)
        r["unranked_reason"] = None if r["ranked"] else (
            "driving range" if k == "range" else "disc golf (listed, not tiered)" if k == "disc_golf" else
            f"only {r['holes_mapped']} of ~{r['holes_expected']} holes mapped" if not full_holes else
            f"mapping {r['completeness']:.0%} complete (needs {RANK_MIN_COMPLETENESS:.0%})")
        r["tier"] = r["rank"] = r["rank_of"] = r["rank_all"] = None
        r["provisional"] = False
        if r["score"] is not None:
            highlights(r)
        if r["ranked"] and r.get("outline"):
            r["features_outline"] = outline_features(r)[0]     # for the check, and for re-scoring provisional courses in the page
    assign_tiers(allrecs)
    check = assign_provisional(allrecs)
    allrecs.sort(key=lambda r: (r["region"], r["group"], -(r["score"] or -1)))
    for key in regions:
        rs = [r for r in allrecs if r["region"] == key]
        regions[key]["counts"] = {
            "courses": len(rs), "ranked": sum(r["ranked"] for r in rs), "provisional": sum(r["provisional"] for r in rs),
            "by_kind": pd.Series([r["kind"] for r in rs]).value_counts().to_dict(),
            "holes_mapped": int(sum(r["holes_mapped"] for r in rs)), "holes_expected": int(sum(r["holes_expected"] or 0 for r in rs)),
            "bunkers": int(sum(r["bunkers"] for r in rs)), "water_hazards": int(sum(r["water_hazards"] for r in rs)),
            "mean_completeness": float(np.mean([r["completeness"] for r in rs if r["kind"] != "range"]))}
    dump("courses.json", {
        "generated": now_iso(), "regions": regions, "weights": WEIGHTS, "ramps": FEATURE_RAMPS, "ramps_short": FEATURE_RAMPS_SHORT, "feature_notes": FEATURE_NOTES,
        "tiers": TIERS, "completeness_weights": COMPLETENESS, "rank_min_completeness": RANK_MIN_COMPLETENESS,
        "provisional_features": PROVISIONAL_FEATURES, "provisional_check": check,
        "sources": {"osm": "© OpenStreetMap contributors (ODbL), BBBike weekly extracts",
                    "dem": "Copernicus GLO-30 DEM © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the EU and ESA",
                    "worldcover": "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium (CC BY 4.0)",
                    "vanparks": "City of Vancouver Open Data, parks facilities (Open Government Licence – Vancouver)"},
        "courses": allrecs})
    return allrecs


# ============================================================================= forecast

def build_forecast(recs=None):
    if recs is None:
        recs = json.loads((OUT / "courses.json").read_text(encoding="utf-8"))["courses"]
    fc = json.loads((RAW / "forecast.json").read_text(encoding="utf-8"))
    pts = fc["points"]
    plat = np.array([p["lat"] for p in pts]); plon = np.array([p["lon"] for p in pts])
    today = pd.Timestamp.now(tz=TZ).normalize().tz_localize(None)
    days = pd.date_range(today, periods=7, freq="D")
    out_pts, course_days = [], {}
    point_of = {}
    for r in recs:
        d = np.hypot((plat - r["lat"]) * 111.2, (plon - r["lon"]) * 72.8)
        point_of[r["id"]] = int(d.argmin())
    times = None
    for i, p in enumerate(pts):
        h = p["hourly"]
        df = pd.DataFrame({"temp": h["temperature_2m"], "dew": h["dew_point_2m"], "precip": h["precipitation"], "wind": h["wind_speed_10m"],
                           "gust": h["wind_gusts_10m"], "pop": h.get("precipitation_probability"), "code": h.get("weather_code"),
                           "feels": h.get("apparent_temperature")},
                          index=pd.to_datetime(h["time"]).tz_localize("UTC"))
        df = df.dropna(subset=["temp"])
        s = Wx.score(df, p["lat"], p["lon"])
        s = s[(s["date"] >= days[0]) & (s["date"] <= days[-1])]
        kinds = {}
        for kind in ("18", "9", "short"):
            dd = Wx.daily(s, {"short": "pitch_and_putt"}.get(kind, kind))
            kinds[kind] = [{"date": d.strftime("%Y-%m-%d"), **{k: v for k, v in row.items()}} for d, row in dd.iterrows()]
        lt = s.index.tz_convert(TZ)
        if times is None:
            times = [t.strftime("%Y-%m-%dT%H:%M") for t in lt]
        courses_here = [r["id"] for r in recs if point_of[r["id"]] == i]
        out_pts.append({"i": i, "lat": p["lat"], "lon": p["lon"], "region": p["region"], "elevation": p.get("elevation"),
                        "courses": courses_here, "t0": lt[0].strftime("%Y-%m-%dT%H:%M"),
                        "temp": s["temp"].round(1).tolist(), "precip": s["precip"].round(1).tolist(), "pop": s["pop"].tolist(),
                        "wind": s["wind"].round(0).tolist(), "gust": s["gust"].round(0).tolist(), "code": s["code"].tolist(),
                        "comfort": (s["comfort"] * 100).round(0).astype(int).tolist(), "frost": s["frost"].astype(int).tolist(),
                        "daylight": s["daylight"].round(2).tolist(), "days": kinds})
    # per course: its round kind's day list, and the best day this week
    for r in recs:
        kind = "short" if r["group"] == "short" else "9" if (r["holes_expected"] or 18) <= 9 else "18"
        pdays = out_pts[point_of[r["id"]]]["days"][kind]
        best = max(pdays, key=lambda d: (d["playable_h"], d["best_comfort"] or 0)) if pdays else None
        course_days[r["id"]] = {"point": point_of[r["id"]], "round": kind,
                                "week_playable_h": round(sum(d["playable_h"] for d in pdays), 1),
                                "best_day": best["date"] if best and best["playable_h"] else None,
                                "playable_h": [d["playable_h"] for d in pdays],
                                "best_start": [d["best_start"] for d in pdays], "best_end": [d["best_end"] for d in pdays]}
    regions = {}
    for key in REGIONS:
        rp = [p for p in out_pts if p["region"] == key]
        per_day = []
        for j, d in enumerate(days):
            ph = [p["days"]["18"][j]["playable_h"] for p in rp if j < len(p["days"]["18"])]
            per_day.append({"date": d.strftime("%Y-%m-%d"), "median_playable_h": float(np.median(ph)) if ph else None,
                            "max_playable_h": max(ph) if ph else None})
        regions[key] = {"days": per_day}
    dump("playability.json", {"generated": now_iso(), "forecast_fetched": fc["fetched"], "tz": TZ, "model": {
        "rules": PLAYABILITY, "playable_min": PLAYABLE_MIN, "round_hours": ROUND_HOURS,
        "notes": "Hour = the hour ending at the time shown. Comfort is the product of ramps for rain, sustained wind, gusts, "
                 "temperature, frost delay and daylight; playable = comfort >= playable_min. Source: Open-Meteo best-match models "
                 "(CC BY 4.0)."},
        "days": [d.strftime("%Y-%m-%d") for d in days], "points": out_pts, "courses": course_days, "regions": regions})


# ============================================================================= observations + climatology

def load_obs(key) -> pd.DataFrame:
    st = OBS_STATIONS[key]
    def read(cid):
        fs = sorted((RAW / "obs").glob(f"{cid}_*.parquet"))
        if not fs:
            return pd.DataFrame()
        return pd.concat([pd.read_parquet(f) for f in fs]).drop_duplicates("time").set_index("time").sort_index()
    df = read(st["id"])
    if st.get("wind_from") and len(df):
        w = read(st["wind_from"])
        df["wind"] = w["wind"].reindex(df.index) if len(w) else np.nan
    return df


@functools.lru_cache(maxsize=None)
def obs_scored(key) -> pd.DataFrame:
    st = OBS_STATIONS[key]
    df = load_obs(key)
    if df.empty:
        return df
    full = pd.date_range(df.index.min(), df.index.max(), freq="h")
    df = df.reindex(full)
    s = Wx.score(df[["temp", "precip", "wind"]], st["lat"], st["lon"], use_gust=False)
    # a day counts only if every daylight hour has temperature and precipitation (wind gaps are tolerated: rare and
    # the wind rule rarely binds) and the night before is complete enough for the frost rule
    bad = (s["daylight"] > 0) & (df["temp"].isna() | df["precip"].isna())
    s["valid"] = ~bad.groupby(s["date"]).transform("any")
    return s


def splice(series, min_overlap=60):
    """Vectorised equivalent of pipelines.common.eccc.splice (same rule: the first station is the reference; later
    ones fill gaps after a month-by-month bias adjustment over the overlap). The shared version loops per day in
    Python and takes ~30 s per 35-year series."""
    combined = None
    for t in series:
        t = t.dropna()
        t = t[~t.index.duplicated()]
        if t.empty:
            continue
        if combined is None:
            combined = t
            continue
        overlap = combined.index.intersection(t.index)
        diff = combined.loc[overlap] - t.loc[overlap]
        by = diff.groupby(diff.index.month).agg(["mean", "count"])
        overall = diff.mean() if len(diff) else 0.0
        adj_m = by["mean"].where(by["count"] >= min_overlap).reindex(range(1, 13)).fillna(overall if np.isfinite(overall) else 0.0)
        adj = pd.Series(adj_m.reindex(t.index.month).to_numpy(), index=t.index)
        filler = (t + adj).loc[~t.index.isin(combined.index)]
        combined = pd.concat([combined, filler]).sort_index()
    if combined is None:
        return pd.Series(dtype=float)
    return combined.reindex(pd.date_range(combined.index.min(), combined.index.max(), freq="D"))


def build_climate():
    out = {}
    mid = pd.date_range("2025-01-01", periods=12, freq="MS") + pd.Timedelta(days=14)  # the 15th of each month
    for key, st in CLIMATE_STATIONS.items():
        frames = [pd.read_parquet(RAW / "climate" / f"{cid}.parquet") for cid in st["ids"] if (RAW / "climate" / f"{cid}.parquet").exists()]
        frames = [f.set_index("date") for f in frames if len(f)]
        if not frames:
            continue
        tmax = splice([f["tmax"] for f in frames]); tmin = splice([f["tmin"] for f in frames])
        pr = eccc.fill_series([f["precip"] for f in frames])
        d = pd.DataFrame({"tmax": tmax, "tmin": tmin, "precip": pr})
        d = d[(d.index >= "1991-01-01") & (d.index < f"{pd.Timestamp.now().year}-01-01")]
        g = d.groupby(d.index.month)
        reg_lat, reg_lon = REGIONS[key]["center"][1], REGIONS[key]["center"][0]
        sun = Wx.sun_times(reg_lat, reg_lon, mid)
        months = []
        for m in range(1, 13):
            x = g.get_group(m)
            n = x[["tmax", "precip"]].dropna().shape[0]
            good = ((x["precip"] < 1) & (x["tmax"] >= 12)).sum() / max(1, n)
            months.append({"month": m, "tmax": x["tmax"].mean(), "tmin": x["tmin"].mean(), "precip_mm": x["precip"].mean() * 30.4,
                           "wet_days_pct": 100 * (x["precip"] >= 1).mean(), "soaking_days_pct": 100 * (x["precip"] >= 10).mean(),
                           "frost_days_pct": 100 * (x["tmin"] <= 0).mean(), "light_frost_days_pct": 100 * (x["tmin"] <= 2).mean(),
                           "good_days_pct": 100 * good,
                           "daylight_h": (sun["sunset"].iloc[m - 1] - sun["sunrise"].iloc[m - 1]).total_seconds() / 3600})
        out[key] = {"stations": st["name"], "period": f"{d.index.min():%Y}–{d.index.max():%Y}", "months": months}
    # observed playable hours by month (hourly CS stations, same rules as the forecast minus gusts)
    for key, st in OBS_STATIONS.items():
        s = obs_scored(key)
        if s.empty:
            continue
        s = s.assign(frost_day=s["frost"] & (s["daylight"] > 0))
        dd = s[s["valid"]].groupby("date").agg(playable_h=("playable_dh", "sum"), frost=("frost_day", "any"))
        dd = dd[dd.index < pd.Timestamp.now().normalize()]
        frost_end = s[s["frost"] & (s["daylight"] > 0) & s["valid"]].groupby("date").apply(lambda g: g.index.max().tz_convert(TZ).hour)
        mm = dd.groupby(dd.index.month)
        months = []
        for m in range(1, 13):
            x = mm.get_group(m) if m in mm.groups else pd.DataFrame(columns=dd.columns)
            fe = frost_end[frost_end.index.month == m]
            months.append({"month": m, "days": len(x), "playable_h": x["playable_h"].mean() if len(x) else None,
                           "playable_day_pct": 100 * (x["playable_h"] >= PLAYABLE_DAY_HOURS).mean() if len(x) else None,
                           "frost_delay_pct": 100 * x["frost"].mean() if len(x) else None,
                           "frost_until_median_h": float(fe.median()) if len(fe) else None})
        best = sorted([m for m in months if m["playable_h"] is not None], key=lambda m: -m["playable_h"])[:4]
        reg = st["region"]
        out.setdefault(reg, {}).setdefault("observed", {})[key] = {
            "station": st["name"], "period": f"{dd.index.min():%Y-%m-%d} to {dd.index.max():%Y-%m-%d}", "valid_days": len(dd),
            "months": months, "best_months": [m["month"] for m in best]}
    dump("climate.json", {"generated": now_iso(), "regions": out, "playable_day_hours": PLAYABLE_DAY_HOURS,
                          "notes": "Daily ECCC climate 1991 to last year (stations spliced with a monthly bias adjustment). "
                                   "good_days = precipitation under 1 mm and a high of 12 °C or more. Observed playable hours use "
                                   "the forecast's rules on hourly ECCC data (no gust rule: these stations don't report gusts)."})


# ============================================================================= backtest

def build_backtest():
    res, series = {}, {}
    pooled = {L: [] for L in [0] + BACKTEST_LEADS}
    for key, st in OBS_STATIONS.items():
        f = RAW / "hindcast" / f"{key}.parquet"
        if not f.exists():
            continue
        hc = pd.read_parquet(f).set_index("time").sort_index()
        ob = obs_scored(key)
        if ob.empty:
            continue
        od = ob.groupby("date").agg(playable_h=("playable_dh", "sum"), valid=("valid", "all"))
        start = hc.index.min().tz_convert(TZ).normalize().tz_localize(None) + pd.Timedelta(days=1)
        # climatology baseline: mean observed playable hours for the calendar month, from years before the backtest
        prior = od[(od.index < start) & od["valid"]]
        clim = prior.groupby(prior.index.month)["playable_h"].mean()
        res[key] = {"station": st["name"], "region": st["region"], "leads": {}}
        for L in [0] + BACKTEST_LEADS:
            sfx = "" if L == 0 else f"_previous_day{L}"
            cols = {"temp": f"temperature_2m{sfx}", "precip": f"precipitation{sfx}", "wind": f"wind_speed_10m{sfx}"}
            if not all(c in hc for c in cols.values()):
                continue
            fdf = hc[list(cols.values())].rename(columns={v: k for k, v in cols.items()}).dropna()
            if fdf.empty:
                continue
            fs = Wx.score(fdf, st["lat"], st["lon"], use_gust=False)
            fd = fs.groupby("date").agg(fc_h=("playable_dh", "sum"), n=("playable", "size"), day_h=("daylight", "sum"))
            j = fd[fd["n"] >= 23].join(od, how="inner")
            j = j[j["valid"] & (j.index >= start) & (j.index < pd.Timestamp.now(tz=TZ).normalize().tz_localize(None))]
            if j.empty:
                continue
            # hour-by-hour agreement over daylight hours
            hh = fs[["playable", "daylight"]].join(ob[["playable", "valid"]], rsuffix="_obs", how="inner")
            hh = hh[(hh["daylight"] > 0) & hh["valid"] & hh.index.tz_convert(TZ).tz_localize(None).normalize().isin(j.index)]
            err = j["fc_h"] - j["playable_h"]
            fp, op = j["fc_h"] >= PLAYABLE_DAY_HOURS, j["playable_h"] >= PLAYABLE_DAY_HOURS
            good_need = GOOD_DAY_SHARE * j["day_h"]
            fg, og = j["fc_h"] >= good_need, j["playable_h"] >= good_need
            cb = j.index.month.map(clim).to_numpy(dtype=float)
            ok = np.isfinite(cb)
            cg = pd.Series(cb >= good_need.to_numpy(), index=j.index)       # climatology's call on a good day
            cp = pd.Series(cb >= PLAYABLE_DAY_HOURS, index=j.index)
            mae_clim = float(np.abs(cb[ok] - j["playable_h"].to_numpy()[ok]).mean()) if ok.any() else None
            mae = float(err.abs().mean())
            res[key]["leads"][str(L)] = {
                "days": int(len(j)), "mae_h": mae, "bias_h": float(err.mean()), "within1_pct": float(100 * (err.abs() <= 1).mean()),
                "hit_rate_pct": float(100 * (fp == op).mean()), "pod_pct": float(100 * (fp & op).sum() / max(1, op.sum())),
                "false_alarm_pct": float(100 * (fp & ~op).sum() / max(1, fp.sum())),
                "hit_rate_climatology_pct": float(100 * (cp == op).mean()),
                "good_day_hit_rate_pct": float(100 * (fg == og).mean()), "good_day_hit_rate_climatology_pct": float(100 * (cg == og).mean()),
                "good_day_obs_pct": float(100 * og.mean()),
                "hour_accuracy_pct": float(100 * (hh["playable"] == hh["playable_obs"]).mean()) if len(hh) else None,
                "corr": float(np.corrcoef(j["fc_h"], j["playable_h"])[0, 1]) if len(j) > 2 and j["fc_h"].std() > 0 else None,
                "mae_climatology_h": mae_clim, "skill_vs_climatology": (1 - mae / mae_clim) if mae_clim else None}
            j2 = j.assign(err=err, month=j.index.to_period("M").astype(str))
            pooled[L].append(j2[["fc_h", "playable_h", "err"]].assign(fp=fp, op=op, fg=fg, og=og, cg=cg, cp=cp, clim=cb))
            if L in (1, 3):
                res[key]["leads"][str(L)]["by_month"] = {m: {"days": int(len(g)), "mae_h": float(g["err"].abs().mean()), "bias_h": float(g["err"].mean())}
                                                       for m, g in j2.groupby("month")}
            if L in (0, 1, 3, 7):
                tail = j.tail(60)
                series.setdefault(key, {"dates": [d.strftime("%Y-%m-%d") for d in tail.index], "observed": tail["playable_h"].round(1).tolist()})
                series[key][f"lead{L}"] = [None if pd.isna(v) else round(float(v), 1) for v in tail["fc_h"].reindex(pd.to_datetime(series[key]["dates"]))]
        res[key]["period"] = f"{start:%Y-%m-%d} to {od.index.max():%Y-%m-%d}"
    overall = {}
    for L, parts in pooled.items():
        if not parts:
            continue
        p = pd.concat(parts)
        ok = np.isfinite(p["clim"])
        mc = float((p["clim"][ok] - p["playable_h"][ok]).abs().mean())
        overall[str(L)] = {"days": int(len(p)), "mae_h": float(p["err"].abs().mean()), "bias_h": float(p["err"].mean()),
                           "within1_pct": float(100 * (p["err"].abs() <= 1).mean()), "hit_rate_pct": float(100 * (p["fp"] == p["op"]).mean()),
                           "hit_rate_climatology_pct": float(100 * (p["cp"] == p["op"]).mean()),
                           "good_day_hit_rate_pct": float(100 * (p["fg"] == p["og"]).mean()),
                           "good_day_hit_rate_climatology_pct": float(100 * (p["cg"] == p["og"]).mean()),
                           "mae_climatology_h": mc, "skill_vs_climatology": 1 - float(p["err"].abs().mean()) / mc if mc else None}
    dump("backtest.json", {"generated": now_iso(), "leads": [0] + BACKTEST_LEADS, "playable_day_hours": PLAYABLE_DAY_HOURS,
                           "good_day_share": GOOD_DAY_SHARE,
                           "notes": "Forecast = Open-Meteo previous-runs API (best-match models): the value for each hour from the run "
                                    "issued N days earlier (lead 0 = the latest run). Truth = ECCC hourly observations at automatic "
                                    "stations. Both go through the same playable-hour rules minus the gust rule (no gust record at "
                                    "these stations). Climatology baseline = observed monthly mean playable hours from the years "
                                    "before the backtest window.",
                           "overall": overall, "stations": res, "recent": series})


# ============================================================================= status + CLI

def build_status():
    f = RAW / "status.json"
    st = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
    dump("status.json", {"generated": now_iso(), "sources": st})


PARTS = {"courses": build_courses, "forecast": build_forecast, "climate": build_climate, "backtest": build_backtest}


def main(argv):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    names = [a for a in argv if a != "all"] or list(PARTS)
    failed = []
    for n in names:
        print(f"[{n}]", flush=True)
        try:
            PARTS[n]()
        except Exception as exc:                 # keep the old output of this part; build the rest
            traceback.print_exc()
            failed.append(f"{n}: {type(exc).__name__}: {exc}"[:300])
    if failed:
        f = RAW / "status.json"
        st = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
        st["build"] = {"ok": False, "attempted": now_iso(), "error": "; ".join(failed)}
        f.write_text(json.dumps(st, indent=1), encoding="utf-8")
        import os
        if os.environ.get("GITHUB_ACTIONS"):
            for m in failed:
                print(f"::warning title=Golf build part failed::{m}", flush=True)
    else:
        f = RAW / "status.json"
        if f.exists():
            st = json.loads(f.read_text(encoding="utf-8"))
            st["build"] = {"ok": True, "attempted": now_iso(), "error": None}
            f.write_text(json.dumps(st, indent=1), encoding="utf-8")
    build_status()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
