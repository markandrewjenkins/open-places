// This week: playable daylight hours for every course over the next seven days, from Open-Meteo's hourly forecast run
// through the playable-hour rules (rain, wind, gusts, cold, frost delay, daylight). Day cards → course × day grid →
// hour by hour; a day or a course opens its detail in the drawer.
import * as d3 from "d3";
import { el } from "../shared/ui.js";
import { dStats, dChart, dNote, dLink, dHead, href } from "../shared/console.js";
import { G, $, tip, fmt0, fmt1, fH, day, fDay, fDayLong, fDow, hhmm, R, FOOTPRINT, clamp01, season, weekGood, loadCore, regionCourses, forecastOf,
  regionDays, goodRegionDay, weekCols, comfortHeat, comfortLegend, course, L, P, tierBadge, courseBadge, regionOf, route, days } from "./common.js";

const go = (...a) => G.ctx.go(...a);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const roundName = { 18: "18 holes, 4½ h", 9: "9 holes, 2¼ h", short: "pitch & putt, 1½ h" };
const verdict = (rd) => (goodRegionDay(rd) ? "Good day" : rd.median >= rd.daylight * 0.4 ? "Mixed" : "Washout");

export const week = {
  id: "week", title: "This week", color: "var(--g-week)",
  eyebrow: "Playability forecast", heading: "Playable Hours This Week",
  footprint: FOOTPRINT, kind: "only-here",
  // Civic Atlas: matters most in the dry season and when this week actually has good golf days
  relevance: (ctx, date = new Date()) => clamp01(0.15 + 0.35 * season(date) + 0.5 * weekGood()),
  load: loadCore,
  badge: () => { const rd = regionDays(); return [`${rd.filter(goodRegionDay).length} of ${rd.length}`, "good golf days ahead"]; },
  kpis: () => {
    const rd = regionDays(), best = rd.reduce((a, b) => (b.median > a.median ? b : a)), good = rd.filter(goodRegionDay);
    const frost = rd.filter((d_) => d_.frost >= 0.5), wet = rd.reduce((a, b) => (b.rain > a.rain ? b : a));
    return [
      ["Best day", fDay(day(best.date)), `${fH(best.median)} playable, typical course`],
      ["Good golf days", `${good.length} of ${rd.length}`, good.length ? good.map((d_) => fDow(day(d_.date))).join(" · ") : "none this week"],
      ["Frost delays", frost.length ? `${frost.length} day${frost.length > 1 ? "s" : ""}` : "None", frost.length ? `first tee ~${frostLbl(frost[0].frostUntil)} ${fDow(day(frost[0].date))}` : "no frosty mornings forecast"],
      ["Wettest", wet.rain >= 1 ? fDow(day(wet.date)) : "Dry week", wet.rain >= 1 ? `${fmt0(wet.rain)} mm` : "under 1 mm any day"],
    ];
  },
  tile: (t) => {
    const rd = regionDays(), good = rd.filter(goodRegionDay), best = rd.reduce((a, b) => (b.median > a.median ? b : a));
    t.kpis([[`${good.length} of ${rd.length}`, "good golf days ahead"], [fDow(day(best.date)), `best day, ${fH(best.median)}`], [fH(d3.sum(rd, (d_) => d_.median)), "playable this week"]]);
    weekCols(t.vis, rd.map((d_) => ({ ...d_, value: d_.median, good: goodRegionDay(d_) })), { bw: 30, pick: (r) => go("week", "days", r.date) });
  },
  subs: [
    { id: "days", title: "Day by day", short: "Days", class: "pane-wk-days", rows: "auto minmax(0, 1fr)",
      view: () => renderDays(), html: `
      <div class="g-days" id="wk-days"></div>
      <div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title">Playable daylight hours, typical course</h3>
          <p class="note cx-card-sub" id="wk-chart-sub">Median course in the region; the whisker spans the best and worst course. ⛳ = a good golf day: at least 75% of daylight playable for most courses.</p>
          <div class="chart" id="wk-chart"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title" id="wk-best-h">Best tee times</h3><p class="note cx-card-sub" id="wk-best-sub"></p><ol class="g-list cx-grow" id="wk-best"></ol></div>
      </div>` },
    { id: "grid", title: "Course × day", short: "Courses", class: "pane-wk-grid",
      view: () => renderGrid(), html: `
      <div class="card cx-fill"><h3 class="cx-card-title">Playable hours per course, per day</h3>
        <p class="note cx-card-sub">Daylight hours playable at each course; darker = more of the day playable, a bar on top = a good golf day (75%+ playable). Click a course or a day.</p>
        <div class="g-grid cx-grow" id="wk-grid"></div></div>` },
    { id: "hours", title: "Hour by hour", short: "Hours", class: "pane-wk-hours", rows: "minmax(0, 1.25fr) minmax(0, 1fr)",
      view: (host, ctx, r) => renderHours(r), html: `
      <div class="card cx-fill"><div class="g-card-head"><div><h3 class="cx-card-title" id="wk-h-title">Hour by hour</h3><p class="note cx-card-sub" id="wk-h-sub"></p></div>
        <label class="g-pick">Course <select id="wk-h-course"></select></label></div>
        <div class="chart" id="wk-h-heat"></div><div id="wk-h-legend"></div></div>
      <div class="card cx-fill"><h3 class="cx-card-title">Lost hours by cause</h3><p class="note cx-card-sub">Each lost daylight hour goes to the rule that hurts it most.</p><div class="legend" id="wk-why-legend"></div><div class="chart" id="wk-why"></div></div>` },
  ],
  drawers: {
    days: (host, ctx, item) => (isDate(item) ? dayDrawer(item, "days") : courseDrawer(item)),
    grid: (host, ctx, item) => (isDate(item) ? dayDrawer(item, "grid") : courseDrawer(item)),
  },
};

const frostLbl = (h) => (h == null ? "–" : `${h % 12 || 12} ${h < 12 ? "am" : "pm"}`);
const selDate = () => { const r = route(); return r.topic === "week" && isDate(r.item) ? r.item : null; };

// ------------------------------------------------------------------ day by day
function renderDays() {
  const rd = regionDays(), sel = selDate(), best = rd.reduce((a, b) => (b.median > a.median ? b : a));
  $("wk-days").replaceChildren(...rd.map((d_) => {
    const v = verdict(d_);
    return el("a", { class: `g-day${sel === d_.date ? " on" : ""}`, href: href("week", "days", d_.date), "data-v": v },
      el("span", { class: "g-day-n" }, fDay(day(d_.date))),
      el("b", { class: "g-day-h" }, fmt1(d_.median), el("small", {}, " h")),
      el("span", { class: "g-day-v" }, v === "Good day" ? "⛳ Good day" : v),
      el("span", { class: "g-day-wx" }, `${Math.round(d_.tmax)}° / ${Math.round(d_.tmin)}°${d_.rain >= 1 ? ` · ${fmt0(d_.rain)} mm` : " · dry"}${d_.frost >= 0.5 ? ` · frost to ${frostLbl(d_.frostUntil)}` : ""}`));
  }));
  weekCols("wk-chart", rd.map((d_) => ({ ...d_, value: d_.median, good: goodRegionDay(d_) })), { axis: true, range: true, wx: true, long: true, labels: true, selected: sel,
    pick: (r) => go("week", "days", r.date),
    tip: (r) => [el("div", { class: "t-row" }, el("b", {}, fH(r.median)), el("span", {}, `typical course, of ${fH(r.daylight)} daylight`)),
      el("div", { class: "t-row" }, el("b", {}, `${fH(r.min)}–${fH(r.max)}`), el("span", {}, "worst to best course")),
      el("div", { class: "t-row" }, el("b", {}, `${r.goodN} of ${r.n}`), el("span", {}, "courses with a good day"))] });
  const target = rd.find((d_) => d_.date === sel) || best;
  $("wk-best-h").textContent = `Best tee times, ${fDayLong(day(target.date))}`;
  $("wk-best-sub").textContent = `Longest stretch fit for a round, per course. ${sel ? "" : "Showing the best day; pick another above."}`;
  $("wk-best").replaceChildren(...bestOn(target.k).slice(0, 12).map(({ c, f }) => courseRow(c, f.days[target.k], "days")));
}
function bestOn(k) {
  return regionCourses().filter((c) => c.group !== "other").map((c) => ({ c, f: forecastOf(c.id) })).filter((x) => x.f)
    .sort((a, b) => b.f.days[k].playable_h - a.f.days[k].playable_h || (L(b.c.id)?.score ?? -1) - (L(a.c.id)?.score ?? -1));
}
function courseRow(c, d_, sub) {
  const lv = L(c.id);
  return el("li", {}, el("a", { href: href("week", sub, c.id) },
    courseBadge(c.id, true), el("span", { class: "g-l-name" }, c.name),
    el("span", { class: "g-l-win" }, d_.best_start ? `${hhmm(d_.best_start)}–${hhmm(d_.best_end)}` : "no window"),
    el("b", {}, fH(d_.playable_h))));
}

// ------------------------------------------------------------------ course × day grid
function renderGrid() {
  const ds = regionDays(), r = route(), sel = r.topic === "week" ? r.item : null;
  const rows = regionCourses().filter((c) => c.group !== "other").map((c) => ({ c, f: forecastOf(c.id) })).filter((x) => x.f)
    .sort((a, b) => b.f.week - a.f.week || (L(b.c.id)?.score ?? -1) - (L(a.c.id)?.score ?? -1));
  const shade = (s) => `color-mix(in oklab, var(--g-good) ${Math.round(clamp01(s) * 78)}%, var(--surface))`;
  const table = el("table", { class: "g-table" },
    el("thead", {}, el("tr", {}, el("th", { class: "g-t-name" }, "Course"),
      ...ds.map((d_) => el("th", { class: sel === d_.date ? "on" : null }, el("a", { href: href("week", "grid", d_.date) }, fDow(day(d_.date)), el("small", {}, day(d_.date).getDate())))),
      el("th", { class: "num" }, "Week"))),
    el("tbody", {}, ...rows.map(({ c, f }) => el("tr", { class: sel === c.id ? "on" : null, "data-id": c.id },
      el("th", { class: "g-t-name" }, el("a", { href: href("week", "grid", c.id) }, courseBadge(c.id, true), el("span", {}, c.name))),
      ...f.days.map((d_) => el("td", { class: d_.good ? "good" : null, style: { background: shade(d_.share) }, title: `${fDay(day(d_.date))}: ${fH(d_.playable_h)} of ${fH(d_.daylight_h)} daylight${d_.best_start ? `, best ${hhmm(d_.best_start)}–${hhmm(d_.best_end)}` : ""}` },
        fmt1(d_.playable_h))),
      el("td", { class: "num" }, fmt0(f.week))))));
  table.addEventListener("click", (e) => { if (e.target.closest("a")) return; const tr = e.target.closest("tr[data-id]"); if (tr) go("week", "grid", tr.dataset.id); });
  $("wk-grid").replaceChildren(table);
  const on = $("wk-grid").querySelector("tr.on");
  if (on) on.scrollIntoView({ block: "nearest" });
}

// ------------------------------------------------------------------ hour by hour
function renderHours(r) {
  const cs = regionCourses().filter((c) => c.group !== "other" && G.P.courses[c.id]);
  let id = r.item && regionOf(r.item) === G.region && G.P.courses[r.item] ? r.item : null;
  if (!id) id = (cs.filter((c) => L(c.id)).sort((a, b) => L(b.id).score - L(a.id).score)[0] || cs[0]).id;
  const c = course(id), f = forecastOf(id);
  const sel = $("wk-h-course");
  if (sel.dataset.region !== G.region) {
    sel.replaceChildren(...[...cs].sort((a, b) => a.name.localeCompare(b.name)).map((x) => el("option", { value: x.id }, x.name)));
    sel.dataset.region = G.region;
    sel.onchange = () => go("week", "hours", sel.value);
  }
  sel.value = id;
  $("wk-h-title").textContent = c.name;
  $("wk-h-sub").textContent = `Comfort per daylight hour from the forecast grid point ${fmt1(distKm(c, f.pt))} km away. Playable = comfort of at least 50%. ${f.good} good golf day${f.good === 1 ? "" : "s"}, ${fH(f.week)} playable this week.`;
  comfortHeat("wk-h-heat", f.pt);
  $("wk-h-legend").replaceChildren(comfortLegend());
  whyLost("wk-why", f.pt);
}
const distKm = (c, p) => Math.hypot((c.lon - p.lon) * 73.6, (c.lat - p.lat) * 111.2);

const CAUSES = [["rain", "Rain", "--g-rain"], ["wind", "Wind & gusts", "--g-wind"], ["cold", "Cold", "--g-cold"], ["frost", "Frost delay", "--g-frost"]];
function whyLost(target, pt) {
  const rules = G.P.model.rules, ramp = (v, a, b) => clamp01((v - a) / (b - a));
  const rows = days().map((date, k) => {
    const out = { date, rain: 0, wind: 0, cold: 0, frost: 0, ok: 0 };
    for (let h = 0; h < 24; h++) {
      const i = (k + G.d0) * 24 + h, dl = pt.daylight[i];
      if (dl <= 0) continue;
      if (pt.comfort[i] >= 50) { out.ok += dl; continue; }
      if (pt.frost[i]) { out.frost += dl; continue; }
      const s = { rain: ramp(pt.precip[i], rules.rain_mm[0], rules.rain_mm[1]), wind: Math.max(ramp(pt.wind[i], ...rules.wind_kmh), ramp(pt.gust[i], ...rules.gust_kmh)), cold: ramp(-pt.temp[i], -rules.temp_c[0], -rules.temp_c[1]) };
      const worst = Object.entries(s).sort((a, b) => b[1] - a[1])[0];
      out[worst[1] > 0 ? worst[0] : "rain"] += dl;
    }
    return out;
  });
  $("wk-why-legend").replaceChildren(...CAUSES.map(([, n, v]) => el("span", { class: "key" }, el("i", { class: "band", style: { background: `var(${v})` } }), n)),
    el("span", { class: "key" }, el("i", { class: "band", style: { background: "var(--g-good)", opacity: 0.35 } }), "playable"));
  const host = $(target), m = { l: 34, r: 8, t: 6, b: 20 };
  const W = Math.max(160, host.clientWidth), H = Math.max(60, host.clientHeight || 150);
  host.replaceChildren();
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H);
  const g = svg.append("g").attr("transform", `translate(${m.l},${m.t})`), iw = W - m.l - m.r, ih = H - m.t - m.b;
  const x = d3.scaleBand(rows.map((r) => r.date), [0, iw]).padding(0.3);
  const y = d3.scaleLinear([0, d3.max(rows, (r) => r.ok + r.rain + r.wind + r.cold + r.frost) || 9], [ih, 0]).nice();
  g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(3)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(3).tickFormat((v) => `${v} h`).tickSize(0).tickPadding(6)).call((a) => a.select(".domain").remove());
  const keys = ["frost", "cold", "wind", "rain", "ok"], col = { ...Object.fromEntries(CAUSES.map(([k, , v]) => [k, `var(${v})`])), ok: "var(--g-good)" };
  const stack = d3.stack().keys(keys)(rows);
  g.selectAll("g.s").data(stack).join("g").attr("class", "s").style("fill", (s) => col[s.key]).style("opacity", (s) => (s.key === "ok" ? 0.35 : 1))
    .selectAll("rect").data((s) => s).join("rect").attr("x", (d_) => x(d_.data.date)).attr("width", x.bandwidth()).attr("y", (d_) => y(d_[1])).attr("height", (d_) => Math.max(0, y(d_[0]) - y(d_[1])))
    .on("pointermove", (e, d_) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, fDayLong(day(d_.data.date))),
      ...[["ok", "playable"], ...CAUSES.map(([k, n]) => [k, `lost to ${n.toLowerCase()}`])].filter(([k]) => d_.data[k] > 0.05)
        .map(([k, n]) => el("div", { class: "t-row" }, el("i", { class: "t-key", style: { background: col[k] } }), el("b", {}, fH(d_.data[k])), el("span", {}, n))))))
    .on("pointerleave", () => tip.hide());
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickFormat((d_) => fDow(day(d_))).tickSize(0).tickPadding(6)).call((a) => a.select(".domain").remove());
}

// ------------------------------------------------------------------ drawers
function dayDrawer(date, sub) {
  const rd = regionDays().find((d_) => d_.date === date);
  if (!rd) return null;
  const list = bestOn(rd.k);
  return {
    kicker: `${R().name} · ${verdict(rd)}`, title: fDayLong(day(date)),
    body: [
      dStats([[fH(rd.median), `playable, typical course (of ${fH(rd.daylight)} daylight)`], [`${rd.goodN} of ${rd.n}`, "courses with a good golf day"],
        [`${Math.round(rd.tmax)}° / ${Math.round(rd.tmin)}°`, rd.rain >= 1 ? `${fmt0(rd.rain)} mm rain` : "dry"],
        [rd.frost >= 0.5 ? frostLbl(rd.frostUntil) : "No", rd.frost >= 0.5 ? "frost delay until about" : "frost delay"]]),
      rd.soggy >= 0.5 ? dNote("Over 15 mm fell in the previous 24 hours: expect soft, cart-path-only conditions even when it's dry.") : null,
      dHead("Longest playable stretch per course"),
      el("ol", { class: "g-list g-list-dr" }, ...list.slice(0, 15).map(({ c, f }) => courseRow(c, f.days[rd.k], sub))),
      dLink(href("week", "grid"), "Every course, every day"),
    ],
  };
}
export function courseDrawer(id) {
  const c = course(id), f = c && forecastOf(id);
  if (!c || !f) return null;
  const lv = L(id), best = f.days.reduce((a, b) => (b.playable_h > a.playable_h ? b : a));
  return {
    kicker: `${lv ? `${lv.tier} tier · ` : P(id) ? `${P(id).tier} tier (provisional) · ` : ""}${c.holes_label || ""} · forecast`, title: c.name,
    body: [
      dStats([[fH(f.week), "playable daylight this week"], [`${f.good} of ${f.days.length}`, "good golf days"], [fDow(day(best.date)), `best day, ${fH(best.playable_h)}`], [roundName[f.round] || f.round, "round length used"]]),
      dChart("dr-wk-heat", "Comfort by hour (hover for the weather)"),
      el("ul", { class: "g-dlist" }, ...f.days.map((d_) => el("li", { class: d_.good ? "good" : null },
        el("span", {}, fDay(day(d_.date))), el("b", {}, fH(d_.playable_h)),
        el("span", {}, d_.best_start ? `best ${hhmm(d_.best_start)}–${hhmm(d_.best_end)}` : "no round-length window"),
        el("span", { class: "g-flags" }, [d_.good ? "⛳" : "", d_.frost_until ? `frost to ${hhmm(d_.frost_until)}` : "", d_.soggy ? "soggy" : "", d_.rain_mm >= 1 ? `${fmt0(d_.rain_mm)} mm` : ""].filter(Boolean).join(" · "))))),
      dNote(`Forecast grid point ${fmt1(distKm(c, f.pt))} km from the course. Hours are daylight hours (sunrise + 20 min to sunset − 20 min) where the rules give a comfort of at least 50%.`),
      el("div", { class: "g-dlinks" }, dLink(href("week", "hours", id), "Hour by hour"), lv || c.ranked || P(id) ? dLink(href("tiers", c.group === "short" ? "short" : "board", id), "Tier list entry") : null,
        dLink(href("explore", "map", id), "On the map")),
    ],
    after: () => comfortHeat("dr-wk-heat", f.pt, { compact: true }),
  };
}
