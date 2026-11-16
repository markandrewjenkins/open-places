"""Download raw inputs for Air Traffic (air traffic).

  python -m pipelines.air.fetch [daily|snapshot|metar|airports ...] [--force]

snapshot   one poll of every aircraft in the home circle (adsb.lol, fallback adsb.fi), appended to the log
metar      latest METAR and TAF for the stations in config.METAR_IDS (NOAA Aviation Weather Center)
airports   OurAirports airports, runways and frequencies (public domain), reused until a week old
daily      all three

Each source runs on its own: a failure is recorded in data/air/raw/status.json (and as a GitHub Actions warning) and
the others still run. No accounts or keys.
"""
from __future__ import annotations

import json
import os
import sys
import time
import traceback
from datetime import datetime, timezone

from . import logio
from .collect import poll_once
from .config import METAR_IDS, OURAIRPORTS, OURAIRPORTS_MAX_AGE_DAYS, RAW
from .feeds import FIELDS, S, metar_taf

FORCE = "--force" in sys.argv


def snapshot() -> dict:
    rows, p = poll_once()
    logio.append("ac", rows, FIELDS)
    logio.append("polls", [p], logio.POLL_FIELDS)
    if not p["ok"]:
        raise RuntimeError(p["error"])
    return {"aircraft": p["n"], "source": p["source"]}


def metar() -> dict:
    j = metar_taf(METAR_IDS)
    RAW.mkdir(parents=True, exist_ok=True)
    (RAW / "metar.json").write_text(json.dumps(j), encoding="utf-8")
    return {"metar": len(j["metar"]), "taf": len(j["taf"])}


def airports() -> dict:
    out = RAW / "ourairports"
    out.mkdir(parents=True, exist_ok=True)
    got = {}
    for name in ("airports", "runways", "airport-frequencies"):
        f = out / f"{name}.csv"
        if f.exists() and not FORCE and time.time() - f.stat().st_mtime < OURAIRPORTS_MAX_AGE_DAYS * 86400:
            got[name] = "cached"
            continue
        r = S.get(OURAIRPORTS.format(name=name), timeout=120)
        r.raise_for_status()
        f.write_bytes(r.content)
        got[name] = len(r.content)
        time.sleep(1)
    return got


SOURCES = {"snapshot": snapshot, "metar": metar, "airports": airports}


def record(name: str, ok: bool, info: dict | None = None, error: str | None = None) -> None:
    f = RAW / "status.json"
    RAW.mkdir(parents=True, exist_ok=True)
    s = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    e = s.get(name, {})
    e.update({"last_try": now, "ok": ok, "error": error})
    if ok:
        e.update({"last_ok": now, "info": info})
    s[name] = e
    f.write_text(json.dumps(s, indent=1), encoding="utf-8")


def main(argv: list[str]) -> int:
    names = [a for a in argv if not a.startswith("--")] or ["daily"]
    if "daily" in names or "all" in names:
        names = list(SOURCES)
    bad = 0
    for n in names:
        try:
            info = SOURCES[n]()
            record(n, True, info)
            print(f"{n}: ok {info}")
        except Exception as exc:  # noqa: BLE001
            bad += 1
            record(n, False, error=str(exc)[:300])
            traceback.print_exc()
            if os.environ.get("GITHUB_ACTIONS"):
                print(f"::warning title=air {n}::{str(exc)[:200]}")
    return 0 if bad < len(names) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
