// Public Transit · road speeds estimated from bus movements (Greater Victoria's West Shore). There is no open traffic
// feed for Victoria, so this compares how fast buses are moving along a few key roads right now with how fast they
// usually move there at this hour. It's an honest proxy, not a traffic measurement: buses stop, use bus lanes and
// bus-only shoulders, and a single late bus can drag an average down. Every figure says how many buses it rests on.
//
// The roads, their "spines" (a bus route's shape along the road, one per carriageway) and the typical bus speed by
// direction, day type and hour come from ../data/blink/corridors.json (pipelines/blink/traffic.py: from the logged
// Route 95 collector where it has watched an hour, else the timetable's own speed). The rules below match the
// pipeline's, so live and typical are measured the same way:
//   a position counts within NEAR_M of a spine; consecutive positions of one vehicle on one trip, 5–120 s apart by
//   the vehicle's own timestamps, give distance |Δchainage| over Δt; positions at a trip's first stop (layover) don't
//   count, and a bus standing still for more than 2 minutes in a row stops counting.
// Live speed = all those distances over all those seconds in the last 10 minutes, per road and direction.
//
// Changes become Open Places alerts (op-alert): "Hwy 1 inbound slow" when buses run below half the typical speed with
// at least two buses seen, "Hwy 1 inbound back to normal" when they recover to 70%; each change must hold for two polls.
// Each alert deep-links to the Road Speed drawer over the live map: <href>/now/map/speed:<row id> (e.g. hwy1-inbound).
//
// Exports: loadCorridors() → Promise<doc>; createTraffic(opts) → { ready, feed(vehicles, asOf), rows(), row(id),
// segments(rowId, binM) (the road in stretches, each with its live bus speed), kmhAt(lon, lat) (live or typical bus speed
// on the corridor under a point, for the map's motion model), corridors(), loaded, error, polls, asOf };
// speedLine(row), typSrcText, SPEED_NOTE, LEVEL_OF(ratio).
const URL_ = "../data/blink/corridors.json";
const NEAR_M = 60, MIN_DT = 5, MAX_DT = 120, STILL_MAX = 120, MAX_KMH = 110;
const WINDOW_S = 600, SLOW = 0.5, OK = 0.7, MIN_BUSES = 2, MIN_SECS = 60, CONFIRM = 2;
const LAT0 = 48.44, KX = 111320 * Math.cos((LAT0 * Math.PI) / 180), KY = 110540;
const xy = (lon, lat) => [(lon + 123.4) * KX, (lat - LAT0) * KY];
const BASE_KEY = "odp-transit-speeds";

let corrP = null;
/** the corridors file, with each spine prepared for projection */
export function loadCorridors() {
  return (corrP ||= fetch(URL_).then((r) => { if (!r.ok) throw new Error(`corridors.json: ${r.status}`); return r.json(); }).then((doc) => {
    for (const c of doc.corridors) {
      c.sp = c.spines.map((line) => {
        const P = line.map(([lon, lat]) => xy(lon, lat)), C = [0];
        for (let i = 1; i < P.length; i++) C.push(C[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
        return { P, C };
      });
      const all = c.spines.flat();
      c.bb = [Math.min(...all.map((p) => p[0])) - 0.002, Math.min(...all.map((p) => p[1])) - 0.0015, Math.max(...all.map((p) => p[0])) + 0.002, Math.max(...all.map((p) => p[1])) + 0.0015];
    }
    return doc;
  }).catch((e) => { corrP = null; throw e; }));
}

function projectOne(sp, x, y) {
  let best = [0, Infinity];
  const { P, C } = sp;
  for (let i = 0; i < P.length - 1; i++) {
    const [ax, ay] = P[i], [bx, by] = P[i + 1], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
    const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    if (d < best[1]) best = [C[i] + t * Math.sqrt(L2), d];
  }
  return best;
}
/** { c: chainage m, d: distance m, k: spine index } on the nearest spine, or null when off the corridor (exported for
 *  the Road Speed view: which buses are on the road) */
export function project(cor, lon, lat) {
  if (lon < cor.bb[0] || lon > cor.bb[2] || lat < cor.bb[1] || lat > cor.bb[3]) return null;
  const [x, y] = xy(lon, lat);
  let out = null;
  cor.sp.forEach((sp, k) => { const [c, d] = projectOne(sp, x, y); if (d <= NEAR_M && (!out || d < out.d)) out = { c, d, k }; });
  return out;
}

const parts = (tz, date = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour: "numeric", weekday: "short", hourCycle: "h23" }).formatToParts(date).map((x) => [x.type, x.value]));
  return { hour: +p.hour % 24, day: p.weekday === "Sat" ? "sat" : p.weekday === "Sun" ? "sun" : "weekday" };
};
function readBase() { try { return JSON.parse(localStorage.getItem(BASE_KEY) || "{}"); } catch { return {}; } }
function writeBase(b) { try { localStorage.setItem(BASE_KEY, JSON.stringify(b)); } catch { /* ignore */ } }

/**
 * A traffic estimator for one page. feed(vehicles) after every poll (vehicles: the relay's vehicle list for the
 * agency); rows() → one row per road and direction. opts.emit(detail) receives op-alert details on changes;
 * opts.place / opts.href go into them.
 */
export function createTraffic({ tz = "America/Vancouver", emit = null, place = null, href = "#getting-around/transit" } = {}) {
  const speedHref = (id) => `${href.replace(/\/$/, "")}/now/map/speed:${id}`;
  let doc = null, polls = 0, lastAt = null;
  const last = new Map();          // vehicle → { ts, trip, seq, at: { corridorId: {c, k} } }
  const still = new Map(), lastDir = new Map();   // `${veh}|${cid}` → seconds still / last direction
  const segs = new Map();          // `${cid}|${dir}` → [{ t, d, dt, veh }]
  const state = new Map();         // `${cid}|${dir}` → { now: "unknown"|"slow"|"normal", pend, n, since }
  let base = readBase();
  const ready = loadCorridors().then((d) => { doc = d; }).catch(() => { doc = { corridors: [], error: true }; });

  function typicalFor(c, dirName, when = parts(tz)) {
    const T = c.typical?.[dirName]?.[when.day];
    let v = T?.[when.hour];
    if (!v && T) v = T[(when.hour + 23) % 24] || T[(when.hour + 1) % 24];      // a neighbouring hour, if this one is empty
    if (v) return { kmh: v[0], src: v[1], n: v[2] };
    const b = base[`${c.id}|${dirName}|${when.day}|${when.hour}`];
    return b && b[1] >= 6 ? { kmh: b[0], src: "rolling", n: b[1] } : null;
  }

  function feed(vehicles, asOf = Date.now() / 1000) {
    if (!doc) { ready.then(() => feed(vehicles, asOf)); return; }
    polls++; lastAt = asOf;
    const seen = new Set();
    for (const v of vehicles) {
      if (v.lat == null || v.lon == null || !v.ts) continue;
      const id = String(v.vehicle); seen.add(id);
      const prev = last.get(id);
      if (prev && prev.ts === v.ts) continue;                    // no new report from this vehicle
      const here = {};
      for (const c of doc.corridors) { const p = project(c, v.lon, v.lat); if (p) here[c.id] = p; }
      if (prev && prev.trip === v.trip && prev.trip != null) {
        const dt = v.ts - prev.ts;
        for (const c of doc.corridors) {
          const a = prev.at[c.id], b = here[c.id], key = `${id}|${c.id}`;
          if (!a || !b) { still.delete(key); continue; }
          if (dt < MIN_DT || dt > MAX_DT || a.k !== b.k || !(prev.seq > 1) || !(v.seq > 1)) continue;
          const dc = b.c - a.c;
          if ((Math.abs(dc) / dt) * 3.6 > MAX_KMH) continue;
          let dir;
          if (Math.abs(dc) < 5) { still.set(key, (still.get(key) || 0) + dt); dir = lastDir.get(key); }
          else { still.set(key, 0); dir = dc > 0 ? 0 : 1; lastDir.set(key, dir); }
          if (dir == null || still.get(key) > STILL_MAX) continue;
          const sk = `${c.id}|${dir}`;
          if (!segs.has(sk)) segs.set(sk, []);
          segs.get(sk).push({ t: v.ts, d: Math.abs(dc), dt, veh: id, c0: Math.min(a.c, b.c), c1: Math.max(a.c, b.c), k: b.k });
        }
      }
      last.set(id, { ts: v.ts, trip: v.trip ?? null, seq: v.seq ?? null, at: here });
    }
    for (const id of [...last.keys()]) if (!seen.has(id)) last.delete(id);
    for (const [k, list] of segs) segs.set(k, list.filter((s) => s.t >= asOf - WINDOW_S));
    evaluate(asOf);
  }

  function rowFor(c, dir, asOf) {
    const dirName = c.dirs[dir], list = segs.get(`${c.id}|${dir}`) || [];
    const d = list.reduce((s, x) => s + x.d, 0), t = list.reduce((s, x) => s + x.dt, 0), n = new Set(list.map((x) => x.veh)).size;
    const kmh = t >= MIN_SECS ? (d / t) * 3.6 : null;
    const typ = typicalFor(c, dirName, parts(tz, new Date(asOf * 1000)));
    const ratio = kmh != null && typ ? kmh / typ.kmh : null;
    const st = state.get(`${c.id}|${dir}`) || { now: "unknown" };
    return { id: `${c.id}-${dirName}`, corridor: c.id, label: c.label, long: c.long, dir, dirName, title: `${c.label} ${dirName}`,
      kmh, n, secs: t, typical: typ?.kmh ?? null, typSrc: typ?.src ?? null, ratio, state: st.now,
      level: ratio == null ? "none" : st.now === "slow" ? "slow" : ratio < OK ? "busy" : "normal" };
  }

  function evaluate(asOf) {
    const when = parts(tz, new Date(asOf * 1000));
    let dirty = false;
    for (const c of doc.corridors) for (const dir of [0, 1]) {
      const r = rowFor(c, dir, asOf), k = `${c.id}|${dir}`;
      const st = state.get(k) || { now: "unknown", pend: null, n: 0 };
      // rolling baseline: this browser's own record of bus speeds here, used only where the file has no typical
      if (r.kmh != null && r.n >= 1) {
        const bk = `${c.id}|${r.dirName}|${when.day}|${when.hour}`, b = base[bk] || [r.kmh, 0];
        base[bk] = [Math.round((b[0] * Math.min(b[1], 30) + r.kmh) / (Math.min(b[1], 30) + 1) * 10) / 10, b[1] + 1]; dirty = true;
      }
      let want = null;
      if (r.ratio != null && r.n >= MIN_BUSES && r.ratio < SLOW) want = "slow";
      else if (r.ratio != null && r.ratio >= OK) want = "normal";
      if (want && want !== st.now) {
        st.n = st.pend === want ? st.n + 1 : 1; st.pend = want;
        if (st.n >= CONFIRM) {
          const was = st.now; st.now = want; st.pend = null; st.n = 0; st.since = asOf;
          if (emit && (want === "slow" || was === "slow")) emit(alertDetail(r, want, asOf));
        }
      } else if (!want || want === st.now) { st.pend = null; st.n = 0; }
      state.set(k, st);
    }
    if (dirty && polls % 3 === 0) writeBase(base);
  }

  function alertDetail(r, want, asOf) {
    const stamp = new Date(Math.floor(asOf / 600) * 600 * 1000).toISOString().slice(0, 16);
    const fig = `${Math.round(r.kmh)} km/h against a typical ${Math.round(r.typical)} km/h for this hour`;
    return want === "slow"
      ? { id: `transit:speed:${r.id}:slow:${stamp}`, topic: "transit", level: "notice", title: `${r.title} slow`,
        body: `Buses on ${r.long} (${r.dirName}) are averaging ${fig}, from ${r.n} buses; estimated from bus movements, not a traffic feed.`, place, href: speedHref(r.id), speed: r.id }
      : { id: `transit:speed:${r.id}:normal:${stamp}`, topic: "transit", level: "info", title: `${r.title} back to normal`,
        body: `Buses on ${r.long} (${r.dirName}) are back to ${fig}; estimated from bus movements.`, place, href: speedHref(r.id), speed: r.id };
  }

  /** a row by its id ("hwy1-inbound") */
  function row(id) {
    if (!doc) return null;
    for (const c of doc.corridors) for (const dir of [0, 1]) if (`${c.id}-${c.dirs[dir]}` === id) return rowFor(c, dir, lastAt || Date.now() / 1000);
    return null;
  }
  /** the road for one row in stretches of about binM metres, along the carriageway that direction uses, each with the
   *  live bus speed measured inside it (distance and time shared out by overlap) and its line as [lon, lat] points */
  function segments(id, binM = 300) {
    const r = row(id); if (!r) return [];
    const c = doc.corridors.find((x) => x.id === r.corridor), k = c.sp.length > 1 ? r.dir : 0, sp = c.sp[k], L = sp.C[sp.C.length - 1];
    const n = Math.max(1, Math.round(L / binM)), w = L / n;
    const bins = Array.from({ length: n }, (_, i) => ({ c0: i * w, c1: (i + 1) * w, d: 0, dt: 0, veh: new Set() }));
    for (const s of segs.get(`${c.id}|${r.dir}`) || []) {
      const f = s.k === k ? 1 : L / (c.sp[s.k].C[c.sp[s.k].C.length - 1] || L);      // the other carriageway: scale its chainage
      const a = s.c0 * f, b = s.c1 * f, span = Math.max(1, b - a);
      for (const B of bins) {
        const o = Math.min(b, B.c1) - Math.max(a, B.c0);
        if (o <= 0 && !(span <= 1 && a >= B.c0 && a < B.c1)) continue;
        const share = span <= 1 ? 1 : o / span;
        B.d += s.d * share; B.dt += s.dt * share; B.veh.add(s.veh);
      }
    }
    return bins.map((B) => ({ c0: B.c0, c1: B.c1, secs: B.dt, n: B.veh.size, kmh: B.dt >= 20 ? (B.d / B.dt) * 3.6 : null,
      line: sliceLine(c.spines[k], sp, B.c0, B.c1) }));
  }
  /** live (else typical) bus speed on the corridor under a point, km/h, or null off the corridors */
  function kmhAt(lon, lat) {
    if (!doc) return null;
    for (const c of doc.corridors) {
      const p = project(c, lon, lat); if (!p) continue;
      const rs = [0, 1].map((dir) => rowFor(c, dir, lastAt || Date.now() / 1000));
      const live = rs.filter((x) => x.kmh != null && x.n >= 1);
      if (live.length) return { kmh: Math.min(...live.map((x) => x.kmh)), src: "live" };
      const typ = rs.filter((x) => x.typical);
      if (typ.length) return { kmh: Math.min(...typ.map((x) => x.typical)), src: "typical" };
    }
    return null;
  }

  return {
    ready, feed, row, segments, kmhAt,
    get loaded() { return !!doc && !doc.error; },
    get error() { return !!doc?.error; },
    get polls() { return polls; },
    get asOf() { return lastAt; },
    corridors: () => doc?.corridors || [],
    /** one row per road and direction, busiest first (rows with no buses last) */
    rows: () => (doc ? doc.corridors.flatMap((c) => [0, 1].map((dir) => rowFor(c, dir, lastAt || Date.now() / 1000)))
      .sort((a, b) => (a.ratio == null) - (b.ratio == null) || (a.ratio ?? 9) - (b.ratio ?? 9)) : []),
  };
}

/** the [lon, lat] points of a spine between two chainages */
function sliceLine(lonlat, sp, c0, c1) {
  const { C } = sp, out = [];
  const at = (c) => { let i = 1; while (i < C.length - 1 && C[i] < c) i++; const t = (c - C[i - 1]) / ((C[i] - C[i - 1]) || 1);
    return [lonlat[i - 1][0] + (lonlat[i][0] - lonlat[i - 1][0]) * t, lonlat[i - 1][1] + (lonlat[i][1] - lonlat[i - 1][1]) * t]; };
  out.push(at(c0));
  for (let i = 0; i < C.length; i++) if (C[i] > c0 && C[i] < c1) out.push(lonlat[i]);
  out.push(at(c1));
  return out;
}
/** level for a live / typical ratio: "slow" below half, "busy" below 70 %, else "normal" */
export const LEVEL_OF = (ratio) => (ratio == null ? "none" : ratio < SLOW ? "slow" : ratio < OK ? "busy" : "normal");

/** "Hwy 1 inbound · buses 18 km/h · typical 42" */
export const speedLine = (r) => `${r.title} · ${r.kmh == null ? "no buses moving" : `buses ${Math.round(r.kmh)} km/h`}${r.typical ? ` · typical ${Math.round(r.typical)}` : ""}`;
export const typSrcText = { log: "logged bus speeds for this hour", tt: "the timetable's speed for this hour", rolling: "this browser's own record for this hour" };
export const SPEED_NOTE = "Estimated from bus movements: the average speed of buses along each road over the last 10 minutes (stops included), compared with the usual bus speed there at this hour. Buses stop and some use bus lanes, so this is a proxy for traffic, not a measurement of it.";
