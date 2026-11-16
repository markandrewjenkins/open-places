"""Waterways configuration: areas, vessel categories and sources."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "ships" / "raw"
OUT = ROOT / "site" / "public" / "data" / "ships"
SALISH_AIS = ROOT / "data" / "salish" / "raw" / "ais"     # Salish Sea Live's cache of the same NOAA days (reused if present)

# Home waters: Juan de Fuca from Sooke to Port Townsend, Haro Strait and the Gulf Islands, the southern Strait of
# Georgia, Burrard Inlet and the Fraser River up to Mission, plus Puget Sound down to Seattle. (south, west, north, east)
HOME_BBOX = (47.45, -124.10, 49.45, -122.20)

# US Coast Guard terrestrial AIS, distributed by NOAA / BOEM Marine Cadastre (public domain). Daily zstd CSVs,
# published in batches months after the fact. Receivers on the US side also hear most Canadian traffic in these waters.
AIS_INDEX = "https://noaaocm.blob.core.windows.net/ais/csv2/csv{y}/index.html"
AIS_URL = "https://noaaocm.blob.core.windows.net/ais/csv2/csv{y}/ais-{d}.csv.zst"
AIS_DAYS = 7                       # one week: every weekday once

# Canadian Coast Guard navigational warnings (NAVWARNs, which replace NOTSHIPs) as an S-124 exchange set. A trial
# product, updated about weekly: "not operational or official". Series P = Pacific.
S124_URL = "https://nis.ccg-gcc.gc.ca/notice/s124/Canada_S100_Exchange_Set.zip"
S124_PAGE = "https://nis.ccg-gcc.gc.ca/public/rest/messages/en/s124-trial"

# Water Survey of Canada via MSC GeoMet (Open Government Licence – Canada): Fraser River at Hope, the freshet gauge.
GEOMET = "https://api.weather.gc.ca/collections"
HOPE = "08MF005"
NORMAL_YEARS = (1995, 2024)

# Named areas: (id, name, group, kind, (south, west, north, east)). Rectangles are rough on purpose: AIS positions are
# on the water, so a box that clips some land still counts only vessels.
AREAS = [
    ("vic-harbour", "Victoria Harbour & Ogden Point", "victoria", "harbour", (48.404, -123.418, 48.437, -123.360)),
    ("haro", "Haro Strait", "victoria", "lane", (48.40, -123.30, 48.72, -123.12)),
    ("swartz", "Swartz Bay ferry approaches", "victoria", "ferry", (48.64, -123.48, 48.74, -123.33)),
    ("jdf", "Juan de Fuca off Victoria", "victoria", "lane", (48.17, -123.80, 48.38, -123.05)),
    ("port-angeles", "Port Angeles harbour", "victoria", "harbour", (48.11, -123.50, 48.16, -123.38)),
    ("fraser-mouth", "Fraser River mouth & Sand Heads", "vancouver", "river", (49.05, -123.35, 49.14, -123.19)),
    ("fraser-main", "Fraser River, Steveston to New Westminster", "vancouver", "river", (49.10, -123.19, 49.24, -122.88)),
    ("fraser-up", "Fraser River above New Westminster", "vancouver", "river", (49.15, -122.88, 49.25, -122.25)),
    ("burrard", "Burrard Inlet & Port of Vancouver", "vancouver", "harbour", (49.27, -123.14, 49.32, -122.85)),
    ("english-bay", "English Bay anchorages", "vancouver", "anchorage", (49.24, -123.35, 49.32, -123.14)),
    ("elliott", "Elliott Bay & Seattle waterfront", "seattle", "harbour", (47.57, -122.43, 47.63, -122.33)),
    ("ship-canal", "Ballard Locks & Ship Canal", "seattle", "river", (47.64, -122.42, 47.68, -122.30)),
    ("puget-central", "Puget Sound off Seattle", "seattle", "lane", (47.55, -122.55, 47.75, -122.38)),
]

# AIS ship-type code → category (same order and meaning as Salish Sea Live)
CATS = ["Passenger & ferry", "Cargo", "Tanker", "Tug & tow", "Fishing", "Pleasure & sail", "Other"]
CRUISE_M = 200      # passenger vessels at least this long are drawn and counted as cruise ships


def vessel_category(code) -> int:
    try:
        c = int(code)
    except (TypeError, ValueError):
        return 6
    if 60 <= c <= 69:
        return 0
    if 70 <= c <= 79:
        return 1
    if 80 <= c <= 89:
        return 2
    if c in (31, 32, 52):
        return 3
    if c == 30:
        return 4
    if c in (36, 37):
        return 5
    return 6
