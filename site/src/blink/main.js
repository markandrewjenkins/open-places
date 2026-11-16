// Public Transit: every region with open transit data, in the shared console (../shared/console.js).
// Inverted pyramid: Overview → topic (key numbers + one main view per sub-topic) → item (detail drawer).
// Network-wide topics for any region: tmap.js (live map), tnext.js (next departures), talerts.js (service alerts),
// tnet.js (network and timetable). Greater Victoria adds Route 95's reliability analysis as a set piece
// (live.js, ontime.js, wait.js, corridor.js, outlook.js, compare.js), shown only when the region is Greater Victoria
// and, inlaid in Open Places, only for Langford, the West Shore and the CRD as a whole (regions.js SPOTLIGHT_PLACES).
// The internal key stays `blink` (folder, data paths, the Route 95 logger), so nothing running breaks.
import { initTheme, initSkin, el } from "../shared/ui.js";
import { createConsole } from "../shared/console.js";
import { T, spotlightOn, regionsGrouped, rememberRegion, loadCore as loadTransit, credits, meta, agencies, live as liveKind } from "./tcommon.js";
import { tmap } from "./tmap.js";
import { tnext } from "./tnext.js";
import { talerts } from "./talerts.js";
import { tnet } from "./tnet.js";
import { B, MIN, thin, pct, loadCore } from "./common.js";
import { live } from "./live.js";
import { ontime } from "./ontime.js";
import { wait } from "./wait.js";
import { corridor } from "./corridor.js";
import { outlook } from "./outlook.js";
import { compare } from "./compare.js";
import { nightRun } from "./skin.js";

initTheme(document.getElementById("theme"));
initSkin(document.getElementById("skin"));

// ------------------------------------------------------------------ region picker (reloads the page for the new region)
const sel = document.getElementById("region");
if (sel) {
  sel.replaceChildren(...regionsGrouped().map(([g, rs]) => el("optgroup", { label: g }, ...rs.map((r) => el("option", { value: r.id }, r.name)))));
  sel.value = T.region.id;
  sel.addEventListener("change", () => {
    rememberRegion(sel.value);
    const q = new URLSearchParams(location.search);
    for (const k of ["region", "place", "at", "name"]) q.delete(k);
    if (sel.value !== "victoria") q.set("region", sel.value);
    location.href = `${location.pathname}${q.toString() ? `?${q}` : ""}#overview`;
  });
}
if (!new URLSearchParams(location.search).get("embed")) rememberRegion(T.region.id);

// Route 95: one overview tile (the set piece) and its deeper views in a rail section of their own
const r95 = {
  ...live, title: "Route 95 · live & timetable", tileTitle: "Route 95 spotlight · Langford ⇄ Downtown", section: "Route 95 spotlight",
  tile: (t, ctx) => {
    live.tile(t, ctx);
    const p = B.blink.headline.punctuality, w = B.blink.headline.wait;
    t.kpis([[`${B.live?.vehicles?.length ?? 0}`, `route 95 buses ${B.live?.realtime ? "live" : "last logged"}`],
      [thin(p.n, MIN.events) ? "collecting" : pct(p.on_time), thin(p.n, MIN.events) ? `on-time share · ${p.n || 0}/${MIN.events} departures so far` : "on time at timepoints"],
      [w.ewt_min == null || thin(w.stop_hours, MIN.stopHours) ? "collecting" : `${w.ewt_min.toFixed(1)} min`, "excess wait vs timetable"]]);
  },
};
const deeper = [ontime, wait, corridor, outlook, compare].map((m) => ({ ...m, noTile: true }));

const about = (spot) => {
  const ag = agencies().map((a) => meta(a));
  return {
    eyebrow: "Public Transit", heading: "About & Methodology", class: "pane-about",
    html: () => `
    <div class="card prose">
      <h3>What it shows</h3>
      <p>Public transit wherever an agency publishes open data that needs no key: where every vehicle is (GTFS-Realtime vehicle positions), what leaves the stops near you next (trip-update predictions, or what the timetable promises), service alerts, and the network itself: every route, how often it runs and when. Pick a region at the top. Inlaid in Open Places, it follows the place you're looking at.</p>
      <p><b>Live data</b> comes through a small relay (a Cloudflare Worker) because transit feeds don't allow web pages to read them directly. It asks each agency at most once every 15–30 seconds however many people are watching, and only for agencies on its list.</p>
      <p><b>Timetables.</b> A daily pipeline downloads each agency's open GTFS schedule (politely: only when it has changed) and keeps a compact summary: the routes and one simplified line per direction, and for every stop the number of departures, first and last times and the usual gap in the peaks, midday and evening on a typical weekday, Saturday and Sunday. Full timetables aren't republished, so "about every 10 min" is an estimate from those gaps, not a scheduled time; live predictions are marked with a dot.</p>
      <p><b>Route 95 spotlight</b> (Greater Victoria, shown for Langford and the West Shore): BC Transit's route 95 Langford / Downtown rapid bus, measured from a log of its real-time feed every 30 seconds: on-time performance, real waits versus the timetable, bunching, where the bus loses time, rain, and four comparison routes. Every figure shows the sample behind it, and thin samples are marked "collecting".</p>
    </div>
    <div class="card prose">
      <h3>Honest limitations</h3>
      <ul>
        <li>Only agencies with keyless feeds are live. TransLink (Vancouver), Sound Transit, Bay Area agencies other than BART (511.org), LA Metro, San Diego MTS and Las Vegas RTC need a key, which is the owner's call; their regions say so.</li>
        <li>Vehicle positions are as reported by each agency, typically 15–60 seconds old. A vehicle whose GPS fails disappears from the map.</li>
        <li>Route colours are the agencies' own where they publish one; icons are generic drawings, not the agencies' vehicles or liveries.</li>
        <li>"Typical" days are dates in the next two weeks with the most service; holidays and special events differ.</li>
        <li>Route 95's history began on 12 November 2026 and is collected on a home PC, so it has gaps.</li>
      </ul>
    </div>
    <div class="card prose">
      <h3>Data sources</h3>
      <ul class="sources">
        ${ag.map((m) => `<li>${m.name || ""}: ${m.credit || ""} <a href="${m.terms || "#"}">Terms</a>. This site is independent and not endorsed by the agency.</li>`).join("")}
        <li>Agency feeds located with the <a href="https://mobilitydatabase.org/">Mobility Database</a> (MobilityData).</li>
        ${spot ? `<li>Route 95: BC Transit GTFS-Realtime, logged; weather <a href="https://open-meteo.com/">Open-Meteo</a> (CC BY 4.0); bus lanes © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> (ODbL)</li>` : ""}
        <li>Basemap © <a href="https://openfreemap.org">OpenFreeMap</a>, © OpenStreetMap contributors</li>
      </ul>
      <p class="note" id="generated"></p>
    </div>`,
  };
};

const ctx = { region: T.region.id };
B.ctx = ctx; T.ctx = ctx;   // one shared context: the console adds route, go, href, refresh, repaint…
loadTransit().then(() => {
  if (sel) sel.value = T.region.id;              // a spot outside the asked-for region may have switched it
  document.title = `Public Transit · ${T.region.name}`;
  const spot = spotlightOn();
  const modules = [tmap, tnext, talerts, tnet, ...(spot ? [r95, ...deeper] : [])];
  if (spot) {
    loadCore().then(() => nightRun()).catch(() => {});
    window.addEventListener("blink-live", () => nightRun());
  }
  const cx = createConsole({
    host: document.getElementById("app"),
    title: "Public Transit",
    kicker: () => `${T.region.name} · ${agencies().map((a) => meta(a).operator || meta(a).name).join(", ")} · ${liveKind() === "rt" ? "live" : liveKind() === "trips" ? "live predictions" : "timetables"}`,
    heading: () => (T.at && T.atName ? `Transit near ${T.atName}` : "Overview"),
    note: T.uncovered ? `${T.uncovered} Showing ${T.region.name} instead; pick another region at the top.` : spot ? "Every vehicle, the next departures near you, service alerts and the network, plus the Route 95 spotlight for Langford and the West Shore. Pick a tile, or a topic in the menu, to go a level deeper."
      : "Every vehicle, the next departures near you, service alerts and the network. Pick a tile, or a topic in the menu, to go a level deeper.",
    modules,
    about: about(spot),
    foot: `<p>${credits().slice(0, 2).join(" ")} This site is independent of every agency.</p><p class="note" id="generated-rail"></p>`,
    ctx,
  });
  const gen = document.getElementById("generated");
  if (gen) gen.textContent = `Timetables built ${new Date(T.index.generated).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}.`;
  void cx;
}).catch((e) => {
  document.getElementById("app").replaceChildren(el("p", { class: "note cx-status" }, `Could not load the network: ${e.message}`));
});
window.addEventListener("skinchange", () => nightRun());
window.addEventListener("transit-live", () => nightRun());
