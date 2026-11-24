"""Build Air Traffic's published JSON from OurAirports and the latest METAR/TAF.

  python -m pipelines.air.build

Writes site/public/data/air/:
  air.json        home, the aerodrome watch zones (YYJ and the harbour: arriving / departing / low, from live aircraft),
                  the latest METAR / TAF (the page's copy until the relay's live weather answers), credits
  airports.json   aerodromes within LOCAL_RADIUS_KM of home, with runways (ends, headings, lengths) and frequencies
  runways.json    runway centrelines of every medium and large airport (for maps)
  world.json      every large and medium airport in OurAirports (compact rows), for "any place" on the page

Live aircraft are not logged: pages read them through the relay.
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from .config import AERODROMES, CREDIT, HOME, LOCAL_RADIUS_KM, OUT, RAW, TZ


def km(lat1, lon1, lat2, lon2):
    r = math.pi / 180
    a = np.sin((lat2 - lat1) * r / 2) ** 2 + np.cos(lat1 * r) * np.cos(lat2 * r) * np.sin((lon2 - lon1) * r / 2) ** 2
    return 12742 * np.arcsin(np.sqrt(a))


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


# ------------------------------------------------------------------ main
def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    ap, rw, fq = load_ourairports()
    aero = local_airports(ap, rw, fq)
    (OUT / "airports.json").write_text(json.dumps({"home": HOME, "radius_km": LOCAL_RADIUS_KM, "airports": aero,
                                                   "credit": CREDIT["ourairports"]}, separators=(",", ":")), encoding="utf-8")
    (OUT / "runways.json").write_text(json.dumps(world_runways(ap, rw) | {"credit": CREDIT["ourairports"]}, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    (OUT / "world.json").write_text(json.dumps(world_airports(ap, rw) | {"credit": CREDIT["ourairports"]}, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")

    metar = json.loads((RAW / "metar.json").read_text(encoding="utf-8")) if (RAW / "metar.json").exists() else None
    if metar is None and (OUT / "air.json").exists():   # no fresh weather: keep the published copy
        metar = json.loads((OUT / "air.json").read_text(encoding="utf-8")).get("weather")
    body = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "home": HOME | {"tz": TZ},
        "aerodromes": {k: v | {"lat": next((a["lat"] for a in aero if a["icao"] == k), None), "lon": next((a["lon"] for a in aero if a["icao"] == k), None)} for k, v in AERODROMES.items()},
        "weather": metar or {"metar": {}, "taf": {}},
        "credit": CREDIT,
    }
    (OUT / "air.json").write_text(json.dumps(body, separators=(",", ":"), default=clean), encoding="utf-8")
    print(f"air.json: {len(body['weather'].get('metar', {}))} METARs; airports.json: {len(aero)} aerodromes; "
          f"world.json: {len(ap[ap.type.isin(['large_airport', 'medium_airport'])])} airports")


if __name__ == "__main__":
    main()
