// Public Transit · Service alerts: what the region's agencies say is disrupted (detours, stop closures, delays),
// from their open GTFS-Realtime alerts feed through the relay, refreshed every two minutes. Regions whose live feed
// needs a key say so instead.
import * as d3 from "d3";
import { el } from "../shared/ui.js";
import { renderBars } from "../shared/charts.js";
import { dStats, dNote, dLink, href } from "../shared/console.js";
import { EFFECT, CAUSE, hasRelay } from "./transit.js";
import { T, $, fmt0, loadCore, loadAlerts, alertActive, badge, plural, clockOf, live, liveNote, tz } from "./tcommon.js";

const key = (a) => `${a.agency}:${a.id}`;
const fDate = (s) => new Date(s * 1000).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz() }).replace(/\s?a\.m\./, " am").replace(/\s?p\.m\./, " pm");
const period = (a) => { const p = a.periods?.find((x) => !x.end || x.end * 1000 > Date.now()) || a.periods?.[0]; if (!p) return "until further notice";
  return p.start && p.start * 1000 > Date.now() ? `from ${fDate(p.start)}${p.end ? ` to ${fDate(p.end)}` : ""}` : p.end ? `until ${fDate(p.end)}` : "until further notice"; };
const title = (a) => a.header || (a.description || "").split(/[.\n]/)[0] || EFFECT[a.effect] || "Service alert";
const sorted = () => T.alerts.slice().sort((a, b) => (alertActive(b) - alertActive(a)) || (b.rs.length ? 1 : 0) - (a.rs.length ? 1 : 0) || title(a).localeCompare(title(b)));
const effects = () => d3.rollups(T.alerts, (v) => v.length, (a) => EFFECT[a.effect] || "Not stated").sort((a, b) => b[1] - a[1]);
const affected = () => new Set(T.alerts.flatMap((a) => a.rs));
const off = () => live() === "static" || !hasRelay();

export const talerts = {
  id: "alerts", title: "Service alerts", tileTitle: "Service alerts", color: "var(--t-alert)",
  eyebrow: "Disruptions", heading: "Service Alerts",
  load: () => loadCore().then(loadAlerts),
  badge: () => (off() || !T.alertsLoaded ? "" : [fmt0(T.alerts.length), "service alerts"]),
  kpis: () => off() ? [["Alerts", "–", "needs the live feed"]] : [["Alerts", fmt0(T.alerts.length), T.alertsAt ? `checked ${clockOf(T.alertsAt)}` : T.alertsErr ? "feed not answering" : "loading…"],
    ["In effect now", fmt0(T.alerts.filter(alertActive).length), "the rest are scheduled"], ["Routes affected", fmt0(affected().size)],
    ["Most common", effects()[0]?.[0] || "–", effects()[0] ? plural(effects()[0][1], "alert") : ""]],
  tile: (t) => {
    if (off()) { t.kpis([["–", live() === "static" ? "alerts need the live feed" : "relay not configured"]]); t.status(""); t.vis.replaceChildren(el("p", { class: "note tr-tilenote" }, liveNote())); return; }
    const A = sorted();
    t.kpis([[T.alertsLoaded ? fmt0(A.length) : "…", "service alerts"], [fmt0(affected().size), "routes affected"]]);
    t.status(T.alertsAt ? "Live" : "");
    const fit = Math.max(2, Math.floor((t.vis.clientHeight || 150) / 24));
    t.vis.replaceChildren(el("ul", { class: "tr-alist mini" }, ...(A.length ? A.slice(0, fit).map((a) => el("li", {}, el("span", { class: "tr-abadges" }, ...a.rs.slice(0, 2).map((r) => badge(r, true))), el("span", {}, title(a))))
      : [el("li", { class: "note" }, T.alertsLoaded ? "No alerts right now." : "Checking…")])));
  },
  subs: [
    { id: "list", title: "All alerts", short: "Alerts", class: "pane-tralerts",
      view: () => renderList(),
      html: `<div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title">Alerts</h3><p class="note cx-card-sub" id="tr-al-sub"></p><ol class="tr-alist cx-grow" id="tr-al"></ol></div>
        <div class="card cx-fill"><h3 class="cx-card-title">By effect</h3><p class="note cx-card-sub">What the agencies say each alert does to service.</p><div class="chart bars" id="tr-al-eff"></div>
          <h3 class="cx-card-title tr-gap">Routes with the most alerts</h3><div class="chart bars" id="tr-al-rt"></div></div>
      </div>` },
  ],
  drawers: {
    list: (host, ctx, item) => {
      const a = T.alerts.find((x) => key(x) === item); if (!a) return null;
      return { kicker: `${EFFECT[a.effect] || "Service alert"}${a.cause && a.cause > 2 ? ` · ${CAUSE[a.cause]}` : ""}`, title: title(a), body: [
        a.rs.length ? el("div", { class: "tr-abadges big" }, ...a.rs.slice(0, 24).map((r) => badge(r))) : null,
        dStats([[alertActive(a) ? "Now" : "Later", period(a)], [fmt0(a.stops.length), "stops named"]]),
        a.description && a.description !== a.header ? el("p", { class: "tr-adesc" }, a.description) : null,
        a.url && /^https?:\/\//.test(a.url) ? el("a", { class: "cx-dlink", href: a.url, target: "_blank", rel: "noopener" }, "The agency's notice ↗") : null,
        dNote("As published in the agency's open GTFS-Realtime alerts feed. Check the agency for the latest before you travel."),
        a.rs[0] ? dLink(href("now", "map", `r:${a.rs[0].agency}:${a.rs[0].id}`), `Route ${a.rs[0].name} on the live map`) : null,
      ] };
    },
  },
};

function renderList() {
  const A = sorted(), sel = T.ctx?.route?.item;
  $("tr-al-sub").textContent = off() ? liveNote() : T.alertsErr ? `The alerts feed isn't answering (${T.alertsErr.message}).` : `${plural(A.length, "alert")} from the open feed, checked ${clockOf(T.alertsAt)}. In effect now first.`;
  $("tr-al").replaceChildren(...(A.length ? A.map((a) => el("li", { class: (sel === key(a) ? "on " : "") + (alertActive(a) ? "" : "later") }, el("a", { href: href("alerts", "list", key(a)) },
    el("span", { class: "tr-abadges" }, ...a.rs.slice(0, 4).map((r) => badge(r, true)), a.rs.length > 4 ? el("small", {}, `+${a.rs.length - 4}`) : null),
    el("b", {}, title(a)), el("small", {}, `${EFFECT[a.effect] || "Alert"} · ${period(a)}`))))
    : [el("li", { class: "note" }, off() ? "No live alerts here." : T.alertsLoaded ? "No alerts right now." : "Checking…")]));
  const E = effects();
  if (E.length) renderBars("tr-al-eff", E.map(([k, v]) => [k, v, k]), "--t-alert", fmt0, 130); else $("tr-al-eff").replaceChildren();
  const R = d3.rollups(T.alerts.flatMap((a) => a.rs), (v) => v.length, (r) => r).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (R.length) renderBars("tr-al-rt", R.map(([r, v]) => [`${r.name}${r.l && r.l !== r.name ? ` ${r.l}` : ""}`.slice(0, 26), v, `${r.agency}:${r.id}`]), "--t-alert", fmt0, 130,
    { pick: (k) => T.ctx.go("now", "map", `r:${k}`) }); else $("tr-al-rt").replaceChildren(el("p", { class: "note" }, "No alert names a route."));
}
