"""Air Traffic (air traffic) configuration. Internal project key: `air`."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "air" / "raw"
DERIVED = ROOT / "data" / "air" / "derived"          # small committed summaries (the raw log is git-ignored)
# collector output: one csv.gz per UTC day (AIR_LOG_DIR overrides, e.g. on an always-on machine)
LOG = Path(os.environ["AIR_LOG_DIR"]) if os.environ.get("AIR_LOG_DIR") else RAW / "log"
OUT = ROOT / "site" / "public" / "data" / "air"

TZ = "America/Vancouver"

# The home circle: Greater Victoria and its approaches (Sooke to Sidney, the Juan de Fuca and Haro Strait corridors).
HOME = {"id": "victoria", "name": "Greater Victoria", "lat": 48.53, "lon": -123.42, "radius_nm": 40}

# Live ADS-B: adsb.lol (data ODbL 1.0). Keyless use is published as 500 requests a day per IP (checked 2026-11-15,
# https://www.adsb.lol/docs/open-data/api/), so the collector polls every 3 min (480 a day) unless the owner sets a free
# adsb.lol key in the environment variable ADSBLOL_API_KEY (sent as x-api-key; then once a minute).
# adsb.fi's open-data API is the fallback (personal, non-commercial use, credit with a link; 1 request/s at most; the
# v2 lat/lon/dist path is deprecated in favour of v3).
ADSB_LOL = "https://api.adsb.lol/v2/point/{lat}/{lon}/{r}"
ADSB_FI = "https://opendata.adsb.fi/api/v3/lat/{lat}/lon/{lon}/dist/{r}"
ADSBLOL_API_KEY = os.environ.get("ADSBLOL_API_KEY", "")
# Aviation weather: NOAA / NWS Aviation Weather Center Data API (US government work, public domain; ≤100 requests/min).
AWC_METAR = "https://aviationweather.gov/api/data/metar"
AWC_TAF = "https://aviationweather.gov/api/data/taf"
METAR_IDS = ["CYYJ", "CYWH", "CYVR", "CYCD", "CYXX", "KBLI"]
# Airports, runways and radio frequencies: OurAirports (public domain), refreshed nightly upstream; we take it weekly.
OURAIRPORTS = "https://davidmegginson.github.io/ourairports-data/{name}.csv"
OURAIRPORTS_MAX_AGE_DAYS = 7

# Aerodromes with richer local detail, and the zone used to call a low aircraft an arrival or departure there.
# zone_km: radius around the aerodrome reference point; ceiling_ft: only aircraft below this (barometric) count.
AERODROMES = {
    "CYYJ": {"name": "Victoria International", "short": "YYJ", "zone_km": 8.0, "ceiling_ft": 3000},
    "CYWH": {"name": "Victoria Harbour (water aerodrome)", "short": "Harbour", "zone_km": 4.0, "ceiling_ft": 2000},
}
LOCAL_RADIUS_KM = 60                  # aerodromes listed in airports.json around HOME

# Collector politeness
MIN_INTERVAL = 30                     # never faster than this
DEFAULT_INTERVAL = 60 if ADSBLOL_API_KEY else 180   # keyless: stay under adsb.lol's 500 requests a day
MAX_BACKOFF = 900
FLUSH_EVERY = 300                     # seconds of buffered rows before an append to disk

CREDIT = {
    "adsb": "Aircraft positions: adsb.lol (ODbL 1.0), from its volunteer feeders; fallback adsb.fi open data (adsb.fi)",
    "awc": "Aviation weather: NOAA / NWS Aviation Weather Center (public domain)",
    "ourairports": "Airports, runways and frequencies: OurAirports (public domain)",
}
