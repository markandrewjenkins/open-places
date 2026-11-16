// Tier list: every well-mapped course scored 0–100 from transparent features (hole length, views, bunkers, water,
// holes, trees, relief, par, minus climb), then cut into S–D tiers by rank within the region. The weight sliders
// re-score and re-tier in the browser with the same formula as pipelines/golf/build.py.
import * as d3 from "d3";
import { el } from "../shared/ui.js";
import { dStats, dNote, dLink, dHead, href } from "../shared/console.js";
import { G, $, fmt0, fmt1, R, REGIONS, FOOTPRINT, clamp01, season, loadCore, TIERS, tierVar, FEATURES, FEATURE_ORDER, featRaw, L, course, ranked,
  regionCourses, setWeights, defaultWeights, isDefaultWeights, scoreOf, tierBadge, route, NOT_MAPPED, osmLinks, P, provisionals, PROV_TIP } from "./common.js";

const go = (...a) => G.ctx.go(...a);
const PRESETS = {
  Default: null,
  Scenic: { views: 5, water: 2.5, trees: 2, relief: 1.5, length: 1.5, bunkers: 0.5, holes: 1, par: 0, climb: -0.5 },
  Championship: { length: 5, bunkers: 3, par: 2, holes: 2, water: 1.5, views: 0.5, trees: 1, relief: 0.5, climb: 0 },
  "Easy walk": { length: 2, views: 1.5, bunkers: 1, water: 1, holes: 1, trees: 1, relief: 0, par: 0.5, climb: -5 },
  "Equal": { length: 1, views: 1, bunkers: 1, water: 1, holes: 1, trees: 1, relief: 1, par: 1, climb: -1 },
};

export const tiers = {
  id: "tiers", title: "Tier list", color: "var(--g-tiers)",
  eyebrow: "Course tier list", heading: "Course Rankings",
  footprint: FOOTPRINT, kind: "only-here",
  relevance: (ctx, date = new Date()) => clamp01(0.3 + 0.45 * season(date)),
  load: loadCore,
  badge: () => { const top = ranked()[0]; return [top ? shortName(top.name) : "", "top-ranked course with your weights"]; },
  kpis: () => {
    const rs = ranked(), top = rs[0], all = regionCourses().filter((c) => c.group === "course");
    const moved = rs.filter((c) => c.tier && L(c.id).tier !== c.tier);
    return [
      ["Top course", top ? shortName(top.name) : "–", top ? `${fmt0(L(top.id).score)} / 100 · S tier` : ""],
      ["Ranked", `${rs.length} of ${all.length}`, provisionals().length ? `+ ${provisionals().length} provisional (holes not mapped)` : "the rest: not enough mapped yet"],
      ["Weights", isDefaultWeights() ? "Default" : "Yours", isDefaultWeights() ? "move a slider to re-rank" : `${moved.length} course${moved.length === 1 ? "" : "s"} changed tier`],
      ["Short courses", String(ranked("short").length), "pitch & putt and par-3, both regions"],
    ];
  },
  tile: (t) => {
    const rs = ranked();
    t.kpis([[rs[0] ? shortName(rs[0].name) : "–", "top of the list"], [`${rs.length}`, `ranked of ${regionCourses().filter((c) => c.group === "course").length} courses`], [String(rs.filter((c) => L(c.id).tier === "S").length), "S-tier"]]);
    const box = el("div", { class: "g-mini-board" }, ...TIERS.map((tr) => el("div", { class: "g-mb-row" }, tierBadge(tr, true),
      el("span", {}, rs.filter((c) => L(c.id).tier === tr).map((c) => shortName(c.name)).join(" · ") || "–"))));
    t.vis.replaceChildren(box);
  },
  subs: [
    { id: "board", title: "Full courses", short: "Courses", class: "pane-tier-board", cols: "minmax(0, 1fr) 290px",
      view: () => { boardView("tr-board", ranked(), "board", false, provisionals()); slidersView(); }, html: `
      <div class="card cx-fill"><h3 class="cx-card-title" id="tr-board-h">Tier list</h3><p class="note cx-card-sub" id="tr-board-sub"></p><div class="g-board cx-grow" id="tr-board"></div></div>
      <div class="card cx-fill g-sliders-card"><h3 class="cx-card-title">Your weights</h3><p class="note cx-card-sub">Drag to say what matters to you; the list re-ranks as you go. Climb counts against.</p>
        <div class="g-presets" id="tr-presets"></div><div class="g-sliders cx-grow" id="tr-sliders"></div></div>` },
    { id: "short", title: "Short & other", short: "Short", class: "pane-tier-short", cols: "minmax(0, 1fr) minmax(0, 0.8fr)",
      view: () => { boardView("tr-short", ranked("short"), "short", true, provisionals("short")); otherView(); }, html: `
      <div class="card cx-fill"><h3 class="cx-card-title">Pitch & putt and par-3 courses</h3><p class="note cx-card-sub">Few enough that they're tiered across both regions together, with short-course yardsticks (60–130 yd holes).</p><div class="g-board cx-grow" id="tr-short"></div></div>
      <div class="card cx-fill"><h3 class="cx-card-title" id="tr-other-h">Also on the map</h3><p class="note cx-card-sub">Not on the tier list as ranked courses: disc golf, driving ranges, and courses without their holes mapped in OpenStreetMap (some with a provisional tier).</p><ul class="g-plain cx-grow" id="tr-other"></ul></div>` },
    { id: "recipe", title: "The recipe", short: "Recipe", class: "pane-tier-recipe", cols: "minmax(0, 1fr) minmax(0, 1.1fr)",
      view: () => { recipeView(); matrixView(); }, html: `
      <div class="card cx-fill"><h3 class="cx-card-title">How a course is scored</h3><div class="cx-grow g-scroll" id="tr-recipe"></div></div>
      <div class="card cx-fill"><h3 class="cx-card-title">The ingredients, course by course</h3><p class="note cx-card-sub">Each feature on its 0–100 yardstick (blank = not mapped). Dashed rows are provisional: measured from the course outline only. Click a course for the detail.</p><div class="cx-grow g-scroll" id="tr-matrix"></div></div>` },
  ],
  drawers: {
    board: (host, ctx, item) => tierDrawer(item),
    short: (host, ctx, item) => tierDrawer(item),
    recipe: (host, ctx, item) => tierDrawer(item),
  },
};

export const shortName = (n) => n.replace(/ (Golf|Golf &|Golf and) (Country Club|Course|Club|Links|Centre|Center)\b.*$/i, "").replace(/ Golf (Course|Club)$/i, "")
  .replace(/^Bear Mountain Resort - /, "Bear Mtn ").replace(/ Golf$/, "").replace(/ Resort & Country Club$/, "");

// ------------------------------------------------------------------ the board
function boardView(id, rs, sub, showRegion, prov = []) {
  const r = route(), sel = r.topic === "tiers" ? r.item : null, custom = !isDefaultWeights();
  if (id === "tr-board") {
    $("tr-board-h").textContent = `${R().name}: ${rs.length} ranked courses${prov.length ? ` + ${prov.length} provisional` : ""}`;
    $("tr-board-sub").textContent = (custom ? "Ranked with your weights. Arrows show the change from the default tier." : "Top 10% S, next 20% A, then B (35%), C (25%) and D. Ranked within the region; click a course for why.")
      + (prov.length ? " Dashed plates are provisional: holes not mapped in OpenStreetMap, estimated from the course outline, no rank number." : "");
  }
  $(id).replaceChildren(...TIERS.map((tr) => {
    const cs = [...rs.filter((c) => L(c.id).tier === tr), ...prov.filter((c) => P(c.id).tier === tr)].sort((a, b) => (L(b.id) || P(b.id)).score - (L(a.id) || P(a.id)).score);
    return el("div", { class: "g-tier-row", style: `--tcol: ${tierVar(tr)}` },
      el("div", { class: "g-tier-l" }, tr),
      el("div", { class: "g-tier-cs" }, ...(cs.length ? cs.map((c) => {
        const pv = P(c.id);
        if (pv) return el("a", { class: `g-plate prov${sel === c.id ? " on" : ""}`, href: href("tiers", sub, c.id), title: `${PROV_TIP}. ${c.name}: about ${fmt0(pv.score)} / 100, estimated from the course outline.` },
          el("span", { class: "g-plate-n", "aria-label": "provisional" }, "≈"), el("span", { class: "g-plate-name" }, shortName(c.name)),
          showRegion ? el("span", { class: "g-plate-r" }, REGIONS[c.region].short) : null,
          el("b", { class: "g-plate-s" }, fmt0(pv.score)));
        const lv = L(c.id), d0 = c.tier, mv = custom && d0 && d0 !== lv.tier ? (TIERS.indexOf(d0) > TIERS.indexOf(lv.tier) ? "up" : "down") : null;
        return el("a", { class: `g-plate${sel === c.id ? " on" : ""}`, href: href("tiers", sub, c.id), title: `${c.name}: ${fmt1(lv.score)} / 100${mv ? ` (default tier ${d0})` : ""}` },
          el("span", { class: "g-plate-n" }, `${lv.rank}`), el("span", { class: "g-plate-name" }, shortName(c.name)),
          showRegion ? el("span", { class: "g-plate-r" }, REGIONS[c.region].short) : null,
          mv ? el("span", { class: `g-mv ${mv}`, "aria-label": mv === "up" ? "moved up" : "moved down" }, mv === "up" ? "▲" : "▼") : null,
          el("b", { class: "g-plate-s" }, fmt0(lv.score)));
      }) : [el("span", { class: "note" }, "–")])));
  }));
}

// ------------------------------------------------------------------ weight sliders (built once, then only repainted, so a drag never breaks)
function slidersView() {
  const host = $("tr-sliders");
  if (!host.dataset.built) {
    host.dataset.built = "1";
    $("tr-presets").replaceChildren(...Object.keys(PRESETS).map((name) => el("button", { type: "button", "data-preset": name, onclick: () => {
      setWeights(PRESETS[name] ? { ...defaultWeights(), ...PRESETS[name] } : defaultWeights()); G.ctx.refresh(); } }, name)));
    host.replaceChildren(...FEATURE_ORDER.map((k) => {
      const input = el("input", { type: "range", min: k === "climb" ? -5 : 0, max: k === "climb" ? 0 : 5, step: 0.25, "data-k": k, "aria-label": `${FEATURES[k]} weight` });
      input.addEventListener("input", () => { setWeights({ ...G.weights, [k]: +input.value }); G.ctx.refresh(); });
      return el("label", { class: "g-slider", title: G.C.feature_notes[k] }, el("span", { class: "g-s-name" }, FEATURES[k]), input, el("b", { "data-v": k }));
    }));
  }
  for (const input of host.querySelectorAll("input")) { const k = input.dataset.k; if (document.activeElement !== input) input.value = G.weights[k]; host.querySelector(`[data-v="${k}"]`).textContent = fmt1(G.weights[k]); }
  const cur = Object.entries(PRESETS).find(([, p]) => { const w = p ? { ...defaultWeights(), ...p } : defaultWeights(); return Object.keys(w).every((k) => Math.abs(w[k] - G.weights[k]) < 1e-9); });
  for (const b of $("tr-presets").children) b.setAttribute("aria-pressed", String(cur?.[0] === b.dataset.preset));
}

// ------------------------------------------------------------------ short & other
function otherView() {
  const cs = regionCourses().filter((c) => !c.ranked).sort((a, b) => (a.group === "other") - (b.group === "other") || b.completeness - a.completeness);
  $("tr-other-h").textContent = `Also on the map in ${R().name}`;
  $("tr-other").replaceChildren(...cs.map((c) => { const pv = P(c.id);
    return el("li", {}, el("a", { href: pv ? href("tiers", c.group === "short" ? "short" : "board", c.id) : href("coverage", "courses", c.id) }, el("span", {}, c.name),
      el("small", {}, c.group === "other" ? (c.kind === "disc_golf" ? "disc golf" : "driving range") : pv ? `provisional ${pv.tier} tier · holes not mapped` : `${c.holes_label} · ${NOT_MAPPED}`))); }));
}

// ------------------------------------------------------------------ recipe
function recipeView() {
  const C = G.C, w = G.weights;
  const ramp = (k) => { const [a, b] = C.ramps[k]; return k === "climb" ? `${a}→${b} m/km` : `${featRaw(k, a)} → ${featRaw(k, b)}`; };
  $("tr-recipe").replaceChildren(
    el("p", { class: "g-p" }, "Each feature is put on a 0–100 yardstick (below the first number = 0, above the second = 100). The score is the weighted average; climb is subtracted. Features a course hasn't mapped drop out and the rest are re-weighted, so a gap doesn't count against it."),
    el("table", { class: "data g-recipe" }, el("thead", {}, el("tr", {}, el("th", {}, "Feature"), el("th", { class: "num" }, "Weight"), el("th", {}, "0 → 100"), el("th", {}, "Measured as"))),
      el("tbody", {}, ...FEATURE_ORDER.map((k) => el("tr", {}, el("td", {}, FEATURES[k]), el("td", { class: "num" }, fmt1(w[k])), el("td", { class: "nowrap" }, ramp(k)), el("td", { class: "note" }, C.feature_notes[k]))))),
    el("p", { class: "g-p" }, `Short courses use their own yardsticks for hole length (${C.ramps_short.length.join("–")} yd) and par (${C.ramps_short.par.join("–")}).`),
    el("p", { class: "g-p" }, el("b", {}, "Views. "), "Measured where golfers stand: from every tee and green, the share of sight lines (30 m Copernicus surface model, out to 6 km, trees and buildings included) that reach the sea or a lake. The course's value is the 90th percentile over its tees and greens, so a few signature holes count, but one lucky tee box doesn't make the course. This replaced an earlier fairway average, which scored almost every inland course near zero. Courses facing a hillside or forest still score low by design: it measures water views, not long views in general."),
    el("p", { class: "g-p" }, el("b", {}, "Who gets ranked. "), `A course needs at least ${Math.round(C.rank_min_completeness * 100)}% mapping completeness in OpenStreetMap (holes 55%, greens 15%, tees, fairways and hazards 10% each). The rest are listed as "${NOT_MAPPED}", never ranked.`),
    el("p", { class: "g-p" }, el("b", {}, "Tiers. "), "By rank within the region: top 10% S, next 20% A, 35% B, 25% C, last 10% D. A tier is relative to the neighbours, not an absolute grade."),
    provisionalRecipe(),
  );
}
function provisionalRecipe() {
  const ck = G.C.provisional_check?.course, cs = G.C.provisional_check?.short;
  if (!ck) return null;
  const n0 = (v) => fmt0(v);
  return el("div", {},
    el("p", { class: "g-p" }, el("b", {}, "Provisional tiers. "), "A course with its outline in OpenStreetMap but too few holes is scored on what the outline alone shows: sea and lake views from a grid of points across it (in place of the tees and greens), tree cover and relief over it, the climb on a back-and-forth walk across it, and the number of holes (tagged, or 18 if it covers 38 ha or more). Hole length, par, bunkers and water in play stay unknown and drop out. That outline-only score is set against the outline-only scores of the fully mapped courses, both regions together, and given the full score at the same place in that order; the tier is where that lands in its region. It gets no rank number, so it never moves a mapped course's rank or tier."),
    el("p", { class: "g-p" }, el("b", {}, "How far to trust it. "), `Run on each of the ${ck.courses} fully mapped courses as if its holes were missing (the others as the yardstick), it was off by ${n0(ck.mae)} points on average (median ${n0(ck.median_abs)}, worst ${n0(ck.max_abs)}), against ${n0(ck.mae_if_average)} for guessing the average for every course. It put the course in the right tier ${n0(ck.same_tier_pct)}% of the time and within one tier ${n0(ck.within_one_tier_pct)}%. Treat a provisional tier as give or take one.`
      + (cs && !cs.used ? ` Short courses get none: ${cs.reason}.` : "")));
}
function matrixView() {
  const rs = ranked(), r = route(), sel = r.topic === "tiers" ? r.item : null;
  const shade = (v) => (v == null ? "transparent" : `color-mix(in oklab, var(--g-tiers) ${Math.round(clamp01(v / 100) * 80)}%, var(--surface))`);
  $("tr-matrix").replaceChildren(el("table", { class: "g-matrix" },
    el("thead", {}, el("tr", {}, el("th", {}, "Course"), ...FEATURE_ORDER.map((k) => el("th", { title: FEATURES[k] }, el("span", {}, FEATURES[k].split(" ")[0]))), el("th", { class: "num" }, "Score"))),
    el("tbody", {}, ...rs.map((c) => el("tr", { class: sel === c.id ? "on" : null },
      el("th", {}, el("a", { href: href("tiers", "recipe", c.id) }, tierBadge(L(c.id).tier, true), el("span", {}, shortName(c.name)))),
      ...FEATURE_ORDER.map((k) => el("td", { style: { background: shade(c.features[k]) }, title: `${FEATURES[k]}: ${featRaw(k, c.feature_raw[k])}` }, c.features[k] == null ? "" : fmt0(c.features[k]))),
      el("td", { class: "num" }, el("b", {}, fmt0(L(c.id).score))))),
      ...provisionals().map((c) => el("tr", { class: `prov${sel === c.id ? " on" : ""}`, title: PROV_TIP },
        el("th", {}, el("a", { href: href("tiers", "recipe", c.id) }, tierBadge(P(c.id).tier, true, true), el("span", {}, shortName(c.name)))),
        ...FEATURE_ORDER.map((k) => el("td", { style: { background: shade(c.features[k]) }, title: c.features[k] == null ? `${FEATURES[k]}: unknown until the holes are mapped` : `${FEATURES[k]}: ${featRaw(k, c.feature_raw[k])} (from the outline)` }, c.features[k] == null ? "" : fmt0(c.features[k]))),
        el("td", { class: "num" }, el("b", {}, `≈${fmt0(P(c.id).score)}`)))))));
}

// ------------------------------------------------------------------ drawer: why a course sits where it does
export function tierDrawer(id) {
  const c = course(id);
  if (!c) return null;
  const lv = L(id), pv = P(id), w = G.weights, f = c.features || {}, links = osmLinks(c);
  const pos = d3.sum(Object.entries(w), ([k, v]) => (f[k] != null && v > 0 ? v : 0)) || 1;
  const rows = (lv || pv || c.score != null ? FEATURE_ORDER : []).filter((k) => f[k] != null).map((k) => ({ k, v: f[k], pts: (w[k] * f[k]) / pos })).sort((a, b) => b.pts - a.pts);
  const where = c.group === "short" ? "short courses, both regions" : `in ${REGIONS[c.region].name}`;
  const between = pv ? (pv.above === 0 ? `above #1 of ${pv.of}` : pv.above >= pv.of ? `below #${pv.of} of ${pv.of}` : `between #${pv.above} and #${pv.above + 1} of ${pv.of}`) : "";
  const unknown = pv ? FEATURE_ORDER.filter((k) => f[k] == null).map((k) => FEATURES[k].toLowerCase()) : [];
  return {
    kicker: lv ? `${lv.tier} tier · #${lv.rank} of ${lv.rankOf} ${where}` : pv ? `${pv.tier} tier, provisional · would sit ${between} ${where}`
      : c.group === "other" ? (c.kind === "disc_golf" ? "Disc golf · listed, not ranked" : "Driving range · listed, not ranked") : `Not ranked · ${NOT_MAPPED}`,
    title: c.name,
    body: [
      c.name_note ? dNote(c.name_note) : null,
      c.name_hint ? el("p", { class: "cx-dnote g-hint" }, el("b", {}, "Hint: "), c.name_hint) : null,
      pv ? el("p", { class: "cx-dnote g-prov-note" }, el("span", { class: "g-prov-tag" }, "Provisional"), " Holes not mapped in OpenStreetMap: this tier is an estimate from the course outline, give or take one tier, and carries no rank number.") : null,
      dStats([[lv ? fmt0(lv.score) : pv ? `≈${fmt0(pv.score)}` : "–", pv ? "estimated score / 100" : "score / 100"], [String(c.holes_expected ?? "–"), pv && c.outline?.holes_from === "area" ? "holes (from area)" : "holes"], [c.yards ? fmt0(c.yards) : "–", "yards mapped"], [c.par && !pv ? `par ${c.par}` : "–", "par (18-hole)"]], true),
      lv && !isDefaultWeights() && c.tier ? dNote(`With the default weights: ${c.tier} tier, ${fmt0(c.score)} / 100.`) : null,
      pv && !isDefaultWeights() && c.tier ? dNote(`With the default weights: provisional ${c.tier} tier, about ${fmt0(c.score)} / 100.`) : null,
      c.kind_note ? dNote(c.kind_note) : null,
      !lv && c.unranked_reason ? dNote(`Why not ranked: ${c.unranked_reason}. Mapping completeness ${Math.round(c.completeness * 100)}%.`) : null,
      !lv && !pv && c.provisional_withheld ? dNote(c.provisional_withheld) : null,
      pv ? dHead("Estimated from the outline") : null,
      pv ? el("ul", { class: "g-plain g-prov-list" },
        el("li", {}, el("b", {}, "Measured from the outline: "), FEATURE_ORDER.filter((k) => f[k] != null).map((k) => `${FEATURES[k].toLowerCase()} ${featRaw(k, c.feature_raw[k])}`).join(" · ")),
        el("li", {}, el("b", {}, "How: "), `views from ${c.outline?.points ?? "a grid of"} points ${c.outline?.spacing_m ? `${fmt0(c.outline.spacing_m)} m apart ` : ""}across the polygon in place of the tees and greens; climb on a back-and-forth walk across it in place of the holes${c.outline?.holes_from === "area" && f.holes != null ? `; ${c.holes_expected} holes guessed from its ${fmt0(c.area_ha)} ha` : ""}.`),
        el("li", {}, el("b", {}, "Unknown until the holes are mapped: "), `${unknown.join(", ")}. They drop out and the other weights are rescaled.`),
        el("li", {}, el("b", {}, "Error: "), `the same method run on the ${G.C.provisional_check.course.courses} fully mapped courses was off by ${fmt0(G.C.provisional_check.course.mae)} points on average and within one tier ${fmt0(G.C.provisional_check.course.within_one_tier_pct)}% of the time.`)) : null,
      rows.length ? dHead(pv ? "What lifts it, what drags it (outline features)" : "What lifts it, what drags it") : null,
      rows.length ? el("ul", { class: "g-fbars" }, ...rows.map(({ k, v, pts }) => el("li", { class: pts < 0 ? "neg" : null },
        el("span", { class: "g-fb-l" }, FEATURES[k]), el("span", { class: "g-fb-raw" }, featRaw(k, c.feature_raw[k])),
        el("span", { class: "g-fb-bar" }, el("i", { style: { width: `${v}%` } })), el("b", {}, `${pts >= 0 ? "+" : "−"}${fmt1(Math.abs(pts))}`)))) : null,
      rows.length ? dNote(pv ? `Bar = the feature on its 0–100 yardstick; the numbers add up to its outline-only score, ${fmt0(pv.outline)}, which sits where a full score of about ${fmt0(pv.score)} sits among the mapped courses.` : "Bar = the feature on its 0–100 yardstick; the number = points it adds to the score with the current weights.") : null,
      c.holes?.length ? dHead(`Hole by hole (${c.holes.length} mapped)`) : null,
      c.holes?.length ? holeTable(c) : null,
      el("div", { class: "g-dlinks" },
        c.holes?.length ? dLink(href("explore", "holes", id), "Plan and profile") : null,
        dLink(href("explore", "map", id), "On the map"),
        G.P.courses[id] ? dLink(href("week", "grid", id), "This week's forecast") : null,
        !lv && c.group !== "other" && !c.not_in_osm ? el("a", { class: "cx-dlink", href: links.edit, target: "_blank", rel: "noopener" }, "Edit in OpenStreetMap ↗") : null,
        el("a", { class: "cx-dlink", href: links.view, target: "_blank", rel: "noopener" }, "OpenStreetMap ↗")),
    ],
  };
}
function holeTable(c) {
  return el("div", { class: "g-holes-wrap" }, el("table", { class: "data g-holes" },
    el("thead", {}, el("tr", {}, ...["#", "Par", "Yd", "Drop m", "Climb m", "Water", "View"].map((h, i) => el("th", { class: i ? "num" : null }, h)))),
    el("tbody", {}, ...c.holes.map((h) => el("tr", {}, el("td", {}, h.ref ?? "–"), el("td", { class: "num" }, h.par ?? "–"), el("td", { class: "num" }, h.yd ?? "–"),
      el("td", { class: "num" }, h.drop == null ? "–" : (h.drop > 0 ? "↓" : h.drop < 0 ? "↑" : "") + fmt0(Math.abs(h.drop))), el("td", { class: "num" }, h.climb == null ? "–" : fmt0(h.climb)),
      el("td", { class: "num" }, h.water ? "●" : ""), el("td", { class: "num" }, h.view_tee == null ? "–" : `${Math.round(100 * Math.max(h.view_tee, h.view_green))}%`))))));
}
