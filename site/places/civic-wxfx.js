// Open Places: the weather pages' live touches (Forecast and the Weather summary).
//  * fxLayer(map, ctx): a faint weather effect over the map showing what it's doing at the place right now: rain streaks,
//    snow, drifting fog, wind-blown streaks in strong wind, a faint sun glow when it's clear by day, nothing otherwise.
//    One canvas inside the map's canvas container (under markers, popups and every floating panel), pointer-events none,
//    drawn at about 30 fps and stopped while the tab is hidden. prefers-reduced-motion: one still frame, no animation.
//    How much falls follows the precipitation rate of the hour in progress. For checking the look whatever the weather:
//    ?wxfx=rain:4 (or snow:1, fog, wind:70, clear) in the page URL stands in for the forecast (rate in mm/h, gusts in km/h).
//  * rainPanel(ctx): the Forecast page's rain line from the hourly forecast ("Rain continuing for about 3 hours",
//    "Rain expected in 2 hours, for about 4 hours", "Dry for the next 12 hours"; snow the same way when it's snow).
//    An hour counts as wet at a 50% chance or more and 0.2 mm or more. It stays on the page, not in the alert bar.
// Data: the page's own Open-Meteo forecast (civic-data.js weather(), CC BY 4.0): the same cached call as the Forecast
// tile and chart, so no extra requests. Fields used: current weather_code, precipitation, wind_speed_10m, is_day;
// hourly precipitation, snowfall, precipitation_probability, wind_gusts_10m.
import { el } from "../src/shared/ui.js";
import { weather } from "./civic-data.js";
import "./civic-wxfx.css";

const PP = 50, MM = 0.2, AHEAD = 12;   // a wet hour: chance ≥ 50% and ≥ 0.2 mm; the line looks 12 hours ahead
const reduced = () => matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const dark = () => { const t = document.documentElement.dataset.theme; return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const RAINY = (c) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95, SNOWY = (c) => (c >= 71 && c <= 77) || c === 85 || c === 86, FOGGY = (c) => c === 45 || c === 48;
// a typical rate for the code when the model's hour shows nothing yet (mm/h)
const CODE_RATE = { 51: 0.2, 53: 0.4, 55: 0.8, 56: 0.3, 57: 0.8, 61: 0.8, 63: 2.5, 65: 6, 66: 1, 67: 4, 80: 1, 81: 3, 82: 8, 95: 5, 96: 6, 99: 9, 71: 0.3, 73: 0.8, 75: 2, 77: 0.3, 85: 0.6, 86: 2 };

/** the hour now in the hourly arrays (the hour that started most recently, place time) */
const hourIdx = (w) => { const now = w.current.time.slice(0, 13); return Math.max(0, w.hourly.time.findIndex((t) => t.slice(0, 13) === now)); };
const hLabel = (s) => { const h = +s.slice(11, 13); return `${h % 12 || 12} ${h < 12 ? "am" : "pm"}`; };

/** what it's doing now: { kind: rain | snow | fog | wind | clear | none, rate (mm/h), f (0–1 intensity), wind, gust, day } */
export function nowFx(w) {
  if (!w?.current || !w.hourly) return null;
  const c = w.current, h = w.hourly, i = hourIdx(w), code = c.weather_code;
  // Open-Meteo's hourly precipitation is the hour ending at that time, so the hour in progress is i + 1
  const hr = Math.max(h.precipitation?.[i + 1] ?? 0, h.precipitation?.[i] ?? 0), sn = Math.max(h.snowfall?.[i + 1] ?? 0, h.snowfall?.[i] ?? 0);
  const wind = c.wind_speed_10m ?? 0, gust = Math.max(h.wind_gusts_10m?.[i] ?? 0, h.wind_gusts_10m?.[i + 1] ?? 0);
  const falling = RAINY(code) || SNOWY(code) || (c.precipitation ?? 0) > 0;
  const rate = falling ? Math.max(hr, CODE_RATE[code] ?? 0.3) : 0;
  const snow = SNOWY(code) || (falling && sn > 0 && sn / 0.7 >= 0.5 * hr);
  const windy = gust >= 50 || wind >= 30;
  const kind = falling ? (snow ? "snow" : "rain") : FOGGY(code) ? "fog" : windy ? "wind" : code <= 1 && c.is_day ? "clear" : "none";
  // intensity: 0.2 mm/h is a drizzle (≈0.15), 4 mm/h steady rain (≈0.6), 10 mm/h or more a downpour (1)
  const f = kind === "rain" || kind === "snow" ? clamp(0.12 + Math.log1p(rate) / Math.log1p(10) * 0.88, 0.12, 1) : kind === "wind" ? clamp((gust - 40) / 50, 0.3, 1) : 0.6;
  return { kind, rate, f, wind, gust, windy, day: !!c.is_day, code };
}

// ------------------------------------------------------------------ the rain line
/** { kind: "rain" | "snow", state: "now" | "soon" | "dry", text, sub, slots } from the hourly forecast, or null */
export function rainLine(w) {
  if (!w?.hourly?.precipitation) return null;
  const h = w.hourly, i = hourIdx(w), c = w.current, n = h.time.length;
  // slot j (1…) is the hour ending at time[i + j]; slot 1 is the hour in progress
  const slot = (j) => { const k = i + j; if (k >= n) return null;
    const mm = h.precipitation[k] ?? 0, pp = h.precipitation_probability?.[k] ?? 0, sn = h.snowfall?.[k] ?? 0;
    return { j, k, t: h.time[k - 1] ?? h.time[k], mm, pp, wet: pp >= PP && mm >= MM, snow: sn > 0 && sn / 0.7 >= 0.5 * mm }; };
  const slots = [...Array(AHEAD)].map((_, j) => slot(j + 1)).filter(Boolean);
  const runFrom = (j0) => { const out = []; for (let j = j0; j <= 24; j++) { const s = slot(j); if (!s?.wet) break; out.push(s); } return out; };
  const kindOf = (run) => (run.filter((s) => s.snow).length * 2 > run.length ? "snow" : "rain");
  const dur = (m, capped) => (capped ? "24 hours or more" : m <= 1 ? "about an hour" : `about ${m} hours`);
  const peak = (run) => run.reduce((a, s) => (s.mm > a.mm ? s : a), run[0]);
  const code = c.weather_code, nowWet = RAINY(code) || SNOWY(code) || (c.precipitation ?? 0) > 0;
  if (nowWet) {
    const run = runFrom(2), kind = run.length ? kindOf(run) : SNOWY(code) ? "snow" : "rain", K = kind === "snow" ? "Snow" : "Rain";
    const m = run.length + 1, end = run.length ? h.time[run[run.length - 1].k] : null, p = run.length ? peak(run) : null;
    return { kind, state: "now", slots,
      text: run.length ? `${K} continuing for ${dur(m, run.length >= 23)}` : `${K} easing within the hour`,
      sub: run.length ? `Until about ${hLabel(end)} · up to ${p.mm.toFixed(1)} mm/h around ${hLabel(p.t)}` : `Light: the next hours are under ${PP}% or ${MM} mm` };
  }
  const first = slots.find((s) => s.wet);
  if (first) {
    const run = runFrom(first.j), kind = kindOf(run), K = kind === "snow" ? "Snow" : "Rain", hrs = first.j - 1, p = peak(run);
    const when = hrs === 0 ? "within the hour" : hrs === 1 ? "in about an hour" : `in ${hrs} hours`;
    return { kind, state: "soon", slots, text: `${K} expected ${when}, for ${dur(run.length, run.length >= 24)}`,
      sub: `From about ${hLabel(first.t)} · ${p.pp}% chance · up to ${p.mm.toFixed(1)} mm/h around ${hLabel(p.t)}` };
  }
  const best = slots.reduce((a, s) => (s.pp > a.pp ? s : a), slots[0] || { pp: 0 });
  return { kind: "rain", state: "dry", slots, text: `Dry for the next ${AHEAD} hours`,
    sub: best?.pp ? `Highest chance ${best.pp}% around ${hLabel(best.t)}` : "No precipitation in the forecast" };
}

/** Forecast page, top left: the rain line, prominent like an alert while rain is falling or due */
export function rainPanel(ctx) {
  const c = weather(ctx.place.ll, ctx), r = rainLine(c.data);
  const title = r?.kind === "snow" && r.state !== "dry" ? "Snow Outlook" : "Rain Outlook";
  if (!r) return { id: "wx-rain", title, place: "left", el: el("div", { class: "civ-fp-body" }, el("p", { class: "note civ-empty" }, c.err ? "The hourly forecast didn't load (Open-Meteo may be busy)." : "Loading the hourly forecast…")) };
  const max = Math.max(2, ...r.slots.map((s) => s.mm));
  const bars = el("div", { class: "rx-bars", role: "img", "aria-label": `Next ${r.slots.length} hours of precipitation` }, ...r.slots.map((s, n) =>
    el("div", { class: "rx-b", "data-wet": String(s.wet), "data-snow": String(s.snow), title: `${hLabel(s.t)}: ${s.mm.toFixed(1)} mm, ${s.pp}%` },
      el("i", { style: `height:${Math.max(s.mm > 0 ? 8 : 0, Math.round((Math.sqrt(s.mm) / Math.sqrt(max)) * 100))}%;opacity:${(0.35 + 0.65 * s.pp / 100).toFixed(2)}` }),
      el("small", {}, n % 3 === 0 ? hLabel(s.t) : ""))));
  return { id: "wx-rain", title, place: "left", el: el("div", { class: "civ-fp-body rx", "data-state": r.state, "data-kind": r.kind },
    el("p", { class: "rx-line" }, el("i", { class: "rx-dot" }), r.text),
    el("p", { class: "rx-sub" }, r.sub),
    bars,
    el("div", { class: "civ-fp-foot" }, el("span", {}, `Open-Meteo hourly (CC BY 4.0) · an hour counts at ${PP}% chance and ${MM} mm or more`))) };
}

// ------------------------------------------------------------------ the background effect
/** ?wxfx=kind[:value] → a stand-in for nowFx (see the header) */
function override() {
  const q = new URLSearchParams(location.search).get("wxfx"); if (!q) return null;
  const [kind, v] = q.split(":"), x = +v || 0, rate = kind === "rain" || kind === "snow" ? x || 2 : 0, gust = kind === "wind" ? x || 70 : 20;
  const f = rate ? clamp(0.12 + Math.log1p(rate) / Math.log1p(10) * 0.88, 0.12, 1) : kind === "wind" ? clamp((gust - 40) / 50, 0.3, 1) : 0.6;
  return { kind, rate, f, wind: gust * 0.6, gust, windy: gust >= 50, day: true, code: -1 };
}
/** custom stage layer: the canvas and its loop → cleanup */
export function fxLayer(map, ctx) {
  const host = map.getCanvasContainer(), cv = el("canvas", { class: "wxfx", "aria-hidden": "true" });
  host.insertBefore(cv, map.getCanvas().nextSibling);
  const g = cv.getContext("2d");
  let W = 0, H = 0, fx = null, sig = "", parts = [], raf = 0, last = 0, alive = true;
  // the canvas container has no size of its own (MapLibre sizes the map canvas directly), so follow the map container
  const box = map.getContainer();
  const size = () => { const r = box.getBoundingClientRect(); W = Math.round(r.width); H = Math.round(r.height); cv.width = W; cv.height = H; cv.style.width = `${W}px`; cv.style.height = `${H}px`; seed(); frame(0, true); };
  const ro = new ResizeObserver(size);
  const rnd = (a, b) => a + Math.random() * (b - a);
  function seed() {
    parts = []; if (!fx || !W) return;
    const area = (W * H) / (2560 * 1440);
    if (fx.kind === "rain") for (let n = Math.round((150 + 550 * fx.f) * area); n--;) parts.push({ x: rnd(0, W), y: rnd(0, H), l: rnd(10, 22) * (0.7 + fx.f * 0.6), v: rnd(0.8, 1.2), a: rnd(0.6, 1) });
    if (fx.kind === "snow") for (let n = Math.round((170 + 330 * fx.f) * area); n--;) parts.push({ x: rnd(0, W), y: rnd(0, H), r: rnd(1.3, 3.2), v: rnd(0.5, 1.1), ph: rnd(0, 6.28), a: rnd(0.5, 1) });
    if (fx.kind === "fog") for (let n = 7; n--;) parts.push({ x: rnd(-0.2, 1.1) * W, y: rnd(0.05, 1) * H, r: rnd(0.25, 0.45) * Math.max(W, H), v: rnd(0.4, 1) });
    if (fx.kind === "wind" || (fx.windy && fx.kind !== "fog")) for (let n = Math.round((fx.kind === "wind" ? 26 + 24 * fx.f : 12) * Math.max(0.5, area)); n--;) parts.push({ w: true, x: rnd(0, W), y: rnd(0, H), l: rnd(120, 260), v: rnd(0.8, 1.3), ph: rnd(0, 6.28), a: rnd(0.5, 1) });
  }
  function frame(t, still = false) {
    g.clearRect(0, 0, W, H);
    if (!fx || !W) return;
    const D = dark(), dt = still ? 0 : Math.min(60, t - (last || t)) / 16.7;
    // slant from the wind: about 0.12 at calm to 0.5 in a gale (streaks run down to the right)
    const slant = clamp(0.1 + (Math.max(fx.wind, fx.gust * 0.6)) / 140, 0.1, 0.55);
    if (fx.kind === "clear") {
      const gr = g.createRadialGradient(W * 0.62, -H * 0.08, 0, W * 0.62, -H * 0.08, Math.max(W, H) * 0.6);   // top centre, between the panel columns
      gr.addColorStop(0, D ? "rgba(255,196,120,0.10)" : "rgba(255,186,80,0.16)"); gr.addColorStop(1, "rgba(255,196,120,0)");
      g.fillStyle = gr; g.fillRect(0, 0, W, H); return;
    }
    if (fx.kind === "fog") for (const p of parts) {
      p.x += dt * 0.25 * p.v; if (p.x - p.r > W) p.x = -p.r;
      const gr = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r), a = D ? 0.07 : 0.16;
      gr.addColorStop(0, D ? `rgba(205,214,226,${a})` : `rgba(255,255,255,${a})`); gr.addColorStop(1, "rgba(205,214,226,0)");
      g.fillStyle = gr; g.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
    }
    if (fx.kind === "rain") {
      const base = D ? "190,212,240" : "38,66,104", A = (D ? 0.14 : 0.17) + fx.f * (D ? 0.12 : 0.13);
      g.lineWidth = 1.2; g.lineCap = "round";
      for (const p of parts) {
        const sp = (14 + fx.f * 10) * p.v * dt; p.y += sp; p.x += sp * slant;
        if (p.y > H + 30) { p.y = -30; p.x = rnd(-0.2 * W, W); } if (p.x > W + 30) p.x -= W + 60;
        g.strokeStyle = `rgba(${base},${(A * p.a).toFixed(3)})`; g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x - p.l * slant, p.y - p.l); g.stroke();
      }
    }
    if (fx.kind === "snow") {
      const base = D ? "236,244,255" : "84,104,136", A = D ? 0.42 + fx.f * 0.22 : 0.40 + fx.f * 0.2;
      for (const p of parts) {
        p.ph += 0.02 * dt; p.y += (0.9 + fx.f) * p.v * dt; p.x += (Math.sin(p.ph) * 0.4 + slant * 1.2) * dt;
        if (p.y > H + 5) { p.y = -5; p.x = rnd(0, W); } if (p.x > W + 5) p.x = -5;
        g.fillStyle = `rgba(${base},${(A * p.a).toFixed(3)})`; g.beginPath(); g.arc(p.x, p.y, p.r, 0, 6.283); g.fill();
      }
    }
    // wind: long thin streaks that bow a little as they cross
    const ws = parts.filter((p) => p.w);
    if (ws.length) {
      const base = D ? "200,216,236" : "60,84,118", A = (fx.kind === "wind" ? 0.22 + 0.10 * fx.f : 0.14) * (D ? 1 : 1.4);
      g.lineWidth = 2; g.lineCap = "round";
      for (const p of ws) {
        p.x += (9 + 6 * fx.f) * p.v * dt; p.ph += 0.03 * dt;
        if (p.x - p.l > W) { p.x = -rnd(0, 200); p.y = rnd(0, H); }
        const bow = Math.sin(p.ph) * 10, gr = g.createLinearGradient(p.x - p.l, 0, p.x, 0);
        gr.addColorStop(0, `rgba(${base},0)`); gr.addColorStop(0.7, `rgba(${base},${(A * p.a).toFixed(3)})`); gr.addColorStop(1, `rgba(${base},0)`);
        g.strokeStyle = gr; g.beginPath(); g.moveTo(p.x - p.l, p.y); g.quadraticCurveTo(p.x - p.l / 2, p.y + bow, p.x, p.y + bow * 0.3); g.stroke();
      }
    }
  }
  const moving = () => fx && fx.kind !== "none" && fx.kind !== "clear" && !reduced() && !document.hidden;
  function loop(t) {
    raf = 0; if (!alive) return;
    if (t - last >= 33) { frame(t); last = t; }   // about 30 fps
    if (moving()) raf = requestAnimationFrame(loop);
  }
  const kick = () => { if (!raf && moving()) { last = 0; raf = requestAnimationFrame(loop); } else if (!moving()) frame(0, true); };
  // read the page's forecast (cached; this never fetches on its own beyond the page's one call) and follow changes
  function read() {
    const w = weather(ctx.place.ll, ctx).data, n = override() || nowFx(w), s = n ? `${ctx.place.id}|${n.kind}|${n.f.toFixed(2)}|${n.windy}|${Math.round(n.wind / 5)}|${dark()}` : "";
    if (s === sig) return; sig = s; fx = n; cv.dataset.kind = n?.kind || ""; seed(); frame(0, true); kick();
  }
  const vis = () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else kick(); };
  const mq = matchMedia("(prefers-reduced-motion: reduce)"), onMq = () => kick();
  document.addEventListener("visibilitychange", vis); mq.addEventListener?.("change", onMq);
  const tick = setInterval(read, 3000);
  ro.observe(box); size(); read();
  return () => { alive = false; cancelAnimationFrame(raf); clearInterval(tick); ro.disconnect(); document.removeEventListener("visibilitychange", vis); mq.removeEventListener?.("change", onMq); cv.remove(); };
}
