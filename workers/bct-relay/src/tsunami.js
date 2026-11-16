// Tsunami messages for Open Places (the "Tsunami Status" tile). tsunami.gov's Atom feeds send no CORS headers, so a
// github.io page can't read them; this route fetches both at most once a minute per Cloudflare location and answers
// compact JSON. Public domain (NOAA / NWS).
//
//   /tsunami/latest.json     the latest message of each warning centre:
//     NTWC (Palmer, Alaska): Alaska, BC, the US west coast    PTWC (Hawaii): Hawaii, the Pacific basin, the Caribbean
//
// Each feed holds only its centre's newest event. The page compares message ids to spot new ones.

const FEEDS = { NTWC: "https://www.tsunami.gov/events/xml/PAAQAtom.xml", PTWC: "https://www.tsunami.gov/events/xml/PHEBAtom.xml" };
const TTL = 60;
export const TSU_CREDIT = "NOAA National Tsunami Warning Center and Pacific Tsunami Warning Center, tsunami.gov (public domain)";

const pick = (s, re) => (re.exec(s) || [])[1];
const strip = (s) => (s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

export function parseAtom(center, xml) {
  const bulletin = strip(pick(xml, /<feed[^>]*>[\s\S]*?<title>([\s\S]*?)<\/title>/));
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
    const sum = strip(pick(e, /<summary[^>]*>([\s\S]*?)<\/summary>/));
    const note = pick(sum, /Note:\s*\*?\s*(.+?)(?:Definition:|$)/);
    const lat = pick(e, /<geo:lat>([^<]+)</), lon = pick(e, /<geo:long>([^<]+)</), mag = pick(sum, /Preliminary Magnitude:\s*([\d.]+)/);
    return {
      id: pick(e, /<id>([^<]+)<\/id>/), center, bulletin, title: strip(pick(e, /<title>([\s\S]*?)<\/title>/)), updated: pick(e, /<updated>([^<]+)</),
      category: pick(sum, /Category:\s*(\w+)/) || null, mag: mag ? +mag : null, lat: lat ? +lat : null, lon: lon ? +lon : null,
      note: note && !/^Definition/.test(note) ? note.trim() : null, link: pick(e, /<link rel="alternate"[^>]*href="([^"]+)"/) || null,
    };
  });
}

export async function tsunamiRoute(file, ctx) {
  if (file !== "latest.json") return null;
  const cache = globalThis.caches?.default, key = new Request("https://relay.cache/tsunami/latest.json");
  const hit = cache && (await cache.match(key));
  if (hit) return { body: await hit.json(), ttl: TTL };
  const latest = [];
  for (const [c, url] of Object.entries(FEEDS)) {
    const r = await fetch(url, { headers: { "User-Agent": "openplaces relay (tsunami)", Accept: "application/atom+xml, text/xml" } });
    if (!r.ok) throw new Error(`tsunami.gov ${c} returned ${r.status}`);
    latest.push(...parseAtom(c, await r.text()));
  }
  const body = { fetched: new Date().toISOString(), latest, credit: TSU_CREDIT };
  if (cache) ctx?.waitUntil?.(cache.put(key, new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${TTL}` } })));
  return { body, ttl: TTL };
}
