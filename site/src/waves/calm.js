// Calm water: low-wind, low-wave windows for paddling near Victoria and Vancouver. Sub-views: the week
// (spot × day + hour-by-hour wind) and the calm windows tier list.
import {
  W, $, d3, el, tipRow, cssVar, loadForecast, hours, dayMatrix, hourStrip, tierBoard, findWindow, factorBars, trustChip, smallNote,
  wd, hr, md, dayLong, dayOf, span, f1, f0, pct, compass, tierOf, tierCol, TIERS, ymd, frame, gridY, axisClean,
  BBOX_VICTORIA, BBOX_VANCOUVER, clamp01, hoursToWindow,
} from "./common.js";
import { dStats, dChart, dNote, dLink, dHead } from "../shared/console.js";

const P = () => W.waves.paddle;
const KEYS = () => Object.keys(W.waves.paddle);
const go = (...a) => W.ctx.go(...a);
const short = (n) => n.replace(/ \(.*\)/, "");

function calmHours() { // daylight hours at B or better per day over the next 7 days, best spot each hour
  const T = hours(W.fc), by = new Map();
  T.forEach((t, i) => {
    const best = d3.max(KEYS(), (k) => (W.fc.paddle[k].day[i] ? W.fc.paddle[k].score[i] : null));
    if (best != null && best >= 55) by.set(ymd(t), (by.get(ymd(t)) || 0) + 1);
  });
  return P()[KEYS()[0]].daily.map((d) => [d.date, by.get(d.date) || 0]);
}

export const calm = {
  id: "calm", title: "Calm water", color: "var(--calm)",
  eyebrow: "Victoria & Vancouver", heading: "Paddling Forecast",
  // Civic Atlas: two waterfronts; relevance = paddling season (summer) + a calm window today or tomorrow
  footprint: { bbox: [-123.55, 48.38, -122.90, 49.36], areas: [{ name: "Victoria", bbox: BBOX_VICTORIA }, { name: "Vancouver", bbox: BBOX_VANCOUVER }] }, kind: "only-here",
  relevance: (ctx, date = new Date()) => {
    const season = [0.25, 0.25, 0.35, 0.5, 0.7, 0.85, 0.95, 0.95, 0.75, 0.5, 0.3, 0.25][date.getMonth()];
    const hrs = W.waves ? hoursToWindow(W.waves.paddle_windows, 70, date) : Infinity;
    return clamp01(0.65 * season + (hrs < 30 ? 0.35 : hrs < 72 ? 0.15 : 0));
  },
  load: loadForecast,
  badge: () => { const h = d3.sum(calmHours(), (d) => d[1]); return [`${h} h`, "calm daylight hours (B+) this week, best spot"]; },
  kpis: () => {
    const ws = W.waves.paddle_windows, first = TIERS.flatMap((t) => ws.items[t] || [])[0], ch = calmHours();
    const next = Object.values(ws.items).flat().filter((w) => w.score >= 55).sort((a, b) => new Date(a.start) - new Date(b.start))[0];
    return [
      ["Next calm window", next ? `${wd(next.start)} ${hr(next.start)}` : "–", next ? `${short(next.name)}, ${next.hours} h, ${next.tier}` : "none at B+"],
      ["Best window", first ? `${first.tier} · ${wd(first.start)}` : "–", first ? `${short(first.name)}` : ""],
      ["Calm hours", `${d3.sum(ch, (d) => d[1])} h`, "daylight, B or better, best spot"],
      ["Spots", `${KEYS().length}`, "2 exposed · 2 sheltered"],
    ];
  },
  tile: (t) => {
    const ws = W.waves.paddle_windows, ch = calmHours();
    const next = Object.values(ws.items).flat().filter((w) => w.score >= 55).sort((a, b) => new Date(a.start) - new Date(b.start))[0];
    const best = ch.reduce((a, b) => (b[1] > a[1] ? b : a));
    t.kpis([
      [next ? `${wd(next.start)} ${hr(next.start)}` : "–", next ? `next calm window · ${next.region}` : "no calm window at B+"],
      [`${d3.sum(ch, (d) => d[1])} h`, "calm daylight hours this week"],
      [wd(dayOf(best[0])), `calmest day · ${best[1]} h`],
    ]);
    tileBars(t.vis, ch);
  },
  subs: [
    { id: "week", title: "This week", short: "Week", class: "pane-cweek",
      view: (host, ctx, r) => {
        if (r.item) { const k = r.item.split(":")[0]; if (P()[k]) W.paddle = k; }
        dayMatrix("cw-matrix", KEYS().map((k) => ({ key: k, name: short(P()[k].name), sub: `${P()[k].area} · ${P()[k].sheltered ? "sheltered" : "exposed"}`, daily: P()[k].daily })),
          { sel: W.paddle, selItem: r.item, select: (k) => { W.paddle = k; if (r.item && r.item.split(":")[0] !== k) go("calm", "week"); else ctx.refresh(); }, pick: (k, d) => go("calm", "week", `${k}:${d}`) });
        renderStrip();
        renderRules();
      }, html: `
      <div class="card cx-fill ww-mx-card"><h3 class="cx-card-title">Calmest rating each day</h3><p class="note cx-card-sub">Score = 100 × wind × gust × wave (waves only at exposed spots), daylight only. Bold edge: 2+ hours at B or better.</p><div id="cw-matrix"></div></div>
      <div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title" id="cw-strip-t">Hour by hour</h3><div class="legend" id="cw-strip-leg"></div><div class="chart" id="cw-strip"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">The thresholds</h3><p class="note cx-card-sub">Score 1 at calm, 0.85 at "full", 0 at "zero". Tides and currents are shown, not scored: check them before you go.</p><div class="ww-prules cx-grow" id="cw-rules"></div></div>
      </div>` },
    { id: "windows", title: "Calm windows", short: "Windows", class: "pane-cwin",
      view: (host, ctx, r) => tierBoard("cw-board", W.waves.paddle_windows, windowCard, (k) => go("calm", "windows", k), r.item), html: `
      <p class="note cx-lede">Runs of 2+ daylight hours at C or better. Calm spells are common in the forecast, so S (near glassy) is frequent in settled weeks. The backtest checks wind (and waves at English Bay) against the shore stations; gusts aren't observed hourly, so they aren't in it.</p>
      <div class="ww-board cx-grow" id="cw-board"></div>` },
  ],
  drawers: {
    week: (host, ctx, item) => dayDrawer(item),
    windows: (host, ctx, item) => windowDrawer(item),
  },
};

function tileBars(host, ch) {
  const m = { l: 26, r: 6, t: 8, b: 18 };
  const { g, iw, ih } = frame(host, m, 150);
  const x = d3.scaleBand(ch.map((d) => d[0]), [0, iw]).padding(0.25);
  const y = d3.scaleLinear([0, Math.max(10, d3.max(ch, (d) => d[1]))], [ih, 0]).nice();
  gridY(g, y, iw, ih, (v) => `${v}h`);
  g.selectAll("rect").data(ch).join("rect").attr("x", (d) => x(d[0])).attr("width", x.bandwidth()).attr("y", (d) => y(d[1])).attr("height", (d) => ih - y(d[1])).attr("rx", 3)
    .style("fill", "var(--calm)").style("cursor", "pointer").attr("data-pick", "").on("click", (e, d) => go("calm", "week", `${W.paddle}:${d[0]}`));
  g.append("g").selectAll("text").data(ch).join("text").attr("class", "axis-t").attr("x", (d) => x(d[0]) + x.bandwidth() / 2).attr("y", ih + 13).attr("text-anchor", "middle").text((d) => wd(dayOf(d[0])));
}

function renderStrip() {
  const k = W.paddle, p = P()[k], F = W.fc.paddle[k], T = hours(W.fc);
  $("cw-strip-t").textContent = `Hour by hour · ${short(p.name)}`;
  $("cw-strip-leg").replaceChildren(
    el("span", { class: "key" }, el("i", { class: "band", style: { background: "var(--t-A)" } }), "calm score (daylight)"),
    el("span", { class: "key" }, el("i", { class: "line", style: { background: "var(--calm)" } }), "wind km/h"),
    el("span", { class: "key" }, el("i", { class: "line dash", style: { background: "var(--ink-2)" } }), "gusts km/h"));
  hourStrip("cw-strip", T, F.score, F.day, {
    lines: [{ v: F.wspd, color: cssVar("--calm"), w: 2 }, { v: F.gust, color: cssVar("--ink-2"), dash: "3 3", w: 1.2 }], unit: "",
    pick: (i) => go("calm", "week", `${k}:${ymd(T[i])}`),
    tip: (t, i) => t.append(el("div", { class: "t-title" }, `${short(p.name)} · ${wd(T[i])} ${hr(T[i])}${F.day[i] ? "" : " (dark)"}`),
      tipRow(tierCol(tierOf(F.score[i])), `${F.score[i] ?? "–"} ${tierOf(F.score[i]) || ""}`, "calm score"),
      tipRow(cssVar("--calm"), `${f0(F.wspd[i])} km/h ${compass(F.wdir[i])}`, "wind"), tipRow(null, `${f0(F.gust[i])} km/h`, "gusts"),
      F.hs[i] != null ? tipRow(null, f1(F.hs[i], " m"), "waves offshore") : null, tipRow(null, f1(F.tide[i], " m"), "tide")),
  });
}
function renderRules() {
  $("cw-rules").replaceChildren(...KEYS().map((k) => {
    const p = P()[k], r = p.rule;
    return el("div", { class: `ww-prule${k === W.paddle ? " on" : ""}` }, el("b", {}, short(p.name)),
      el("small", {}, `wind ${r.wind_kmh[0]}/${r.wind_kmh[1]} km/h · gust ${r.gust_kmh[0]}/${r.gust_kmh[1]}${r.wave_m ? ` · waves ${r.wave_m[0]}/${r.wave_m[1]} m` : " · sheltered"}`));
  }));
}

function windowCard(w) {
  return [
    el("div", { class: "ww-card-h" }, el("b", {}, short(w.name)), el("span", { class: "ww-score" }, Math.round(w.score))),
    el("div", { class: "ww-card-t" }, `${span(w.start, w.end)} · ${w.hours} h`),
    el("div", { class: "ww-card-c" }, `wind ≤ ${f0(w.wspd_max)} · gusts ≤ ${f0(w.gust_max)} km/h${w.hs_max != null ? ` · waves ≤ ${f1(w.hs_max, " m")}` : ""}`),
    trustChip(w.trust, { extra: el("span", {}, `day ${w.lead_days}`) }),
  ];
}
function windowDrawer(item) {
  const w = findWindow(W.waves.paddle_windows, item);
  if (!w) return null;
  const p = P()[w.spot];
  return {
    kicker: `Calm water · ${w.tier}-tier window`, title: `${short(p.name)}, ${span(w.start, w.end)}`,
    body: [
      dStats([[`${w.tier} · ${Math.round(w.score)}`, "window score (best 3 h)"], [`${w.hours} h`, `${w.go_hours} at B or better`],
        [`${f0(w.wspd_max)} / ${f0(w.gust_max)}`, "max wind / gust, km/h"], [w.hs_max != null ? f1(w.hs_max, " m") : "sheltered", "max waves"]]),
      dHead(`Forecast trust at day ${w.lead_days}`), trustChip(w.trust),
      dNote(`Most days have a calm spell somewhere, so read the skill score, not accuracy.${smallNote(w.trust?.n_days)}`),
      ...p.notes.map((t) => dNote(t)),
      dLink(W.ctx.href("calm", "week", `${w.spot}:${ymd(w.start)}`), "That day, hour by hour"),
    ],
  };
}
function dayDrawer(item) {
  const [k, date] = item.split(":");
  const p = P()[k], d = p?.daily.find((x) => x.date === date);
  if (!p || !d) return null;
  W.paddle = k;
  const F = W.fc.paddle[k], T = hours(W.fc), idx = T.map((t, i) => i).filter((i) => ymd(T[i]) === date);
  const tr = p.trust[d.lead], pk = d.best_time ? T.findIndex((t) => +t === +new Date(d.best_time)) : -1;
  return {
    kicker: `Calm water · ${p.area}`, title: `${short(p.name)}, ${dayLong(dayOf(date))}`,
    body: [
      dStats([[d.best == null ? "–" : `${d.tier} · ${Math.round(d.best)}`, "calmest daylight hour"], [d.best_time ? hr(d.best_time) : "–", "when"],
        [`${d.go_hours ?? 0} h`, "at B or better"], [d.go ? "GO" : "no-go", `call made ${d.lead} day${d.lead === 1 ? "" : "s"} ahead`]]),
      trustChip(tr), dNote(`Backtest at this lead.${smallNote(tr?.n_days)}`),
      dChart("dr-cday", "Wind and gusts through the day (km/h)"),
      pk >= 0 ? factorBars([["Wind", F.f_wind[pk], `${f0(F.wspd[pk])} km/h ${compass(F.wdir[pk])}`], ["Gust", F.f_gust[pk], `${f0(F.gust[pk])} km/h`],
        ["Waves", p.sheltered ? null : F.f_wave[pk], p.sheltered ? "sheltered: not scored" : f1(F.hs[pk], " m")]]) : null,
      pk >= 0 ? dNote(`Air ${f0(F.temp[pk], "°")}${F.sst[pk] != null ? `, sea ${f0(F.sst[pk], "°")}` : ""}; ${F.precip[pk] > 0 ? `${f1(F.precip[pk], " mm")} rain that hour` : "dry that hour"}. Tide ${f1(F.tide[pk], " m")} (${p.tide}).`) : null,
    ],
    after: () => {
      const m = { l: 30, r: 8, t: 8, b: 20 };
      const { g, iw, ih } = frame("dr-cday", m, 190);
      const x = d3.scaleBand(idx, [0, iw]).padding(0.15);
      const y = d3.scaleLinear([0, Math.max(25, d3.max(idx, (i) => F.gust[i] || 0))], [ih, 0]).nice();
      gridY(g, y, iw, ih);
      g.selectAll("rect").data(idx).join("rect").attr("x", (i) => x(i)).attr("width", x.bandwidth()).attr("y", (i) => y(F.wspd[i] ?? 0)).attr("height", (i) => ih - y(F.wspd[i] ?? 0))
        .style("fill", (i) => (F.day[i] ? tierCol(tierOf(F.score[i])) : "var(--ww-night)"));
      g.append("path").datum(idx).attr("d", d3.line().x((i) => x(i) + x.bandwidth() / 2).y((i) => y(F.gust[i] ?? 0))).style("fill", "none").style("stroke", "var(--ink-2)").style("stroke-dasharray", "3 3");
      g.append("g").selectAll("text").data(idx.filter((i, j) => j % 4 === 0)).join("text").attr("class", "axis-t").attr("x", (i) => x(i) + x.bandwidth() / 2).attr("y", ih + 13).attr("text-anchor", "middle").text((i) => hr(T[i]));
    },
  };
}
