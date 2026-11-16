"""Fetch and trim live ADS-B (adsb.lol, fallback adsb.fi) and aviation weather (NOAA AWC). Shared by fetch and collect.

Trimming keeps only what the page needs and drops identities aircraft owners asked to limit: aircraft flagged in the
aggregator's database as FAA LADD (Limiting Aircraft Data Displayed) or PIA (Privacy ICAO Address) are kept as
anonymous positions (no callsign, no hex). Registrations and registered owners are never kept.
"""
from __future__ import annotations

import time

import requests

from pipelines.common.http import USER_AGENT

from .config import ADSB_FI, ADSB_LOL, ADSBLOL_API_KEY, AWC_METAR, AWC_TAF

S = requests.Session()
S.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})

FIELDS = ["ts", "hex", "flight", "type", "cat", "lat", "lon", "alt", "gs", "track", "vr", "mil", "emerg"]


def trim(a: dict, ts: int) -> dict | None:
    if a.get("lat") is None or a.get("lon") is None:
        return None
    cat, kind = str(a.get("category") or ""), str(a.get("type") or "")
    if cat.startswith("C") or kind.endswith("_nt") or (a.get("alt_baro") == "ground" and not a.get("t") and not cat.startswith("A")):
        return None                                     # ground vehicles and beacons, never aircraft
    flags = int(a.get("dbFlags") or 0)
    private = bool(flags & 8 or flags & 4)          # LADD or PIA
    alt = a.get("alt_baro")
    ground = alt == "ground"
    vr = a.get("baro_rate", a.get("geom_rate"))
    emerg = a.get("emergency")
    return {
        "ts": ts,
        "hex": "" if private else str(a.get("hex", "")).lower().lstrip("~"),
        "flight": "" if private else str(a.get("flight") or "").strip(),
        "type": str(a.get("t") or ""),
        "cat": str(a.get("category") or ""),
        "lat": round(float(a["lat"]), 4), "lon": round(float(a["lon"]), 4),
        "alt": 0 if ground else (int(alt) if isinstance(alt, (int, float)) else None),
        "gs": round(float(a["gs"])) if a.get("gs") is not None else None,
        "track": round(float(t)) if (t := a.get("track", a.get("true_heading", a.get("mag_heading")))) is not None else None,
        "vr": int(vr) if isinstance(vr, (int, float)) else None,
        "mil": 1 if flags & 1 else 0,
        "emerg": emerg if emerg and emerg != "none" else "",
    }


def point(lat: float, lon: float, r_nm: int, timeout: int = 20) -> tuple[list[dict], str, int]:
    """Aircraft within r_nm of a point: (rows, source, epoch seconds). adsb.lol first, adsb.fi if it fails."""
    errors = []
    for name, tpl, hdr in (("adsb.lol", ADSB_LOL, {"x-api-key": ADSBLOL_API_KEY} if ADSBLOL_API_KEY else {}), ("adsb.fi", ADSB_FI, {})):
        try:
            r = S.get(tpl.format(lat=lat, lon=lon, r=r_nm), timeout=timeout, headers=hdr)
            if r.status_code == 429:
                raise requests.HTTPError("429 rate limited")
            r.raise_for_status()
            j = r.json()
            now = j.get("now") or time.time() * 1000
            ts = int(now / 1000) if now > 1e11 else int(now)
            rows = [x for x in (trim(a, ts) for a in (j.get("ac") or j.get("aircraft") or [])) if x]
            return rows, name, ts
        except (requests.RequestException, ValueError) as exc:
            errors.append(f"{name}: {exc}")
    raise RuntimeError("; ".join(errors))


def metar_taf(ids: list[str]) -> dict:
    """Latest METAR and TAF per station from the Aviation Weather Center Data API."""
    q = {"ids": ",".join(ids), "format": "json"}
    m = S.get(AWC_METAR, params=q, timeout=30); m.raise_for_status()
    t = S.get(AWC_TAF, params=q, timeout=30); t.raise_for_status()
    keep_m = ["icaoId", "name", "lat", "lon", "elev", "obsTime", "reportTime", "rawOb", "temp", "dewp", "wdir", "wspd", "wgst",
              "visib", "altim", "wxString", "clouds", "fltCat"]
    keep_t = ["icaoId", "name", "issueTime", "validTimeFrom", "validTimeTo", "rawTAF", "fcsts"]
    metar = {x["icaoId"]: {k: x.get(k) for k in keep_m} for x in (m.json() or [])}
    taf = {}
    for x in t.json() or []:
        x = {k: x.get(k) for k in keep_t}
        x["fcsts"] = [{k: f.get(k) for k in ("timeFrom", "timeTo", "fcstChange", "probability", "wdir", "wspd", "wgst", "visib", "wxString", "clouds")}
                      for f in (x.get("fcsts") or [])]
        taf[x["icaoId"]] = x
    return {"metar": metar, "taf": taf, "fetched": int(time.time())}
