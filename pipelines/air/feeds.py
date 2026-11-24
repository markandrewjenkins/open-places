"""Fetch aviation weather (NOAA Aviation Weather Center METAR and TAF) for the Air Traffic page's daily copy.

Live aircraft are not fetched here: the browser reads them through the relay (workers/bct-relay/src/air.js, hub.js).
"""
from __future__ import annotations

import time

import requests

from pipelines.common.http import USER_AGENT

from .config import AWC_METAR, AWC_TAF

S = requests.Session()
S.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})

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
