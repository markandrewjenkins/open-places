# Open Places live relay (Cloudflare Worker)

Transit agencies' real-time feeds are open (no key) but send no CORS headers, so a page on github.io can't read them.
This Worker fetches them for the page, at most once every 15 seconds (Calgary 30) per feed and Cloudflare location,
and adds CORS for the dashboards' origins only. One upstream request serves every viewer at that location. It only
fetches the agencies on its allow-list (`src/agencies.js`: all 35 BC Transit systems, TTC, Calgary Transit, Edmonton
Transit Service, King County Metro, SacRT, the MBTA and BART), so it is not an open proxy. The worker's name stays
`bct-relay` so the deployed URL doesn't change.

## Live hub (Durable Object, Workers Paid)

Before the hub, every route fetched its upstream on a cache miss at each Cloudflare location, so upstream calls grew
with locations and places, and every viewer made 6–10 relay calls a minute. `src/hub.js` adds one Durable Object class
(`LiveHub`, SQLite-backed, binding `HUB`) with **one object per live source**, which polls on a fixed clock however many
people watch, keeps the latest trimmed snapshot in memory and in DO storage (a restart serves the last good copy), and
sleeps when nobody asks:

| Source (object name) | Clock | Upstream |
|---|---|---|
| `transit:victoria` | vehicles + trip updates every 20 s, alerts every 60 s | BC Transit GTFS-Realtime (operator 48) |
| `air:48.50,-123.50,46` | 30 s (10 s while a client sent `fast=air` in the last 60 s), stretched to fit adsb.lol's daily budget (below) | adsb.lol, adsb.fi failover; `ADSBLOL_API_KEY` sent if set |
| `ais:salish` | one persistent websocket, reconnect 5 s → 5 min backoff, housekeeping alarm 60 s | aisstream.io (`AISSTREAM_API_KEY`) |
| `roads:-125,47.5,-122,49.5` | 60 s | DriveBC Open511 (it rate-limited us before) |

- **Sets** (`src/sets.js`) are Open Places place ids: `crd` (alias `victoria`), `langford`, `victoria-city`, `saanich` and
  the other CRD municipalities. Every CRD place shares the same four sources: one aircraft circle (46 nm around
  48.50, -123.50, which holds every place's 22 nm circle and the Air Traffic page's 40 nm view), one DriveBC box, one AIS
  area. So the whole region costs each upstream one call per clock, whichever places are open.
- **adsb.lol daily budget:** the air source counts its adsb.lol calls per UTC day (in DO storage) and paces itself so
  the allowance lasts until 00:00 UTC: interval = max(30 s, or 10 s in fast mode, seconds left in the UTC day / calls
  left). The budget is `ADSBLOL_DAILY_BUDGET` if set (a Worker variable or secret, e.g. 7000 for a feeder's key), else
  **450** without `ADSBLOL_API_KEY` and **950** with it (headroom under adsb.lol's 500 and 1,000). Light use stays at
  the normal clock; watching all day spreads the calls evenly (keyless: one call about every 2.5–3 minutes; with a key
  about every 90 s), so the feed never runs dry for the rest of the day. Once the day's budget is spent the source
  makes no more calls until midnight UTC and serves its last snapshot marked stale. The air part's meta carries
  `{ budget, used, every_s }` so pages can say how often positions update; the browser moves aircraft on between reports.
- **Waking and sleeping:** a source wakes on its first request (it fetches at once; with an old stored copy it waits
  up to 3 s, else serves the old copy marked stale) and stops its alarms, closing the websocket, after **10 minutes**
  with no request. Asleep it costs nothing.
- **Upstream manners:** 429s are honoured (Retry-After, default 60 s; DriveBC 300 s), and air.js still rests a 429'd
  or 403'd upstream. User-Agent `openplaces relay (hub)`. The AIS key is only ever sent to aisstream and is cut out of
  any error text.
- **`GET /live?set=<id>[&parts=transit,alerts,air,ais,roads][&fast=air]`** returns every part in one answer:
  `{ set, name, region, ll, served_epoch, parts: { <part>: { asOf, fetched, served, age_s, every_s, stale, error, data } } }`.
  `data` is exactly what the old route returns (shapes in `site/src/shared/livehub.js`). `stale` is true when the
  last poll failed or the copy is older than 2.5 clocks, so a page can show DELAYED rather than LIVE. `&debug=1` adds
  each source's upstream call count and whether it was asleep.
- **Edge caching:** `/live` answers are cached for 5 s per Cloudflare location (Cache API, keyed on set + parts + fast)
  and each source's answer until its next poll is due, so the DO sees about one request per source per clock per
  location, not one per viewer.
- **Old routes** answer from the hub too, with the same bodies: `/rt/victoria/vehicles.json`, `alerts.json`,
  `vehicles.pb`, `trips.pb`, `alerts.pb`; `/air/point.json` for circles up to 30 nm inside the region's circle (cut down
  to the asked circle; the Air Traffic page's 40 nm / 10 s polling stays on the old route until it moves to `/live`
  with `fast=air`); `/ais/salish.json`; `/drivebc/events.json` for any box inside the region box (cut down by geometry;
  Open511's own box match is a little looser at the edges, so an answer can differ by an event far from the place).
  Everything else (other agencies, `/victoria/*`, METAR, `/local/`, `/tsunami/`) is unchanged. Without the `HUB`
  binding (e.g. `node dev.mjs`), or if the hub fails, every old route falls back to its old per-request path.
- **Client:** `site/src/shared/livehub.js` (`liveSet(placeId, { parts, fast })`, `livePart(…)` for modules with their
  own pollers) polls `/live` once per place every 20 s (10 s with fast aircraft while the hub's air clock is that fast;
  alerts and roads ride along every 60 s), paused while the tab is hidden, and backs
  off to 60 s → 8 min on any non-JSON or non-200 answer (including Cloudflare's 1103 page when a spending limit is
  reached), keeping the last data marked DELAYED. A relay without the hub (its root page doesn't name `/live`) is
  detected once per page and every module falls back to its old route.
- **Wired (2026-11-15):** Open Places' Local Stops buses, aircraft (tile, map layer and Air Traffic leaf, which asks for
  fast mode), BC Ferries and the stage's ships, and DriveBC events for every CRD place; Public Transit's Victoria buses
  and alerts; the standalone Air Traffic page in Greater Victoria (fast mode). Measured locally on
  `places/?p=langford#overview`: 3 `/live` calls a minute plus Local Stops' `trips.pb` (2 a minute), down from 8 relay
  calls a minute. Outside the CRD every page keeps its old routes.

### Monthly cost (Workers Paid, estimate)

Workers Paid is US$5 a month and includes 10 M Worker requests, 30 M CPU-ms, 1 M Durable Object requests (alarms
count) and 400,000 GB-s of DO duration; beyond that $0.30 per M requests, $0.02 per M CPU-ms, $0.15 per M DO requests,
$12.50 per M GB-s (Cloudflare's published prices as given to us on 2026-11-15; check before relying on them).

- **Hub, while someone watches all day:** about 7,700 alarms a day (transit 4,320, air ≤ 950 under its daily budget, roads 1,440, AIS 1,440)
  plus about 11,500 DO requests a day per busy Cloudflare location: roughly 0.3 M + 0.35 M per location a month.
  Duration: the AIS object holds its socket and can't hibernate, so it is billed all the time it is awake
  (128 MB × 30 days ≈ 324,000 GB-s); the polling objects are awake about a second per poll (≈ 32,000 GB-s). Total
  ≈ 356,000 GB-s, inside the 400,000 included. Only one object ever holds the AIS socket. Asleep (no viewers for
  10 min): nothing.
- **Viewers:** once the pages use `/live`, an all-day viewer with the tab visible makes 3 requests a minute, about
  4,300 a day, 130,000 a month (before: 6–10 calls a minute, 8,600–14,400 a day). Hidden tabs make none.

| All-day viewers | Worker requests / month | DO requests / month | Estimated bill |
|---|---|---|---|
| none (idle) | ~0 | ~0 | **$5.00** |
| 10 | 1.3 M | ~0.7 M | **$5.00** |
| 100 | 13 M | ~1.0 M | **≈ $6** (3 M extra requests $0.90) |
| 1,000 | 130 M | ~1.5–4 M | **≈ $45** (120 M extra requests $36, CPU ≈ $3, DO requests ≈ $0.50) |

CPU per `/live` request is about 1–2 ms (a cache hit passed through). The rest of the site's relay calls (METAR,
`/local/`, `/tsunami/`, the Air Traffic page, other agencies) come on top until they move to the hub. Set a spending
limit in the Cloudflare dashboard; when it is reached Workers answer HTTP 1103 and `livehub.js` backs off to 60 s or
more and shows the last data as DELAYED.

### Deploy the hub (owner, after upgrading to Workers Paid)

```bash
cd workers/bct-relay
npx.cmd wrangler deploy
```
The `[[migrations]]` block in `wrangler.toml` (tag `v1`, `new_sqlite_classes = ["LiveHub"]`) creates the class on this
first deploy; later deploys don't repeat it. Optional: `npx.cmd wrangler secret put ADSBLOL_API_KEY` (a free adsb.lol
key) and, if not already set, `npx.cmd wrangler secret put AISSTREAM_API_KEY`. Then check
https://bct-relay.openplaces.workers.dev/live?set=langford shows `"stale": false` for transit, air and roads (the first
call takes a second or two) and `/live?set=langford&debug=1` lists the four sources. To turn the hub off without
losing anything, delete the `[[durable_objects.bindings]]` block and redeploy: every old route falls back to its own
upstream fetch.

Test it locally first (no account needed; Durable Objects run in `wrangler dev`):
```bash
cd workers/bct-relay
npx.cmd wrangler dev --local --port 8790 --var HUB_IDLE_S:90   # HUB_IDLE_S shortens the 10-minute sleep for testing
curl "http://localhost:8790/live?set=langford&debug=1"
```

| Path | What |
|---|---|
| `/live?set=<place>[&parts=…][&fast=air]` | every live part for one Open Places place in one answer, from the hub (above) |
| `/rt/` | the agencies on the allow-list, with each one's feeds and credit line |
| `/rt/<agency>/vehicles.json` (`?route=` short name or id, `?bbox=w,s,e,n`) | every vehicle position: route, trip, direction, bearing, speed, stop, status, occupancy |
| `/rt/<agency>/alerts.json` (`?route=`) | service alerts with effect, cause, severity, routes, stops and active periods |
| `/rt/<agency>/trips.json?stops=a,b,c` (up to 30) | live predictions at those stops; big agencies answer 413 with `{use: "/rt/<agency>/trips.pb"}` |
| `/rt/<agency>/vehicles.pb`, `trips.pb`, `alerts.pb` | the raw GTFS-Realtime feeds, with CORS (the page decodes big agencies' `trips.pb` itself) |
| `/victoria/vehicles.json` (`?route=95` to filter) | Route 95's original route, kept for the logger and older pages: every Victoria bus, with the trip's current delay merged in |
| `/victoria/alerts.json` (`?route=95`) | service alerts |
| `/victoria/vehicles.pb`, `trips.pb`, `alerts.pb` | the raw GTFS-Realtime feeds |
| `/air/point.json?lat=&lon=&r=` (r in nm, 5–100) | aircraft near a point for Air Traffic and Open Places, from adsb.lol (ODbL) with adsb.fi as a fallback; position snapped to 0.05°, 15 s cache, privacy-flagged (LADD/PIA) aircraft anonymised, ground vehicles dropped, 5 s cache (the page polls every 5 s) |
| `/air/metar.json?ids=CYYJ,CYWH` (up to 12) or `?bbox=lat0,lon0,lat1,lon1` (up to 4° a side) | METAR and TAF from the NOAA Aviation Weather Center (public domain), 5-minute cache |
| `/drivebc/events.json?bbox=w,s,e,n` (BC, ≤ 3° a side, snapped to 0.5°) | active DriveBC Open511 road events for Open Places' Roads & Cameras and Malahat tiles (OGL-BC), trimmed, 2-minute cache |
| `/ais/salish.json` | live ships for Waterways from aisstream.io, once the `AISSTREAM_API_KEY` secret is set (see below); without it, `{"needs_key": true}` |
| `/local/meetings.json?org=langford` | City of Langford council and committee meetings from its eSCRIBE public calendar (21 days back, 90 ahead): name, local time, place, agenda link; 1-hour cache (`src/local.js`) |
| `/local/police.json` | police news-release headlines (title, date, link, agency) from West Shore, Sooke and Sidney North Saanich RCMP, Victoria, Saanich and Oak Bay police, past 120 days; headlines and links only, 15-minute cache (`src/local.js`) |

Every transit JSON response carries the agency's credit line, as its terms require (BC Transit's Open Data Terms of
Use: credit BC Transit, no implied endorsement, no BC Transit marks; the others are listed in `src/agencies.js` and the
README's Public Transit credits). Upstream errors come back as 502, and upstream 429s as 429 with a Retry-After.

The `/air/` routes exist because adsb.lol, adsb.fi and aviationweather.gov send no CORS headers either (adsbdb.com does,
so the page asks it directly for flight routes). Neither needs a key today;
if adsb.lol starts requiring one, set it as a Worker secret (`npx wrangler secret put ADSB_KEY`) and read it in `src/air.js`,
never in the page. Upstream 429s are passed on as 429 with a Retry-After, and the page backs off.

## Try it locally (no account needed)

```bash
node workers/bct-relay/dev.mjs --test                 # decodes one sample of each Victoria feed and exits
node workers/bct-relay/dev.mjs --test-rt ttc bart     # vehicles.json, alerts.json and trips.pb for some agencies
node workers/bct-relay/dev.mjs                        # serves http://localhost:8787
```
Then open http://localhost:5173/blink/?relay=http://localhost:8787 (add `&region=toronto` etc. for another region).

## Deploy (owner, once, about 10 minutes)

1. Create a free Cloudflare account at https://dash.cloudflare.com/sign-up. No card is needed for Workers Free.
2. In a terminal at the repo root, sign in:
   ```bash
   npx wrangler login
   ```
   A browser window opens for Cloudflare's own sign-in.
3. Deploy:
   ```bash
   npx wrangler deploy --config workers/bct-relay/wrangler.toml
   ```
   It prints the URL, e.g. `https://bct-relay.<your-subdomain>.workers.dev`.
4. Put that URL in `site/src/shared/relay.js` (`export const RELAY = "https://bct-relay.…workers.dev"`), re-export
   Public Transit and push. The page then switches itself to live mode, and falls back to timetables (and Route 95
   to its logged snapshot) whenever the relay is unreachable.

**Redeploy after a code change** (for example the 2026-11-13 `/rt/` routes for Public Transit), from the repo root:
```bash
npx.cmd wrangler deploy --config workers/bct-relay/wrangler.toml
```
(`npx` works too outside PowerShell.) Then check `https://bct-relay.openplaces.workers.dev/rt/` lists the agencies.

**Free-plan headroom** (before the hub; with the hub the relay needs Workers Paid, see above):
- **Requests:** 100,000 requests a day. A page open on the live map polls every 20 s, which is 180 requests an
  hour, so the plan covers about 550 viewer-hours a day.
- **CPU (10 ms per request on Workers Free):** vehicle feeds decode in about 0.1–1.4 ms and alerts are small, but
  trip-update feeds are 0.6–2.5 MB and take 9–47 ms, so the relay only decodes them for small agencies; for big ones
  (Victoria, King County, TTC, Calgary, Edmonton, MBTA) it passes `trips.pb` through and the page decodes it. Decoded
  JSON is cached per request URL, so repeat requests cost no decoding at all.
- **Allowed origins:** to let another site use the relay, edit `ALLOWED_ORIGINS` in `wrangler.toml`.

## Live ships for Waterways (aisstream.io, optional)

aisstream.io's free community AIS stream needs an API key, and its terms don't allow the key in a browser, so the
relay holds it as a secret. A request that finds no listen running at its Cloudflare location starts one (about 25
seconds, in the background after the response) and is answered at once from the last snapshot; the listen merges what
it heard into a rolling 20-minute state kept in Cloudflare's cache. A cold location waits about 6 seconds for its first
snapshot. A lock keeps each location to one listen at a time, so a page polling every 30 seconds keeps the relay
listening about 25 seconds in every 30 (the old 7-second listen once a minute left moving ships' positions ~12 minutes
old, because aisstream's feed for this box carries only 2–3 reports a second). Without the secret the route answers
`{"needs_key": true}` and the Waterways page stays on its replay of a real day.

1. Sign up at https://aisstream.io/ (it signs in with GitHub) and create an API key on its API Keys page.
   The key is yours: don't paste it into chat, a page or a commit.
2. Store it in the Worker as a secret (it prompts for the value):
   ```bash
   npx wrangler secret put AISSTREAM_API_KEY --config workers/bct-relay/wrangler.toml
   ```
3. Redeploy the relay so it has the `/ais/` route:
   ```bash
   npx wrangler deploy --config workers/bct-relay/wrangler.toml
   ```
4. Check https://bct-relay.<your-subdomain>.workers.dev/ais/salish.json shows `"count"` above 0 (the first call takes
   about 6 seconds). The Waterways map then shows "Live" on its own; nothing in the site needs changing.

To try it locally first (the key stays in your shell, not in a file):
```bash
AISSTREAM_API_KEY=<your key> node workers/bct-relay/dev.mjs 8789
```
then open http://localhost:5173/ships/?relay=http://localhost:8789#water/map.

Limits: aisstream allows 3 open connections per key and may limit bandwidth on uncompressed connections; each
Cloudflare location holds at most one connection at a time (about 25 s of every 30 while someone is watching), so up
to three busy locations fit; a fourth would see errors and be served its last snapshot marked stale.
The Workers Free plan's 10 ms CPU limit counts only CPU, not the seconds spent waiting on the socket, but parsing a
busy 25-second listen can approach it; with the hub deployed, `/ais/salish.json` is served from the one `ais:salish` object, which keeps a single
connection open while anyone watches (one of aisstream's three), and the per-location listens above no longer run.

The 24/7 Route 95 reliability log is separate: that's the collector (`python -m pipelines.blink.collect`) on an
always-on machine, not this Worker.
