// The Open Places logo ("N1 · Faint Glow"): the world map over a quiet wall of data bricks, dark on the left and lighter
// toward a dawn rim on the right, where a few bricks come online in amber. The map turns so the place you're looking at
// sits in the middle (longitude only: the tilt stays fixed, so the logo keeps its shape).
//   globe.place(p)          a place from civic-data (turns to its longitude)
//   globe.follow(lngLat)    the world map's centre while the map is open (no easing; the map already animates)
// The bricks and the light are fixed in screen space; only the land, its brick clip and the grid lines move.
// Land: Natural Earth 1:110m via world-atlas (public domain), loaded lazily so the header paints first.
// Colours are the --logo-* tokens in civic.css (dark and light); the favicon is the same mark in the dark colours.
import * as d3 from "d3";

const SIZE = 64, C = 32, R = 26, TILT = -25;   // drawn in a 64-unit box, shown at 30 px
const reduce = matchMedia("(prefers-reduced-motion: reduce)");
const NS = "http://www.w3.org/2000/svg";
const rnd = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mk = (tag, attrs = {}) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };

/** one brick grid over the globe: brightness rises left → right with a little dull/bright jitter, and amber bricks
 *  "come online" more often toward the rim. Deterministic, so the mark never changes between loads. */
function bricks({ cls, base, jit, amberMax, amberOp, seed }) {
  const h = 3.2, w = 4.8, gap = 0.75; let out = "";
  for (let row = 0, y = C - R; y < C + R; row++, y += h) {
    const off = row % 2 ? w / 2 : 0;
    for (let x = C - R - off; x < C + R; x += w) {
      const cx = x + w / 2, cy = y + h / 2; if (Math.hypot(cx - C, cy - C) > R + 3) continue;
      const t = (cx - (C - R)) / (2 * R), k = Math.round(x * 10);
      const ax = `x="${(x + gap / 2).toFixed(2)}" y="${(y + gap / 2).toFixed(2)}" width="${(w - gap).toFixed(2)}" height="${(h - gap).toFixed(2)}" rx=".5"`;
      const op = base[0] + (base[1] - base[0]) * smooth(0, 0.85, t) + jit * (rnd(row + 50, k) - 0.5) * 2;
      out += `<rect class="${cls}" ${ax} style="opacity:${Math.max(0.02, op).toFixed(2)}"/>`;
      if (rnd(row + seed, k) < amberMax * smooth(0.4, 1, t)) out += `<rect class="lg-a" ${ax} style="opacity:${(amberOp[0] + (amberOp[1] - amberOp[0]) * t).toFixed(2)}"/>`;
    }
  }
  return out;
}

/** the mark's static SVG markup; `id` keeps the gradient and clip ids unique per copy */
function markup(id) {
  const g = (o) => `<stop offset="${o[0]}" style="stop-color:${o[1]};stop-opacity:${o[2]}"/>`;
  // the ring: plain ink round the night side, easing into amber over ~25° either side of where the dawn rim begins
  const ring = [[0, "var(--logo-ring)", 1], [0.58, "var(--logo-ring)", 1], [0.76, "var(--logo-lit)", 1], [1, "var(--logo-lit)", 1]];
  const glow = [[0, "var(--logo-lit)", 0], [0.6, "var(--logo-lit)", 0], [0.8, "var(--logo-lit)", 0.9], [1, "var(--logo-lit)", 1]];
  return `<defs>
      <clipPath id="${id}c"><circle cx="${C}" cy="${C}" r="${R - 1}"/></clipPath>
      <clipPath id="${id}l"><path class="lg-landclip"/></clipPath>
      <linearGradient id="${id}s" gradientUnits="userSpaceOnUse" x1="${C - R}" y1="0" x2="${C + R}" y2="0">${g([0, "var(--logo-tile)", 0.12])}${g([1, "var(--logo-tile)", 0.42])}</linearGradient>
      <linearGradient id="${id}f" gradientUnits="userSpaceOnUse" x1="${C - R}" y1="0" x2="${C + R}" y2="0">${g([0, "var(--logo-land)", 0.35])}${g([1, "var(--logo-land)", 0.6])}</linearGradient>
      <linearGradient id="${id}r" gradientUnits="userSpaceOnUse" x1="${C - R}" y1="0" x2="${C + R}" y2="0">${ring.map(g).join("")}</linearGradient>
      <linearGradient id="${id}g" gradientUnits="userSpaceOnUse" x1="${C - R}" y1="0" x2="${C + R}" y2="0">${glow.map(g).join("")}</linearGradient>
      <filter id="${id}b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.6"/></filter></defs>
    <g clip-path="url(#${id}c)">
      <circle cx="${C}" cy="${C}" r="${R}" fill="url(#${id}s)"/>
      ${bricks({ cls: "lg-t", base: [0.08, 0.3], jit: 0.06, amberMax: 0.3, amberOp: [0.12, 0.35], seed: 0 })}
      <path class="lg-grat"/>
      <path class="lg-land" fill="url(#${id}f)"/>
      <g clip-path="url(#${id}l)">${bricks({ cls: "lg-l", base: [0.12, 0.5], jit: 0.12, amberMax: 0.35, amberOp: [0.15, 0.45], seed: 7 })}</g>
      <path class="lg-night" d="M${C - R - 2} ${C - R - 2}H${C - 4}Q${C - 20} ${C} ${C - 4} ${C + R + 2}H${C - R - 2}Z"/>
    </g>
    <circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="url(#${id}g)" stroke-width="3.6" filter="url(#${id}b)"/>
    <circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="url(#${id}r)" stroke-width="2.9"/>`;
}

// the favicon: the same mark with the dark-theme colours written in (a favicon can't read the page's CSS variables)
const FAV = { "--logo-ring": "#e6ebf3", "--logo-lit": "#f6b440", "--logo-tile": "#4f8fd0", "--logo-land": "#b9d3ee", "--logo-night": "#050a14" };
const FAV_CSS = `.lg-t{fill:#4f8fd0}.lg-l{fill:#b9d3ee}.lg-a{fill:#f6b440}.lg-grat{fill:none;stroke:#e6ebf3;stroke-width:.5;opacity:.22}.lg-night{fill:#050a14;opacity:.45}`;
let favT = 0;
function setFavicon(svg) {
  clearTimeout(favT);
  favT = setTimeout(() => {
    let s = svg.innerHTML;
    for (const [k, v] of Object.entries(FAV)) s = s.replaceAll(`var(${k})`, v);
    s = s.replace(/(\.\d)\d+/g, "$1");   // a tenth of a unit is plenty at 16-32 px, and keeps the data URL small
    // an opaque night-blue disc behind it, so the tab colour doesn't show through the see-through sea
    const doc = `<svg xmlns="${NS}" viewBox="0 0 ${SIZE} ${SIZE}"><style>${FAV_CSS}</style><circle cx="${C}" cy="${C}" r="${R}" fill="#0b1424"/>${s}</svg>`;
    // rasterised to a small PNG: the SVG (hundreds of bricks) would be a ~100 KB data URL
    const url = URL.createObjectURL(new Blob([doc], { type: "image/svg+xml" })), img = new Image();
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
  const svg = mk("svg", { viewBox: `0 0 ${SIZE} ${SIZE}`, width: 30, height: 30, class: "civ-globe", "aria-hidden": "true", style: "flex:none;overflow:visible" });
  svg.innerHTML = markup(id);
  host.replaceWith(svg);

  const proj = d3.geoOrthographic().translate([C, C]).scale(R).clipAngle(90).precision(0.4);
  const path = d3.geoPath(proj), grat = d3.geoGraticule().step([30, 30])();
  path.digits?.(2);
  const $ = (s) => svg.querySelector(s);
  let land = null, lon = 100, anim = 0, spin = 0, spinning = false, settle = 0;

  function draw() {
    proj.rotate([lon, TILT, 0]);
    $(".lg-grat").setAttribute("d", path(grat) || "");
    const d = land ? path(land) || "" : "";
    $(".lg-land").setAttribute("d", d); $(".lg-landclip").setAttribute("d", d);
  }
  const wrap = (a) => ((a + 540) % 360) - 180;
  function turnTo(to, ms = 900) {
    cancelAnimationFrame(anim); clearTimeout(settle); stopSpin();
    const end = () => { cancelAnimationFrame(anim); lon = to; draw(); setFavicon(svg); };
    if (reduce.matches || ms === 0 || document.hidden) return end();
    const from = lon, dλ = wrap(to - from), t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      lon = from + dλ * d3.easeCubicInOut(t); draw();
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
      turnTo(wrap(-(p?.ll?.[0] ?? -100)), 700);
      setTimeout(() => { if (want?.[0] === "place" && (!want[1] || want[1].level === "world")) startSpin(); }, 720);
      return;
    }
    turnTo(wrap(-p.ll[0]));
  }
  function follow(ll) {
    want = ["follow", ll];
    stopSpin(); cancelAnimationFrame(anim);
    lon = wrap(-(ll.lng ?? ll[0])); draw();
  }

  draw();
  import("topojson-client").then((topo) => import("world-atlas/land-110m.json").then((l) => {
    const lt = l.default || l;
    land = topo.feature(lt, lt.objects.land);
    if (want?.[0] === "follow") follow(want[1]); else { draw(); setFavicon(svg); }
  })).catch((e) => console.warn("[globe] land not loaded:", e));
  return { place, follow };
}
