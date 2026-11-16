"""Download inputs for the Langford Boom Tracker.

  python -m pipelines.langford.fetch daily          # permits, population, census, tracker (cheap; skips unchanged files)
  python -m pipelines.langford.fetch all            # daily + orthos (service metadata and cached hotspot thumbnails)
  python -m pipelines.langford.fetch tracker ...    # any list of sources

Each source runs on its own: a failure is logged to data/langford/raw/status.json (and as a GitHub Actions
::warning::) and the others still run, keeping their last good files. Re-running is idempotent: catalogue files are
only downloaded when their `last_modified` changes, ortho thumbnails are downloaded once, and the tracker is a full
snapshot (≈500 rows) that replaces the previous one only after it parses.

Licensing: `permits` and `population` are OGL-BC, `census` is OGL-C. `tracker` and `orthos` come from the City of
Langford with no stated licence: local use only (see config.py).
"""
from __future__ import annotations

import io
import json
import math
import os
import re
import sys
import time
import traceback
from datetime import datetime, timezone

import pandas as pd
import requests

from pipelines.common.http import USER_AGENT, get_json

from .config import (ARCGIS_INTERVAL, BPER_PACKAGE, BPER_RESOURCES, CENSUS_CHARS, CENSUS_SDMX, CKAN, CRD_PREFIX, GEOS,
                     HOTSPOTS, ORTHOS_FOLDER, POP_PACKAGE, POP_RESOURCE, RAW, THUMB_HALF_M, THUMB_PX, TRACKER, TRACKER_DROP)

S = requests.Session()
S.headers["User-Agent"] = USER_AGENT
_last: dict[str, float] = {}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="minutes")


def get_bytes(url: str, params: dict | None = None, *, min_interval: float = 1.0, retries: int = 4, timeout: int = 120) -> requests.Response:
    """GET with per-host pacing and retries (for CSV and image downloads; JSON goes through common.http.get_json)."""
    host = url.split("/")[2]
    for attempt in range(retries):
        wait = _last.get(host, 0) + min_interval - time.time()
        if wait > 0:
            time.sleep(wait)
        _last[host] = time.time()
        try:
            r = S.get(url, params=params, timeout=timeout)
            if r.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(f"{r.status_code} from {url}")
            r.raise_for_status()
            return r
        except requests.RequestException as exc:
            if attempt == retries - 1 or (isinstance(exc, requests.HTTPError) and exc.response is not None
                                          and 400 <= exc.response.status_code < 500 and exc.response.status_code != 429):
                raise
            backoff = 2 ** attempt * 3
            print(f"  retry {attempt + 1} after {backoff}s: {exc}")
            time.sleep(backoff)
    raise RuntimeError("unreachable")


def load_meta() -> dict:
    f = RAW / "catalogue_meta.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}


def save_meta(meta: dict) -> None:
    (RAW / "catalogue_meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")


def catalogue_resources(package: str) -> list[dict]:
    return get_json(CKAN, {"id": package}, min_interval=1.0)["result"]["resources"]


def find_resource(resources: list[dict], prefix: str) -> dict:
    hits = [r for r in resources if (r.get("name") or "").strip().lower().startswith(prefix.lower())
            and (r.get("format") or "").lower() == "csv"]
    if not hits:
        raise RuntimeError(f"catalogue resource not found: {prefix!r}")
    return hits[0]


# ============================================================================= BC Stats building permits (OGL-BC)

MONTH_RE = re.compile(r"^[A-Z][a-z]{2} \d{4}$")


def parse_bper(text: str, series: str) -> pd.DataFrame:
    """BC Stats wide CSV → long rows (sgc, name, month, series, value). 'x' (suppressed) becomes NaN."""
    raw = pd.read_csv(io.StringIO(text), header=None, dtype=str, keep_default_na=False)
    hdr = next(i for i in range(min(10, len(raw))) if raw.iloc[i].str.match(MONTH_RE).sum() > 12)
    cols = raw.iloc[hdr].tolist()
    mcols = [j for j, c in enumerate(cols) if MONTH_RE.match(c or "")]
    body = raw.iloc[hdr + 1:]
    body = body[body[0].str.fullmatch(r"\d{1,7}")]                  # data rows start with an SGC code
    if body.empty:
        raise RuntimeError(f"{series}: no data rows found")
    rows = []
    for _, r in body.iterrows():
        for j in mcols:
            v = r[j].replace(",", "").strip()
            rows.append((r[0], r[1].strip(), cols[j], series, float(v) if re.fullmatch(r"-?\d+(\.\d+)?", v) else float("nan")))
    df = pd.DataFrame(rows, columns=["sgc", "name", "month", "series", "value"])
    df["month"] = pd.to_datetime(df.month, format="%b %Y")
    return df


def permits() -> dict:
    """Nine monthly CSVs (values in $000, units). Each is re-downloaded only when the catalogue's last_modified changes."""
    RAW.mkdir(parents=True, exist_ok=True)
    (RAW / "bper").mkdir(exist_ok=True)
    meta = load_meta()
    res = catalogue_resources(BPER_PACKAGE)
    changed = 0
    for key, prefix in BPER_RESOURCES.items():
        r = find_resource(res, prefix)
        stamp = r.get("last_modified") or r.get("metadata_modified")
        f = RAW / "bper" / f"{key}.csv"
        if f.exists() and meta.get(f"bper:{key}") == stamp:
            continue
        text = get_bytes(r["url"], min_interval=1.0).content.decode("utf-8-sig", errors="replace")
        parse_bper(text, key)                                         # validate before replacing the cached copy
        f.write_text(text, encoding="utf-8")
        meta[f"bper:{key}"] = stamp
        changed += 1
        print(f"  {key}: downloaded ({stamp})")
    save_meta(meta)
    df = pd.concat([parse_bper((RAW / "bper" / f"{k}.csv").read_text(encoding="utf-8"), k) for k in BPER_RESOURCES], ignore_index=True)
    note = re.search(r"Building Permits \(BPER\), ([A-Z][a-z]+ \d{4})", (RAW / "bper" / "value_total.csv").read_text(encoding="utf-8"))
    df.to_parquet(RAW / "bper.parquet", index=False)
    lf = df[(df.sgc == GEOS["langford"][1]) & df.value.notna()]
    newest = lf.month.max()
    print(f"  permits: {changed} file(s) updated, {df.sgc.nunique()} geographies, {df.month.min():%b %Y} – {newest:%b %Y}"
          + (f" (release {note.group(1)})" if note else ""))
    return {"newest": newest.strftime("%Y-%m"), "release": note.group(1) if note else None, "updated_files": changed}


# ============================================================================= BC Stats population (OGL-BC)

def population() -> dict:
    """Municipal July-1 estimates and projections (totals only). The 9 MB CSV is fetched only when it changes."""
    RAW.mkdir(parents=True, exist_ok=True)
    meta = load_meta()
    r = find_resource(catalogue_resources(POP_PACKAGE), POP_RESOURCE)
    stamp = r.get("last_modified") or r.get("metadata_modified")
    out = RAW / "population.parquet"
    if not (out.exists() and meta.get("population") == stamp):
        text = get_bytes(r["url"], min_interval=1.0, timeout=300).content.decode("utf-8-sig", errors="replace")
        df = pd.read_csv(io.StringIO(text), usecols=["Region", "Region.Name", "Region.Type", "Year", "Type", "Gender", "Total"])
        df = df[(df.Gender == "T") & ((df.Region == 0) | (df.Region // 1000 == 17))]       # BC + Capital RD municipalities
        df = df.rename(columns={"Region": "region", "Region.Name": "name", "Year": "year", "Type": "kind", "Total": "pop"})
        df = df[["region", "name", "year", "kind", "pop"]]
        if len(df) < 100 or 17044 not in set(df.region):
            raise RuntimeError("population CSV: Langford rows missing (format changed?)")
        df.to_parquet(out, index=False)
        meta["population"] = stamp
        save_meta(meta)
        print(f"  population: downloaded ({stamp})")
    df = pd.read_parquet(out)
    est = df[df.kind == "Estimate"]
    print(f"  population: {df.region.nunique()} regions, estimates {est.year.min()}–{est.year.max()}, projections to {df.year.max()}")
    return {"newest": str(int(est.year.max()))}


# ============================================================================= StatCan 2021 census (OGL-C)

def census() -> dict:
    """2021 census profile (population 2021 and 2016, dwellings, land area) for every CRD CSD, the CRD and BC.
    The census doesn't change, so this is skipped once cached (delete raw/census.parquet to refresh)."""
    out = RAW / "census.parquet"
    if out.exists():
        df = pd.read_parquet(out)
        return {"newest": "2021", "skipped": "cached", "n": int(df.geo.nunique())}
    codes = set()
    if (RAW / "bper.parquet").exists():
        b = pd.read_parquet(RAW / "bper.parquet", columns=["sgc"])
        codes = {c for c in b.sgc.unique() if c.startswith(CRD_PREFIX) and len(c) == 7}
    codes |= {v[1] for v in GEOS.values() if len(v[1]) == 7}
    frames = []
    for flow, geos in (("DF_CSD", [f"2021A0005{c}" for c in sorted(codes)]), ("DF_CD", ["2021A00035917"]), ("DF_PR", ["2021A000259"])):
        try:
            url = CENSUS_SDMX.format(flow=flow, geos="+".join(geos))
            text = get_bytes(url, {"format": "csv"}, min_interval=1.0).text
            frames.append(pd.read_csv(io.StringIO(text), usecols=["REF_AREA", "CHARACTERISTIC", "OBS_VALUE"]))
        except Exception as exc:                                    # BC total is optional
            if flow != "DF_PR":
                raise
            print(f"  census: province flow unavailable ({exc})")
    df = pd.concat(frames, ignore_index=True)
    df["geo"] = df.REF_AREA.str[9:]                                 # 2021A0005|5917044 → 5917044; 2021A0003|5917 → 5917
    df["field"] = df.CHARACTERISTIC.map(CENSUS_CHARS)
    df = df.dropna(subset=["field"]).pivot_table(index="geo", columns="field", values="OBS_VALUE", aggfunc="first").reset_index()
    if "5917044" not in set(df.geo):
        raise RuntimeError("census: Langford missing from the response")
    df.to_parquet(out, index=False)
    lf = df[df.geo == "5917044"].iloc[0]
    print(f"  census: {len(df)} geographies; Langford {lf['pop_2016']:,.0f} → {lf['pop_2021']:,.0f} ({lf['pct_change']:+.1f}%)")
    return {"newest": "2021", "n": int(len(df))}


# ============================================================================= Langford Development Tracker (UNLICENSED)

def arcgis_query_all(layer: str, params: dict, page: int = 1000) -> list[dict]:
    """Page through an ArcGIS FeatureServer layer with resultOffset until exceededTransferLimit is false."""
    feats, offset = [], 0
    while True:
        d = get_json(f"{layer}/query", {**params, "f": "json", "resultOffset": offset, "resultRecordCount": page,
                                        "orderByFields": "OBJECTID"}, min_interval=ARCGIS_INTERVAL)
        if "error" in d:
            raise RuntimeError(f"ArcGIS error: {d['error']}")
        batch = d.get("features", [])
        feats += batch
        if not batch or not d.get("exceededTransferLimit"):
            break
        offset += len(batch)
    return feats


def tracker() -> dict:
    """Full snapshot of the City's development applications (≈500 rows: one or two pages). UNLICENSED source.
    Parcel IDs and roll numbers are dropped before anything is written. Each snapshot's status is also appended to
    tracker_history.parquet (one row per permit per status change) so stage timings can be refined over time."""
    expected = get_json(f"{TRACKER}/query", {"where": "1=1", "returnCountOnly": "true", "f": "json"}, min_interval=ARCGIS_INTERVAL).get("count")
    feats = arcgis_query_all(TRACKER, {"where": "1=1", "outFields": "*", "outSR": 4326, "returnGeometry": "true"})
    if not feats:
        raise RuntimeError("tracker: no features returned")
    rows = []
    for f in feats:
        a = {k: v for k, v in f["attributes"].items() if k not in TRACKER_DROP}
        g = f.get("geometry") or {}
        a["lon"], a["lat"] = g.get("x"), g.get("y")
        rows.append(a)
    df = pd.DataFrame(rows).drop_duplicates("OBJECTID")
    if expected and len(df) < expected:
        raise RuntimeError(f"tracker: got {len(df)} of {expected} features (paging incomplete)")
    for c in ("StatusChanged", "Entered", "Issued", "FinalledORClosed"):
        df[c] = pd.to_datetime(df[c].replace("", None), errors="coerce")
    df["LastUpdated"] = pd.to_datetime(df.LastUpdated, unit="ms", utc=True, errors="coerce")
    df["TotalValuation"] = pd.to_numeric(df.TotalValuation, errors="coerce")
    df["fetched"] = now_iso()
    RAW.mkdir(parents=True, exist_ok=True)
    df.to_parquet(RAW / "tracker.parquet", index=False)
    # status history: keep the first time each (permit, status, status date) was seen
    hist_f = RAW / "tracker_history.parquet"
    snap = df[["PermitNumber", "Type", "Status", "StatusChanged", "fetched"]].rename(columns={"fetched": "seen"})
    if hist_f.exists():
        old = pd.read_parquet(hist_f)
        snap = pd.concat([old, snap], ignore_index=True).drop_duplicates(["PermitNumber", "Status", "StatusChanged"], keep="first")
    snap.to_parquet(hist_f, index=False)
    newest = max(df.Entered.max(), df.StatusChanged.max())
    print(f"  tracker: {len(df)} applications, entered {df.Entered.min():%Y-%m-%d} – {df.Entered.max():%Y-%m-%d}, "
          f"newest status change {df.StatusChanged.max():%Y-%m-%d}, city timestamp {df.LastUpdated.max():%Y-%m-%d}")
    return {"newest": newest.strftime("%Y-%m-%d"), "n": int(len(df))}


# ============================================================================= ORTHOS aerial photos (UNLICENSED)

def _merc(lon: float, lat: float) -> tuple[float, float]:
    return lon * 20037508.34 / 180, math.log(math.tan((90 + lat) * math.pi / 360)) * 6378137.0


def orthos() -> dict:
    """Service metadata for every ORTHOS MapServer (years parsed from names: `2025_Orthos`, `Orthos_2026`) plus one
    small export image per hotspot and year, downloaded once and cached (historic orthos don't change). The
    thumbnails are only used to measure vegetation loss; they're never copied to the site. UNLICENSED source."""
    folder = get_json(ORTHOS_FOLDER, {"f": "json"}, min_interval=ARCGIS_INTERVAL)
    services = []
    for s in folder.get("services", []):
        m = re.search(r"(19|20)\d{2}", s["name"])
        if s.get("type") != "MapServer" or not m:
            continue
        url = f"{ORTHOS_FOLDER.rsplit('/ORTHOS', 1)[0]}/{s['name']}/MapServer"
        try:
            d = get_json(url, {"f": "json"}, min_interval=ARCGIS_INTERVAL)
        except Exception as exc:
            services.append({"year": int(m.group(0)), "name": s["name"], "url": url, "ok": False, "error": str(exc)[:200]})
            continue
        ti, fe = d.get("tileInfo") or {}, d.get("fullExtent") or {}
        layers = d.get("layers") or []
        # the mosaic group also holds Boundary/Footprint outlines: export the raster sublayer only
        try:
            ld = get_json(f"{url}/layers", {"f": "json"}, min_interval=ARCGIS_INTERVAL).get("layers", [])
            raster = next((l["id"] for l in ld if l.get("type") == "Raster Layer"), None)
        except Exception:
            raster = None
        services.append({
            "year": int(m.group(0)), "name": s["name"], "url": url, "ok": "error" not in d,
            "image_layer": layers[0]["name"] if layers else None,          # e.g. Orthos_April_2021: carries the month
            "raster_layer": raster,
            "wkid": (d.get("spatialReference") or {}).get("latestWkid"),
            "cached": bool(d.get("singleFusedMapCache")),
            "tile_origin": ti.get("origin"), "tile_size": ti.get("rows"), "tile_format": ti.get("format"),
            "lods": [{"level": l["level"], "resolution": l["resolution"], "scale": l["scale"]} for l in ti.get("lods", [])],
            "extent": {k: fe.get(k) for k in ("xmin", "ymin", "xmax", "ymax")}, "extent_wkid": (fe.get("spatialReference") or {}).get("latestWkid"),
            "max_image": [d.get("maxImageWidth"), d.get("maxImageHeight")],
            "copyright": d.get("copyrightText") or "", "description": d.get("serviceDescription") or "",
        })
    if not services:
        raise RuntimeError("orthos: no year services found in the ORTHOS folder")
    services.sort(key=lambda s: s["year"])
    RAW.mkdir(parents=True, exist_ok=True)
    (RAW / "orthos_services.json").write_text(json.dumps({"fetched": now_iso(), "services": services}, indent=1), encoding="utf-8")
    # hotspot thumbnails (Web Mercator export; the server reprojects from UTM 10N)
    tdir = RAW / "thumbs"
    tdir.mkdir(exist_ok=True)
    got = 0
    for h in HOTSPOTS:
        x, y = _merc(h["lon"], h["lat"])
        half = THUMB_HALF_M / math.cos(math.radians(h["lat"]))       # metres on the ground → mercator units
        for s in services:
            f = tdir / f"{h['id']}_{s['year']}.jpg"
            if f.exists() or not s.get("ok"):
                continue
            r = get_bytes(f"{s['url']}/export", {"bbox": f"{x - half},{y - half},{x + half},{y + half}", "bboxSR": 3857, "imageSR": 3857,
                                                 "size": f"{THUMB_PX},{THUMB_PX}", "format": "jpg", "f": "image", "layers": f"show:{s.get('raster_layer') if s.get('raster_layer') is not None else 0}"},
                          min_interval=ARCGIS_INTERVAL)
            if not r.headers.get("content-type", "").startswith("image"):
                raise RuntimeError(f"orthos: {s['name']} export returned {r.headers.get('content-type')}: {r.text[:200]}")
            f.write_bytes(r.content)
            got += 1
    print(f"  orthos: {len(services)} services ({services[0]['year']}–{services[-1]['year']}, "
          f"{sum(s['ok'] for s in services)} ok), {got} new thumbnails")
    return {"newest": str(services[-1]["year"]), "n": len(services)}


# ============================================================================= CLI

SOURCES = {"permits": permits, "population": population, "census": census, "tracker": tracker, "orthos": orthos}
GROUPS = {"daily": ["permits", "population", "census", "tracker"], "all": list(SOURCES)}


def record(name: str, ok: bool, info: dict | None = None, error: str | None = None) -> None:
    f = RAW / "status.json"
    RAW.mkdir(parents=True, exist_ok=True)
    st = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
    prev = st.get(name, {})
    entry = {"ok": ok, "attempted": now_iso(), "last_ok": now_iso() if ok else prev.get("last_ok"),
             "newest": (info or {}).get("newest") or (prev.get("newest") if not ok else None), "error": error}
    for k in ("skipped", "release"):
        if info and info.get(k):
            entry[k] = info[k]
    st[name] = entry
    f.write_text(json.dumps(st, indent=1), encoding="utf-8")


def main(argv: list[str]) -> int:
    for stream in (sys.stdout, sys.stderr):                 # Windows consoles: never die on a non-ASCII log line
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    names = []
    for a in argv or ["daily"]:
        names += GROUPS.get(a, [a])
    failed = []
    for name in names:
        if name not in SOURCES:
            print(f"unknown source {name!r}; choose from {', '.join(SOURCES)} or {', '.join(GROUPS)}")
            return 2
        print(f"{name}…", flush=True)
        try:
            info = SOURCES[name]() or {}
            record(name, True, info)
        except Exception as exc:                              # keep going: one source must not block the rest
            msg = f"{type(exc).__name__}: {exc}"[:400]
            traceback.print_exc()
            record(name, False, error=msg)
            failed.append(name)
            if os.environ.get("GITHUB_ACTIONS"):
                print(f"::warning title=Langford source failed: {name}::{msg}", flush=True)
    if failed:
        print(f"finished with {len(failed)} failed source(s): {', '.join(failed)} (their last good data is kept)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
