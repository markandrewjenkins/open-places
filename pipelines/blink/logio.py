"""Reading and writing the collector's compact logs.

Layout under data/blink/raw/log/:
    YYYY-MM-DD.<kind>.csv.gz       the open day: gzip members appended every few minutes (one header, first member)
    YYYY-MM-DD/<HHMMSS>.<kind>.csv.gz   "parts" layout (one small file per run, used by the GitHub Actions collector)
    YYYY-MM-DD.<kind>.parquet      a closed day, compacted (deduped, sorted, zstd)

Kinds: vp (vehicle positions), tu (trip-update stop rows near the poll time), trips (trip-level state changes),
polls (one row per poll: coverage and outages), alerts (service alerts for the logged routes, when they change).
"""
from __future__ import annotations

import gzip
import io
import zlib
from pathlib import Path

import pandas as pd

from .config import LOG

KINDS = ("vp", "tu", "trips", "polls", "alerts")
DEDUPE = {
    "vp": ["vehicle", "ts"],
    "tu": ["trip_id", "start_date", "seq", "arr", "dep", "sr"],
    "trips": ["trip_id", "start_date", "sr", "vehicle"],
    "polls": ["obs"],
    "alerts": ["alert_id", "hash"],
}
SORT = {"vp": ["ts"], "tu": ["obs"], "trips": ["obs"], "polls": ["obs"], "alerts": ["obs"]}
STR_COLS = {"route", "trip_id", "start_time", "vehicle", "stop_id", "err", "alert_id", "hash", "cause", "effect",
            "header", "routes", "periods", "stops"}


def gz_member(df: pd.DataFrame, header: bool) -> bytes:
    """One complete gzip member holding `df` as CSV."""
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6, mtime=0) as gz:
        gz.write(df.to_csv(index=False, header=header, lineterminator="\n").encode("utf-8"))
    return buf.getvalue()


def append_csv_gz(path: Path, df: pd.DataFrame) -> None:
    """Append as a new gzip member in a single write; the header is written only when the file is new."""
    if df.empty:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.exists() or path.stat().st_size == 0
    blob = gz_member(df, header=new)
    with open(path, "ab") as f:
        f.write(blob)
        f.flush()


def read_gz_tolerant(path: Path) -> bytes:
    """Decompress every complete gzip member; a truncated last member (crash mid-write) is dropped, not fatal."""
    data = path.read_bytes()
    out, pos = [], 0
    while pos < len(data):
        d = zlib.decompressobj(16 + zlib.MAX_WBITS)
        try:
            chunk = d.decompress(data[pos:])
        except zlib.error:
            break
        if not d.eof:                     # incomplete member at the end of the file
            break
        out.append(chunk)
        used = len(data) - pos - len(d.unused_data)
        pos += used
    text = b"".join(out)
    if text and not text.endswith(b"\n"):  # drop a partial last line
        text = text[: text.rfind(b"\n") + 1]
    return text


def _read_csv_bytes(b: bytes) -> pd.DataFrame:
    if not b.strip():
        return pd.DataFrame()
    df = pd.read_csv(io.BytesIO(b), dtype={c: "string" for c in STR_COLS}, low_memory=False)
    return df


def read_csv_gz(path: Path) -> pd.DataFrame:
    try:
        return _read_csv_bytes(read_gz_tolerant(path))
    except Exception as exc:              # a damaged file must never stop the build or the collector
        print(f"  warning: could not read {path.name}: {exc}", flush=True)
        return pd.DataFrame()


def clean_frame(df: pd.DataFrame, kind: str) -> pd.DataFrame:
    if df.empty:
        return df
    for c in df.columns:
        if c in STR_COLS:
            df[c] = df[c].astype("string")
    keys = [k for k in DEDUPE[kind] if k in df.columns]
    df = df.drop_duplicates(subset=keys, keep="last") if keys else df.drop_duplicates()
    s = [k for k in SORT[kind] if k in df.columns]
    return df.sort_values(s, kind="stable").reset_index(drop=True) if s else df


COMPACT_SORT = {"vp": ["vehicle", "ts"], "tu": ["trip_id", "seq", "obs"], "trips": ["obs"], "polls": ["obs"], "alerts": ["obs"]}
F32 = {"lat", "lon", "bearing", "speed"}
SMALL = {"dir", "seq", "status", "occ", "cong", "sr", "n_stu", "ok", "n_vp", "n_tu", "n_trips", "n_vp_all", "n_tu_all",
         "arr_delay", "dep_delay", "ms"}


def narrow(df: pd.DataFrame) -> pd.DataFrame:
    """Smaller dtypes for archived days (float32 positions are ~0.6 m precise here)."""
    df = df.copy()
    for c in df.columns:
        if c in F32:
            df[c] = df[c].astype("float32")
        elif c in SMALL:
            df[c] = pd.to_numeric(df[c], errors="coerce").astype("Int32")
    return df


def day_files(day: str, kind: str, log: Path = LOG) -> list[Path]:
    files = []
    if (log / f"{day}.{kind}.parquet").exists():
        files.append(log / f"{day}.{kind}.parquet")
    if (log / f"{day}.{kind}.csv.gz").exists():
        files.append(log / f"{day}.{kind}.csv.gz")
    if (log / day).is_dir():
        files += sorted((log / day).glob(f"*.{kind}.csv.gz"))
    return files


def read_day(day: str, kind: str, log: Path = LOG) -> pd.DataFrame:
    frames = []
    for f in day_files(day, kind, log):
        df = pd.read_parquet(f) if f.suffix == ".parquet" else read_csv_gz(f)
        if not df.empty:
            frames.append(df)
    if not frames:
        return pd.DataFrame()
    return clean_frame(pd.concat(frames, ignore_index=True), kind)


def days(log: Path = LOG) -> list[str]:
    out = set()
    if not log.exists():
        return []
    for p in log.iterdir():
        name = p.name
        if len(name) >= 10 and name[4] == "-" and name[7] == "-" and name[:4].isdigit():
            out.add(name[:10])
    return sorted(out)


def read_all(kind: str, log: Path = LOG, since: str | None = None) -> pd.DataFrame:
    frames = [read_day(d, kind, log) for d in days(log) if since is None or d >= since]
    frames = [f for f in frames if not f.empty]
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def compact(day: str, log: Path = LOG) -> dict:
    """Merge a closed day's csv.gz / parts into one parquet per kind and remove the sources."""
    done = {}
    for kind in KINDS:
        srcs = [f for f in day_files(day, kind, log) if f.suffix != ".parquet"]
        if not srcs:
            continue
        df = read_day(day, kind, log)
        target = log / f"{day}.{kind}.parquet"
        if not df.empty:
            df = narrow(df).sort_values([c for c in COMPACT_SORT[kind] if c in df.columns], kind="stable")
            tmp = target.with_suffix(".tmp")
            df.to_parquet(tmp, index=False, compression="zstd", compression_level=9)
            tmp.replace(target)
        for f in srcs:
            f.unlink()
        done[kind] = len(df)
    part_dir = log / day
    if part_dir.is_dir() and not any(part_dir.iterdir()):
        part_dir.rmdir()
    return done
