"""Dark Sky Finder configuration."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "darksky" / "raw"
OUT = ROOT / "site" / "public" / "data" / "darksky"

# Night-light composites come from NASA GIBS (VIIRS SNPP Black Marble VNP46A2, gap-filled,
# BRDF/moonlight-corrected daily radiance). The GIBS rendering is an 8-bit display stretch,
# so values are a monotonic radiance *index*, not calibrated nW·cm⁻²·sr⁻¹.
GIBS_WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
GIBS_LAYER = "VIIRS_SNPP_GapFilled_BRDF_Corrected_DayNightBand_Radiance"
COMPOSITE_DATES = ["03-15", "04-15", "05-15", "08-15", "09-15", "10-15", "11-15"]
COMPOSITE_YEARS = [2014, 2025]
RES_DEG = 0.01           # ~1 km grid for the radiance composite

# Training domain: western North America, where Globe at Night observations are plentiful.
TRAIN_BBOX = (30.0, -130.0, 56.0, -104.0)       # south, west, north, east

# Map views (south, west, north, east)
VIEWS = {
    "bc": {"name": "British Columbia", "bbox": (48.2, -129.5, 55.5, -114.0), "center": (-123.6, 49.4), "zoom": 6.2},
    "az": {"name": "Arizona", "bbox": (31.3, -114.9, 37.05, -109.0), "center": (-111.7, 34.2), "zoom": 6.3},
}

GAN_YEARS = range(2014, 2026)

# Curated stargazing sites: certified dark-sky places plus popular local spots.
# (name, lon, lat, view, kind, note)
SITES = [
    ("Cattle Point Urban Star Park", -123.2963, 48.4500, "bc", "RASC Urban Star Park", "Oak Bay waterfront, Greater Victoria"),
    ("Dominion Astrophysical Observatory", -123.4170, 48.5194, "bc", "Observatory", "Saanich — public star parties in summer"),
    ("East Sooke Regional Park", -123.6770, 48.3500, "bc", "Regional park", "Dark southern horizon over the Strait"),
    ("Jordan River", -124.0500, 48.4210, "bc", "Coastal", "West coast road, Juan de Fuca"),
    ("Pacific Rim (Long Beach)", -125.7500, 49.0450, "bc", "National park reserve", "Open Pacific horizon"),
    ("Strathcona Park (Buttle Lake)", -125.5950, 49.7100, "bc", "Provincial park", "Mountain valley, very dark"),
    ("McDonald Park", -122.4090, 49.0700, "bc", "RASC Dark-Sky Preserve", "Abbotsford, Fraser Valley"),
    ("Cypress Mountain", -123.2040, 49.3960, "bc", "Mountain", "Above Vancouver's glow"),
    ("Golden Ears Park", -122.4650, 49.3150, "bc", "Provincial park", "Alouette Lake"),
    ("Manning Park", -120.7850, 49.0630, "bc", "Provincial park", "Lightning Lake, popular with astronomers"),
    ("Mount Kobau", -119.6720, 49.1140, "bc", "Star party site", "Osoyoos — Mount Kobau Star Party"),
    ("Kalamalka Lake", -119.2830, 50.1960, "bc", "Provincial park", "North Okanagan"),
    ("Wells Gray Park", -120.2000, 51.9500, "bc", "Provincial park", "Clearwater Valley"),
    ("Kootenay National Park", -116.0500, 50.8000, "bc", "National park", "Rockies"),
    ("Yoho National Park", -116.4800, 51.4000, "bc", "National park", "Emerald Lake area"),
    ("Flagstaff", -111.6513, 35.1983, "az", "International Dark Sky City", "World's first, 2001"),
    ("Lowell Observatory", -111.6646, 35.2029, "az", "Observatory", "Flagstaff — where Pluto was found"),
    ("Grand Canyon (South Rim)", -112.1130, 36.0570, "az", "International Dark Sky Park", ""),
    ("Sedona", -111.7610, 34.8697, "az", "International Dark Sky Community", ""),
    ("Sunset Crater & Wupatki", -111.4000, 35.3650, "az", "International Dark Sky Park", ""),
    ("Petrified Forest NP", -109.7820, 34.9100, "az", "International Dark Sky Park", ""),
    ("Kartchner Caverns SP", -110.3500, 31.8370, "az", "International Dark Sky Park", ""),
    ("Oracle State Park", -110.7330, 32.6100, "az", "International Dark Sky Park", ""),
    ("Kitt Peak", -111.5990, 31.9583, "az", "Observatory", "National Observatory"),
    ("Organ Pipe Cactus NM", -112.8740, 31.9550, "az", "International Dark Sky Park", ""),
    ("Tonto Natural Bridge SP", -111.4530, 34.3230, "az", "International Dark Sky Park", ""),
    ("Big Lake (White Mountains)", -109.4100, 33.8760, "az", "High country", "Very dark, 2,750 m"),
    ("Phoenix (downtown)", -112.0740, 33.4484, "az", "City", "For comparison"),
    ("Vancouver (downtown)", -123.1207, 49.2827, "bc", "City", "For comparison"),
    ("Victoria (downtown)", -123.3656, 48.4284, "bc", "City", "For comparison"),
]

# Towns for the "getting brighter" ranking (approximate centres).
TOWNS = [
    ("Victoria", -123.366, 48.428, "bc"), ("Langford", -123.505, 48.450, "bc"), ("Sooke", -123.726, 48.374, "bc"),
    ("Sidney", -123.400, 48.650, "bc"), ("Duncan", -123.708, 48.778, "bc"), ("Nanaimo", -123.940, 49.166, "bc"),
    ("Parksville", -124.312, 49.319, "bc"), ("Courtenay", -124.995, 49.687, "bc"), ("Campbell River", -125.244, 50.024, "bc"),
    ("Port Alberni", -124.806, 49.234, "bc"), ("Tofino", -125.907, 49.153, "bc"), ("Vancouver", -123.121, 49.283, "bc"),
    ("Surrey", -122.849, 49.191, "bc"), ("Langley", -122.660, 49.104, "bc"), ("Abbotsford", -122.305, 49.050, "bc"),
    ("Chilliwack", -121.952, 49.158, "bc"), ("Squamish", -123.155, 49.702, "bc"), ("Whistler", -122.957, 50.116, "bc"),
    ("Kelowna", -119.496, 49.888, "bc"), ("West Kelowna", -119.583, 49.863, "bc"), ("Vernon", -119.272, 50.267, "bc"),
    ("Penticton", -119.593, 49.491, "bc"), ("Kamloops", -120.327, 50.674, "bc"), ("Prince George", -122.749, 53.917, "bc"),
    ("Cranbrook", -115.768, 49.512, "bc"), ("Nelson", -117.295, 49.493, "bc"), ("Williams Lake", -122.141, 52.141, "bc"),
    ("Phoenix", -112.074, 33.448, "az"), ("Mesa", -111.831, 33.415, "az"), ("Gilbert", -111.789, 33.353, "az"),
    ("Queen Creek", -111.634, 33.249, "az"), ("Buckeye", -112.584, 33.370, "az"), ("Surprise", -112.368, 33.630, "az"),
    ("Maricopa", -112.048, 33.058, "az"), ("Casa Grande", -111.757, 32.880, "az"), ("Tucson", -110.975, 32.222, "az"),
    ("Marana", -111.225, 32.437, "az"), ("Flagstaff", -111.651, 35.198, "az"), ("Prescott Valley", -112.316, 34.610, "az"),
    ("Yuma", -114.628, 32.693, "az"), ("Lake Havasu City", -114.322, 34.484, "az"), ("Kingman", -114.053, 35.190, "az"),
    ("Sierra Vista", -110.303, 31.554, "az"), ("Show Low", -110.030, 34.254, "az"), ("Bullhead City", -114.568, 35.148, "az"),
]
