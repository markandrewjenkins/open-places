// Live photo lookups for the aircraft and ship cards, made in the viewer's browser only when a card is open: the photo
// of that very aircraft or vessel when an open source has one, else an example of the same type in the same livery.
// src/air/photo.js and src/ships/vesselinfo.js build the lookup chains; this file holds what they share:
//
//   photoLookup(key, chain, render)   one lookup chain per selection, debounced (DEBOUNCE_MS: a selection that changes
//       again before then never asks anything), never two at once for the same key; render(photo) is called (sync when
//       already known) for every figure that asked while it ran. chain: async () => photo | null.
//   step(key, fn)                     one source's answer, cached in memory and sessionStorage (JSON only, at most 24 h:
//       Planespotters' limit), so a card rebuilt every second or reopened later asks nothing; a failed request is
//       remembered as "nothing" for RETRY_MS, so a failing source is not asked again on every rebuild.
//   commonsFiles(params) → [file]     Wikimedia Commons API (CORS via origin=*) → freely licensed bitmap files only:
//       { title, src (500 px thumbnail), w, h, page, author, licence, licence_url, desc }
//   commonsPhoto(file, extra) → photo  a Commons file as a card photo
//   showPhoto(fig, photo, { alt, onFail })  the photo with its credit line, into a typephoto.js <figure>
//
// photo: { src, w, h, page, author, source: "Planespotters.net" | "Wikimedia Commons", licence?, licence_url?,
//          label (what it shows, "This aircraft", "Air Canada Airbus A320 (example)"), exact (bool), referrer (bool) }
// Only https URLs on the sources' own hosts are used; everything fetched is treated as data.
import { el } from "./ui.js";

const DEBOUNCE_MS = 450, RETRY_MS = 5 * 60e3, TTL_MS = 24 * 3600e3, SS = "op-photo:";
const mem = new Map();
const ssGet = (k) => { try { const x = JSON.parse(sessionStorage.getItem(SS + k) || "null"); return x && Date.now() - x.t < TTL_MS ? x : null; } catch { return null; } };
const ssSet = (k, x) => { try { sessionStorage.setItem(SS + k, JSON.stringify(x)); } catch { /* full or blocked: memory only */ } };
/** a source's cached answer: the photo, null (none, or failed recently) or undefined (not asked yet) */
function peek(k) {
  let x = mem.get(k);
  if (!x) { x = ssGet(k); if (x) mem.set(k, x); }
  if (x?.err && Date.now() - x.t > RETRY_MS) { mem.delete(k); return undefined; }
  return x ? x.v : undefined;
}
export async function step(k, fn) {
  const c = peek(k);
  if (c !== undefined) return c;
  try {
    const x = { v: (await fn()) ?? null, t: Date.now() };
    mem.set(k, x); ssSet(k, x);
    return x.v;
  } catch {
    mem.set(k, { v: null, t: Date.now(), err: true });   // memory only: a later session tries again
    return null;
  }
}

// ------------------------------------------------------------------ one chain per selection, debounced
const results = new Map(), waiters = new Map(), running = new Set();
let pend = null;
export function photoLookup(key, chain, render) {
  const r = results.get(key);
  if (r && (r.p || Date.now() - r.t < RETRY_MS)) { if (r.p) render(r.p); return; }
  let w = waiters.get(key);
  if (!w) waiters.set(key, (w = new Set()));
  w.add(render);
  if (running.has(key) || pend?.key === key) return;
  if (pend) clearTimeout(pend.timer);   // the earlier selection was left before its lookup started: drop it
  pend = { key, timer: setTimeout(() => {
    pend = null; running.add(key);
    Promise.resolve().then(chain).catch(() => null).then((p) => {
      running.delete(key); results.set(key, { p: p || null, t: Date.now() });
      const ws = waiters.get(key); waiters.delete(key);
      if (p) for (const f of ws || []) f(p);
    });
  }, DEBOUNCE_MS) };
}

// ------------------------------------------------------------------ Wikimedia Commons
const OK_LICENCE = /^(cc0( 1\.0)?|public domain|pd[- ].*|cc[ -]by(-sa)?([ -]\d\.\d)?( [a-z-]+)?)$/i;
const text = (html) => { if (!html) return ""; try { return (new DOMParser().parseFromString(String(html), "text/html").body.textContent || "").replace(/\s+/g, " ").trim(); } catch { return ""; } };
const okURL = (u, hosts) => { try { const x = new URL(u); return x.protocol === "https:" && hosts.some((h) => x.hostname === h || x.hostname.endsWith(`.${h}`)) ? x.href : ""; } catch { return ""; } };
export const safeURL = okURL;
const API = "https://commons.wikimedia.org/w/api.php";
/** a Commons query (generator=… params) → freely licensed bitmap files with a 500 px thumbnail, in the API's order */
export async function commonsFiles(params) {
  const q = new URLSearchParams({ action: "query", format: "json", formatversion: "2", origin: "*", prop: "imageinfo", iiprop: "url|size|extmetadata|mime",
    iiurlwidth: "500", iiextmetadatafilter: "LicenseShortName|LicenseUrl|Artist|ImageDescription|ObjectName", ...params });
  const r = await fetch(`${API}?${q}`, { credentials: "omit" });
  if (!r.ok) throw new Error(`Commons answered ${r.status}`);
  const j = await r.json();
  const pages = (j.query?.pages || []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const out = [];
  for (const p of pages) {
    const i = p.imageinfo?.[0], m = i?.extmetadata || {};
    const lic = String(m.LicenseShortName?.value || "").trim();
    if (!i || !/^image\/(jpeg|png|webp)$/.test(i.mime || "") || !OK_LICENCE.test(lic)) continue;
    const src = okURL(i.thumburl, ["wikimedia.org"]), page = okURL(i.descriptionurl, ["wikimedia.org"]);
    if (!src || !page) continue;
    out.push({ title: String(p.title || "").replace(/^File:/, ""), src, w: i.thumbwidth, h: i.thumbheight, ow: i.width, oh: i.height, page,
      author: text(m.Artist?.value).slice(0, 120) || "", licence: lic, licence_url: okURL(m.LicenseUrl?.value, ["creativecommons.org", "wikimedia.org", "wikipedia.org"]),
      desc: `${text(m.ObjectName?.value)} ${text(m.ImageDescription?.value)}`.slice(0, 600) });
  }
  return out;
}
/** wide enough to crop to the card's 16:9 without losing the subject, and big enough to be a real photo */
export const landscape = (f) => f.ow >= 640 && f.ow / f.oh >= 1.2 && f.ow / f.oh <= 2.6;
export const commonsPhoto = (f, extra = {}) => ({ src: f.src, w: f.w, h: f.h, page: f.page, author: f.author, licence: f.licence, licence_url: f.licence_url,
  source: "Wikimedia Commons", referrer: false, title: f.title, ...extra });

// ------------------------------------------------------------------ the figure
/** the photo and its credit into a typephoto.js figure (locked, so a late type-photo load can't replace it) */
export function showPhoto(fig, p, { alt = "", onFail } = {}) {
  const img = el("img", { class: "tf-ph", src: p.src, alt: alt || p.label || "Photo", loading: "lazy", decoding: "async",
    // Planespotters' thumbnails must be fetched as linked from the page (no hot-link bypass); Wikimedia's as the cards always have
    referrerpolicy: p.referrer ? "strict-origin-when-cross-origin" : "no-referrer" });
  img.onerror = () => { if (img.dataset.retried || p.source !== "Wikimedia Commons") onFail?.(); else { img.dataset.retried = "1"; setTimeout(() => { img.src = `${p.src}#retry`; }, 2500); } };
  const who = p.author && p.author !== "unknown author" ? p.author : `author on ${p.source}`;
  const credit = p.source === "Planespotters.net"
    // Planespotters: "© photographer", the thumbnail itself a plain link to the photo's page there
    ? [el("span", {}, `${p.label} · `), el("a", { href: p.page, target: "_blank", rel: "noopener" }, `© ${who}`), " · Planespotters.net"]
    : [el("span", {}, `${p.label} · `), p.licence_url ? el("a", { href: p.licence_url, target: "_blank", rel: "noopener license" }, p.licence) : p.licence, " · ",
      el("a", { href: p.page, target: "_blank", rel: "noopener" }, who), " · Wikimedia Commons"];
  fig.dataset.lock = "1"; fig.hidden = false;
  fig.replaceChildren(el("a", { class: "tf-link", href: p.page, target: "_blank", rel: "noopener", title: `Open the original photo on ${p.source}` }, img),
    el("figcaption", { title: `${p.label}. ${p.source === "Planespotters.net" ? `© ${who}` : `${who}, ${p.licence}`}, via ${p.source}.` }, ...credit));
  fig.classList.add("tf-photo");
}
