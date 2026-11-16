"""Light-pollution model and static map layers for Dark Sky Finder.

  python -m pipelines.darksky.build

Target: Sky Quality Meter readings (mag/arcsec²) reported to Globe at Night under clear, dark
(sun < −15°) skies. Features: VIIRS night-light index at the point and averaged over growing
radii (sky glow travels tens of km), the brightest source within ~25 km, and moonlight at the
time of the reading. Validated with spatial block cross-validation (1° cells held out together)
against a one-feature log-linear baseline.
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone

import ephem
import numpy as np
import pandas as pd
from PIL import Image
from scipy import ndimage
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import LinearRegression
from sklearn.model_selection import GroupKFold

from .config import COMPOSITE_YEARS, OUT, RAW, RES_DEG, SITES, TOWNS, TRAIN_BBOX, VIEWS

SIGMAS = [1, 3, 8, 20, 50]          # gaussian sigma in grid cells (~1.1 km each)
LATEST, EARLIEST = max(COMPOSITE_YEARS), min(COMPOSITE_YEARS)
SQM_MIN, SQM_MAX = 15.5, 22.3
POTENTIAL_Q = 0.8           # "good night" sky: readings are only ever contaminated brighter


# ----------------------------------------------------------------------------- features

def feature_stack(index: np.ndarray) -> dict[str, np.ndarray]:
    f = index.astype(np.float32)
    feats = {"light_point": f}
    for s in SIGMAS:
        feats[f"glow_{s}"] = ndimage.gaussian_filter(f, sigma=s, mode="nearest")
    feats["max_25km"] = ndimage.maximum_filter(ndimage.gaussian_filter(f, 1), size=45, mode="nearest")
    return feats


def sample(feats: dict[str, np.ndarray], lat, lon) -> pd.DataFrame:
    s, w, n, e = TRAIN_BBOX
    r = np.clip(((n - np.asarray(lat)) / RES_DEG).astype(int), 0, next(iter(feats.values())).shape[0] - 1)
    c = np.clip(((np.asarray(lon) - w) / RES_DEG).astype(int), 0, next(iter(feats.values())).shape[1] - 1)
    return pd.DataFrame({k: v[r, c] for k, v in feats.items()})


def moon_and_sun(df: pd.DataFrame) -> pd.DataFrame:
    """Moon altitude/phase and sun altitude at each observation.

    Globe at Night's UT columns carry a sign error in 2014–2022 releases (UT = local − offset),
    so UT is rebuilt from the local date/time and longitude (local solar time; ±1 h is
    plenty for darkness and moonlight).
    """
    ut = (pd.to_datetime(df.LocalDate.astype(str).str[:10] + " " + df.LocalTime.astype(str).str[:5], errors="coerce")
          - pd.to_timedelta(df.Longitude / 15, unit="h"))
    obs, moon, sun = ephem.Observer(), ephem.Moon(), ephem.Sun()
    out = []
    for lat, lon, t in zip(df.Latitude, df.Longitude, ut):
        if pd.isna(t):
            out.append((np.nan, np.nan, np.nan))
            continue
        obs.lat, obs.lon = str(lat), str(lon)
        obs.date = ephem.Date(t.to_pydatetime())
        moon.compute(obs); sun.compute(obs)
        out.append((math.degrees(moon.alt), moon.phase / 100, math.degrees(sun.alt)))
    m = pd.DataFrame(out, columns=["moon_alt", "moon_illum", "sun_alt"], index=df.index)
    m["moonlight"] = m.moon_illum * np.sin(np.radians(m.moon_alt.clip(lower=0)))
    return m


# ----------------------------------------------------------------------------- conversions

def sqm_to_nelm(sqm):
    """Naked-eye limiting magnitude from sky brightness (common Schaefer-style approximation)."""
    return 7.93 - 5 * np.log10(10 ** (4.316 - np.asarray(sqm) / 5) + 1)


BORTLE = [(21.99, 1), (21.89, 2), (21.69, 3), (20.49, 4), (19.50, 5), (18.94, 6), (18.38, 7), (17.80, 8), (-99, 9)]


def bortle(sqm: float) -> int:
    return next(b for thr, b in BORTLE if sqm >= thr)


# ----------------------------------------------------------------------------- main

def main() -> None:
    lights = {y: np.load(RAW / f"lights_{y}.npy") for y in COMPOSITE_YEARS}
    feats = feature_stack(lights[LATEST])
    names = list(feats) + ["moonlight"]

    gan = pd.read_parquet(RAW / "gan.parquet")
    gan["sqm"] = pd.to_numeric(gan.SQMReading, errors="coerce")
    gan["nelm"] = pd.to_numeric(gan.LimitingMag, errors="coerce")
    clear = gan[gan.CloudCover.astype(str).str.lower().eq("clear")].copy()
    clear = clear.join(moon_and_sun(clear))
    clear = clear[clear.sun_alt < -15]
    X_all = sample(feats, clear.Latitude, clear.Longitude)
    X_all.index = clear.index
    clear = clear.join(X_all)

    train = clear[clear.sqm.between(SQM_MIN, SQM_MAX)].copy()
    train["block"] = (np.floor(train.Latitude).astype(int) * 1000 + np.floor(train.Longitude).astype(int))
    print(f"SQM training rows: {len(train):,} in {train.block.nunique()} one-degree blocks")
    X, y, groups = train[names].to_numpy(), train.sqm.to_numpy(), train.block.to_numpy()

    base_params = dict(max_iter=400, learning_rate=0.04, max_leaf_nodes=24, min_samples_leaf=30, l2_regularization=1.0,
                       monotonic_cst=[-1] * len(names), random_state=7)
    typical_params = {**base_params, "loss": "absolute_error"}
    potential_params = {**base_params, "loss": "quantile", "quantile": POTENTIAL_Q}
    cv = GroupKFold(n_splits=5)
    pred_typ, pred_pot, pred_base, pred_base_q = (np.zeros_like(y) for _ in range(4))
    glow = train["glow_8"].to_numpy()
    for tr, te in cv.split(X, y, groups):
        pred_typ[te] = HistGradientBoostingRegressor(**typical_params).fit(X[tr], y[tr]).predict(X[te])
        pred_pot[te] = HistGradientBoostingRegressor(**potential_params).fit(X[tr], y[tr]).predict(X[te])
        b = LinearRegression().fit(np.log1p(glow[tr])[:, None], y[tr])
        pred_base[te] = b.predict(np.log1p(glow[te])[:, None])
        # baseline for the potential model: the training quantile within the same glow decile
        edges = np.quantile(glow[tr], np.linspace(0, 1, 11))
        dec_tr, dec_te = np.clip(np.searchsorted(edges, glow[tr]) - 1, 0, 9), np.clip(np.searchsorted(edges, glow[te]) - 1, 0, 9)
        qs = np.array([np.quantile(y[tr][dec_tr == k], POTENTIAL_Q) for k in range(10)])
        pred_base_q[te] = qs[dec_te]

    def metrics(p):
        err = p - y
        return {"mae": round(float(np.abs(err).mean()), 3), "rmse": round(float(np.sqrt((err ** 2).mean())), 3),
                "r2": round(float(1 - (err ** 2).sum() / ((y - y.mean()) ** 2).sum()), 3),
                "bortle_exact": round(float(np.mean([bortle(a) == bortle(b) for a, b in zip(p, y)])), 3),
                "bortle_within1": round(float(np.mean([abs(bortle(a) - bortle(b)) <= 1 for a, b in zip(p, y)])), 3)}

    def qmetrics(p, q=POTENTIAL_Q):
        d = y - p
        return {"pinball": round(float(np.mean(np.maximum(q * d, (q - 1) * d))), 4), "coverage": round(float(np.mean(y <= p)), 3)}
    m_gbm, m_base = metrics(pred_typ), metrics(pred_base)
    q_gbm, q_base = qmetrics(pred_pot), qmetrics(pred_base_q)
    print("spatial CV typical   gbm:", m_gbm, "baseline:", m_base)
    print("spatial CV potential gbm:", q_gbm, " baseline:", q_base)

    model_typ = HistGradientBoostingRegressor(**typical_params).fit(X, y)
    model = HistGradientBoostingRegressor(**potential_params).fit(X, y)

    # Independent check: naked-eye limiting magnitude reports (no SQM) vs the model's prediction
    nel = clear[clear.sqm.isna() & clear.nelm.between(1, 7) & (clear.moonlight < 0.05)].copy()
    nel_pred = sqm_to_nelm(model_typ.predict(nel[names].to_numpy()))
    nelm_check = {"n": int(len(nel)), "spearman": round(float(pd.Series(nel_pred).corr(nel.nelm.reset_index(drop=True), method="spearman")), 3),
                  "by_reported": nel.assign(pred=nel_pred).groupby("nelm").pred.agg(["mean", "count"]).round(2).reset_index().values.tolist()}
    print("NELM check:", nelm_check["n"], "rows, spearman", nelm_check["spearman"])

    # permutation-style importance (drop in R² when a feature is shuffled), on the CV-free fit
    rng = np.random.default_rng(0)
    base_r2 = 1 - ((model_typ.predict(X) - y) ** 2).sum() / ((y - y.mean()) ** 2).sum()
    importance = {}
    for j, nme in enumerate(names):
        Xp = X.copy(); Xp[:, j] = rng.permutation(Xp[:, j])
        r2 = 1 - ((model_typ.predict(Xp) - y) ** 2).sum() / ((y - y.mean()) ** 2).sum()
        importance[nme] = round(float(base_r2 - r2), 4)

    OUT.mkdir(parents=True, exist_ok=True)
    s, w, n, e = TRAIN_BBOX
    layers = {}
    for key, v in VIEWS.items():
        vs, vw, vn, ve = v["bbox"]
        r0, r1 = int((n - vn) / RES_DEG), int((n - vs) / RES_DEG)
        c0, c1 = int((vw - w) / RES_DEG), int((ve - w) / RES_DEG)
        sub = {k: a[r0:r1, c0:c1] for k, a in feats.items()}
        h, wd = next(iter(sub.values())).shape
        Xg = np.column_stack([sub[k].ravel() for k in feats] + [np.zeros(h * wd)])
        sqm = model.predict(Xg).reshape(h, wd).clip(SQM_MIN, SQM_MAX)
        # value PNG: 8-bit encoding of SQM for click lookups; colour PNG for display
        enc = np.round((sqm - SQM_MIN) / (SQM_MAX - SQM_MIN) * 254 + 1).astype(np.uint8)
        Image.fromarray(enc, "L").save(OUT / f"sqm_{key}.png", optimize=True)
        Image.fromarray(colourise(sqm), "RGBA").save(OUT / f"sqm_{key}_rgba.png", optimize=True)
        # brightening: change in smoothed light index between composites
        d = (ndimage.gaussian_filter(lights[LATEST].astype(np.float32), 2) -
             ndimage.gaussian_filter(lights[EARLIEST].astype(np.float32), 2))[r0:r1, c0:c1]
        lit = ndimage.gaussian_filter(np.maximum(lights[LATEST], lights[EARLIEST]).astype(np.float32), 2)[r0:r1, c0:c1] > 12
        Image.fromarray(diverging(d, lit), "RGBA").save(OUT / f"change_{key}_rgba.png", optimize=True)
        layers[key] = {"bounds": [[vw, vn], [ve, vn], [ve, vs], [vw, vs]], "shape": [h, wd],
                       "sqm_range": [SQM_MIN, SQM_MAX],
                       "share_bortle_le3": round(float((sqm >= 21.69).mean()), 3),
                       "share_bortle_ge7": round(float((sqm < 18.94).mean()), 3)}
        print(f"  {key}: {wd}x{h}, Bortle ≤3 share {layers[key]['share_bortle_le3']:.0%}")

    # sites
    site_feats = sample(feats, [x[2] for x in SITES], [x[1] for x in SITES])
    site_feats["moonlight"] = 0.0
    site_sqm = model.predict(site_feats[names].to_numpy())
    site_typ = model_typ.predict(site_feats[names].to_numpy())
    sites = [{"name": nm, "lon": lo, "lat": la, "view": vw_, "kind": kd, "note": nt, "sqm": round(float(q), 2),
              "sqm_typical": round(float(t), 2), "bortle": bortle(q), "nelm": round(float(sqm_to_nelm(q)), 1)}
             for (nm, lo, la, vw_, kd, nt), q, t in zip(SITES, site_sqm, site_typ)]

    # glow-reach transects: average predicted SQM in rings around major cities
    cities = {"Vancouver": (-123.12, 49.28), "Victoria": (-123.37, 48.43), "Phoenix": (-112.07, 33.45), "Tucson": (-110.97, 32.22)}
    reach = {}
    for cname, (lo, la) in cities.items():
        rows = []
        for km in list(range(0, 21, 2)) + list(range(25, 121, 5)):
            ang = np.linspace(0, 2 * np.pi, 72, endpoint=False)
            lats = la + (km / 111.0) * np.sin(ang)
            lons = lo + (km / (111.0 * math.cos(math.radians(la)))) * np.cos(ang)
            inside = (lats > s) & (lats < n) & (lons > w) & (lons < e)
            fx = sample(feats, lats[inside], lons[inside]); fx["moonlight"] = 0.0
            q = model.predict(fx[names].to_numpy())
            rows.append([km, round(float(np.median(q)), 2), round(float(np.percentile(q, 90)), 2)])
        reach[cname] = rows

    # brightening by town: mean light index within ~5 km, both composites
    towns = []
    sm = {yr: ndimage.uniform_filter(lights[yr].astype(np.float32), size=9) for yr in COMPOSITE_YEARS}
    for nm, lo, la, vw_ in TOWNS:
        a, b = (float(sample({"v": sm[yr]}, [la], [lo]).v.iloc[0]) for yr in (EARLIEST, LATEST))
        towns.append({"name": nm, "lon": lo, "lat": la, "view": vw_, "before": round(a, 1), "after": round(b, 1),
                      "change_pct": round(100 * (b - a) / max(a, 1), 1)})

    obs_points = train.assign(pred=pred_typ).sample(min(2500, len(train)), random_state=1)
    model_json = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "n_train": int(len(train)), "n_blocks": int(train.block.nunique()), "years": [int(train.year.min()), int(train.year.max())],
        "cv": {"typical": {"gbm": m_gbm, "baseline": m_base}, "potential": {"gbm": q_gbm, "baseline": q_base, "q": POTENTIAL_Q}},
        "nelm_check": nelm_check, "importance": importance,
        "features": names, "composite_years": COMPOSITE_YEARS,
        "scatter": obs_points[["sqm", "pred", "Latitude", "Longitude", "year"]].round(3).values.tolist(),
        "reach": reach, "towns": towns, "layers": layers, "views": VIEWS, "bortle": BORTLE,
    }
    with open(OUT / "model.json", "w", encoding="utf-8") as f:
        json.dump(model_json, f, separators=(",", ":"))
    with open(OUT / "sites.json", "w", encoding="utf-8") as f:
        json.dump(sites, f, separators=(",", ":"))
    print("wrote model.json, sites.json and map layers")


# ----------------------------------------------------------------------------- colour

# Sequential ramp for sky brightness: bright (light-polluted) = warm and opaque,
# dark = transparent-ish deep violet so the basemap and stars-feel show through.
SQM_STOPS = [(16.0, (255, 236, 179, 235)), (17.5, (255, 183, 77, 220)), (18.6, (240, 98, 146, 205)),
             (19.6, (171, 71, 188, 185)), (20.6, (94, 53, 177, 160)), (21.4, (40, 30, 110, 120)), (22.0, (10, 10, 40, 40))]


def colourise(sqm: np.ndarray) -> np.ndarray:
    xs = np.array([s for s, _ in SQM_STOPS])
    cols = np.array([c for _, c in SQM_STOPS], dtype=float)
    out = np.stack([np.interp(sqm, xs, cols[:, k]) for k in range(4)], axis=-1)
    return out.astype(np.uint8)


def diverging(d: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Brightening (warm) vs dimming (cool), transparent where there is little light."""
    t = np.clip(d / 40.0, -1, 1)
    warm, cool = np.array([229, 57, 53]), np.array([30, 136, 229])
    rgb = np.where(t[..., None] >= 0, warm, cool)
    a = (np.abs(t) ** 0.7 * 230) * mask
    return np.dstack([rgb, a]).astype(np.uint8)


if __name__ == "__main__":
    main()
