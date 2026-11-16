// Local civic feeds for Open Places (Greater Victoria): council meetings and police news releases.
// None of these upstreams send CORS headers, so the relay reads them, keeps headline + date + link only (no release text,
// no images), and caches the answer per Cloudflare location (police 15 min, meetings 1 h). Police headlines go through
// redactHeadline() (site/src/shared/redact-names.js, bundled by wrangler): names of missing people, suspects, accused and
// victims are taken out; the link to the original release stays.
//
// Routes:
//   /local/meetings.json?org=langford   upcoming + recent council/committee meetings (eSCRIBE public calendar)
//   /local/police.json                  police news releases from the Greater Victoria agencies, newest first
//
// Terms (headlines + links, credited, no marks):
//   City of Langford: "You may download, store in cache, display, print and copy … in unaltered form only"
//     (https://langford.ca/disclaimer/); meetings are the City's public calendar on eSCRIBE.
//   RCMP: non-commercial reproduction with attribution (https://rcmp.ca/en/terms-and-conditions); no RCMP badge.
//   VicPD, Saanich Police, Oak Bay Police: © the department, no open licence; headline + link to the original only.

import { redactHeadline, NAMES_NOTE } from "../../../site/src/shared/redact-names.js";

const UA = { "User-Agent": "openplaces local-relay" };
const ORGS = { langford: { host: "pub-langford.escribemeetings.com", name: "City of Langford" } };

// police agencies: detachment HQ location (for nearest-first ordering in the page) and how to read its releases
export const AGENCIES = [
  { id: "westshore", name: "West Shore RCMP", ll: [-123.5, 48.452], kind: "rcmp", url: "https://rcmp.ca/en/bc/west-shore/news",
    covers: "Langford, Colwood, View Royal, Metchosin, Highlands, Songhees and Esquimalt Nations" },
  { id: "sooke", name: "Sooke RCMP", ll: [-123.728, 48.376], kind: "rcmp", url: "https://rcmp.ca/en/bc/sooke/news", covers: "Sooke, Juan de Fuca" },
  { id: "sidney", name: "Sidney North Saanich RCMP", ll: [-123.401, 48.65], kind: "rcmp", url: "https://rcmp.ca/en/bc/sidney-north-saanich/news", covers: "Sidney, North Saanich" },
  { id: "vicpd", name: "Victoria Police", ll: [-123.362, 48.43], kind: "rss", url: "https://engagement.vicpd.ca/tag/news-releases/rss/", covers: "Victoria, Esquimalt" },
  { id: "saanich", name: "Saanich Police", ll: [-123.375, 48.468], kind: "wp", url: "https://saanichpolice.ca/wp-json/wp/v2/posts?per_page=12&_fields=id,date,link,title", covers: "Saanich" },
  { id: "oakbay", name: "Oak Bay Police", ll: [-123.316, 48.427], kind: "wp", url: "https://oakbaypolice.org/wp-json/wp/v2/posts?per_page=8&_fields=id,date,link,title", covers: "Oak Bay" },
];
export const POLICE_CREDIT = `Headlines and links from each agency's newsroom: RCMP (non-commercial reproduction with attribution), Victoria Police, Saanich Police, Oak Bay Police (© each department). Not endorsed by any agency. ${NAMES_NOTE}`;

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", hellip: "…" };
export const unescape = (s) => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m).replace(/\s+/g, " ").trim();

async function text(url, init) {
  const r = await fetch(url, { ...init, headers: { ...UA, ...(init?.headers || {}) } });
  if (!r.ok) throw new Error(`${new URL(url).host} returned ${r.status}`);
  return r.text();
}

/** rcmp.ca newsroom pages embed every release as JSON in drupal-settings (poweb.all_news.<view>) */
export function parseRcmp(html, a) {
  const m = /data-drupal-selector="drupal-settings-json">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error(`${a.name}: newsroom data not found`);
  const views = JSON.parse(m[1])?.poweb?.all_news || {};
  let list = Object.values(views)[0] || [];
  if (typeof list === "string") list = JSON.parse(list);
  return list.map((x) => ({ agency: a.id, title: unescape(x.title), date: x.field_publish_date || x.created, link: x.view_node, where: x.field_location || null }));
}
export function parseRss(xml, a) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const g = (t) => (new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(it) || [])[1];
    const d = new Date(unescape(g("pubDate")));
    return { agency: a.id, title: unescape(g("title")), date: isNaN(d) ? null : d.toISOString().slice(0, 10), link: unescape(g("link")), where: null };
  });
}
export const parseWp = (json, a) => json.map((p) => ({ agency: a.id, title: unescape(p.title?.rendered), date: String(p.date).slice(0, 10), link: p.link, where: null }));

async function agencyNews(a) {
  if (a.kind === "rcmp") return parseRcmp(await text(a.url), a);
  if (a.kind === "rss") return parseRss(await text(a.url), a);
  return parseWp(JSON.parse(await text(a.url, { headers: { Accept: "application/json" } })), a);
}

export async function policeJSON() {
  const res = await Promise.allSettled(AGENCIES.map(agencyNews));
  const since = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  const items = res.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).filter((x) => x.title && x.link && x.date && x.date >= since)
    .sort((p, q) => (p.date < q.date ? 1 : p.date > q.date ? -1 : 0))
    .map((x) => ({ ...x, title: redactHeadline(x.title) }));
  return {
    fetched: new Date().toISOString(), count: items.length, items, names: "redacted",
    agencies: AGENCIES.map((a, i) => ({ id: a.id, name: a.name, ll: a.ll, covers: a.covers, page: a.url.includes("/wp-json/") ? a.url.split("/wp-json/")[0] : a.url.replace(/tag\/news-releases\/rss\/$/, ""), ok: res[i].status === "fulfilled", error: res[i].status === "rejected" ? String(res[i].reason?.message || res[i].reason) : undefined })),
    credit: POLICE_CREDIT,
  };
}

/** eSCRIBE's public calendar: meetings from 21 days ago to 90 days ahead (name, start, end, place, link) */
export async function meetingsJSON(org) {
  const o = ORGS[org]; if (!o) return null;
  const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const body = JSON.stringify({ calendarStartDate: day(-21), calendarEndDate: day(90) });
  const j = JSON.parse(await text(`https://${o.host}/MeetingsCalendarView.aspx/GetCalendarMeetings`, { method: "POST", body, headers: { "Content-Type": "application/json; charset=utf-8" } }));
  const iso = (s) => (s ? s.replace(/\//g, "-").replace(" ", "T") : null);   // "2026/11/24 17:30:00" → local time, no zone
  const meetings = (j.d || []).map((m) => ({
    name: m.MeetingName, type: m.MeetingType, start: iso(m.StartDate), end: iso(m.EndDate), where: m.Location || null, agenda: !!m.HasAgenda,
    link: m.HasAgenda ? `https://${o.host}/Meeting.aspx?Id=${m.ID}&Agenda=Agenda&lang=English` : `https://${o.host}/`,
  })).sort((a, b) => (a.start < b.start ? -1 : 1));
  return { org, name: o.name, tz: "America/Vancouver", fetched: new Date().toISOString(), portal: `https://${o.host}/`, count: meetings.length, meetings,
    credit: `${o.name} council and committee calendar (eSCRIBE). Times are local (Pacific).` };
}

/** route /local/<file>: returns { body, ttl } or null */
export async function localRoute(file, params, ctx) {
  const key = file === "police.json" ? "police" : file === "meetings.json" ? `meetings:${params.get("org") || ""}` : null;
  if (!key) return null;
  const ttl = key === "police" ? 900 : 3600;
  const cache = globalThis.caches?.default, ck = new Request(`https://openplaces-local.cache/${key}`);
  const hit = cache && (await cache.match(ck));
  if (hit) return { body: await hit.json(), ttl };
  const body = key === "police" ? await policeJSON() : await meetingsJSON(params.get("org"));
  if (!body) return null;
  if (cache) ctx?.waitUntil?.(cache.put(ck, new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` } })));
  return { body, ttl };
}
