"""Build Waterways' JSON from the cached inputs (python -m pipelines.ships.build).

  typical.json   one week of US Coast Guard AIS per named area: vessels per day by type, a weekday × hour grid, the
                 hour-of-day profile by type, regular vessels, cruise calls at Ogden Point
  lanes.json     where vessels go: a ~650 m grid of vessel-time (10-minute slots) over home waters, split by group
  replay.json    one whole day of every vessel in home waters, 5-minute positions (thinned), for the "a day on the water" map
  types.json     MMSI → category for every vessel seen that week (the live map's fallback when a ship hasn't sent its type)
  notices.json   Canadian Coast Guard Pacific NAVWARNs (S-124 trial exchange set)
  river.json     Fraser River at Hope: daily discharge normals (p10/p50/p90) for the freshet chart

Each part is built only when its inputs are cached; otherwise the published file is left as it is.
"""
from __future__ import annotations

import json
import math
import re
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from .config import AREAS, CATS, CRUISE_M, HOME_BBOX, HOPE, NORMAL_YEARS, OUT, RAW, S124_PAGE, vessel_category

TZ = "America/Vancouver"
NOAA = "NOAA / BOEM Marine Cadastre: US Coast Guard terrestrial AIS (public domain)"
DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="minutes")


def write(name: str, obj) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    txt = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    (OUT / name).write_text(txt, encoding="utf-8")
    print(f"  {name}: {len(txt) / 1024:,.0f} kB")


def clean_name(s) -> str:
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s.title() if s.isupper() else s


# ============================================================================= AIS
def load_ais() -> pd.DataFrame | None:
    files = sorted((RAW / "ais").glob("*.parquet"))
    if not files:
        return None
    df = pd.concat([pd.read_parquet(f) for f in files], ignore_index=True)
    df["t"] = pd.to_datetime(df.BaseDateTime, utc=True).dt.tz_convert(TZ)
    df["cat"] = df.VesselType.map(vessel_category).astype("int8")
    df["Length"] = df.Length.where(df.Length.between(2, 500))
    df.attrs["days"] = [f.stem for f in files]
    return df


def vessel_table(df: pd.DataFrame) -> pd.DataFrame:
    """One row per MMSI: its most common name, category and length (AIS static data is noisy)."""
    g = df.groupby("MMSI")
    v = pd.DataFrame({
        "name": g.VesselName.agg(lambda s: s.mode().iat[0] if s.notna().any() else ""),
        "cat": g.cat.agg(lambda s: s[s != 6].mode().iat[0] if (s != 6).any() else 6),
        "len": g.Length.median(),
    })
    v["name"] = v.name.map(clean_name)
    v["cruise"] = (v.cat == 0) & (v.len >= CRUISE_M)
    return v


def area_stats(df: pd.DataFrame, V: pd.DataFrame, area) -> dict:
    aid, name, group, kind, (s, w, n, e) = area
    a = df[df.LAT.between(s, n) & df.LON.between(w, e)].copy()
    a["cat"] = a.MMSI.map(V.cat).astype("int8")
    a["dow"] = a.t.dt.dayofweek
    a["hour"] = a.t.dt.hour
    a["date"] = a.t.dt.date
    # weekday × hour: unique vessels present (each local weekday-hour occurs exactly once in a 7-day UTC window)
    grid = np.zeros((7, 24), dtype=int)
    for (d, h), x in a.groupby(["dow", "hour"]).MMSI.nunique().items():
        grid[d, h] = x
    # hour-of-day profile by category: mean over the 7 occurrences of that hour
    hourly = np.zeros((24, len(CATS)))
    for (h, c), x in a.groupby(["hour", "cat"]).apply(lambda q: q.groupby("dow").MMSI.nunique().sum(), include_groups=False).items():
        hourly[h, c] = x / 7
    per_dow = a.groupby("dow").MMSI.nunique().reindex(range(7), fill_value=0)
    by_cat = (a.groupby(["dow", "cat"]).MMSI.nunique().groupby("cat").sum() / 7).reindex(range(len(CATS)), fill_value=0)
    moving = a.SOG >= 1
    # regulars: vessels seen on the most weekdays (then most time in the area)
    seen = a.groupby("MMSI").agg(days=("dow", "nunique"), n=("dow", "size"))
    seen = seen.sort_values(["days", "n"], ascending=False).head(14)
    regulars = [[V.name.get(m) or "(no name)", int(V.cat.get(m, 6)), None if pd.isna(V.len.get(m)) else int(V.len.get(m)), int(r.days)]
                for m, r in seen.iterrows()]
    busiest = np.unravel_index(grid.argmax(), grid.shape)
    out = {
        "id": aid, "name": name, "group": group, "kind": kind, "bbox": [w, s, e, n],
        "vessels_week": int(a.MMSI.nunique()), "per_day": round(float(per_dow.mean()), 1),
        "by_cat": [round(float(x), 1) for x in by_cat],
        "per_dow": [int(x) for x in per_dow],
        "grid": grid.tolist(), "hourly": np.round(hourly, 2).tolist(),
        "busiest": {"dow": DOW[busiest[0]], "hour": int(busiest[1]), "n": int(grid.max())},
        "moving_share": round(float(moving.mean()), 3) if len(a) else None,
        "speed_kn": round(float(a.SOG[moving].median()), 1) if moving.any() else None,
        "regulars": regulars,
    }
    if aid == "vic-harbour":                                   # cruise calls at Ogden Point
        cr = a[a.MMSI.map(V.cruise)]
        calls = []
        for (m, d), x in cr.groupby(["MMSI", "date"]):
            calls.append([str(d), V.name.get(m), None if pd.isna(V.len.get(m)) else int(V.len.get(m)), x.t.min().strftime("%H:%M"), x.t.max().strftime("%H:%M")])
        out["cruise_calls"] = sorted(calls)
    return out


def typical(df: pd.DataFrame, V: pd.DataFrame) -> dict:
    days = df.attrs["days"]
    areas = [area_stats(df, V, a) for a in AREAS]
    return {
        "generated": now_iso(), "source": NOAA, "days": days, "cats": CATS, "cruise_m": CRUISE_M, "tz": TZ,
        "window": {"from": df.t.min().isoformat(timespec="minutes"), "to": df.t.max().isoformat(timespec="minutes")},
        "home": {"vessels_week": int(df.MMSI.nunique()), "by_cat": [int(x) for x in V.cat.value_counts().reindex(range(len(CATS)), fill_value=0)]},
        "areas": areas,
    }


def lanes(df: pd.DataFrame, V: pd.DataFrame) -> dict:
    """Vessel-time per ~650 m cell: distinct (vessel, 10-minute slot) pairs, split into four groups."""
    s, w, n, e = HOME_BBOX
    dlat, dlon = 0.006, 0.009
    x = df[["MMSI", "LON", "LAT", "t"]].copy()
    x["i"] = ((x.LON - w) / dlon).astype(int)
    x["j"] = ((x.LAT - s) / dlat).astype(int)
    x["slot"] = (x.t.astype("int64") // (600 * 10**9)).astype(int)
    x = x.drop_duplicates(["MMSI", "slot", "i", "j"])
    grp = V.cat.map({0: 0, 1: 1, 2: 1, 3: 2, 4: 3, 5: 3, 6: 3})
    x["g"] = x.MMSI.map(grp).fillna(3).astype(int)
    c = x.groupby(["i", "j", "g"]).size().unstack(fill_value=0).reindex(columns=range(4), fill_value=0)
    c["all"] = c.sum(axis=1)
    c = c[c["all"] >= 6]
    cells = [[int(i), int(j), int(r["all"]), int(r[0]), int(r[1]), int(r[2])] for (i, j), r in c.iterrows()]
    return {"generated": now_iso(), "source": NOAA, "days": df.attrs["days"], "origin": [w, s], "d": [dlon, dlat],
            "groups": ["Passenger & ferry", "Cargo & tanker", "Tug & tow", "Fishing, pleasure & other"], "cell": "[i, j, all, passenger, cargo+tanker, tug]; the rest is all minus those",
            "unit": "vessel-time in 10-minute slots over the week", "cells": cells}


def replay(df: pd.DataFrame, V: pd.DataFrame) -> dict:
    """One local day (a midweek day fully inside the window): each vessel's 5-minute positions, thinned so a vessel
    keeps a point only when it has moved ~40 m or an hour has passed. Coordinates are 1e-4° offsets from the bbox corner."""
    s, w, n, e = HOME_BBOX
    dates = sorted(df.t.dt.date.unique())
    full = [d for d in dates[1:-1]]
    day = next((d for d in full if d.weekday() == 2), full[len(full) // 2])  # a Wednesday if there is one
    x = df[df.t.dt.date == day][["MMSI", "LON", "LAT", "SOG", "t"]].copy()
    x["m"] = x.t.dt.hour * 60 + x.t.dt.minute
    x["slot"] = x.m // 10
    x = x.sort_values("t").groupby(["MMSI", "slot"]).tail(1).sort_values(["MMSI", "t"])
    ships = []
    for mmsi, g in x.groupby("MMSI"):
        pts, last = [], None
        rows = g[["slot", "LON", "LAT"]].to_numpy()
        for k, (slot, lon, lat) in enumerate(rows):
            t = int(slot) * 10
            keep = last is None or k == len(rows) - 1 or t - last[0] >= 180 \
                or math.hypot((lon - last[1]) * 0.66, lat - last[2]) >= 0.0008
            if keep:
                pts += [t, round((lon - w) * 1e4), round((lat - s) * 1e4)]
                last = (t, lon, lat)
        v = V.loc[mmsi]
        ships.append([v["name"], int(v["cat"]), None if pd.isna(v["len"]) else int(v["len"]), pts])
    return {"generated": now_iso(), "source": NOAA, "date": str(day), "weekday": DOW[day.weekday()], "origin": [w, s], "scale": 1e-4,
            "step_min": 10, "gap_min": 185, "cats": CATS, "cruise_m": CRUISE_M,
            "note": "Positions every 10 minutes at most; a vessel that hasn't moved keeps one point every 3 hours.", "ships": ships}


def types_map(V: pd.DataFrame) -> dict:
    known = V[V.cat != 6]
    return {"generated": now_iso(), "source": NOAA, "cats": CATS, "cruise_m": CRUISE_M,
            "t": {str(m): [int(r["cat"]), None if pd.isna(r["len"]) else int(r["len"])] for m, r in known.iterrows()}}


# ============================================================================= NAVWARNs
NS = {"S124": "http://www.iho.int/S124/gml/2.0", "S100": "http://www.iho.int/s100gml/5.0", "gml": "http://www.opengis.net/gml/3.2"}


def _txt(node, path) -> str | None:
    x = node.find(path, NS)
    if x is None or not x.text:
        return None
    # the published GML carries U+FFFD where the source had a degree sign or a non-breaking space
    t = re.sub(r"(\d)�", r"\1°", x.text).replace("�", " ")
    return re.sub(r"\s+", " ", t).strip()


def _coords(part) -> list[list[float]]:
    out = []
    for pos in part.iter("{http://www.opengis.net/gml/3.2}pos"):
        lat, lon = map(float, pos.text.split()[:2])
        out.append([round(lon, 5), round(lat, 5)])
    for pl in part.iter("{http://www.opengis.net/gml/3.2}posList"):
        v = list(map(float, pl.text.split()))
        out += [[round(v[i + 1], 5), round(v[i], 5)] for i in range(0, len(v) - 1, 2)]
    return out


def notices() -> dict | None:
    f = RAW / "s124.zip"
    if not f.exists():
        return None
    meta = json.loads((RAW / "s124.json").read_text(encoding="utf-8")) if (RAW / "s124.json").exists() else {}
    z = zipfile.ZipFile(f)
    s, w, n, e = HOME_BBOX
    out = []
    for name in z.namelist():
        if not re.search(r"124CA01P_\d+_\d+\.GML$", name, re.I):
            continue
        raw = z.read(name)
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("cp1252")
        root = ET.fromstring(text.encode("utf-8"))
        pre = root.find(".//S124:NavwarnPreamble", NS)
        if pre is None:
            continue
        parts = root.findall(".//S124:NavwarnPart", NS)
        coords = [c for p in parts for c in _coords(p)]
        info = [t for p in parts for t in [_txt(p, ".//S124:information/S124:text")] if t]
        details = [t for p in parts for t in [_txt(p, ".//S124:navwarnTypeDetails")] if t]
        aton = [t for p in parts for t in [_txt(p, ".//S124:atoNNumber")] if t]
        start = [t for p in parts for t in [_txt(p, ".//S124:dateStart/S100:date")] if t]
        end = [t for p in parts for t in [_txt(p, ".//S124:dateEnd/S100:date")] if t]
        num, yr = _txt(pre, ".//S124:warningNumber"), _txt(pre, ".//S124:year")
        lon = sum(c[0] for c in coords) / len(coords) if coords else None
        lat = sum(c[1] for c in coords) / len(coords) if coords else None
        out.append({
            "id": f"P{num}-{(yr or '')[-2:]}", "number": num, "year": yr,
            "title": _txt(pre, ".//S124:navwarnTitle/S124:text") or "Navigational warning",
            "kind": details[0] if details else _txt(pre, ".//S124:navwarnTypeGeneral") or "",
            "general": _txt(pre, ".//S124:navwarnTypeGeneral") or "",
            "area": _txt(pre, ".//S124:generalArea/S124:locationName/S124:text") or "",
            "chart": _txt(pre, ".//S124:chartAffected/S124:chartNumber"),
            "publication": _txt(pre, ".//S124:publicationAffected"),
            "aton": aton[:3], "text": " ".join(dict.fromkeys(info))[:600],
            "published": (_txt(pre, ".//S124:publicationTime") or "")[:16], "start": min(start) if start else None, "end": max(end) if end else None,
            "lon": None if lon is None else round(lon, 5), "lat": None if lat is None else round(lat, 5),
            "shape": "area" if any(p.find(".//S100:surfaceProperty", NS) is not None for p in parts) else "line" if any(p.find(".//S100:curveProperty", NS) is not None for p in parts) else "point",
            "home": lat is not None and s <= lat <= n and w <= lon <= e,
        })
    out.sort(key=lambda x: x["published"] or "", reverse=True)
    return {"generated": now_iso(), "source": "Canadian Coast Guard NAVWARNs, S-124 trial exchange set (not operational or official)",
            "page": S124_PAGE, "dataset_modified": meta.get("last_modified"), "count": len(out), "home_count": sum(x["home"] for x in out), "notices": out}


# ============================================================================= Fraser at Hope normals
def river() -> dict | None:
    f = RAW / "hope_daily.parquet"
    if not f.exists():
        return None
    d = pd.read_parquet(f)
    d["date"] = pd.to_datetime(d.date)
    d = d[~((d.date.dt.month == 2) & (d.date.dt.day == 29))]
    d["doy"] = d.date.dt.dayofyear - ((d.date.dt.is_leap_year) & (d.date.dt.month > 2)).astype(int)
    q = d.groupby("doy").q.quantile([0.1, 0.5, 0.9]).unstack()
    q = q.rolling(7, center=True, min_periods=1).mean()                     # smooth day-to-day noise in the normals
    peak = d.groupby(d.date.dt.year).apply(lambda g: g.loc[g.q.idxmax()], include_groups=False)
    return {"generated": now_iso(), "station": HOPE, "name": "Fraser River at Hope", "years": list(NORMAL_YEARS),
            "source": "Water Survey of Canada (ECCC) hydrometric data via MSC GeoMet, Open Government Licence – Canada",
            "normals": [[int(k), round(r[0.1]), round(r[0.5]), round(r[0.9])] for k, r in q.iterrows()],
            "peaks": {"median_doy": int(peak.doy.median()), "median_q": round(float(peak.q.median())), "max_q": round(float(peak.q.max())),
                      "max_year": int(peak.q.idxmax())}}


if __name__ == "__main__":
    df = load_ais()
    if df is None:
        print("  no cached AIS days (run `fetch ais`); keeping the published AIS files")
    else:
        print(f"  AIS: {len(df):,} positions, {df.MMSI.nunique():,} vessels, {df.attrs['days'][0]} to {df.attrs['days'][-1]}")
        V = vessel_table(df)
        write("typical.json", typical(df, V))
        write("lanes.json", lanes(df, V))
        write("replay.json", replay(df, V))
        write("types.json", types_map(V))
    for name, fn in (("notices.json", notices), ("river.json", river)):
        obj = fn()
        if obj is None:
            print(f"  {name}: inputs not cached; keeping the published file")
        else:
            write(name, obj)
