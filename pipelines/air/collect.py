"""Polite aircraft logger for the home circle (Greater Victoria), for the busy-hours and movements views.

  python -m pipelines.air.collect                    # run until stopped (default: one poll every 3 min; 1 min with ADSBLOL_API_KEY set)
  python -m pipelines.air.collect --interval 120     # slower (never below 30 s)
  python -m pipelines.air.collect --once             # one poll and exit (the daily workflow uses this)

Each tick asks adsb.lol (fallback adsb.fi) for every aircraft within the home radius: one small JSON request
(~5-15 kB). Positions are trimmed (no registrations, no owners; LADD / PIA aircraft anonymised, see feeds.py) and
appended to data/air/raw/log/ac-<UTC day>.csv.gz, with one row per poll in polls-<day>.csv.gz. Errors and 429s back off
exponentially to 15 minutes. Disk: about 0.3-0.6 MB a day. Stop with Ctrl+C (the buffer is flushed).
"""
from __future__ import annotations

import argparse
import signal
import time

from . import logio
from .config import DEFAULT_INTERVAL, FLUSH_EVERY, HOME, MAX_BACKOFF, MIN_INTERVAL
from .feeds import FIELDS, point

_stop = False


def _sig(*_):
    global _stop
    _stop = True


def poll_once() -> tuple[list[dict], dict]:
    t0 = time.time()
    try:
        rows, src, ts = point(HOME["lat"], HOME["lon"], HOME["radius_nm"])
        return rows, {"ts": ts, "ok": 1, "n": len(rows), "source": src, "ms": int((time.time() - t0) * 1000), "error": ""}
    except Exception as exc:  # noqa: BLE001 - every failure becomes a logged poll row
        return [], {"ts": int(time.time()), "ok": 0, "n": "", "source": "", "ms": int((time.time() - t0) * 1000), "error": str(exc)[:200]}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=int, default=DEFAULT_INTERVAL)
    ap.add_argument("--once", action="store_true")
    a = ap.parse_args()
    interval = max(MIN_INTERVAL, a.interval)
    signal.signal(signal.SIGINT, _sig)
    signal.signal(signal.SIGTERM, _sig)
    buf, polls, last_flush, fails = [], [], time.time(), 0
    while True:
        rows, p = poll_once()
        buf += rows
        polls.append(p)
        fails = 0 if p["ok"] else fails + 1
        print(f"{time.strftime('%H:%M:%S')} {'ok ' + str(p['n']) + ' aircraft via ' + p['source'] if p['ok'] else 'error: ' + p['error']}", flush=True)
        if a.once or _stop or time.time() - last_flush >= FLUSH_EVERY:
            logio.append("ac", buf, FIELDS)
            logio.append("polls", polls, logio.POLL_FIELDS)
            buf, polls, last_flush = [], [], time.time()
        if a.once or _stop:
            break
        wait = interval if not fails else min(MAX_BACKOFF, interval * 2 ** fails)
        end = time.time() + wait
        while time.time() < end and not _stop:
            time.sleep(1)
        if _stop:
            logio.append("ac", buf, FIELDS)
            logio.append("polls", polls, logio.POLL_FIELDS)
            break


if __name__ == "__main__":
    main()
