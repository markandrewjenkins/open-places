# Open Places

Interactive forecasting dashboards built only on free, open government and citizen-science data.
Each project pairs a reproducible data pipeline (Python) with a validated predictive model and a
static web front end (Vite + MapLibre + d3), refreshed daily by GitHub Actions.

| # | Project | Region | Status |
|---|---------|--------|--------|
| 01 | [Cherry Blossom Watch](site/blossom/) — cherry blossom forecasts for every public tree, plus a cultivar tier list | Greater Victoria, Vancouver Island, Vancouver | Live |
| 02 | [Dark Sky Finder](site/darksky/) — stargazing and aurora forecasts with a light-pollution model | BC, Arizona | Live |
| 03 | [Fire, Water & Rock](site/hazards/) — wildfire, river, earthquake and highway hazard twin | BC / Pacific Northwest | Live |
| 04 | [Snowpack to Tap](site/water/) — snowpack, Lake Powell/Mead projections, Colorado River inflow forecast, California reservoirs | California, Arizona, Colorado River | Live |
| 05 | [Salish Sea Live](site/salish/) — live hydrophones, whale sightings, shipping lanes, orca-call triage model | Salish Sea | Live |
| 06 | [Toronto City Pulse](site/toronto/) — Island ferry crowd forecast, live Bike Share, TTC delay patterns | Toronto | Live |
| 07 | [California Duck Curve](site/grid/) — demand / net-demand forecast scored against CAISO, duck curve, batteries | California | Live |
| 08 | [Fall Foliage Watch](site/foliage/) — fall-colour forecast for ~800k street trees, a colour tier list, day trips and 25 satellite autumns | Greater Victoria, Vancouver, Toronto & Ontario | Live |
| 09 | [Sunday Wander](site/sunday/) — every road rated for a relaxed outing by car, bike or on foot, with a trip planner and loop builder | Greater Victoria, Greater Vancouver | Live |
| 10 | [Langford Boom Tracker](site/langford/) — how fast BC's boomtown is building: permits and new homes against its neighbours, population growth and a backtested 12-month permit forecast | Langford, Greater Victoria | Ready (not yet published) |
| 11 | [Public Transit](site/blink/) — public transit wherever the feeds are open: every vehicle live on the map, the next departures near you, service alerts and how often every route runs, plus a Route 95 reliability spotlight for Langford and the West Shore | 35 BC Transit systems, Toronto, Calgary, Edmonton, Seattle, Sacramento, Boston, BART (live); Vancouver (timetables) | Live (relay redeploy pending); Route 95 collecting |
| 12 | [Fairway Forecast](site/golf/) — when you can play golf this week, course by course, an S–D course tier list from OpenStreetMap course maps and terrain, the best months to play, and a backtest of how far ahead to trust the forecast | Greater Victoria, Greater Vancouver | Ready (not yet published) |
| 13 | [Air Traffic](site/air/) — a live radar of what's flying overhead (5 / 15 / 40 km around you; next close pass, what you can probably hear, rare aircraft, a spotter log), arrivals and departures at Victoria International (YYJ) and the Harbour seaplane base, flying weather (METAR/TAF), runways and wind; live aircraft in its covered areas, airports and weather anywhere | Greater Victoria & Vancouver, Phoenix, Toronto, San Francisco, Los Angeles, San Diego (live aircraft); airports anywhere | Live (relay redeploy pending) |
| 14 | [Waterways](site/ships/) — ships, ferries, tugs and river traffic on a map (live once the relay has an AIS key, otherwise a real day of shipping replayed), the busiest hours on each stretch of water, cruise calls, live tides and the Fraser's flow against normal, and Canadian Coast Guard navigational warnings | Greater Victoria, Vancouver & the Fraser, Seattle | Ready (not yet published) |

## Design skins

Every page has its **Classic** design plus a themed alternative, switched with the button in the top bar. The choice is remembered across pages, and `?skin=alt` or `?skin=classic` in a URL forces it. Each skin has its own day and night versions.

| Page | Skin | Day / Night |
|---|---|---|
| Cherry Blossom Watch | Sakura.exe | Pastel Win95 desktop / "after hours" vaporwave |
| Dark Sky Finder | Planetarium | Indigo dome with chalk constellations by night / museum-gallery placards by day |
| Fire, Water & Rock | Field Ops | Field notebook with ICS forms / emergency operations centre |
| Snowpack to Tap | Hoover Deco | 1930s Bureau of Reclamation Art Deco / the dam at night |
| Salish Sea Live | Sonar Room | Nautical chart / submarine sonar console |
| Toronto City Pulse | Departure Board | Subway tile wall / platform at night, with a split-flap ferry board |
| California Duck Curve | Control Room | Engineering drawing / SCADA mimic board |
| Fall Foliage Watch | Kodachrome | Warm paper and Kodachrome red, set in Fraunces and Jost: a quiet film-era take on Classic |
| Sunday Wander | Road Atlas | Printed nature atlas: paper land, green parks, blue sea; quiet serif type and hairline rules |
| Langford Boom Tracker | Blueprint | Drafting vellum with hazard tape / cyanotype blueprint |
| Public Transit | Night Run | Sunrise highway in vaporwave pastels / outrun neon on an indigo night road |
| Fairway Forecast | Clubhouse | Scorecard card stock with a hand-hung leaderboard / the 19th hole after dark: green baize, cream and brass |
| Air Traffic | Flight Strip | Buff flight-progress strips and condensed type / a dim slate radar room with mono read-outs |
| Waterways | Chart Room | A paper nautical chart: cream paper, sounding-blue ink, IBM Plex / the chart table under a dimmed lamp: deep navy with one amber accent |

Each skin lives in `site/src/<page>/skin.css` (every rule scoped under `:root[data-skin="alt"]`) and an optional `skin.js` that builds extras such as live strips, the taskbar, the sonar plot and the mimic board. The extras only exist while the skin is on. `node tools/sweep.mjs http://localhost:5173/ <outDir> "?skin=alt"` checks every page for console errors and horizontal overflow.

## Publishing: one repo per dashboard

Each dashboard is published as its own repository and GitHub Pages site (e.g. `markandrewjenkins/cherry-blossom-watch` → https://markandrewjenkins.github.io/cherry-blossom-watch/). This folder stays the single source:

```bash
python tools/export_repos.py      # regenerate export/<repo>/ for every project (data files are add-only; --with-data to overwrite)
bash tools/push_repos.sh          # commit and push each one
```

## Layout

```
pipelines/            Python data pipelines, one package per project
  common/             shared HTTP + Environment Canada (MSC GeoMet) clients
  blossom/            fetch.py → model.py → build.py; cultivars.py (tiers), photos.py (cultivar photos)
  darksky/            fetch.py (Globe at Night, NASA GIBS night lights) → build.py (light-pollution model, map layers)
  toronto/            fetch.py (ferry counts, Bike Share trips, TTC delays) → build.py (demand models, delay patterns)
  grid/               fetch.py (CAISO Today's Outlook history, weather) → build.py (day-ahead models vs CAISO)
  salish/             fetch.py (Orcasound, OrcaHello, Acartia, iNaturalist, NOAA AIS, optional aisstream) → build.py
  water/              fetch.py (RISE, SNOTEL, CDEC) → build.py (snow indices, inflow model, analog lake projections)
  hazards/            fetch.py now|history → build.py (wildfire-starts model, river ranks, flood frequency, quake recurrence)
  ships/              fetch.py (NOAA AIS week, Coast Guard S-124 notices, Fraser at Hope) → build.py (typical week, lanes, replay day)
data/<project>/derived/  small committed artefacts (training tables, climatologies) so CI needn't re-download history
data/<project>/raw/   downloaded inputs (git-ignored, re-fetched by CI)
site/                 Vite multi-page static site
  public/data/<project>/   JSON produced by the pipelines
  src/shared/         design system (theme.css) and UI helpers
  <project>/index.html
tools/shot.mjs        headless screenshots for visual checks
.github/workflows/    daily refresh + GitHub Pages deploy
```

## Running locally

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # macOS/Linux: .venv/bin/pip
.venv/Scripts/python -m pipelines.blossom.fetch all
.venv/Scripts/python -m pipelines.blossom.build
cd site && npm install && npm run dev
```

## Cherry Blossom Watch: method in brief

- **Trees:** City of Vancouver *public-trees* (29.8k Prunus), City of Victoria *Tree Species* (5.5k) and the Township of Esquimalt tree map (953), mapped to 32 cultivars and six bloom groups. Areas without inventories show CC-licensed iNaturalist sightings.
- **Observed bloom dates:** Each year's median iNaturalist observation date per region and taxon, within the group's flowering window. Photos annotated as "no flowers" are excluded.
- **Weather:** ECCC daily climate, with station chains spliced after a monthly bias adjustment. Victoria runs from 1898 (Gonzales Heights → Gonzales CS).
- **Models:** Climatology, thermal time, chill-adjusted thermal time and a temperature-sensitivity regression, pooled across regions and selected by leave-one-year-out cross-validated MAE.
  - Japanese cherries borrow the best donor's temperature response, because their own index is too noisy to fit one.
- **Forecast:** An analog-weather ensemble from the last 30 seasons combined with the model's cross-validated residuals. The resulting 80% intervals cover 78–88% of outcomes in backtests.
- **Map modes:** colour trees by bloom chance (the default) or by cultivar tier (S–D, each tree icon lettered). Filter with a searchable checklist of individual cultivars, or with tier and group chips that tick or untick theirs. In the tier list, Somei-yoshino, Japan's reference hanami cherry, leads the S tier.
- **Trip planner:** walk, bike or drive routes through the cherries in bloom on the chosen date. Each street tree is attached to its nearest road segment from OpenStreetMap (BBBike extracts). Routes favour segments with more selected cultivars in bloom per 100 m, and include a loop builder and GPX / Google Maps export. The ready-made routes run through the streets whose best ~600 m is most densely lined with S- and A-tier cherries.

## Dark Sky Finder: method in brief

- **Night lights:** NASA Black Marble VNP46A2 (gap-filled, moonlight-corrected) daily radiance from the GIBS imagery service. I take the median of 7 dates for 2014 and 2025 on a ~1 km grid. The GIBS rendering is an 8-bit display stretch, so values are a radiance *index*.
- **Ground truth:** Globe at Night Sky Quality Meter readings, 2014–2025, across western North America (about 5.4k readings in 214 one-degree blocks).
  - Only clear skies with the sun 15° or more below the horizon are used.
  - UT is rebuilt from local time because the 2014–2022 releases carry a sign error in the UT field.
- **Models:** Gradient boosting with monotonic constraints. Features are the light index at the point, gaussian glow at 1–55 km, the brightest source within 25 km, and moonlight at the time of the reading. There is a median model for typical readings and an 80th-percentile model for good-night potential, validated with spatial block cross-validation against a one-feature baseline.
- **Live layers:** Computed in the browser. Cloud forecasts (ECCC GEM / NOAA via Open-Meteo), NOAA SWPC OVATION aurora and Kp, CelesTrak ISS elements, and Astronomy Engine for moon and twilight.
- **Refreshing:** The static layers need the raw composites (git-ignored, ~14 MB), so the model is rebuilt manually with `python -m pipelines.darksky.fetch all && python -m pipelines.darksky.build` rather than daily.

## Fire, Water & Rock: method in brief

- **Wildfire starts:** Daily new fires per BC Wildfire fire centre and cause, April–October 2000–2025 (≈42k fires).
  - Modelled with Poisson gradient boosting on the centre's ECCC station heat, rain (1/7/30 days), days since rain and a dryness index.
  - Leave-one-season-out validation against a centre × week climatology. Deviance explained is 52% vs 31% for lightning fires and 24% vs 14% for people-caused fires.
  - The current season is a true out-of-sample test. The 7-day outlook runs on ECCC GEM forecasts.
- **Rivers:** The latest real-time reading at ~430 gauges is ranked against that gauge's 1991–present daily means within ±7 days of the date.
- **Floods:** Gumbel fits to pre-2021 water-year annual maxima, with bootstrap ranges, give return periods for the November 2021 atmospheric-river peaks. A GEV fit is kept as a sensitivity check.
- **Earthquakes:** Gutenberg–Richter recurrence (Aki–Utsu b-value, magnitude of completeness by maximum curvature + 0.2) from the USGS catalogue since 1970, with 50-year Poisson odds.
- **Refreshing:** `fetch now` + `build` daily. `fetch history` + `build --retrain` occasionally rebuild the derived tables.

## Snowpack to Tap: method in brief

- **Snow index:** Σ SWE / Σ 1991–2020 median SWE for the day (NRCS-style) across long-record SNOTEL sites in the Upper Colorado (HUC 14) and the Sierra.
- **Inflow forecast:** Log April–July unregulated inflow to Lake Powell, regressed on the snow index, the water-year precipitation index and the previous autumn's baseflow, with one model per issue date (Jan 1 → May 1).
  - Validated leave-one-year-out, 1987–2026.
  - April 1: R² 0.70, mean absolute error 1.28 MAF vs 2.60 MAF for climatology. Nested 80% intervals cover 75%.
- **Lake projections:** An analog ensemble of 2000–2025 storage changes applied to today's storage and converted with each lake's recent storage–elevation curve. The output is the odds of crossing the 2007-guideline tier lines and Powell's minimum power pool.
- **California:** CDEC daily storage for the 12 largest reservoirs against their 1991–2020 average for the date.
- **Journey map:** One map from snowpack to taps, built into `site/public/data/water/map.json` (~130 KB) by `build.py`.
  - Each long-record SNOTEL site is coloured by SWE as a share of its own 1991–2020 median for the day (7-day smoothed), for the latest day and for the last April 1. Sites whose median is under 1″ count as out of season. The tooltip sparkline shows the season against the median.
  - Reservoirs are cups filled to storage/capacity, with a bar at the 1991–2020 average for the date. Powell and Mead come from RISE. Their dam coordinates and full-pool capacities are in `config.py`, with a source note.
  - The scenario slider is shared with the inflow forecaster. Across the analog years, next summer's peak Powell storage is regressed on that spring's April–July inflow (R² ≈ 0.9). The fit then gives the forecast inflow's peak level, with operations baked in as for the projections.
  - Geometry is fetched once by `python -m pipelines.water.fetch geo` and simplified with Douglas–Peucker in the build:
    - basins: USGS Watershed Boundary Dataset (HUC 14, 15, 1802, 1804), from the National Map `wbd` MapServer;
    - rivers: Natural Earth 1:10m;
    - aqueducts: OpenStreetMap waterway relations through Overpass (California Aqueduct, Colorado River Aqueduct, Central Arizona Project).

## Salish Sea Live: method in brief

- **Area:** 47–51° N, 122–128.6° W: all of Vancouver Island (west coast and Johnstone Strait included), the whole Strait of Georgia, Juan de Fuca and Puget Sound. Every source that takes a bounding box uses it (`pipelines/salish/config.py`).
- **Live audio:** The Orcasound hydrophones (from Orcasound's feed list) stream as HLS straight from their public S3 bucket into the page (hls.js), with a Web Audio spectrogram.
  - Eleven other hydrophones are shown as map points with links: SIMRES (Saturna), Raincoast (Pender), OrcaLab (Hanson Island, Robson Bight), JASCO/ECHO (Boundary Pass) and Ocean Networks Canada.
  - ONC audio needs an account and token, so it's linked, not fetched. Positions marked approximate are read off operators' descriptions.
- **Freshness:** `fetch.py` runs each source on its own and records success, failure and the newest record in `data/salish/raw/status.json`. In CI a failure becomes a `::warning` annotation. The page shows when the pipeline ran and each source's newest record.
  - Why this exists: from 6 to 11 November 2026 the page was stuck on 5 November data. An Acartia record arrived with its count and coordinates as strings, pyarrow refused to write the mixed column, and the step's `set -e` stopped the build. `continue-on-error` hid the failure.
- **Sightings:** Acartia's public endpoint serves only the current week, so runs are merged into `sightings.json`, a rolling one-year archive that starts 6 October 2026 (back-filled from this repo's history). iNaturalist adds the last 120 days of cetacean observations. The map's date range runs up to today.
- **Ships:** The latest 14 days of US Coast Guard AIS from NOAA/BOEM Marine Cadastre. Since 2025 these are daily `.csv.zst` files of about 320 MB each, streamed and filtered with pyarrow's zstd codec, so no new dependency.
  - Tracks are simplified (Douglas–Peucker, about 40 m) and delta-encoded into one `ships/<day>.json` per day, about 0.6 MB each, which the page loads on demand. A checklist filters seven vessel types.
  - Coverage is US receivers only, so it is thin north of Nanaimo and essentially absent in Johnstone Strait and off the west coast. The page reports vessels per day by region and says so.
  - Set the `AISSTREAM_API_KEY` repository secret to add a live snapshot from aisstream.io (free account required). Without it, "today" says so and shows no ships.
- **Whale-sound tier list:** An editorial 0–100 score for the last 30 days of OrcaHello encounters and Orcasound listener events: verification 30, AI confidence 20, species 20 (Southern Resident > other orca > humpback > unknown), clarity 15, corroboration 10, recency 5. Tiers are S 85+, A 70+, B 55+, C 40+, D below.
  - OrcaHello clips play their WAV. Listener events replay about 30 s of Orcasound's HLS archive around the moment the button was pressed.
- **Hearing outlook:** Weekly logistic regression on season and recent whale reports in the Orcasound app, which include AI detections posted there.
  - Validated on 2025–2026 against two baselines.
  - It's only a few percent better than "this hydrophone's recent frequency", and the page says so.
- **Triage model:** A gradient-boosted second-stage classifier on OrcaHello detections. It predicts the volunteer verdict from AI scores plus network context, with a time split (2020–24 train, 2025–26 test) against ranking by AI confidence alone.
  - OrcaHello runs on a small Azure app, so the full crawl is slow, resumable and done locally, never in CI. CI fetches only the last week (about 5 pages). The crawler now re-fetches a short last page instead of trusting it, which had frozen the clips at September 2026.
  - The context features (hourly windows) are computed in true seconds. Under pandas 3 they had been off by 1,000× because timestamps are stored in microseconds.
  - Result on 12,504 reviewed detections (November 2026 rebuild): AUC 0.806 vs 0.623 for AI confidence alone. To catch 95% of real calls, volunteers would review 70% of flags instead of 87%.
  - "Season" carries most of the signal, then "strongest segment", the hydrophone, and network activity in the last two hours.
  - The earlier figures (AUC 0.729, 80% vs 89%) came from the mis-scaled windows and fewer detections.
- **Privacy:** Moderator identities, free-text comments, listener descriptions and reporter names are dropped at fetch time.

## Toronto City Pulse: method in brief

- **Island ferry:** Poisson gradient boosting on daily riders (ticket redemptions, 2015–), with weather, Ontario holidays, season, school break and the ridership level 1–5 weeks earlier.
  - Tested on 2025–26: mean absolute error ≈1,010 riders vs 1,560 for same-weekday-same-month, R² 0.88.
  - Intervals are calibrated on the first half of the test period and checked on the second (71% inside the 80% band).
- **Bike Share:** The same approach on daily trips (2023–). It's 14% better than the baseline, a modest gain stated as such. Live station availability comes from GBFS in the browser.
- **TTC:** Subway delay log 2022–, decoded with the TTC's incident codes.

## California Duck Curve: method in brief

- **Forecast:** Hourly gradient boosting for gross demand and net demand (demand − solar − wind).
  - Inputs: calendar, temperature at six load centres, solar radiation and cloud over the Mojave and Central Valley, wind, and load from 2 and 7 days earlier.
  - Trained 2020 → June 2025, tested since July 2025, with gross demand scored against CAISO's own day-ahead forecast.
  - Result (Jul 2025 – Oct 2026): 3.1% hourly error vs 2.0% for CAISO's day-ahead forecast, and 2.6× better than "same hour last week". Net demand: ±1.5 GW vs ±3.2 GW for the same baseline.
- **Stories:** The spring weekday duck curve by year, battery charge/discharge profiles by year, the latest day's fuel mix, and renewable share.
  - The yearly minimum of hourly net demand fell from +4.7 GW (2020) to −8.9 GW (20 June 2026).
- **Data:** CAISO "Today's Outlook" daily files, cached one per day (about 4,900 files). Header capitalisation changes across years, so columns are normalised per file.

## Fall Foliage Watch: method in brief

- **Satellite autumns:** NASA MODIS MCD12Q2 mid-green-down dates (2001–2025), the median of a 5 × 5 km window per place, fetched from the ORNL DAAC subset service (no login). Places with year-to-year scatter above ±9 days are dominated by summer-dry grass or evergreen forest and aren't modelled; Victoria, Cowichan and the Fraser Valley fall into this group.
- **Timing model:** each place's typical date, shifted +1.8 days per °C of September warmth, with one slope shared by every place. Tested by leaving each year out: ±3.55 days against ±3.79 for the typical date. A cold-degree-day senescence model, August windows and a linear trend all did no better and were dropped. Victoria borrows Vancouver's typical date and slope, applied to its own September.
- **Street-tree colour:** iNaturalist "Leaves" annotations (green / coloured / leafless) are aligned on each year's green-down. They give when colour starts, how widely trees of one species vary (±15 days), and per-species shifts shrunk toward horticultural priors. Leaf fall is set ~24 days after each tree's colour onset (ground phenology), because people rarely photograph bare trees. The page shows observers' last-three-weeks share against the model's as a live check.
- **Map:** ~800k deciduous trees from the Victoria, Esquimalt, Vancouver and Toronto inventories, split into ~1 km JSON tiles that load as you pan, with species-mix squares when zoomed out. A searchable checklist picks individual species (tier chips act as presets), and the squares fade where few of the chosen trees grow.
- **Day trips:** in a closed forest canopy the satellite's half-way green-down falls close to peak colour, so trip cards use it directly.
- **Trip planner:** walk, bike or drive routes through the trees in colour on the chosen date, in Victoria, Vancouver and Toronto. Routes favour road segments with more selected species showing colour per 100 m, and include a loop builder and GPX / Google Maps export. The ready-made routes follow the streets most densely lined with S- and A-tier colour trees.

## Sunday Wander: method in brief

- **Network:** Every road and path from OpenStreetMap, read from BBBike's weekly city extracts (Overpass is the fallback). Ways are split at intersections, and access and one-way rules are worked out separately for cars, bikes and walking (`pipelines/common/roadgraph.py`).
- **Ingredients per road segment (0–100):**
  - water views: line of sight over the Copernicus GLO-30 surface model (buildings and trees block it) to the sea, or to lakes and rivers over 2 ha, in 24 directions up to 2 km; "next to the water" is a separate, smaller ingredient, and ponds and wetlands don't count;
  - parks and forest within ~60 m, and farmland within ~100 m;
  - street trees from the city inventories;
  - sights: viewpoints, heritage places, lighthouses, and Wikidata landmarks with a heritage designation or a Wikipedia article;
  - stops: ice cream, cafés, bakeries, farm stands, picnic sites, beaches, washrooms;
  - "slow and wide": posted speed and lanes, where 50 km/h on two lanes is best; winding local roads through forest count as narrow;
  - traffic signals and stop signs per km, and gentle curves (sinuosity);
  - cycling infrastructure for bikes, and quiet streets for walking;
  - industrial land counts against.
- **Score and tiers:** a weighted mix that viewers can re-weight live. Tiers are by share of road length: S is the top 5%, then A 10%, B 15%, C 20% and D the rest. There is no ground truth for "a nice drive", so this is a transparent recipe, not a trained model.
- **Routing (in the browser):** A* and Dijkstra over the network. Each second on a road costs extra in proportion to how low that road ranks, and the Direct ↔ Scenic slider sets how much. The loop builder routes start → two high-ranked stretches → start, trying the pairs whose triangle fits the target time. Routes export as GPX or a Google Maps link.
- **Ready-made routes:** editorial picks of local classics, routed and rated with the same recipe (`pipelines/sunday/routes.py`).

The same planner (`site/src/shared/planner.js`, `route.js`) appears in **Cherry Blossom Watch** and **Fall Foliage Watch**. There, every street tree is attached to its nearest road segment, so a route is scored by the selected trees forecast to be in bloom (or in colour) on the chosen date. Their ready-made routes are data-driven: the streets whose best ~600 m is most densely lined with S- and A-tier trees, grouped by neighbourhood (`pipelines/common/treetrips.py`).

All data is published under open licences (OGL-Canada, OGL-Vancouver, OGL-Victoria, OGL-Toronto; NASA data is public domain). iNaturalist observations remain © their observers.

## Langford Boom Tracker: method in brief

- **Permits:** BC Stats monthly building permits by municipality (BPER, January 2018 onward): permit values and new housing units for Langford, Colwood, Sooke, Victoria, Saanich and the CRD. Suppressed counts ("x") stay missing, so 12-month sums that include them are flagged as lower bounds.
- **Growth:** BC Stats July 1 population estimates and projections, with the 2016 and 2021 census counts from the Statistics Canada census profile API. Langford grew 31.8% between the censuses, the fastest in the Capital Region.
- **Forecast:** the headline is the trailing 12-month mean, carried forward. A seasonal variant (that level × a CRD-wide monthly pattern) is shown for comparison; permit seasonality is too weak to help, and one apartment permit can dominate a month.
  - Scored by rolling-origin backtests (every month since December 2020 is an origin, 750 forecast–actual pairs). Langford units: mean absolute error 71 homes a month for the 12-month mean, 73 seasonal, 100 for "same month last year". Nothing was tuned on the test period.
  - The 80% range comes from backtest errors and was checked out of sample (77% inside).
- **City of Langford layers (local preview only):** the Development Tracker (pipeline stages, Kaplan–Meier stage timings, a map) and the City's aerial photos (a then-and-now swipe and hotspots, 2007–2026) have no stated licence. They are written to separate files (`tracker.json`, `orthos.json`), are not fetched by the daily workflow, and the page works without them.

Permits and population: Open Government Licence – British Columbia (adapted from Statistics Canada; not an endorsement). Census: Open Government Licence – Canada.

## Public Transit: method in brief

Public transit wherever an agency publishes open data that needs no key or account. The internal project key is `blink` (the page started as Route 95 Reliability, which is now its Greater Victoria set piece).

- **Agencies:** all 35 BC Transit systems (Victoria, Kelowna, Nanaimo, Kamloops, the Fraser Valley and 30 more), TTC (Toronto), Calgary Transit, Edmonton Transit Service, King County Metro (Seattle), SacRT (Sacramento), the MBTA (Boston) and BART (predictions and alerts; it publishes no train positions), plus TransLink's timetables (its live feed needs a key). Feeds that need a free key are listed in `pipelines/blink/agencies.py` and left out (the owner's choice): TransLink realtime, Sound Transit (OneBusAway Puget Sound), 511 SF Bay (Muni, AC Transit, Caltrain…), LA Metro, Las Vegas RTC and NCTD (Swiftly), San Diego MTS, TriMet; Valley Metro's live URL carries a shared key and Tucson has no open feed.
- **Timetables:** `python -m pipelines.blink.static` downloads each agency's static GTFS politely (only when it has changed, by ETag / Last-Modified, weekly for BC Transit, whose server sends no validators; 2 s between requests to a host) and summarises it into `site/public/data/blink/agencies/<agency>/`: routes with one simplified line per direction (15 m Douglas–Peucker, delta-encoded), and for every stop and route-direction the departures, first and last times and the median gap in the peaks (7–9 am, 3–6 pm), midday and evening on a typical weekday, Saturday and Sunday (the days in the next two weeks with the most service). Full timetables aren't republished; "about every 10 min" is an estimate from those gaps.
- **Live:** GTFS-Realtime feeds send no CORS headers, so the page reads them through the relay (`workers/bct-relay`, a Cloudflare Worker): `/rt/<agency>/vehicles.json`, `alerts.json` and `trips.json` (or the raw `trips.pb` for big agencies, decoded in the browser to stay inside the Worker's 10 ms CPU budget). It only fetches agencies on its allow-list and caches each upstream feed for 15–30 s however many people are watching.
- **Page:** a live map (generic side-view icons by mode in the route's own colour; Victoria keeps its double-deckers for route 95), next departures near the region centre, an Open Places place or your location (asked only when you press the button), service alerts, and the network by frequency and hour. The Route 95 spotlight shows only for Greater Victoria, and inlaid in Open Places only for Langford, the West Shore (Colwood, View Royal, Highlands, Metchosin, Sooke) and the CRD as a whole.

Route 95 spotlight:

- **Route:** BC Transit's route 95 Langford / Downtown Blink, Greater Victoria's rapid bus, with routes 61 (same corridor, local stops), 4, 14 and 15 measured the same way for comparison. The internal project key is `blink`.
- **Log:** a collector (`python -m pipelines.blink.collect`) polls BC Transit's open GTFS-Realtime vehicle positions, trip updates and alerts every 30 s and writes daily files (csv.gz while a day is open, parquet once it closes). It runs on an always-on machine, not in the daily workflow, and resumes and dedupes after a restart.
- **Stop times from GPS:** each position is projected onto its trip's shape, and the moment the bus reached each stop is interpolated between the positions either side (brackets over 4 minutes are dropped). These agree with the feed's own times to a median of about 10 s.
- **Metrics:** on time = leaving a timepoint between 1 minute early and 5 minutes late (trip origins excluded); bunched = a gap under a quarter of the scheduled headway (or 2 minutes); excess wait = actual minus scheduled average wait, Σh²/2Σh, in hours with a bus every 15 minutes or better; time lost = segment run time minus scheduled. Headways are only measured inside continuously watched stretches (no poll gap over 150 s).
- **Bus lanes:** OpenStreetMap `bus:lanes` / `lanes:bus` and dedicated busway tags (BBBike extract), matched to each stop-to-stop segment, give the share of each segment with a bus lane.
- **Model:** shrunken cell means of delay and excess wait by direction × time of day × day type × wet/dry hour (Open-Meteo), backed off to coarser cells, tested by leaving one service day out against the timetable and a time-of-day average. It switches itself on after 14 service days including 3 wet ones; until then the page shows it as collecting.
- **Honesty with thin data:** every figure shows the departures, headways or hours behind it, and anything below a minimum sample is greyed and marked "collecting". The live map is the latest logged poll plus a one-hour replay, because BC Transit's real-time server can't be read from a web page.

Credits (each agency's terms ask for these; this project is independent and endorsed by none of them):
- BC Transit (GTFS and GTFS-Realtime), under the [BC Transit GTFS Data Terms of Use](https://www.bctransit.com/open-data/terms-of-use).
- TTC: contains information licensed under the [Open Government Licence – Toronto](https://open.toronto.ca/open-data-licence/).
- Calgary Transit: contains information licensed under the [Open Government Licence – City of Calgary](https://data.calgary.ca/stories/s/u45n-7awa/).
- Edmonton Transit Service: contains data from the [City of Edmonton Open Data Terms of Use](https://www.edmonton.ca/sites/default/files/public-files/assets/Web-version2.1-OpenDataAgreement.pdf).
- King County Metro: transit scheduling, geographic, and real-time data provided by permission of King County ([terms](https://kingcounty.gov/en/dept/metro/rider-tools/mobile-and-web-apps)).
- SacRT: data from Sacramento Regional Transit under its [data licence agreement](https://www.sacrt.com/transit-data-portal/).
- MBTA: data provided by MassDOT / MBTA under the [MassDOT Developers License Agreement](https://www.mass.gov/files/documents/2017/10/27/develop_license_agree_0.pdf).
- BART: schedule and real-time data under the [BART Developer License Agreement](https://www.bart.gov/schedules/developers/developer-license-agreement).
- TransLink: route and arrival data used in this product or service is provided by permission of TransLink. TransLink assumes no responsibility for the accuracy or currency of the Data used in this product or service.
- Route 95: weather from Open-Meteo (CC BY 4.0); bus lanes © OpenStreetMap contributors (ODbL). Basemap © OpenFreeMap, © OpenStreetMap contributors.

## West Coast Water (shelved 2026-11-13): method in brief

Shelved: not built, exported or refreshed. The code stays in `pipelines/waves` and `site/waves` so it can come back.


- **Where:** five surf beaches (Jordan River and Sombrio on the Juan de Fuca coast; Chesterman, Cox Bay and Long Beach at Tofino) and four paddling spots (Victoria waterfront, Inner Harbour & Gorge, English Bay & Kitsilano, False Creek & Deep Cove). The internal project key is `waves`.
- **Rating:** every daylight hour (civil dawn to dusk) gets 100 × size × period × direction × wind × tide, each factor 0–1 from the beach's own rule in `pipelines/waves/config.py`: swell height and peak period at its driver buoy (Neah Bay 46087 for Juan de Fuca, La Perouse Bank 46206 for Tofino), swell direction against the beach's window, wind against its offshore direction, and tide against a preferred band. Tiers: S 85+, A 70+, B 55+, C 40+. A GO day has 2+ daylight hours at B or better; a window is 2+ hours in a row at C or better. Calm water uses 100 × wind × gust × wave. The tide and swell preferences are surf-guide lore, unverified: there is no official surf report for these beaches.
- **Forecast:** Open-Meteo's marine API (best-match wave height and direction, ECMWF WAM peak period) and weather API (wind, gusts) at each driver buoy, plus DFO / CHS tide predictions, for 7 days. "Right now" uses the latest buoy report.
- **Backtest:** since 17 November 2025 the rule has been applied each day to what the buoys and shore wind stations recorded and to Open-Meteo's archived forecasts (Previous Runs API) made 1–7 days earlier. The page leads with the Heidke skill score and the false-alarm ratio, because GO days are rare (7% of days at Jordan River) and accuracy flatters a forecast that always says no. Jordan River: skill .54 at days 1 and 3, .48 at day 5; false alarms 27% at day 1, about 50% at days 3–5. Wave height at Neah Bay is within ±0.23 m at day 1 and ±0.29 m at day 5, against ±0.64 m for persistence. The Tofino beaches have only a 28-day sample (the Canadian buoy keeps 30 days online), flagged wherever it appears.
- **Seasons:** the share of days per month with 2+ daylight hours of B-or-better swell, from 21 years of NDBC 46087 and 33 years of DFO MEDS 46206 (swell only; the MEDS archive has no direction).
- **Caveats:** waves are scored at the buoy, not the beach. La Perouse Bank may report direction about 23° off true (unverified). Gusts aren't observed hourly, so the calm-water backtest scores wind and waves only. Tides are not for navigation.

Forecasts: Open-Meteo.com, CC BY 4.0; the free API is for non-commercial use only, with attribution. Buoys: NOAA National Data Buoy Center (public domain) and Environment and Climate Change Canada (the ECCC buoy station metadata says "All rights reserved"; its fit with the Open Government Licence – Canada is pending verification). Wave archive (DFO MEDS) and tides (DFO / Canadian Hydrographic Service IWLS): Open Government Licence – Canada; not for navigation.

## Fairway Forecast: method in brief

- **Courses:** every `leisure=golf_course` (and disc golf course) in OpenStreetMap for Greater Victoria and Greater Vancouver (BBBike weekly extracts), with its holes, tees, greens, fairways, bunkers and water. The internal project key is `golf`. Completeness weighs the parts of a course map (holes 55%, greens 15%, tees, fairways and hazards 10% each); a course is ranked only with at least 85% of its holes and 70% completeness; the rest are listed as "not enough mapped in OpenStreetMap", with an edit link (those with an outline get a provisional tier, below). A course OpenStreetMap leaves unnamed is shown as "Unnamed course, <nearest locality>".
- **Tier list:** features from the course map (hole length, par, bunkers per hole, holes with water within 25 m of the line, number of holes), the Copernicus GLO-30 surface model (relief, metres climbed per km walked, and line-of-sight sea and lake views out to 6 km from every tee and green, taking the 90th percentile per course) and ESA WorldCover (tree cover). Each goes on a 0–100 yardstick and the score is their weighted average, climb counting against; missing features drop out. Tiers are by rank within the region (top 10% S, 20% A, 35% B, 25% C, 10% D); pitch & putt courses are tiered across both regions. The weight sliders re-score in the browser with the same formula.
- **Provisional tiers:** a course with a `leisure=golf_course` outline but too few holes is scored on what the outline alone shows: water views from a grid of up to ~150 points across the polygon (90th percentile, in place of the tees and greens), tree cover and relief over the polygon (as for mapped courses), metres climbed per km on a back-and-forth walk across it (rows, then columns; in place of the holes), and the number of holes (a `holes` tag, else 18 if the outline is 38 ha or more). Hole length, par, bunkers and water in play are unknown and drop out, the other weights rescaled. That outline-only score is placed among the outline-only scores of the fully mapped courses (both regions pooled) and given the full score at the same place in their order (quantile mapping); the tier is where that lands among the region's ranked courses. Provisional courses take **no rank number** and don't count in the tier percentiles, so ranked courses keep exactly their scores, ranks and tiers; on the page they are dashed plates marked "Provisional — holes not mapped in OpenStreetMap", re-scored live with the sliders. Each build re-runs the method on every ranked course with that course left out: on the 33 full courses it is off by 9 points on average (median 8, worst 28, against 12 for guessing the average), with a rank correlation of 0.64, the right tier 42% of the time and within one tier 91%. It is weaker in Victoria (8 courses: off by 14 on average, rank correlation 0.38, within one tier 7 of 8) than in Vancouver (25: off by 8, 0.70). It misses most on long, hilly courses (Bear Mountain Mountain course 62 → 47, Olympic View 57 → 32: length is the heaviest weight) and flatters short, open ones (Uplands 42 → 61, Cedar Hill 28 → 46); Victoria Golf Club comes out 77 against 63, still S. A group gets provisional tiers only if the check has 8+ courses and a rank correlation of 0.4+, so short courses get none (6 mapped, correlation 0.03). An unmapped "course" with under 0.75 ha a hole counts as a short course. To map the missing holes, see [docs/golf-mapping-kit.md](docs/golf-mapping-kit.md).
- **Playable hours:** each daylight hour (sunrise + 20 min to sunset − 20 min) gets a comfort score from ramps for rain (0.1–1 mm), wind (20–40 km/h), gusts (40–65 km/h) and cold (8 °C down to 2 °C), plus a frost delay after a night at or below 1 °C (until the air reaches 3 °C). Comfort of at least 50% is playable; a good golf day has 75%+ of its daylight playable. Forecast: Open-Meteo hourly best-match models on a ~3 km grid, refreshed daily.
- **Backtest:** for every day from November 2025 to November 2026, the forecast issued 0–7 days earlier (Open-Meteo Previous Runs API) went through the same rules and was scored against Environment Canada's hourly observations at UVic, Vancouver Harbour and Pitt Meadows (no gust rule: the stations record none), against the monthly average from the years before as the baseline. Good golf days called right, pooled: 88% at day 1, 83% at day 3, 80% at day 7, against 77% for the monthly average, so day 7 is about no better than the average; at UVic the day-7 hours forecast has no skill (−0.01).
- **Best months:** mean playable hours per day by month from the same stations' hourly records since 2016, and the 1991–2025 daily climate (dry days of 12 °C or more, frost nights) from spliced ECCC climate stations.
- **Caveats:** the tier list judges only what volunteers have mapped, and the land rather than turf, service or price. The surface model includes trees and buildings, so views are over the canopy, and only water views count. Rules are a judgement call.

Course maps © OpenStreetMap contributors (ODbL). Copernicus DEM GLO-30 © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the EU and ESA. ESA WorldCover 2021 (CC BY 4.0), contains modified Copernicus Sentinel data. Forecasts: Open-Meteo.com (CC BY 4.0). Climate and hourly observations: Environment and Climate Change Canada (Open Government Licence – Canada). Park golf facilities: City of Vancouver Open Data (Open Government Licence – Vancouver).

## Air Traffic: method in brief

- **What:** a live radar of the aircraft around your spot (Greater Victoria's centre, a point picked on the map, or your device's location on request), Victoria International (CYYJ) and Victoria Harbour seaplane base (CYWH) movements, flying weather, runways and wind. The radar takes its ideas from the owner's NeonDeck "Vapor Trails" app, restyled to the portfolio's calm look. "Air Traffic" is a working title; the internal project key is `air`.
- **Live:** positions come from the community ADS-B network adsb.lol (ODbL 1.0), with adsb.fi's open-data API as a fallback (personal, non-commercial use, credited), through the Cloudflare relay (`/air/point.json`, 5 s edge cache, snapped to 0.05°), because neither sends CORS headers. The page asks every 5 s for everything within 40 km (so the 5 / 15 / 40 km range switches instantly) and moves each aircraft on from its speed and track in between; on a 429 or an error it backs off (20 s, doubling to 2 min) and says so. It pauses when the tab is hidden.
- **On the radar:** colour = kind of flight (airline callsign → airliner, or cargo for cargo operators' codes; registration or light aircraft → private; rotorcraft → helicopter; the aggregator's military flag → military); size = the ADS-B weight category; silhouette = airframe from above (twin jet, four-engined, rear-engined T-tail, turboprop, four-engined turboprop, light single, helicopter) from the type code; a short trail whose length is speed and strength altitude. Taxiing aircraft are small planes, parked ones dots; ground vehicles (category C, non-transponder beacons, untyped objects on the ground) are dropped by the relay. No airline or airport marks.
- **Next pass and closest approach:** each aircraft flying straight on at its current speed and track; the next pass is the soonest within 2.5 km of your spot in the next 15 minutes.
- **What you can probably hear:** a typical source level by kind (light 72 dBA at 1,000 ft up to 88 for heavies, helicopters 86, military +6, +3 climbing at full power below 10,000 ft), less 20·log10(d / 305 m) and 0.003 dB/m air absorption, with height above the nearest airport's elevation. Above 55 dBA counts as audible; faint / clear / loud from 55 / 63 / 72. An estimate, not a measurement.
- **Rare aircraft:** the NeonDeck list (giants, classics, warbirds, tankers, waterbombers…) plus the military flag, with plausibility checks because aircraft types come from a crowd-sourced address database (gliders and balloons must be slow and without airline flight numbers, big types can't report a light class, warbirds and bush planes must be slow). Victoria Harbour's Beavers and Otters don't count as rare in Victoria.
- **Callsigns and routes:** callsigns show the IATA form (AC810) from OpenFlights' airline codes (ODbL), with the ICAO form in the detail. A selected airline flight's route is looked up live from adsbdb.com in the viewer's browser and never stored (its route data, by David Taylor and Jim Mason, may not be copied into other databases); when the aircraft is far off the route on file (more than 25% + 80 km longer than the direct line) the page says the route may be old. No aircraft photos (the usual sources aren't licensed for reuse).
- **Spotter log:** every aircraft seen while the page is open, the nearest it came and the loudest estimate, in the viewer's localStorage (today and yesterday), never sent anywhere. Your location is used only on a button press, stays in the browser and is never put in the URL.
- **Arrivals and departures:** inferred, not from any schedule: an aircraft inside an aerodrome zone (YYJ 8 km below 3,000 ft, the Harbour 4 km below 2,000 ft) descending faster than 300 ft/min is arriving, climbing is departing. Seaplanes without ADS-B are not seen.
- **Live coverage:** adsb.lol meters every request (1,000 a day with a key), so the relay asks for whole areas, not each page's circle: two 250 nm zones (Victoria & Vancouver, out to Seattle and Portland; Phoenix, with Tucson and Las Vegas) and a shared pool for Toronto, San Francisco, Los Angeles and San Diego (Seattle and Portland also allowed). Every place inside a zone or city circle is cut from that one snapshot; other places show airports and weather and say live aircraft aren't covered (`workers/bct-relay/src/airzones.js`, mirrored in `site/src/shared/aircover.js`). Nothing is logged.
- **Weather and runways:** METAR and TAF from the NOAA Aviation Weather Center Data API (via the relay, 5-minute cache); flight category from ceiling and visibility; runway ends, headings and frequencies from OurAirports (refreshed weekly), with head- and crosswind per runway end, and runway centrelines for every medium and large airport worldwide (`runways.json`) on the radar. Not for navigation.

Aircraft positions: adsb.lol (data under the Open Database License 1.0) and adsb.fi open data (credited, non-commercial). Flight routes: adsbdb.com (looked up live, not stored). Airline codes: OpenFlights (ODbL). Weather: NOAA / National Weather Service Aviation Weather Center (public domain; NAV CANADA observations as relayed). Airports, runways and frequencies: OurAirports (public domain). Base map: OpenFreeMap, © OpenMapTiles, © OpenStreetMap contributors (ODbL).

## Waterways: method in brief

- **What:** ships, ferries, cruise ships, tugs, fishing boats and the pleasure craft that carry AIS around Greater Victoria, Vancouver and the lower Fraser River, and Seattle and Puget Sound: what's moving, when each stretch of water is busiest, tides and the river, and Coast Guard navigational warnings. "Waterways" is a working title; the internal project key is `ships`.
- **Typical week:** one week of US Coast Guard terrestrial AIS from NOAA / BOEM Marine Cadastre (public domain; receivers on the US side also hear most Canadian traffic here), clipped to the Salish Sea and reusing Salish Sea Live's cached days. Thirteen named areas (Victoria Harbour, Haro Strait, Swartz Bay, the Fraser's mouth and reaches, Burrard Inlet, Elliott Bay, the Ship Canal …) are rough boxes on the water; "vessels in an hour" counts different vessels with a report inside the box that hour. A week has every weekday and hour exactly once, so the hour-by-hour grid is a real week, not a model. NOAA publishes months behind, so it is a past week and says which.
- **Map:** shipping lanes are a density grid of every position that week; the replay plays one real day (positions thinned to every 10 minutes, or every 3 hours for a vessel that isn't moving). Ships are generic top-down silhouettes by AIS type (cargo, tanker, cruise, ferry, tug, fishing, pleasure), rotated by course; no operator names, logos or colours.
- **Live ships (optional):** aisstream.io's free community stream needs a key that must stay server-side, so the Cloudflare relay holds it (`AISSTREAM_API_KEY` secret) and serves `/ais/salish.json`: it listens for ~7 s at most once a minute per location, merges into a rolling 20-minute state in the edge cache and returns compact JSON. Without the key the route answers `needs_key` and the page stays on the replay. "Open AIS elsewhere" shows the same live view on Finland's Digitraffic AIS (CC BY 4.0, CORS-open, no key).
- **Tides and the river (live in the browser):** CHS IWLS predictions, observations and high/low times at five stations (Victoria Harbour, Patricia Bay, Point Atkinson, Steveston, New Westminster), at most one request every 0.4 s with failures remembered for two minutes; the gap between observed and predicted is the surge. The Fraser at Hope (08MF005) comes from MSC GeoMet's real-time and daily-mean collections, against its 1995–2024 range for the date.
- **Notices:** the Canadian Coast Guard's weekly S-124 navigational-warning *trial* exchange set (Pacific series), parsed from GML; the Coast Guard says the trial data is not operational or official. Not for navigation.

Ship tracks: NOAA / BOEM Marine Cadastre, US Coast Guard AIS (public domain). Live ships (when enabled): aisstream.io. Open AIS elsewhere: Fintraffic / Digitraffic (CC BY 4.0). Tides and water levels: Canadian Hydrographic Service, Fisheries and Oceans Canada (CHS licence; not to be used for navigation; not endorsed by CHS, DFO or the Crown). River flow: Water Survey of Canada, Environment and Climate Change Canada (Open Government Licence – Canada). Navigational warnings: Canadian Coast Guard S-124 trial data set (Government of Canada). Base map: OpenFreeMap, © OpenMapTiles, © OpenStreetMap contributors (ODbL).
