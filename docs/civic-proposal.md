# Open Places: one dashboard for every place (proposal, 2026-11-12; decisions 2026-11-13)

**Decided 2026-11-13:**
- **Name:** Open Places (plural). Earlier drafts used "Civic Atlas", then "Open City". It's plural because you browse many places, and it covers regions, provinces and states as well as cities.
- **Standalone dashboards:** keep the standalone repos alongside the combined site.
- **Basics:** cover any place in the world.
- **First region:** Greater Victoria, meaning the CRD and its municipalities.
- **West Coast Water:** shelved.
- **Layout:** the owner wants an inverted pyramid across both topic and scale. The order runs alerts → basics →
  municipality → region → province/state → country → world, with each step up showing fewer but more critical items.
  New hazard and pattern modules: earthquakes, tsunami, atmospheric rivers / Pineapple Express, ENSO, and unusual
  patterns.
- **Design:** conservative and neutral, a Claude-like dark grey with a light flip. The mockup v2 explores this.

**The idea:** a single site that opens on a world map. Pick a place, and it serves a one-screen console for that
metro area:
- the basics everyone wants (weather, air, transit, roads and cameras, alerts);
- the special-interest topics that make the place itself, such as cherry blossoms in Victoria, whale calls in the
  Salish Sea and the Island ferry in Toronto.

Everything is built from open data, and each topic appears only where it applies.


## Why it exists

**Tagline (chosen 2026-11-13):** "What's happening where you live, from open public data, on one page."

**About (chosen 2026-11-13):**
> A lot of what happens around you is measured, and much of it is published for anyone to use. Open Places
> gathers it in one spot, so you can see what's going on where you live: today, this season, and over the years.
>
> Every number shows where it came from and how fresh it is. Open data only, no sign-in, no ads, no analytics.

**What it tries to do well:**
- **Most useful first.** Alerts and the basics come before the niche and the local.
- **Show its working.** Every number carries its source, its age and, where there's a forecast, a backtest of how
  well it has done.
- **Say what it doesn't know.** Gaps, unmapped data and licence limits are stated on the page, not hidden.
- **Credit everyone.** Agencies, researchers and volunteers publish this data so it gets used; each module credits
  them by name.

---

## 1. Name

| Option | Why it works | Watch-outs |
|---|---|---|
| **Civic Atlas** (recommended) | It starts on a map, "civic" says public data, and it scales from one city to many. Each region page reads naturally: "Civic Atlas · Greater Victoria". | Check the name isn't taken on GitHub or as a domain. |
| Local Pulse | Grows out of Toronto City Pulse, and it's live-feeling. | Sounds like a news app. |
| Open City | Plain and honest about the open data. | Very generic, with many existing uses. |
| Placeboard | Short and brandable: "a dashboard for a place". | It's an invented word. |
| Here & Now | Friendly, and good for "use my location". | Hard to search for. |

The existing dashboards keep their own names as modules ("Cherry Blossom Watch, in Civic Atlas").

## 2. How it's organised: four kinds of module

Every module states where it applies. The shell shows a module when the selected place falls inside its footprint.

| Kind | Shows up | Modules |
|---|---|---|
| **Basics** | Every place. Each country or province uses a different data source behind the same tile. | Weather & daylight, Air quality, Transit, Roads & cameras, Alerts |
| **Only here** | Inside a metro area | Cherry Blossom Watch, Fall Foliage Watch, Sunday Wander, Salish Sea Live, Toronto ferry / Bike Share / TTC, West Coast Water, Golf, Langford Boom Tracker, Blink 95 |
| **Wider lenses** | Inside a large footprint (a province, a grid region or a river basin) | Fire, Water & Rock (BC hazards), Snowpack to Tap ("where your tap water comes from": LA, San Diego, Phoenix, Tucson, Las Vegas), California Duck Curve ("your power grid": California metros), Dark Sky Finder ("nearest dark skies from here") |
| **Sub-area** | Inside a municipality within a metro | Langford Boom Tracker inside Greater Victoria; neighbourhood views later |

The "global" dashboards don't really sit outside the model; they have bigger footprints:
- the Duck Curve is the power-grid topic for California metros;
- Snowpack to Tap is the water-supply topic for the Southwest;
- Fire, Water & Rock feeds the Alerts tile for BC metros;
- Dark Sky works anywhere it has light-pollution data (BC and Arizona today).

They also stay reachable from a "Beyond the city" shelf on the world map, so nothing is orphaned.

### Where each place stands today

| Place | Only here | Wider lenses | Count |
|---|---|---|---|
| **Greater Victoria** | Blossoms, Foliage, Sunday Wander, Salish Sea, West Coast Water, Golf, Langford, Blink 95 | Hazards, Dark Sky | 10 |
| **Greater Vancouver** | Blossoms, Foliage, Sunday Wander, Salish Sea, West Coast Water, Golf | Hazards, Dark Sky | 8 |
| **Toronto** | Ferry / Bike Share / TTC, Foliage | — | 2–4 |
| **Seattle / Puget Sound** | Salish Sea | — | 1 |
| **LA, San Diego, SF Bay, Sacramento** | — | Duck Curve, Snowpack to Tap (LA, SD) | 1–2 |
| **Phoenix, Tucson, Las Vegas** | — | Snowpack to Tap, Dark Sky (Arizona) | 1–2 |
| **Anywhere else** | — | — | Basics only |

Greater Victoria is the obvious first city: it has the most modules, and BC Transit's live feed needs no key.

## 3. Layout (follows the one-screen, inverted-pyramid rule)

### Level 0: World map
- **Map:** a full-screen MapLibre globe. Lit cities are sized by how many modules they have, and hovering shows
  "Greater Victoria · 10 dashboards".
- **Finding a place:** a search box, a "Use my location" button and a "Basics anywhere" hint: click any spot for weather,
  air, quakes and daylight.
- **Beyond the city shelf:** a strip along the bottom with the wider lenses, as an index and an entry point.

### Level 1: Region console (one screen, no scroll on desktop)
```
┌ Civic Atlas  World › Canada › BC › Greater Victoria ▾   [search]          Design ▾  ☾ ┐
├──────────────┬────────────────────────────────────────────────────────────────────────┤
│ OVERVIEW     │ RIGHT NOW  12° light rain · AQHI 2 · next Blink 4 min · 1 road alert    │
│ THE BASICS   ├────────────┬────────────┬────────────┬────────────┬────────────────────┤
│  Weather     │ Weather    │ Air        │ Transit    │ Roads/cams │ Alerts             │  ← small, same everywhere
│  Air         ├────────────┴──────┬─────┴────────────┴──┬─────────┴────────────────────┤
│  Transit     │ IN SEASON         │                    │                              │
│  Roads & cams│ Fall Foliage      │ West Coast Water   │ Salish Sea Live              │  ← larger tiles, ordered by
│  Alerts      │ peak in 6 days    │ Jordan River: A    │ 3 S-tier calls this week     │    what's interesting NOW
│ ONLY HERE    ├───────────────────┼────────────────────┼──────────────────────────────┤
│  Foliage  ●  │ Sunday Wander     │ Golf               │ Langford Boom · Blink 95     │
│  Waves       │ best loop: Marine │ 6 playable hrs Sat │ 61 units/month · 78% on time │
│  Whales      │                   │                    │                              │
│  …           │                                                                        │
│ WIDER LENSES │  (Cherry blossoms drop to the bottom row in November and rise in March) │
│  Hazards     │                                                                        │
│  Night sky   │                                                                        │
└──────────────┴────────────────────────────────────────────────────────────────────────┘
```
- **Basics row:** five compact tiles in the same position in every city, so the page feels familiar anywhere.
- **Special-interest grid:** equal-sized tiles ordered by a **seasonal relevance score**. Each module reports how
  relevant it is today (0–1): blossoms peak in March–April, foliage in October, whales in summer, waves in winter swell
  season. The most interesting topics rise to the top on their own, and no single topic looks like "the main one".
- **Left rail:** grouped into Basics, Only here and Wider lenses. The badges show each topic's headline number, and a dot
  marks topics that are in season.
- **Breadcrumb:** doubles as a region switcher. Pick a sub-area such as Langford and the page re-focuses on it.

### Levels 2–3: drill-down
These levels reuse the shared console being built now: topic → sub-view → a detail drawer docked on the right (a bottom
sheet on phones). Each dashboard's current views become a module's sub-views, with no rewrite of its analysis.

### Phones
- **Overview:** a single column. The "Right now" strip stays pinned, the basics become a horizontally swipeable row,
  and the special tiles follow.
- **Navigation:** the rail becomes tabs.

## 4. The basics: which open data each one uses

| Basic | Victoria / Vancouver | Toronto | California / Arizona | Anywhere |
|---|---|---|---|---|
| Weather & daylight | ECCC + Open-Meteo | ECCC + Open-Meteo | NWS + Open-Meteo | Open-Meteo |
| Air quality | ECCC AQHI | ECCC AQHI | AirNow (check whether it needs a key) | Open-Meteo air quality |
| Transit | BC Transit GTFS + live feed, no key (Victoria); TransLink timetables, but its live feed needs a key | TTC GTFS (live feed to be checked) | Agency GTFS | Mobility Database catalogue (timetables only) |
| Roads & cameras | DriveBC cameras and Open511 events; City of Vancouver cameras | City of Toronto cameras, Ontario 511 | Caltrans cameras and road info | Not available |
| Alerts | ECCC alerts, BC Wildfire, DriveBC, earthquakes (USGS / Natural Resources Canada) | ECCC alerts | NWS alerts, CAL FIRE, USGS | Earthquakes (USGS) |

**Caveat:** live feeds called from the browser can be blocked by the provider's browser security settings (CORS), or
arrive in a binary format (GTFS-Realtime). Each source will be checked and, where needed, covered by a small pipeline
snapshot every few minutes. Some of these feeds may not allow that much polling; I'll check each before relying on it.

## 5. Packaging and technology

- **The monorepo stays the single source of truth.** Every dashboard keeps its own repo, daily refresh and standalone
  page. Those pages are portfolio pieces and the best deep links.
- **A new `civic-atlas` repo holds only the shell:** the world map, the region resolver, the basics, and the module
  front-end code bundled from the monorepo.
  - **Data:** it reads each dashboard's published data straight from its GitHub Pages site. They all live under
    markandrewjenkins.github.io, which is one origin, so there are no cross-site issues, no copying, and each dashboard's
    refresh stays independent.
- **Module contract** (being built now in `site/src/shared/console.js`): every module provides:
  - its metadata (id, title, colour);
  - **footprint**: polygons or region ids;
  - **kind**: basic, only here, lens or sub-area;
  - **relevance(ctx, date)**: the seasonal score;
  - **tile(host, ctx)**, **subs** and **drawers**: the views at each level;
  - **load(ctx)**: lazy loading of its data.

  The same module code renders both in its standalone page and inside Civic Atlas.
- **Regions:**
  - **Hierarchy:** world → country → province/state → metro → municipality.
  - **Boundaries:** open metro boundaries (Statistics Canada census metropolitan areas, US Census metro areas) and
    municipal boundaries.
  - **Matching:** a point-in-polygon check finds the place, then every module whose footprint overlaps it.
  - **Data file:** a small `regions.json` built in the pipeline.
- **Design skins:** a page that shows ten modules at once can't wear ten skins.
  - Civic Atlas gets its own design: Classic plus one or two themes of its own.
  - Embedded modules follow the shell's design.
  - Each standalone page keeps its signature skin (Sakura.exe, Sonar Room and so on). An "Open full dashboard ↗" link
    on every module leads to it.
- **Performance:** only the overview tiles load at first; a module's full data loads when you open it. The map and
  chart libraries are shared across modules.

## 6. Phases

1. **Foundation (in progress):** the shared console and module contract. The four new dashboards (West Coast Water,
   Langford, Golf, Blink 95) are being built on it.
2. **Shell MVP for Greater Victoria:**
   - the world map with a single lit city;
   - a region console with live basics (weather, AQHI, BC Transit, DriveBC cameras, alerts);
   - the specials as overview tiles that link to their full dashboards.

   This is fast to ship because no dashboard needs converting yet.
3. **Native modules:**
   - convert each dashboard into a module that opens inside the console;
   - add the seasonal ordering;
   - add Greater Vancouver and Toronto.
4. **Wider lenses and "basics anywhere":**
   - the California and Arizona metros with the grid, water and dark-sky lenses;
   - basics for any clicked place in the world.
5. **Extras:**
   - sub-areas (Langford, neighbourhoods);
   - compare two cities side by side;
   - "My places" saved in the browser;
   - a shareable link for every view (already a feature of the console's address scheme).

## 6b. What the mockup taught us (site/places/index.html, 2026-11-13)

The mockup worked around ten gaps in `site/src/shared/console.js`. The real shell needs them fixed in the console itself:
- **Placement:** show, hide and reorder modules per place after creation, without loading or drawing hidden modules.
- **Data loading:** `load(ctx)` keyed by region, so live feeds can differ by place.
- **Layout:**
  - a separate basics row;
  - tile-grid sizing that follows the visible modules;
  - section headings in the rail (`paintNav` assumes every child is a topic group);
  - a controls slot in the overview header.
- **Titles and routes:** a document title that follows the place, and routes outside the console (`#world`).
- **Source tags:** a per-tile source kind (live / data / mock).

## 6c. Mockup v2 (2026-11-13): what the owner steered towards

- **Look:** v1's colourful design is back as the default (navy "Night lights" and cream "Day chart"), now in Inter
  throughout. (Superseded the same day: see Designs below.)
- **Navigation:**
  - The left nav lists main topics only, most useful first: Every day (Right now, Weather & air, Getting around,
    Hazards), This place (Your municipality, Seasons & nature, Outdoors & leisure, Growth & housing, Water & power)
    and Bigger picture (Climate & patterns).
  - Each topic's pages are tabs across the top of the right panel, ordered from here outwards to the planet, and
    each tab is tagged with the area it covers.
  - Links take the form `#topic/page`.
- **Two views:** Summary is the default one-screen pyramid. Everything is a dense scrolling feed in the same order,
  where every item clicks through.
- **Inlaid dashboards:** drilling into a full dashboard shows it in a frame:
  `../<page>/?embed=1&skin=places|alt&theme=light|dark[&region=…]`, with a per-frame toggle between the Open Places
  look and the dashboard's own theme. The standalone pages still need an embed mode and a shared `places` skin.
- **Still mock:** transit, cameras, tsunami and ENSO; there's no reverse geocoding yet.
- **Designs (decided 2026-11-13):** Default = Harbour, alternate = Blue (formerly Tide). The Design button in the top
  bar switches between the two, and each has a light and a dark mode. Both start from v1 Classic (its text colours,
  topic colours and dark "now" band) and add Aero Lite's glass: cards at least 92% opaque, a soft highlight edge,
  gentle corners, and solid hairlines instead of dotted or dashed rules.
  - **Default** (no `?skin`, formerly Harbour): a bright cool-white page by day and Classic's navy at night, with
    softened corners instead of pills.
  - **Blue** (`?skin=blue`, formerly Tide): sky and aqua accents, a faint sky-tint page, a glass rail and top bar,
    and glossy pill tabs. At night it is Classic's navy deepened toward blue-teal, with amber alert highlights.

  The other designs (Classic, Clear Sky, Aero Lite, Aero, Aero Max, Neutral, Slate, Newsprint and Terminal) were
  removed on 2026-11-13. If one of them was the saved choice, the page opens in Default.

## 7. Decisions for you

1. **Name:** Civic Atlas, or another option.
2. **Standalone dashboards:** keep them alongside the combined site (recommended), or fold everything into one site.
3. **Design:** Civic Atlas has its own design and modules follow it (recommended), or each module keeps its skin
   inside the shell.
4. **Scope of "basics anywhere":** show basics for any place in the world from the start, or only for lit cities.
5. **First city:** Greater Victoria (recommended), with Vancouver and Toronto in phase 3.
