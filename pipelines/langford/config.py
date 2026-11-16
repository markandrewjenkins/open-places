"""Langford Boom Tracker configuration (project key `langford`).

Two kinds of source, kept apart all the way to the published JSON:

* OPEN: BC Stats building permits (OGL-BC), BC Stats population estimates (OGL-BC), Statistics Canada 2021 census
  profile (OGL-C). These feed langford.json and backtest.json, which can be published as they are.
* UNLICENSED: City of Langford Development Tracker and ORTHOS aerial photos (no licence stated). Everything derived
  from them goes only into tracker.json and orthos.json, each flagged `"langford_unlicensed": true`, so the page can
  ship without them. The owner will ask the City before publishing anything built on these.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "langford" / "raw"
OUT = ROOT / "site" / "public" / "data" / "langford"

# ----------------------------------------------------------------------------- open sources
CKAN = "https://catalogue.data.gov.bc.ca/api/3/action/package_show"

# BC Stats "Building Permits (BPER)": monthly CSVs by census subdivision, Jan 2018 onward ($000 for values).
BPER_PACKAGE = "building-permits-bper-"
BPER_RESOURCES = {                      # local key → resource name prefix in the catalogue (IDs can change; names rarely do)
    "value_total": "Total Value, Building Permits, Monthly",
    "value_res": "Residential Value, Building Permits, Monthly",
    "value_ind": "Industrial Value, Building Permits, Monthly",
    "value_com": "Commercial Value, Building Permits, Monthly",
    "value_inst": "Institutional and Government Value, Building Permits, Monthly",
    "units_total": "Residential Total Units, Building Permits, Monthly",
    "units_single": "Residential Single Units, Building Permits, Monthly",
    "units_row": "Residential Row Units, Building Permits, Monthly",
    "units_apt": "Residential Apartment Units, Building Permits, Monthly",
}

# BC Stats sub-provincial population estimates (July 1) and projections, by municipality.
POP_PACKAGE = "bc-sub-provincial-population-estimates-and-projections"
POP_RESOURCE = "Municipalities (Census Subdivisions)"

# Statistics Canada 2021 Census Profile, SDMX REST (no key). Characteristics 1–7: population 2021, population 2016,
# % change, total private dwellings, dwellings occupied by usual residents, density per km², land area km².
CENSUS_SDMX = "https://api.statcan.gc.ca/census-recensement/profile/sdmx/rest/data/STC_CP,{flow}/A5.{geos}.1.1+2+3+4+5+6+7.1"
CENSUS_CHARS = {1: "pop_2021", 2: "pop_2016", 3: "pct_change", 4: "dwellings", 5: "dwellings_occupied",
                6: "density_km2", 7: "land_km2"}

# Comparison set: key → (label, StatCan SGC code, BC Stats population region code).
# "crd" is the Capital Regional District (census division 5917); its BC Stats population is the sum of its CSDs.
GEOS = {
    "langford": ("Langford", "5917044", 17044),
    "colwood": ("Colwood", "5917041", 17041),
    "sooke": ("Sooke", "5917052", 17052),
    "victoria": ("Victoria", "5917034", 17034),
    "saanich": ("Saanich", "5917021", 17021),
    "crd": ("Capital Regional District", "5917", None),
    "bc": ("British Columbia", "59", 0),
}
CRD_PREFIX = "5917"                     # every CRD municipality's SGC code starts with this (league table)

# ----------------------------------------------------------------------------- unlicensed sources (City of Langford)
LANGFORD_ARCGIS = "https://arcex.langford.ca/server/rest/services"
TRACKER = f"{LANGFORD_ARCGIS}/Development_Tracker/Development_Applications/FeatureServer/0"
ORTHOS_FOLDER = f"{LANGFORD_ARCGIS}/ORTHOS"
ARCGIS_INTERVAL = 1.0                   # seconds between calls to arcex.langford.ca (a small municipal server)

# Fields never stored, even locally: parcel identifiers and assessment roll numbers add nothing to the dashboard.
TRACKER_DROP = ["PID", "Parcel", "RollNumber", "CivID", "Civ_ID", "Maplink", "POINT_Z", "POINT_M", "TypeDescription"]

# Ortho thumbnails per hotspot and year (local cache, used to measure vegetation loss; never published as images).
THUMB_PX = 256
THUMB_HALF_M = 300                      # half-width of each hotspot box, metres (a 600 m square)

# Growth hotspots for the before/after swipe. Chosen from the Development Tracker (2024–26 new-construction
# valuation and unit counts within ~400 m) plus BC Stats context and the 2007 vs 2025 orthos; lon/lat WGS84.
# `before`/`after` are suggested swipe years (both verified to have imagery here).
HOTSPOTS = [
    {"id": "downtown", "name": "Downtown core (Goldstream–Hockley)", "lon": -123.5036, "lat": 48.4480, "before": 2007, "after": 2026},
    {"id": "city_gate", "name": "City Gate (Millstream, by Hwy 1)", "lon": -123.5035, "lat": 48.4630, "before": 2007, "after": 2026},
    {"id": "westhills", "name": "Westhills", "lon": -123.5519, "lat": 48.4492, "before": 2007, "after": 2026},
    {"id": "jacklin_rita", "name": "Jacklin Rd – Rita Rd", "lon": -123.5107, "lat": 48.4474, "before": 2007, "after": 2026},
    {"id": "happy_valley", "name": "Happy Valley – Olympic View (south)", "lon": -123.5195, "lat": 48.4134, "before": 2007, "after": 2026},
    {"id": "skirt_mtn", "name": "Skirt Mountain / Bear Mountain slopes", "lon": -123.5268, "lat": 48.4571, "before": 2007, "after": 2026},
    {"id": "florence_north", "name": "North of Florence Lake (Madrona–Kingbird)", "lon": -123.5010, "lat": 48.4707, "before": 2007, "after": 2026},
    {"id": "westshore_pkwy", "name": "West Shore Parkway at Sooke Rd", "lon": -123.5442, "lat": 48.4292, "before": 2007, "after": 2026},
    {"id": "isabell_luxton", "name": "Glen Lake south (Isabell–Lodmell)", "lon": -123.5262, "lat": 48.4313, "before": 2007, "after": 2026},
]

LICENCES = {
    "bper": {"name": "Open Government Licence – British Columbia", "url": "https://www2.gov.bc.ca/gov/content?id=A519A56BC2BF44E4A008B33FCF527F61",
             "credit": "Adapted from Statistics Canada, Building Permits (BPER), via BC Stats. This does not constitute an endorsement by Statistics Canada of this product."},
    "population": {"name": "Open Government Licence – British Columbia", "url": "https://www2.gov.bc.ca/gov/content?id=A519A56BC2BF44E4A008B33FCF527F61",
                   "credit": "BC Stats, Sub-Provincial Population Estimates and Projections"},
    "census": {"name": "Open Government Licence – Canada", "url": "https://open.canada.ca/en/open-government-licence-canada",
               "credit": "Statistics Canada, 2021 Census of Population, Census Profile"},
    "tracker": {"name": None, "note": "No licence stated by the City of Langford. Local use only until the City agrees."},
    "orthos": {"name": None, "note": "No licence stated by the City of Langford. Local use only until the City agrees."},
}
