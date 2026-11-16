# Fairway Forecast: OpenStreetMap golf mapping kit

The tier list can only rank a course whose holes are mapped in OpenStreetMap (OSM). The courses below have an outline
but few or no holes, so they are unranked or carry only a **provisional** tier estimated from the outline (dashed on the
page; see the README's "Fairway Forecast: method in brief"). Mapping their holes replaces the estimate with a real rank.

You need your own free OSM account (sign up at openstreetmap.org). Everything below is done in the iD editor in the
browser; nothing needs installing.

## What gets a course ranked

The pipeline (`pipelines/golf/courses.py`, `build.py`) ranks a course when **both** hold:

- at least **85% of its holes** have a `golf=hole` line, and
- mapping **completeness is 70% or more**: hole lines 55%, greens 15%, tees 10%, fairways 10%, hazards 10% (any bunker or
  water on the course). Short courses (pitch & putt, par 3) don't need fairways (that share counts the greens again) and get the hazard share free.

So for a full course **every hole line plus every green is exactly 70%**: the minimum (a short course reaches 90% with those two). Tees, fairways and par make the score better and
more honest. What each part feeds:

| You map | The dashboard uses it for |
|---|---|
| `golf=hole` line, tee to green | hole length (the biggest weight), climb on the walk, number of holes, water in play |
| `par` on every hole | the par feature (counted only when every hole has a par) |
| `golf=bunker` areas | bunkers per hole |
| `natural=water` + `golf=water_hazard` / `lateral_water_hazard` | water in play (a hazard within 25 m of a hole line) |
| `golf=tee`, `golf=green`, `golf=fairway` | completeness; and they show where each hole line starts and ends, which is where sea and lake views are measured |
| `holes=18` (or 9, 27…) on the course outline | the number of holes the course should have; without it the pipeline guesses from the area |

## How to map a course (a few minutes a hole once you're in the rhythm)

1. Open the course's **iD link** from the tables below and sign in. Press **B** to open the Background panel and pick
   an imagery layer OSM is allowed to trace from: **Esri World Imagery** (usually the sharpest here) or **Bing Maps
   Aerial**; Mapbox Satellite is also permitted. Everything in iD's own imagery list is cleared for tracing.
   **Never trace from Google Maps, Google Earth, Street View or a club's course map**: they are copyrighted and edits
   copied from them get reverted. If the imagery looks shifted against roads or paths already in OSM, line it up in the
   Background panel's "Imagery Offset" first.
2. **Trace one hole at a time**, in this order, then move on:
   - **Tee boxes**: one closed area per tee box, preset "Tee Box" (`golf=tee`).
   - **Green**: closed area, preset "Putting Green" (`golf=green`).
   - **Hole line**: a line from the **back tee to the middle of the green**, bending at the dogleg along the line of
     play; preset "Golf Hole" (`golf=hole`). Set **`ref`** = hole number and **`par`** = 3, 4 or 5 (optionally
     `handicap`). Draw it in the direction of play; the pipeline reads the tee from the first point.
   - **Fairway**: closed area, preset "Fairway" (`golf=fairway`); par 3s usually have none.
   - **Bunkers**: closed areas, preset "Sand Trap" (`golf=bunker` + `natural=sand`).
   - **Water**: `natural=water` with `golf=water_hazard` (crossing the hole) or `golf=lateral_water_hazard` (alongside
     it). Ponds already mapped as plain `natural=water` inside the course are counted too; just add the golf tag.
   Keep everything **inside the course outline** (`leisure=golf_course`): features are assigned to the course whose
   outline contains them.
3. Hole numbers and par from your own knowledge of the course: the tee signs or a scorecard you played with. Don't copy
   them from another map.
4. **Upload every few holes** (Save, top right) with a comment like "Royal Colwood: holes 1–6 traced from Esri World
   Imagery". iD records the imagery used in the changeset. Smaller uploads are easier to fix.
5. When the course is done, add **`holes=18`** (or the real count) to the course outline if it's missing.

## When the dashboard picks the edits up

The pipeline reads the **BBBike weekly OSM extracts** of Victoria and Vancouver. The daily GitHub Actions run (06:30
Pacific) re-downloads an extract once its copy is **6.5 days old** (`OSM_MAX_AGE_DAYS` in `pipelines/golf/config.py`),
so an edit shows up after the next BBBike extract that contains it is downloaded: **usually within a week, at most
about two**. The page's left rail shows "course maps <date>", the date of the extract in use; edits after that date
aren't in yet. The Map coverage topic then shows the new completeness, and the course moves from provisional to ranked
once it passes the thresholds above.

## The courses

Victoria first, then Vancouver; within each, full courses (largest first), then short courses. "Now" is the state in
the current build. Short courses get no provisional tier (too few mapped short courses to test the method on), so
mapping them is the only way onto the list. \* = the hole count is a guess from the outline's area (no `holes` tag and
no holes mapped): check it, and tag the outline with the real count.

### Greater Victoria

| Course | Now | Missing in OpenStreetMap | Edit | OSM object |
|---|---|---|---|---|
| Royal Colwood Golf Club \* | provisional A; 0/18 holes | all 18 hole lines; 15 greens; tees (3 mapped); fairways (3 of ~14); par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/48.4432/-123.4832) | [relation 2557711](https://www.openstreetmap.org/relation/2557711) |
| Gorge Vale Golf Course \* | provisional B; 1/18 holes | 17 of 18 hole lines; 15 greens; tees (8 mapped); fairways (3 of ~14); par on 17 holes | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/48.4425/-123.4108) | [relation 10397300](https://www.openstreetmap.org/relation/10397300) |
| Arbutus Ridge Golf and Country Club \* | provisional B; 0/18 holes | all 18 hole lines; 12 greens; tees; fairways (6 of ~14); par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/48.6879/-123.5472) | [relation 907311](https://www.openstreetmap.org/relation/907311) |
| Ardmore Golf Course \* | provisional D; 0/9 holes | all 9 hole lines; 8 greens; tees (2 mapped); fairways (2 of ~7); par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/48.6354/-123.4617) | [way 151269713](https://www.openstreetmap.org/way/151269713) |
| Mount Douglas Golf Course \* | provisional D; 0/9 holes | all 9 hole lines; greens; tees; fairways; par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/48.4817/-123.3501) | [way 153751839](https://www.openstreetmap.org/way/153751839) |
| Green Acres Par 3 Driving Range \* | unranked, no provisional tier (short course); 0/18 holes | all 18 hole lines; greens; tees; par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/48.3937/-123.5183) | [way 667414520](https://www.openstreetmap.org/way/667414520) |
| Cordova Bay Golf Course - Ridge Course \* | unranked, no provisional tier (short course); 0/9 holes | all 9 hole lines; greens; tees; par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/48.5307/-123.3769) | [way 117596878](https://www.openstreetmap.org/way/117596878) |
| Henderson Park Golf Course \* | unranked, no provisional tier (short course); 0/9 holes | all 9 hole lines; greens; tees; par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/48.4566/-123.3125) | [way 151292667](https://www.openstreetmap.org/way/151292667) |

### Greater Vancouver

| Course | Now | Missing in OpenStreetMap | Edit | OSM object |
|---|---|---|---|---|
| Swaneset Bay Resort & Country Club \* | provisional A; 8/18 holes | 10 of 18 hole lines; 13 greens; fairways (7 of ~14); par on 10 holes | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/49.3069/-122.6595) | [way 41779106](https://www.openstreetmap.org/way/41779106) |
| Point Grey Golf & Country Club \* | provisional A; 0/18 holes | all 18 hole lines; tees (11 mapped); par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/49.2238/-123.185) | [way 31399643](https://www.openstreetmap.org/way/31399643) |
| Richmond Country Club \* | provisional B; 0/18 holes | all 18 hole lines; 4 greens; tees; fairways; par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/49.1278/-123.1249) | [way 24941563](https://www.openstreetmap.org/way/24941563) |
| Mayfair Lakes Golf Course \* | provisional C; 0/18 holes | all 18 hole lines; 1 green; par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/49.1753/-123.0346) | [relation 1256003](https://www.openstreetmap.org/relation/1256003) |
| Quilchena Golf & Country Club \* | provisional C; 0/18 holes | all 18 hole lines; tees; fairways; par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/49.1616/-123.1926) | [way 35894312](https://www.openstreetmap.org/way/35894312) |
| Guildford Golf & Country Club \* | provisional C; 0/18 holes | all 18 hole lines; par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/49.1454/-122.8069) | [relation 1272613](https://www.openstreetmap.org/relation/1272613) |
| Beach Grove Golf and Country Club \* | provisional C; 0/18 holes | all 18 hole lines; tees; par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/49.0246/-123.0628) | [way 421207112](https://www.openstreetmap.org/way/421207112), [way 24487957](https://www.openstreetmap.org/way/24487957) |
| Marine Drive Golf Club \* | provisional A; 0/18 holes | all 18 hole lines; 15 greens; tees (11 mapped); fairways (7 of ~14); par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/49.2166/-123.1606) | [way 37058593](https://www.openstreetmap.org/way/37058593) |
| Green Acres Golf Course \* | provisional D; 0/9 holes | all 9 hole lines; par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/49.1756/-123.0631) | [relation 1255999](https://www.openstreetmap.org/relation/1255999) |
| Savage Creek Golf Course | provisional D; 15/18 holes | 3 of 18 hole lines; 3 greens; par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/49.1608/-123.0632) | [way 119107965](https://www.openstreetmap.org/way/119107965) |
| Delta Golf Club \* | provisional D; 0/9 holes | all 9 hole lines; 8 greens; tees; fairways; par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/49.0979/-122.8934) | [way 24722746](https://www.openstreetmap.org/way/24722746) |
| Eaglequest Golf Coyote Creek | provisional D; 14/18 holes | 4 of 18 hole lines; 4 greens; par on 5 holes | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/49.1421/-122.7985) | [relation 1272480](https://www.openstreetmap.org/relation/1272480) |
| Nicowynd Golf Course \* | provisional C; 0/9 holes | all 9 hole lines; greens; tees; fairways; par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/49.0707/-122.8332) | [way 26639269](https://www.openstreetmap.org/way/26639269) |
| Mylora Executive Golf Course \* | provisional D; 0/9 holes | all 9 hole lines; greens; tees; fairways; par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/49.1425/-123.0836) | [way 25147198](https://www.openstreetmap.org/way/25147198) |
| Sunshine Woods Golf Club \* | provisional D; 0/9 holes | all 9 hole lines; greens; tees; fairways; par on every hole; bunkers / water | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/49.1183/-122.9309) | [way 24633719](https://www.openstreetmap.org/way/24633719) |
| Eaglequest Golf \* | provisional D; 0/9 holes | all 9 hole lines; tees; fairways; par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/49.2316/-122.8707) | [way 41835587](https://www.openstreetmap.org/way/41835587) |
| Meridian Golf Course \* | provisional C; 0/9 holes | all 9 hole lines; greens; tees; fairways; par on every hole; bunkers / water | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/49.0215/-122.7559) | [way 26634957](https://www.openstreetmap.org/way/26634957) |
| Kensington Pitch and Putt \* | unranked, no provisional tier (short course); 0/18 holes | all 18 hole lines; tees; par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/49.277/-122.9788) | [way 40395741](https://www.openstreetmap.org/way/40395741) |
| Central Park Pitch & Putt \* | unranked, no provisional tier (short course); 0/18 holes | all 18 hole lines; 17 greens; tees (3 mapped); par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/49.2232/-123.0151) | [way 42434882](https://www.openstreetmap.org/way/42434882) |
| Unnamed course, Richmond \* | unranked, no provisional tier (short course); 0/9 holes | all 9 hole lines; greens; tees; par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/49.1795/-123.0669) | [way 155251906](https://www.openstreetmap.org/way/155251906) |
| Ambleside Par 3 \* | unranked, no provisional tier (short course); 0/18 holes | all 18 hole lines; 2 greens; tees; par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/49.3231/-123.1454) | [way 371985312](https://www.openstreetmap.org/way/371985312) |
| Murdo Frazer Pitch & Putt \* | unranked, no provisional tier (short course); 0/18 holes | all 18 hole lines; greens; tees; par on every hole | [iD](https://www.openstreetmap.org/edit?editor=id#map=17/49.3342/-123.1087) | [way 255159669](https://www.openstreetmap.org/way/255159669) |

Notes on a few courses:

- **Gorge Vale** has one hole line already (`par` set); trace the other 17 the same way.
- **Savage Creek** (15 of 18 holes) and **Eaglequest Coyote Creek** (14 of 18) are close: three or four more hole lines
  and their greens rank them. Savage Creek has no `par` on any hole yet.
- **Swaneset Bay** has 8 holes and 19 tee boxes mapped. Its outline is 175 ha, far more than one 18-hole course needs;
  if it covers more than one course, tag the real total (e.g. `holes=36`) so the pipeline expects every hole.
- **Cordova Bay Ridge Course** and **Henderson Park** are counted as short courses from their size (under 0.75 ha a
  hole); tag `golf:course=pitch_and_putt` on the outline if that's right, or `holes=*` if the count differs.
- **Green Acres Par 3 Driving Range** (Langford) sits about 200 m inside the south edge of the Victoria extract
  (48.392 N); anything mapped south of that line isn't read.

The tables come from `site/public/data/golf/courses.json` as built from the OSM extract of 2026-11-07. The Map coverage
topic on the page always shows the current state, course by course, with an "Edit in OSM" link.
