// "Planetarium" design skin extras for Dark Sky Finder (the page's themed skin, data-skin="alt").
// Night = an indigo dome with chalk constellation lines, day = museum-gallery placards. Builds a "now showing"
// programme board, the dome and its chalked Orion in the hero, and a footer line, only while the skin is on;
// tints the MapLibre basemap and puts the classic paint back exactly when it is switched off.
// It reads data main.js has already loaded (passed in through initPlanetarium) and never fetches anything new.

const root = document.documentElement;
const skinOn = () => root.dataset.skin === "alt";
const isNight = () => (root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
const TZ = { bc: "America/Vancouver", az: "America/Phoenix" };
const DATA_LAYERS = /^(sqm-|change-|aurora$|sites$)/;
const PROPS = { background: ["background-color"], fill: ["fill-color", "fill-outline-color"], line: ["line-color"], symbol: ["icon-opacity", "text-color", "text-halo-color"] };

// Basemap: the dome at night; by day a muted indigo exhibit case with brass roads. Data layers keep classic colours,
// whose violet-to-navy sky ramp already suits the dome.
const PALETTE = {
  day: { bg: "#2a2a52", land: "#2e2d58", water: "#22214a", waterLine: "#3a3970", building: "#34336a", minor: "#403f78", major: "#5e5c9a",
    motorway: "#d9b56e", casing: "#33326a", rail: "#4a4985", boundary: "#e6dcc0", text: "#ece6d6", waterText: "#a9a6d6", halo: "#2a2a52", icon: 0, siteStroke: "#1f1b3a" },
  night: { bg: "#141039", land: "#17133f", water: "#0e0b2c", waterLine: "#241e5a", building: "#1d1850", minor: "#2a2463", major: "#463e8a",
    motorway: "#8a7fd6", casing: "#1f1a52", rail: "#332c70", boundary: "#b6a8ff", text: "#cfc8f5", waterText: "#8a82c4", halo: "#141039", icon: 0, siteStroke: "#0f0c2e" },
};

let api, strip, overlay, flavour, heroObs;
let classic = null;        // classic basemap paint, snapshotted at map load
let painted = false;

export function initPlanetarium(hooks) {
  api = hooks;
  addEventListener("darksky:mapload", () => { snapshot(); paint(); });
  // initSkin fires "themechange" right after "skinchange", so this one listener covers both
  addEventListener("themechange", () => { build(); paint(); api.updateSites?.(); refresh(); });
  addEventListener("darksky:data", refresh);
  build();
}

// ------------------------------------------------------------------ DOM extras
function build() {
  if (!skinOn()) {
    strip?.remove(); overlay?.remove(); flavour?.remove(); heroObs?.disconnect();
    strip = overlay = flavour = heroObs = null;
    return;
  }
  if (!heroObs && api.redrawStars) {
    // keep the canvas star field crisp when the hero changes height (cards load)
    let raf;
    heroObs = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(api.redrawStars); });
    heroObs.observe(document.querySelector(".hero"));
  }
  strip ??= make("div", "pl-strip", `<div class="pl-strip-in">
      <span class="pl-now"><i class="pl-dot"></i>Now showing</span>
      <span class="pl-item"><span class="k">Moon</span><b data-k="moonPct">…</b><i data-k="moonName"></i></span>
      <span class="pl-item"><span class="k">Kp</span><b data-k="kp">…</b></span>
      <span class="pl-item"><span class="k">Cloud</span><b data-k="cloud">…</b><i data-k="whereAt"></i></span>
      <span class="pl-item"><span class="k">Darkness</span><b data-k="dark">…</b></span>
      <span class="pl-item"><span class="k">ISS</span><b data-k="iss">…</b></span>
      <span class="pl-asof">Data as of <b data-k="asof">--:--</b></span>
    </div>`, ".topbar", "after");
  if (!overlay) {
    overlay = dome();
    document.querySelector(".hero")?.insertBefore(overlay, document.querySelector(".hero-inner"));
  }
  flavour ??= make("div", "pl-flavour",
    `<span class="pl-day">Please do not tap on the glass · Exhibits on loan from NOAA, NASA &amp; Globe at Night</span>` +
    `<span class="pl-night">House lights down · The show is in progress · Please silence your phone</span>`, "footer.site .wrap");
  refresh();
}

function refresh() {
  if (!strip || !api) return;
  const v = liveValues(api.state);
  for (const n of strip.querySelectorAll("[data-k]")) { const x = v[n.dataset.k]; if (x !== undefined) n.textContent = x; }
}

function make(tag, cls, html, where, how = "append") {
  const n = document.createElement(tag);
  n.className = cls;
  n.setAttribute("aria-hidden", "true");
  n.innerHTML = html;
  document.querySelector(where)?.[how](n);
  return n;
}

// ------------------------------------------------------------------ live values (strings, ready to print)
const hm = (d, tz) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });
function liveValues(s) {
  const tz = TZ[s.view] || TZ.bc, now = Date.now(), out = {};
  out.moonPct = s.moon ? `${Math.round(s.moon.frac * 100)}%` : "…";
  out.moonName = s.moon ? s.moon.name.toLowerCase() : "";
  if (s.kp?.length) { const past = s.kp.filter((d) => +d.t <= now); out.kp = (past.at(-1) || s.kp[0]).kp.toFixed(1); }
  else out.kp = s.kp ? "n/a" : "…";
  let cloud = null, where = "";
  const nearest = (hours) => hours?.reduce((a, b) => (Math.abs(+b.t - now) < Math.abs(+a.t - now) ? b : a));
  if (s.spot && s.spotNights?.length) { cloud = nearest(s.spotNights[0].hours)?.cc; where = s.spot.name || "your spot"; }
  else if (!s.spot) {
    const top = (s.siteScores?.[s.view] || []).filter((x) => x.kind !== "City" && x.nights[0]).sort((a, b) => b.nights[0].score - a.nights[0].score)[0];
    if (top) { cloud = nearest(top.nights[0].hours)?.cc; where = top.name; }
  }
  out.cloud = cloud != null ? `${Math.round(cloud)}%` : "…";
  out.whereAt = where ? `at ${where}` : "";
  if (!s.spot) out.iss = "pick a spot";
  else if (s.iss === false) out.iss = "unavailable";
  else if (!s.iss) out.iss = "computing…";
  else if (!s.iss.length) out.iss = "none visible";
  else {
    const p = s.iss[0];
    out.iss = `${p.max.toLocaleDateString("en-CA", { weekday: "short", timeZone: tz })} ${hm(p.max, tz)} · ${Math.round(p.maxEl)}°`;
  }
  const asof = [s.asOf, s.swAsOf].filter(Boolean).sort((a, b) => b - a)[0];
  out.asof = asof ? asof.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "--:--";
  // astronomical darkness tonight (main.js hands over state.dark = { dusk, dawn })
  out.dark = s.dark ? `${hm(s.dark.dusk, tz)}–${hm(s.dark.dawn, tz)}` : s.moon ? "no full dark" : "…";
  return out;
}

// ------------------------------------------------------------------ basemap tint
function mapReady() {
  const map = api?.getMap();
  return map && map.getLayer("sites") ? map : null;
}
function snapshot() {
  const map = mapReady();
  if (!map || classic) return;
  classic = {};
  for (const layer of map.getStyle().layers) {
    if (DATA_LAYERS.test(layer.id) || !PROPS[layer.type]) continue;
    classic[layer.id] = {};
    for (const p of PROPS[layer.type]) {
      if (layer.type === "symbol" && p.startsWith("text") && layer.layout?.["text-field"] === undefined) continue;
      classic[layer.id][p] = map.getPaintProperty(layer.id, p);
    }
  }
  classic.sites = { "circle-stroke-color": map.getPaintProperty("sites", "circle-stroke-color") };
}
function restore(map) {
  painted = false;
  for (const [id, props] of Object.entries(classic)) {
    if (!map.getLayer(id)) continue;
    for (const [p, v] of Object.entries(props)) map.setPaintProperty(id, p, v);
  }
}
function paint() {
  const map = mapReady();
  if (!map || !classic) return;
  if (!skinOn()) { if (painted) restore(map); return; }
  const pal = PALETTE[isNight() ? "night" : "day"];
  for (const layer of map.getStyle().layers) {
    if (DATA_LAYERS.test(layer.id) || !classic[layer.id]) continue;
    for (const [p, v] of Object.entries(basemapPaint(layer, pal))) map.setPaintProperty(layer.id, p, v);
  }
  map.setPaintProperty("sites", "circle-stroke-color", pal.siteStroke);
  painted = true;
}
function basemapPaint(layer, p) {
  const { id, type } = layer;
  if (type === "background") return { "background-color": p.bg };
  if (type === "fill") {
    if (/water/.test(id)) return { "fill-color": p.water };
    if (/building/.test(id)) return { "fill-color": p.building, "fill-outline-color": p.building };
    if (/aeroway|road_area/.test(id)) return { "fill-color": p.minor };
    return { "fill-color": p.land };
  }
  if (type === "line") {
    if (/water/.test(id)) return { "line-color": p.waterLine };
    if (/boundary/.test(id)) return { "line-color": p.boundary };
    if (/dashline|pier/.test(id)) return { "line-color": p.bg };
    if (/rail/.test(id)) return { "line-color": p.rail };
    if (/casing/.test(id)) return { "line-color": p.casing };
    if (/motorway/.test(id)) return { "line-color": p.motorway };
    if (/major|runway|trunk|primary/.test(id)) return { "line-color": p.major };
    return { "line-color": p.minor };
  }
  if (type === "symbol") {
    const out = { "icon-opacity": p.icon };
    if (layer.layout?.["text-field"] !== undefined) Object.assign(out, { "text-color": /water/.test(id) ? p.waterText : p.text, "text-halo-color": p.halo });
    return out;
  }
  return {};
}

// ------------------------------------------------------------------ hero: the dome
function dome() {
  // Altitude rings of the dome converging on a zenith above the hero, a chalked Orion with its belt pointing down to
  // Sirius and up to Aldebaran. The chalk texture is an SVG displacement filter (night only, via --chalk-filter).
  const NS = "http://www.w3.org/2000/svg";
  const W = 1200, H = 420, zx = 600, zy = 560;
  let g = "";
  for (let k = 1; k <= 6; k++) g += `<ellipse class="dome" cx="${zx}" cy="${zy}" rx="${k * 170}" ry="${k * 105}"/>`;
  for (let a = -70; a <= 70; a += 20) {
    const t = ((a - 90) * Math.PI) / 180;
    g += `<line class="dome" x1="${zx}" y1="${zy}" x2="${(zx + Math.cos(t) * 1100).toFixed(1)}" y2="${(zy + Math.sin(t) * 680).toFixed(1)}"/>`;
  }
  const S = { meissa: [70, 0, 3.4], betelgeuse: [18, 52, 0.5], bellatrix: [132, 62, 1.6], mintaka: [102, 150, 2.2], alnilam: [83, 161, 1.7],
    alnitak: [64, 172, 1.8], saiph: [36, 262, 2.1], rigel: [152, 250, 0.1], sirius: [-118, 292, -1.4], aldebaran: [262, 64, 0.9] };
  const lines = [["meissa", "betelgeuse"], ["meissa", "bellatrix"], ["betelgeuse", "alnitak"], ["bellatrix", "mintaka"], ["mintaka", "alnilam"],
    ["alnilam", "alnitak"], ["alnitak", "saiph"], ["mintaka", "rigel"]];
  const seg = ([a, b]) => `M${S[a][0]},${S[a][1]}L${S[b][0]},${S[b][1]}`;
  let c = `<path class="cl" d="${lines.map(seg).join("")}"/>`;
  c += `<path class="cl thin" d="M${S.alnitak[0] - 14},${S.alnitak[1] + 8}L${S.sirius[0] + 12},${S.sirius[1] - 7}M${S.mintaka[0] + 14},${S.mintaka[1] - 8}L${S.aldebaran[0] - 12},${S.aldebaran[1] + 8}"/>`;
  c += Object.entries(S).map(([, [x, y, m]], i) => {
    const r = Math.max(1.4, 4.2 - m * 0.8);
    return `<g class="cs${i % 2 ? " tw" : ""}" style="--d:${(i * 1.1) % 6}s" transform="translate(${x},${y})"><circle class="glow" r="${(r * 3).toFixed(1)}"/><circle r="${r.toFixed(1)}"/></g>`;
  }).join("");
  c += `<text class="cn big" x="168" y="198">Orion</text>`;
  c += `<text class="cn sm" x="-66" y="48">Betelgeuse</text><text class="cn sm" x="166" y="266">Rigel</text>`;
  c += `<text class="cn" x="-104" y="322">Sirius</text><text class="cn sm" x="${S.aldebaran[0] - 30}" y="${S.aldebaran[1] - 14}">Aldebaran</text>`;
  c += `<text class="cn sm" x="-40" y="214" transform="rotate(-30 -40 214)">follow the belt</text>`;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "pl-sky");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMin slice");
  svg.innerHTML = `<defs><filter id="pl-chalk" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="3" result="n"/>` +
    `<feDisplacementMap in="SourceGraphic" in2="n" scale="2.6"/></filter></defs><g>${g}</g><g transform="translate(890,58) scale(0.74)">${c}</g>`;
  return svg;
}
