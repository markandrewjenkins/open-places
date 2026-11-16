# Data limits: update frequency and licences

Audit date: 2026-11-13. Sources read: `README.md`, `pipelines/<project>/config.py` and `fetch.py`, `site/src/<project>/*.js`,
`site/public/data/*/`, `.github/workflows/refresh.yml`, `tools/export_repos.py`, and each provider's terms page online.
"Verified 2026-11-13" means the provider's own terms page (or the dataset's own metadata) was read today. "Unverified"
means it was not, either because the page refused automated access (403/404) or because this audit did not get to it. Nothing
here is legal advice.

**How "daily" really works.** `refresh.yml` runs at cron `30 13 * * *` (UTC): **06:30 PDT in summer, 05:30 PST from November
to March**. GitHub starts scheduled runs late or skips them at busy times. Every data step has `continue-on-error: true`, so a
failed source keeps yesterday's file without any visible sign, except on Salish Sea Live and Fairway Forecast, which publish
per-source status. The published exports, checked today, carried `generated` stamps of about **2026-11-12 21:00 UTC (13:00 PST)**,
not 13:30 UTC. **`salish-sea-live` is stuck on 2026-11-05**: the fix described in the README is in this folder but not in the
exported repo.

## 1. Summary

Licence risk: **Low** = open licence, attribution only. **Check** = something to fix or confirm before publishing widely.
**High** = data published under a non-commercial licence, an unclear licence, or no stated licence. "Commercial OK?" is about a
paid, ad-supported or sponsored version of the page as it is built today.

| Dashboard | How fresh the data really is | Needs minute-level? | Gap to real-time | Licence risk | Commercial OK? |
|---|---|---|---|---|---|
| Cherry Blossom Watch | Daily (cron 13:30 UTC); bloom forecast moves daily at most | No: bloom shifts by days | None needed | Check (Esquimalt trees unlicensed; ~94% of photos CC BY-NC) | **No**, unless NC photos and Esquimalt trees are dropped |
| Dark Sky Finder | Static model rebuilt **by hand** (last local build 2026-10-09; no step in `refresh.yml`); clouds, aurora, Kp and ISS **live in the browser** on page load | Partly: aurora/Kp would benefit from 5–15 min updates while the page is open | Re-poll SWPC every 5–15 min in the browser (no server needed) | Check (Open-Meteo free tier; CelesTrak usage policy) | **No** as built (Open-Meteo free API) |
| Fire, Water & Rock | Daily snapshot, although the page calls itself "a live hazard twin" with a "Live map" | **Yes**: highway closures, new fires and quakes change within minutes | 5–15 min relay or browser fetches; see section 4 | Low | **No** as built (Open-Meteo in the build); everything else yes |
| Snowpack to Tap | Daily; sources are daily too | No | None | Low (CDEC terms unverified) | Yes (attribution) |
| Salish Sea Live | Hydrophone audio **live in browser** (seconds); sightings, clips and reports daily; ships are NOAA archives **months old**; live AIS **off** (no key) | **Yes**: whale sightings and ships matter in minutes | Always-on AIS relay (aisstream forbids browser connections) and 5–15 min sightings polling | **High** (Orcasound CC BY-NC-SA; iNaturalist records; Acartia and OrcaHello unclear; aisstream has no terms) | **No** |
| Toronto City Pulse | Daily; Bike Share station status **live in browser**, fetched once per page view (no auto-refresh); TTC delays monthly at source (published to 2026-09-30) | Partly: ferry crowding and bike/dock availability are minute-level questions | Re-poll GBFS every 1–5 min in the browser; ferry counts are "Real-time" at source but need a relay to use that way | Low (GBFS feed states no licence) | **No** as built (Open-Meteo); otherwise yes |
| California Duck Curve | Daily; CAISO data is 5-minute, used as hourly | No: a day-ahead forecast product | Optional "now" fuel-mix strip would need 5-min polling | **High** (CAISO Terms of Use restrict republishing; no open licence found) | Unclear: ask CAISO |
| Fall Foliage Watch | Daily; ERA5 weather lags ~6 days (published `weather_to` 2026-11-06) | No | None | Check (Esquimalt; ~87% of photos NC) | **No**, unless NC photos are dropped and Open-Meteo is replaced |
| Sunday Wander | Road network **frozen** until the CI cache goes cold (`fetch missing`); weather **live in browser** | No | None | Check (ODbL share-alike on road JSON; Esquimalt; Copernicus notice) | **No** as built (browser Open-Meteo); yes after fixes |
| Langford Boom Tracker | Daily run, but sources are monthly (permits), annual (population) and five-yearly (census) | No | None | Low for published files; City layers excluded (no licence) | Yes (fix StatCan wording) |
| Public Transit | Vehicles, predictions and alerts **live in the browser** through the relay (cached 15–30 s per agency; refreshed every 20 s / 30 s / 2 min on the page); timetables rebuilt when an agency's GTFS changes; Route 95's collector polls every 30 s, its analysis rebuilt **daily** | **Yes**: a real-time product | Relay redeploy with the `/rt/` routes | Check (revocable BC Transit licence; "Blink" mark; eight agency licences, see below; TTC realtime page marked Retired; Open-Meteo for Route 95) | Unclear (BC Transit silent on commercial use; MBTA and BART licences need reading for commercial terms) |
| Fairway Forecast | Daily (forecast fetched ~05:15 UTC); OSM reused up to 6.5 days | No: hourly forecast is the right grain | None | Check (ODbL share-alike on course JSON; Copernicus notice) | **No** as built (Open-Meteo); yes after a paid plan or swap |
| Air Traffic | Aircraft **live in the browser** every 10 s via the relay (Open Places tile every 30 s; dead-reckoned in between, dropped-out aircraft held ≤ 60 s, relay serves its last good copy marked stale when upstreams fail); routes from adsbdb on selection; busy hours from a collector (1 poll / 3 min keyless, 1/min with an adsb.lol key) on an always-on machine; METAR/TAF every 10 min in the browser, daily in the build; OurAirports weekly | **Yes**: aircraft move in seconds | Relay must be redeployed with `/air/` routes; busy hours need the collector running | Check (adsb.lol ODbL share-alike on the logged summaries; adsb.fi personal, non-commercial) | **No** while adsb.fi is the fallback; adsb.lol alone is ODbL (yes, with share-alike) |

## 2. Per-dashboard checklists

Line format: **Source**: what we use · source updates · we refresh · licence · attribution · commercial · verified · action.

### Cherry Blossom Watch (`blossom`)

- [ ] **City of Vancouver public trees**: Prunus inventory · source updated irregularly · daily · OGL-Vancouver ([licence](https://opendata.vancouver.ca/pages/licence/)) · attribution: "Contains information licensed under the Open Government Licence – Vancouver" · commercial: yes · unverified (licence page needs JavaScript) · none
- [ ] **City of Victoria tree species**: inventory · irregular · daily · OGL-Victoria ([licence](https://opendata.victoria.ca/pages/open-data-licence)) · OGL statement · commercial: yes · unverified (page needs JavaScript) · none
- [ ] **Township of Esquimalt tree map** (ArcGIS): 953 trees · irregular · daily · **no licence**: the service's `copyrightText` and description are empty, and no Esquimalt open-data licence was found · commercial: unclear · verified 2026-11-13 (service metadata) · **ask Esquimalt for permission or an OGL**, or exclude it from exports as Langford's layers are
- [ ] **ECCC daily climate** (MSC GeoMet): station chains · daily · daily · ECCC Data Servers End-use Licence v2.1.1 ([licence](https://eccc-msc.github.io/open-data/licence/readme_en/)), **not OGL-Canada as the page says** · attribution: "Data Source: Environment and Climate Change Canada" · commercial: yes · verified 2026-11-13 · update the credit line
- [ ] **iNaturalist observations and photos**: 3,215 sightings with photos re-hosted by URL in `sightings.json` · continuous · daily · per-observation and per-photo CC licences, default CC BY-NC ([help](https://help.inaturalist.org/en/support/solutions/articles/151000173511); [terms](https://www.inaturalist.org/pages/terms) returned 403) · credit each observer (done per card) · commercial: **no**: of the photos, 2,269 are CC BY-NC, 81 CC BY-NC-ND and 7 CC BY-NC-SA; only 77 CC BY, 68 CC0 and 2 CC BY-SA · licence model verified 2026-11-13; API terms unverified · for a commercial version, filter `photo_license=cc0,cc-by,cc-by-sa` as `photos.py` already does
- [ ] **Wikimedia Commons and iNaturalist cultivar photos**: one photo per cultivar · static · on demand · per-file CC0, CC BY or CC BY-SA (filtered in `photos.py`) · credit plus licence per photo (done) · commercial: yes · unverified · none
- [ ] **OpenStreetMap via BBBike extracts**: roads for trips; `streets.json` and `trip_*.json` · BBBike city extracts updated weekly (country extracts daily or weekly) · reused while under 6 days old · ODbL ([copyright](https://www.openstreetmap.org/copyright), [BBBike](https://download.bbbike.org/osm/)) · "© OpenStreetMap contributors", plus naming the ODbL for data files · commercial: yes, with share-alike · verified 2026-11-13 · see ODbL in section 3
- [ ] **OpenFreeMap basemap**: tiles · weekly · live in browser · free, commercial allowed, no SLA ([site](https://openfreemap.org/)) · "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" (MapLibre adds it) · commercial: yes · verified 2026-11-13 · none

### Dark Sky Finder (`darksky`)

- [ ] **NASA Black Marble VNP46A2 via GIBS**: night lights · daily product · **manual rebuild only** · NASA-led mission data are CC0 unless labelled ([policy](https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance)) · citation requested; no implied NASA endorsement · commercial: yes · verified 2026-11-13 · record the rebuild date on the page
- [ ] **Globe at Night SQM readings**: training data · annual campaigns · manual · CC BY 4.0 (per page and README) ([data](https://globeatnight.org/maps-data/)) · credit NOIRLab/Globe at Night · commercial: yes · unverified (403) · none
- [ ] **Open-Meteo cloud forecast**: fetched **in the browser** on page load · models update hourly to 6-hourly · live · CC BY 4.0; **free API non-commercial only** (ads or subscriptions count as commercial); 10,000 calls/day per IP ([terms](https://open-meteo.com/en/terms), [licence](https://open-meteo.com/en/licence)) · "Weather data by Open-Meteo.com" with a link · commercial: **no** on the free API · verified 2026-11-13 · paid plan or a direct ECCC/NOAA source for a commercial version
- [ ] **NOAA SWPC OVATION aurora and Kp forecast**: browser fetch, once per page load · OVATION about every few minutes, Kp forecast 3-hourly · live (no re-poll) · US government work, public domain ([SWPC](https://www.swpc.noaa.gov/)) · credit NOAA SWPC · commercial: yes · unverified (disclaimer page 404) · consider re-polling while the page is open
- [ ] **CelesTrak ISS elements**: browser fetch per page view · every 2 h · live · reuse terms not stated; usage policy: one download per update, and IPs with 50+ errors in 2 h are firewalled ([policy](https://celestrak.org/NORAD/documentation/gp-data-formats.php)) · credit CelesTrak · commercial: unclear · verified 2026-11-13 (usage policy only) · cache the elements in a pipeline file instead of fetching per visitor
- [ ] **Astronomy Engine**: JavaScript library, not data · MIT licence (unverified) · none
- [ ] **OpenFreeMap / OSM basemap**: as above

### Fire, Water & Rock (`hazards`)

- [ ] **BC Wildfire Service current fires and perimeters, historical incidents** (DataBC WFS): current fires update several times a day (unverified) · daily · OGL-BC ([licence](https://www2.gov.bc.ca/gov/content/data/policy-standards/open-data/open-government-licence-bc)) · "Contains information licensed under the Open Government Licence – British Columbia"; no implied endorsement · commercial: yes · verified 2026-11-13 (licence) · none
- [ ] **ECCC hydrometric real-time, daily means and daily climate**: real-time readings every 5 min, published about hourly (unverified) · daily (shows one reading per gauge, up to ~24 h old) · ECCC Data Servers End-use Licence ([licence](https://eccc-msc.github.io/open-data/licence/readme_en/)) · "Data Source: Environment and Climate Change Canada"; real-time data are provisional · commercial: yes · verified 2026-11-13 · fix the "OGL-Canada" label; add "provisional" to river readings
- [ ] **USGS ComCat earthquakes**: minutes · daily · public domain ([USGS](https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits)) · "Credit: U.S. Geological Survey" · commercial: yes · verified 2026-11-13 · none
- [ ] **DriveBC Open511 events**: minutes · daily · OGL-BC per the API help page ([help](https://api.open511.gov.bc.ca/help)), plus separate API Terms of Use (not read) · OGL-BC statement · commercial: yes (OGL-BC) · licence verified via search result only; API terms unverified · read the API Terms of Use
- [ ] **Open-Meteo (ECCC GEM) 7-day outlook**: fetched in `build.py` · hourly to 6-hourly · daily · non-commercial free tier (see Dark Sky) · commercial: **no** on the free API · verified 2026-11-13 · as Dark Sky
- [ ] **Page wording**: says "A live hazard twin" and "Live map", but the footer says "Live layers refresh daily" · action: label it "as of <time>", or make it live (section 4)

### Snowpack to Tap (`water`)

- [ ] **USDA NRCS SNOTEL** (AWDB REST): hourly and daily · daily · US government work, public domain · credit USDA NRCS · commercial: yes · unverified · none
- [ ] **Reclamation RISE** (Powell, Mead): daily · daily · US government work, public domain · credit Bureau of Reclamation · commercial: yes · unverified · none
- [ ] **California DWR CDEC**: hourly and daily sensors · daily · **no conditions of use found** on the CDEC home page ([CDEC](https://cdec.water.ca.gov/)) · credit CDEC/DWR · commercial: unclear · unverified · check https://cdec.water.ca.gov/general.html, or ask CDEC staff
- [ ] **USGS Watershed Boundary Dataset**: static, fetched once · public domain · "Credit: U.S. Geological Survey" · commercial: yes · verified 2026-11-13 (USGS policy) · none
- [ ] **Natural Earth rivers**: static · public domain ([terms](https://www.naturalearthdata.com/about/terms-of-use/)) · credit optional · commercial: yes · unverified · none
- [ ] **OSM aqueducts via Overpass** (in `map.json`): fetched once · ODbL · "© OpenStreetMap contributors" · commercial: yes, with share-alike · verified 2026-11-13 · name the ODbL for `map.json` (section 3)

### Salish Sea Live (`salish`)

- [ ] **Orcasound live hydrophone audio** (HLS from S3, in the browser): seconds · live · **CC BY-NC-SA 4.0** ([AWS registry](https://registry.opendata.aws/orcasound/)) · credit Orcasound · commercial: **no**; share-alike applies to derived clips and spectrogram exports · verified 2026-11-13 via the AWS registry listing, not Orcasound's own page · a commercial version needs Orcasound's permission
- [ ] **Orcasound listener reports** (`live.orcasound.net/api/json`): minutes · daily · assumed CC BY-NC-SA (Orcasound-wide) · commercial: **no** · unverified · confirm with Orcasound
- [ ] **OrcaHello AI detections and reviews** (AI for Orcas Azure app): minutes · daily (last week only; full crawl local) · **no licence found** · commercial: unclear · unverified · ask Orcasound/AI for Orcas
- [ ] **Acartia sightings** (`/sightings/current`, rolling ~7 days): minutes · daily, merged into a one-year archive · Acartia's repo says the data follow "the Creative Commons license" but does not say which; account and API key "required" per its GitHub, though this endpoint needs no token · commercial: unclear · unverified · find the actual CC variant, and whether re-publishing the archive is allowed
- [ ] **iNaturalist cetaceans**: 6,000 points (species, date, lat, lon) in `whales_inat.json` · continuous · daily (120 days plus all years) · per-observation licence, default CC BY-NC; "all rights reserved" possible; no licence filter in `fetch.py` · page credits "© their observers" · commercial: **no** as fetched · licence model verified 2026-11-13 · add `license=cc0,cc-by,cc-by-sa` (or `cc-by-nc`) to the query, or publish aggregates only
- [ ] **NOAA/BOEM Marine Cadastre AIS**: published in batches **months late** (latest end of June 2026 per the page) · checked daily · US government, public domain ([hub](https://hub.marinecadastre.gov/)) · credit NOAA/BOEM · commercial: yes · unverified today · none
- [ ] **aisstream.io live ships** (optional, `AISSTREAM_API_KEY`): real-time · **off**: `live_fetched` is null and `live_ships` is null on the published site · **no terms of use or licence published**; "Direct browser connections are not permitted"; 3 connections per IP or account; 1 subscription update per second ([docs](https://aisstream.io/documentation)) · commercial: unclear · verified 2026-11-13 · treat as unlicensed until aisstream publishes terms; needs a server-side relay (section 4)
- [ ] **Hydrophone locations** (SIMRES, Raincoast, OrcaLab, JASCO, ONC): links and approximate positions only · no data reuse · none
- [ ] **Published export is stale**: `salish-sea-live` shows `generated` 2026-11-05T20:46Z · action: re-run `tools/export_repos.py salish` and push, so the fixed `fetch.py` reaches the exported repo

### Toronto City Pulse (`toronto`)

- [ ] **Toronto Island ferry ticket counts**: source refresh rate "**Real-time**" (last refreshed 2026-11-13 06:18) · daily (published last full day 2026-11-11) · OGL-Toronto ([licence](https://open.toronto.ca/open-data-licence/)) · "Contains information licensed under the Open Government Licence – Toronto"; no implied City endorsement · commercial: yes · verified 2026-11-13 · none
- [ ] **Bike Share ridership**: monthly (last 2026-11-10) · daily · OGL-Toronto · commercial: yes · verified 2026-11-13 · none
- [ ] **TTC subway delays**: monthly (last 2026-10-26) · daily (published through 2026-09-30) · OGL-Toronto · commercial: yes · verified 2026-11-13 · none
- [ ] **Bike Share Toronto GBFS** (browser): `ttl` 6 s · once per page view, no re-poll · `system_information` has **no `license_id` or `license_url`**; the page puts it under OGL-Toronto · commercial: unclear · verified 2026-11-13 (feed checked) · confirm the GBFS terms with Bike Share Toronto or the City; add a re-poll
- [ ] **ECCC daily climate (Toronto City)**: daily · daily · ECCC Data Servers End-use Licence · "Data Source: Environment and Climate Change Canada" · commercial: yes · verified 2026-11-13 · none
- [ ] **Open-Meteo forecast** (`build.py`): non-commercial free tier · commercial: **no** · verified 2026-11-13 · as Dark Sky

### California Duck Curve (`grid`)

- [ ] **CAISO "Today's Outlook" history**: 5-minute values, one file per day · daily (published `last` 2026-11-12 12:00) · **no open licence found**: CAISO's Terms of Use say material may not be "copied, reproduced, republished … or distributed except as authorized" ([legal](https://www.caiso.com/Pages/Legal.aspx); the page returned 404 to automated fetches, so this wording comes from a search snippet) · credit CAISO · commercial: **unclear** · unverified (full text not read) · read the full Terms of Use in a browser; republishing derived hourly series and the fuel mix may need CAISO's OK
- [ ] **Open-Meteo forecast and ERA5 archive**: non-commercial free tier; ERA5 is Copernicus C3S data (credit "Contains modified Copernicus Climate Change Service information", unverified) · commercial: **no** on the free API · verified 2026-11-13 (Open-Meteo) · as Dark Sky

### Fall Foliage Watch (`foliage`)

- [ ] **Street trees: Vancouver, Victoria, Toronto**: OGL-Vancouver, OGL-Victoria, OGL-Toronto · daily · commercial: yes · Toronto verified 2026-11-13; Vancouver and Victoria unverified · none
- [ ] **Township of Esquimalt trees**: **no licence** (as in Cherry Blossom Watch) · action: ask or exclude
- [ ] **NASA MODIS MCD12Q2 via the ORNL DAAC subset service**: annual product · fetched when missing · NASA data CC0 unless labelled; citation requested · commercial: yes · verified 2026-11-13 (NASA policy) · cite the DOI on the page
- [ ] **Open-Meteo ERA5 archive and forecast**: ERA5 lags ~5–6 days (published `weather_to` 2026-11-06) · daily · non-commercial free tier · commercial: **no** · verified 2026-11-13 · as Dark Sky
- [ ] **iNaturalist "Leaves" annotations and photos**: daily · per-observation licences; the photo filter in `fetch.py` deliberately includes `cc-by-nc,cc-by-nc-sa`, and `foliage.json` holds 92 CC BY-NC, 4 CC BY-NC-SA and 1 CC BY-NC-ND photos, against about 14 that permit commercial use · commercial: **no** · verified 2026-11-13 · drop NC licences from `CC` for a commercial version
- [ ] **OSM via BBBike** (trip routes): ODbL · as in Cherry Blossom Watch
- [ ] **OpenFreeMap basemap**: as above

### Sunday Wander (`sunday`)

- [ ] **OpenStreetMap roads, scenery and stops via BBBike** (Overpass fallback): BBBike weekly · **only refetched when `data/sunday/raw/<region>/roads.json` is missing** (`fetch missing`), i.e. when the Actions cache is cold · ODbL · "© OpenStreetMap contributors" plus ODbL for the data files · commercial: yes, with share-alike · verified 2026-11-13 · `graph_*.json` is a derivative database (section 3); the page credits "via the Overpass API" but the default is now BBBike; add a road-network date to the page or refresh it weekly
- [ ] **Wikidata landmarks**: fetched once · CC0 ([licensing](https://www.wikidata.org/wiki/Wikidata:Licensing)) · no attribution required · commercial: yes · unverified · none
- [ ] **Copernicus DEM GLO-30** (water views): static · Copernicus WorldDEM-30 licence: free, reproduction, distribution and adaptation allowed ([licence PDF](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM/resources/license/License-COPDEM-30.pdf)) · **modified data need "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved"**, plus the sentence "The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30", and no implied endorsement · commercial: yes · verified 2026-11-13 · the page lacks "produced using", "all rights reserved" and the liability sentence
- [ ] **Street trees: Vancouver, Victoria, Esquimalt**: fetched once · the page says "Township of Esquimalt open data", but Esquimalt states **no licence** · action: correct the wording; ask or exclude
- [ ] **Open-Meteo Sunday forecast** (browser, once per page view): non-commercial free tier · commercial: **no** · verified 2026-11-13 · as Dark Sky
- [ ] **OpenFreeMap basemap**: as above

### Langford Boom Tracker (`langford`)

- [ ] **BC Stats building permits (BPER)**: monthly · daily run · OGL-BC · "Contains information licensed under the Open Government Licence – British Columbia" · commercial: yes · verified 2026-11-13 (licence) · none
- [ ] **BC Stats population estimates and projections**: annual · daily run · OGL-BC · commercial: yes · verified 2026-11-13 (licence) · the README's "adapted from Statistics Canada; not an endorsement" is fine
- [ ] **Statistics Canada census profile API**: five-yearly · daily run · **Statistics Canada Open Licence**, not OGL-Canada as `config.py` and the page say ([licence](https://www.statcan.gc.ca/en/terms-conditions/open-licence)) · adapted data: "Adapted from Statistics Canada, <product>, <reference date>. This does not constitute an endorsement by Statistics Canada of this product." · commercial: yes · verified 2026-11-13 · update `LICENCES["census"]` and the page note
- [ ] **City of Langford Development Tracker and ORTHOS aerials**: `tracker.json` and `orthos.json` · local preview only, not fetched in CI, excluded by `EXCLUDE` in `export_repos.py` (export folder confirmed to hold only `langford.json` and `backtest.json`) · **no licence**: the `arcex.langford.ca` services root has no licence or terms text, and no City open-data licence was found · commercial: no · verified 2026-11-13 · keep excluded; ask the City (GIS) for written permission
- [ ] **Statistics Canada 2021 census subdivision boundaries** (cartographic boundary file, layer 9 of `geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/MapServer`, CSDs `5917*` in the CRD, simplified to ~40 m): once per census · `python -m pipelines.langford.boundaries` → `site/public/data/langford/crd_csd.json` (13 municipalities, 49 KB; run by hand, not in CI) · [Statistics Canada Open Licence](https://www.statcan.gc.ca/en/terms-conditions/open-licence) (the REST service itself lists the Open Government Licence – Canada) · credited on the Growth & housing map panel · commercial: yes · verified 2026-11-15 · shades the Open Places Growth & housing map (new homes per 1,000 people) and outlines Langford on the Municipal Notices map; the City's own layers stay excluded
- [ ] **CRD orthoimagery**: listed only as an alternative in `orthos.json`, not used · CRD terms (as noted in the code) forbid redistribution · none
- [ ] **OpenFreeMap basemap**: as above

### Public Transit (`blink`)

Agencies other than BC Transit (BC Transit's rows follow under Route 95). "CORS" is whether a web page could read the feed directly; none of the realtime feeds allow it, so they go through the relay. No agency states a rate limit for these files; the relay asks each upstream at most once per 15 s (Calgary 30 s) and the pipeline asks for each static GTFS at most once a day, conditionally.

- [ ] **BC Transit, 34 more systems** (operator ids in `pipelines/blink/agencies.py`): same tmix host, terms and limits as Victoria below · static weekly (the server sends no ETag/Last-Modified) · realtime through the relay · verified 2026-11-13
- [ ] **TTC (Toronto)**: static `opendata.toronto.ca` OpenData_TTC_Schedules.zip (~29 MB) and realtime `bustime.ttc.ca/gtfsrt/{vehicles,trips,alerts}` · Open Government Licence – Toronto · CORS: no · **the open.toronto.ca dataset page for the realtime feed is marked "Retired"** although the feed answers: confirm with the City before publishing · verified 2026-11-13
- [ ] **Calgary Transit**: static and realtime from `data.calgary.ca` downloads (302 to S3; the older `transitdata.calgary.ca` host timed out) · Open Government Licence – City of Calgary · CORS: no · relay ttl 30 s · verified 2026-11-13
- [ ] **Edmonton Transit Service**: `gtfs.edmonton.ca` static and `TMGTFSRealTimeWebService` realtime · City of Edmonton Open Data Terms of Use v2.1 · CORS: its header names only edmonton.ca · verified 2026-11-13
- [ ] **King County Metro (Seattle)**: `metro.kingcounty.gov/GTFS` static (ETag) and `s3.amazonaws.com/kcm-alerts-realtime-prod` realtime · "provided by permission of King County" credit required · CORS: no · Sound Transit's realtime needs a OneBusAway key (not wired) · verified 2026-11-13
- [ ] **MBTA (Boston)**: `cdn.mbta.com` static and realtime · MassDOT Developers License Agreement (read before any commercial use) · CORS: no (the V3 API, which has CORS, wants a key for real use) · verified 2026-11-13
- [ ] **SacRT (Sacramento)**: `apps.sacrt.com` static and realtime (the older iportal host has an expired certificate) · SacRT data licence agreement; no SacRT marks · CORS: no · verified 2026-11-13
- [ ] **BART**: `bart.gov/dev` static and `api.bart.gov/gtfsrt` trip updates and alerts; **no vehicle positions published** · BART Developer License Agreement · CORS: no · verified 2026-11-13
- [ ] **TransLink (Vancouver)**: static `gtfs-static.translink.ca` only, with TransLink's required attribution line · its realtime needs a free developer key: **not wired** (owner's choice) · verified 2026-11-13
- [ ] **Listed, not wired (need a key):** 511 SF Bay (Muni, AC Transit, Caltrain…; token), LA Metro, Las Vegas RTC and NCTD (Swiftly key), San Diego MTS (key on request), TriMet (AppID), OneBusAway Puget Sound. Valley Metro (Phoenix) publishes a realtime URL with a shared key in it: left out. Tucson: no open feed found.
- [ ] **Static GTFS summaries** (`site/public/data/blink/agencies/`): only per-stop counts, first/last times and median gaps are published, plus simplified route lines; no full timetables

### Route 95 spotlight (`blink`, Greater Victoria)

- [ ] **BC Transit GTFS static**: changes at service changes · daily · BC Transit GTFS Data Terms of Use: "limited, revocable and non-exclusive license to use, reproduce, and redistribute"; credit BC Transit; no BC Transit domain, trademarks, official marks "or any confusingly similar variation"; terms may change without notice; "as is"; you indemnify BC Transit ([terms](https://www.bctransit.com/open-data/terms-of-use)) · the page's credit and non-endorsement line already meet this · commercial: **unclear** (terms silent) · verified 2026-11-13 · see "Blink" in section 3
- [ ] **BC Transit GTFS-Realtime vehicles and trip updates**: about 30 s at source (unverified) · collector every 30 s on an always-on machine; **site rebuilt daily**; the live map is the last logged poll · same terms; no rate limit stated (the collector's 30 s floor is polite) · verified 2026-11-13 · publishing more often needs a relay (section 4); `collect_workflow.yml.example` notes that GitHub's terms discourage using Actions as a 24/7 collector
- [ ] **BC Transit alerts**: collector every 300 s · same terms · none
- [ ] **Open-Meteo archive and forecast** (wet/dry hours): non-commercial free tier · commercial: **no** · verified 2026-11-13 · as Dark Sky; ECCC hourly observations would do for wet/dry hours
- [ ] **OSM bus lanes via BBBike**: weekly · ODbL; `blink.json` names the ODbL · commercial: yes, with share-alike · verified 2026-11-13 · none
- [ ] **Road speeds estimated from bus movements** (`blink/corridors.json`, added 2026-11-15): no open traffic-speed feed exists for Greater Victoria, so the page derives average bus speeds on five West Shore roads from the same GTFS-Realtime positions (live, through the relay) and compares them with a typical bus speed per hour from the collector's log (where it has watched that hour) or the GTFS timetable. Labelled ESTIMATE everywhere; buses stop and use bus lanes, so it is a proxy, not traffic data · same BC Transit terms; the road spines are bus shapes matched to OSM road names (ODbL: the file carries the credit) · rebuilt by `python -m pipelines.blink.traffic` · verified 2026-11-15
- [ ] **OSM traffic signals via BBBike** (`blink/agencies/victoria/signals.json`, added 2026-11-15): `highway=traffic_signals` nodes within 20 m of a Victoria route line (581 of 644), from the same weekly BBBike Victoria extract · rebuilt by `.venv/Scripts/python -m pipelines.blink.signals` after the extract or `network.json` changes · was only used to slow the predicted bus motion near signals; **no longer loaded by the site since 2026-11-15** (buses now sit at their reported positions), so the file and the refresh.yml step can be dropped · ODbL; the file carries "© OpenStreetMap contributors (ODbL)" · commercial: yes, with share-alike · verified 2026-11-15 · a derivative database (section 3)
- [ ] **DriveBC highway cameras in the Road Speed view**: the up to four camera sites within 400 m of the chosen road, from `roads/cams.json` (see Open Places Roads below); images from `https://www.drivebc.ca/images/<id>.jpg`, reloaded at most once per camera update period (at least 2 min), only while the view is open · OGL-BC · credited "DriveBC, Open Government Licence – BC" in the view, which links each DriveBC camera page · verified 2026-11-15
- [ ] **Open Places Local Stops** (Langford): BC Transit GTFS stops and timetable summary plus GTFS-Realtime predictions and positions through the relay (one `vehicles.json` every 20 s and `trips.pb` every 30 s while a West Shore place is open) · credit "BC Transit (open data licence)" · no BC Transit marks · verified 2026-11-15
- [ ] **OpenFreeMap basemap**: as above

### Fairway Forecast (`golf`)

- [ ] **OpenStreetMap golf courses via BBBike**: weekly · reused until 6.5 days old · ODbL; `courses.json` names the ODbL · "Course maps © OpenStreetMap contributors (ODbL)" (done) · commercial: yes, with share-alike · verified 2026-11-13 · `courses.json` and `geo_*.json` are derivative databases (section 3)
- [ ] **Copernicus DEM GLO-30** (relief, views): static · as in Sunday Wander · the page has the © line but not "produced using … all rights reserved" or the liability sentence · verified 2026-11-13 · fix the notice
- [ ] **ESA WorldCover 2021 v200** (tree cover): fixed product · CC BY 4.0, "free of charge, without restriction of use" ([access](https://esa-worldcover.org/en/data-access)) · "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium" · commercial: yes · verified 2026-11-13 · the page has a shorter credit; use the full one
- [ ] **Open-Meteo forecast and Previous Runs API**: models hourly to 6-hourly · daily (`forecast_fetched` 05:15 UTC) · non-commercial free tier · commercial: **no** · verified 2026-11-13 · as Dark Sky
- [ ] **ECCC daily climate and hourly observations** (UVic, Vancouver Harbour, Pitt Meadows): hourly · daily, incremental · ECCC Data Servers End-use Licence; the page says OGL-Canada · "Data Source: Environment and Climate Change Canada" · commercial: yes · verified 2026-11-13 · fix the label
- [ ] **City of Vancouver parks and facilities**: OGL-Vancouver · commercial: yes · unverified · none
- [ ] **OpenFreeMap basemap**: as above

### Air Traffic (`air`)

- [ ] **adsb.lol API** (`/v2/point`): seconds at source · browser every 10 s via the relay (8 s edge cache, one upstream call per Cloudflare location and 0.05° cell, last good copy kept 15 min); collector every 3 min (keyless limit is **500 requests/day per IP**, per its API page, checked 2026-11-15; free keys: 1,000/day on request, 7,200/day for feeders, as `x-api-key`; relay reads the Worker secret `ADSBLOL_API_KEY`, collector the env var of the same name) · 2026-11-15 measurement: 100% of 108 direct requests answered, p50 0.4 s but p95 4–6 s; through the old relay 4 of 36 requests for one circle failed · data under the ODbL 1.0 ([adsb.lol](https://www.adsb.lol/docs/open-data/api/)) · "Aircraft data: adsb.lol (ODbL 1.0)" on the page and in `air.json` · commercial: yes, with share-alike · no key today; dynamic rate limits, may later need a feeder key (would go in the relay as a secret) · verified 2026-11-13 · `air.json` and `data/air/derived/*.csv` are derivative databases (section 3)
- [ ] **adsb.fi open data** (fallback only; v3 `/api/v3/lat/…/lon/…/dist/…`, v2 deprecated): seconds · only when adsb.lol is slow (> 2.5 s) or fails · personal, non-commercial use, credit and link to adsb.fi, 1 request/s; 4xx/429 answers count toward a temporary IP block · **answers 403 to the Cloudflare Worker** (seen 2026-11-15), so from the relay it is effectively unavailable; the relay rests it 10 min after a 403 · fine from the collector's home IP · credited on the page · commercial: **no** · verified 2026-11-13 · drop it if the page ever goes commercial
- [ ] **Not used (checked 2026-11-15):** airplanes.live answers 403 with "contact us" to keyless API requests, so it would need the owner to ask permission; OpenSky Network works anonymously (400 credits/day per IP, bounding boxes, 10 s resolution) but its terms are non-commercial/research and it is not wired in.
- [ ] **adsbdb.com** (`/v0/callsign/…`, flight routes): CORS-enabled, no key, no published rate limit · looked up in the viewer's browser only for the flight they select, cached for the session, never stored or logged · the API is free; its README says the route data "is the work of David Taylor, Edinburgh and Jim Mason, Glasgow, and may not be copied, published, or incorporated into other databases" without David Taylor's permission · credited on the page · commercial: **unclear** · verified 2026-11-13 · keep it live-only; ask before showing routes anywhere stored or exported
- [ ] **OpenFlights airline codes** (ICAO → IATA, `site/src/air/airlines.js`, the NeonDeck table): static · ODbL · credited on the page · commercial: yes, with share-alike · verified 2026-11-13 · none
- [ ] **NOAA Aviation Weather Center Data API** (METAR/TAF for CYYJ, CYWH and neighbours): METAR hourly plus specials, TAF 4×/day · browser every 10 min via the relay (5-min cache); daily in the build · US government work, public domain; up to 100 requests/min · credited · commercial: yes · verified 2026-11-13 · Canadian reports originate with NAV CANADA and are only relayed; not for navigation
- [ ] **OurAirports** (airports, runways, frequencies): community-edited, daily at source · weekly · public domain ([ourairports.com/data](https://ourairports.com/data/)) · credited · commercial: yes · verified 2026-11-13 · not for navigation (said on the page)
- [ ] **Privacy**: LADD/PIA-flagged aircraft are shown as "ID withheld" with no callsign or hex; registrations and operators are never stored. No airline or airport logos.
- [ ] **OpenFreeMap basemap**: as above

### Waterways (`ships`)

- [ ] **NOAA / BOEM Marine Cadastre AIS** (US Coast Guard terrestrial AIS, daily files): published months after the fact · checked daily, a new week only when NOAA publishes one (reuses Salish Sea Live's cached days) · US government work, public domain · credited · commercial: yes · verified 2026-11-13 · the "typical week" is a past summer week and the page says which
- [x] **aisstream.io** (live ships, Waterways): seconds · through the relay, polled by the page every 30 s; each Cloudflare location listens ~25 s of every 30 while someone is watching (stale-while-revalidate, one listen at a time), positions kept 20 min, names/types 24 h; the page dead-reckons moving ships up to 3 min past their last report (before 2026-11-15: one ~7 s listen a minute, which left moving ships ~12 min stale) · free; key held as the relay secret (no browser connections allowed); 3 connections per key · no published terms or licence; the owner judged public non-commercial display fine (2026-11-13) · credited "AIS positions from aisstream.io" · **on** since 2026-11-13 · also feeds Open Places "Ferries on the Water" (ferries picked out by AIS type 60–69 or public fleet name; BC Ferries itself has no open sailing/capacity API, so capacity is not shown and its site is not scraped)
- [ ] **Fintraffic Digitraffic marine AIS** ("Open AIS elsewhere", Finland/Baltic): seconds · browser on demand, `Digitraffic-User` header · CC BY 4.0 ("Source: Fintraffic / digitraffic.fi") · credited · commercial: yes · verified 2026-11-13
- [ ] **CHS IWLS API** (tides and water levels at five stations): predictions plus observations every few minutes · browser on demand, at most 1 request per 0.4 s (CHS asks for no more than 3/s and 30/min per IP) · CHS licence: not for navigation, the data may not be sold or passed on, notice of CHS / DFO copyright and no endorsement · the full notice is on the About pane · commercial: needs a CHS licence · verified 2026-11-13
- [ ] **Water Survey of Canada via MSC GeoMet** (Fraser at Hope 08MF005, real-time and daily means): 5-minute real-time, provisional · browser on demand; normals rebuilt monthly · OGL-Canada · credited · commercial: yes · verified 2026-11-13
- [ ] **Canadian Coast Guard S-124 NAVWARN trial exchange set**: weekly · daily check (HEAD Last-Modified, ~3 MB when changed) · Government of Canada; the Coast Guard calls the trial data non-operational and unofficial · credited, with the trial caveat · commercial: yes (OGL terms assumed; unverified) · verified 2026-11-13 · not for navigation
- [ ] **OpenFreeMap basemap**: as above

### Open Places local feeds (`local`: Municipal Notices, Police News, Nearby Earthquakes)

Snapshot: `python -m pipelines.local.build` → `site/public/data/local/local.json` (fallback + the crime-severity chart). Live
paths: the browser (Langford WordPress, NRCan, USGS) and the relay's `/local/` routes (`workers/bct-relay/src/local.js`).
Everything below except StatCan and NRCan is **headline + date + link only**: no release text, no images, no marks.
- [ ] **City of Langford news + page dates** (WordPress REST `langford.ca/wp-json/wp/v2/posts`, `/pages?slug=…`; CORS-open): when the City posts (about weekly) · browser every 30 min · **no open licence**: [langford.ca/disclaimer](https://langford.ca/disclaimer/) says "You may download, store in cache, display, print and copy … in unaltered form only" and forbids redistribution without permission · headlines link to the City's pages · commercial: **no** · verified 2026-11-15 · the City has no notices / road-works / utility feed: "Public Notices" and "Traffic Advisories" are pages edited in place (shown with their last-modified date)
- [ ] **Langford council & committee calendar** (eSCRIBE `pub-langford.escribemeetings.com/MeetingsCalendarView.aspx/GetCalendarMeetings`, no CORS): when scheduled · relay, 1 h cache; daily snapshot · the City's public meeting calendar (same disclaimer) · meeting name, time, place and agenda link only · verified 2026-11-15
- [ ] **Police news releases**: West Shore, Sooke and Sidney North Saanich RCMP (rcmp.ca newsroom pages; the JSON list is embedded in each page, undocumented, so it may break; the documented BC Atom feed `rcmp.ca/en/feed-flux/news-nouvelles/division/e` holds only the latest ~20 province-wide), Victoria Police (Ghost RSS `engagement.vicpd.ca/tag/news-releases/rss/`), Saanich Police and Oak Bay Police (WordPress REST) · relay, 15 min cache; daily snapshot · RCMP: [terms](https://rcmp.ca/en/terms-and-conditions) allow non-commercial reproduction with attribution, not "for the purposes of commercial redistribution", no badge; VicPD, Saanich, Oak Bay: © each department, no licence · credited by name, no crests · commercial: **no** · verified 2026-11-15 · names of missing people, suspects/accused and victims are taken out of the headlines (`site/src/shared/redact-names.js`, in the relay, the snapshot and the page); the link to the original release stays; the pane shows 30 days only
- [ ] **Statistics Canada 35-10-0063-01** (Crime severity index by police service, BC; annual, released each July): yearly · daily snapshot (WDS `getDataFromCubePidCoordAndLatestNPeriods`, CORS-open) · [Statistics Canada Open Licence](https://www.statcan.gc.ca/en/terms-conditions/open-licence) · credited on the chart · commercial: yes · verified 2026-11-15 · the West Shore RCMP is split into Langford, Colwood, View Royal, Metchosin (municipal, Metchosin from 2022, 2022 partial) and West Shore (rural) rows
- [ ] **Earthquakes Canada FDSN event service** (`earthquakescanada.nrcan.gc.ca/fdsnws/event/1/query`, CORS-open): minutes · browser on page load, merged with USGS (same quake within 90 s and 60 km kept once, USGS record kept), blasts and industry-related events dropped · Natural Resources Canada, Open Government Licence – Canada · credited on the tile · commercial: yes · verified 2026-11-15
- [ ] **Not open (left out)**: Emergency Info BC events (WordPress REST is CORS-open but gov.bc.ca copyright: "may not be reproduced or redistributed without the prior written permission"; the open alternative is the BC Data Catalogue's Evacuation Orders and Alerts layer, OGL-BC); CRD / Eco-Counter bike counters (Eco-Counter page: non-commercial sharing only, no API; the Galloping Goose tile stays planned); Colwood (CivicWeb meetings, no feed), Metchosin, Highlands and Sooke (no feeds found); View Royal has a news RSS (not wired).

### Open Places: Roads & Cameras and Malahat Corridor (`places/`, BC places)

- [ ] **DriveBC Open511 events** (roads within 40 km, the Malahat corridor, road closures in the alert feed): minutes · browser, one shared fetch per place (a 0.5°-snapped box, ~30 KB), every 5 min while the tab is visible, 5-min localStorage cache, 15-min back-off on a 429; through the relay's `/drivebc/events.json` (2-min edge cache) once it is redeployed, else direct (CORS `*`) · OGL-BC ([help](https://api.open511.gov.bc.ca/help), [licence](https://www2.gov.bc.ca/gov/content?id=A519A56BC2BF44E4A008B33FCF527F61)); the separate [API Terms of Use](https://www2.gov.bc.ca/gov/content/data/policy-standards/data-policies/open-data/api-terms-of-use-for-ogl-information) let the province "impose and or adjust limits" without notice, no numbers given · credited "DriveBC … Open Government Licence – BC" on the tile and pane · commercial: yes · verified 2026-11-15 · none
- [ ] **DriveBC highway cameras**: list from the BC Data Catalogue `bc-highwaycams` CSV (OGL-BC, updated monthly; last 2026-11-01) plus each camera's update period from `www.drivebc.ca/api/webcams/` (undocumented, no CORS), built by `python -m pipelines.roads.cams` into `site/public/data/roads/cams.json` (1,048 cameras; rerun weekly at most) · images hot-linked from `https://www.drivebc.ca/images/<id>.jpg` (the URL the catalogue publishes; CORS `*`): only shown cameras, one HEAD per camera once its own update period (5–28 min) has passed, the picture reloaded only when new (its `Expires` header is the capture time) · OGL-BC per the catalogue; the retired images.drivebc.ca terms page said the images may be republished under the OGL (via search; the host no longer resolves) · credited on the pane and the camera view, which links each DriveBC camera page · commercial: yes (OGL-BC) · verified 2026-11-15 · optional: confirm with cameraprogram@gov.bc.ca, since older DriveBC pages forbade rebroadcast
- [ ] **Elsewhere**: road events are mock and cameras planned (WSDOT, Caltrans, Ontario 511 and city camera feeds each need their own terms check)

### Open Places: Rain Map, Trail Advisories, Tsunami, El Niño / La Niña, Seasonal Outlook, Unusual Patterns (`places/`)

Snapshot: `python -m pipelines.climate.build [enso outlook ocean tsunami nps]` → `site/public/data/climate/*.json` (about
60 small requests per run, paced per host; meant to run daily). Browser code: `site/places/civic-mod-weather.js` (radar),
`civic-mod-trails.js`, `civic-mod-climate.js`; relay route `/tsunami/latest.json` (`workers/bct-relay/src/tsunami.js`).
- [ ] **ECCC MSC GeoMet radar WMS** (`RADAR_1KM_RRAI` rain mm/h, `RADAR_1KM_RSNO` snow cm/h; North American 1 km composite, Canadian + US radars): every 6 min, 3 h kept · browser, 11 frames 12 min apart over the last 2 h, 512 px tiles, capabilities re-read every 6 min at most; one GetFeatureInfo for the rate at the place · CORS `*` · Open Government Licence – Canada · credited under the map · commercial: yes · verified 2026-11-15 · used for Canada and clicked spots inside North America
- [ ] **NOAA / NWS nowCOAST radar WMS** (`base_reflectivity_mosaic`, dBZ): ~4 min · browser, as above (frames snapped to the nearest published time) · CORS `*` · public domain · credited · commercial: yes · verified 2026-11-15 · legend in dBZ with Marshall–Palmer mm/h equivalents
- [ ] **RainViewer** (fallback outside North America only): 10 min · browser · free for personal, educational and "small-scale community use", credit required ("Weather data by RainViewer"), no key, no SLA · commercial: **no** (ask RainViewer) · verified 2026-11-15 · not used for any current Open Places place
- [ ] **BC Parks public advisories API** (`bcparks.api.gov.bc.ca/api/public-advisories`, Strapi): when BC Parks posts · browser, one request per place per 15 min (parks in a ~65 km box, kept within 50 km), CORS `*`, 100 requests/min limit, upstream cache · data under the Open Government Licence – BC, API under the BC Government API Terms of Use ([catalogue](https://open.canada.ca/data/en/dataset/fb1c834b-5a59-44f4-8ed9-6585e826f88d)) · credited on the tile · commercial: yes · verified 2026-11-15 · titles + type + date + link to the park page; no description text copied · park locations (marker positions on the Trail Advisories map) from the same API's `protectedAreas` latitude/longitude · basemap OpenFreeMap (© OpenStreetMap contributors, ODbL)
- [ ] **Linked only**: CRD Regional Parks alerts (crd.ca/news/alerts: no feed, © CRD); Parks Canada Fort Rodd Hill (no API); Avalanche Canada (public API but [terms](https://avalanche.ca/terms-of-use) forbid reproduction without written consent: ask it@avalanche.ca to show danger ratings); BC Wildfire fire bans; Emergency Info BC (its RSS stopped in 2024; gov.bc.ca copyright)
- [ ] **NPS alerts API** (US places): needs a free key (owner registers at nps.gov/subjects/developer; set `NPS_API_KEY` for the pipeline) · daily · public domain · until then Trail Advisories is PLANNED for US places and the pipeline writes a `needs_key` stub
- [ ] **NWS tsunami alerts** (`api.weather.gov/alerts/active?event=Tsunami Warning,Tsunami Advisory,Tsunami Watch`): minutes · browser every 5 min · CORS-open · public domain · commercial: yes · verified 2026-11-15 · US coastal zones only (AK and WA zones stand in as a signal for BC)
- [ ] **tsunami.gov Atom** (NTWC `PAAQAtom.xml`, PTWC `PHEBAtom.xml`): each holds only the newest event · relay `/tsunami/latest.json` (60 s edge cache, browser every 5 min) once redeployed; daily snapshot with a rolling 120-day history meanwhile · no CORS · public domain · commercial: yes · verified 2026-11-15
- [ ] **NOAA CPC ENSO** (ONI and RONI ascii tables, ENSO diagnostic discussion status, official probabilities and RONI outlook tables, parsed from HTML): monthly (2nd Thursday) / weekly · daily snapshot · no CORS · public domain · commercial: yes · verified 2026-11-15 · the HTML tables may change shape
- [ ] **ECCC CanSIPS seasonal forecast** (GeoMet WMS `CanSIPS_100km_AirTemp-Prob{Below,Near,Above}Normal-2m_P01M-P03M`, GetFeatureInfo at 7 points): monthly (1st) · daily snapshot · OGL – Canada · commercial: yes · verified 2026-11-15
- [ ] **NOAA CPC seasonal temperature outlook** (NWS map service `outlooks/cpc_sea_temp_outlk`, query at 6 points): monthly (3rd Thursday) · daily snapshot · public domain · CPC gives only the favoured tercile; the other two follow CPC's 33.3 % near-normal convention · verified 2026-11-15
- [ ] **NOAA OISST v2.1 SST anomaly** (CoastWatch ERDDAP `ncdcOisst21NrtAgg_LonPM180`, preliminary, ~2 days old; final dataset as fallback): daily, sampled weekly over 12 weeks on a 2° grid · daily snapshot · public domain · "marine heatwave" is an estimate (a third of 40–56°N 160–124°W at ≥ +1.5 °C, or the BC/WA shelf averaging that), not NOAA's own heatwave product · verified 2026-11-15
- [ ] **NOAA CO-OPS tide predictions** (Port Angeles 9444090 for BC, Seattle 9447130, San Francisco 9414290): a year of high/low predictions · daily snapshot · public domain · king tides = top 5 % of the year's daily highest highs · verified 2026-11-15 · **CHS (Victoria Harbour 07120) not used**: the CHS licence is not open (non-commercial derived products only, with a prescribed notice naming the user, "not for navigation")

- [ ] **ECCC AQHI observations** (MSC GeoMet OGC API `collections/aqhi-observations-realtime/items`, `latest=true`, a box about ±2° × ±1.3° around the place): hourly · browser, once per place per session (cached) · CORS-open · Open Government Licence – Canada · credited on the Air quality map panel · commercial: yes · verified 2026-11-15 · Canadian stations only; US places show a note instead (AirNow needs a key)
- [ ] **Open-Meteo GFS, coastal points** (Atmospheric rivers map: one multi-location request for 16 points from Alaska to California, hourly wind and humidity by level, scored as integrated vapour transport): hourly model runs · browser, once per session (cached) · data CC BY 4.0, credit Open-Meteo · commercial: **no** on the free, keyless API (non-commercial use only; same as the rest of Open Places' Open-Meteo use) · verified 2026-11-15 · an estimate, labelled so; one request, not sixteen, to stay inside Open-Meteo's rate limit

### Open Places: map stage (`places/`, shell)
- [ ] **What the stage fetches itself** (only while the layer or page is shown): BC Parks public advisories (minimal
  fields, once per place per 15 min, OGL-BC); the relay's AIS snapshot `/ais/salish.json` every 60 s (aisstream.io,
  no published terms, credited; not for navigation). Transit vehicles come from the Public Transit dashboard's shared
  poll (`/rt/<agency>/vehicles.json`, 20 s) and aircraft from the air dashboard's shared feed (`/air/point.json`, one
  per 0.05 degree cell, 22 nm), so the stage adds no second poll. Basemap: OpenFreeMap (OpenStreetMap contributors, ODbL).
- [ ] **What You Need to Know** uses only data already on the page (no AI or third-party service).
- [ ] **"Updated" and the sources panel**: every fetch is noted by one wrapper around `window.fetch`
  (`civic-sources.js`), so "last successful fetch" is per source, whichever module made the call.

## 3. Cross-cutting

**Live hub: upstream calls per day** (added 2026-11-15; `workers/bct-relay/src/hub.js`, live once the owner deploys it on
Workers Paid). One Durable Object per source polls on a fixed clock while anyone watches and sleeps after 10 minutes
with no requests, so upstream calls no longer grow with viewers, Cloudflare locations or places: every Greater Victoria
place (`crd`, `langford`, `victoria-city`, … in `src/sets.js`) shares one source of each kind. Figures are for one
region watched around the clock; a region nobody watches costs nothing.

| Source | Hub clock | Calls / day (24 h watched) | Before the hub | Against the provider's limits |
|---|---|---|---|---|
| BC Transit GTFS-Realtime (victoria) | vehicles + trip updates 20 s, alerts 60 s | 4,320 + 4,320 + 1,440 = **10,080** | up to 5,760 per feed per Cloudflare location (15 s cache), × locations | no published limit; one fetch per feed per clock |
| adsb.lol `/v2/point` (one 46 nm circle for the CRD) | 30 s (10 s while a page asks `fast=air`), stretched to fit the daily budget | **≤ 450** keyless, ≤ 950 with a key, or `ADSBLOL_DAILY_BUDGET` | one per 8 s per location per 0.05° cell (up to 10,800 per cell per location) | see below |
| adsb.fi (fallback) | only when adsb.lol is slow (> 2.5 s) or fails | a few % of the above | same | personal, non-commercial; refuses Workers' IPs (403), rested 10 min |
| aisstream.io | **one** websocket for the Salish box, held while anyone watches | 1 connection (+ reconnects, 5 s → 5 min backoff; 10 min after an error message) | one 25 s listen per location per 30 s; up to 3 locations at once | 3 connections per key; the hub uses one |
| DriveBC Open511 (one box, -125,47.5,-122,49.5) | 60 s; Retry-After honoured (300 s default) | **1,440** | one per 2 min per location per place box | rate-limited us before; 1 call a minute is well under what tripped it (browser polling from many tabs) |

**adsb.lol tiers** (500 / 1,000 / 7,200 requests a day): the hub's air source keeps a per-UTC-day call count in DO
storage and paces itself: interval = max(30 s, or 10 s fast, seconds left in the UTC day / calls left in the budget).
Budget: `ADSBLOL_DAILY_BUDGET` if set, else 450 without `ADSBLOL_API_KEY` and 950 with it (headroom under 500 / 1,000);
a feeder's key could set 7000. So the feed runs around the clock instead of dying after about 4 hours at a fixed 30 s:
keyless and watched all day it updates about every 3 minutes (86,400 s / 450 ≈ 192 s at 00:00 UTC, shorter if earlier
hours went unwatched); with a key about every 90 s; at 7,000 about every 12 s. Light use (an hour or two) keeps the
30 s clock. Fast mode (the Air Traffic page) only goes below 30 s when the budget allows. After the budget is spent the
hub makes no calls until 00:00 UTC and serves its last snapshot marked stale. adsb.fi (fallback only) is not counted.
The air part's meta carries `{ budget, used, every_s }`, and the pages say "new positions every N min" when the clock is
stretched, dead-reckoning aircraft in between (up to 4 min). The Worker's outgoing IP is shared, so keyless limits may
bite sooner; a free key as the `ADSBLOL_API_KEY` secret makes the count ours alone. Outside Greater Victoria the Air
Traffic page still uses the old `/air/point.json` path (one call per 8 s per location per cell while open).

**Worker requests per viewer** (Open Places, tab visible all day): before, buses every 20 s, aircraft every 30 s, ships
every 60 s (twice: tile and map stage), local stops' trip feed every 30 s and DriveBC every 5 min, about 6–10 calls a
minute or **8,600–14,400 a day**; with the modules on `site/src/shared/livehub.js` (wired 2026-11-15), one `/live` call every 20 s,
**4,320 a day** for the hub's parts (measured on `places/?p=langford#overview`: 3 `/live` + 2 `trips.pb` a minute, from 8 relay calls) (trip feeds, tsunami, local notices and METAR stay separate). Costs:
`workers/bct-relay/README.md`, "Monthly cost".

**Attribution every published page must show** (in addition to the per-source lines above):
- Basemap: "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" (MapLibre's compact control shows it; keep the footer line).
- OSM-derived data: "© OpenStreetMap contributors", the licence named (ODbL) with a link to https://www.openstreetmap.org/copyright.
- Open-Meteo (8 pages): "Weather data by Open-Meteo.com" linked; CC BY 4.0 also needs a licence link and a note that the data were changed.
- ECCC (blossom, hazards, toronto, golf): "Data Source: Environment and Climate Change Canada". The pages and README say OGL-Canada, but ECCC's open-data licence page names its own Data Servers End-use Licence. Both allow commercial use; only the wording changes.
- OGL family (BC, Toronto, Vancouver, Victoria): "Contains information licensed under the Open Government Licence – <issuer>" with a link. All forbid implying official endorsement.
- Copernicus DEM (sunday, golf): the "produced using …; all rights reserved" notice and the no-liability sentence.
- Statistics Canada (langford): "Adapted from Statistics Canada … This does not constitute an endorsement by Statistics Canada of this product."
- The exported repos have **no LICENSE file**, and their README says "Data licences are listed at the foot of the dashboard". Add a `DATA-LICENCES.md` per repo, because the JSON files are redistributed through the repo, not just shown on a page.

**ODbL share-alike.** A rendered map or chart is a Produced Work: attribution only. A **JSON file of OSM-derived features** (`sunday/graph_*.json`, `golf/courses.json` and `geo_*.json`, `blink/segments.json`, `network.json` and `signals.json`, `blossom` and `foliage` `streets.json` and `trip_*.json`, `water/map.json` aqueducts) is published "as a database", which the OSMF FAQ treats as a likely **Derivative Database** ([FAQ](https://osmfoundation.org/wiki/Licence/Licence_and_Legal_FAQ)). Those files must be offered under the ODbL, and any data merged into them (scores, DEM views, tree counts) goes under the ODbL with them. Practical steps: state "This file is © OpenStreetMap contributors, available under the ODbL" in the repo and next to the download; keep non-OSM layers in separate files where possible. Fine-grained cases (per-segment scores) are not settled by the FAQ: the [community guidelines](https://osmfoundation.org/wiki/Licence/Community_Guidelines) or legal-questions@osmfoundation.org can settle them. Verified 2026-11-13.

**Non-commercial sources that block a commercial version**
- **Open-Meteo free API**: used by Dark Sky, hazards, Toronto, grid, foliage, Sunday, Route 95 and golf (and the shelved West Coast Water). Ads, subscriptions or sponsored products count as commercial. Fix: a paid Open-Meteo plan, or ECCC GeoMet and NOAA directly.
- **iNaturalist photos** (blossom ~94% NC, foliage ~87% NC) and **observation records** (salish, unfiltered; default CC BY-NC).
- **Orcasound audio and reports** (CC BY-NC-SA).
- **Unclear, so treat as blocking until settled**: CAISO, aisstream.io, Acartia, OrcaHello, Bike Share Toronto GBFS, CDEC, CelesTrak, BC Transit (silent on commercial use), Esquimalt and City of Langford (no licence).
- Hosting: GitHub Pages' own terms limit commercial use of Pages sites (unverified today); check them before monetising.

**Trademarks and endorsement**
- **"Blink"** is BC Transit's brand for route 95. Its terms forbid BC Transit trademarks "or any confusingly similar variation". The public name "Public Transit" (and its "Route 95 spotlight") avoids it, and so does the repo `public-transit`. The internal key `blink`, the page text "Blink is Greater Victoria's rapid bus…", and the README's "Langford / Downtown Blink" are descriptive uses. Keep "Blink" out of titles, logos, domains and the skin name, and ask BC Transit if it ever becomes the brand.
- Do not use NASA, USGS, ECCC, City or BC Transit logos. Every OGL, NASA, Copernicus and StatCan licence bars implied endorsement.
- "Copernicus" and "WorldDEM" are trademarks; only refer to them in the credit.

## 4. Where real-time matters

Dashboards where minute-level data changes what a visitor would do:

- **Public Transit**: the product *is* real-time. Live vehicles, predictions and alerts for every wired agency now load in the browser through the relay (`/rt/<agency>/…`, cached 15–30 s per upstream) once it is redeployed; Route 95's analysis is still rebuilt daily from the collector's 30 s log.
- **Salish Sea Live**: ships (aisstream allows no browser connections, so this needs an always-on relay with the key held server-side), plus Acartia/Orcasound sightings every 5–15 min so listeners can act on a report. Audio is already live.
- **Fire, Water & Rock**: DriveBC closures, new wildfire starts, earthquakes and river rises. USGS GeoJSON feeds and DriveBC may be fetchable straight from the browser (CORS unverified); BC WFS and ECCC real-time would need a 5–15 min relay. At minimum, label the page "as of <time>" instead of "live". In smoke season, an **AQHI** layer (ECCC, hourly) would be the most useful addition; it is not in the project today.
- **Toronto City Pulse**: re-poll GBFS every 1–5 min while the page is open (no server needed, `ttl` 6 s). Ferry crowding "now" needs the City's real-time counts through a relay; TTC real-time is not used at all.
- **Dark Sky Finder**: re-poll SWPC OVATION and Kp every 5–15 min in the browser during aurora alerts; cache CelesTrak in the pipeline instead of fetching it per visitor.
- **Not needed**: Cherry Blossom Watch, Snowpack to Tap, California Duck Curve, Fall Foliage Watch, Sunday Wander, Langford Boom Tracker, Fairway Forecast. Daily is the right grain for all of them, but each page should show its own `generated` time and per-source status, as `golf/status.json` does.

Options for the relay (a small always-on machine, a serverless function on a schedule, or a worker that caches feeds and serves them with CORS) are being researched in `docs/live-data-options.md`. GitHub Actions is not a fit below ~15 minutes: scheduled runs start late, get skipped, and are disabled after 60 days without repository activity.

## Appendix: West Coast Water (`waves`, shelved 2026-11-13)

Not built, exported or refreshed. If it returns:
- [ ] **Open-Meteo marine and weather APIs, Previous Runs**: non-commercial free tier · verified 2026-11-13
- [ ] **NOAA NDBC buoys** (46087): public domain · unverified
- [ ] **ECCC buoys and SWOB** (46206): the station metadata's "All rights reserved" is still unexplained. The CIOOS Pacific catalogue and ERDDAP list the ECCC real-time buoy data under OGL-Canada 2.0, and ECCC's own open-data licence allows commercial use. Not verified on ECCC's own station record · ask ECCC (MSC open data) to confirm
- [ ] **DFO MEDS wave archive and CHS IWLS tides**: OGL-Canada; "not for navigation" · unverified
