"""Snapshot of the local civic feeds for Open Places (Greater Victoria).

  python -m pipelines.local.build

Writes site/public/data/local/local.json. The Open Places page reads these live where it can (the City of Langford's
WordPress REST API is CORS-open; meetings and police news come through the relay's /local/ routes, see
workers/bct-relay/src/local.js). This file is the fallback until the relay is redeployed, and the only source of the
annual Crime Severity Index chart.

Sources, headline + date + link only (no release text, images or marks):
  * City of Langford news (WordPress REST, langford.ca) and council/committee calendar (eSCRIBE public portal).
    Terms: langford.ca/disclaimer, copy "in unaltered form only"; no open licence, so headlines and links only.
  * Police news releases: West Shore, Sooke and Sidney North Saanich RCMP newsrooms (rcmp.ca: non-commercial
    reproduction with attribution), Victoria Police (Ghost RSS), Saanich Police and Oak Bay Police (WordPress REST);
    each (c) its agency, headlines and links only. Names of missing people, suspects, accused and victims are taken out
    of the headlines by the same function the relay and the page use (site/src/shared/redact-names.js, run here through
    node: pipelines/local/redact_names.mjs). Without node the police section is not written (fails closed).
  * BC RCMP provincial newsroom (rcmp.ca/en/bc/news): only releases datelined in a CRD municipality and not already in
    a local detachment's list (e.g. BC Highway Patrol, IHIT, Island District), same terms as the other RCMP newsrooms.
  * Statistics Canada table 35-10-0063-01, Crime severity index by police service in BC (annual), Statistics Canada
    Open Licence.

Release scan (Public Safety for Langford): each release from the last 45 days is read once (cached by link in
data/local/raw/police_scan.json, one request every 2 s per host) to note which CRD municipalities its text names
(`mentions`) and, for West Shore RCMP releases and releases naming Langford, one place the text names precisely enough
to map (`loc`): an intersection or a hundred-block (BC Address Geocoder, OGL-BC; intersection, block or address matches
in the expected municipality only) or an official lake, river, park or mountain within 12 km of Langford (BC
Geographical Names, OGL-BC). None of the release text is kept; a release with no such place gets no `loc`.
"""
from __future__ import annotations

import html
import json
import re
import shutil
import subprocess
import time
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import requests

from pipelines.common.http import USER_AGENT

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "site" / "public" / "data" / "local"
S = requests.Session()
S.headers["User-Agent"] = USER_AGENT

ESCRIBE = "https://pub-langford.escribemeetings.com"
LANGFORD_WP = "https://langford.ca/wp-json/wp/v2"
# id, name, detachment location [lon, lat], kind, url  (same list as AGENCIES in workers/bct-relay/src/local.js)
AGENCIES = [
    ("westshore", "West Shore RCMP", [-123.5, 48.452], "rcmp", "https://rcmp.ca/en/bc/west-shore/news"),
    ("sooke", "Sooke RCMP", [-123.728, 48.376], "rcmp", "https://rcmp.ca/en/bc/sooke/news"),
    ("sidney", "Sidney North Saanich RCMP", [-123.401, 48.65], "rcmp", "https://rcmp.ca/en/bc/sidney-north-saanich/news"),
    ("vicpd", "Victoria Police", [-123.362, 48.43], "rss", "https://engagement.vicpd.ca/tag/news-releases/rss/"),
    ("saanich", "Saanich Police", [-123.375, 48.468], "wp", "https://saanichpolice.ca/wp-json/wp/v2/posts?per_page=12&_fields=id,date,link,title"),
    ("oakbay", "Oak Bay Police", [-123.316, 48.427], "wp", "https://oakbaypolice.org/wp-json/wp/v2/posts?per_page=8&_fields=id,date,link,title"),
    ("bcrcmp", "BC RCMP", [-122.849, 49.191], "rcmp-bc", "https://rcmp.ca/en/bc/news"),
]
# the CRD's municipalities (release datelines and mentions); the West Shore detachment's area first
CRD_MUNIS = ["Langford", "Colwood", "View Royal", "Metchosin", "Highlands", "Sooke", "Victoria", "Esquimalt", "Saanich", "Oak Bay",
             "Central Saanich", "North Saanich", "Sidney"]
WEST_SHORE = {"Langford", "Colwood", "View Royal", "Metchosin", "Highlands"}
LOCAL_RCMP = ("/bc/west-shore/", "/bc/sooke/", "/bc/sidney-north-saanich/")
RAW = ROOT / "data" / "local" / "raw"
LANGFORD_LL = (-123.505, 48.449)
# StatCan 35-10-0063-01 geography members: key → (member id, label)
CSI_PID = 35100063
CSI_GEO = {
    "bc": (1, "British Columbia"),
    "langford": (144, "Langford RCMP (municipal)"), "colwood": (125, "Colwood RCMP (municipal)"),
    "view-royal": (162, "View Royal RCMP (municipal)"), "metchosin": (236, "Metchosin RCMP (municipal)"),
    "westshore": (178, "West Shore RCMP (rural)"), "sooke": (21, "Sooke RCMP (municipal)"),
    "victoria-city": (25, "Victoria Police"), "esquimalt": (6, "Esquimalt (Victoria Police)"), "saanich": (20, "Saanich Police"),
    "oak-bay": (16, "Oak Bay Police"), "central-saanich": (2, "Central Saanich Police"),
    "north-saanich": (121, "North Saanich RCMP (municipal)"), "sidney": (204, "Sidney RCMP (municipal)"),
}
CSI_STATS = {1: "csi", 3: "violent", 5: "nonviolent"}


def clean(s: str | None) -> str:
    s = re.sub(r"<!\[CDATA\[(.*?)\]\]>", r"\1", s or "", flags=re.S)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", s))).strip()


def local_iso(s: str | None) -> str | None:
    """eSCRIBE "2026/11/24 17:30:00" → "2026-11-24T17:30:00" (local Pacific time, no zone)"""
    return s.replace("/", "-").replace(" ", "T") if s else None


def langford_news() -> list[dict]:
    r = S.get(f"{LANGFORD_WP}/posts", params={"per_page": 20, "_fields": "id,date,link,title"}, timeout=60)
    r.raise_for_status()
    return [{"id": p["id"], "title": clean(p["title"]["rendered"]), "date": p["date"][:10], "link": p["link"]} for p in r.json()]


def langford_pages() -> list[dict]:
    """Pages the City updates in place (no feed): title, last-modified date and link."""
    out = []
    for slug in ("public-notices", "traffic-advisories", "meetings"):
        r = S.get(f"{LANGFORD_WP}/pages", params={"slug": slug, "_fields": "title,link,modified"}, timeout=60)
        if r.ok and r.json():
            p = r.json()[0]
            out.append({"slug": slug, "title": clean(p["title"]["rendered"]), "modified": p["modified"][:10], "link": p["link"]})
    return out


def meetings() -> list[dict]:
    today = date.today()
    body = {"calendarStartDate": str(today - timedelta(days=21)), "calendarEndDate": str(today + timedelta(days=90))}
    r = S.post(f"{ESCRIBE}/MeetingsCalendarView.aspx/GetCalendarMeetings", json=body, timeout=60)
    r.raise_for_status()
    out = []
    for m in r.json().get("d", []):
        agenda = bool(m.get("HasAgenda"))
        out.append({"name": m["MeetingName"], "type": m["MeetingType"], "start": local_iso(m["StartDate"]), "end": local_iso(m["EndDate"]),
                    "where": m.get("Location") or None, "agenda": agenda,
                    "link": f"{ESCRIBE}/Meeting.aspx?Id={m['ID']}&Agenda=Agenda&lang=English" if agenda else f"{ESCRIBE}/"})
    return sorted(out, key=lambda m: m["start"])


def agency_news(a) -> list[dict]:
    aid, _name, _ll, kind, url = a
    r = S.get(url, timeout=60)
    r.raise_for_status()
    if kind in ("rcmp", "rcmp-bc"):   # rcmp.ca newsroom pages embed every release as JSON in drupal-settings (poweb.all_news.<view>)
        m = re.search(r'data-drupal-selector="drupal-settings-json">(.*?)</script>', r.text, re.S)
        rows = next(iter(json.loads(m.group(1))["poweb"]["all_news"].values()))
        rows = json.loads(rows) if isinstance(rows, str) else rows
        out = [{"agency": aid, "title": clean(x["title"]), "date": (x.get("field_publish_date") or x["created"])[:10],
                "link": x["view_node"], "where": x.get("field_location")} for x in rows]
        if kind == "rcmp-bc":   # the whole province: keep releases datelined in the CRD that no local newsroom lists
            out = [x for x in out if any(m.lower() in (x["where"] or "").lower() for m in CRD_MUNIS) and not any(q in x["link"] for q in LOCAL_RCMP)]
        return out
    if kind == "rss":
        out = []
        for it in re.findall(r"<item>(.*?)</item>", r.text, re.S):
            def g(t: str) -> str:
                m = re.search(rf"<{t}[^>]*>(.*?)</{t}>", it, re.S)
                return m.group(1) if m else ""
            out.append({"agency": aid, "title": clean(g("title")), "date": parsedate_to_datetime(clean(g("pubDate"))).date().isoformat(),
                        "link": clean(g("link")), "where": None})
        return out
    return [{"agency": aid, "title": clean(p["title"]["rendered"]), "date": p["date"][:10], "link": p["link"], "where": None} for p in r.json()]


# ------------------------------------------------------------------ release scan: which municipalities, one mappable place
_last: dict[str, float] = {}
SUFFIX = r"(?:Road|Rd|Street|St|Avenue|Ave|Drive|Dr|Way|Parkway|Pkwy|Boulevard|Blvd|Highway|Hwy|Lane|Ln|Crescent|Cres|Place|Pl|Trail|Terrace|Court|Ct)\b\.?"
STREET = rf"((?:[A-Z][\w'’.-]*\s){{1,3}}?{SUFFIX}|Highway \d+|Hwy\.? \d+)"
INTERSECTION = re.compile(rf"{STREET}\s+(?:and|&|at|near)\s+{STREET}")
BLOCK = re.compile(rf"(\d{{1,5}})[- ]block of\s+{STREET}")
AREA = re.compile(r"\b((?:Mount|Mt\.) [A-Z][a-z]+|(?:[A-Z][a-z]+ ){1,2}(?:Lake|River|Creek|Park|Mountain|Valley|Hill))\b")


def polite_get(url: str, **kw) -> requests.Response:
    host = url.split("/")[2]
    wait = _last.get(host, 0) + 2.0 - time.time()
    if wait > 0:
        time.sleep(wait)
    _last[host] = time.time()
    return S.get(url, timeout=60, **kw)


def release_text(link: str) -> str:
    h = polite_get(link).text
    m = re.search(r"<article\b.*?</article>", h, re.S) or re.search(r"<main\b.*?</main>", h, re.S)
    body = re.sub(r"<(script|style|nav|aside|footer|header|form)\b.*?</\1>", " ", m.group(0) if m else h, flags=re.S)
    return clean(body)


def km_from_langford(lon: float, lat: float) -> float:
    return (((lon - LANGFORD_LL[0]) * 73.9) ** 2 + ((lat - LANGFORD_LL[1]) * 111.2) ** 2) ** 0.5


def geocode(address: str, locality: str) -> dict | None:
    """BC Address Geocoder (OGL-BC, no key): an intersection, block or address in the expected municipality only."""
    r = polite_get("https://geocoder.api.gov.bc.ca/addresses.json", params={"addressString": f"{address}, {locality}, BC", "maxResults": 1, "minScore": 80})
    if not r.ok or not r.json().get("features"):
        return None
    f = r.json()["features"][0]
    p = f["properties"]
    if p.get("matchPrecision") not in ("INTERSECTION", "BLOCK", "CIVIC_NUMBER") or (p.get("localityName") or "").lower() != locality.lower() or p.get("score", 0) < 85:
        return None
    lon, lat = f["geometry"]["coordinates"][:2]
    kind = {"INTERSECTION": "intersection", "BLOCK": "block", "CIVIC_NUMBER": "block"}[p["matchPrecision"]]
    name = p.get("fullAddress", address).replace(", BC", "")
    if kind == "block":   # never a house number: round to the hundred-block
        name = re.sub(r"^(\d+)", lambda mm: f"{int(mm.group(1)) // 100 * 100} block", name)
    return {"ll": [round(lon, 4), round(lat, 4)], "name": name, "kind": kind}


def gazetteer(name: str) -> dict | None:
    """BC Geographical Names (OGL-BC): an official lake, river, park or mountain of that exact name within 12 km of Langford."""
    r = polite_get("https://apps.gov.bc.ca/pub/bcgnws/names/search", params={"outputFormat": "json", "name": name, "outputSRS": 4326, "itemsPerPage": 10})
    if not r.ok:
        return None
    for f in r.json().get("features", []):
        lon, lat = f["geometry"]["coordinates"][:2]
        if f["properties"]["name"].lower() == name.lower() and km_from_langford(lon, lat) <= 12:
            return {"ll": [round(lon, 4), round(lat, 4)], "name": f["properties"]["name"], "kind": "area"}
    return None


def place_in(text: str, locality: str) -> dict | None:
    for m in INTERSECTION.finditer(text):
        g = geocode(f"{m.group(1).strip()} and {m.group(2).strip()}", locality)
        if g:
            return g
    for m in BLOCK.finditer(text):
        g = geocode(f"{m.group(1)} {m.group(2).strip()}", locality)
        if g:
            return g
    for name in dict.fromkeys(m.group(1).replace("Mt.", "Mount") for m in AREA.finditer(text)):
        if name.split()[0] in ("The", "This", "That", "West", "Langford", "Saanich", "Victoria") and name != "Langford Lake":
            continue
        g = gazetteer(name)
        if g:
            return g
    return None


def scan(items: list[dict]) -> None:
    """add `mentions` (CRD municipalities the release names) and `loc` (one mappable place) to recent releases"""
    RAW.mkdir(parents=True, exist_ok=True)
    f = RAW / "police_scan.json"
    cache = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
    since = str(date.today() - timedelta(days=45))
    for x in items:
        if x["date"] < since:
            continue
        if x["link"] not in cache:
            try:
                text = release_text(x["link"])
                mentions = [m for m in CRD_MUNIS if re.search(rf"\b{m}\b", text)]
                where = (x.get("where") or "").strip()
                loc = None
                if x["agency"] == "westshore" or "Langford" in mentions or "langford" in where.lower():
                    loc = place_in(text, where if where in WEST_SHORE else "Langford")
                cache[x["link"]] = {"mentions": mentions, "loc": loc}
            except Exception as e:   # one page must not sink the rest; it is tried again next run
                print(f"  scan {x['link']}: {e}")
                continue
        c = cache[x["link"]]
        x["mentions"] = c["mentions"]
        if c.get("loc"):
            x["loc"] = c["loc"]
    keep = {x["link"] for x in items}
    f.write_text(json.dumps({k: v for k, v in cache.items() if k in keep}, ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"  scan: {sum(1 for x in items if 'Langford' in x.get('mentions', []))} name Langford, {sum(1 for x in items if x.get('loc'))} mapped")


def redact_titles(titles: list[str]) -> list[str]:
    """names out of the headlines, through the shared JS function (one implementation for relay, snapshot and page)"""
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node not found: needed to take names out of police headlines")
    r = subprocess.run([node, str(Path(__file__).with_name("redact_names.mjs"))], input=json.dumps(titles), capture_output=True,
                       text=True, encoding="utf-8", timeout=60, check=True)
    out = json.loads(r.stdout)
    if len(out) != len(titles):
        raise RuntimeError("redaction returned a different number of headlines")
    return out


def police() -> dict:
    items, status = [], []
    since = str(date.today() - timedelta(days=120))
    for a in AGENCIES:
        try:
            got = [x for x in agency_news(a) if x["title"] and x["date"] >= since]
            items += got
            status.append({"id": a[0], "name": a[1], "ll": a[2], "page": a[4].split("/wp-json/")[0].replace("tag/news-releases/rss/", ""), "ok": True})
        except Exception as e:  # one agency down must not sink the rest
            print(f"  {a[1]}: {e}")
            status.append({"id": a[0], "name": a[1], "ll": a[2], "page": a[4].split("/wp-json/")[0], "ok": False, "error": str(e)[:200]})
    items.sort(key=lambda x: x["date"], reverse=True)
    seen: set[str] = set()
    items = [x for x in items if not (x["link"] in seen or seen.add(x["link"]))]
    scan(items)
    for x, t in zip(items, redact_titles([x["title"] for x in items])):   # raises (no police section written) if it can't
        x["title"] = t
    return {"items": items, "agencies": status, "names": "redacted"}


def csi() -> dict:
    """Crime severity index (+ violent / non-violent) for each police service, last 15 years."""
    coords = [{"productId": CSI_PID, "coordinate": f"{geo}.{st}.0.0.0.0.0.0.0.0", "latestN": 15}
              for geo, _ in CSI_GEO.values() for st in CSI_STATS]
    r = S.post("https://www150.statcan.gc.ca/t1/wds/rest/getDataFromCubePidCoordAndLatestNPeriods", json=coords, timeout=120)
    r.raise_for_status()
    by_coord = {}
    for row in r.json():
        if row.get("status") != "SUCCESS":
            continue
        o = row["object"]
        by_coord[o["coordinate"]] = {int(p["refPer"][:4]): p["value"] for p in o["vectorDataPoint"] if p.get("value") is not None}
    years = sorted({y for v in by_coord.values() for y in v})
    series = {}
    for key, (geo, label) in CSI_GEO.items():
        s = {"label": label}
        for st, name in CSI_STATS.items():
            v = by_coord.get(f"{geo}.{st}.0.0.0.0.0.0.0.0", {})
            s[name] = [v.get(y) for y in years]
        if any(x is not None for x in s["csi"]):
            series[key] = s
    return {"table": "35-10-0063-01", "years": years, "series": series,
            "credit": "Statistics Canada, Table 35-10-0063-01 (Crime severity index by police service, BC). Statistics Canada Open Licence."}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    out = {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    for key, fn in (("news", langford_news), ("pages", langford_pages), ("meetings", meetings), ("police", police), ("csi", csi)):
        try:
            out[key] = fn()
            v = out[key]
            print(f"{key}: {len(v) if isinstance(v, list) else len(v.get('items', v.get('series', [])))}")
        except Exception as e:
            print(f"{key}: FAILED {e}")
            out[key] = None
    (OUT / "local.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT / 'local.json'}")


if __name__ == "__main__":
    main()
