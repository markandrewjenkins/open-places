# Heading rename: factual labels

Owner's request (2026-11-13): replace sentence and question headings such as "Where the buses are, and what the timetable promises" with short factual headers such as "Live Bus Map".

Rules applied:

- **View, pane, topic, overview and page headings (H1/H2):** 1 to 4 words, Title Case, no questions, no "you/your/we", no trailing period. A heading says what the panel shows. Place names stay only where the eyebrow doesn't already give them.
- **Card titles (H3) and tile titles:** only the ones that were questions or full sentences were changed. They stay in sentence case to match the cards around them.
- **Eyebrows:** changed only where they now repeated the heading. Notes, data, chart logic, ids, hashes and credits are unchanged.
- **About panes:** the heading is now "About & Methodology" and the eyebrow is the dashboard name, so the two lines don't repeat each other.
- **Overview headings:** now "Overview" because the kicker line above already names the place and date. Public Transit shows "Transit near {place}" when a place is picked.
- **BC Transit's "Blink" mark** is gone from our copy: the Open Places Route 95 heading and one mock departure row. Route names delivered in BC Transit's GTFS data are unchanged.
- **Not changed:** `export/` (old export copies), `docs/console.md`, the mockup gallery title "One screen, three levels", and left-nav and sub-tab labels (except "How accurate?", which became "Accuracy").

205 strings changed. Each dashboard section below lists its count.

## Alternatives for the most visible headings

The first option is the one now in the code. To use an alternative, edit the file shown. For a console module, change its `heading:` field.

| Where | In code now | Alternative 1 | Alternative 2 |
|---|---|---|---|
| Public Transit · Route 95 live (`src/blink/live.js`) | Live Map & Timetable | Live Bus Map | Route 95 Live |
| Public Transit · Live map (`src/blink/tmap.js`) | Live Vehicle Map | Live Transit Map | Vehicles Now |
| Public Transit · Next departures (`src/blink/tnext.js`) | Next Departures | Departures Nearby | Nearby Stops |
| Public Transit · Punctuality (`src/blink/ontime.js`) | Route 95 On-Time Performance | Route 95 Punctuality | On-Time Record |
| Public Transit · Rain (`src/blink/outlook.js`) | Rain Delay Outlook | Weather & Delays | Route 95 Rain Impact |
| Fairway Forecast · This week (`src/golf/week.js`) | Playable Hours This Week | Golf Forecast | Week Ahead |
| Langford · Building (`src/langford/building.js`) | New Homes Permitted | Langford Housing Starts* | Building Permits |
| Langford · Pipeline (`src/langford/pipeline.js`) | Pipeline & Approval Times | Development Pipeline | Applications & Timing |
| Toronto · Island ferry (`src/toronto/ferry.js`) | Crowd Forecast | Island Ferry Forecast | Ferry Ridership Forecast |
| Air Traffic · Overhead now (`src/air/now.js`) | Aircraft Overhead | Live Radar | Flights Overhead |
| Open Places · Transit basic (`places/civic-modules.js`) | Next Departures | Transit | Live Transit |
| Open Places · World map (`places/index.html`) | World Map | Choose a Place | Place Finder |
| Home page hero (`index.html`) | Open Places | Open Data Projects | Forecasts from Open Data |
| Cherry Blossom Watch hero (`blossom/index.html`) | Cherry Blossom Forecast | Peak Bloom Forecast | Bloom Forecast |
| Duck Curve hero (`grid/index.html`) | Duck Curve Forecast | Grid Forecast | Tomorrow's Net Demand |
| About panes (every `main.js`) | About & Methodology | Method & Sources | About This Dashboard |

\* The data counts permits, not starts. "Housing Starts" would be wrong unless that is reworded.

## Public Transit (17)

| Kind | Before | After | File |
|---|---|---|---|
| View heading | Where the buses are, and what the timetable promises | Live Map & Timetable | `src/blink/live.js` |
| View heading (+eyebrow) | Every vehicle, right now / Where every bus and train is | All vehicles / Live Vehicle Map | `src/blink/tmap.js` |
| View heading | What leaves next, near you | Next Departures | `src/blink/tnext.js` |
| View heading | Detours, closures and delays | Service Alerts | `src/blink/talerts.js` |
| View heading | Every route, how often and when | Route Network | `src/blink/tnet.js` |
| View heading | Does route 95 keep to its timetable? | Route 95 On-Time Performance | `src/blink/ontime.js` |
| View heading | How long do you really wait for a 95? | Route 95 Wait Times | `src/blink/wait.js` |
| View heading | Where does route 95 lose time: bus lanes or mixed traffic? | Route 95 Delay by Segment | `src/blink/corridor.js` |
| View heading | Is the rapid bus more reliable than the routes around it? | Route 95 vs Nearby Routes | `src/blink/compare.js` |
| View heading | Does rain slow the 95, and what's ahead? | Rain Delay Outlook | `src/blink/outlook.js` |
| About heading (+eyebrow) | About & method / How this dashboard is made | Public Transit / About & Methodology | `src/blink/main.js` |
| Overview heading | Transit in {region} right now / Transit around {place} right now | Overview / Transit near {place} | `src/blink/main.js` |
| Tile title | On time? | On time | `src/blink/ontime.js` |
| Drawer title | How the model works | Rain model | `src/blink/outlook.js` |
| Card title | Why uneven buses mean longer waits | Bunching and wait time | `src/blink/wait.js` |
| Card title | Every trip through distance and time | Trips by distance and time | `src/blink/wait.js` |
| Card title | Which hours have been watched | Hours watched by time of day | `src/blink/live.js` |

## Air Traffic (8)

| Kind | Before | After | File |
|---|---|---|---|
| View heading | What's flying overhead right now | Aircraft Overhead | `src/air/now.js` |
| View heading | Who's landing and taking off, and on which runway | Arrivals, Departures & Runways | `src/air/airports.js` |
| View heading | Flying weather at the nearby airports | Airport Weather | `src/air/weather.js` |
| View heading | When is the sky over Greater Victoria busiest? | Busiest Hours | `src/air/busy.js` |
| About heading (+eyebrow) | About & method / How this dashboard is made | Air Traffic / About & Methodology | `src/air/main.js` |
| Overview heading | The sky over {place} at a glance | Overview | `src/air/main.js` |
| Card title | Recent movements, from the log | Recent movements (log) | `src/air/airports.js` |
| Card title | How high, how far | Altitude and distance | `src/air/now.js` |

## Fairway Forecast (golf) (12)

| Kind | Before | After | File |
|---|---|---|---|
| View heading | When you can play this week | Playable Hours This Week | `src/golf/week.js` |
| View heading | Which courses are worth the green fee | Course Rankings | `src/golf/tiers.js` |
| View heading | When the golf season really runs | Season by Month | `src/golf/months.js` |
| View heading | How far ahead to trust the forecast | Forecast Accuracy | `src/golf/trust.js` |
| View heading | Every mapped hole, green and bunker | Holes, Greens & Bunkers | `src/golf/explore.js` |
| View heading | How well each course is mapped | Course Mapping Quality | `src/golf/coverage.js` |
| About heading (+eyebrow) | About & method / How this dashboard is made | Fairway Forecast / About & Methodology | `src/golf/main.js` |
| Overview heading | The golf week at a glance | Overview | `src/golf/main.js` |
| Card title | Did it call the good golf day right? | Good-day hit rate | `src/golf/trust.js` |
| Card title | The plain answer | Summary | `src/golf/trust.js` |
| Card title | Harder in winter | Miss by month | `src/golf/trust.js` |
| Card title | Why daylight hours are lost | Lost hours by cause | `src/golf/week.js` |

## Langford Boom Tracker (12)

| Kind | Before | After | File |
|---|---|---|---|
| View heading | How fast is Langford building? | New Homes Permitted | `src/langford/building.js` |
| View heading | How fast are people arriving? | Population Growth | `src/langford/growth.js` |
| View heading | How many homes in the next year? | New Homes Forecast | `src/langford/forecast.js` |
| View heading | What's in the pipeline, and how long does it take? | Pipeline & Approval Times | `src/langford/pipeline.js` |
| View heading | What did the land look like before? | Then & Now | `src/langford/thennow.js` |
| About heading (+eyebrow) | About & method / How this dashboard is made | Langford Boom Tracker / About & Methodology | `src/langford/main.js` |
| Overview heading | The boomtown at a glance | Overview | `src/langford/main.js` |
| Tile title | How fast it's building | Homes permitted | `src/langford/building.js` |
| Tile title | What's in the pipeline | Development pipeline | `src/langford/pipeline.js` |
| Sub-tab | How accurate? | Accuracy | `src/langford/forecast.js` |
| Card title | Why a flat line? | Flat-line forecast | `src/langford/forecast.js` |
| Card title | Each forecast's next-12-month total vs what happened | 12-month totals vs actual | `src/langford/forecast.js` |

## Waterways (ships) (11)

| Kind | Before | After | File |
|---|---|---|---|
| View heading | What's moving on the water | Live Vessel Map | `src/ships/water.js` |
| View heading | When the water is busiest | Busiest Times | `src/ships/busy.js` |
| View heading (+eyebrow) | Fraser River · tides and water levels / How high is the water? | Fraser River / Tides & Water Levels | `src/ships/river.js` |
| View heading | Works, wrecks and hazards on the water | Marine Hazards | `src/ships/notices.js` |
| About heading (+eyebrow) | About & method / How this dashboard is made | Waterways / About & Methodology | `src/ships/main.js` |
| Overview heading | On the water around {region} | Overview | `src/ships/main.js` |
| Card title | What kind of traffic | Traffic by type | `src/ships/busy.js` |
| Card title | How high the Fraser is running | Fraser River flow | `src/ships/river.js` |
| Card title | Who uses the river | River users | `src/ships/river.js` |
| Card title | How to read the map | Map key | `src/ships/water.js` |
| Card title | What they're about | By topic | `src/ships/notices.js` |

## Toronto City Pulse (12)

| Kind | Before | After | File |
|---|---|---|---|
| View heading | Should you go to the Island this week? | Crowd Forecast | `src/toronto/ferry.js` |
| View heading | Bikes right now, and the week ahead | Bike Availability & Forecast | `src/toronto/bike.js` |
| View heading | When and why the subway stops | Delay Times & Causes | `src/toronto/ttc.js` |
| View heading | The forecast behind the forecasts | 7-Day Forecast | `src/toronto/weather.js` |
| About heading (+eyebrow) | About & method / How this dashboard is made | Toronto City Pulse / About & Methodology | `src/toronto/main.js` |
| Overview heading | The city at a glance | Overview | `src/toronto/main.js` |
| Card title | What moves trips | Trip drivers | `src/toronto/bike.js` |
| Card title | When Toronto rides | Trips by hour and weekday | `src/toronto/bike.js` |
| Card title | When the crowds peak | Peak hours | `src/toronto/ferry.js` |
| Card title | What moves the crowd | Crowd drivers | `src/toronto/ferry.js` |
| Card title | Ferry riders it implies | Implied ferry riders | `src/toronto/weather.js` |
| Card title | Bike Share trips it implies | Implied Bike Share trips | `src/toronto/weather.js` |

## West Coast Water (waves, shelved) (8)

| Kind | Before | After | File |
|---|---|---|---|
| View heading | Is it worth driving to the coast this week? | Surf Forecast | `src/waves/surf.js` |
| View heading | When is the water flat enough to paddle? | Paddling Forecast | `src/waves/calm.js` |
| View heading | What is the ocean doing right now? | Live Ocean Conditions | `src/waves/live.js` |
| View heading | How much should you trust day 3 vs day 1? | Accuracy by Lead Time | `src/waves/trust.js` |
| About heading (+eyebrow) | About & method / How this dashboard is made | West Coast Water / About & Methodology | `src/waves/main.js` |
| Overview heading | Where's the water good this week? | Overview | `src/waves/main.js` |
| Card title | How far to trust it | Forecast reliability | `src/waves/main.js` |
| Card title | Reading it | Spot notes | `src/waves/surf.js` |

## Cherry Blossom Watch (9)

| Kind | Before | After | File |
|---|---|---|---|
| Page H1 | When will the cherry blossoms peak? | Cherry Blossom Forecast | `blossom/index.html` |
| Eyebrow | Spring {year} forecast | Spring {year} | `src/blossom/main.js` |
| Eyebrow (pre-load) | Spring forecast | Spring | `blossom/index.html` |
| Section H2 | Scrub through spring | Bloom Map | `blossom/index.html` |
| Section H2 | Which trees are worth the trip? | Best Trees to Visit | `blossom/index.html` |
| Section H2 | The bloom calendar | Bloom Calendar | `blossom/index.html` |
| Section H2 | Blossoms are arriving earlier | Bloom Date Trend | `blossom/index.html` |
| Section H2 | How good is the forecast? | Forecast Accuracy | `blossom/index.html` |
| Card title | Does the forecast sharpen as spring approaches? | Error by lead time | `blossom/index.html` |

## Dark Sky Finder (8)

| Kind | Before | After | File |
|---|---|---|---|
| Page H1 | Where's the darkest sky tonight? | Dark Sky Forecast | `darksky/index.html` |
| Section H2 | Pick your spot | Sky Brightness Map | `darksky/index.html` |
| Section H2 | Best places to go | Best Sites | `darksky/index.html` |
| Section H2 | Will the aurora reach us? | Aurora Outlook | `darksky/index.html` |
| Section H2 | Mapping the glow | Light Pollution Model | `darksky/index.html` |
| Card title | Leaving the glow | Darkness by distance | `darksky/index.html` |
| Card title | Where is it getting brighter? | Brightening by town | `darksky/index.html` |
| Card title | What the model leans on | Model inputs | `darksky/index.html` |

## Fire, Water & Rock (hazards) (8)

| Kind | Before | After | File |
|---|---|---|---|
| Page H1 | Fire, water & rock | Fire, Water & Rock | `hazards/index.html` |
| Section H2 | Everything happening at once | All Active Hazards | `hazards/index.html` |
| Section H2 | How many fires will start this week? | Fire Starts This Week | `hazards/index.html` |
| Section H2 | Can weather predict fire starts? | Model Accuracy | `hazards/index.html` |
| Section H2 | November 2021: how rare was the atmospheric river? | 2021 Atmospheric River | `hazards/index.html` |
| Section H2 | What are the odds of a big earthquake? | Earthquake Odds | `hazards/index.html` |
| Card title | What drives the model | Model inputs | `hazards/index.html` |
| Card title | The one this can't see | Cascadia blind spot | `hazards/index.html` |

## Snowpack to Tap (water) (8)

| Kind | Before | After | File |
|---|---|---|---|
| Page H1 | Snowpack to tap | Snowpack to Tap | `water/index.html` |
| Section H2 | From mountain snow to the tap | Supply Network | `water/index.html` |
| Section H2 | Where are Lake Powell and Lake Mead heading? | Powell & Mead Outlook | `water/index.html` |
| Section H2 | How much water will reach Lake Powell next spring? | Lake Powell Spring Inflow | `water/index.html` |
| Section H2 | The snow seasons | Snow Seasons | `water/index.html` |
| Section H2 | California's big reservoirs, today | California Reservoirs | `water/index.html` |
| Section H2 | Ninety years of Lake Mead | Lake Mead History | `water/index.html` |
| Card title | How good is it? | Forecast skill | `water/index.html` |

## Salish Sea Live (7)

| Kind | Before | After | File |
|---|---|---|---|
| Page H1 | Listen to the Salish Sea | Salish Sea Hydrophones | `salish/index.html` |
| Eyebrow | Live from under the water | Live underwater audio | `salish/index.html` |
| Section H2 | Whales and ships | Whales & Ships | `salish/index.html` |
| Section H2 | Whale sound tier list | Whale Sound Tier List | `salish/index.html` |
| Section H2 | Will you hear whales this week? | Whale Sound Forecast | `salish/index.html` |
| Section H2 | Helping volunteers find the calls | Call Triage Model | `salish/index.html` |
| Card title | What the model listens for | Model inputs | `salish/index.html` |

## California Duck Curve (grid) (8)

| Kind | Before | After | File |
|---|---|---|---|
| Page H1 | When the sun sets, the duck stands up | Duck Curve Forecast | `grid/index.html` |
| Eyebrow | California's grid · forecast for {date} | California's grid · {date} | `src/grid/main.js` |
| Section H2 | Can open data match the grid operator? | Forecast vs CAISO | `grid/index.html` |
| Section H2 | The duck is getting deeper every spring | Duck Curve Trend | `grid/index.html` |
| Section H2 (pre-load) | Where yesterday's power came from | Yesterday's Power Mix | `grid/index.html` |
| Section H2 | Where power came from on {date} | Power Mix, {date} | `src/grid/main.js` |
| Card title | Where in the day the forecast misses | Error by hour of day | `grid/index.html` |
| Card title | Batteries now move sunshine into the evening | Battery output by hour | `grid/index.html` |

## Fall Foliage Watch (13)

| Kind | Before | After | File |
|---|---|---|---|
| Page H1 | When will the leaves peak? | Fall Colour Forecast | `foliage/index.html` |
| Eyebrow | Autumn {year} forecast | Autumn {year} | `src/foliage/main.js` |
| Eyebrow (pre-load) | Autumn forecast | Autumn | `foliage/index.html` |
| Section H2 | Scrub through autumn | Colour Map | `foliage/index.html` |
| Section H2 | Which trees are worth the walk? | Best Trees to Visit | `foliage/index.html` |
| Section H2 | The colour calendar | Colour Calendar | `foliage/index.html` |
| Section H2 (pre-load) | Where's the colour this weekend? | Weekend Colour | `foliage/index.html` |
| Section H2 | Where's the colour on the coast and beyond? / …in cottage country? | Coast & Interior Colour / Cottage Country Colour | `src/foliage/main.js` |
| Section H2 (pre-load) | Is autumn arriving later? | Autumn Timing Trend | `foliage/index.html` |
| Section H2 | Is autumn arriving later? Here, yes. / Is autumn arriving later? | Autumn Timing: Trending Later / Autumn Timing Trend | `src/foliage/main.js` |
| Section H2 | How good is the forecast? | Forecast Accuracy | `foliage/index.html` |
| Section H2 | Colour spotted this month | Recent Sightings | `foliage/index.html` |
| Card title | Warm Septembers delay autumn | September warmth vs timing | `foliage/index.html` |

## Sunday Wander (6)

| Kind | Before | After | File |
|---|---|---|---|
| Page H1 | Where shall we wander this Sunday? | Scenic Drives, Rides & Walks | `sunday/index.html` |
| Section H2 | Plan a trip | Trip Planner | `sunday/index.html` |
| Section H2 | What makes a good outing? | Rating Weights | `sunday/index.html` |
| Section H2 (pre-load) | The best roads | Top Roads | `sunday/index.html` |
| Section H2 | The best roads in {region} for a drive/ride/walk | Top Drives/Rides/Walks · {region} | `src/sunday/main.js` |
| Section H2 | Classic routes, rated | Classic Routes | `sunday/index.html` |

## Home page (site/index.html) (1)

| Kind | Before | After | File |
|---|---|---|---|
| Page H1 | Forecasting the world from free, open data | Open Places | `index.html` |

## Open Places mockup (48)

| Kind | Before | After | File |
|---|---|---|---|
| Topic heading | Weather and daylight | Weather & Daylight | `places/civic-modules.js` |
| Topic heading | How clean is the air? | Air Quality | `places/civic-modules.js` |
| Topic heading | When's the next one? | Next Departures | `places/civic-modules.js` |
| Topic heading | How are the roads? | Road Conditions | `places/civic-modules.js` |
| Topic heading | Anything to know about right now? | Active Alerts | `places/civic-modules.js` |
| Topic heading | How fast is Langford growing? | Growth & Housing | `places/civic-modules.js` |
| Topic heading | What's moving in Langford right now? | Local Stops & Cameras | `places/civic-modules.js` |
| Topic heading | What is the City of Langford saying? | Municipal Notices | `places/civic-modules.js` |
| Topic heading | Any earthquakes nearby? | Nearby Earthquakes | `places/civic-modules.js` |
| Topic heading | When do the cherries peak? | Cherry Blossom Forecast | `places/civic-modules.js` |
| Topic heading | When do the leaves peak? | Fall Colour Forecast | `places/civic-modules.js` |
| Topic heading | Where should we go this Sunday? | Scenic Routes | `places/civic-modules.js` |
| Topic heading | Can I hear whales right now? | Whale Calls & Sightings | `places/civic-modules.js` |
| Topic heading | When can I play golf this week? | Playable Golf Hours | `places/civic-modules.js` |
| Topic heading | Is the 95 Blink on time? | Route 95 On-Time Performance | `places/civic-modules.js` |
| Topic heading | What's flying overhead? | Aircraft Overhead | `places/civic-modules.js` |
| Topic heading (x2) | Who's out on the water? | Vessel Traffic | `places/civic-modules.js` |
| Topic heading | Will I get on the next ferry? | Sailing Capacity | `places/civic-modules.js` |
| Topic heading | Is the Malahat open? | Malahat Status | `places/civic-modules.js` |
| Topic heading | How busy are the trails? | Trail Traffic | `places/civic-modules.js` |
| Topic heading | How busy will the ferry be? | Ferry Crowd Forecast | `places/civic-modules.js` |
| Topic heading | How busy is Bike Share? | Bike Share Usage | `places/civic-modules.js` |
| Topic heading | When and why is the subway late? | Subway Delays | `places/civic-modules.js` |
| Topic heading | Where does my tap water come from? | Water Supply | `places/civic-modules.js` |
| Topic heading | Is there a tsunami threat? | Tsunami Status | `places/civic-modules.js` |
| Topic heading | Fire, flood and quake risk in BC | Fire, Flood & Quake Risk | `places/civic-modules.js` |
| Topic heading | Is an atmospheric river coming? | Atmospheric River Outlook | `places/civic-modules.js` |
| Topic heading | Anything out of the ordinary? | Unusual Patterns | `places/civic-modules.js` |
| Topic heading | Where's the nearest dark sky? | Nearest Dark Skies | `places/civic-modules.js` |
| Topic heading | What is the grid doing tomorrow? | Grid Forecast | `places/civic-modules.js` |
| Topic heading | What is the country being warned about? | National Weather Alerts | `places/civic-modules.js` |
| Topic heading | What kind of winter is coming? | Winter Outlook | `places/civic-modules.js` |
| Topic heading | Big earthquakes around the world | Major Earthquakes | `places/civic-modules.js` |
| Topic heading | El Niño, La Niña or neutral? | El Niño / La Niña | `places/civic-modules.js` |
| Mock row (Blink mark) | Langford Exchange · 95 Blink | Langford Exchange · 95 | `places/civic-modules.js` |
| Card title | Active now, most serious first | Active alerts | `places/civic-modules.js` |
| Card title | Sources checked for this place | Sources checked | `places/civic-modules.js` |
| Card title | {topic}: what this tile will show | {topic} (planned) | `places/civic-modules.js` |
| Card title | Why it ranks where it does | Ranking factors | `places/civic-modules.js` |
| Card title | Why it's low in the step | Ranking factors | `places/civic-modules.js` |
| Card title | What the numbers mean | Index guide | `places/civic-modules.js` |
| Card title | {city}: when peak colour arrives ({year}) | {city} peak colour, {year} | `places/civic-modules.js` |
| Card title | Five patterns worth knowing about | Pattern watch | `places/civic-modules.js` |
| Card title | The belly, deepening by year | Belly depth by year | `places/civic-modules.js` |
| Card title | How ENSO usually tilts winter | Typical ENSO effects | `places/civic-modules.js` |
| World-map H1 | Pick a place. | World Map | `places/index.html` |
| About card title | How a screen is ordered | Screen layout | `places/civic.js` |

## Mockup gallery pages (site/mockups/*.html) (9)

| Kind | Before | After | File |
|---|---|---|---|
| Mock H2 | When, where and how much bloom | Overview | `mockups/blossom.html` |
| Mock H2 | When will the cherry blossoms peak? | Peak Bloom Forecast | `mockups/blossom.html` |
| Card title | How sure is it? | Forecast error | `mockups/blossom.html` |
| Mock H2 | Tomorrow's grid at a glance | Overview | `mockups/grid.html` |
| Mock H2 | The duck gets deeper every spring | Duck Curve by Year | `mockups/grid.html` |
| Card title | Batteries fill the neck | Battery output by hour | `mockups/grid.html` |
| Mock H2 | Whales, ships and sound, right now | Overview | `mockups/salish.html` |
| Mock H2 | Which whale calls can I trust? | Whale Call Tier List | `mockups/salish.html` |
| Card title | Where the calls come from | Calls by hydrophone | `mockups/salish.html` |

