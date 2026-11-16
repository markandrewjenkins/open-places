# New open-data ideas: Victoria, Vancouver, Langford (checked 2026-11-11)

Everything below was fetched live without a login unless noted. Licences: OGL-C = Open Government Licence Canada,
OGL-BC = Open Government Licence British Columbia.

## Waves and tides
- **NOAA NDBC buoys** (text, hourly, no key): 46206 La Perouse Bank, 46087 Neah Bay / Cape Flattery (the best swell
  proxy for Jordan River and Sombrio), 46146 Halibut Bank, 46131 Sentry Shoal, 46132 South Brooks, 46304 English Bay.
  `ndbc.noaa.gov/data/realtime2/<id>.txt`. 46134 Pat Bay is not reporting.
- **MSC Datamart** moved to dated folders: `dd.weather.gc.ca/YYYYMMDD/WXO-DD/observations/swob-ml/marine/moored-buoys/…`
  (OGL-C), also available through the OGC API at `api.weather.gc.ca`.
- **DFO tides (IWLS API):** no key. Victoria Harbour 07120, Tofino 08615, Point Atkinson 07795.
- **Open-Meteo Marine:** swell height, period and direction, 7–8-day forecast, ERA5 history back to 1940. Non-commercial
  use, attribution required.
- Not available: a surf-spot dataset, a buoy at Jordan River itself, official surf reports.

## Golf
- **OpenStreetMap** course geometry: 20+ courses in Greater Victoria (Bear Mountain ×2, Cedar Hill, Gorge Vale,
  Royal Colwood, Olympic View…), with 184 holes, 420 bunkers and 40 water hazards mapped; 142 holes in Vancouver.
- **Vancouver parks-facilities** (Langara, Fraserview, McCleery, pitch-and-putt, disc golf).
- **Weather:** Open-Meteo, ECCC daily climate.
- Not available: tee times, prices, rounds played, course condition.

## Camping
- **BC Parks Data API** `bcparks.api.gov.bc.ca/api/park-operation-sub-areas` (capacity, reservable vs first-come
  sites, RV sites, seasons, advisories), OGL-BC.
- **Recreation Sites and Trails BC:** DataBC WFS layer `WHSE_FOREST_TENURE.FTEN_REC_SITE_POINTS_SVW`.
- **Parks Canada attendance** (annual CSV): Pacific Rim 1,173,986; Gulf Islands 24,837; Fort Rodd Hill 56,234 (2024-25).
- Not available: live campsite availability (no public API; scraping not recommended).

## Public services
- **Vancouver** (opendata.vancouver.ca, daily): 3-1-1 requests (1.33 million rows), building permits, washrooms,
  drinking fountains, off-leash dog areas, libraries, EV chargers, parking meters.
- **City of Victoria** (opendata.victoria.ca): development applications, building permits 2016–2025, traffic volume
  and speed, washrooms, fountains, playgrounds, garbage routes, tree canopy 2013/2019/2023.
- **Saanich** portal: opendata-saanich.hub.arcgis.com (contents not reviewed).
- **BC Transit Victoria** schedule feed (GTFS) and real-time vehicle and trip feeds, no key (operator 48; Langford
  Blink route 95 included).
- **TransLink** real-time needs a free key the owner must register for.
- **Air quality index:** `api.weather.gc.ca/collections/aqhi-observations-realtime`.
- **Vancouver police (VPD GeoDASH):** weekly, non-commercial use only.
- **Statistics Canada 35-10-0184:** crime counts per police service, incl. Langford RCMP.
- Not open: VicPD incident data, Island Health ER waits, official BC Ferries feed, beach water-quality downloads,
  CRD bike-counter exports.

## Langford
- **Development Tracker** (no licence stated):
  `arcex.langford.ca/server/rest/services/Development_Tracker/Development_Applications/FeatureServer/0`.
  472 applications from Jan 2024 to Oct 2026, with status, dates, valuation and building type.
- **Aerial photos 2007–2025:** `arcex.langford.ca/server/rest/services/ORTHOS/<year>_Orthos/MapServer` (no licence
  stated); CRD licensed aerial photos 2015–2025.
- **BC Stats building permits by municipality**, monthly Jan 2018 – Aug 2026 (OGL-BC): value and housing units.
- **Population:** BC Stats estimates and census counts. Langford grew 31.8% from 2016 to 2021 (35,342 → 46,584),
  fastest in BC.
- **DFO NuSEDS salmon counts:** Goldstream River chum 1953–2025, with huge swings (9,364 / 40,816 / 4,238 / 24,509 / 3,056).
- **Lake water:** Florence Lake sampled every two weeks May–Sept by Island Health (not downloadable).
- Before publishing anything built on the unlicensed Langford layers, ask the city (gis@langford.ca, address
  not verified).

## Dashboard ideas (interesting × feasible)
1. **West Coast Water:** a surf and wave go/no-go board for Jordan River, Sombrio and Tofino, plus calm-water windows.
   Forecasts are checked against the buoys at each lead time.
2. **Langford Boom Tracker:** permits and housing units, an application pipeline, aerial photos over time, and
   a seasonal housing-units forecast with month-by-month backtests.
3. **Golf Playability & Course Tier List:** playable hours from daylight, frost and rain, and a tier list from length,
   hazards and hilliness. No price or tee-time data exists.
4. **Goldstream Chum Run:** a stock-recruitment model (3- and 4-year-old fish) plus fall rain, tested by leaving one
   year out at a time; ties into Salish Sea, since the orcas feed on chum.
5. **Vancouver 3-1-1 Pulse:** request volume by category, forecast from weather and holidays.
6. **Blink 95 Reliability:** real-time feed logging over several weeks, then delay and bunching models.
7. **Shoulder-season camping planner** (extends Sunday Wander): climate comfort odds by month.
8. **West Shore Risk Lens** (insurance angle): crime trends + hazard layers + new homes in hazard zones.
