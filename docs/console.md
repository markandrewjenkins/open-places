# Console: the shared dashboard shell

Every dashboard in this portfolio uses the same one-screen "inverted pyramid" layout (the owner's rule):

1. **Overview**: one equal tile per topic, with headline numbers and one small chart each. No topic should look like the main one.
2. **Topic**: the left rail opens a topic. It shows a summary strip of key numbers, then one main view per sub-topic.
3. **Item**: clicking a bar, cell, station or day opens its detail in a drawer docked on the right.

On desktop (≥ 1100px wide) everything fits one screen and the page never scrolls; the view's charts size to the space they get.

The shell lives in `site/src/shared/`:

| File | What it is |
|---|---|
| `console.js` | `createConsole()`, the router, the rail, tiles, views, drawer and lazy loading. Also exports `href`, `go` and the drawer helpers `dStats`, `dChart`, `dNote`, `dLink`, `dHead`. |
| `console.css` | Layout and look of every `.cx-*` element. It uses only the tokens from `theme.css`, so light and dark come for free. |
| `charts.js` | d3 chart helpers that fill their container's width and height: `frame`, `renderBars`, `renderHeat`, `renderHourBars`, `renderCompare`, `gridY`, `colPath`, `barPath`. |

Toronto City Pulse (`site/src/toronto/`) is the reference implementation. `main.js` wires four modules: `ferry.js`, `bike.js`, `ttc.js` and `weather.js`.

## Page setup

```html
<link rel="stylesheet" href="../src/shared/theme.css" />
<link rel="stylesheet" href="../src/shared/console.css" />   <!-- before the page's own CSS -->
<link rel="stylesheet" href="../src/mypage/mypage.css" />
<link rel="stylesheet" href="../src/mypage/skin.css" />
…
<body class="mypage cx-body">          <!-- cx-body: the one-screen body layout from first paint -->
  <header class="topbar">…</header>    <!-- anything above the app (top bar, skin strips) keeps its height -->
  <div id="app" class="cx-app"></div>
  <script type="module" src="../src/mypage/main.js"></script>
</body>
```

Link `console.css` in the HTML rather than importing it from JS. A JS import puts it after your page CSS in dev, and then it overrides your rules.

```js
import { initTheme, initSkin } from "../shared/ui.js";
import { createConsole } from "../shared/console.js";
import { rivers } from "./rivers.js";
import { lakes } from "./lakes.js";

initTheme(document.getElementById("theme"));
initSkin(document.getElementById("skin"));

const cx = createConsole({
  host: document.getElementById("app"),
  title: "Water Watch",                        // document title; overview h1 fallback
  kicker: (ctx) => "Updated today",            // overview eyebrow (string or function of ctx; re-evaluated on every render)
  heading: "The watershed at a glance",        // overview h1
  note: "Pick a tile, or a topic in the menu, to go a level deeper.",
  modules: [rivers, lakes],
  about: { eyebrow: "About & Methodology", heading: "How this is made", html: `<div class="card prose">…</div>` }, // optional last page
  foot: `<p>Built on open data.</p><p class="note" id="generated-rail"></p>`,                              // rail footer
  ctx: { region: "bc" },                       // shared state handed to every module
  onRoute: (route, ctx) => {},                 // runs on every route change, before the view renders
});
```

Other options: `topbar` (selector of the bar above the app, default `.topbar`; its height becomes `--cx-top` for the sticky mobile tabs), `fullscreen` (default true: adds `cx-body` to `<body>`), `prefetch` (default true: idle-load every module after the first render) and `tileCols` (overview columns; by default 1–2 topics give 1–2 columns, 3 give 3, 4 give 2×2, 5+ give 3 per row).

`createConsole` returns `{ ctx, refresh(), go(), href(), route, modules }`.

## The module contract

A module is one topic. Keep it in its own file, with no references to page markup outside its own `html`, so a multi-city "Civic" shell can later put it on another page.

```js
export const rivers = {
  id: "rivers",                         // hash segment and data-topic; unique on the page; "overview" is reserved
  title: "Rivers",                      // rail label and document title
  tileTitle: "River levels",            // optional: overview tile name, if it differs from title
  color: "var(--river)",                // topic colour; becomes --tc inside the module
  eyebrow: "BC rivers",                 // topic view: small kicker above the h1
  heading: "Which rivers are running high?",

  load: (ctx) => loadJSON(`../data/${ctx.region}/rivers.json`).then((d) => { data = d; }),  // once, on first use

  badge: (ctx) => [fmt(data.high), "gauges above normal"],                 // rail badge: string or [text, tooltip]
  kpis: (ctx) => [["Gauges", "212", "reporting now"], ["Above normal", "14", "", { title: "…" }]],  // [label, value, sub?, attrs?]

  tile: (t, ctx) => {                   // overview tile
    t.kpis([["14", "gauges above normal"], ["Fraser", "highest vs normal"], ["+38%", "vs a typical June"]]);  // [value, label, extraNode?]
    t.status("Live 9:40 am");           // optional status chip in the tile head (empty hides it)
    renderBars(t.vis, rows, "--river", fmt);   // t.vis is a .chart that fills the rest of the tile
  },

  subs: [                               // level 2: one main view each
    { id: "now", title: "Right now", short: "Now",       // short = label of the tile's sub-link
      rows: "auto minmax(0, 1fr)",                        // desktop grid-template-rows of the pane (or `cols`, or `class`)
      html: `<div class="cx-row cols-2">
               <div class="card cx-fill"><h3 class="cx-card-title">Highest gauges</h3><p class="note cx-card-sub">…</p><div class="chart" id="rv-high"></div></div>
               …</div>`,
      view: (host, ctx, route) => {      // runs each time the pane is shown, resized, or re-rendered
        renderBars("rv-high", rows, "--river", fmt, 200, {
          selected: route.item, pick: (key) => ctx.go("rivers", "now", key) });  // click opens the drawer
      } },
    { id: "history", title: "History", html: `…`, view: (host, ctx) => {} },
  ],

  drawers: {                            // level 3, keyed by the sub-topic it opens from
    now: (host, ctx, item) => {
      const g = data.gauges.find((x) => x.id === item);
      if (!g) return null;              // unknown item: the drawer stays closed
      return {
        kicker: "Rivers · gauge", title: g.name,
        body: [dStats([[g.level, "metres"], [g.pct, "of normal"]]), dChart("dr-a", "Last 30 days"), dLink(ctx.href("rivers", "history"), "History")],
        after: () => renderHourBars("dr-a", …),   // charts inside the drawer: draw them here, once it is laid out
      };
    },
  },
};
```

Notes:

- **Markup.** Each sub's `html` (a string, a Node or `(ctx) => either`) is built once at start, so every element id exists from the beginning. Prefix ids with the module id, because they share the page with other modules.
- **Rendering.** Only the visible pane renders. `view()` must be safe to call repeatedly: it runs again on resize, on theme or skin change, and on `cx.refresh()`. Charts read colours from CSS variables on each render, which is what makes theme switching work.
- **Loading.** `load(ctx)` runs on first use: the module's topic, its tile (the overview needs every tile), or the idle prefetch. Until it resolves, the pane shows "Loading…", and an error message if it fails. Several modules can share one promise (Toronto's four topics share `loadData()`). For live feeds that arrive later, store the data and call `ctx.refresh()`.
- **Single-pane topics.** Leave out `subs` and give the module `html`/`view` directly. It routes as `#id` and has no sub-tabs. `page: true` drops the tile and badge (this is how `about` works), and `separate: true` draws a divider above it in the rail. `noTile: true` keeps a normal topic (with sub-tabs and badge) in the rail but leaves it off the Overview, and `section: "…"` puts a small heading above it in the rail (desktop) to start a group; Public Transit uses both for its Route 95 spotlight.
- **ctx.** Your object, which the console extends with `route` (current `{ topic, sub, item }`), `theme` (`"light"`/`"dark"`), `skin` (`data-skin` or `""`), `desktop` (bool), `go`, `href` and `refresh`. Put shared things like `region` on it, so the same module can render a different region inside a different shell.

## Routing

The hash is `#topic/sub/item`. `item` is URI-encoded and may contain `/`. Missing or unknown parts fall back: no topic or an unknown topic goes to the overview, an unknown sub goes to the first sub. Every state is linkable and the back button walks back up. Use `href(topic, sub, item)` for links and `go(topic, sub, item)` (or `ctx.go`) to navigate. Both are also exported from `console.js`. The document title follows: `Sub · Topic · Title`.

Item keys are up to the module. The conventions so far: the plain name for a station or cause, `dow-hour` for a heatmap cell (from `renderHeat` with `pick: (d, h) => ctx.go(t, s, `${d}-${h}`)`), `YYYY-MM-DD` for a day, and `route-3` for the 4th route.

## The drawer (level 3)

Navigating to an item calls `drawers[sub](host, ctx, item)`. You can return `{ kicker, title, body: [nodes], after }`, or render into `host` yourself and return `{ kicker, title }`. Return `null` to keep the drawer closed. The drawer is filled before the view renders, so on desktop the view reflows beside it (`--cx-drawer-w`, default `min(380px, 38%)`) and its charts measure the narrower space. `after()` runs once the drawer is in place: draw drawer charts there. The ✕ button and Esc go back to `#topic/sub`. Building blocks styled by `console.css`: `dStats(items, four?)`, `dChart(id, title)`, `dNote(text)`, `dLink(href, text)` and `dHead(text)`, plus `.cx-fillbar > i` for a fill bar.

## Layout helpers (console.css)

- `.cx-pane` is a grid. Set its desktop rows and columns with the sub's `rows` / `cols`, or give it a `class` and write the grid template in your CSS inside `@media (min-width: 1100px)`.
- `.cx-row.cols-2`, `.cols-3` and `.cols-13-1` (1.35 : 1) are rows of cards. They collapse to one column on mobile.
- `.card.cx-fill` is a card whose `.chart` (or `.cx-grow` element) takes the leftover height. Use `.cx-card-title`, `.cx-card-sub` and `.cx-lede` for text.
- `.chart` boxes size their svg to the box (`frame()` in `charts.js`). On mobile `.cx-app .chart` is 240px tall, `.chart.bars` grows with its rows, tiles are 170px and drawer charts 190px. Override with `.cx-app .my-chart { height: … }` in your page CSS.
- Short desktop windows (≤ 860px tall) get tighter padding automatically.

## Mobile (< 1100px)

The page scrolls. The rail turns into sticky, horizontally scrolling topic tabs under the top bar (`top: var(--cx-top)`); the badges, carets and footer are hidden. Each topic shows its sub-topics as tabs (`.cx-subtabs`), and the active tab is scrolled into view. Rows collapse to one column, charts get fixed heights, and the drawer becomes a bottom sheet (max 78vh). The console redraws on width changes only, so scrolling with a collapsing browser toolbar doesn't redraw.

Sub-topic tabs are a real tablist (`role="tablist"` / `"tab"`, `aria-selected`, roving tabindex): ←/→ move focus, Home/End
jump, Enter or Space opens the tab (manual activation, so arrowing past a heavy tab loads nothing). `tablistKeys(list)` and
`rovingTabs(list)` are exported for other tab rows.

## Inlaid in a shell (?embed=1)

Inside a same-origin parent (Open Places), the console posts its rail to the parent on every route change:
`{ type: "cx-nav", title, hash, route, items: [{ id, title, href, section, page }] }` (and again when the parent sends
`{ type: "cx-hello" }`). If the parent's `<html>` has `data-cx-flatten`, the page is "flattened" (`html.cx-flat`): the rail
is hidden, sub-topic tabs show on every width, and the rail's footer (sources, licences) becomes one slim "Sources &
credits" line under the view that opens on hover or focus. The parent navigates the page by changing the frame's hash.

## Restyling it from a skin

Skins (`:root[data-skin="…"]`, see `initSkin` in `ui.js`) restyle the console from their own skin CSS. The console needs no changes. Every console selector has low specificity (one or two classes), so any `:root[data-skin="alt"] body.mypage .cx-…` rule wins. The hooks:

- **Tokens.** Redefine theme tokens (`--page`, `--surface`, `--ink`, `--border`, `--radius`, `--font`…) and your topic colour variables (`--ferry`…) under the skin selector, for light and dark.
- **Topic colour.** Each module's `color` is applied as `:where([data-topic="id"]) { --tc: … }` (zero specificity). Use `[data-topic="id"]` in skin CSS to set your own per-topic variables, as Toronto's skin does with `--trim`.
- **Structure.** `.cx-nav` (rail), `.cx-group` / `.cx-topic` / `.cx-dot` / `.cx-label` / `.cx-badge` / `.cx-caret` / `.cx-subs` (rail entries; `.active`, `.open`, `[data-topic="overview"]`, `.cx-page`), `.cx-foot`, `.cx-view[data-view]`, `.cx-head`, `.cx-title .eyebrow`, `.cx-title h1`, `.cx-kpis` / `.cx-kpi` / `.cx-kpi-l` / `-v` / `-s`, `.cx-subtabs`, `.cx-tiles`, `.cx-tile` / `-head` / `-dot` / `-name` / `-live` / `-go` / `-kpis` / `-vis` / `-links`, `.cx-tk`, `.cx-drawer` / `-head` / `-x` / `-body`, `.cx-dstats`, `.cx-dsec`, `.cx-dlink`, `.cx-card-title`. The chart internals are `.chart .brow`, `.hcell`, `.axis-t` and `.halo`.
- **Sizes.** `--cx-rail-w` (240px) and `--cx-drawer-w`.
- **Extras.** A skin's JS can add elements (Toronto's Departure Board adds a live strip under the top bar and turns the ferry week into a split-flap board). Anything placed directly in `<body>` keeps its height on desktop (`body.cx-body > *`). Build extras after `createConsole()` returns, because the console's markup exists from then on.

See `site/src/toronto/skin.css` for a complete skin over the console.

## Checklist for a new dashboard

1. Create `site/<page>/index.html` as above and add it to `pages` in `site/vite.config.js`.
2. Write one module per topic, keeping the topics of equal weight: each gets a tile with three numbers and one chart.
3. On desktop, check that every sub-topic fits 1440×900 and 1280×800 without page scroll (the view may scroll internally only as a last resort). Check mobile at 390px. Check light, dark and every skin.
4. Make sure deep links (`#topic/sub/item`) open directly, Back works, and there are no console errors.
