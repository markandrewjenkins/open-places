// Notices: the Canadian Coast Guard's navigational warnings (NAVWARNs, which replaced Notices to Shipping) for the
// Pacific, from the CCG's weekly S-124 trial data set. Trial data: "not operational or official", so every view says so.
import * as d3 from "d3";
import { el } from "../shared/ui.js";
import { renderBars } from "../shared/charts.js";
import { dStats, dNote, dLink, href } from "../shared/console.js";
import { W, $, fmt0, fDay, fDate, REGIONS, loadCore } from "./common.js";
import { focusNotice } from "./water.js";

const BOX = { victoria: [-124.1, 48.1, -122.9, 48.95], vancouver: [-123.6, 48.95, -121.8, 49.45] };
const S = { scope: "here", kind: null };
const inBox = (n, b) => n.lon != null && n.lon >= b[0] && n.lon <= b[2] && n.lat >= b[1] && n.lat <= b[3];
const all = () => W.notices?.notices || [];
function list() {
  const b = BOX[W.region];
  let L = S.scope === "here" && b ? all().filter((n) => inBox(n, b)) : S.scope === "home" ? all().filter((n) => n.home) : all();
  if (S.kind) L = L.filter((n) => (n.kind || n.title) === S.kind);
  return L;
}
const age = (n) => Math.round((Date.now() - new Date(n.published || n.start)) / 864e5);
const fresh = (n) => age(n) <= 14;
const active = (n) => !n.end || new Date(`${n.end}T23:59`) >= new Date();

export const notices = {
  id: "notices", title: "Notices", tileTitle: "Coast Guard notices", color: "var(--t-notice)",
  eyebrow: "Canadian Coast Guard navigational warnings", heading: "Marine Hazards",
  load: () => loadCore(),
  badge: () => { const L = all().filter((n) => BOX[W.region] && inBox(n, BOX[W.region])); return [`${L.length}`, `NAVWARNs in force around ${REGIONS[W.region].short}`]; },
  kpis: () => {
    const L = list(), recent = L.filter(fresh);
    const top = d3.rollups(L, (v) => v.length, (n) => n.kind || n.title).sort((a, b) => b[1] - a[1])[0];
    return [["In force", fmt0(L.length), S.scope === "here" && BOX[W.region] ? `around ${REGIONS[W.region].short}` : S.scope === "home" ? "home waters" : "all BC coast and inland"],
      ["New in 2 weeks", fmt0(recent.length), recent[0] ? `latest ${fDay(recent[0].published.slice(0, 10))}` : ""],
      ["Most common", top ? top[0] : "–", top ? `${top[1]} notices` : ""],
      ["Data set", W.notices?.dataset_modified ? fDay(new Date(W.notices.dataset_modified).toISOString().slice(0, 10)) : "–", "CCG S-124 trial, weekly"]];
  },
  tile: (t) => {
    const b = BOX[W.region], L = b ? all().filter((n) => inBox(n, b)) : all().filter((n) => n.home);
    t.kpis([[fmt0(L.length), `notices in force around ${REGIONS[W.region].short}`], [fmt0(L.filter(fresh).length), "new in the last two weeks"]]);
    t.status(W.notices ? `Weekly · ${fDay(new Date(W.notices.dataset_modified || W.notices.generated).toISOString().slice(0, 10))}` : "");
    t.vis.replaceChildren(el("ol", { class: "ww-nlist mini" }, ...L.slice(0, 6).map((n) => el("li", {}, el("a", { href: href("notices", "list", n.id) },
      el("b", {}, n.kind || n.title), el("span", {}, `${n.area} · ${fDay((n.published || n.start || "").slice(0, 10))}`))))));
  },
  subs: [
    { id: "list", title: "Notices in force", short: "List", class: "pane-wwnotices",
      view: (host, ctx, route) => renderList(route),
      html: `<div class="cx-row cols-13-1">
        <div class="card cx-fill"><div class="ww-nhead"><h3 class="cx-card-title">Notices in force</h3><div class="seg" id="ww-nscope"></div></div><p class="note cx-card-sub" id="ww-nsub"></p><ol class="ww-nlist cx-grow" id="ww-nlist"></ol></div>
        <div class="card cx-fill"><h3 class="cx-card-title">By topic</h3><p class="note cx-card-sub">Click a kind to filter the list. Many are long-lived: wrecks and moorings stay in force until cleared.</p><div class="chart" id="ww-nkinds"></div></div>
      </div>` },
  ],
  drawers: {
    list: (host, ctx, item) => {
      const n = all().find((x) => x.id === item); if (!n) return null;
      return { kicker: `NAVWARN ${n.id.replace("-", "/")} · ${n.area}`, title: n.kind || n.title, body: [
        dStats([[n.start ? fDay(n.start) : "–", "in force from"], [n.end ? fDay(n.end) : "until cancelled", "until"], [n.chart || "–", "chart"], [n.general || n.title, "category"]]),
        n.text ? el("p", { class: "ww-ntext" }, n.text) : null,
        n.aton?.length ? dNote(`Aid to navigation: ${n.aton.join("; ")}.`) : null,
        n.publication ? dNote(`Chart area: ${n.publication}.`) : null,
        n.lon != null ? el("a", { class: "cx-dlink", href: href("water", "map"), onclick: () => focusNotice(n) }, "Show on the map →") : null,
        dNote(`Published ${fDate((n.published || "").slice(0, 10))}. From the Canadian Coast Guard's S-124 trial data set, which the Coast Guard says is not operational or official: check the official NAVWARN search before relying on it.`),
        el("a", { class: "cx-dlink", href: "https://nis.ccg-gcc.gc.ca/public/rest/messages/en/search", target: "_blank", rel: "noopener" }, "Official NAVWARN search ↗"),
      ] };
    },
  },
};

function renderList(route) {
  const scopes = [["here", `Around ${REGIONS[W.region].short}`], ["home", "Home waters"], ["all", "All Pacific"]].filter(([k]) => k !== "here" || BOX[W.region]);
  if (!scopes.some(([k]) => k === S.scope)) S.scope = scopes[0][0];
  $("ww-nscope").replaceChildren(...scopes.map(([k, l]) => el("button", { type: "button", "aria-pressed": String(S.scope === k), onclick: () => { S.scope = k; S.kind = null; W.ctx.refresh(); } }, l)));
  const L = list();
  $("ww-nsub").textContent = `${fmt0(L.length)} notice${L.length === 1 ? "" : "s"}${S.kind ? ` about "${S.kind}"` : ""}, newest first.${W.region === "seattle" ? " Canadian notices only: US Coast Guard Local Notices to Mariners aren't wired in yet." : ""} Bold = new in the last two weeks.`;
  $("ww-nlist").replaceChildren(...L.map((n) => el("li", { class: [fresh(n) ? "new" : "", route.item === n.id ? "on" : "", active(n) ? "" : "ended"].join(" ").trim() || null },
    el("a", { href: href("notices", "list", n.id) }, el("b", {}, n.kind || n.title), el("span", {}, n.text ? n.text.slice(0, 140) + (n.text.length > 140 ? "…" : "") : n.title),
      el("small", {}, `${n.area} · ${fDay((n.published || n.start || "").slice(0, 10))}${n.end ? ` – ${fDay(n.end)}` : ""}`)))));
  const base = S.scope === "here" && BOX[W.region] ? all().filter((n) => inBox(n, BOX[W.region])) : S.scope === "home" ? all().filter((n) => n.home) : all();
  const kinds = d3.rollups(base, (v) => v.length, (n) => n.kind || n.title).sort((a, b) => b[1] - a[1]).slice(0, 12);
  renderBars("ww-nkinds", kinds.map(([k, v]) => [k, v, k]), "--t-notice", fmt0, 210, { selected: S.kind, pick: (k) => { S.kind = S.kind === k ? null : k; W.ctx.refresh(); } });
}
