"""Daily snapshots for the Open Places "Climate & patterns" and "Hazards" tiles.

    python -m pipelines.climate.build            # everything
    python -m pipelines.climate.build enso tsunami   # just some parts

Writes site/public/data/climate/:
  enso.json     NOAA CPC: ONI + RONI history, ENSO Alert System status, official probabilities and RONI outlook
  outlook.json  seasonal temperature outlook by region: ECCC CanSIPS (Canada, via MSC GeoMet) and NOAA CPC (US)
  ocean.json    NE Pacific sea-surface temperature anomaly (NOAA OISST v2.1) and king-tide windows (NOAA CO-OPS)
  tsunami.json  the latest NTWC / PTWC messages (tsunami.gov Atom), with a rolling 120-day history built up run by run
  ao.json       NOAA CPC daily Arctic Oscillation index (last 120 days) and the GEFS ensemble's 15-day AO forecast
  nps.json      US national-park alerts (NPS API), only when NPS_API_KEY is set (the owner registers the key)

None of these sources send CORS headers usable from a github.io page except GeoMet and NOAA's map services, so the
browser reads these snapshots. Every source is public domain (NOAA, NPS) or Open Government Licence - Canada (ECCC).
Polite: one run is about 60 small requests, paced per host.
"""
from __future__ import annotations

import csv
import html
import io
import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "site" / "public" / "data" / "climate"
UA = "openplaces/0.1 (climate snapshots)"

_s = requests.Session()
_s.headers.update({"User-Agent": UA})
_last: dict[str, float] = {}


def get(url: str, params: dict | None = None, *, pace: float = 0.6, retries: int = 4, timeout: int = 60) -> requests.Response:
    host = url.split("/")[2]
    for k in range(retries):
        wait = _last.get(host, 0) + pace - time.time()
        if wait > 0:
            time.sleep(wait)
        _last[host] = time.time()
        try:
            r = _s.get(url, params=params, timeout=timeout)
            if r.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(f"{r.status_code} from {r.url}")
            r.raise_for_status()
            return r
        except requests.RequestException as e:
            if k == retries - 1:
                raise
            print(f"  retry {k + 1}: {e}")
            time.sleep(3 * 2 ** k)
    raise RuntimeError("unreachable")


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def write(name: str, obj) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    p = OUT / name
    p.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  wrote climate/{name} ({p.stat().st_size / 1024:,.1f} KB)")


def read(name: str):
    p = OUT / name
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def text_of(s: str) -> str:
    return html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s))).strip()


# ------------------------------------------------------------------ ENSO (NOAA CPC, public domain)
CPC = "https://www.cpc.ncep.noaa.gov"


def index_table(url: str, n: int = 48) -> list:
    """CPC's ONI / RONI ascii tables → [[season, year, anomaly]] (last n rows)."""
    rows = []
    for line in get(url).text.splitlines():
        p = line.split()
        if len(p) >= 3 and re.fullmatch(r"[A-Z]{3}", p[0]) and p[1].isdigit():
            rows.append([p[0], int(p[1]), float(p[-1])])
    return rows[-n:]


def table_rows(page: str, table_id: str) -> list[list[str]]:
    m = re.search(rf'<table id="{table_id}".*?</table>', page, re.S)
    if not m:
        return []
    out = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", m.group(0), re.S):
        cells = re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", tr, re.S)
        # the season cell holds "<abbr>NDJ <span …>Nov Dec Jan</span></abbr>": keep the code
        vals = [text_of(re.sub(r"<span.*?</span>", "", c, flags=re.S)) for c in cells]
        if vals and re.fullmatch(r"[A-Z]{3}", vals[0]):
            out.append(vals)
    return out


def enso() -> None:
    print("ENSO (NOAA CPC)")
    oni = index_table(f"{CPC}/data/indices/oni.ascii.txt")
    roni = index_table(f"{CPC}/data/indices/RONI.ascii.txt")
    disc = get(f"{CPC}/products/analysis_monitoring/enso_advisory/ensodisc.shtml").text
    t = text_of(disc)
    status = re.search(r"ENSO Alert System Status:\s*(.+?)\s+Synopsis:", t)
    synopsis = re.search(r"Synopsis:\s*(.+?)(?:\s{2,}|\. )", t)
    issued = re.search(r"issued by CLIMATE PREDICTION CENTER/NCEP/NWS\s+(\d{1,2} \w+ \d{4})", t)
    nxt = re.search(r"next ENSO Diagnostics? Discussion is scheduled for\s+(\d{1,2} \w+ \d{4})", t)
    probs_page = get(f"{CPC}/products/analysis_monitoring/enso/roni/probabilities/").text
    probs = [[r[0], int(r[1]), int(r[2]), int(r[3])] for r in table_rows(probs_page, "probabilities-table") if len(r) >= 4]
    # the RONI outlook table: season, 5/15/25/50/75/85/95th percentiles (its id has varied, so match on the caption too)
    out_page = get(f"{CPC}/products/analysis_monitoring/enso/roni/outlook/").text
    otab = []
    m = re.search(r"ENSO Outlook\s*Season\s*5%(.*?)Back to top", text_of(out_page), re.S)
    if m:
        for mm in re.finditer(r"([A-Z]{3}) [A-Z][a-z]{2} [A-Z][a-z]{2} [A-Z][a-z]{2} ((?:-?\d+(?:\.\d+)? ?){7})", m.group(1)):
            otab.append([mm.group(1), *[float(v) for v in mm.group(2).split()]])
    d = lambda s: datetime.strptime(s, "%d %B %Y").date().isoformat() if s else None
    write("enso.json", {
        "generated": now_iso(),
        "status": status.group(1).strip() if status else None,
        "synopsis": (synopsis.group(1).strip() + ".") if synopsis else None,
        "issued": d(issued.group(1)) if issued else None,
        "next": d(nxt.group(1)) if nxt else None,
        "oni": oni, "roni": roni,
        "probs": probs,                       # [season, La Niña %, Neutral %, El Niño %]
        "outlook": otab,                      # [season, p5, p15, p25, p50, p75, p85, p95] RONI °C
        "source": "NOAA Climate Prediction Center: ENSO diagnostic discussion, ONI and RONI tables, official ENSO probabilities and RONI outlook (public domain)",
        "links": {"discussion": f"{CPC}/products/analysis_monitoring/enso_advisory/ensodisc.shtml",
                  "probabilities": f"{CPC}/products/analysis_monitoring/enso/roni/probabilities/"},
    })


# ------------------------------------------------------------------ seasonal outlook
GEOMET = "https://geo.weather.gc.ca/geomet"
CA_REGIONS = [  # id, short label, name, (lon, lat)
    ("bc", "BC", "BC coast", (-123.37, 48.43)), ("bci", "BC int.", "BC interior", (-120.33, 50.67)),
    ("ab", "AB", "Alberta", (-114.07, 51.05)), ("pr", "SK/MB", "Prairies", (-104.6, 50.45)),
    ("on", "ON", "Ontario", (-79.38, 43.65)), ("qc", "QC", "Quebec", (-73.57, 45.5)), ("at", "Atl.", "Atlantic", (-63.57, 44.65)),
]
US_REGIONS = [
    ("pnw", "PNW", "Pacific Northwest", (-122.33, 47.61)), ("ca", "CA", "California", (-121.49, 38.58)),
    ("sw", "SW", "Southwest", (-112.07, 33.45)), ("nv", "NV", "Great Basin", (-115.14, 36.17)),
    ("pl", "Plains", "Plains", (-94.58, 39.1)), ("ne", "NE", "Northeast", (-74.0, 40.71)),
]
SEASONS = ["DJF", "JFM", "FMA", "MAM", "AMJ", "MJJ", "JJA", "JAS", "ASO", "SON", "OND", "NDJ"]
MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def season_label(start_month: int) -> str:  # 12 → "Dec–Feb"
    return f"{MON[start_month - 1]}–{MON[(start_month + 1) % 12]}"


def cansips_point(layer: str, lon: float, lat: float) -> tuple[float | None, str | None]:
    j = get(GEOMET, {"service": "WMS", "version": "1.3.0", "request": "GetFeatureInfo", "layers": layer, "query_layers": layer,
                     "crs": "EPSG:4326", "bbox": f"{lat - 0.5},{lon - 0.5},{lat + 0.5},{lon + 0.5}", "width": 10, "height": 10,
                     "i": 5, "j": 5, "info_format": "application/json"}, pace=0.4).json()
    f = (j.get("features") or [None])[0]
    if not f:
        return None, None
    return f["properties"].get("value"), f["properties"].get("dim_reference_time")


def outlook() -> None:
    print("Seasonal outlook (ECCC CanSIPS via GeoMet; NOAA CPC map service)")
    ca, ref = [], None
    for rid, short, name, (lon, lat) in CA_REGIONS:
        v = {}
        for k in ("Below", "Near", "Above"):
            val, ref = cansips_point(f"CanSIPS_100km_AirTemp-Prob{k}Normal-2m_P01M-P03M", lon, lat)
            v[k.lower()] = None if val is None else round(val)
        ca.append({"id": rid, "label": short, "title": name, "ll": [lon, lat], **v})
    # P01M-P03M = months 1–3 after the run month: the Nov 1 run covers Dec–Feb
    ref_d = datetime.fromisoformat(ref.replace("Z", "+00:00")) if ref else datetime.now(timezone.utc)
    start = ref_d.month % 12 + 1
    # NOAA CPC: polygons per lead; pick the lead whose season starts with the same month
    want = SEASONS[start % 12]
    svc = "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/cpc_sea_temp_outlk/MapServer"
    lead, fdate, us = None, None, []
    for lid in range(4):
        j = get(f"{svc}/{lid}/query", {"where": "1=1", "outFields": "valid_seas,fcst_date", "returnGeometry": "false", "resultRecordCount": 1, "f": "json"}, pace=0.4).json()
        seas = (j.get("features") or [{}])[0].get("attributes", {}).get("valid_seas", "")
        if seas.startswith(want):
            lead, fdate = lid, (j["features"][0]["attributes"]["fcst_date"]); break
    if lead is not None:
        for rid, short, name, (lon, lat) in US_REGIONS:
            j = get(f"{svc}/{lead}/query", {"geometry": f"{lon},{lat}", "geometryType": "esriGeometryPoint", "inSR": 4326,
                                             "spatialRel": "esriSpatialRelIntersects", "outFields": "prob,cat,valid_seas", "returnGeometry": "false", "f": "json"}, pace=0.4).json()
            a = (j.get("features") or [{}])[0].get("attributes") if j.get("features") else None
            # CPC shows only the favoured tercile; near-normal stays at 33.3% unless it is the favoured one (CPC convention)
            cat, p = (a or {}).get("cat"), (a or {}).get("prob")
            if not a or cat in (None, "EC") or not p:
                b, n, ab = 33, 34, 33
            elif cat == "Above":
                ab, n = round(p), 33; b = 100 - ab - n
            elif cat == "Below":
                b, n = round(p), 33; ab = 100 - b - n
            else:
                n = round(p); b = ab = round((100 - n) / 2)
            us.append({"id": rid, "label": short, "title": name, "ll": [lon, lat], "below": max(0, b), "near": n, "above": max(0, ab), "cat": cat or "EC"})
    write("outlook.json", {
        "generated": now_iso(),
        "ca": {"ref": ref, "season": SEASONS[start % 12], "label": season_label(start), "regions": ca,
               "source": "ECCC CanSIPS seasonal forecast, probability of below / near / above-normal temperature, months 1–3 (MSC GeoMet, Open Government Licence – Canada)"},
        "us": {"issued": datetime.fromtimestamp(fdate / 1000, timezone.utc).date().isoformat() if fdate else None, "season": want, "label": season_label(start), "regions": us,
               "source": "NOAA CPC seasonal temperature outlook (NWS map service, public domain). CPC shows only the favoured category; the rest is split by CPC's convention."},
    })


# ------------------------------------------------------------------ ocean: NE Pacific SST anomaly + king tides
ERDDAP = "https://coastwatch.pfeg.noaa.gov/erddap/griddap"
BOX = {"lat": (40, 56), "lon": (-160, -124)}          # NE Pacific, where "the Blob" sat in 2014–16 and 2019
COAST = {"lat": (46, 51), "lon": (-130, -123.5)}      # BC / Washington shelf


def sst_series(ds: str, box: dict, stride: int, weeks: int) -> list:
    q = (f"anom[last-{7 * weeks}:7:last][(0.0)][({box['lat'][0]}):{stride}:({box['lat'][1]})]"
         f"[({box['lon'][0]}):{stride}:({box['lon'][1]})]")
    txt = get(f"{ERDDAP}/{ds}.csv?{requests.utils.quote(q, safe='():,')}", pace=1.5, timeout=120).text
    by: dict[str, list[float]] = {}
    for r in list(csv.reader(io.StringIO(txt)))[2:]:
        if len(r) >= 5 and r[4] not in ("NaN", ""):
            by.setdefault(r[0][:10], []).append(float(r[4]))
    return [{"t": t, "mean": round(sum(v) / len(v), 2), "f15": round(sum(1 for a in v if a >= 1.5) / len(v), 2),
             "f10": round(sum(1 for a in v if a >= 1.0) / len(v), 2), "n": len(v)} for t, v in sorted(by.items())]


TIDE_STATIONS = {  # province → NOAA CO-OPS station (public domain); king tides are the year's highest predicted highs
    "bc": ("9444090", "Port Angeles, WA", "across Juan de Fuca Strait from Victoria"),
    "wa": ("9447130", "Seattle, WA", "Elliott Bay"),
    "cal": ("9414290", "San Francisco, CA", "Golden Gate"),
}


def king_tides(station: str) -> dict:
    begin = date.today()
    j = get("https://api.tidesandcurrents.noaa.gov/api/prod/datagetter", {
        "product": "predictions", "station": station, "begin_date": begin.strftime("%Y%m%d"), "range": 24 * 366,
        "datum": "MLLW", "interval": "hilo", "units": "metric", "time_zone": "gmt", "format": "json", "application": "openplaces"}, pace=1.0).json()
    highs: dict[str, tuple[float, str]] = {}
    for p in j.get("predictions", []):
        if p.get("type") != "H":
            continue
        d, v = p["t"][:10], float(p["v"])
        if d not in highs or v > highs[d][0]:
            highs[d] = (v, p["t"].replace(" ", "T") + "Z")
    days = sorted(highs.items())
    vals = sorted(v for _, (v, _) in days)
    thr = vals[int(0.95 * (len(vals) - 1))] if vals else None    # top 5% of the year's daily highest highs
    wins, cur = [], None
    for d, (v, t) in days:
        if thr is not None and v >= thr:
            if cur and (date.fromisoformat(d) - date.fromisoformat(cur["end"])).days <= 1:
                cur["end"] = d
                if v > cur["peak_m"]:
                    cur.update(peak_m=v, peak_t=t)
            else:
                cur = {"start": d, "end": d, "peak_m": v, "peak_t": t}; wins.append(cur)
    return {"threshold_m": thr, "datum": "MLLW", "windows": wins,
            "daily": [[d, v] for d, (v, _) in days[:60]]}            # next 60 days' highest high, for a chart


def ocean() -> None:
    print("Ocean (NOAA OISST via ERDDAP; NOAA CO-OPS tide predictions)")
    out = {"generated": now_iso()}
    sst = None
    for ds in ("ncdcOisst21NrtAgg_LonPM180", "ncdcOisst21Agg_LonPM180"):   # preliminary (≈2 days old), then final (≈2 weeks)
        try:
            sst = {"dataset": ds, "box": BOX, "series": sst_series(ds, BOX, 8, 12), "coast": sst_series(ds, COAST, 4, 12)}
            break
        except Exception as e:  # noqa: BLE001 - try the other dataset
            print(f"  {ds}: {e}")
    if sst:
        sst["source"] = "NOAA NCEI OISST v2.1 daily SST anomaly vs 1991–2020 (via NOAA CoastWatch ERDDAP, public domain), weekly samples"
    out["sst"] = sst
    out["tides"] = {}
    for prov, (sid, name, note) in TIDE_STATIONS.items():
        try:
            out["tides"][prov] = {"station": sid, "name": name, "note": note, **king_tides(sid),
                                  "source": f"NOAA CO-OPS tide predictions, station {sid} {name} (public domain)"}
        except Exception as e:  # noqa: BLE001
            print(f"  tides {sid}: {e}")
    write("ocean.json", out)


# ------------------------------------------------------------------ tsunami messages (tsunami.gov Atom, public domain)
TSU_FEEDS = {"NTWC": "https://www.tsunami.gov/events/xml/PAAQAtom.xml",     # National Tsunami Warning Center (Palmer): covers BC, US west coast, Alaska
             "PTWC": "https://www.tsunami.gov/events/xml/PHEBAtom.xml"}     # Pacific Tsunami Warning Center (Hawaii)
A = "{http://www.w3.org/2005/Atom}"
GEO = "{http://www.w3.org/2003/01/geo/wgs84_pos#}"


def parse_atom(center: str, xml: str) -> list[dict]:
    root = ET.fromstring(xml)
    out = []
    for e in root.findall(f"{A}entry"):
        summ = ET.tostring(e.find(f"{A}summary"), encoding="unicode", method="html") if e.find(f"{A}summary") is not None else ""
        st = text_of(summ)
        cat = re.search(r"Category:\s*(\w+)", st)
        mag = re.search(r"Preliminary Magnitude:\s*([\d.]+)", st)
        note = re.search(r"Note:\s*\*?\s*(.+?)(?:Definition:|$)", st)
        link = next((l.get("href") for l in e.findall(f"{A}link") if l.get("rel") == "alternate"), None)
        lat, lon = e.findtext(f"{GEO}lat"), e.findtext(f"{GEO}long")
        out.append({"id": e.findtext(f"{A}id"), "center": center, "title": (e.findtext(f"{A}title") or "").strip(),
                    "updated": e.findtext(f"{A}updated"), "category": cat.group(1) if cat else None,
                    "mag": float(mag.group(1)) if mag else None, "lat": float(lat) if lat else None, "lon": float(lon) if lon else None,
                    "note": note.group(1).strip().rstrip(".") + "." if note and not note.group(1).startswith("Definition") else None, "link": link,
                    "bulletin": (root.findtext(f"{A}title") or "").strip()})
    return out


def tsunami() -> None:
    print("Tsunami messages (tsunami.gov Atom)")
    prev = read("tsunami.json") or {}
    latest = []
    for c, url in TSU_FEEDS.items():
        try:
            latest += parse_atom(c, get(url, pace=1.0).text)
        except Exception as e:  # noqa: BLE001
            print(f"  {c}: {e}")
    cut = (datetime.now(timezone.utc) - timedelta(days=120)).isoformat()
    hist = {h["id"]: h for h in prev.get("history", []) if h.get("updated", "") >= cut[:19]}
    for x in latest:
        hist[x["id"]] = x
    write("tsunami.json", {"generated": now_iso(), "latest": latest,
                           "history": sorted(hist.values(), key=lambda h: h.get("updated") or "", reverse=True),
                           "source": "NOAA National Tsunami Warning Center and Pacific Tsunami Warning Center Atom feeds, tsunami.gov (public domain)",
                           "note": "Each feed holds only its latest event; the history builds up one daily run at a time."})


# ------------------------------------------------------------------ US national-park alerts (needs the owner's free NPS key)
NPS_PARKS = {  # Open Places region → NPS park codes near it
    "seattle": ["olym", "mora", "noca", "sajh", "klse", "ebla"],
    "sfbay": ["goga", "muwo", "pore", "jomu", "rori"], "sacramento": ["whis", "lavo"],
    "la": ["samo", "chis", "jotr"], "sandiego": ["cabr", "jotr"], "lasvegas": ["lake", "deva"],
    "phoenix": ["tont", "moca", "cagr"], "tucson": ["sagu", "orpi", "chir"],
}


def nps() -> None:
    key = os.environ.get("NPS_API_KEY")
    if not key:
        print("NPS alerts: skipped (set NPS_API_KEY: a free key from https://www.nps.gov/subjects/developer/get-started.htm)")
        if not (read("nps.json") or {}).get("alerts"):      # a stub, so the page knows to show PLANNED (and doesn't 404)
            write("nps.json", {"generated": now_iso(), "needs_key": True, "regions": NPS_PARKS, "parks": {}, "alerts": []})
        return
    print("NPS alerts")
    codes = sorted({c for v in NPS_PARKS.values() for c in v})
    parks = {p["parkCode"]: p for p in get("https://developer.nps.gov/api/v1/parks", {"parkCode": ",".join(codes), "limit": 100, "api_key": key}).json().get("data", [])}
    alerts = get("https://developer.nps.gov/api/v1/alerts", {"parkCode": ",".join(codes), "limit": 500, "api_key": key}).json().get("data", [])
    write("nps.json", {"generated": now_iso(), "regions": NPS_PARKS,
                       "parks": {c: {"name": p.get("fullName"), "ll": [float(p["longitude"]), float(p["latitude"])] if p.get("latitude") else None, "url": p.get("url")} for c, p in parks.items()},
                       "alerts": [{"park": a.get("parkCode"), "title": a.get("title"), "category": a.get("category"), "url": a.get("url"),
                                   "updated": a.get("lastIndexedDate"), "body": (a.get("description") or "")[:280]} for a in alerts],
                       "source": "National Park Service alerts API (public domain)"})


# ------------------------------------------------------------------ Arctic Oscillation (NOAA CPC, public domain)
# Daily AO index (CDAS reanalysis, 1000 hPa) and the GEFS ensemble's 15-day forecast of it, for the Weather Patterns
# leaf's polar-vortex / Arctic-outflow card. CPC's ftp server sends no CORS headers, so the browser reads this snapshot.
AO_OBS = "https://ftp.cpc.ncep.noaa.gov/cwlinks/norm.daily.ao.cdas.z1000.19500101_current.csv"
AO_GEFS = "https://ftp.cpc.ncep.noaa.gov/cwlinks/norm.daily.ao.gefs.z1000.120days.csv"


def ao() -> None:
    print("Arctic Oscillation (NOAA CPC)")
    obs = []
    for row in csv.reader(io.StringIO(get(AO_OBS, timeout=120).text)):
        try:
            obs.append([date(int(row[0]), int(row[1]), int(row[2])).isoformat(), round(float(row[3]), 3)])
        except (ValueError, IndexError):
            continue
    obs = obs[-120:]
    # forecast file: lead, member, init time, AO, valid time. Keep the newest initialisation, then mean / range per day
    rows = list(csv.DictReader(io.StringIO(get(AO_GEFS, timeout=120).text)))
    init = max((r["time"] for r in rows if r.get("time")), default=None)   # the "time" column is the run's start date
    by: dict[str, list[float]] = {}
    for r in rows:
        if r.get("time") == init and r.get("ao_index") and r.get("valid_time"):
            by.setdefault(r["valid_time"], []).append(float(r["ao_index"]))
    fc = [[t, round(sum(v) / len(v), 3), round(min(v), 3), round(max(v), 3), len(v)] for t, v in sorted(by.items())]
    write("ao.json", {
        "generated": now_iso(), "init": init,
        "obs": obs,                            # [date, AO] last 120 days
        "fc": fc,                              # [valid date, ensemble mean, min, max, members] from the newest GEFS run
        "source": "NOAA Climate Prediction Center: daily Arctic Oscillation index (CDAS) and GEFS forecast (public domain)",
        "links": {"page": "https://www.cpc.ncep.noaa.gov/products/precip/CWlink/daily_ao_index/ao.shtml"},
    })


PARTS = {"enso": enso, "outlook": outlook, "ocean": ocean, "tsunami": tsunami, "nps": nps, "ao": ao}

if __name__ == "__main__":
    want = sys.argv[1:] or list(PARTS)
    bad = 0
    for k in want:
        try:
            PARTS[k]()
        except Exception as e:  # noqa: BLE001 - one flaky source keeps the others' fresh data
            bad += 1
            print(f"  {k} failed: {e}")
    sys.exit(1 if bad == len(want) else 0)
