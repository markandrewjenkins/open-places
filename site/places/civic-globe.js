// The Open Places logo ("L1 · Spotlight"): the globe at dusk, turned to the place you're looking at, with a pool of warm
// light on it. Open data lighting up the place. The land inside the pool is lit; a small dot marks the spot.
//   globe.place(p)          a place from civic-data (turns to it; the world view turns slowly, with the light mid-globe)
//   globe.follow(lngLat)    the world map's centre while the map is open (no easing; the map already animates)
// The globe turns in longitude and tilts part-way toward the place's latitude, so far-north places don't lie on their back.
// Land: Natural Earth 1:110m via world-atlas (public domain), loaded lazily so the header paints first.
// The globe keeps its night colours in both themes so the light always shows; only the outline (--logo-ring) follows the
// theme. Colours are the --logo-* tokens in civic.css. The favicon is the same mark, rasterised in the dark colours.
import * as d3 from "d3";

const SIZE = 64, C = 32, R = 25, TILT_K = 0.55, POOL = 19;
const reduce = matchMedia("(prefers-reduced-motion: reduce)");
const NS = "http://www.w3.org/2000/svg";
const f = (n) => +n.toFixed(2);

/** the mark's static SVG markup; `id` keeps the gradient, mask and clip ids unique per copy */
function markup(id) {
  const st = (o, c, a) => `<stop offset="${o}" style="stop-color:${c};stop-opacity:${a}"/>`;
  return `<defs>
      <radialGradient id="${id}s" cx=".42" cy=".38" r=".75">${st(0, "var(--logo-sea2)", 1)}${st(1, "var(--logo-sea)", 1)}</radialGradient>
      <clipPath id="${id}c"><circle cx="${C}" cy="${C}" r="${R}"/></clipPath>
      <radialGradient id="${id}m" class="lg-pool" gradientUnits="userSpaceOnUse" cx="${C}" cy="${C}" r="${POOL}">${st(0, "#fff", 1)}${st(0.55, "#fff", 0.85)}${st(1, "#fff", 0)}</radialGradient>
      <mask id="${id}k" maskUnits="userSpaceOnUse" x="0" y="0" width="${SIZE}" height="${SIZE}"><rect width="${SIZE}" height="${SIZE}" fill="url(#${id}m)"/></mask>
      <radialGradient id="${id}g" class="lg-pool" gradientUnits="userSpaceOnUse" cx="${C}" cy="${C}" r="18">${st(0, "var(--logo-lit)", 0.75)}${st(0.5, "var(--logo-lit)", 0.3)}${st(1, "var(--logo-lit)", 0)}</radialGradient></defs>
    <g clip-path="url(#${id}c)">
      <circle cx="${C}" cy="${C}" r="${R}" fill="url(#${id}s)"/>
      <path class="lg-land" style="fill:var(--logo-land)"/>
      <circle class="lg-glow" cx="${C}" cy="${C}" r="18" fill="url(#${id}g)"/>
      <path class="lg-land" style="fill:var(--logo-landlit)" mask="url(#${id}k)"/></g>
    <circle cx="${C}" cy="${C}" r="${R}" style="fill:none;stroke:var(--logo-ring);stroke-width:1.8;opacity:.85"/>
    <circle class="lg-dot" cx="${C}" cy="${C}" r="2.6" style="fill:var(--logo-lit);stroke:#fff;stroke-width:1"/>`;
}

// the favicon: the same mark with the dark-theme colours written in (a favicon can't read the page's CSS variables),
// rasterised to a small PNG (the land path would make a large SVG data URL)
const FAV = { "--logo-ring": "#e6ebf3", "--logo-lit": "#f6b440", "--logo-sea": "#081329", "--logo-sea2": "#12284d", "--logo-land": "#4a72a3", "--logo-landlit": "#f4dfae" };
let favT = 0;
function setFavicon(svg) {
  clearTimeout(favT);
  favT = setTimeout(() => {
    let s = svg.innerHTML;
    for (const [k, v] of Object.entries(FAV)) s = s.replaceAll(`var(${k})`, v);
    s = s.replace(/(\.\d)\d+/g, "$1");
    const url = URL.createObjectURL(new Blob([`<svg xmlns="${NS}" viewBox="0 0 ${SIZE} ${SIZE}">${s}</svg>`], { type: "image/svg+xml" })), img = new Image();
    img.onload = () => {
      try {
        const cv = Object.assign(document.createElement("canvas"), { width: 64, height: 64 });
        cv.getContext("2d").drawImage(img, 0, 0, 64, 64);
        let link = document.querySelector('link[rel="icon"]');
        if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.append(link); }
        link.type = "image/png"; link.href = cv.toDataURL("image/png");
      } catch (e) { console.warn("[globe] favicon:", e?.message || e); }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }, 400);
}

export function createGlobe(host) {
  const id = `lg${Math.random().toString(36).slice(2, 7)}`;
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: `0 0 ${SIZE} ${SIZE}`, width: 30, height: 30, class: "civ-globe", "aria-hidden": "true", style: "flex:none;overflow:visible" })) svg.setAttribute(k, v);
  svg.innerHTML = markup(id);
  host.replaceWith(svg);

  const proj = d3.geoOrthographic().translate([C, C]).scale(R).clipAngle(90).precision(0.4);
  const path = d3.geoPath(proj);
  path.digits?.(2);
  const lands = svg.querySelectorAll(".lg-land"), pools = svg.querySelectorAll(".lg-pool");
  const glow = svg.querySelector(".lg-glow"), dot = svg.querySelector(".lg-dot");
  let land = null, lon = 100, lat = 20, spot = null, anim = 0, spin = 0, spinning = false, settle = 0;

  function draw() {
    proj.rotate([-lon, -lat * TILT_K, 0]);
    const d = land ? path(land) || "" : "";
    lands.forEach((n) => n.setAttribute("d", d));
    // the light sits on the place; with no place (the world view) it sits a little up and left of centre
    const [x, y] = spot ? proj(spot) || [C, C] : [C - 4, C - 5];
    pools.forEach((n) => { n.setAttribute("cx", f(x)); n.setAttribute("cy", f(y)); });
    glow.setAttribute("cx", f(x)); glow.setAttribute("cy", f(y));
    dot.setAttribute("cx", f(x)); dot.setAttribute("cy", f(y));
    dot.style.display = spot ? "" : "none";
  }
  const wrap = (a) => ((a + 540) % 360) - 180;
  function turnTo(toLon, toLat, ms = 900) {
    cancelAnimationFrame(anim); clearTimeout(settle); stopSpin();
    const end = () => { cancelAnimationFrame(anim); lon = toLon; lat = toLat; draw(); setFavicon(svg); };
    if (reduce.matches || ms === 0 || document.hidden) return end();
    const l0 = lon, p0 = lat, dl = wrap(toLon - l0), dp = toLat - p0, t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms), e = d3.easeCubicInOut(t);
      lon = l0 + dl * e; lat = p0 + dp * e; draw();
      if (t < 1) anim = requestAnimationFrame(step); else end();
    };
    anim = requestAnimationFrame(step);
    settle = setTimeout(end, ms + 120);   // frames can be paused (background tab): always land on the place
  }
  // the whole world: a slow turn (none with reduced motion, and paused while the tab is hidden)
  function startSpin() {
    if (reduce.matches || spinning) return;
    spinning = true; let last = performance.now();
    const step = (now) => { if (!spinning) return; if (!document.hidden) { lon = wrap(lon + (now - last) * 0.006); draw(); } last = now; spin = requestAnimationFrame(step); };
    spin = requestAnimationFrame(step);
  }
  function stopSpin() { spinning = false; cancelAnimationFrame(spin); }

  let want = null;   // last request, replayed once the land has loaded
  function place(p) {
    want = ["place", p];
    if (!p || p.level === "world" || !p.ll) {
      spot = null;
      turnTo(wrap(p?.ll?.[0] ?? -100), 20, 700);
      setTimeout(() => { if (want?.[0] === "place" && (!want[1] || want[1].level === "world" || !want[1].ll)) startSpin(); }, 720);
      return;
    }
    spot = [p.ll[0], p.ll[1]];
    turnTo(p.ll[0], p.ll[1]);
  }
  function follow(ll) {
    want = ["follow", ll];
    stopSpin(); cancelAnimationFrame(anim); clearTimeout(settle);
    lon = ll.lng ?? ll[0]; lat = ll.lat ?? ll[1]; spot = [lon, lat]; draw();
  }

  draw();
  import("topojson-client").then((topo) => import("world-atlas/land-110m.json").then((l) => {
    const lt = l.default || l;
    land = topo.feature(lt, lt.objects.land);
    if (want?.[0] === "follow") follow(want[1]); else { draw(); setFavicon(svg); }
  })).catch((e) => console.warn("[globe] land not loaded:", e));
  return { place, follow };
}
