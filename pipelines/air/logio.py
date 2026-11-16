"""The aircraft log: one gzip CSV per UTC day of trimmed positions, plus one row per poll (success, count, source).

Rows are appended as complete gzip members, so a crash loses at most the unflushed buffer and a torn last member is
skipped on read.
"""
from __future__ import annotations

import csv
import gzip
import io
import zlib
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from .config import LOG
from .feeds import FIELDS

POLL_FIELDS = ["ts", "ok", "n", "source", "ms", "error"]


def _day(ts: int) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")


def append(kind: str, rows: list[dict], fields: list[str], log: Path = LOG) -> None:
    """Append rows (grouped by UTC day of their ts) to <log>/<kind>-<day>.csv.gz as one gzip member per day."""
    if not rows:
        return
    log.mkdir(parents=True, exist_ok=True)
    by_day: dict[str, list[dict]] = {}
    for r in rows:
        by_day.setdefault(_day(int(r["ts"])), []).append(r)
    for day, rs in by_day.items():
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
        for r in rs:
            w.writerow(r)
        with open(log / f"{kind}-{day}.csv.gz", "ab") as f:
            f.write(gzip.compress(buf.getvalue().encode("utf-8")))


def _read_members(path: Path) -> str:
    """Decode concatenated gzip members, stopping quietly at a torn last member."""
    data, out = path.read_bytes(), []
    while data:
        d = zlib.decompressobj(16 + zlib.MAX_WBITS)
        try:
            out.append(d.decompress(data))
        except zlib.error:
            break
        if not d.eof:
            break
        data = d.unused_data
    return b"".join(out).decode("utf-8", "replace")


def read(kind: str, fields: list[str], log: Path = LOG) -> pd.DataFrame:
    frames = []
    for p in sorted(log.glob(f"{kind}-*.csv.gz")):
        text = _read_members(p)
        if text.strip():
            frames.append(pd.read_csv(io.StringIO(text), names=fields, header=None, keep_default_na=False,
                                      na_values={"alt": [""], "gs": [""], "track": [""], "vr": [""], "ms": [""], "n": [""]}))
    if not frames:
        return pd.DataFrame(columns=fields)
    return pd.concat(frames, ignore_index=True)


def read_positions(log: Path = LOG) -> pd.DataFrame:
    return read("ac", FIELDS, log)


def read_polls(log: Path = LOG) -> pd.DataFrame:
    return read("polls", POLL_FIELDS, log)
