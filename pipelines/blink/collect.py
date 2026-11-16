"""Polite GTFS-Realtime logger for BC Transit Victoria route 95 Blink (and a few comparison routes).

  python -m pipelines.blink.collect                      # run until stopped (default: every 30 s)
  python -m pipelines.blink.collect --interval 45        # slower polling (never below 30 s)
  python -m pipelines.blink.collect --minutes 13 --parts # GitHub Actions: one ~13-minute run, one small file per run
  python -m pipelines.blink.collect --compact            # compact closed days to parquet and exit
  python -m pipelines.blink.collect --stop               # ask a running collector to flush and exit (STOP file)

Each tick fetches the vehicle-positions and trip-updates feeds (back to back, ~360 KB together), keeps only the
logged routes and writes:
  vp     new vehicle reports only (deduped on vehicle + vehicle timestamp)
  tu     route 95 trip-update stop rows whose predicted time is within ±2 min of the poll, only when changed:
         this keeps the last prediction before the bus reaches each stop (and any stop BC Transit marks SKIPPED)
         without logging every downstream prediction every 30 s
  trips  a row when a trip first appears or its state (SCHEDULED / CANCELED / ADDED, vehicle) changes
  polls  one row per tick: success, feed header times, counts, latency, error. The build uses it for coverage.
  alerts service alerts for the logged routes, every 5 min, only when an alert changes

Safe to run for weeks: a file lock stops a second copy; dedupe state is rebuilt from today's files on restart;
feed errors back off exponentially (to 10 min) and are logged as poll rows; rows are flushed every 2 minutes as
complete gzip members (a crash loses at most that much, and a torn last member is skipped on read); closed days are
compacted to zstd parquet. Disk: roughly 2-4 MB per day for five routes (~100 MB a month).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import sys
import time
import traceback
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pandas as pd
import requests
from google.transit import gtfs_realtime_pb2 as rt

from pipelines.common.http import USER_AGENT

from . import logio
from .config import (ALERT_EVERY, DEFAULT_INTERVAL, FLUSH_EVERY, LOG, MAX_BACKOFF, MIN_INTERVAL, RAW, ROUTE_IDS,
                     RT_ALERTS, RT_TRIPS, RT_VEHICLES, TU_ROUTES, TU_WINDOW, TZ)

ZONE = ZoneInfo(TZ)
STOP_FILE = LOG / "STOP"
LOCK_FILE = LOG / ".collector.lock"
STATUS_FILE = RAW / "collector_status.json"
RID2SHORT = {v: k for k, v in ROUTE_IDS.items()}
INT_COLS = {"ts", "obs", "start_date", "dir", "odo", "seq", "status", "occ", "cong", "arr", "arr_delay", "dep", "dep_delay",
            "sr", "n_stu", "ok", "vp_hdr", "tu_hdr", "n_vp_all", "n_tu_all", "n_vp", "n_tu", "n_trips", "ms"}

S = requests.Session()
S.headers.update({"User-Agent": USER_AGENT, "Accept": "application/x-protobuf, application/octet-stream"})

_stop = False


def _on_signal(*_):
    global _stop
    _stop = True


def local_day(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, ZONE).strftime("%Y-%m-%d")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ============================================================================= single-instance lock

class Lock:
    def __init__(self, path):
        self.path, self.fh = path, None

    def acquire(self) -> bool:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.fh = open(self.path, "a+")
        try:
            if os.name == "nt":
                import msvcrt
                self.fh.seek(0)
                msvcrt.locking(self.fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.fh.close()
            self.fh = None
            return False
        return True

    def release(self):
        if self.fh:
            try:
                if os.name == "nt":
                    import msvcrt
                    self.fh.seek(0)
                    msvcrt.locking(self.fh.fileno(), msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
            self.fh.close()


# ============================================================================= fetch + parse

def fetch_feed(url: str, timeout: int = 25) -> rt.FeedMessage:
    r = S.get(url, timeout=timeout)
    if r.status_code != 200:
        raise requests.HTTPError(f"HTTP {r.status_code} from {url.split('?')[0]}")
    msg = rt.FeedMessage()
    msg.ParseFromString(r.content)
    return msg


def parse_vehicles(msg, obs: int) -> tuple[list[dict], int]:
    rows, n_all = [], 0
    for e in msg.entity:
        if not e.HasField("vehicle"):
            continue
        n_all += 1
        v = e.vehicle
        route = RID2SHORT.get(v.trip.route_id)
        if route is None:
            continue
        p = v.position
        rows.append({
            "ts": int(v.timestamp or obs), "obs": obs, "route": route, "trip_id": v.trip.trip_id,
            "start_date": int(v.trip.start_date or 0), "start_time": v.trip.start_time,
            "dir": int(v.trip.direction_id), "vehicle": v.vehicle.id or v.vehicle.label,
            "lat": round(p.latitude, 6), "lon": round(p.longitude, 6),
            "bearing": round(p.bearing, 1) if p.HasField("bearing") else None,
            "speed": round(p.speed, 2) if p.HasField("speed") else None,
            "odo": int(p.odometer) if p.HasField("odometer") else None,
            "seq": int(v.current_stop_sequence) if v.HasField("current_stop_sequence") else None,
            "stop_id": v.stop_id or None, "status": int(v.current_status),
            "occ": int(v.occupancy_status) if v.HasField("occupancy_status") else None,
            "cong": int(v.congestion_level) if v.HasField("congestion_level") else None,
        })
    return rows, n_all


def parse_trips(msg, obs: int) -> tuple[list[dict], list[dict], int]:
    stops, trips, n_all = [], [], 0
    for e in msg.entity:
        if not e.HasField("trip_update"):
            continue
        n_all += 1
        t = e.trip_update
        route = RID2SHORT.get(t.trip.route_id)
        if route is None:
            continue
        base = {"trip_id": t.trip.trip_id, "start_date": int(t.trip.start_date or 0)}
        trips.append({"obs": obs, "route": route, **base, "start_time": t.trip.start_time,
                      "dir": int(t.trip.direction_id), "vehicle": t.vehicle.id or t.vehicle.label or None,
                      "sr": int(t.trip.schedule_relationship), "n_stu": len(t.stop_time_update)})
        if route not in TU_ROUTES:
            continue
        for u in t.stop_time_update:
            arr = int(u.arrival.time) if u.HasField("arrival") and u.arrival.time else None
            dep = int(u.departure.time) if u.HasField("departure") and u.departure.time else None
            sr = int(u.schedule_relationship)
            ref = dep or arr
            if sr == 0 and (ref is None or abs(ref - obs) > TU_WINDOW):
                continue
            stops.append({
                "obs": obs, "route": route, **base, "seq": int(u.stop_sequence), "stop_id": u.stop_id,
                "arr": arr, "arr_delay": int(u.arrival.delay) if u.HasField("arrival") else None,
                "dep": dep, "dep_delay": int(u.departure.delay) if u.HasField("departure") else None, "sr": sr})
    return stops, trips, n_all


def _text(ts) -> str:
    for tr in ts.translation:
        if not tr.language or tr.language.startswith("en"):
            return tr.text
    return ts.translation[0].text if ts.translation else ""


def parse_alerts(msg, obs: int) -> list[dict]:
    rows = []
    for e in msg.entity:
        if not e.HasField("alert"):
            continue
        a = e.alert
        routes = sorted({RID2SHORT[i.route_id] for i in a.informed_entity if i.route_id in RID2SHORT})
        if not routes:
            continue
        stops = sorted({i.stop_id for i in a.informed_entity if i.stop_id})
        periods = ";".join(f"{p.start or ''}-{p.end or ''}" for p in a.active_period)
        body = _text(a.description_text)
        header = (_text(a.header_text) or body)[:300]
        h = hashlib.sha1(f"{periods}|{header}|{body}|{routes}|{a.cause}|{a.effect}".encode()).hexdigest()[:12]
        rows.append({"obs": obs, "alert_id": e.id, "hash": h, "routes": " ".join(routes), "stops": " ".join(stops[:60]),
                     "periods": periods, "cause": rt.Alert.Cause.Name(a.cause), "effect": rt.Alert.Effect.Name(a.effect),
                     "header": header})
    return rows


# ============================================================================= collector

class Collector:
    def __init__(self, parts: bool):
        self.parts = parts
        self.run_tag = datetime.now(ZONE).strftime("%H%M%S")
        self.buf = {k: [] for k in logio.KINDS}
        self.seen_vp: dict[str, int] = {}                 # vehicle -> last vehicle timestamp written
        self.seen_tu: dict[tuple, tuple] = {}             # (trip, date, seq) -> (arr, dep, sr)
        self.seen_trip: dict[tuple, tuple] = {}           # (trip, date) -> (sr, vehicle)
        self.seen_alert: set[str] = set()
        self.rows_today = {k: 0 for k in logio.KINDS}
        self.day = local_day(time.time())
        self.status = {"pid": os.getpid(), "started": now_iso(), "mode": "parts" if parts else "daily",
                       "last_poll": None, "last_ok": None, "fails_in_a_row": 0, "polls": 0, "polls_ok": 0}
        self.restore()

    # -- resume: rebuild dedupe state from today's (and yesterday's open) files
    def restore(self):
        for day in logio.days()[-2:]:
            vp = logio.read_day(day, "vp")
            if not vp.empty:
                for v, ts in vp.groupby("vehicle").ts.max().items():
                    self.seen_vp[str(v)] = max(int(ts), self.seen_vp.get(str(v), 0))
            tu = logio.read_day(day, "tu")
            if not tu.empty:
                for r in tu.itertuples(index=False):
                    self.seen_tu[(r.trip_id, int(r.start_date), int(r.seq))] = (_i(r.arr), _i(r.dep), int(r.sr))
            tr = logio.read_day(day, "trips")
            if not tr.empty:
                for r in tr.itertuples(index=False):
                    self.seen_trip[(r.trip_id, int(r.start_date))] = (int(r.sr), _s(r.vehicle))
            al = logio.read_day(day, "alerts")
            if not al.empty:
                self.seen_alert |= set(al["hash"].astype(str))
            if day == self.day:
                for k in logio.KINDS:
                    d = logio.read_day(day, k)
                    self.rows_today[k] = len(d)
        if self.seen_vp:
            print(f"  resumed: {len(self.seen_vp)} vehicles, {len(self.seen_tu):,} stop rows, {len(self.seen_trip)} trips known",
                  flush=True)

    def path(self, day: str, kind: str):
        if self.parts:
            return LOG / day / f"{self.run_tag}.{kind}.csv.gz"
        return LOG / f"{day}.{kind}.csv.gz"

    def add(self, kind: str, rows: list[dict]):
        self.buf[kind].extend(rows)

    def poll(self, with_alerts: bool) -> bool:
        obs = int(time.time())
        rec = {"obs": obs, "ok": 0, "vp_hdr": None, "tu_hdr": None, "n_vp_all": None, "n_tu_all": None,
               "n_vp": 0, "n_tu": 0, "n_trips": 0, "ms": None, "err": None}
        t0 = time.time()
        try:
            vmsg = fetch_feed(RT_VEHICLES)
            tmsg = fetch_feed(RT_TRIPS)
            rec["ms"] = int((time.time() - t0) * 1000)
            rec["vp_hdr"], rec["tu_hdr"] = int(vmsg.header.timestamp), int(tmsg.header.timestamp)
            vp, rec["n_vp_all"] = parse_vehicles(vmsg, obs)
            stu, trips, rec["n_tu_all"] = parse_trips(tmsg, obs)
            new_vp = []
            for r in vp:
                if r["ts"] > self.seen_vp.get(r["vehicle"], 0):
                    self.seen_vp[r["vehicle"]] = r["ts"]
                    new_vp.append(r)
            new_tu = []
            for r in stu:
                k, val = (r["trip_id"], r["start_date"], r["seq"]), (r["arr"], r["dep"], r["sr"])
                if self.seen_tu.get(k) != val:
                    self.seen_tu[k] = val
                    new_tu.append(r)
            new_trips = []
            for r in trips:
                k, val = (r["trip_id"], r["start_date"]), (r["sr"], r["vehicle"])
                if self.seen_trip.get(k) != val:
                    self.seen_trip[k] = val
                    new_trips.append(r)
            self.add("vp", new_vp)
            self.add("tu", new_tu)
            self.add("trips", new_trips)
            rec.update(ok=1, n_vp=len(new_vp), n_tu=len(new_tu), n_trips=len(new_trips))
            if with_alerts:
                try:
                    al = [a for a in parse_alerts(fetch_feed(RT_ALERTS), obs) if a["hash"] not in self.seen_alert]
                    self.seen_alert |= {a["hash"] for a in al}
                    self.add("alerts", al)
                except Exception as exc:          # alerts are optional; never fail the tick for them
                    rec["err"] = f"alerts: {type(exc).__name__}: {exc}"[:200]
        except Exception as exc:
            rec["ms"] = int((time.time() - t0) * 1000)
            rec["err"] = f"{type(exc).__name__}: {exc}"[:300]
        self.add("polls", [rec])
        self.status["polls"] += 1
        self.status["last_poll"] = now_iso()
        if rec["ok"]:
            self.status["polls_ok"] += 1
            self.status["last_ok"] = self.status["last_poll"]
            self.status["fails_in_a_row"] = 0
        else:
            self.status["fails_in_a_row"] += 1
            self.status["last_error"] = rec["err"]
        return bool(rec["ok"])

    def flush(self):
        for kind, rows in self.buf.items():
            if not rows:
                continue
            df = pd.DataFrame(rows)
            for c in INT_COLS & set(df.columns):
                df[c] = pd.to_numeric(df[c], errors="coerce").astype("Int64")
            obs_col = "obs" if "obs" in df else "ts"
            df["_day"] = [local_day(x) for x in df[obs_col]]
            for day, g in df.groupby("_day"):
                logio.append_csv_gz(self.path(day, kind), g.drop(columns="_day"))
                if day == self.day:
                    self.rows_today[kind] += len(g)
            self.buf[kind] = []
        self.write_status()

    def write_status(self):
        st = {**self.status, "day": self.day, "rows_today": dict(self.rows_today), "updated": now_iso()}
        STATUS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = STATUS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(st, indent=1), encoding="utf-8")
        tmp.replace(STATUS_FILE)

    def rollover(self):
        """New local day: compact closed days, prune old dedupe keys."""
        today = local_day(time.time())
        if today == self.day:
            return
        self.flush()
        self.day = today
        self.rows_today = {k: 0 for k in logio.KINDS}
        compact_closed(keep_parts=False)
        cutoff = int((datetime.now(ZONE) - pd.Timedelta(days=2)).strftime("%Y%m%d"))
        self.seen_tu = {k: v for k, v in self.seen_tu.items() if k[1] >= cutoff}
        self.seen_trip = {k: v for k, v in self.seen_trip.items() if k[1] >= cutoff}


def _i(x):
    return None if pd.isna(x) else int(x)


def _s(x):
    return None if pd.isna(x) else str(x)


def compact_closed(keep_parts: bool = False) -> None:
    today = local_day(time.time())
    for day in logio.days():
        if day < today:
            done = logio.compact(day)
            if done:
                print(f"  compacted {day}: " + ", ".join(f"{k} {v:,}" for k, v in done.items()), flush=True)


def run(interval: int, minutes: float | None, parts: bool) -> int:
    interval = max(MIN_INTERVAL, int(interval))
    lock = Lock(LOCK_FILE)
    if not lock.acquire():
        print("another collector is already running (lock held); exiting", flush=True)
        return 1
    for sig in ("SIGINT", "SIGTERM", "SIGBREAK"):
        if hasattr(signal, sig):
            signal.signal(getattr(signal, sig), _on_signal)
    if STOP_FILE.exists():
        STOP_FILE.unlink()
    try:
        if not parts:
            compact_closed()
        c = Collector(parts)
        end = time.time() + minutes * 60 if minutes else None
        last_flush, last_alert, delay = time.time(), 0.0, interval
        print(f"collecting routes {', '.join(ROUTE_IDS)} every {interval}s"
              + (f" for {minutes:g} min" if minutes else " until stopped") + f" -> {LOG}", flush=True)
        while not _stop:
            tick = time.time()
            with_alerts = tick - last_alert >= ALERT_EVERY
            ok = c.poll(with_alerts)
            if with_alerts and ok:
                last_alert = tick
            if ok:
                delay = interval
            else:
                delay = min(MAX_BACKOFF, max(interval, delay * 2))
                print(f"  {now_iso()} poll failed ({c.status['fails_in_a_row']} in a row): "
                      f"{c.status.get('last_error')}; next try in {delay}s", flush=True)
            if time.time() - last_flush >= FLUSH_EVERY:
                c.flush()
                last_flush = time.time()
                print(f"  {now_iso()} rows today: " + ", ".join(f"{k} {v:,}" for k, v in c.rows_today.items()), flush=True)
            if not parts:
                c.rollover()
            if end and time.time() + delay > end:
                break
            # sleep in short steps so a STOP file or signal is honoured quickly
            wake = tick + delay
            while not _stop and time.time() < wake:
                if STOP_FILE.exists():
                    print("STOP file found; flushing and exiting", flush=True)
                    STOP_FILE.unlink()
                    c.flush()
                    return 0
                time.sleep(min(2.0, max(0.0, wake - time.time())))
        c.flush()
        print("collector stopped cleanly", flush=True)
        return 0
    except Exception:
        traceback.print_exc()
        try:
            c.flush()                                         # noqa: F821 (best effort)
        except Exception:
            pass
        return 1
    finally:
        lock.release()


def main(argv: list[str]) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    ap = argparse.ArgumentParser(prog="python -m pipelines.blink.collect")
    ap.add_argument("--interval", type=int, default=DEFAULT_INTERVAL, help="seconds between polls (min 30)")
    ap.add_argument("--minutes", type=float, default=None, help="stop after this many minutes (CI runs)")
    ap.add_argument("--parts", action="store_true", help="one small file per run (for committing from CI)")
    ap.add_argument("--compact", action="store_true", help="compact closed days to parquet and exit")
    ap.add_argument("--stop", action="store_true", help="ask a running collector to flush and exit")
    a = ap.parse_args(argv)
    if a.stop:
        LOG.mkdir(parents=True, exist_ok=True)
        STOP_FILE.write_text(now_iso())
        print(f"wrote {STOP_FILE}; the collector exits within a few seconds")
        return 0
    if a.compact:
        compact_closed()
        return 0
    return run(a.interval, a.minutes, a.parts)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
