# Live data options (research, 2026-11-13)

Scope: live Victoria transit in the browser, 24/7 logging, BC Ferries, the Malahat, bike/trail
counts, and hazard/climate feeds for the "Open City" umbrella. The sites are static on GitHub Pages
and refreshed by GitHub Actions; there is no server.

How to read the notes:
- **V** means verified on 2026-11-13, either by reading the cited page or by a direct request.
  Each CORS result comes from a GET (and an OPTIONS where noted) sent with
  `Origin: https://example.github.io`.
- **U** means unverified: from memory, a secondary source, or a page that could not be read.
- No accounts were created and no keys were used. Each server got only a handful of requests.

---

## 1. Live BC Transit (all Victoria buses) in the browser

### CORS

| Request | Result | Note |
|---|---|---|
| `OPTIONS https://bct.tmix.se/gtfs-realtime/vehicleupdates.pb?operatorIds=48` | `404 Not Found`, no CORS headers | V |
| `GET` same URL with `Origin` | `200`, `application/x-protobuf`, **no `Access-Control-Allow-Origin`** (server `Microsoft-HTTPAPI/2.0`) | V |

So a github.io page **cannot** read the feed directly. Every browser-live option needs a relay, or a
pre-built file that a scheduled job publishes.

### BC Transit open-data terms

Source: <https://www.bctransit.com/open-data/terms-of-use/> (V). The feed list is at
<https://www.bctransit.com/open-data> (V); it shows Victoria = `operatorIds=48` and gives no key
requirement and no stated refresh rate.

| Topic | What the terms say | Note |
|---|---|---|
| Licence | Custom terms (not OGL or CC), a "limited, revocable and non-exclusive license" to use, reproduce and **redistribute** the GTFS Data | V |
| Attribution | Must identify BC Transit as the source; must not use BC Transit's domain name or marks; must withdraw the attribution if BC Transit asks | V |
| Polling frequency | **Nothing stated**, on either the terms page or the open-data page | V |
| Relaying / caching | Not mentioned explicitly. Redistribution is allowed, and the indemnity covers your "distribution of the Data to any end user" | V |
| Real-time | The terms speak of "GTFS Data" generally and have no real-time clause | V |
| Warranty | "As is" / "as available"; the user indemnifies BC Transit | V |
| Changes | BC Transit may modify the terms "at any time, without notice" | V |

Reading: a caching relay that serves the decoded feed with "Source: BC Transit" attribution fits
the redistribution grant. Polling every 30 s from a single relay is modest. Every browser fetching
the feed directly (if CORS ever allowed it) would multiply the load; a relay avoids that. (This is an
interpretation, not legal advice.)

### Relay / proxy hosts for a live map

All of these need an account, which the owner would create.

| Host | Free limits relevant here | 30 s live? | Account / card | Note |
|---|---|---|---|---|
| **Cloudflare Workers** | 100,000 requests/day (resets 00:00 UTC); 10 ms CPU per invocation; 50 subrequests; 128 MB memory; 5 cron triggers per account; cron wall time up to 15 min ([limits](https://developers.cloudflare.com/workers/platform/limits/)) | Yes as an on-request relay: the Worker fetches upstream, caches about 15–30 s, and adds `Access-Control-Allow-Origin`. Cron granularity is **1 minute** (5-field cron, UTC; schedule changes take up to 15 min to propagate) ([cron docs](https://developers.cloudflare.com/workers/configuration/cron-triggers/)) | Cloudflare account; card not needed for Workers Free (U) | V (limits), U (card) |
| Cloudflare KV (with Workers) | 100k reads/day; **1,000 writes/day** to different keys; 1 write/s to the same key; 1 GB ([KV limits](https://developers.cloudflare.com/kv/platform/limits/)) | Too few writes for a 30 s log (2,880/day); fine as a cache of the latest snapshot only if writes stay under 1,000/day | as above | V |
| Cloudflare D1 | 5 M rows read/day; **100k rows written/day**; 5 GB total; 10 DBs ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)) | See section 2 for the arithmetic | as above | V |
| Cloudflare R2 | 10 GB-month; 1 M Class A (writes) and 10 M Class B (reads) per month; free egress ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)) | Good for storing snapshot files | Payment method on file probably required to enable R2 (U; the pricing page does not say) | V / U |
| Cloudflare Durable Objects | On Free (SQLite backend only): 100k requests/day; 13,000 GB-s/day; 100k rows written/day; 5 GB. **Alarms count as requests**, and each `setAlarm()` counts as one row written ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)) | An alarm can re-arm every 30 s, the only Cloudflare way to get sub-minute polling. 2,880 alarms/day fits in 100k | as above | V |
| Deno Deploy | Free: 1 M requests/month; 10 h active CPU; KV 1 GiB, 1 M read units and 500k write units per month; 20 GiB egress. **Banner: "Deno Deploy will be sunset in April 2027"** ([pricing](https://deno.com/deploy/pricing), [limits](https://docs.deno.com/deploy/pricing_and_limits/)) | Technically yes, but the platform is being retired | Account | V; **avoid** |
| Vercel (Hobby) | Cron **once per day** only, with ±59 min precision ([cron pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing)). An on-request relay function would work, but you cannot schedule polling | Relay only | Account | V |
| Netlify | Scheduled functions have a 30 s execution limit, are on all plans, and the shortest listed shorthand is `@hourly` ([docs](https://docs.netlify.com/build/functions/scheduled-functions/)) | Relay only | Account | V (min interval not stated) |
| Fly.io | **No free tier** for new organizations; a trial gives $1 of credit for 7 days; the smallest machine (shared-cpu-1x, 256 MB) is US$2.19/month; a card is required to keep going ([pricing](https://docs.fly.io/about/pricing)) | Yes (a real always-on VM) | Account + card | V |

Bottom line for live maps: a **Cloudflare Worker relay**. The browser calls
`https://<worker>/victoria/vehicles.json`. The Worker fetches `vehicleupdates.pb` (and `tripupdates.pb`)
at most once per 15–30 s through the Cache API, decodes it to compact JSON, and adds the CORS header
plus a BC Transit attribution field. Decoding a full Victoria feed inside the 10 ms CPU limit is
plausible but untested (U). A fallback is to pass the raw `.pb` through with CORS and decode it in the
browser with `protobufjs` / `gtfs-realtime-bindings`.

**Update 2026-11-13 (Public Transit):** measured, not guessed. With the relay's own decoder
(`workers/bct-relay/src/gtfsrt.js`, warm, in Node) vehicle feeds decode in about 0.1–1.4 ms, but trip-update
feeds are 0.6–2.5 MB and take 9 ms (Victoria) to 47 ms (Edmonton). So the relay decodes vehicles and alerts to JSON
(`/rt/<agency>/vehicles.json`, `alerts.json`), decodes trip updates only for small agencies (`trips.json?stops=`), and
passes big agencies' `trips.pb` through with CORS for the page to decode (the same decoder is copied to
`site/src/blink/gtfsrt.js`). The relay now serves 42 agencies from an allow-list (`workers/bct-relay/src/agencies.js`);
none of their realtime feeds send CORS headers. Feeds that need a key are listed in `pipelines/blink/agencies.py`
and left out.

Request budget: one open tab polling every 30 s makes 2,880 requests/day, so 100k/day covers roughly
35 always-open viewers, or many more casual ones. The upstream load stays at about 2,880 fetches/day
whatever the number of viewers.

---

## 2. 24/7 logging for reliability history

Load to plan for: poll `vehicleupdates.pb` (+ `tripupdates.pb`) every 30 s, which is 2,880 polls/day
per feed. Tonight at about 23:30 PST the Victoria vehicle feed was 5,083 bytes (V). The daytime size
for about 100–250 buses is not measured; an estimate is 20–60 KB (U).

| Option | Cost (CAD) | 30 s polling? | Setup effort | Notes |
|---|---|---|---|---|
| **Raspberry Pi 5 4 GB** | Board CA$154.95; CanaKit Essentials kit (board, 32 GB card, case, PSU) **CA$229.95**; Starter kit with 128 GB **CA$284.95** ([CanaKit](https://www.canakit.com/raspberry-pi-5-4gb.html?cid=CAD)) (V). Power about 3–5 W (U) → 26–44 kWh/yr → **about CA$4–6.50/yr** at BC Hydro Step 2 of 14.08 ¢/kWh ([BC Hydro tiered rate](https://app.bchydro.com/accounts-billing/rates-energy-use/electricity-rates/residential-rates/tiered.html)) (V for the rate) | Yes, any interval | Low–medium: flash the OS, copy `pipelines/blink/collect.py`, add a systemd service, and push daily to the repo or to R2 | A cheaper Pi 4 / Pi Zero 2 W is enough for a Python poller (U on current CAD prices). Use a high-endurance card or USB SSD and write batched files to limit SD wear (U) |
| Old laptop / used mini PC | CA$0 if already owned; used mini PC about CA$100–200 (U). Idle about 6–15 W (U) → **about CA$7–19/yr** at 14.08 ¢/kWh | Yes | Low (Windows + Task Scheduler, or Linux + systemd) | A laptop battery acts as a small UPS |
| Windows Task Scheduler on the owner's PC | CA$0 | Yes, **only while the PC is on** | Already effectively in place | Gaps whenever the PC sleeps or is off, which is the current problem |
| GitHub Actions `schedule` | Free on public repos ("standard GitHub-hosted runners is free: In public repositories") ([billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)) | **No.** The minimum is every 5 min; runs "can be delayed during periods of high loads… High load times include the start of every hour" and may be dropped; public-repo schedules are auto-disabled after 60 days without activity ([events doc](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)) | Low | Policy: Actions must not place "a burden on our servers… disproportionate to the benefits"; "don't use Actions as a content delivery network or as part of a serverless application"; and (hosted runners) nothing "unrelated to the production, testing, deployment, or publication of the software project" ([Additional Products terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features)). A long-running 30 s poller inside Actions is a poor fit. A daily build step is fine. All V |
| Cloudflare Workers cron + D1/R2 | CA$0 | Cron is 1 min. **30 s needs either a Durable Object alarm, or a cron run that polls, waits 30 s and polls again** (wall time allows 15 min; CPU is 10 ms per invocation) | Medium (JS/TS, not Python) | Storage arithmetic below |
| Oracle Cloud Always Free | CA$0 | Yes (real VM) | Medium | 2× AMD micro (1/8 OCPU, 1 GB) or Arm A1 up to 2 OCPU / 12 GB; 200 GB block; 10 TB egress. **Idle instances may be reclaimed** if over 7 days the 95th-percentile CPU < 20 % and network < 20 % (and memory < 20 % on A1) ([Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)) (V). A light poller can look "idle". Card needed at signup (U: the FAQ blocked automated fetch) |
| Google Cloud e2-micro | CA$0 within limits | Yes | Medium | 1 e2-micro in us-west1, us-central1 or us-east1; 30 GB-month disk; **1 GB/month egress**; "A Google Cloud billing account is required" ([free features](https://docs.cloud.google.com/free/docs/free-cloud-features)) (V). Pushing logs out costs egress |

**Cloudflare storage arithmetic** (limits V; sizes U):
- One D1 row per vehicle per poll: 250 vehicles × 2,880 polls = **720,000 rows/day**, which is over the
  100k rows written/day free limit. One row per poll (a compressed blob or a JSON array) is 2,880 rows/day,
  which fits.
- R2 with one object per poll: 2,880 writes/day ≈ 86k Class A per month (limit 1 M). At about 30 KB per
  snapshot that is about 2.6 GB/month, which reaches the 10 GB free storage in about 4 months unless a
  daily job compacts it to Parquet or gzipped CSV (10–20× smaller, U).

**Recommendation:** a **Raspberry Pi 5 (4 GB) essentials kit, about CA$230 up front and about CA$5/yr
in power**. It runs the existing Python collector unchanged at 30 s, has no account, no card and no
reclamation risk, and pushes one compacted file per day to the repo (or R2) for the static site. Add the
Cloudflare Worker relay separately for live browser maps. If the owner wants no hardware, use the
**Cloudflare Durable Object alarm + R2** route. It is free and always on, but needs a JS rewrite.

---

## 3. BC Ferries

| Item | Finding | Note |
|---|---|---|
| Official API / open data | **None found.** The BC Data Catalogue has only static `ferry-terminals` and `coastal-ferry-routes` (OGL-BC); there are no sailing, capacity or position data ([catalogue search](https://catalogue.data.gov.bc.ca/api/3/action/package_search?q=bc%20ferries)) | V |
| bcferries.com features | Current conditions (conditions by route, departures & arrivals, terminal webcams, **ferry tracking**) exist as web pages ([terms page nav](https://www.bcferries.com/terms-and-conditions)) | V |
| Website terms on automated access | "Terms & conditions" covers carriage and booking only; **no general website terms of use** and nothing on scraping; footer "Copyright © 2026 British Columbia Ferry Services Inc." ([terms](https://www.bcferries.com/terms-and-conditions)) | V |
| robots.txt | `Crawl-delay: 10`, `Request-rate: 1/10`, `Visit-time: 0900-1200` (UTC); disallows `/routes-fares`, `/cart`, `/checkout`, `/seasonal-schedules` etc.; blocks GPTBot, CCBot, PerplexityBot ([robots.txt](https://www.bcferries.com/robots.txt)) | V |
| Community API | **bcferriesapi.ca** (MIT, Go, unofficial), no key, CORS `*`. Endpoints `/v2/`, `/v2/capacity/`, `/v2/noncapacity/`. Current conditions refresh every minute and schedules every 4 h. Its own README says it is unofficial and data can be delayed or unavailable ([repo](https://github.com/samuel-pratt/bc-ferries-api)). A live response shows `sourceURL: https://www.bcferries.com/current-conditions/DUK-TSA` with fill %, car %, oversize % and vessel name, so it **scrapes bcferries.com** | V |
| Risks of unofficial data | Breaks whenever the site changes. A one-minute scrape conflicts with the robots `Visit-time` and crawl-delay hints. No licence from BC Ferries, so republishing deck-space data rests on the scraper's and your own risk. Single-maintainer uptime | V (facts) / interpretation |
| AIS vessel positions (aisstream.io) | WebSocket `wss://stream.aisstream.io/v0/stream`; "The API key belongs in a server-side environment variable"; "**Direct browser connections are not permitted**"; 3 subscribed connections per account, 3 per IP; bounding boxes required; up to 200 MMSI filters; "no SLA or uptime guarantee"; per-user bandwidth limits on uncompressed connections from Sept 2026 ([docs](https://aisstream.io/documentation)) | V |
| aisstream licence / terms | The documentation page states **no data licence or commercial-use terms**; `/terms` returned 404 | V (absence) |

Practical route: filter AIS by the MMSIs of the Swartz Bay–Tsawwassen vessels in a small Strait of
Georgia bounding box, collect it on the Pi (server-side key), and publish snapshots. Treat
redistribution as unclear until aisstream publishes terms. If capacity data is used, credit the
community API and BC Ferries as the original source and poll it, not bcferries.com.

---

## 4. The Malahat (Hwy 1, Goldstream–Mill Bay)

**Built 2026-11-15** in Open Places (`site/places/civic-mod-roads.js`): Open511 events on Hwy 1 within 1.2 km of the
West Shore Parkway → Mill Bay line (24 km), a status from road state and in-effect event text, the 9 DriveBC camera
sites, and op-alerts on status change. Travel time and the road weather station are still not used.

| Source | Access | Licence | Note |
|---|---|---|---|
| **DriveBC Open511 events** | `https://api.open511.gov.bc.ca/events?format=json&status=ACTIVE&bbox=-123.65,48.45,-123.5,48.70` (also `road_name=Highway 1`, `event_type`, `severity`; max `limit=500`). **CORS `*`**. Tonight's query returned 6 events, including Malahat fog and utility work ([help](https://api.open511.gov.bc.ca/help)) | "governed by the Open Government Licence – British Columbia"; catalogue `open511-drivebc-api` is OGL-BC | V |
| Historical DriveBC events | Annual CSVs 2022–2025 (`historical-drivebc-events`, OGL-BC) ([catalogue](https://catalogue.data.gov.bc.ca/dataset/historical-drivebc-events)) | OGL-BC | V |
| **DriveBC cameras** | Image URL `https://www.drivebc.ca/images/{id}.jpg` (**CORS `*`**, so usable in `<img>` and canvas). The camera list is in the catalogue CSV `bc-highwaycams` (OGL-BC, modified 2026-11-01). The live JSON `https://www.drivebc.ca/api/webcams/` works but is undocumented and has no CORS. Malahat camera IDs: 974/975 Goldstream N/S, 926/927 Tunnel Hill, 909/910 Okotoks, 8/273/272 S. Shawnigan Lake Rd, 424/427 Malahat Summit, 664/137 Bamberton, 425/428 Butterfield Rd, 395/396/397 Mill Bay. Mean refresh about 5–15 min (`update_period_mean` 299–915 s) | The catalogue dataset is **OGL-BC**. Legacy DriveBC pages say images "may not be rebroadcast or republished without express authorization"; the newer catalogue release supersedes them in practice. Contact cameraprogram@gov.bc.ca to be sure | V (URLs, CORS, catalogue licence); the legacy-terms conflict is from search snippets (U); old `images.drivebc.ca` no longer resolves (V) |
| **Road weather station** | DriveBC station **62091 "Malahat"**, "South side of Hwy 1, 300 m East of Malahat Summit" (air and road temperature, wind, precipitation, visibility) in the undocumented `https://www.drivebc.ca/api/weather/current/` (no CORS; 137 stations). Station locations are in catalogue `avalanche-and-weather-programs-weather-station-network` (OGL-BC) | Live obs feed has no stated licence | V (data), U (licence of live obs) |
| Highway forecast | `https://www.drivebc.ca/api/weather/hef/` (ECCC highway forecasts; undocumented) | ECCC licence applies to forecasts (U) | V (endpoint) |
| **Traffic counts** | MoTI Traffic Data Program: interactive map <https://twm.th.gov.bc.ca/?c=tdp>, contact TrafficDataProgram@gov.bc.ca ([program page](https://www.th.gov.bc.ca/trafficData/)). No API or bulk download is documented. TRADAS site diagrams show **short-count** posts near Malahat Summit (e.g. [55300S](https://tradas.th.gov.bc.ca/siteDiagrams/55300S.pdf)); no current permanent station was confirmed | Licence not stated | V (portal), U (station type, frequency) |
| Travel time | **None found** for the Malahat (no DriveBC travel-time feed). Commercial traffic APIs need keys | | U |
| Elevation profile | NRCan **MRDEM** (CanElevation, 30 m) **replaces CDEM** ([open.canada.ca](https://open.canada.ca/data/en/dataset/18752265-bda3-498c-a4ba-9dfe68cb98da)); OGL-Canada; must keep the Copernicus credit ("produced using Copernicus WorldDEM-30 © DLR"). Finer: **LidarBC** (OGL-BC) ([LidarBC](https://www2.gov.bc.ca/gov/content/data/geographic-data-services/topographic-data/lidarbc)) | OGL-Canada / OGL-BC | From search results (U). Compute the profile once offline; it never changes |

---

## 5. Victoria bike lanes and trails

| Source | Finding | Licence | Note |
|---|---|---|---|
| City of Victoria counters (Pandora, Fort, Wharf) | **No counter dataset on opendata.victoria.ca**: the hub search for "bike count" returned 0 items; "cycling" returns only the *Cycling Network (OCP)* feature service. News from 2019 says data is downloaded monthly | Portal datasets are typically OGL-Victoria (U) | V (search), U (frequency) |
| CRD automated counters (regional, incl. Galloping Goose) | CRD Bike Counts page: automated counters "provide real-time data that updates daily"; public view at <https://data.eco-counter.com/ParcPublic/?id=4828>; partners are Victoria, Saanich, Colwood, Esquimalt and UVic; contact bikecount@crd.bc.ca. Volunteer counts each May and October ([CRD](https://www.crd.ca/node/4746)) | **No licence stated** | V |
| Eco-Visio data endpoint | The public page pulls JSON from an internal Eco-Counter endpoint. It is **not documented or licensed for reuse**, and a guessed path returned 404. The official Eco-Counter API is for the counter owner (CRD) | | V (no documented endpoint), U (API access model) |
| Saanich trail counters | Saanich Parks and CRD Parks use infrared trail counters as a general trend guide (also counts animals) ([Saanich page](https://www.saanich.ca/EN/main/parks-recreation-community/parks/parks-trails-amenities/trails/trail-usage-and-infrared-counters.html)) | | U (the page served an outage notice today) |
| CRD trail closures | Alerts are web pages under `https://www.crd.ca/news/alerts/...` (e.g. the Galloping Goose Viaduct Park closure, expected until spring 2027). **No RSS/API found** (`/rss.xml` 404, no feed link on `/news/alerts`) | | V (no feed); closure detail from search (U) |
| **BC Parks advisories** | Official API `https://bcparks.api.gov.bc.ca/api/public-advisories` (Strapi; **CORS `*`**); catalogue `bc-parks-data-api-access` with [endpoint doc](https://raw.githubusercontent.com/bcgov/bcparks.ca/main/infrastructure/kong/public-documentation.json) | **OGL-BC** | V |

Best path for counts: ask CRD (bikecount@crd.bc.ca) for an export or data-sharing permission rather
than scraping Eco-Visio.

---

## 6. Hazard and climate feeds ("Open City")

| Feed | URL | Browser CORS | Licence | Note |
|---|---|---|---|---|
| USGS earthquakes GeoJSON | `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson` | **Yes** (`*`) | "U.S. Public Domain"; credit "U.S. Geological Survey" ([USGS](https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits)) | V |
| NRCan Earthquakes Canada | FDSN `https://earthquakescanada.nrcan.gc.ca/fdsnws/event/1/query?starttime=…&minmagnitude=2&format=text` (pipe-delimited; also QuakeML) | **Yes** (`*`) | "Earthquakes Canada Usage Guidelines", citation requested ([policy page](https://origin2.earthquakescanada.nrcan.gc.ca/stndon/NWFA-ANFO/dist_policy-en.php)); licence text not found | V (endpoint, CORS), U (licence) |
| Tsunami (NTWC / PTWC) | Atom `https://www.tsunami.gov/events/xml/PAAQAtom.xml` (NTWC covers the BC coast), `PHEBAtom.xml`; CAP `PAAQCAP.xml` ([product retrieval](https://www.tsunami.gov/?page=productRetrieval)) | **No** | NWS content is public domain; do not imply endorsement or alter official material ([disclaimer](https://www.weather.gov/disclaimer)) | V. Relay or pre-fetch |
| Emergency Info BC | WordPress RSS `https://www.emergencyinfobc.gov.bc.ca/feed/` | **No** | Not stated | V (feed), U (terms) |
| NAAD (Pelmorex) | For broadcasters and "Last Mile Distributors" (TCP streams; LMD guide [PDF](https://alerts.pelmorex.com/wp-content/uploads/2026/01/NAADS-2.0-LMD-User-Guide.pdf)); archive <https://alertsarchive.pelmorex.com/>; LMD registration offered | n/a (not HTTP JSON) | Terms say use means acceptance; "as is"; **nothing on web redistribution** ([terms](https://alerts.pelmorex.com/terms-and-conditions-of-use)) | V. Heavy for a dashboard; use ECCC alerts instead |
| **ECCC weather alerts** | OGC API `https://api.weather.gc.ca/collections/weather-alerts/items?f=json` (GeoJSON polygons); GeoMet WMS `ALERTS` layer; CAP on Datamart `dd.weather.gc.ca` | **Yes** for api.weather.gc.ca and geo.weather.gc.ca; dd.weather.gc.ca sent no CORS header | ECCC Data Servers End-use Licence: commercial OK; credit "Data Source: Environment and Climate Change Canada"; warnings must not be altered in "content or intent" ([licence](https://eccc-msc.github.io/open-data/licence/readme_en/)) | V |
| Atmospheric rivers (CW3E) | AR Scale, AR Landfall Tool, IVT maps as PNGs ([CW3E forecasts](https://cw3e.ucsd.edu/iwv-and-ivt-forecasts/)); no JSON/netCDF listed | Images only (link or embed) | "intended for research purposes only", "experimental", "not intended to support decision making operations"; © Regents of UC | V. Link out with credit; don't rehost without asking |
| ENSO (NOAA CPC) | Status: **El Niño Advisory**, issued 12 Nov 2026, next update 10 Dec 2026 ([ENSO discussion](https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso_advisory/ensodisc.shtml)). Data: `https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt`, `RONI.ascii.txt` (Relative ONI, which CPC now links), weekly Niño 3.4 `wksst9120.for` (updated 2026-11-13) | **No** | NOAA, public domain (U for CPC specifically) | V. Pre-fetch in the daily Action |
| **Open-Meteo forecast + air quality** | `api.open-meteo.com/v1/forecast`, `air-quality-api.open-meteo.com/v1/air-quality` | **Yes** (`*`) | Free tier is non-commercial only: < 10,000 calls/day, 5,000/hour, 600/min; ads or subscriptions count as commercial; CC BY 4.0, credit "Weather data by Open-Meteo.com" with a link ([terms](https://open-meteo.com/en/terms), [licence](https://open-meteo.com/en/licence)) | V |
| Reverse geocoding (no key) | **Nominatim** `nominatim.openstreetmap.org/reverse` (CORS `*`): max 1 req/s, identify the app, **must cache**, attribution required, no client-side autocomplete; end-user-triggered use is "ok, provided that your number of users is moderate" ([policy](https://operations.osmfoundation.org/policies/nominatim/)). **BigDataCloud** `reverse-geocode-client` (CORS `*`): no key, but only for the **device's current location** from the browser; server or batch use gets an IP ban ([page](https://www.bigdatacloud.com/free-api/free-reverse-geocode-to-city-api)). **Photon** (CORS `*`): "please be fair", throttled, no guarantee ([photon](https://photon.komoot.io/)) | Yes (all three) | OSM data ODbL (U) | V |

---

## Recommendations

1. **Live Victoria transit first:** build a **Cloudflare Worker relay**. It caches `vehicleupdates.pb`
   for 15–30 s, decodes it to JSON, adds `Access-Control-Allow-Origin` and a "Source: BC Transit"
   field, and the github.io map polls it every 30 s. Static GTFS (routes and shapes) stays a daily
   Actions build. The owner creates the Cloudflare account; no card is expected for Workers Free (U).
2. **Always-on logging:** a **Raspberry Pi 5 4 GB kit (about CA$230, about CA$5/yr power)** running the
   existing `collect.py` as a systemd service, with a daily compacted file pushed to the repo or R2.
   Don't use GitHub Actions as the poller: its minimum is 5 min, runs get delayed or dropped, and its
   terms prohibit "serverless application" style use. The zero-hardware fallback is a Durable Object
   alarm + R2 (requires JS).
3. **Low-risk to use now (official, open licence, and browser-readable unless noted):**
   - USGS GeoJSON
   - NRCan FDSN
   - ECCC alerts (api.weather.gc.ca)
   - Open-Meteo (keep it non-commercial and credit it)
   - DriveBC Open511 events
   - DriveBC camera images (catalogue OGL-BC)
   - BC Parks advisories API
   - CPC ENSO files (pre-fetch, no CORS)
   - tsunami.gov Atom (pre-fetch or relay)
   - BC Transit GTFS-RT (via the relay)
4. **Use with care:** the Nominatim reverse geocoder (on user click only, cached); DriveBC's undocumented
   `/api/weather` and `/api/webcams` JSON (fetch server-side, prefer the catalogue CSV for the camera
   list); CW3E images (link and credit, research-only); MoTI traffic counts (ask the program for data).
5. **Higher risk / avoid for now:**
   - BC Ferries capacity via bcferriesapi.ca (an unofficial scraper; no licence from BC Ferries)
   - Eco-Visio internal endpoints (ask CRD instead)
   - aisstream redistribution (no published data terms; must stay server-side)
   - NAAD (a broadcaster channel)
   - Deno Deploy (sunset April 2027)
   - Vercel Hobby cron (daily only)
