# Shared brief for the Nov 15 build (read first)

Project: **Open Places**, an open-data dashboard monorepo at `D:\Dev\OpenDataProject1` (not a git repo; the
folder rename to OpenPlaces is deferred). The site is Vite in `site/`; the Open Places console is
`site/places/index.html` (+ `civic.js`, `civic.css`, `civic-modules.js`, `civic-charts.js`, `civic-data.js`,
`civic-globe.js`). Standalone dashboards live in `site/<proj>/` + `site/src/<proj>/`, sharing
`site/src/shared/` (console.js/.css, ui.js, theme.css, charts.js, relay.js). Python pipelines are in
`pipelines/<proj>/` writing `site/public/data/<proj>/`. The Cloudflare Worker relay is `workers/bct-relay/`
(deployed by the owner at https://bct-relay.openplaces.workers.dev; `src/index.js` routes to `rt.js`,
`air.js`, `ais.js`, agency list in `agencies.js`).

Seven agents work **at the same time**. Each owns specific files (listed in its own brief). Rules:

- **Stay in your files.** `civic-modules.js` and `workers/bct-relay/src/index.js` are shared: put new code
  in a new file of your own (e.g. `site/places/civic-mod-cameras.js`, `workers/bct-relay/src/cams.js`) and
  make only small, targeted edits to the shared file (your module's own block, one import line, one entry in
  the `TOPICS` list near the end, one route line). **Re-read the shared file right before every edit**;
  others are editing it too. Never reformat or reorder code you don't own.
- **Overview alerts API** (built by the shell agent; emit them from your own code even before it exists):
  `window.dispatchEvent(new CustomEvent("op-alert", { detail: { id, topic, level, title, body, place, href } }))`
  - `id`: stable string so repeats are de-duplicated (e.g. `"drivebc:DBC-12345:closed"`).
  - `topic`: the module id (`"roads"`, `"airtraffic"`, …). `level`: `"info"` | `"notice"` | `"warn"`.
  - `title`: short factual label ("Hwy 1 closed at Goldstream"); `body`: one plain sentence; `href`: optional
    in-app hash like `"#getting-around/roads"`.
  - Emit only **changes** (new / cleared / crossed a threshold), never every poll.
- **Headings** are short factual labels in Title Case, 1–4 words ("Live Bus Map", "Traffic Cameras",
  "Trail Advisories"). No sentences, questions, "you", or puns. About panes are "About & Methodology".
  Spell names out rather than acronyms in headings ("El Niño / La Niña", not "ENSO Outlook").
- **Honest status tags** on every tile: `LIVE`, `DATA` (published JSON), `MOCK`, `PLANNED`, `ESTIMATE`.
  Never present mock data as live. If a feed doesn't exist or its terms forbid public display, say so and
  leave it PLANNED with the reason in `long`.
- **Data rules:** open data only; credit every source with its licence on the tile/pane; no accounts, sign-ups
  or API keys created by you (the owner registers keys; if a key is needed, build it so it works once the owner
  adds a Worker secret and report the steps). Never paste or store keys in code. Be polite to APIs (cache, no
  tight polling; Open-Meteo and DriveBC already rate-limited us once). User-Agent strings say `openplaces`, never
  a person's name or email.
- **Marks:** use no agency/brand logos or marks (BC Transit "Blink"/swoosh, BC Ferries, airline logos, RCMP crest).
  Credit by name, imply no endorsement.
- **Look:** the Open Places Default ("Harbour") tokens, light and dark. Use existing CSS variables
  (`--page`, `--ink`, `--muted`, `--m-<topic>` …) rather than new hard-coded colours.
- **Testing:** a Vite dev server is already running at http://localhost:5173 (do **not** start another, and do
  **not** use the shared in-app browser pane). For screenshots and console checks use headless Playwright as
  `tools/sweep.mjs` does (`playwright-core`, `channel: "msedge"`, run with `node` from the repo root) and save
  images in your scratchpad. Key test URL: `http://localhost:5173/places/?p=langford#overview`.
  Don't run `npm run build` (the lead runs one build at the end); `npx vite build` into a scratch `--outDir` is
  fine if you must check bundling. On this machine use `npx.cmd`, not `npx`.
- **Never** deploy the relay, push to GitHub, publish anything, or change system settings. If the relay changes,
  say so in your report; the owner redeploys with `npx.cmd wrangler deploy` in `workers/bct-relay`.
- Update docs you touch (`docs/review-checklist.md` items for your area, `docs/data-limits.md` for new sources).

**Your final report** (keep it short): what is now live (with a real number you saw), what stayed
mock/planned and why, new sources + licences, files changed, whether the relay needs a redeploy, and anything
the owner must do.
