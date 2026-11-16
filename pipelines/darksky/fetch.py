"""Download raw inputs for Dark Sky Finder.

  python -m pipelines.darksky.fetch [gan|lights|all]
"""
from __future__ import annotations

import io
import re
import sys

import numpy as np
import pandas as pd
import requests
from PIL import Image

from pipelines.common.http import USER_AGENT

from .config import COMPOSITE_DATES, COMPOSITE_YEARS, GAN_YEARS, GIBS_LAYER, GIBS_WMS, RAW, RES_DEG, TRAIN_BBOX

GAN_PAGE = "https://globeatnight.org/maps-data/"
S = requests.Session()
S.headers["User-Agent"] = USER_AGENT


def fetch_gan() -> pd.DataFrame:
    """Globe at Night observations (all years with CSV releases), clipped to the training box."""
    html = S.get(GAN_PAGE, timeout=60).text

    links = {int(y): p for p, y in re.findall(r'href="(/documents/\d+/GaN(\d{4})\.csv)"', html)}
    frames = []
    s, w, n, e = TRAIN_BBOX
    for y in GAN_YEARS:
        if y not in links:
            print(f"  {y}: no CSV release")
            continue
        r = S.get("https://globeatnight.org" + links[y], timeout=120)
        r.raise_for_status()
        df = pd.read_csv(io.BytesIO(r.content), low_memory=False, encoding_errors="replace")
        df.columns = [c.strip() for c in df.columns]
        df = df[(df.Latitude.between(s, n)) & (df.Longitude.between(w, e))].copy()
        df["year"] = y
        frames.append(df)
        print(f"  {y}: {len(df):,} observations in western North America")
    out = pd.concat(frames, ignore_index=True)
    keep = ["ID", "year", "Latitude", "Longitude", "Elevation(m)", "LocalDate", "LocalTime", "UTDate", "UTTime", "LimitingMag", "SQMReading",
            "CloudCover", "Country"]
    out = out[[c for c in keep if c in out.columns]]
    RAW.mkdir(parents=True, exist_ok=True)
    out.to_parquet(RAW / "gan.parquet", index=False)
    return out


def _wms(bbox: tuple[float, float, float, float], date: str, width: int, height: int) -> np.ndarray | None:
    s, w, n, e = bbox
    r = S.get(GIBS_WMS, params={
        "SERVICE": "WMS", "REQUEST": "GetMap", "VERSION": "1.3.0", "LAYERS": GIBS_LAYER, "CRS": "EPSG:4326",
        "BBOX": f"{s},{w},{n},{e}", "WIDTH": width, "HEIGHT": height, "FORMAT": "image/png", "TIME": date}, timeout=180)
    if r.status_code != 200 or not r.headers.get("content-type", "").startswith("image"):
        return None
    return np.array(Image.open(io.BytesIO(r.content)).convert("L"))


def fetch_lights() -> None:
    """Median night-light composites per year on a RES_DEG grid over the training box."""
    s, w, n, e = TRAIN_BBOX
    ny, nx = round((n - s) / RES_DEG), round((e - w) / RES_DEG)
    tile = 1300
    for year in COMPOSITE_YEARS:
        stack = []
        for md in COMPOSITE_DATES:
            img = np.zeros((ny, nx), dtype=np.uint8)
            ok = True
            for y0 in range(0, ny, tile):
                for x0 in range(0, nx, tile):
                    hh, ww = min(tile, ny - y0), min(tile, nx - x0)
                    tb = (n - (y0 + hh) * RES_DEG, w + x0 * RES_DEG, n - y0 * RES_DEG, w + (x0 + ww) * RES_DEG)
                    a = _wms(tb, f"{year}-{md}", ww, hh)
                    if a is None:
                        ok = False
                        break
                    img[y0:y0 + hh, x0:x0 + ww] = a
                if not ok:
                    break
            if ok and img.mean() > 0.5:
                stack.append(img)
                print(f"  {year}-{md}: mean index {img.mean():.2f}")
            else:
                print(f"  {year}-{md}: unavailable")
        comp = np.median(np.stack(stack), axis=0).astype(np.uint8)
        RAW.mkdir(parents=True, exist_ok=True)
        np.save(RAW / f"lights_{year}.npy", comp)
        print(f"  composite {year}: {len(stack)} dates, shape {comp.shape}")


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what in ("gan", "all"):
        fetch_gan()
    if what in ("lights", "all"):
        fetch_lights()
