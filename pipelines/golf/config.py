"""Golf Playability & Course Tier List configuration.

Everything a reader might want to argue with lives here: the region boxes, the weather stations, what counts as a
playable hour, and the default weights of the course score (the page lets viewers change the weights).
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "golf" / "raw"
OSM = ROOT / "data" / "osm"          # BBBike city extracts (.osm.pbf), shared with Sunday Wander
DEM_DIR = ROOT / "data" / "dem"      # Copernicus GLO-30 tiles, shared
OUT = ROOT / "site" / "public" / "data" / "golf"
TZ = "America/Vancouver"

# (south, west, north, east) = the bounds of the BBBike extracts, which are all the map data there is. Victoria reaches
# Langford's Bear Mountain but stops at 48.392 N (Metchosin Golf & Country Club is just outside); Vancouver covers the
# North Shore to White Rock and east to Pitt Meadows (122.668 W).
REGIONS = {
    "victoria": {"name": "Greater Victoria", "bbox": (48.392, -123.578, 48.702, -123.25), "pbf": "Victoria", "center": [-123.42, 48.50], "zoom": 10.4},
    "vancouver": {"name": "Greater Vancouver", "bbox": (48.999, -123.307, 49.416, -122.668), "pbf": "Vancouver", "center": [-123.0, 49.22], "zoom": 10.0},
}
OSM_MAX_AGE_DAYS = 6.5   # the extract is refreshed weekly upstream; the daily run reuses it until it's this old

# ----------------------------------------------------------------------------------------------------------- stations
# ECCC daily climate (climatology: "best months", frost-delay odds). Listed in splice order: the first is the reference,
# later ones fill gaps and extend the record after a month-by-month bias adjustment (pipelines.common.eccc.splice).
CLIMATE_STATIONS = {
    "victoria": {"name": "Victoria Gonzales + Victoria Int'l", "ids": ["1018611", "1018621", "1018620"], "since": "1991-01-01"},
    "vancouver": {"name": "Vancouver Int'l", "ids": ["1108395", "1108447"], "since": "1991-01-01"},
}
# ECCC hourly observations used as the truth for the forecast backtest. They need hourly precipitation, which the
# airports don't report (only every-third-hour weather words), so these are the automatic "CS" stations.
# wind_from: borrow wind from another station when this one has none (Vancouver Harbour CS has no anemometer feed).
OBS_STATIONS = {
    "uvic": {"name": "Victoria University CS", "id": "1018598", "region": "victoria", "lat": 48.457, "lon": -123.3046},
    "vanharbour": {"name": "Vancouver Harbour CS (wind: Vancouver Int'l)", "id": "1108446", "region": "vancouver", "lat": 49.2954,
                   "lon": -123.1219, "wind_from": "1108395"},
    "pittmeadows": {"name": "Pitt Meadows CS", "id": "1106178", "region": "vancouver", "lat": 49.2083, "lon": -122.6900},
}
BACKTEST_DAYS = 365       # how far back the previous-runs forecasts and the observations go
BACKTEST_LEADS = [1, 2, 3, 4, 5, 6, 7]

OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
OPEN_METEO_PREV = "https://previous-runs-api.open-meteo.com/v1/forecast"
HOURLY_VARS = ["temperature_2m", "dew_point_2m", "precipitation", "wind_speed_10m", "wind_gusts_10m"]
FORECAST_EXTRA = ["precipitation_probability", "apparent_temperature", "weather_code", "relative_humidity_2m"]
WEATHER_POINT_GRID = 0.03   # courses within the same ~3 km cell share one forecast point (the models are 2.5–13 km)

# ----------------------------------------------------------------------------------------------- playable-hour model
# An hour is scored 0–1 for comfort; "playable" means comfort >= PLAYABLE_MIN. Each factor is a ramp from fully
# fine (1) to unplayable (0); the hour's comfort is the product of the factors. The same function runs on the live
# forecast, on the archived forecasts and on the observations, so the backtest grades exactly what the page shows.
PLAYABILITY = {
    "rain_mm": (0.1, 1.0),          # mm in the hour: a trace is fine, 1 mm/h is steady rain nobody plays through
    "wind_kmh": (20, 40),           # sustained wind at 10 m
    "gust_kmh": (40, 65),           # gusts (forecast only; the CS stations have no gust record, so the backtest skips it)
    "temp_c": (8, 2),               # air temperature: 8 °C and up is fine, 2 °C and below nobody's out
    "frost_tmin": 1.0,              # an overnight low at or below this (2 m air; grass is colder) means a frost delay...
    "frost_clear_c": 3.0,           # ...that lasts until the air reaches this temperature (or all day: frozen out)
    "daylight_pad_min": 20,         # first tee 20 min after sunrise; must finish 20 min before sunset
    "wet_24h_mm": 15,               # flagged "soggy" (cart-path only, lift-clean-place) after this much rain in 24 h
}
PLAYABLE_MIN = 0.5
ROUND_HOURS = {"18": 4.5, "9": 2.25, "pitch_and_putt": 1.5, "disc_golf": 2.0}   # walking pace, for the tee-time window
PLAYABLE_DAY_HOURS = 4      # a "playable day" (backtest hit rate) has at least this many playable daylight hours
GOOD_DAY_SHARE = 0.75       # a "good day" has at least this share of its daylight hours playable (the stricter test)

# ------------------------------------------------------------------------------------------------- course features
# Each feature is put on a 0–100 scale before weighting; the ramps are below (value at 0, value at 100).
FEATURE_RAMPS = {
    "length": (230, 400),       # mean yards per hole (pitch-and-putt ~70; a championship course ~400)
    "par": (27, 72),            # total par scaled to 18 holes (only where par is mapped)
    "bunkers": (0, 4),          # bunkers per hole
    "water": (0, 0.5),          # share of holes with water in play (a water hazard within 25 m of the hole line)
    "trees": (0.05, 0.45),      # share of the course under tree canopy
    "views": (0, 0.35),         # line-of-sight water views (dem.water_view) from tees and greens, 90th percentile.
                                # Tried and kept over the fairway mean: same course order on the coast, wider range.
                                # Inland courses stay near 0 because the surface model really does block the water
                                # (Bear Mountain's Mountain course faces north, away from Langford Lake and the sea).
    "relief": (10, 90),         # elevation range, m (scenery: elevated tees and views)
    "climb": (8, 35),           # metres of climb per km walked, tee to green to next tee (walkability penalty)
    "holes": (9, 18),           # 9 holes scores 0, 18 scores 100
}
# Short courses (pitch-and-putt, par 3) are tiered among themselves with their own length scale.
FEATURE_RAMPS_SHORT = {"length": (60, 130), "par": (27, 54)}
# Default weights. Positive = more is better; negative = more counts against. Notes on the choices:
#  length  the strongest single proxy for a "real" golf challenge
#  bunkers, water  hazards = challenge and visual interest; water also because players like water holes
#  views   the DEM viewshed: sea and lake views from the tees and greens (Victoria GC, Kings Links, Cordova Bay)
#  trees   tree-lined fairways read as "parkland" quality; moderate weight because mapping varies a lot
#  relief  some elevation is scenic...
#  climb   ...but a lot of climbing makes the course a hard walk (penalty)
#  holes   18 holes is a fuller day out than 9
#  par     small weight; only counted where par is mapped (otherwise the weight is dropped and the rest rescaled)
WEIGHTS = {"length": 3.0, "bunkers": 1.5, "water": 1.5, "views": 2.0, "trees": 1.0, "relief": 0.75, "holes": 1.5, "par": 0.5,
           "climb": -1.5}

# ----------------------------------------------------------------------------------------------- completeness
# A course is tiered only when it's mapped well enough to measure. Completeness (0–1) = weighted share of:
COMPLETENESS = {"holes": 0.55, "greens": 0.15, "tees": 0.10, "fairways": 0.10, "hazards": 0.10}
RANK_MIN_COMPLETENESS = 0.70    # below this the course is listed as "not enough mapped", never tiered
# Tiers by percentile of the score among the ranked full courses of the same region (short courses: both regions
# together, as there are only a handful), top first; rank_all compares both regions. The page recomputes them when weights change.
TIERS = [("S", 0.10), ("A", 0.30), ("B", 0.65), ("C", 0.90), ("D", 1.01)]

# ----------------------------------------------------------------------------------------------- provisional tiers
# A course with an outline but too few holes gets a provisional tier from what the outline alone can measure: water
# views from a grid of points across the polygon, relief, tree cover, climb on a back-and-forth walk across it, and
# the hole count (tagged, or 18 if the area is 38 ha or more). Hole length, par, bunkers and water in play are
# unknown and drop out (weights rescaled). Its outline-only score is set against the outline-only scores of the fully
# mapped courses (both regions pooled) and given the full score at the same place in that order (quantile mapping);
# the tier is where that lands among the region's ranked courses. It takes no rank number, so ranked courses keep
# their ranks and tiers. The build re-runs the method on every ranked course, leaving that course out, and publishes
# the error; a group gets provisional tiers only if that check has enough courses and keeps their order.
PROVISIONAL_FEATURES = ["views", "trees", "relief", "climb", "holes"]
PROVISIONAL_MIN_CHECK = 8       # ranked courses needed in a group to calibrate and check the method
PROVISIONAL_MIN_RHO = 0.4       # rank correlation (outline-only vs full score, ranked courses) the check must reach
SHORT_HA_PER_HOLE = 0.75        # an unmapped "golf course" with less area per hole than this is a pitch & putt / par 3
                                # (mapped full courses run 0.9 ha a hole and up; pitch & putts 0.3–0.9)

# Vancouver Park Board facilities (opendata.vancouver.ca, Open Government Licence – Vancouver)
VAN_FACILITIES = "https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/parks-facilities/records"
VAN_PARKS = "https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/parks/records"
VAN_PITCH_AND_PUTT = {"Queen Elizabeth Park", "Rupert Park", "Stanley Park"}   # the board's 3 pitch-and-putts

# Unnamed courses (no name in OpenStreetMap) are shown as "Unnamed course, <nearest locality>". Hints are shown in the
# course drawer only, clearly as unconfirmed; they never replace the name.
LOCALITIES = {
    "victoria": {"Victoria": (48.428, -123.365), "Oak Bay": (48.427, -123.312), "Saanich": (48.484, -123.381), "Cordova Bay": (48.52, -123.37),
                 "Langford": (48.45, -123.50), "Colwood": (48.425, -123.49), "View Royal": (48.452, -123.433), "Esquimalt": (48.432, -123.414),
                 "Central Saanich": (48.57, -123.42), "North Saanich": (48.66, -123.42), "Sidney": (48.65, -123.40), "Highlands": (48.51, -123.50)},
    "vancouver": {"Vancouver": (49.25, -123.12), "Burnaby": (49.25, -122.98), "Richmond": (49.17, -123.13), "Delta": (49.09, -123.03),
                  "Tsawwassen": (49.01, -123.08), "Surrey": (49.15, -122.80), "South Surrey": (49.05, -122.79), "White Rock": (49.025, -122.80),
                  "Langley": (49.10, -122.66), "Coquitlam": (49.28, -122.79), "Port Coquitlam": (49.26, -122.78), "Port Moody": (49.28, -122.86),
                  "Pitt Meadows": (49.22, -122.69), "New Westminster": (49.205, -122.91), "North Vancouver": (49.32, -123.07),
                  "West Vancouver": (49.33, -123.16)},
}
# Names for courses OpenStreetMap leaves unnamed, confirmed locally (the site owner identified them). Adding the name to
# OpenStreetMap itself is the better fix; once OSM has a name, it wins and the entry here is ignored.
NAME_OVERRIDES = {"vancouver-r20596956": "Morgan Creek Golf Course"}   # 3500 Morgan Creek Way, South Surrey
NAME_HINTS = {}
