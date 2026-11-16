"""ESA WorldCover 2021 land cover at 10 m (class 10 = tree cover), cropped to each region.

Public on AWS without login: https://registry.opendata.aws/esa-worldcover-vito/  Licence: CC BY 4.0,
"© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium".
The 3° × 3° tiles are 50–75 MB; they're downloaded once, cropped to the region box (a few MB as .npz), and the crop is
what the build reads. The product is a fixed 2021 snapshot, so there's nothing to refresh.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import requests

from pipelines.common.http import USER_AGENT

URL = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{t}_Map.tif"
RES = 1 / 12000      # degrees per cell (10 m at the equator)


def _tile_name(lat0: int, lon0: int) -> str:
    return f"{'N' if lat0 >= 0 else 'S'}{abs(lat0):02d}{'E' if lon0 >= 0 else 'W'}{abs(lon0):03d}"


def _download(name: str, cache: Path) -> Path:
    cache.mkdir(parents=True, exist_ok=True)
    f = cache / f"{name}.tif"
    if f.exists():
        return f
    with requests.get(URL.format(t=name), headers={"User-Agent": USER_AGENT}, stream=True, timeout=900) as r:
        r.raise_for_status()
        tmp = f.with_suffix(".part")
        with open(tmp, "wb") as out:
            for chunk in r.iter_content(1 << 20):
                out.write(chunk)
        tmp.replace(f)
    print(f"    downloaded WorldCover {name} ({f.stat().st_size / 1e6:.0f} MB)", flush=True)
    return f


def _window(path: Path, r0: int, r1: int, c0: int, c1: int) -> np.ndarray:
    """Rows r0:r1, cols c0:c1 of a tiled single-band GeoTIFF, decoding only the tiles that overlap."""
    import tifffile
    out = np.zeros((r1 - r0, c1 - c0), dtype=np.uint8)
    with tifffile.TiffFile(path) as tf:
        p = tf.pages[0]
        tw, tl = p.tilewidth, p.tilelength
        ntx = math.ceil(p.imagewidth / tw)
        fh = tf.filehandle
        for ty in range(r0 // tl, (r1 - 1) // tl + 1):
            for tx in range(c0 // tw, (c1 - 1) // tw + 1):
                i = ty * ntx + tx
                fh.seek(p.dataoffsets[i])
                data = fh.read(p.databytecounts[i])
                seg, _, _ = p.decode(data, i)
                seg = np.asarray(seg).reshape(tl, tw)
                y0, x0 = ty * tl, tx * tw
                ys, ye = max(r0, y0), min(r1, y0 + tl)
                xs, xe = max(c0, x0), min(c1, x0 + tw)
                out[ys - r0:ye - r0, xs - c0:xe - c0] = seg[ys - y0:ye - y0, xs - x0:xe - x0]
    return out


def crop(bbox, cache: Path, dest: Path) -> Path:
    """Write dest (.npz: cls uint8, lon0/lat0 of the top-left corner, res) covering bbox (s, w, n, e)."""
    s, w, n, e = bbox
    lat_tl, lon_tl = n, w
    H, W = int(math.ceil((n - s) / RES)), int(math.ceil((e - w) / RES))
    out = np.zeros((H, W), dtype=np.uint8)
    for la in range(int(math.floor(s / 3) * 3), int(math.floor(n / 3) * 3) + 1, 3):
        for lo in range(int(math.floor(w / 3) * 3), int(math.floor(e / 3) * 3) + 1, 3):
            f = _download(_tile_name(la, lo), cache)
            # tile covers lat la..la+3, lon lo..lo+3; its top-left is (lo, la+3)
            ts, tw_, tn, te = max(s, la), max(w, lo), min(n, la + 3), min(e, lo + 3)
            if ts >= tn or tw_ >= te:
                continue
            r0, r1 = int(round((la + 3 - tn) / RES)), int(round((la + 3 - ts) / RES))
            c0, c1 = int(round((tw_ - lo) / RES)), int(round((te - lo) / RES))
            blk = _window(f, r0, r1, c0, c1)
            R0, C0 = int(round((lat_tl - tn) / RES)), int(round((tw_ - lon_tl) / RES))
            hh, ww = min(blk.shape[0], H - R0), min(blk.shape[1], W - C0)
            out[R0:R0 + hh, C0:C0 + ww] = blk[:hh, :ww]
    dest.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(dest, cls=out, lon0=lon_tl, lat0=lat_tl, res=RES)
    print(f"    WorldCover crop {dest.name}: {W}×{H}, tree cover {(out == 10).mean():.0%}", flush=True)
    return dest
