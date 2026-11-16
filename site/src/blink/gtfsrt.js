// Minimal GTFS-Realtime decoder (protobuf wire format, no dependencies) for the fields the dashboards use.
// Spec: https://gtfs.org/realtime/reference/  Field numbers are the official ones from gtfs-realtime.proto.
//
// Speed matters: the relay runs on Workers Free (10 ms CPU per request), and the Public Transit page also decodes
// big trip-update feeds in the browser. So one Reader walks the whole buffer and a sub-message is just a [p, end)
// window over it (no copies, no new DataView), and strings take an ASCII fast path. The same file is imported by the
// page (site/src/blink/rt.js), so keep it free of Worker- or Node-only APIs.

const UTF8 = new TextDecoder();

class Reader {
  constructor(buf, p = 0, end = buf.length, dv = null) {
    this.b = buf; this.p = p; this.end = end;
    this.dv = dv || new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get done() { return this.p >= this.end; }
  // varint as a Number; exact up to 2^53, which covers every GTFS-RT integer (timestamps, ids, enums)
  uint() {
    const b = this.b;
    let c = b[this.p++], v = c & 0x7f;
    if (c < 0x80) return v;
    c = b[this.p++]; v |= (c & 0x7f) << 7; if (c < 0x80) return v;
    c = b[this.p++]; v |= (c & 0x7f) << 14; if (c < 0x80) return v;
    c = b[this.p++]; v |= (c & 0x7f) << 21; if (c < 0x80) return v;
    let m = 268435456, out = v; // 2^28
    do { c = b[this.p++]; out += (c & 0x7f) * m; m *= 128; } while (c >= 0x80 && m < 1.3e30);
    return out;
  }
  // int32 is sent as a 10-byte two's-complement varint when negative
  int32() {
    const b = this.b; let lo = 0, i = 0, c;
    do { c = b[this.p++]; if (i < 4) lo |= (c & 0x7f) << (7 * i); else if (i === 4) lo |= (c & 0x0f) << 28; i++; } while (c >= 0x80 && i < 10);
    return lo | 0;
  }
  len() { const n = this.uint(); const s = this.p; this.p += n; return [s, s + n]; }
  str() {
    const n = this.uint(), s = this.p, e = s + n, b = this.b;
    this.p = e;
    if (n < 64) {
      let ascii = true;
      for (let i = s; i < e; i++) if (b[i] > 127) { ascii = false; break; }
      if (ascii) return String.fromCharCode.apply(null, b.subarray(s, e));
    }
    return UTF8.decode(b.subarray(s, e));
  }
  f32() { const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  f64() { const v = this.dv.getFloat64(this.p, true); this.p += 8; return v; }
  skip(wt) {
    if (wt === 0) { while (this.b[this.p++] >= 0x80); }
    else if (wt === 1) this.p += 8;
    else if (wt === 2) { const n = this.uint(); this.p += n; }
    else if (wt === 5) this.p += 4;
    else throw new Error(`unsupported wire type ${wt}`);
  }
  // a reader over the next length-delimited field (shares the buffer)
  sub() { const [s, e] = this.len(); return new Reader(this.b, s, e, this.dv); }
  // iterate fields of a message: fn(fieldNumber, wireType) must consume the value or return false to skip it
  each(fn) {
    while (this.p < this.end) {
      const key = this.uint(), f = key >>> 3, wt = key & 7, at = this.p;
      if (fn(f, wt) === false && this.p === at) this.skip(wt);
    }
  }
}

function trip(r) {
  const t = {};
  r.each((f) => {
    if (f === 1) t.trip_id = r.str(); else if (f === 2) t.start_time = r.str(); else if (f === 3) t.start_date = r.str();
    else if (f === 4) t.schedule_relationship = r.uint();
    else if (f === 5) t.route_id = r.str(); else if (f === 6) t.direction_id = r.uint(); else return false;
  });
  return t;
}
function position(r) {
  const p = {};
  r.each((f, wt) => {
    if (f === 1 && wt === 5) p.lat = r.f32(); else if (f === 2 && wt === 5) p.lon = r.f32(); else if (f === 3 && wt === 5) p.bearing = r.f32();
    else if (f === 4 && wt === 1) p.odometer = r.f64(); else if (f === 5 && wt === 5) p.speed = r.f32(); else return false;
  });
  return p;
}
function vehicleDesc(r) {
  const v = {};
  r.each((f) => { if (f === 1) v.id = r.str(); else if (f === 2) v.label = r.str(); else return false; });
  return v;
}
function vehiclePosition(r) {
  const v = {};
  r.each((f) => {
    if (f === 1) v.trip = trip(r.sub()); else if (f === 2) v.position = position(r.sub());
    else if (f === 3) v.current_stop_sequence = r.uint(); else if (f === 4) v.current_status = r.uint();
    else if (f === 5) v.timestamp = r.uint(); else if (f === 7) v.stop_id = r.str();
    else if (f === 8) v.vehicle = vehicleDesc(r.sub()); else if (f === 9) v.occupancy_status = r.uint(); else return false;
  });
  return v;
}
function stopTimeEvent(r) {
  const e = {};
  r.each((f) => { if (f === 1) e.delay = r.int32(); else if (f === 2) e.time = r.uint(); else return false; });
  return e;
}
function stopTimeUpdate(r) {
  const s = {};
  r.each((f) => {
    if (f === 1) s.stop_sequence = r.uint(); else if (f === 2) s.arrival = stopTimeEvent(r.sub());
    else if (f === 3) s.departure = stopTimeEvent(r.sub()); else if (f === 4) s.stop_id = r.str();
    else if (f === 5) s.schedule_relationship = r.uint(); else return false;
  });
  return s;
}
function tripUpdate(r, keepStop, keepTrip) {
  const t = { stop_time_update: [] };
  let skip = false;
  r.each((f) => {
    if (f === 1) { t.trip = trip(r.sub()); if (keepTrip && !keepTrip(t.trip?.trip_id)) skip = true; }
    else if (f === 2 && skip) return false;
    else if (f === 2) {
      // keepStop(stopId) lets a caller (departures near a few stops) skip building objects for every other stop
      if (keepStop) {
        const s = r.sub(), at = s.p; let id = null;
        s.each((g) => { if (g === 4) id = s.str(); else return false; });
        if (id != null && keepStop(id)) { s.p = at; t.stop_time_update.push(stopTimeUpdate(s)); }
        else if (id == null && !t.stop_time_update.length) { s.p = at; t.first = stopTimeUpdate(s); }
      } else t.stop_time_update.push(stopTimeUpdate(r.sub()));
    }
    else if (f === 3) t.vehicle = vehicleDesc(r.sub()); else if (f === 4) t.timestamp = r.uint();
    else if (f === 5) t.delay = r.int32(); else return false;
  });
  return t;
}
function translated(r) {
  let text = null;
  r.each((f) => {
    if (f !== 1) return false;
    const t = r.sub(); let s = null, lang = null;
    t.each((g) => { if (g === 1) s = t.str(); else if (g === 2) lang = t.str(); else return false; });
    if (text === null || lang === "en" || lang === "en-US" || lang === "en-CA") text = s;
  });
  return text;
}
function alert(r) {
  const a = { active_period: [], informed_entity: [] };
  r.each((f) => {
    if (f === 1) { const t = r.sub(), p = {}; t.each((g) => { if (g === 1) p.start = t.uint(); else if (g === 2) p.end = t.uint(); else return false; }); a.active_period.push(p); }
    else if (f === 5) { const e = r.sub(), s = {}; e.each((g) => { if (g === 1) s.agency_id = e.str(); else if (g === 2) s.route_id = e.str(); else if (g === 3) s.route_type = e.uint(); else if (g === 5) s.stop_id = e.str(); else return false; }); a.informed_entity.push(s); }
    else if (f === 6) a.cause = r.uint(); else if (f === 7) a.effect = r.uint();
    else if (f === 8) a.url = translated(r.sub()); else if (f === 10) a.header = translated(r.sub());
    else if (f === 11) a.description = translated(r.sub()); else if (f === 14) a.severity_level = r.uint(); else return false;
  });
  return a;
}

/** Decode a FeedMessage: { timestamp, entities: [{ id, vehicle?, trip_update?, alert? }] }.
 *  opts.only: "vehicle" | "trip_update" | "alert" skips the other entity kinds without building them;
 *  opts.keepStop(stopId) → bool keeps only matching stop-time updates (plus each trip's first, as `first`);
 *  opts.keepTrip(tripId) → bool drops every stop-time update of the other trips (the trip descriptor comes first). */
export function decodeFeed(buf, opts = {}) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const r = new Reader(b);
  const out = { timestamp: null, entities: [] };
  const only = opts.only, keepStop = opts.keepStop, keepTrip = opts.keepTrip;
  r.each((f) => {
    if (f === 1) { const h = r.sub(); h.each((g) => { if (g === 3) out.timestamp = h.uint(); else return false; }); }
    else if (f === 2) {
      const e = r.sub(), ent = {};
      e.each((g) => {
        if (g === 1) ent.id = e.str();
        else if (g === 4 && (!only || only === "vehicle")) ent.vehicle = vehiclePosition(e.sub());
        else if (g === 3 && (!only || only === "trip_update")) ent.trip_update = tripUpdate(e.sub(), keepStop, keepTrip);
        else if (g === 5 && (!only || only === "alert")) ent.alert = alert(e.sub());
        else return false;
      });
      out.entities.push(ent);
    } else return false;
  });
  return out;
}
