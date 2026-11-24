"""Air Traffic (air traffic) configuration. Internal project key: `air`."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "air" / "raw"
OUT = ROOT / "site" / "public" / "data" / "air"

TZ = "America/Vancouver"

# The home circle: Greater Victoria and its approaches (Sooke to Sidney, the Juan de Fuca and Haro Strait corridors).
HOME = {"id": "victoria", "name": "Greater Victoria", "lat": 48.53, "lon": -123.42, "radius_nm": 40}

# Aviation weather: NOAA / NWS Aviation Weather Center Data API (US government work, public domain; ≤100 requests/min).
AWC_METAR = "https://aviationweather.gov/api/data/metar"
AWC_TAF = "https://aviationweather.gov/api/data/taf"
METAR_IDS = ["CYYJ", "CYWH", "CYVR", "CYCD", "CYXX", "KBLI"]
# Airports, runways and radio frequencies: OurAirports (public domain), refreshed nightly upstream; we take it weekly.
OURAIRPORTS = "https://davidmegginson.github.io/ourairports-data/{name}.csv"
OURAIRPORTS_MAX_AGE_DAYS = 7

# Aerodromes with richer local detail, and the zone the Air Traffic page uses to call a low live aircraft arriving,
# departing or passing low there.
# zone_km: radius around the aerodrome reference point; ceiling_ft: only aircraft below this (barometric) count.
AERODROMES = {
    "CYYJ": {"name": "Victoria International", "short": "YYJ", "zone_km": 8.0, "ceiling_ft": 3000},
    "CYWH": {"name": "Victoria Harbour (water aerodrome)", "short": "Harbour", "zone_km": 4.0, "ceiling_ft": 2000},
}
LOCAL_RADIUS_KM = 60                  # aerodromes listed in airports.json around HOME

CREDIT = {
    "awc": "Aviation weather: NOAA / NWS Aviation Weather Center (public domain)",
    "ourairports": "Airports, runways and frequencies: OurAirports (public domain)",
}
