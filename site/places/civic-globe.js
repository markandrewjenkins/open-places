// The Open Places logo: a small orthographic globe that turns to show where you're looking.
//   globe.place(p)          a place from civic-data (turns to it, highlights its country, drops a dot on it)
//   globe.follow(lngLat, z) the world map's centre while the map is open (no easing; the map already animates)
// World outline and country borders: Natural Earth 1:110m via world-atlas (public domain), loaded lazily so the header
// paints first.
// Colours come from the design's tokens, so every design and light/dark mode restyles it.
// Day and night: the night side is shaded live (the sun's real position, with civil / nautical / astronomical twilight
// bands), and the whole globe brightens or dims with the sun's height where you're looking. Updated every minute.
import * as d3 from "d3";
import { countryOf } from "./civic-data.js";

const SIZE = 64, R = 30, C = SIZE / 2;                         // drawn in a 64-unit box, shown at ~30 px
const reduce = matchMedia("(prefers-reduced-motion: reduce)");
const ZOOM = { world: 1, country: 1.05, province: 1.45, region: 1.8, muni: 1.95 };
const NS = "http://www.w3.org/2000/svg";
const RAD = Math.PI / 180;
/** the point on Earth with the sun straight overhead at time t (ms), [lon, lat] in degrees (accurate to ~0.1°) */
export function subsolar(t = Date.now()) {
  const n = t / 864e5 + 2440587.5 - 2451545.0;                       // days since J2000
  const L = 280.46 + 0.9856474 * n, g = (357.528 + 0.9856003 * n) * RAD;
  const lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD, eps = (23.439 - 4e-7 * n) * RAD;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) / RAD;
  const gmst = 280.46061837 + 360.98564736629 * n;
  return [((ra - gmst) % 360 + 540) % 360 - 180, dec / RAD];
}
/** the sun's height above the horizon at ll, in degrees */
export const sunAltitude = (ll, t = Date.now()) => 90 - d3.geoDistance(subsolar(t), ll) / RAD;
// night side: circles round the anti-solar point; 90° = sunset line, then civil (-6°), nautical (-12°), astronomical (-18°)
const NIGHT = [90, 84, 78, 72];
const mk = (tag, attrs = {}) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };

export function createGlobe(host) {
  const id = `glb${Math.random().toString(36).slice(2, 7)}`;
  const svg = mk("svg", { viewBox: `0 0 ${SIZE} ${SIZE}`, width: 30, height: 30, class: "civ-globe", "aria-hidden": "true", style: "flex:none;overflow:visible" });
  svg.innerHTML = `<defs>
      <clipPath id="${id}c"><circle cx="${C}" cy="${C}" r="${R}"/></clipPath>
      <radialGradient id="${id}s" cx="34%" cy="28%" r="80%">
        <stop offset="0" stop-color="#fff" stop-opacity=".42"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/>
        <stop offset="1" stop-color="#000" stop-opacity=".28"/></radialGradient></defs>
    <g class="g-body" style="transition:filter 1.2s ease">
    <circle cx="${C}" cy="${C}" r="${R}" style="fill:color-mix(in oklab, var(--m-water, #2479b8) 72%, var(--page))"/>
    <g clip-path="url(#${id}c)">
      <path class="g-grat" fill="none" style="stroke:currentColor;stroke-opacity:.16;stroke-width:.6"/>
      <path class="g-land" style="fill:color-mix(in oklab, #86bf6e 80%, var(--page));stroke:color-mix(in oklab, #2f6b3a 60%, transparent);stroke-width:.4"/>
      <path class="g-here" style="fill:color-mix(in oklab, #f2d36b 85%, var(--page));stroke:color-mix(in oklab, #6b5a12 70%, transparent);stroke-width:.5"/>
      <path class="g-borders" fill="none" style="stroke:color-mix(in oklab, #24502c 75%, transparent);stroke-width:.55;stroke-linejoin:round"/>
      ${NIGHT.map((r) => `<path class="g-night" data-r="${r}" style="fill:#030b22;fill-opacity:.15"/>`).join("")}
    </g>
    <circle cx="${C}" cy="${C}" r="${R}" fill="url(#${id}s)"/></g>
    <circle cx="${C}" cy="${C}" r="${R - 0.6}" fill="none" style="stroke:currentColor;stroke-width:1.6"/>
    <g class="g-dot"><circle r="6.5" class="g-halo" style="fill:var(--lit, var(--accent));opacity:.28"/>
      <circle r="3.6" class="lit" style="stroke:var(--page);stroke-width:1.4"/></g>`;
  host.replaceWith(svg);

  const proj = d3.geoOrthographic().translate([C, C]).scale(R).clipAngle(90).precision(0.4);
  const path = d3.geoPath(proj), grat = d3.geoGraticule10();
  const $ = (s) => svg.querySelector(s);
  let land = null, countries = null, borders = null;
  // state: rotation [λ, φ], zoom, dot [lon, lat] | null, highlighted country feature | null
  let cur = { rot: [100, -30], k: 1 }, dot = null, here = null, anim = 0, spin = 0, spinning = false;
  let sun = subsolar(), nights = [];
  const body = $(".g-body"), nightEls = [...svg.querySelectorAll(".g-night")];
  function tick() {   // once a minute: move the night side and re-light the globe for the sun's height where we look
    sun = subsolar();
    const anti = [sun[0] + 180, -sun[1]];
    nights = NIGHT.map((r) => d3.geoCircle().center(anti).radius(r).precision(3)());
    draw();
  }

  function draw() {
    proj.rotate([cur.rot[0], cur.rot[1], 0]).scale(R * cur.k);
    $(".g-grat").setAttribute("d", path(grat) || "");
    if (land) $(".g-land").setAttribute("d", path(land) || "");
    if (borders) $(".g-borders").setAttribute("d", path(borders) || "");
    $(".g-here").setAttribute("d", here ? path(here) || "" : "");
    nights.forEach((n, i) => nightEls[i].setAttribute("d", path(n) || ""));
    // brightness follows the sun where we're looking: full by day, dimming through twilight to a floor at night
    const look = dot || [-cur.rot[0], -cur.rot[1]], alt = 90 - d3.geoDistance(sun, look) / RAD;
    const f = Math.max(0, Math.min(1, (alt + 12) / 18));             // 0 below -12° (nautical dusk) … 1 above +6°
    body.style.filter = `brightness(${(0.68 + 0.36 * f).toFixed(3)}) saturate(${(0.7 + 0.35 * f).toFixed(3)})`;
    svg.dataset.daylight = alt > 0 ? "day" : alt > -12 ? "twilight" : "night";
    const g = $(".g-dot");
    // hide the dot when it's on the far side of the globe
    const vis = dot && d3.geoDistance(dot, [-cur.rot[0], -cur.rot[1]]) < Math.PI / 2 - 0.05;
    g.style.display = vis ? "" : "none";
    if (vis) { const [x, y] = proj(dot); g.setAttribute("transform", `translate(${x.toFixed(2)},${y.toFixed(2)})`); }
  }
  const wrap = (a) => ((a + 540) % 360) - 180;
  let settle = 0;
  function turnTo(rot, k, ms = 900) {
    cancelAnimationFrame(anim); clearTimeout(settle); stopSpin();
    const end = () => { cancelAnimationFrame(anim); cur = { rot, k }; draw(); };
    if (reduce.matches || ms === 0 || document.hidden) return end();
    const from = cur, dλ = wrap(rot[0] - from.rot[0]), t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms), e = d3.easeCubicInOut(t);
      cur = { rot: [from.rot[0] + dλ * e, from.rot[1] + (rot[1] - from.rot[1]) * e], k: from.k + (k - from.k) * e };
      draw();
      if (t < 1) anim = requestAnimationFrame(step); else clearTimeout(settle);
    };
    anim = requestAnimationFrame(step);
    settle = setTimeout(end, ms + 120);   // frames can be paused (background tab): always land on the place
  }
  // the whole world: a slow turn (none with reduced motion, and paused while the tab is hidden)
  function startSpin() {
    if (reduce.matches || spinning) return;
    spinning = true; let last = performance.now();
    const step = (now) => { if (!spinning) return; if (!document.hidden) { cur = { ...cur, rot: [wrap(cur.rot[0] + (now - last) * 0.006), cur.rot[1]] }; draw(); } last = now; spin = requestAnimationFrame(step); };
    spin = requestAnimationFrame(step);
  }
  function stopSpin() { spinning = false; cancelAnimationFrame(spin); }

  // the place's own country first (ISO 3166 numeric ids in world-atlas); else whichever outline holds the point, also
  // trying a few nearby points, since coastal towns can fall just outside the coarse 1:110m outlines
  const ISO = { ca: "124", us: "840", mx: "484", gb: "826", fr: "250", de: "276", jp: "392", au: "036", nz: "554" };
  const countryAt = (ll, p) => {
    if (!countries || !ll) return null;
    const iso = ISO[p && countryOf(p)?.id];
    if (iso) { const f = countries.features.find((x) => x.id === iso); if (f) return f; }
    for (const [dx, dy] of [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6], [1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]]) {
      const f = countries.features.find((x) => d3.geoContains(x, [ll[0] + dx, ll[1] + dy]));
      if (f) return f;
    }
    return null;
  };
  let want = null;   // last request, replayed once the outline has loaded
  function place(p) {
    want = ["place", p];
    if (!p || p.level === "world" || !p.ll) {
      dot = null; here = null;
      turnTo([wrap(-(p?.ll?.[0] ?? -100)), -22], 1, 700); setTimeout(() => { if (want?.[0] === "place" && (!want[1] || want[1].level === "world")) startSpin(); }, 720);
      return;
    }
    here = countryAt(p.ll, p);
    // a country is shown whole, centred on its middle; anything smaller is centred on the place itself
    const centre = p.level === "country" && here ? d3.geoCentroid(here) : p.ll;
    dot = p.level === "country" && here ? centre : p.ll;
    turnTo([-centre[0], -Math.max(-60, Math.min(60, centre[1]))], ZOOM[p.level] || 1.6);
  }
  function follow(ll, z) {
    want = ["follow", ll, z];
    stopSpin(); cancelAnimationFrame(anim);
    dot = [ll.lng ?? ll[0], ll.lat ?? ll[1]]; here = countryAt(dot);
    cur = { rot: [-dot[0], -Math.max(-60, Math.min(60, dot[1]))], k: Math.min(2, 1 + Math.max(0, z - 2) * 0.18) };
    draw();
  }

  tick();
  setInterval(tick, 60_000);
  Promise.all([import("world-atlas/land-110m.json"), import("world-atlas/countries-110m.json"), import("topojson-client")])
    .then(([l, c, topo]) => {
      const lt = l.default || l, ct = c.default || c;
      land = topo.feature(lt, lt.objects.land);
      countries = topo.feature(ct, ct.objects.countries);
      // land borders only (shared edges between two countries); coastlines come from the land outline
      borders = topo.mesh(ct, ct.objects.countries, (a, b) => a !== b);
      if (want?.[0] === "place") { const p = want[1]; cancelAnimationFrame(anim); place(p); if (!(p && p.level !== "world")) draw(); }
      else if (want) follow(want[1], want[2]);
      else draw();
    })
    .catch((e) => console.warn("[globe] outline not loaded:", e));
  return { place, follow };
}
