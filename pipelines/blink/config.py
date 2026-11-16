"""Blink 95 Reliability configuration (BC Transit Victoria, operator 48)."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "blink" / "raw"
# collector output: daily csv.gz while a day is open, parquet once it closes (BLINK_LOG_DIR overrides, e.g. in CI)
LOG = Path(os.environ["BLINK_LOG_DIR"]) if os.environ.get("BLINK_LOG_DIR") else RAW / "log"
GTFS_DIR = RAW / "gtfs"               # static schedule zips and filtered parquet, one folder per feed version
OUT = ROOT / "site" / "public" / "data" / "blink"

TZ = "America/Vancouver"

# BC Transit open data (no key). The realtime host serves every BC Transit system; operatorIds=48 is Victoria.
GTFS_STATIC = "https://bct.tmix.se/Tmix.Cap.TdExport.WebApi/gtfs/?operatorIds=48"
RT_VEHICLES = "https://bct.tmix.se/gtfs-realtime/vehicleupdates.pb?operatorIds=48"
RT_TRIPS = "https://bct.tmix.se/gtfs-realtime/tripupdates.pb?operatorIds=48"
RT_ALERTS = "https://bct.tmix.se/gtfs-realtime/alerts.pb?operatorIds=48"
LICENCE = ("BC Transit GTFS Data Terms of Use (bctransit.com/open-data/terms-of-use): limited, revocable licence to use, "
           "reproduce and redistribute; credit BC Transit as the source; no BC Transit marks or implied endorsement; as is.")
ATTRIBUTION = "Schedule and real-time data: BC Transit (GTFS / GTFS-Realtime). Weather: Open-Meteo (CC BY 4.0). Map data: OpenStreetMap contributors (ODbL)."

MAIN = "95"
# Comparison routes. 61 Sooke shares the Trans-Canada Hwy / Douglas St corridor with Blink (same lanes, local
# stopping pattern); 4, 14 and 15 are Frequent Transit Network routes in the urban core.
COMPARE = ["61", "4", "14", "15"]
ROUTES = [MAIN] + COMPARE
ROUTE_IDS = {r: f"{r}-VIC" for r in ROUTES}

# Collector politeness: never poll faster than every 30 s (both realtime feeds are fetched back to back each tick).
MIN_INTERVAL = 30
DEFAULT_INTERVAL = 30
ALERT_EVERY = 300                     # service alerts change rarely
FLUSH_EVERY = 120                     # seconds of buffered rows before an append to disk (a hard kill loses at most this)
MAX_BACKOFF = 600
TU_WINDOW = 120                       # keep trip-update stop rows whose predicted time is within ±2 min of the poll
TU_ROUTES = [MAIN]                    # stop-level trip updates (a cross-check on GPS times) only for route 95

# Metrics
ON_TIME_EARLY = 60                    # on time = departs no more than 1 min early ...
ON_TIME_LATE = 300                    # ... and no more than 5 min late (common North American definition)
BUNCH_RATIO = 0.25                    # a headway under 25% of the scheduled one counts as bunched ...
BUNCH_ABS = 120                       # ... or under 2 minutes, whichever is larger
GAP_RATIO = 1.5                       # a headway over 150% of scheduled is a gap
FREQUENT_HEADWAY = 15 * 60            # excess wait time is reported where the scheduled headway is <= 15 min
MAX_OFFROUTE_M = 150                  # positions farther than this from the trip's shape are ignored

# Weather: Open-Meteo, Langford-to-downtown midpoint (View Royal)
LAT, LON = 48.452, -123.435

# Model gating: below this the code runs but reports what it still needs
MODEL_MIN_DAYS = 14
MODEL_MIN_WET_DAYS = 3
