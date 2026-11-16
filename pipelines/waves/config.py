"""West Coast Water (working title) configuration: buoys, tide gauges, wind stations, forecast points and the
per-spot rating rules.

Every rule below is an editable assumption, not an official surf report (none exists for these beaches). Heights are
significant wave height (Hs) AT THE DRIVER BUOY, because that is the number both the buoy and the forecast give and
it is what local surfers watch ("check Neah Bay"). Directions are degrees true, the direction waves/wind come FROM.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "waves" / "raw"
OUT = ROOT / "site" / "public" / "data" / "waves"
TZ = "America/Vancouver"

# ----------------------------------------------------------------------------------------------- endpoints
NDBC_RT = "https://www.ndbc.noaa.gov/data/realtime2/{id}.{ext}"                 # last 45 days
NDBC_HIST = "https://www.ndbc.noaa.gov/data/historical/stdmet/{id}h{y}.txt.gz"   # annual, final
NDBC_MONTH = "https://www.ndbc.noaa.gov/data/stdmet/{mon}/{id}{m}{y}.txt.gz"     # this year, month m = 1-9, a, b, c
NDBC_MONTH_PRELIM = "https://www.ndbc.noaa.gov/data/stdmet/{mon}/{id}.txt"       # newest month, not yet gzipped
MEDS_CSV = "https://www.meds-sdmm.dfo-mpo.gc.ca/alphapro/wave/waveshare/csvData/{id}_csv.zip"
SWOB_DAY = "https://dd.weather.gc.ca/{d}/WXO-DD/observations/swob-ml/marine/moored-buoys/{d}/{sid}/"
ECCC_API = "https://api.weather.gc.ca/collections"
IWLS = "https://api-iwls.dfo-mpo.gc.ca/api/v1"
OM_MARINE = "https://marine-api.open-meteo.com/v1/marine"
OM_FORECAST = "https://api.open-meteo.com/v1/forecast"
OM_PREVIOUS = "https://previous-runs-api.open-meteo.com/v1/forecast"

# Open-Meteo keeps "previous model runs" for the marine API only from this date (checked 2026-11-12). Before it the
# _previous_dayN variables are empty, so this is where the forecast-vs-buoy backtest can start.
BACKTEST_START = "2025-11-17"
LEADS = list(range(0, 8))           # previous_day0 … previous_day7 (0 = the freshest run, i.e. a 0–23 h lead)
ARCHIVE_DAYS = 400                  # rolling window kept in the durable obs archive

# Marine models: best_match (Météo-France MFWAM ~8 km here) for height, direction and swell partitions; ECMWF WAM
# 0.25° for PEAK period, the only model whose peak period is kept in the previous-runs archive.
MARINE_MODEL = "best_match"
PERIOD_MODEL = "ecmwf_wam025"

# ----------------------------------------------------------------------------------------------- observations
# kind: ndbc = NOAA NDBC realtime2 (+ annual/monthly history); swob = ECCC MSC Datamart SWOB-ML (30 days online),
# also relayed by NDBC for about a day; meds = DFO MEDS archive (history only, it ends 2022–23).
BUOYS = {
    "46087": {"name": "Neah Bay", "lat": 48.494, "lon": -124.728, "owner": "NOAA NDBC", "ndbc": True, "spec": True,
              "history": True, "swob": None, "meds": None,
              "note": "Mouth of Juan de Fuca Strait. The usual swell proxy for Jordan River and Sombrio."},
    "46206": {"name": "La Perouse Bank", "lat": 48.835, "lon": -125.998, "owner": "ECCC", "ndbc": True, "spec": False,
              "history": False, "swob": "4600206", "meds": "c46206",
              "note": "Offshore of Barkley Sound, ~35 km SW of Tofino/Ucluelet. Proxy for the Tofino beaches."},
    "46146": {"name": "Halibut Bank", "lat": 49.340, "lon": -123.727, "owner": "ECCC", "ndbc": True, "spec": False,
              "history": False, "swob": "4600146", "meds": "c46146",
              "note": "Central Strait of Georgia. Wind-sea only; used for calm-water paddling checks."},
    "46304": {"name": "English Bay", "lat": 49.302, "lon": -123.357, "owner": "ECCC", "ndbc": True, "spec": False,
              "history": False, "swob": "4600304", "meds": None,
              "note": "Entrance to English Bay, Vancouver (Ocean Protection Plan buoy). Calm-water checks."},
}

# Observed coastal wind for the backtest and freshness: ECCC hourly climate stations (10 m anemometers; direction in
# tens of degrees) or, where no station near the beach reports wind, a buoy's own anemometer (kind "buoy").
# Checked 2026-11-12: Sheringham Point (1017254, 6 km from Jordan River) and Vancouver Harbour CS (1108446) publish
# hourly temperature but no wind, so they can't be used.
WIND_STATIONS = {
    "46087": {"kind": "buoy", "name": "Neah Bay buoy", "lat": 48.494, "lon": -124.728,
              "note": "No station near Jordan River or Sombrio reports hourly wind, so the Neah Bay buoy's anemometer "
                      "(3.8 m above the sea, ~50 km west, open ocean) stands in. Reads lighter than a 10 m mast."},
    "1038210": {"kind": "eccc", "name": "Tofino Airport", "lat": 49.0822, "lon": -125.7725,
                "note": "Inland of Long Beach; more sheltered than the beaches, so it under-reads sea breezes."},
    "1018611": {"kind": "eccc", "name": "Victoria Gonzales", "lat": 48.4133, "lon": -123.3248, "note": "Gonzales Hill, Victoria waterfront."},
    "1106200": {"kind": "eccc", "name": "Point Atkinson", "lat": 49.3304, "lon": -123.2647,
                "note": "Lighthouse at the mouth of Burrard Inlet / English Bay."},
    "1108395": {"kind": "eccc", "name": "Vancouver Airport", "lat": 49.1950, "lon": -123.1817,
                "note": "Exposed airport anemometer on the Fraser delta: windier than False Creek, hence lenient thresholds."},
}

# DFO / CHS tide gauges and prediction stations (IWLS, no key). Predictions only are used.
TIDES = {
    "07013": {"name": "Sheringham Point", "id": "5cebf1df3d0f4a073c4bbd0d", "lat": 48.3771, "lon": -123.9212,
              "note": "Prediction station 6 km east of Jordan River (no Jordan River station exists)."},
    "08525": {"name": "Port Renfrew", "id": "5cebf1e23d0f4a073c4bc060", "lat": 48.555, "lon": -124.421,
              "note": "Gauge 13 km west-northwest of Sombrio."},
    "08615": {"name": "Tofino", "id": "5cebf1e23d0f4a073c4bc07c", "lat": 49.154, "lon": -125.913, "note": "Tofino gauge."},
    "07120": {"name": "Victoria Harbour", "id": "5cebf1df3d0f4a073c4bbd1e", "lat": 48.4244, "lon": -123.3708, "note": "Victoria gauge."},
    "07795": {"name": "Point Atkinson", "id": "5cebf1de3d0f4a073c4bb94c", "lat": 49.3375, "lon": -123.2536, "note": "Vancouver reference port."},
}

# ----------------------------------------------------------------------------------------------- surf spots
# size: (min, ideal_lo, ideal_hi, max) buoy Hs in m: 0 below min, 1 across the ideal band, falling back to 0 at max
#       (closeouts / unrideable). period: (min, ideal) peak period s. dir: (lo, hi) core swell window at the buoy,
#       taper: degrees outside the window over which the factor falls to 0. facing: the direction the beach faces;
#       offshore wind blows FROM facing + 180. tide: preferred band of the normalised tide (0 = lowest low, 1 = highest
#       high of the 9-day window) and the floor outside it.
SPOTS = {
    "jordan": {
        "name": "Jordan River", "region": "Juan de Fuca", "lat": 48.4215, "lon": -124.0530, "facing": 195,
        "buoy": "46087", "wind_station": "46087", "tide": "07013",
        "size": (1.5, 2.5, 5.0, 7.5), "period": (9, 13), "dir": (240, 295), "taper": 20,
        "tide_band": (0.0, 0.6), "tide_floor": 0.7,
        "drive": {"Victoria": "1 h 05", "Vancouver": "~4 h (ferry + drive)"},
        "notes": [
            "Swell must wrap ~70 km down Juan de Fuca Strait, so only a long-period W swell reaching Neah Bay at "
            "2.5 m+ makes it here; S swell is blocked by the Olympic Peninsula (assumption, community surf guides).",
            "Faces SSW: offshore is a N–NE wind (outflow), onshore is the usual SW–W sea breeze.",
            "Reef/cobble point said to work best low to mid tide (surf-guide lore, unverified).",
        ]},
    "sombrio": {
        "name": "Sombrio Beach", "region": "Juan de Fuca", "lat": 48.4990, "lon": -124.2960, "facing": 205,
        "buoy": "46087", "wind_station": "46087", "tide": "08525",
        "size": (1.2, 2.0, 4.0, 6.0), "period": (9, 12), "dir": (230, 295), "taper": 20,
        "tide_band": (0.0, 0.6), "tide_floor": 0.7,
        "drive": {"Victoria": "1 h 35", "Vancouver": "~4 h 30 (ferry + drive)"},
        "notes": [
            "Further out the strait than Jordan River, so it needs less swell (assumption).",
            "Faces SSW–SW: offshore is NE.",
            "Point/reef breaks favour low to mid tide (surf-guide lore, unverified).",
        ]},
    "chesterman": {
        "name": "Chesterman Beach", "region": "Tofino", "lat": 49.1180, "lon": -125.8920, "facing": 235,
        "buoy": "46206", "wind_station": "1038210", "tide": "08615",
        "size": (0.8, 1.2, 3.0, 5.0), "period": (8, 11), "dir": (190, 300), "taper": 25,
        "tide_band": (0.25, 0.75), "tide_floor": 0.85,
        "drive": {"Victoria": "4 h 30", "Vancouver": "~5 h (Horseshoe Bay ferry + Hwy 4)"},
        "notes": [
            "Open Pacific beach: takes S to NW swell. La Perouse Bank is 35 km offshore, so beach size is roughly "
            "60–90 % of the buoy (assumption).",
            "Faces WSW: offshore is an ENE wind, usually early morning.",
            "Beach break, works on most tides; mid tide preferred (surf-guide lore, unverified).",
        ]},
    "cox": {
        "name": "Cox Bay", "region": "Tofino", "lat": 49.1000, "lon": -125.8780, "facing": 215,
        "buoy": "46206", "wind_station": "1038210", "tide": "08615",
        "size": (0.6, 1.0, 2.5, 4.0), "period": (8, 11), "dir": (180, 290), "taper": 25,
        "tide_band": (0.0, 1.0), "tide_floor": 1.0,
        "drive": {"Victoria": "4 h 30", "Vancouver": "~5 h (Horseshoe Bay ferry + Hwy 4)"},
        "notes": [
            "The most exposed Tofino beach: picks up the most swell and maxes out first (assumption).",
            "Faces SW: offshore is a NE wind.",
            "Works on all tides; tide is not scored here.",
        ]},
    "longbeach": {
        "name": "Long Beach (Incinerator Rock)", "region": "Tofino", "lat": 49.0540, "lon": -125.7660, "facing": 225,
        "buoy": "46206", "wind_station": "1038210", "tide": "08615",
        "size": (0.6, 1.0, 2.5, 4.0), "period": (8, 11), "dir": (185, 295), "taper": 25,
        "tide_band": (0.2, 0.8), "tide_floor": 0.85,
        "drive": {"Victoria": "4 h 15", "Vancouver": "~4 h 45 (Horseshoe Bay ferry + Hwy 4)"},
        "notes": [
            "Long open beach in Pacific Rim National Park Reserve; similar exposure to Cox Bay (assumption).",
            "Faces SW: offshore is a NE wind.",
            "Mid tide preferred (surf-guide lore, unverified).",
        ]},
}

# Wind factor (all surf spots): 1 when calm (≤ WIND_CALM km/h); above that it loses WIND_K_OFF per km/h when dead
# offshore and WIND_K_OFF + WIND_K_ON per km/h when dead onshore, blended by the onshore share (1 − cos angle) / 2.
# e.g. onshore 20 km/h → 0.30, cross-shore 20 km/h → 0.60, offshore 25 km/h → 0.86.
WIND_CALM = 8.0
WIND_K_OFF = 0.008
WIND_K_ON = 0.050

# ----------------------------------------------------------------------------------------------- calm-water paddling
# wind: (full, zero) km/h — score 1 at or under `full`, 0 at `zero`; gust likewise; wave: (full, zero) m Hs at the
# marine point (None = sheltered water, waves not scored). Daylight hours only.
PADDLE = {
    "victoria_waterfront": {
        "name": "Victoria waterfront (Gonzales–Clover Point)", "area": "Victoria", "lat": 48.405, "lon": -123.330,
        "marine": (48.38, -123.30), "wind_station": "1018611", "tide": "07120", "buoy": None,
        "wind": (8, 20), "gust": (15, 30), "wave": (0.2, 0.6),
        "notes": ["Exposed to the strait: waves come from the Juan de Fuca model cell offshore.",
                  "Strong tidal currents off Clover Point and Trial Island; tide shown, not scored."]},
    "victoria_harbour": {
        "name": "Inner Harbour & Gorge", "area": "Victoria", "lat": 48.430, "lon": -123.385,
        "marine": None, "wind_station": "1018611", "tide": "07120", "buoy": None,
        "wind": (12, 25), "gust": (20, 35), "wave": None,
        "notes": ["Sheltered: wind only. Watch harbour traffic and floatplanes."]},
    "english_bay": {
        "name": "English Bay & Kitsilano", "area": "Vancouver", "lat": 49.285, "lon": -123.165,
        "marine": (49.29, -123.21), "wind_station": "1106200", "tide": "07795", "buoy": "46304",
        "wind": (8, 20), "gust": (15, 30), "wave": (0.2, 0.6),
        "notes": ["Exposed to westerlies off the Strait of Georgia; English Bay buoy checks the wave forecast."]},
    "false_creek": {
        "name": "False Creek & Deep Cove", "area": "Vancouver", "lat": 49.270, "lon": -123.125,
        "marine": None, "wind_station": "1108395", "tide": "07795", "buoy": None,
        "wind": (12, 25), "gust": (20, 35), "wave": None,
        "notes": ["Sheltered: wind only. Observed wind for the backtest is Vancouver Airport (exposed, so conservative)."]},
}

# Tiers, shared with the portfolio's other tier lists. GO = B or better.
TIERS = [("S", 85), ("A", 70), ("B", 55), ("C", 40), ("D", 0)]
GO_SCORE = 55
WINDOW_MIN = 40                     # an hour joins a "best window" at C or better
WINDOW_MIN_HOURS = 2

LICENCES = {
    "ndbc": "NOAA National Data Buoy Center — US Government work, public domain.",
    "eccc": "Environment and Climate Change Canada (MSC Datamart SWOB-ML, climate-hourly) — Open Government Licence – Canada "
            "per MSC Open Data terms; attribution: Environment and Climate Change Canada.",
    "meds": "Fisheries and Oceans Canada, Marine Environmental Data Section wave archive — Open Government Licence – Canada.",
    "iwls": "Fisheries and Oceans Canada / Canadian Hydrographic Service IWLS API — Open Government Licence – Canada. "
            "Not for navigation.",
    "open_meteo": "Open-Meteo.com (Marine, Forecast and Previous Runs APIs), CC BY 4.0. Free tier is for non-commercial "
                  "use only; attribution required. Underlying models: Météo-France MFWAM, ECMWF WAM, NOAA GFS, ECCC GEM.",
}
