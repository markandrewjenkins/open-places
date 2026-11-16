"""Build Air Traffic's published JSON from the aircraft log, the latest METAR/TAF and OurAirports.

  python -m pipelines.air.build

Writes site/public/data/air/:
  air.json        coverage of the log, the latest logged snapshot, busy hours, movements at YYJ and the harbour,
                  the type mix, METAR / TAF, sources and credits
  airports.json   aerodromes within LOCAL_RADIUS_KM of home, with runways (ends, headings, lengths) and frequencies
  world.json      every large and medium airport in OurAirports (compact rows), for "any place" on the page

The raw log (data/air/raw/log, git-ignored) is summarised per local hour and per day into data/air/derived/*.csv,
which are committed: hours recomputed from raw logs replace their stored rows, older hours are kept. So the daily
workflow, which has only its own snapshots, never loses what an always-on collector logged.
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from . import logio
from .config import AERODROMES, CREDIT, DERIVED, HOME, LOCAL_RADIUS_KM, OUT, RAW, TZ

FLOAT_TYPES = {"DHC2", "DH2T", "DHC3", "DH3T", "DHC6"}   # Beavers, Otters and Twin Otters: the local floatplane fleet types
GAP_S = 600                                   # a track continues across poll gaps up to 10 minutes
POLL_GAP_S = 180                              # coverage: polls further apart than this leave the time between unwatched
HOURLY_COLS = ["date", "hour", "polls", "sum_n", "max_n", "unique", "sum_low"] + [f"{k}_{m}" for k in AERODROMES for m in ("arr", "dep")]
DAILY_COLS = ["date", "polls", "unique", "peak", "watched_h"] + [f"{k}_{m}" for k in AERODROMES for m in ("arr", "dep")]


def km(lat1, lon1, lat2, lon2):
    r = math.pi / 180
    a = np.sin((lat2 - lat1) * r / 2) ** 2 + np.cos(lat1 * r) * np.cos(lat2 * r) * np.sin((lon2 - lon1) * r / 2) ** 2
    return 12742 * np.arcsin(np.sqrt(a))


def iso(ts) -> str | None:
    if ts is None or (isinstance(ts, float) and math.isnan(ts)):
        return None
    return pd.Timestamp(int(ts), unit="s", tz="UTC").tz_convert(TZ).isoformat(timespec="seconds")


def clean(v):
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return None if np.isnan(v) else round(float(v), 4)
    if isinstance(v, float) and math.isnan(v):
        return None
    return v


# ------------------------------------------------------------------ OurAirports
def load_ourairports():
    d = RAW / "ourairports"
    ap = pd.read_csv(d / "airports.csv", keep_default_na=False, na_values={"elevation_ft": [""], "latitude_deg": [""], "longitude_deg": [""]}, low_memory=False)
    rw = pd.read_csv(d / "runways.csv", keep_default_na=False, low_memory=False)
    fq = pd.read_csv(d / "airport-frequencies.csv", keep_default_na=False, low_memory=False)
    return ap, rw, fq


def num(v):
    try:
        f = float(v)
        return None if math.isnan(f) else f
    except (TypeError, ValueError):
        return None


def local_airports(ap, rw, fq) -> list[dict]:
    ap = ap[ap.type != "closed"].copy()
    ap["km"] = km(HOME["lat"], HOME["lon"], ap.latitude_deg.astype(float), ap.longitude_deg.astype(float))
    near = ap[ap.km <= LOCAL_RADIUS_KM].sort_values("km")
    out = []
    for a in near.itertuples():
        runways = []
        for r in rw[(rw.airport_ref == a.id) & (rw.closed.astype(str) != "1")].itertuples():
            runways.append({k: clean(v) for k, v in {
                "le": r.le_ident, "he": r.he_ident, "length_ft": num(r.length_ft), "width_ft": num(r.width_ft), "surface": r.surface,
                "lighted": str(r.lighted) == "1", "le_lat": num(r.le_latitude_deg), "le_lon": num(r.le_longitude_deg),
                "he_lat": num(r.he_latitude_deg), "he_lon": num(r.he_longitude_deg), "le_hdg": num(r.le_heading_degT)}.items()})
        freqs = [{"type": f.type, "desc": f.description, "mhz": num(f.frequency_mhz)} for f in fq[fq.airport_ref == a.id].itertuples()]
        out.append({k: clean(v) for k, v in {
            "ident": a.ident, "icao": a.icao_code or (a.gps_code if len(str(a.gps_code)) == 4 else ""), "iata": a.iata_code, "name": a.name,
            "type": a.type, "lat": a.latitude_deg, "lon": a.longitude_deg, "elev_ft": a.elevation_ft, "municipality": a.municipality,
            "scheduled": a.scheduled_service == "yes", "km": round(a.km, 1)}.items()} | {"runways": runways, "freqs": freqs})
    return out


def world_airports(ap, rw) -> dict:
    big = ap[ap.type.isin(["large_airport", "medium_airport"])].copy()
    longest = rw.assign(L=pd.to_numeric(rw.length_ft, errors="coerce")).groupby("airport_ref").L.max()
    n_rw = rw[rw.closed.astype(str) != "1"].groupby("airport_ref").size()
    rows = []
    for a in big.itertuples():
        rows.append([a.ident, a.iata_code, a.name, round(float(a.latitude_deg), 4), round(float(a.longitude_deg), 4),
                     "L" if a.type == "large_airport" else "M", a.municipality, a.iso_country, 1 if a.scheduled_service == "yes" else 0,
                     int(n_rw.get(a.id, 0)), int(longest.get(a.id)) if pd.notna(longest.get(a.id)) else None,
                     int(a.elevation_ft) if pd.notna(a.elevation_ft) else None])
    return {"fields": ["ident", "iata", "name", "lat", "lon", "size", "municipality", "country", "scheduled", "runways", "longest_ft", "elev_ft"],
            "rows": rows}


def world_runways(ap, rw) -> dict:
    """Runway centrelines of every medium and large airport, for drawing airports in range on any map (lazy-loaded)."""
    big = ap[ap.type.isin(["large_airport", "medium_airport"])].set_index("id").ident
    r = rw[(rw.closed.astype(str) != "1") & rw.airport_ref.isin(big.index)]
    out: dict[str, list] = {}
    for x in r.itertuples():
        e = [num(x.le_latitude_deg), num(x.le_longitude_deg), num(x.he_latitude_deg), num(x.he_longitude_deg)]
        if any(v is None for v in e):
            continue
        out.setdefault(big[x.airport_ref], []).append([round(v, 4) for v in e] + [num(x.width_ft) or 100, f"{x.le_ident}/{x.he_ident}"])
    return {"fields": ["le_lat", "le_lon", "he_lat", "he_lon", "width_ft", "name"], "airports": out}


# ------------------------------------------------------------------ the log
def movements(pos: pd.DataFrame, aero: list[dict]) -> pd.DataFrame:
    """Arrivals and departures inferred from low tracks near each aerodrome (see README: method in brief)."""
    out = []
    ref = {a["icao"] or a["ident"]: a for a in aero}
    p = pos[pos.hex != ""].sort_values(["hex", "ts"])
    for icao, cfg in AERODROMES.items():
        a = ref.get(icao)
        if not a:
            continue
        p = p.assign(d=km(a["lat"], a["lon"], p.lat.values, p.lon.values))
        for hx, g in p.groupby("hex", sort=False):
            g = g.reset_index(drop=True)
            alt = g.alt.fillna(99999).values
            inside = (g.d.values <= cfg["zone_km"]) & (alt <= cfg["ceiling_ft"])
            if not inside.any():
                continue
            ts = g.ts.values
            i = 0
            while i < len(g):
                if not inside[i]:
                    i += 1
                    continue
                j = i
                while j + 1 < len(g) and inside[j + 1] and ts[j + 1] - ts[j] <= GAP_S:
                    j += 1
                prev = i - 1 if i > 0 and ts[i] - ts[i - 1] <= GAP_S else None
                nxt = j + 1 if j + 1 < len(g) and ts[j + 1] - ts[j] <= GAP_S else None
                seg_alt = alt[i:j + 1]
                lo = seg_alt.min()
                start_ground, end_ground = seg_alt[0] == 0, seg_alt[-1] == 0
                vr = g.vr.iloc[i:j + 1].dropna()
                if start_ground and end_ground and lo == 0 and (seg_alt == 0).all():
                    kind = None                                     # taxiing or parked
                elif end_ground or (prev is not None and nxt is None and alt[prev] > lo):
                    kind = "arr"
                elif start_ground or (prev is None and nxt is not None and alt[nxt] > lo):
                    kind = "dep"
                elif prev is None and nxt is None:
                    kind = "arr" if len(vr) and vr.mean() < -200 else "dep" if len(vr) and vr.mean() > 200 else "arr" if seg_alt[-1] < seg_alt[0] else "dep" if seg_alt[-1] > seg_alt[0] else None
                else:
                    kind = "low"                                    # low pass, circuit or touch-and-go
                if kind:
                    k = i if kind == "dep" else j
                    out.append({"ts": int(ts[k]), "aero": icao, "kind": kind, "hex": hx, "flight": g.flight.iloc[k], "type": g.type.iloc[k],
                                "cat": g.cat.iloc[k], "alt": int(lo) if lo < 99999 else None})
                i = j + 1
    return pd.DataFrame(out, columns=["ts", "aero", "kind", "hex", "flight", "type", "cat", "alt"])


def summarise(pos: pd.DataFrame, polls: pd.DataFrame, mv: pd.DataFrame):
    ok = polls[polls.ok.astype(str) == "1"].copy()
    ok["ts"] = ok.ts.astype(int)
    if ok.empty:
        return pd.DataFrame(columns=HOURLY_COLS), pd.DataFrame(columns=DAILY_COLS)
    air = pos[pos.alt.fillna(1) > 0]                                   # airborne (unknown altitude counts as airborne)
    per = air.groupby("ts").size()
    low = air[air.alt.fillna(99999) < 10000].groupby("ts").size()
    ok["n"] = ok.ts.map(per).fillna(0).astype(int)
    ok["low"] = ok.ts.map(low).fillna(0).astype(int)
    lt = pd.to_datetime(ok.ts, unit="s", utc=True).dt.tz_convert(TZ)
    ok["date"], ok["hour"] = lt.dt.strftime("%Y-%m-%d"), lt.dt.hour
    ok = ok.sort_values("ts")
    gap = ok.ts.diff().shift(-1).fillna(60).clip(upper=POLL_GAP_S)
    ok["watched"] = np.where(ok.ts.diff().shift(-1).fillna(60) <= POLL_GAP_S, gap, 60) / 3600
    pl = pos.copy()
    plt_ = pd.to_datetime(pl.ts, unit="s", utc=True).dt.tz_convert(TZ)
    pl["date"], pl["hour"] = plt_.dt.strftime("%Y-%m-%d"), plt_.dt.hour
    pl["key"] = np.where(pl.hex != "", pl.hex, "anon-" + pl.ts.astype(str) + pl.lat.astype(str))
    pl = pl[pl.alt.fillna(1) > 0]
    hourly = ok.groupby(["date", "hour"]).agg(polls=("ts", "size"), sum_n=("n", "sum"), max_n=("n", "max"), sum_low=("low", "sum")).reset_index()
    uh = pl.groupby(["date", "hour"]).key.nunique().rename("unique").reset_index()
    hourly = hourly.merge(uh, on=["date", "hour"], how="left").fillna({"unique": 0})
    daily = ok.groupby("date").agg(polls=("ts", "size"), peak=("n", "max"), watched_h=("watched", "sum")).reset_index()
    ud = pl.groupby("date").key.nunique().rename("unique").reset_index()
    daily = daily.merge(ud, on="date", how="left").fillna({"unique": 0})
    if len(mv):
        m = mv.copy()
        mt = pd.to_datetime(m.ts, unit="s", utc=True).dt.tz_convert(TZ)
        m["date"], m["hour"] = mt.dt.strftime("%Y-%m-%d"), mt.dt.hour
    for k in AERODROMES:
        for kind in ("arr", "dep"):
            col = f"{k}_{kind}"
            if len(mv):
                sel = m[(m.aero == k) & (m.kind == kind)]
                hourly = hourly.merge(sel.groupby(["date", "hour"]).size().rename(col).reset_index(), on=["date", "hour"], how="left")
                daily = daily.merge(sel.groupby("date").size().rename(col).reset_index(), on="date", how="left")
            hourly[col] = hourly.get(col, 0)
            daily[col] = daily.get(col, 0)
    hourly = hourly.fillna(0)[HOURLY_COLS]
    daily = daily.fillna(0)[DAILY_COLS]
    return hourly, daily


def merge_store(fresh: pd.DataFrame, name: str, keys: list[str], cols: list[str]) -> pd.DataFrame:
    f = DERIVED / name
    if f.exists():
        old = pd.read_csv(f, dtype={"date": str})
        if len(fresh):
            k_new = set(map(tuple, fresh[keys].astype(str).values))
            old = old[[tuple(map(str, r)) not in k_new for r in old[keys].values]]
        fresh = pd.concat([old, fresh], ignore_index=True)
    fresh = fresh[cols].sort_values(keys).reset_index(drop=True)
    DERIVED.mkdir(parents=True, exist_ok=True)
    fresh.to_csv(f, index=False, lineterminator="\n")
    return fresh


# ------------------------------------------------------------------ main
def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    ap, rw, fq = load_ourairports()
    aero = local_airports(ap, rw, fq)
    (OUT / "airports.json").write_text(json.dumps({"home": HOME, "radius_km": LOCAL_RADIUS_KM, "airports": aero,
                                                   "credit": CREDIT["ourairports"]}, separators=(",", ":")), encoding="utf-8")
    (OUT / "runways.json").write_text(json.dumps(world_runways(ap, rw) | {"credit": CREDIT["ourairports"]}, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    (OUT / "world.json").write_text(json.dumps(world_airports(ap, rw) | {"credit": CREDIT["ourairports"]}, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")

    pos, polls = logio.read_positions(), logio.read_polls()
    if not len(polls) and (OUT / "air.json").exists():
        # no log on this machine (the daily workflow): keep the committed summaries, refresh only weather and status
        body = json.loads((OUT / "air.json").read_text(encoding="utf-8"))
        if (RAW / "metar.json").exists():
            body["weather"] = json.loads((RAW / "metar.json").read_text(encoding="utf-8"))
        if (RAW / "status.json").exists():
            body["coverage"]["status"] = json.loads((RAW / "status.json").read_text(encoding="utf-8"))
        body["generated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        (OUT / "air.json").write_text(json.dumps(body, separators=(",", ":"), default=clean), encoding="utf-8")
        print("air.json: no log here, kept the committed summaries and refreshed weather")
        return
    for c in ("ts", "lat", "lon", "alt", "gs", "track", "vr"):
        pos[c] = pd.to_numeric(pos[c], errors="coerce")
    pos = pos.dropna(subset=["ts"])
    pos["ts"] = pos.ts.astype(int)
    pos = pos.drop_duplicates(subset=["ts", "hex", "lat", "lon"])
    for c in ("hex", "flight", "type", "cat"):
        pos[c] = pos[c].astype(str).replace("nan", "")
    polls["ts"] = pd.to_numeric(polls.ts, errors="coerce")
    polls = polls.dropna(subset=["ts"]).drop_duplicates(subset=["ts"])
    mv = movements(pos, aero) if len(pos) else pd.DataFrame(columns=["ts", "aero", "kind", "hex", "flight", "type", "cat", "alt"])
    hourly_new, daily_new = summarise(pos, polls, mv)
    hourly = merge_store(hourly_new, "hourly.csv", ["date", "hour"], HOURLY_COLS)
    daily = merge_store(daily_new, "daily.csv", ["date"], DAILY_COLS)
    mv_store = DERIVED / "movements.csv"
    if mv_store.exists():
        mv = pd.concat([pd.read_csv(mv_store, keep_default_na=False), mv], ignore_index=True)
    mv = mv.drop_duplicates(subset=["ts", "aero", "hex"]).sort_values("ts")
    mv = mv[mv.ts >= mv.ts.max() - 60 * 86400] if len(mv) else mv          # keep two months of individual movements
    mv.to_csv(mv_store, index=False, lineterminator="\n")

    # busy hours: mean airborne aircraft in the circle per (weekday, hour), with the polls behind each cell
    hourly["dow"] = pd.to_datetime(hourly.date).dt.dayofweek
    how = hourly.groupby(["dow", "hour"]).agg(polls=("polls", "sum"), sum_n=("sum_n", "sum"), unique=("unique", "mean"), hours=("polls", "size")).reset_index()
    by_hour = hourly.groupby("hour").agg(polls=("polls", "sum"), sum_n=("sum_n", "sum"), sum_low=("sum_low", "sum"), unique=("unique", "mean"), hours=("polls", "size")).reset_index()
    ok_polls = polls[polls.ok.astype(str) == "1"]
    last_ts = int(ok_polls.ts.max()) if len(ok_polls) else None
    latest = pos[pos.ts == last_ts] if last_ts else pos.iloc[0:0]
    seen = pos[pos.alt.fillna(1) > 0]
    types = seen[seen.hex != ""].drop_duplicates("hex").groupby("type").size().sort_values(ascending=False)
    cats = seen[seen.hex != ""].drop_duplicates("hex").groupby("cat").size()
    metar = json.loads((RAW / "metar.json").read_text(encoding="utf-8")) if (RAW / "metar.json").exists() else {"metar": {}, "taf": {}}
    status = json.loads((RAW / "status.json").read_text(encoding="utf-8")) if (RAW / "status.json").exists() else {}
    src_counts = ok_polls.source.value_counts().to_dict() if len(ok_polls) else {}

    body = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "home": HOME | {"tz": TZ},
        "aerodromes": {k: v | {"lat": next((a["lat"] for a in aero if a["icao"] == k), None), "lon": next((a["lon"] for a in aero if a["icao"] == k), None)} for k, v in AERODROMES.items()},
        "coverage": {
            "polls": int(len(polls)), "polls_ok": int(len(ok_polls)), "first": iso(polls.ts.min()) if len(polls) else (daily.date.min() if len(daily) else None),
            "last": iso(last_ts), "days": int(len(daily)), "watched_h": round(float(daily.watched_h.sum()), 1) if len(daily) else 0,
            "hours_logged": int(len(hourly)), "sources": src_counts,
            "by_day": [{"date": r.date, "hours": round(float(r.watched_h), 2), "polls": int(r.polls), "unique": int(r.unique), "peak": int(r.peak),
                        **{f"{k}_{m}": int(getattr(r, f"{k}_{m}")) for k in AERODROMES for m in ("arr", "dep")}} for r in daily.itertuples()],
            "status": status,
        },
        "latest": {"as_of": iso(last_ts), "epoch": last_ts, "aircraft": [{k: clean(v) for k, v in r.items() if k != "ts"} for r in latest.to_dict("records")]},
        "busy": {
            "how": [[int(r.dow), int(r.hour), round(r.sum_n / r.polls, 2) if r.polls else None, int(r.polls), round(float(r.unique), 1), int(r.hours)] for r in how.itertuples()],
            "by_hour": [[int(r.hour), round(r.sum_n / r.polls, 2) if r.polls else None, round(r.sum_low / r.polls, 2) if r.polls else None, int(r.polls), round(float(r.unique), 1), int(r.hours)] for r in by_hour.itertuples()],
            "fields_how": ["dow (0=Mon)", "hour", "mean airborne", "polls", "mean unique per hour", "hours logged"],
            "fields_by_hour": ["hour", "mean airborne", "mean below 10,000 ft", "polls", "mean unique per hour", "hours logged"],
        },
        "types": [[t or "?", int(n)] for t, n in types.head(16).items()],
        "categories": {c or "?": int(n) for c, n in cats.items()},
        "movements": {
            "recent": [{"ts": iso(r.ts), "aero": r.aero, "kind": r.kind, "flight": r.flight, "type": r.type, "cat": r.cat,
                        "float": r.type in FLOAT_TYPES} for r in mv.tail(60).iloc[::-1].itertuples()],
            "n": {k: {kind: int(((mv.aero == k) & (mv.kind == kind)).sum()) for kind in ("arr", "dep", "low")} for k in AERODROMES},
            "float_types": sorted(FLOAT_TYPES),
        },
        "weather": metar,
        "credit": CREDIT,
    }
    (OUT / "air.json").write_text(json.dumps(body, separators=(",", ":"), default=clean), encoding="utf-8")
    print(f"air.json: {len(polls)} polls, {len(pos)} positions, {len(mv)} movements, {len(daily)} days; "
          f"airports.json: {len(aero)} aerodromes; world.json: {len(ap[ap.type.isin(['large_airport', 'medium_airport'])])} airports")


if __name__ == "__main__":
    main()
