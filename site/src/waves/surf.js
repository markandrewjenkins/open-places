// Surf go/no-go: which open-coast beach is worth the drive this week, and when. Sub-views: the week (spot × day
// tiers + hour-by-hour strip), the best windows tier list, seasons (how often each month delivers) and the spot rules.
import {
  W, $, d3, el, tipRow, cssVar, tip, loadForecast, hours, dayMatrix, hourStrip, tierBoard, findWindow, factorBars, trustChip, smallNote,
  wd, hr, hm, md, dayLong, dayOf, span, f1, f0, pct, dec, compass, swell, ago, tierOf, tierCol, TIERS, ymd, frame, gridY, axisClean,
  BBOX_COAST, clamp01, hoursToWindow,
} from "./common.js";
import { dStats, dChart, dNote, dLink, dHead } from "../shared/console.js";

const S = () => W.waves.spots;
const KEYS = () => Object.keys(W.waves.spots);
const go = (...a) => W.ctx.go(...a);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LORE = "surf-guide lore, unverified";

function bestDay() { // the strongest spot-day this week
  let best = null;
  for (const k of KEYS()) for (const d of S()[k].daily) if (d.best != null && (!best || d.best > best.d.best)) best = { k, d };
  return best;
}
const goDays = () => { const set = new Set(); for (const k of KEYS()) for (const d of S()[k].daily) if (d.go) set.add(d.date); return set.size; };
const tideLbl = (sp) => {
  const [a, b] = sp.rule.tide_band;
  if (sp.rule.tide_floor >= 1) return "all tides (not scored)";
  return `${a <= 0.05 ? "low" : a < 0.4 ? "low–mid" : "mid"}${b >= 0.95 ? " to high" : b > 0.7 ? " to mid-high" : b > 0.5 ? " to mid" : ""} preferred (${LORE})`;
};

export const surf = {
  id: "surf", title: "Surf go/no-go", tileTitle: "Surf go/no-go", color: "var(--surf)",
  eyebrow: "Juan de Fuca & Tofino", heading: "Surf Forecast",
  // Civic Atlas: southwest BC's open coast; relevance = swell season (from the buoy climatology) + a GO window coming up
  footprint: { bbox: BBOX_COAST, places: ["Jordan River", "Sombrio Beach", "Tofino", "Ucluelet"] }, kind: "only-here",
  relevance: (ctx, date = new Date()) => {
    const m = date.getMonth();
    const season = W.waves ? d3.mean(Object.values(W.waves.climatology), (c) => c.months[m]?.go_share ?? 0) / 0.75 : [0.9, 0.85, 0.7, 0.6, 0.4, 0.2, 0.1, 0.15, 0.4, 0.6, 0.8, 0.9][m];
    const hrs = W.waves ? hoursToWindow(W.waves.windows, 55, date) : Infinity;
    return clamp01(0.55 * clamp01(season) + (hrs < 36 ? 0.45 : hrs < 96 ? 0.25 : 0));
  },
  load: loadForecast,
  badge: () => { const b = bestDay(); return b ? [b.d.tier, `best this week: ${S()[b.k].name}, ${wd(dayOf(b.d.date))}`] : "–"; },
  kpis: () => {
    const b = bestDay(), w = W.waves.windows, now = KEYS().map((k) => [k, S()[k].now]).filter(([, n]) => n).sort((a, c) => c[1].score - a[1].score)[0];
    const nb = W.waves.buoys["46087"].latest;
    return [
      ["Best day", b ? `${b.d.tier} · ${wd(dayOf(b.d.date))}` : "–", b ? `${S()[b.k].name}, ${Math.round(b.d.best)}/100` : ""],
      ["Windows", `${(w.counts.S || 0) + (w.counts.A || 0)} S/A`, `${TIERS.slice(0, 4).map((t) => `${w.counts[t] || 0}${t}`).join(" · ")}`],
      ["Right now", now ? `${now[1].tier} · ${S()[now[0]].name.split(" (")[0]}` : "–", now ? `${now[1].daylight ? "" : "after dark · "}buoy ${ago(now[1].buoy.age_h)}` : ""],
      ["Neah Bay", nb ? swell(nb.hs, nb.tp, nb.dir) : "–", nb ? `46087 · ${ago(nb.age_h)}` : ""],
    ];
  },
  tile: (t) => {
    const b = bestDay(), ws = W.waves.windows, first = TIERS.flatMap((x) => ws.items[x] || [])[0];
    t.kpis([
      [b ? `${b.d.tier} ${wd(dayOf(b.d.date))}` : "–", b ? `best day · ${S()[b.k].name}` : "no surf this week"],
      [`${goDays()} of 7`, "days with a GO (B+) window"],
      [first ? S()[first.spot].name.split(" (")[0] : "–", first ? `top window ${span(first.start, first.end)}` : "no windows"],
    ]);
    t.status(`Neah Bay ${f1(W.waves.buoys["46087"].latest?.hs, " m")}`);
    tileMatrix(t.vis);
  },
  subs: [
    { id: "week", title: "This week", short: "Week", class: "pane-sweek",
      view: (host, ctx, r) => {
        if (r.item) { const k = r.item.split(":")[0]; if (S()[k]) W.spot = k; }
        dayMatrix("sf-matrix", KEYS().map((k) => ({ key: k, name: S()[k].name.replace(" (Incinerator Rock)", ""), sub: `${S()[k].region} · ${S()[k].buoy}`, daily: S()[k].daily })),
          { sel: W.spot, selItem: r.item, select: (k) => { W.spot = k; if (r.item && r.item.split(":")[0] !== k) go("surf", "week"); else ctx.refresh(); }, pick: (k, d) => go("surf", "week", `${k}:${d}`) });
        renderStrip();
        renderNow();
      }, html: `
      <div class="card cx-fill ww-mx-card"><h3 class="cx-card-title">Best rating each day</h3><p class="note cx-card-sub">Daylight hours only. Tier from 100 × size × period × direction × wind × tide; a GO day (bold edge) has 2+ hours at B or better. Click a name for its hours, a day for the detail.</p><div id="sf-matrix"></div></div>
      <div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title" id="sf-strip-t">Hour by hour</h3><div class="legend" id="sf-strip-leg"></div><div class="chart" id="sf-strip"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">Right now</h3><p class="note cx-card-sub">Latest buoy swell with the model's wind for this hour and the predicted tide.</p><div class="ww-now cx-grow" id="sf-now"></div></div>
      </div>` },
    { id: "windows", title: "Best windows", short: "Windows", class: "pane-swin",
      view: (host, ctx, r) => tierBoard("sf-board", W.waves.windows, windowCard, (k) => go("surf", "windows", k), r.item), html: `
      <p class="note cx-lede">Runs of 2+ daylight hours at C or better over the next 7 days, ranked by the average of their best three hours. Each card carries the backtest for that spot at that lead time: <b>skill</b> is the Heidke score (0 = no better than chance, 1 = perfect) and false alarms are the share of past GO calls that didn't happen.</p>
      <div class="ww-board cx-grow" id="sf-board"></div>` },
    { id: "seasons", title: "When to go", short: "Seasons", class: "pane-sseason",
      view: () => { renderSeasonTable(); renderSeasonLines(); }, html: `
      <div class="card cx-fill"><h3 class="cx-card-title">How often each month delivers</h3><p class="note cx-card-sub">Share of days with 2+ daylight hours of B-or-better <b>swell</b> at the driver buoy (size × period × direction; beach wind isn't in the long record). Click a spot for its months.</p><div id="sf-season"></div></div>
      <div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title">Typical buoy wave height by month</h3><p class="note cx-card-sub">Median daylight Hs at Neah Bay (2004–2026) and La Perouse Bank (1988–2020).</p><div class="chart" id="sf-season-hs"></div></div>
        <div class="card cx-fill prose ww-notes"><h3 class="cx-card-title">Spot notes</h3><ul>
          <li>Jordan River needs a big, long-period westerly to wrap down the strait, so it is a winter spot: summer swell rarely gets in.</li>
          <li>The Tofino beaches face the open Pacific and get usable swell most of the year; summer is smaller but cleaner.</li>
          <li>The La Perouse archive (DFO MEDS) has no wave direction, so Cox Bay and Long Beach come out identical here.</li>
        </ul></div>
      </div>` },
    { id: "spots", title: "Spot rules", short: "Rules", class: "pane-sspots",
      view: (host, ctx, r) => renderSpots(r.item), html: `
      <p class="note cx-lede">Each beach's rule is an editable assumption, not an official surf report (none exists for these beaches). Heights are significant wave height at the driver buoy, the number local surfers watch. Tide and swell preferences are ${LORE}.</p>
      <div class="ww-spots cx-grow" id="sf-spots"></div>` },
  ],
  drawers: {
    week: (host, ctx, item) => dayDrawer(item),
    windows: (host, ctx, item) => windowDrawer(item),
    seasons: (host, ctx, item) => seasonDrawer(item),
    spots: (host, ctx, item) => spotDrawer(item),
  },
};

// ------------------------------------------------------------------ tile: compact spot × day grid in svg
function tileMatrix(host) {
  const keys = KEYS(), days = S()[keys[0]].daily;
  const m = { l: 86, r: 4, t: 4, b: 16 };
  const { g, iw, ih } = frame(host, m, 150);
  const x = d3.scaleBand(days.map((d) => d.date), [0, iw]).padding(0.08);
  const y = d3.scaleBand(keys, [0, ih]).padding(0.12);
  for (const k of keys) {
    g.append("text").attr("class", "axis-t").attr("x", -6).attr("y", y(k) + y.bandwidth() / 2).attr("dy", "0.35em").attr("text-anchor", "end").text(S()[k].name.split(" ")[0]);
    const row = g.append("g").selectAll("g").data(S()[k].daily).join("g").attr("class", "c pick").attr("data-pick", "").style("cursor", "pointer")
      .on("click", (e, d) => { if (d.best != null) go("surf", "week", `${k}:${d.date}`); });
    row.append("rect").attr("x", (d) => x(d.date)).attr("y", y(k)).attr("width", x.bandwidth()).attr("height", y.bandwidth()).attr("rx", 3)
      .style("fill", (d) => (d.best == null ? "var(--surface-2)" : tierCol(d.tier))).style("opacity", (d) => (d.best == null ? 0.6 : 1));
    if (y.bandwidth() > 13) row.append("text").attr("x", (d) => x(d.date) + x.bandwidth() / 2).attr("y", y(k) + y.bandwidth() / 2).attr("dy", "0.35em").attr("text-anchor", "middle")
      .attr("class", (d) => `ww-tier-ink tier-${d.tier}`).style("font-size", "10.5px").style("font-weight", 700).text((d) => d.tier || "");
  }
  g.append("g").selectAll("text").data(days).join("text").attr("class", "axis-t").attr("x", (d) => x(d.date) + x.bandwidth() / 2).attr("y", ih + 12).attr("text-anchor", "middle").text((d) => wd(dayOf(d.date)));
}

// ------------------------------------------------------------------ week
function renderStrip() {
  const k = W.spot, sp = S()[k], F = W.fc.spots[k], T = hours(W.fc);
  $("sf-strip-t").textContent = `Hour by hour · ${sp.name}`;
  $("sf-strip-leg").replaceChildren(
    el("span", { class: "key" }, el("i", { class: "band", style: { background: "var(--t-A)" } }), "score (daylight, coloured by tier)"),
    el("span", { class: "key" }, el("i", { class: "line", style: { background: "var(--surf)" } }), `Hs at buoy ${sp.buoy} (m)`),
    el("span", { class: "key" }, el("i", { class: "line dash", style: { background: "var(--ink-2)" } }), "wind at the beach ÷ 10 (km/h)"));
  hourStrip("sf-strip", T, F.score, F.day, {
    lines: [{ v: F.hs, color: cssVar("--surf"), w: 2 }, { v: F.wspd.map((v) => (v == null ? null : v / 10)), color: cssVar("--ink-2"), dash: "3 3", w: 1.2 }],
    unit: " m",
    pick: (i) => go("surf", "week", `${k}:${ymd(T[i])}`),
    tip: (t, i) => t.append(el("div", { class: "t-title" }, `${sp.name} · ${wd(T[i])} ${hr(T[i])}${F.day[i] ? "" : " (dark)"}`),
      tipRow(tierCol(tierOf(F.score[i])), `${F.score[i] ?? "–"} ${tierOf(F.score[i]) || ""}`, "score"),
      tipRow(cssVar("--surf"), swell(F.hs[i], F.tp[i], F.dir[i]), `at buoy ${sp.buoy}`),
      tipRow(null, swell(F.swh[i], F.swp[i], F.swd[i]), "primary swell"),
      tipRow(null, `${f0(F.wspd[i])} km/h ${compass(F.wdir[i])}`, `wind (offshore from ${compass(sp.offshore_from)})`),
      tipRow(null, F.tide[i] == null ? "–" : `${f1(F.tide[i], " m")}`, "tide")),
  });
}
function renderNow() {
  $("sf-now").replaceChildren(...KEYS().map((k) => {
    const sp = S()[k], n = sp.now;
    if (!n) return el("div", { class: "ww-now-row" }, el("span", { class: "ww-tier tier-none" }, "–"), el("div", {}, el("b", {}, sp.name), el("small", {}, `buoy ${sp.buoy} hasn't reported in over a day`)));
    return el("a", { class: "ww-now-row", href: W.ctx.href("surf", "spots", k) },
      el("span", { class: `ww-tier tier-${n.tier}` }, n.tier),
      el("div", {}, el("b", {}, sp.name.replace(" (Incinerator Rock)", "")),
        el("small", {}, `${swell(n.buoy.hs, n.buoy.tp, n.buoy.dir)} · ${n.wind} ${f0(n.wspd)} km/h · tide ${n.tide || "–"}`),
        el("small", { class: n.buoy.stale ? "ww-stale" : "" }, `buoy ${sp.buoy} ${ago(n.buoy.age_h)}${n.buoy.stale ? " (stale)" : ""}${n.daylight ? "" : " · dark now"}`)));
  }));
}

// ------------------------------------------------------------------ windows
function windowCard(w) {
  return [
    el("div", { class: "ww-card-h" }, el("b", {}, w.name.replace(" (Incinerator Rock)", "")), el("span", { class: "ww-score" }, Math.round(w.score))),
    el("div", { class: "ww-card-t" }, `${span(w.start, w.end)} · ${w.hours} h`),
    el("div", { class: "ww-card-c" }, `${swell(w.hs, w.tp, w.dir)} · ${w.wind}`),
    el("div", { class: "ww-card-c" }, `tide ${w.tide || "–"} · limited by ${w.limiting}`),
    trustChip(w.trust, { extra: el("span", {}, `day ${w.lead_days}`) }),
  ];
}
function windowDrawer(item) {
  const w = findWindow(W.waves.windows, item);
  if (!w) return null;
  const sp = S()[w.spot], F = W.fc.spots[w.spot], T = hours(W.fc);
  const i0 = T.findIndex((t) => +t === +new Date(w.start)), i1 = i0 + w.hours;
  const pk = T.findIndex((t) => +t === +new Date(w.peak_time));
  return {
    kicker: `Surf · ${w.tier}-tier window`, title: `${sp.name}, ${span(w.start, w.end)}`,
    body: [
      dStats([[`${w.tier} · ${Math.round(w.score)}`, "window score (best 3 h)"], [`${w.go_hours} of ${w.hours} h`, "at B or better"],
        [swell(w.hs, w.tp, w.dir), `at buoy ${sp.buoy}, peak ${hr(w.peak_time)}`], [`${f0(w.wspd)} km/h ${w.wind}`, `wind, from ${compass(w.wdir)}`]]),
      dHead(`Forecast trust at day ${w.lead_days}`), trustChip(w.trust),
      dNote(`Backtest of this spot's GO/no-go call made ${w.lead_days} day${w.lead_days === 1 ? "" : "s"} ahead.${smallNote(w.trust?.n_days)}`),
      dChart("dr-win", "Score through the window"),
      dHead(`Why it rates ${w.tier} at its peak`),
      pk >= 0 ? factorBars([["Size", F.f_size[pk], `${f1(F.hs[pk], " m")} (ideal ${sp.rule.size_m[1]}–${sp.rule.size_m[2]} m)`], ["Period", F.f_period[pk], `${f0(F.tp[pk], " s")} (ideal ${sp.rule.period_s[1]} s+)`],
        ["Direction", F.f_dir[pk], `${f0(F.dir[pk], "°")} ${compass(F.dir[pk])} (window ${sp.rule.dir_window.join("–")}°)`], ["Wind", F.f_wind[pk], `${f0(F.wspd[pk])} km/h from ${compass(F.wdir[pk])}`],
        ["Tide", F.f_tide[pk], `${f1(F.tide[pk], " m")} · ${LORE}`]]) : null,
      dNote(`Primary swell ${swell(w.swh, w.swp, w.swd)}. Drive: Victoria ${sp.drive.Victoria}, Vancouver ${sp.drive.Vancouver} (approximate; check DriveBC and BC Ferries).`),
      dLink(W.ctx.href("surf", "week", `${w.spot}:${ymd(w.start)}`), "That day, hour by hour"),
    ],
    after: () => { if (i0 >= 0) miniScore("dr-win", T.slice(Math.max(0, i0 - 3), i1 + 3), F.score.slice(Math.max(0, i0 - 3), i1 + 3), F.day.slice(Math.max(0, i0 - 3), i1 + 3)); },
  };
}

// ------------------------------------------------------------------ day drawer
function dayDrawer(item) {
  const [k, date] = item.split(":");
  const sp = S()[k];
  const d = sp?.daily.find((x) => x.date === date);
  if (!sp || !d) return null;
  W.spot = k;
  const F = W.fc.spots[k], T = hours(W.fc);
  const idx = T.map((t, i) => i).filter((i) => ymd(T[i]) === date);
  const pk = d.best_time ? T.findIndex((t) => +t === +new Date(d.best_time)) : -1;
  const tr = sp.trust[d.lead];
  return {
    kicker: `Surf · ${sp.region}`, title: `${sp.name}, ${dayLong(dayOf(date))}`,
    body: [
      dStats([[d.best == null ? "–" : `${d.tier} · ${Math.round(d.best)}`, "best daylight hour"], [d.best_time ? hr(d.best_time) : "–", "when"],
        [`${d.go_hours ?? 0} h`, "at B or better (GO needs 2)"], [d.go ? "GO" : "no-go", `call made ${d.lead} day${d.lead === 1 ? "" : "s"} ahead`]]),
      trustChip(tr), dNote(`How the GO/no-go call has held up at this lead.${smallNote(tr?.n_days)}`),
      dChart("dr-day", "Score and factors through the day"),
      pk >= 0 ? dHead(`Best hour, ${hr(T[pk])}`) : null,
      pk >= 0 ? factorBars([["Size", F.f_size[pk], `${f1(F.hs[pk], " m")} at ${sp.buoy}`], ["Period", F.f_period[pk], `${f0(F.tp[pk], " s")} peak`],
        ["Direction", F.f_dir[pk], `${compass(F.dir[pk])} ${f0(F.dir[pk], "°")}`], ["Wind", F.f_wind[pk], `${f0(F.wspd[pk])} km/h ${compass(F.wdir[pk])}`], ["Tide", F.f_tide[pk], f1(F.tide[pk], " m")]]) : null,
      pk >= 0 ? dNote(`Primary swell ${swell(F.swh[pk], F.swp[pk], F.swd[pk])}; wind waves ${f1(F.wwh[pk], " m")}. Nearshore model Hs ${f1(F.hs_near[pk], " m")}. ${F.temp[pk] != null ? `Air ${f0(F.temp[pk], "°")}, sea ${f0(F.sst[pk], "°")}.` : ""}`) : null,
      dLink(W.ctx.href("surf", "spots", k), `${sp.name}: rule and notes`),
    ],
    after: () => dayFactors("dr-day", idx.map((i) => T[i]), idx, F),
  };
}
function miniScore(id, T, score, day) {
  const m = { l: 28, r: 8, t: 8, b: 20 };
  const { g, iw, ih } = frame(id, m, 150);
  const x = d3.scaleBand(T, [0, iw]).padding(0.12), y = d3.scaleLinear([0, 100], [ih, 0]);
  gridY(g, y, iw, ih);
  g.selectAll("rect").data(T.map((t, i) => [t, score[i], day[i]])).join("rect").attr("x", ([t]) => x(t)).attr("width", x.bandwidth())
    .attr("y", ([, s]) => y(s ?? 0)).attr("height", ([, s]) => ih - y(s ?? 0)).style("fill", ([, s, dd]) => (dd ? tierCol(tierOf(s)) : "var(--ww-night)"));
  g.append("g").selectAll("text").data(T.filter((t, i) => i % 3 === 0)).join("text").attr("class", "axis-t").attr("x", (t) => x(t) + x.bandwidth() / 2).attr("y", ih + 13).attr("text-anchor", "middle").text((t) => hr(t));
}
function dayFactors(id, T, idx, F) {
  const m = { l: 28, r: 64, t: 8, b: 20 };
  const { g, iw, ih } = frame(id, m, 190);
  const x = d3.scaleBand(T, [0, iw]).padding(0.15), y = d3.scaleLinear([0, 100], [ih, 0]), yf = d3.scaleLinear([0, 1], [ih, 0]);
  gridY(g, y, iw, ih);
  g.selectAll("rect").data(idx).join("rect").attr("x", (i, j) => x(T[j])).attr("width", x.bandwidth()).attr("y", (i) => y(F.score[i] ?? 0)).attr("height", (i) => ih - y(F.score[i] ?? 0))
    .style("fill", (i) => (F.day[i] ? tierCol(tierOf(F.score[i])) : "var(--ww-night)"));
  const fac = [["size", "--surf"], ["period", "--calm"], ["wind", "--ink-2"], ["tide", "--muted"]];
  for (const [f, c] of fac) {
    const pts = idx.map((i, j) => [T[j], F[`f_${f}`][i]]).filter(([, v]) => v != null);
    g.append("path").datum(pts).attr("d", d3.line().x(([t]) => x(t) + x.bandwidth() / 2).y(([, v]) => yf(v))).style("fill", "none").style("stroke", `var(${c})`).style("stroke-width", 1.5).style("opacity", 0.9);
    if (pts.length) g.append("text").attr("class", "label halo").attr("x", iw + 4).attr("y", yf(pts.at(-1)[1])).attr("dy", "0.35em").style("font-size", "10.5px").style("fill", `var(${c})`).text(f);
  }
  g.append("g").selectAll("text").data(T.filter((t, j) => j % 4 === 0)).join("text").attr("class", "axis-t").attr("x", (t) => x(t) + x.bandwidth() / 2).attr("y", ih + 13).attr("text-anchor", "middle").text((t) => hr(t));
}

// ------------------------------------------------------------------ seasons
function renderSeasonTable() {
  const C = W.waves.climatology, sel = W.ctx.route.item;
  const head = el("div", { class: "ww-sz-row ww-sz-head" }, el("span", {}, ""), ...MON.map((m) => el("span", {}, m)));
  const rows = Object.keys(C).map((k) => el("div", { class: `ww-sz-row${sel === k ? " on" : ""}` },
    el("button", { type: "button", class: "ww-sz-name", "data-pick": "", onclick: () => go("surf", "seasons", k) }, el("b", {}, S()[k].name.replace(" (Incinerator Rock)", "")), el("small", {}, `${C[k].years} yrs`)),
    ...C[k].months.map((mo) => el("span", { class: "ww-sz-cell", style: `--v:${mo.go_share ?? 0}`, title: `${MON[mo.m - 1]}: ${pct(mo.go_share)} of days with 2+ h of B+ swell; ${pct(mo.ok_share)} with C+; median Hs ${f1(mo.hs_median, " m")} (${mo.n_days} days)` }, pct(mo.go_share)))));
  $("sf-season").replaceChildren(el("div", { class: "ww-sz" }, head, ...rows));
}
function renderSeasonLines() {
  const C = W.waves.climatology;
  lineChartMonths("sf-season-hs", [
    { name: "Neah Bay", v: C.jordan.months.map((m) => m.hs_median), color: cssVar("--surf") },
    { name: "La Perouse", v: C.chesterman.months.map((m) => m.hs_median), color: cssVar("--calm") }]);
}
function lineChartMonths(id, series) {
  const m = { l: 36, r: 76, t: 10, b: 22 };
  const { g, iw, ih } = frame(id, m, 200);
  const x = d3.scalePoint(d3.range(12), [0, iw]).padding(0.3);
  const y = d3.scaleLinear([0, d3.max(series.flatMap((s) => s.v))], [ih, 0]).nice();
  gridY(g, y, iw, ih, (v) => `${v} m`);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickFormat((i) => MON[i][0]).tickSize(0).tickPadding(6)).call(axisClean);
  for (const s of series) {
    g.append("path").datum(s.v).attr("d", d3.line().x((v, i) => x(i)).y((v) => y(v)).curve(d3.curveMonotoneX)).style("fill", "none").style("stroke", s.color).style("stroke-width", 2.2);
    g.append("text").attr("class", "label halo").attr("x", x(11) + 6).attr("y", y(s.v[11])).attr("dy", "0.35em").style("font-size", "11px").style("fill", s.color).text(s.name);
  }
}
function seasonDrawer(k) {
  const c = W.waves.climatology[k], sp = S()[k];
  if (!c) return null;
  const best = c.months.reduce((a, b) => (b.go_share > a.go_share ? b : a)), worst = c.months.reduce((a, b) => (b.go_share < a.go_share ? b : a));
  return {
    kicker: "Surf · when to go", title: sp.name,
    body: [
      dStats([[MON[best.m - 1], `best month · ${pct(best.go_share)} of days`], [MON[worst.m - 1], `leanest · ${pct(worst.go_share)}`],
        [`${c.years} years`, `${c.days.toLocaleString()} days with buoy data`], [c.direction_scored ? "scored" : "not in archive", "swell direction"]]),
      dChart("dr-season", "Share of days with 2+ h of B+ swell (bars) and C+ (outline)"),
      dNote(`Source: ${c.source}. Swell only: on any given day the wind can still spoil it, so the real share of good days is lower.`),
    ],
    after: () => {
      const m = { l: 34, r: 8, t: 8, b: 20 };
      const { g, iw, ih } = frame("dr-season", m, 190);
      const x = d3.scaleBand(d3.range(12), [0, iw]).padding(0.2), y = d3.scaleLinear([0, 1], [ih, 0]);
      gridY(g, y, iw, ih, d3.format(".0%"));
      g.selectAll("rect.ok").data(c.months).join("rect").attr("class", "ok").attr("x", (d) => x(d.m - 1)).attr("width", x.bandwidth()).attr("y", (d) => y(d.ok_share)).attr("height", (d) => ih - y(d.ok_share))
        .style("fill", "none").style("stroke", "var(--surf)").style("stroke-dasharray", "2 2");
      g.selectAll("rect.go").data(c.months).join("rect").attr("class", "go").attr("x", (d) => x(d.m - 1)).attr("width", x.bandwidth()).attr("y", (d) => y(d.go_share)).attr("height", (d) => ih - y(d.go_share)).style("fill", "var(--surf)");
      g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickFormat((i) => MON[i][0]).tickSize(0).tickPadding(5)).call(axisClean);
    },
  };
}

// ------------------------------------------------------------------ spot rules
function compassSvg(sp) {
  const s = 64, c = s / 2, r = 26, rad = (d) => ((d - 90) * Math.PI) / 180;
  const pt = (d, rr = r) => `${c + rr * Math.cos(rad(d))},${c + rr * Math.sin(rad(d))}`;
  const [lo, hi] = sp.rule.dir_window;
  const wedge = `M${c},${c} L${pt(lo)} A${r},${r} 0 ${hi - lo > 180 ? 1 : 0} 1 ${pt(hi)} Z`;
  const svg = `<svg viewBox="0 0 ${s} ${s}" width="${s}" height="${s}" aria-hidden="true">
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--axis)"/>
    <path d="${wedge}" fill="var(--surf)" opacity=".28"/>
    <line x1="${c}" y1="${c}" x2="${pt(sp.facing, r + 3).split(",")[0]}" y2="${pt(sp.facing, r + 3).split(",")[1]}" stroke="var(--ink)" stroke-width="2"/>
    <path d="M${pt(sp.offshore_from, r + 2)} L${pt(sp.offshore_from, r - 10)}" stroke="var(--calm)" stroke-width="2.4" marker-end="url(#ww-arr)"/>
    <defs><marker id="ww-arr" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="4" markerHeight="4" orient="auto"><path d="M0,0L6,3L0,6Z" fill="var(--calm)"/></marker></defs>
    <text x="${c}" y="9" text-anchor="middle" font-size="8" fill="var(--muted)">N</text></svg>`;
  const t = document.createElement("template"); t.innerHTML = svg; return t.content;
}
function renderSpots(sel) {
  $("sf-spots").replaceChildren(...KEYS().map((k) => {
    const sp = S()[k], r = sp.rule;
    return el("button", { type: "button", class: `card ww-spot${sel === k ? " sel" : ""}`, "data-pick": "", onclick: () => go("surf", "spots", k) },
      el("div", { class: "ww-spot-h" }, compassSvg(sp), el("div", {}, el("b", {}, sp.name), el("small", {}, `${sp.region} · buoy ${sp.buoy} · faces ${compass(sp.facing)}`))),
      el("dl", { class: "ww-rule" },
        el("dt", {}, "Size"), el("dd", {}, `${r.size_m[1]}–${r.size_m[2]} m ideal (${r.size_m[0]}–${r.size_m[3]} m works)`),
        el("dt", {}, "Period"), el("dd", {}, `${r.period_s[1]} s+ ideal, nothing under ${r.period_s[0]} s`),
        el("dt", {}, "Swell"), el("dd", {}, `${r.dir_window[0]}–${r.dir_window[1]}° (${compass(r.dir_window[0])}–${compass(r.dir_window[1])})`),
        el("dt", {}, "Wind"), el("dd", {}, `offshore from ${compass(sp.offshore_from)}`),
        el("dt", {}, "Tide"), el("dd", {}, tideLbl(sp))),
      el("div", { class: "ww-spot-f" }, `Victoria ${sp.drive.Victoria} · Vancouver ${sp.drive.Vancouver}`));
  }));
}
function spotDrawer(k) {
  const sp = S()[k];
  if (!sp) return null;
  const n = sp.now, r = sp.rule, tr1 = sp.trust[1], tr3 = sp.trust[3];
  return {
    kicker: `Surf · ${sp.region} · rule`, title: sp.name,
    body: [
      dStats([[n ? `${n.tier} · ${Math.round(n.score)}` : "–", n ? `now (buoy ${ago(n.buoy.age_h)})` : "no recent buoy reading"], [`${compass(sp.facing)} ${sp.facing}°`, `faces; offshore from ${compass(sp.offshore_from)}`],
        [`skill ${dec(tr1?.hss)} / ${dec(tr3?.hss)}`, "GO/no-go, day 1 / day 3"], [`${pct(tr3?.far)}`, "false alarms at day 3"]]),
      tr1 && tr1.n_days < 60 ? dNote(`Backtest covers only ${tr1.n_days} days (Canadian buoy history online is 30 days): indicative only.`) : null,
      n ? factorBars([["Size", n.factors.size], ["Period", n.factors.period], ["Direction", n.factors.dir], ["Wind", n.factors.wind, n.wind], ["Tide", n.factors.tide, n.tide]]) : null,
      dHead("The rule"),
      dNote(`Size ${r.size_m[0]} → ${r.size_m[1]}–${r.size_m[2]} → ${r.size_m[3]} m at buoy ${sp.buoy} (0 → ideal → 0). Peak period ${r.period_s[0]} s minimum, ${r.period_s[1]} s ideal, best 3 s longer. Swell window ${r.dir_window.join("–")}° with a ${r.dir_taper}° taper. Wind: 1 when light offshore, falling fastest when onshore. Tide: ${tideLbl(sp)}.`),
      dHead("Notes and assumptions"),
      ...sp.notes.map((t) => dNote(t)),
      dLink(W.ctx.href("trust", "spots", k), "How the forecast has scored here"),
    ],
  };
}

export { LORE };
