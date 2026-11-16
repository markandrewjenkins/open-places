// Air Traffic: what to draw between live reports, shared by the page (common.js) and the Open Places tile
// (site/places/civic-modules.js). No DOM.
//
// ADS-B coverage near Victoria flickers: a low floatplane or a helicopter behind a hill drops out of one report and is
// back in the next, and each report is a few seconds old by the time it arrives. So:
//   - every aircraft is kept by its transponder address and only replaced by a newer position fix (never an older one
//     from a different cache or upstream);
//   - one missing from the reports is held for HOLD_S after its last fix, then dropped;
//   - between fixes it is moved on along its track at its ground speed (dead reckoning, at most DR_MAX_S), so planes
//     glide rather than jump every poll;
//   - its strength fades once it has been missing from reports for FADE_S, and everything fades once the feed itself is
//     more than LIVE_S behind, so a held or frozen aircraft looks it (a slow poll alone doesn't fade anything);
//   - the feed's state ("live", "delayed", "down") comes from the age of the newest report, not from whether the last
//     request worked, and a stale snapshot the relay served from its last good copy counts as delayed.
// Aircraft with no address (privacy-flagged) can't be matched from one report to the next, so they are shown only as
// the latest report has them.
import { airborne, NM } from "./feed.js";

export const HOLD_S = 60, FADE_S = 20, DR_MAX_S = 60;
export const LIVE_S = 45, DOWN_S = 300;     // newest report younger than LIVE_S: live (a 30 s poll + 8 s edge cache fits); older than DOWN_S: down

export const createTrack = () => ({ ac: new Map(), anon: [], asOf: 0, offset: 0, source: "", credit: "", stale: false, staleWhy: "", reports: 0, lastCount: 0, every: 0 });

// The relay's hub can stretch its aircraft clock to fit adsb.lol's daily allowance (it says so in every_s). A report is
// then expected less often, so "live", the fade and dead reckoning stretch with it (dead reckoning to at most 4 min).
const liveS = (T) => Math.max(LIVE_S, (T.every || 0) * 1.5 + 15);
const drS = (T) => Math.min(240, Math.max(DR_MAX_S, (T.every || 0) + 15));

/** the relay's clock (s): local time plus the offset learned from its served_epoch */
export const serverNow = (T, ms = Date.now()) => ms / 1000 + T.offset;

/** fold one relay report ({ as_of_epoch, aircraft, source, served_epoch?, stale?, age_s? }) into the track */
export function ingest(T, j, recvMs = Date.now()) {
  const asOf = +j.as_of_epoch || 0;
  if (j.every_s) T.every = +j.every_s;
  // the relay stamps when it answered; older relays don't, so then assume the report is fresh (under by ≤ its cache)
  T.offset = (j.served_epoch || asOf || recvMs / 1000) - recvMs / 1000;
  const anon = [];
  for (const a of j.aircraft || []) {
    const fix = asOf - (a.seen || 0);
    if (!a.hex) { anon.push({ ...a, fix }); continue; }
    const prev = T.ac.get(a.hex);
    if (!prev || fix >= prev.fix) T.ac.set(a.hex, { ...a, fix });
  }
  T.anon = anon;
  if (asOf >= T.asOf) { T.asOf = asOf; T.source = j.source || T.source; T.credit = j.credit || T.credit; T.stale = !!j.stale; T.staleWhy = j.error || ""; }
  for (const [k, a] of T.ac) if (T.asOf - a.fix > Math.max(HOLD_S, (T.every || 0) * 2)) T.ac.delete(k);
  T.reports++; T.lastCount = (j.aircraft || []).length;
  return T;
}

/** everything to draw: held aircraft included, each with its age (s since its fix, for dead reckoning), whether it
 *  is missing from the newest report, and fade (1 → 0.25: missing from reports, or the feed itself behind) */
export function aircraftOf(T, ms = Date.now()) {
  const now = serverNow(T, ms), behind = Math.max(0, now - T.asOf - liveS(T)), dr = drS(T);
  return [...T.ac.values(), ...T.anon].map((a) => {
    a.age = Math.max(0, now - a.fix); a.dr = dr;
    a.held = T.asOf - a.fix > 1;
    a.fade = fadeOf(Math.max(0, T.asOf - a.fix) + behind);
    return a;
  });
}
export const fadeOf = (age) => (age <= FADE_S ? 1 : Math.max(0.25, 1 - (0.75 * (age - FADE_S)) / (HOLD_S - FADE_S)));

/** where it is now: [lat, lon] moved on along its track at its ground speed for `lag` s (at most DR_MAX_S) */
export function reckon(a, lag) {
  const moving = airborne(a) || (!airborne(a) && (a.gs ?? 0) >= 3);
  if (!moving || a.gs == null || a.track == null) return [a.lat, a.lon];
  const t = Math.min(a.dr || DR_MAX_S, Math.max(0, lag)), v = (a.gs * NM) / 3600, tr = (a.track * Math.PI) / 180;
  return [a.lat + (v * Math.cos(tr) * t) / 110.57, a.lon + (v * Math.sin(tr) * t) / (111.32 * Math.cos((a.lat * Math.PI) / 180))];
}

/** "live" | "delayed" | "down" | "connecting", with the newest report's age in s */
export function feedState(T, ms = Date.now()) {
  if (!T.asOf) return { level: "connecting", age: null };
  const age = Math.max(0, serverNow(T, ms) - T.asOf);
  return { level: age > Math.max(DOWN_S, (T.every || 0) * 3) ? "down" : T.stale || age > liveS(T) ? "delayed" : "live", age, every: T.every || null };
}
export const agoS = (s) => (s == null ? "–" : s < 90 ? `${Math.round(s)} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`);

/** Poll `run()` every `every` ms while the tab is visible. Failures retry after 3 s, then 15 s doubling to 2 min (a 429
 *  waits at least a minute). onResult(value) / onError(err, waitMs) after each attempt. Returns { stop, kick, info }. */
export function poller(run, { every = 10000, onResult, onError } = {}) {
  let timer = 0, stopped = false, fails = 0, nextAt = 0, busy = false;
  const plan = (ms) => { clearTimeout(timer); if (stopped) return; nextAt = Date.now() + ms; timer = setTimeout(tick, ms); };
  async function tick() {
    clearTimeout(timer);
    if (stopped || busy) return;
    if (typeof document !== "undefined" && document.hidden) { nextAt = 0; return; }     // visibilitychange restarts it
    busy = true;
    try {
      const v = await run();
      fails = 0; busy = false;
      plan(every);
      onResult?.(v);
    } catch (e) {
      fails++; busy = false;
      const wait = e?.code === "429" ? Math.max(60000, (e.retryAfter || 0) * 1000) : fails === 1 ? 3000 : Math.min(120000, 15000 * 2 ** (fails - 2));
      plan(wait);
      onError?.(e, wait);
    }
  }
  const vis = () => { if (!document.hidden && !stopped && !busy && !nextAt) tick(); };      // only if paused while hidden
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", vis);
  tick();
  return {
    stop: () => { stopped = true; clearTimeout(timer); if (typeof document !== "undefined") document.removeEventListener("visibilitychange", vis); },
    kick: () => { if (!stopped) tick(); },
    info: () => ({ fails, nextAt, busy }),
  };
}
