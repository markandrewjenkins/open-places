# Open Places: how topics, leaves and detail are organised

## Built (Nov 15): one map stage, panels floating over it

The owner asked for fewer layers of nav bars, menus and padding, standalone dashboards embedded natively (no iframes),
a map or other visual anchor on most pages with detail as popups and drawers over it, and nothing relevant below the
fold on one large screen (designed for 2560x1440 at 100 %, checked at 1920x1080 and 1440x900; panels may scroll inside,
the page never does on desktop).

```
+----------+--------------------------------------------------------------------------------+
| rail     | [Summary] [Transit 3 min] [Roads & Cameras 9] [Malahat open] ...   <- ONE leaf bar  |
| (icons,  | +-KPI strip-+ [layer chips]                            +-right panel-------------+ |
|  topic   | +-----------+                                          | the leaf's own pane, or  | |
|  colour) | +-left panel-+        the shared MapLibre map          | a drawer (vehicle card,  | |
|          | | e.g. Next  |        (layers swapped per page)        | road speed, ...)         | |
|          | | Departures |               popups on click           |                          | |
|          | +------------+                                    [+-] +--------------------------+ |
+----------+--------------------------------------------------------------------------------+
```

- **Navigation**: the left rail (topics, line icons in the topic colour, a hover/focus tooltip with a live hint per
  page) and one leaf bar. No sub-tab row, no inlay header, no skin switch, no repeated eyebrow + heading + KPI block:
  the topic heading is visually hidden (kept for screen readers) and the KPI strip floats over the map.
- **The stage** (`site/places/civic-stage.js`): one MapLibre map behind every page except About. `stage.show({ key,
  specs, center, zoom })` swaps the layers; `stage.pad()` keeps the place centred in the area the panels leave free (the
  shell measures every element marked `data-pad="top|left|right|bottom"`); zoom buttons and credits sit in that free
  corner. Optional layers get chips (on/off remembered per page in this browser). Clicking a feature opens a popup;
  clicking it again closes it. Light/dark restyles the basemap and re-adds the layers. Phones and tablets (< 1100 px):
  the same map becomes a 260-400 px block in the page flow, with the panels stacked under it.
- **Pages**: every leaf renders in the shell (`civic.js` `leafHtml` / `renderLeaf`): its pane (if it has one) floats on
  the right, the stage panels on the left/right, its layers on the map. Pages without geography (Blossom, Foliage,
  Langford Boom, Route 95's on-time chart ...) show their charts in the right panel over the place's map.
- **Overview** = the same stage: title, a hero row of the basic live tiles (weather, air, the next bus, roads),
  "Around <place>" tiles on the left, the layer chips, **What You Need to Know** on the right, and a one-line glance
  strip of every topic at the bottom.
- **Real time first**: the Season month picker, "Preview a busy day" and the Summary/Everything toggle are gone; mock
  and planned pages are not tiles any more but are listed under About & Methodology -> Coming Later with the reason.

### What You Need to Know (`civic-brief.js`)

A rule-based plain-language briefing (no AI service): the official alerts (focused to the place), each live module's own
detectors (the rules that feed the Alert Feed), direct readings (Malahat status, air index, tsunami level, the next bus,
the weather now, the week's quakes) and warnings the op-alert feed raised in the last two hours. Ordered for an average
resident right now: **Act Now** (sev-3 warnings, tsunami, closures within 15 km, the Malahat closed), **Next Few Hours**
(rain or gusts coming, the Malahat single-lane, major road events, other warnings), **Worth Knowing** (moderate air,
recent quakes, trail closures, the next bus, the weather) and one **All quiet** line of what was checked and found calm.
Each item is one sentence with a source tag and freshness (the source's last successful fetch) and links to its page,
where the map and popups show it. At province level and wider the point-based rules (roads, bus, weather, air) are
skipped and the weather warnings in effect anywhere in the province are named by type instead.

### Level focus

A page shows what is about the current place first. Distance = how far up the place chain a module's node sits (the
place itself 0, its region 1, ...; basics, alerts and `at: "*"` modules count as 0). Alerts: kept if they are about the
place (`here`); at distance 1 only sev >= 2; further up only if `here`. The Overview's left column shows the place's own
live tiles and at most two urgent ones from the level above; the status line's sources panel lists the place's sources,
then "One level up" and "Further up" in smaller type.

### Module stage API (for dashboard owners)

A module can define `stage` on its own definition (it wins over the shell's entry in `civic-layers.js` STAGES):

```js
stage: {
  layout: "map" | "panel",           // map: a narrow right column, the map dominant; panel: a wide right panel
  wide: true,                        // map layout with a wider right column
  dz: -0.8,                          // zoom offset from the place's default view
  layers: ["roads", "cams"],         // ids of shared layers in civic-layers.js L (each { id, title, icon, color,
                                     //   kind: circle|line|fill|arrow|label, data(ctx) -> GeoJSON, select(f, ctx) -> Node,
                                     //   start(ctx, redraw) -> stop, optional, on })
  // or draw your own:
  layers: (map, ctx) => cleanup,     // add sources/layers to the shared map, return a function that removes them.
                                     //   Runs once per page and place; re-add your own layers after a style change
                                     //   (or set rerun: true on the spec to be called again).
  panels: (ctx) => [{ id, title, place: "left" | "right", el }],   // floating panels; keep the elements between calls
                                     //   if they hold state (the shell re-renders on every data refresh)
}
```

Built on it so far: Transit, Local Stops and Route 95 mount the Public Transit dashboard's own layers and cards
(`src/blink/tlayers.js`, `tcards.js`, `speed.js`, `tnext.js`, through `civic-transit-stage.js`): pastel routes, 2.5D
fleet sprites, a vehicle card drawer, and road-speed alerts (`.../speed:<rowId>`) open that road's speed card. Air
Traffic uses the air dashboard's own stage entry (in civic-modules.js); the Overview's aircraft layer uses the same
shared feed (`src/air/layer.js`). Roads & Cameras, Malahat, Ferries, Waterways, Trails, Quakes, Police and the Alerts
pages use the shared layers in `civic-layers.js` (TODO for owners: move them into their own `stage` entries).

## History: Nov 13 layout options


Before (Nov 13), `?p=langford#getting-around/transit` at 1440 px stacked three navigation levels: the left topic rail, a
thin row of leaf tabs that read as plain text, and inside the Transit leaf the inlaid dashboard's own left sidebar
(Overview, Live map, Next departures … Route 95) beside its own summary cards. That made two vertical menus side by side.

The owner asked for: topics on the left, leaves along the top of the right-hand section (with a Summary first), and the
detail under each leaf, with only one vertical menu on the page. Three ways to get there:

## Option A: Summary leaf + leaf tabs + flattened sub-tabs (built Nov 13; sub-tabs and inlays replaced Nov 15)

```
+------------+-------------------------------------------------------------------+
| Overview   | [# Summary 8] [o Transit 7 min] [o Roads & Cameras 9] [Air ...] > |  <- leaf bar (pills, topic colour)
| Right now  |  Overview  Live map  Next departures  Alerts | ROUTE 95  Punct... |  <- sub-tabs (inlaid page's menu)
| Weather    |  GETTING AROUND · LANGFORD                    NEXT DEP  VEHICLES  |
|>Getting... |  Next Departures                              7 min     28        |
| Hazards    | +---------------------------------------------------------------+ |
| ...        | |  inlaid dashboard, its own rail hidden                         | |
|            | +---------------------------------------------------------------+ |
+------------+-------------------------------------------------------------------+
```

- **Left rail = topics.** A topic link opens `#topic/summary`.
- **Leaf bar** along the top: the first pill is **Summary** (one compact tile per leaf with its numbers, status tag and a
  mini chart, reusing the overview tile, plus the topic's recent alerts); then one pill per source or sub-dashboard.
- **Sub-tabs**: when a leaf inlays a standalone console dashboard (Public Transit, Air Traffic, Waterways …), that page
  hides its rail (`html.cx-flat`, console.js) and posts its menu to the shell, which shows it as a second, smaller row.
  Deep links: `#getting-around/transit/live` → the inlaid page's `#live`. "Open full dashboard ↗" stays in the inlay header.

Pros: one vertical menu; every level is a visible, clickable control; deep links and the back button work at all three
levels; the screen stays one panel (inverted pyramid); the Summary gives each topic its own at-a-glance page.
Cons: the leaf bar scrolls sideways when a topic has many leaves (Getting Around has up to 12); two rows of tabs cost about
70 px of height; pages that are not console dashboards (Blossom, Foliage …) have no sub-tabs, so detail depth varies.

## Option B: leaves as multi-select chips, stacked panels on one scrolling page

```
+------------+-------------------------------------------------------------------+
| Overview   | Show: [x Transit] [x Roads] [ ] Route 95 [x Air traffic] [ ] ...  |  <- toggle chips (multi-select)
|>Getting... | +-- Transit ------------------------------------------------+     |
| Hazards    | | numbers · chart · list                                    |     |
| ...        | +-----------------------------------------------------------+     |
|            | +-- Roads & Cameras ----------------------------------------+     |
|            | | numbers · map · list                                      |     |
|            | +-----------------------------------------------------------+  v  |
+------------+-------------------------------------------------------------------+
```

Pros: compare two sources side by side (transit and roads during a storm); the chosen set can be remembered per person;
no Summary page needed, the stack is the summary.
Cons: the page scrolls, which breaks the one-screen console; full inlaid dashboards don't stack well (each wants the
whole panel), so they'd need a "compact" mode first; chips that toggle content are less obvious than tabs that navigate,
and deep links have to encode a set (`#getting-around?show=transit,roads`).

## Option C: accordion sections under each topic in the rail

```
+-----------------------+--------------------------------------------------------+
| Overview              |  GETTING AROUND · LANGFORD                             |
| v Getting around      |  Next Departures                                       |
|     Summary           | +----------------------------------------------------+ |
|   > Transit           | |  inlaid dashboard                                  | |
|       Live map        | |                                                    | |
|       Next departures | |                                                    | |
|     Roads & cameras   | +----------------------------------------------------+ |
| > Hazards             |                                                        |
+-----------------------+--------------------------------------------------------+
```

Pros: the whole tree is in one place; the content area gets its full height; familiar from file browsers and docs sites.
Cons: three nested levels in a 228 px rail get cramped and wrap; the rail becomes the only way to see what a topic holds
(the leaves aren't visible next to the content); on phones the rail is a sideways strip, so the accordion has to become
a separate menu sheet; it is the "nested menus" feel the owner wanted to get away from.

## Built: Option A

Files: `site/places/civic.js` (Summary leaf, leaf bar state, sub-tab row and hash sync), `civic.css` (leaf pills,
sub-tabs, Summary grid), `site/src/shared/console.js` / `console.css` (tablist semantics and keyboard for every
console's sub-topic tabs; the "flattened" embed mode that hides an inlaid page's rail and posts its menu).

Leaf styling: 32 px pill buttons outlined in the topic colour on a raised surface, each with a status dot (green = live,
ring = published data, amber square = mock, dashed ring = planned), the place it covers and a count. The selected pill is
filled with the topic colour (shaded by day for white text, lifted by night for dark text) with a notch joining it to
the content; `role="tablist"` / `"tab"`, `aria-selected`, roving tabindex, ←/→/Home/End, Space or Enter to open. On
phones the bar is a sideways scroll strip, with a fade on the edge that has more.
