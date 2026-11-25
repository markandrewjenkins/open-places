// Open Places: the weather hints (the rail's Weather icon and the Forecast page's rain line).
//  * wxHint(w): the Weather icon in the rail follows what it's doing now (sun, moon, cloud, rain, snow, fog, wind, storm),
//    with the temperature as its badge and a hover line. It replaced an animated rain / snow background (too distracting).
//  * rainPanel(ctx): the Forecast page's rain line from the hourly forecast ("Rain continuing for about 3 hours",
//    "Rain expected in 2 hours, for about 4 hours", "Dry for the next 12 hours"; snow the same way when it's snow).
//    An hour counts as wet at a 50% chance or more and 0.2 mm or more. It stays on the page, not in the alert bar.
// Data: the page's own Open-Meteo forecast (civic-data.js weather(), CC BY 4.0): the same cached call as the Forecast
// tile and chart, so no extra requests. Fields used: current weather_code, precipitation, wind_speed_10m, is_day;
// hourly precipitation, snowfall, precipitation_probability, wind_gusts_10m.
import { el } from "../src/shared/ui.js";
import { weather, WMO } from "./civic-data.js";
import "./civic-wxfx.css";

const PP = 50, MM = 0.2, AHEAD = 12;   // a wet hour: chance ≥ 50% and ≥ 0.2 mm; the line looks 12 hours ahead
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

// ------------------------------------------------------------------ the rail hint
// The animated background is gone (distracting); instead the Weather icon in the rail shows what it's doing now,
// with the temperature beside it and a hover line: "Light rain, 10° · Rain continuing for about 3 hours".
/** { ic, temp, tip } for the Weather topic in the rail, or null */
export function wxHint(w) {
  const fx = nowFx(w); if (!fx) return null;
  const c = w.current, code = c.weather_code, day = !!c.is_day;
  const ic = code >= 95 ? "storm" : fx.kind === "rain" ? "cloudRain" : fx.kind === "snow" ? "snow" : fx.kind === "fog" ? "fog"
    : fx.kind === "wind" ? "wind" : code <= 1 ? (day ? "sun" : "moon") : code === 2 ? (day ? "cloudSun" : "cloudMoon") : "cloud";
  const temp = `${Math.round(c.temperature_2m)}°`, r = rainLine(w);
  const windy = fx.windy && fx.kind !== "fog" ? `gusts ${Math.round(fx.gust)} km/h` : "";
  return { ic, temp, tip: [[WMO[code] || "Now", temp, windy].filter(Boolean).join(", "), r?.text].filter(Boolean).join(" · ") };
}
