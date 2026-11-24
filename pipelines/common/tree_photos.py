"""Example photos of tree kinds for the Open Places tree pages (blossom, foliage, Garry oaks & arbutus).

  python -m pipelines.common.tree_photos candidates   # fetch candidates + contact sheets for review
  python -m pipelines.common.tree_photos choose       # write the picks (PICKS below) and patch the published data

Sources, each photo credited with its author and licence:
  - iNaturalist observation and taxon photos, only CC0, CC BY or CC BY-NC (api.inaturalist.org, ~1 request/s);
  - Wikimedia Commons files found by search (any free licence Commons accepts, credited).
Thumbnails only: iNaturalist "small"/"medium" (240/500 px) and Commons 330 px.

Outputs:
  pipelines/common/tree_photos.json         curated picks (the small JSON every build reads)
  site/public/data/oaks/photos.json         Garry oak and arbutus examples (leaves, bark, acorns / flowers, berries)
  site/public/data/blossom/cultivars.json   photo of each replaced cultivar (also pipelines/blossom/cultivar_photos.json)
  site/public/data/foliage/foliage.json     photo of each replaced species (foliage build reads the overrides too)
"""
from __future__ import annotations

import io
import json
import sys
import time
from pathlib import Path

import requests

from .http import USER_AGENT, get_json

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "tree_photos" / "raw"
PICKS_JSON = Path(__file__).with_name("tree_photos.json")
INAT = "https://api.inaturalist.org/v1"
OK_LIC = "cc0,cc-by,cc-by-nc"
LIC_NAME = {"cc0": "CC0", "cc-by": "CC BY", "cc-by-nc": "CC BY-NC"}
FLOWERING, FRUITING, COLOURED = (12, 13), (12, 14), (36, 39)      # iNat annotation (term, value)

# key → (page, what, iNat taxon name or id, annotation, months, Commons search)
TARGETS = {
    # Cherry Blossom Watch: in bloom (replacing CC BY-SA picks)
    "blossom:cherryplum": ("blossom", "in bloom", "Prunus cerasifera", FLOWERING, None, None),
    "blossom:wildcherry": ("blossom", "in bloom", "Prunus avium", FLOWERING, None, None),
    "blossom:bittercherry": ("blossom", "in bloom", "Prunus emarginata", FLOWERING, None, None),
    "blossom:chokecherry": ("blossom", "in bloom", "Prunus virginiana", FLOWERING, None, None),
    # Fall Foliage Watch: in fall colour (replacing SA licences and filling gaps)
    "foliage:cornus kousa": ("foliage", "in fall colour", "Cornus kousa", COLOURED, None, "Cornus kousa autumn leaves"),
    "foliage:styrax": ("foliage", "in fall colour", "Styrax japonicus", None, [10, 11], "Styrax japonicus"),
    "foliage:eucommia": ("foliage", "in fall colour", "Eucommia ulmoides", None, [10, 11], None),
    "foliage:halesia": ("foliage", "in fall colour", "Halesia", None, [10, 11], "Halesia autumn"),
    "foliage:maackia": ("foliage", "in fall colour", "Maackia amurensis", None, [10, 11], None),
    # Garry Oaks & Arbutus
    "oaks:oak-leaves": ("oaks", "leaves", 68632, (36, 38), None, None),
    "oaks:oak-acorns": ("oaks", "acorns", 68632, FRUITING, None, None),
    "oaks:oak-bark": ("oaks", "bark", 68632, None, None, "Quercus garryana bark"),
    "oaks:oak-tree": ("oaks", "tree", 68632, None, None, "Quercus garryana"),
    "oaks:arb-flowers": ("oaks", "flowers", 51046, FLOWERING, None, None),
    "oaks:arb-berries": ("oaks", "berries", 51046, FRUITING, None, None),
    "oaks:arb-bark": ("oaks", "bark", 51046, None, None, "Arbutus menziesii bark"),
    "oaks:arb-tree": ("oaks", "tree", 51046, None, None, "Arbutus menziesii"),
}


def _sized(url: str, size: str) -> str:
    for s in ("square", "small", "medium", "large", "original"):
        url = url.replace(f"/{s}.", f"/{size}.")
    return url


def inat_obs(taxon, ann, months, n=12):
    p = {"photo_license": OK_LIC, "quality_grade": "research", "order_by": "votes", "per_page": n, "photos": "true"}
    p["taxon_id" if isinstance(taxon, int) else "taxon_name"] = taxon
    if ann:
        p["term_id"], p["term_value_id"] = ann
    if months:
        p["month"] = ",".join(map(str, months))
    out = []
    for o in get_json(f"{INAT}/observations", p, min_interval=1.1)["results"]:
        ph = (o.get("photos") or [None])[0]
        if not ph or (ph.get("license_code") or "") not in LIC_NAME:
            continue
        out.append({"src": "inat", "url": _sized(ph["url"], "medium"), "thumb": _sized(ph["url"], "small"),
                    "license": LIC_NAME[ph["license_code"]], "credit": ph.get("attribution", ""),
                    "page": f"https://www.inaturalist.org/observations/{o['id']}", "place": o.get("place_guess") or "",
                    "faves": o.get("faves_count", 0)})
    return out


def inat_taxon(taxon_id):
    t = get_json(f"{INAT}/taxa/{taxon_id}", min_interval=1.1)["results"][0]
    out = []
    for tp in t.get("taxon_photos", []):
        ph = tp["photo"]
        if (ph.get("license_code") or "") not in LIC_NAME:
            continue
        out.append({"src": "inat-taxon", "url": _sized(ph["url"], "medium"), "thumb": _sized(ph["url"], "small"),
                    "license": LIC_NAME[ph["license_code"]], "credit": ph.get("attribution", ""),
                    "page": f"https://www.inaturalist.org/photos/{ph['id']}", "place": "", "faves": 0})
    return out


def commons(query, n=10):
    p = {"action": "query", "format": "json", "generator": "search", "gsrsearch": f"{query} filetype:bitmap", "gsrnamespace": 6,
         "gsrlimit": n, "prop": "imageinfo", "iiprop": "url|extmetadata", "iiurlwidth": 330}
    for attempt in range(4):        # Wikimedia asks for a descriptive User-Agent and a gentle pace
        r = requests.get("https://commons.wikimedia.org/w/api.php", params=p, timeout=60,
                         headers={"User-Agent": "openplaces/0.1 (Open Places tree pages: a few example photos, run by hand)"})
        if r.status_code != 429:
            break
        time.sleep(10 * (attempt + 1))
    r.raise_for_status(); time.sleep(3)
    j = r.json()
    out = []
    for pg in sorted((j.get("query") or {}).get("pages", {}).values(), key=lambda x: x.get("index", 0)):
        ii = (pg.get("imageinfo") or [{}])[0]
        md = ii.get("extmetadata", {})
        lic = (md.get("LicenseShortName") or {}).get("value", "")
        if not lic or "fair use" in lic.lower() or "nd" in lic.lower().split("-"):
            continue
        artist = (md.get("Artist") or {}).get("value", "")
        import re
        artist = re.sub(r"<[^>]+>", "", artist).strip() or "Unknown author"
        out.append({"src": "commons", "url": ii.get("thumburl"), "thumb": ii.get("thumburl"), "license": lic,
                    "credit": f"{artist}, {lic}, via Wikimedia Commons", "page": ii.get("descriptionurl"), "place": "", "faves": 0})
    return out


def candidates(only=None):
    """only: list of target keys to refresh (merged into the existing candidates.json)."""
    RAW.mkdir(parents=True, exist_ok=True)
    path = RAW / "candidates.json"
    cand = json.loads(path.read_text(encoding="utf-8")) if only and path.exists() else {}
    taxa = {}
    for key, (_, _, taxon, ann, months, cq) in TARGETS.items():
        if only and key not in only:
            continue
        c = []
        if ann or months or not cq:
            c += inat_obs(taxon, ann, months)
        if cq:
            c += commons(cq)
            if isinstance(taxon, int):
                taxa.setdefault(taxon, inat_taxon(taxon))
                c += taxa[taxon]
        cand[key] = c
        print(f"  {key}: {len(c)} candidates", flush=True)
    path.write_text(json.dumps(cand, indent=1), encoding="utf-8")
    sheets({k: v for k, v in cand.items() if not only or k in only})


def sheets(cand):
    from PIL import Image, ImageDraw
    s = requests.Session(); s.headers["User-Agent"] = USER_AGENT
    out = RAW / "sheets"; out.mkdir(exist_ok=True)
    for key, c in cand.items():
        tiles = []
        for x in c[:16]:
            try:
                r = s.get(x["thumb"], timeout=30); r.raise_for_status()
                im = Image.open(io.BytesIO(r.content)).convert("RGB"); im.thumbnail((240, 240))
            except Exception:
                im = Image.new("RGB", (240, 240), "grey")
            tiles.append(im); time.sleep(0.4)
        if not tiles:
            continue
        cols = 4; rows = (len(tiles) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * 250, rows * 262), "white"); d = ImageDraw.Draw(sheet)
        for i, im in enumerate(tiles):
            x, y = i % cols * 250, i // cols * 262
            sheet.paste(im, (x + 5, y + 5)); d.text((x + 6, y + 247), f"{i} {c[i]['license']}", fill="black")
        sheet.save(out / f"{key.replace(':', '_').replace(' ', '_')}.jpg", quality=80)


# pick → (candidate list, index), chosen from the contact sheets (data/tree_photos/raw/sheets) on 2026-11-23
PICKS: dict[str, tuple[str, int, str]] = {
    "blossom:cherryplum": ("blossom:cherryplum", 8, "in bloom"),
    "blossom:wildcherry": ("blossom:wildcherry", 3, "in bloom"),
    "blossom:bittercherry": ("blossom:bittercherry", 2, "in bloom"),
    "blossom:chokecherry": ("blossom:chokecherry", 10, "in bloom"),
    "foliage:cornus kousa": ("foliage:cornus kousa", 8, "in fall colour"),
    "foliage:styrax": ("foliage:styrax", 4, "in autumn"),
    "foliage:eucommia": ("foliage:eucommia", 8, "in fall colour"),
    "foliage:halesia": ("foliage:halesia", 1, "in fall colour"),
    "foliage:maackia": ("foliage:maackia", 1, "in fall colour"),
    "oaks:oak-leaves": ("oaks:oak-bark", 9, "Leaves"),
    "oaks:oak-bark": ("oaks:oak-bark", 8, "Bark"),
    "oaks:oak-acorns": ("oaks:oak-bark", 11, "Acorns"),
    "oaks:oak-fall": ("oaks:oak-bark", 7, "Leaves in fall"),
    "oaks:arb-leaves": ("oaks:arb-bark", 12, "Leaves"),
    "oaks:arb-bark": ("oaks:arb-bark", 11, "Bark"),
    "oaks:arb-flowers": ("oaks:arb-flowers", 4, "Flowers"),
    "oaks:arb-berries": ("oaks:arb-berries", 2, "Berries"),
}


def author(credit: str) -> str:
    """Just the author: iNat "(c) Name, some rights reserved (CC BY)" / Commons "Name, CC BY-SA 4.0, via Wikimedia Commons"."""
    import re
    c = re.sub(r",? uploaded by .*$", "", credit)
    c = re.sub(r"^\(c\)\s*", "", c)
    c = re.sub(r",\s*(some|all|no) rights reserved.*$", "", c, flags=re.I)
    c = re.sub(r",\s*[^,]*,\s*via Wikimedia Commons$", "", c)
    c = re.sub(r"\s*\((talk|discussion)\)", "", c)
    return c.strip() or "Unknown author"


def choose():
    cand = json.loads((RAW / "candidates.json").read_text(encoding="utf-8"))
    old = json.loads(PICKS_JSON.read_text(encoding="utf-8")) if PICKS_JSON.exists() else {}
    picks = {k: v for k, v in old.items() if k.split(":")[0] in ("btree", "ftree", "otree")}     # whole trees: choose_trees()
    for key, (src, i, what) in PICKS.items():
        x = cand[src][i]
        picks[key] = {"what": what, "thumb": x["thumb"], "url": x["url"], "license": x["license"], "credit": author(x["credit"]),
                      "page": x["page"], "source": "iNaturalist" if x["src"].startswith("inat") else "Wikimedia Commons"}
    PICKS_JSON.write_text(json.dumps(picks, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    apply(picks)


def apply(picks=None):
    picks = picks or json.loads(PICKS_JSON.read_text(encoding="utf-8"))
    # Garry oaks & arbutus (parts, and the whole trees)
    oak = {k.split(":", 1)[1]: v for k, v in picks.items() if k.startswith(("oaks:", "otree:"))}
    (ROOT / "site/public/data/oaks/photos.json").write_text(json.dumps(
        {"note": "Example photos of each kind, not the tree on the map.", "photos": oak}, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    # blossom: curated cultivar photos + published cultivars.json (keep its shape: thumb, page, license, credit, source)
    cpath = ROOT / "pipelines/blossom/cultivar_photos.json"
    cp = json.loads(cpath.read_text(encoding="utf-8"))
    vpath = ROOT / "site/public/data/blossom/cultivars.json"
    cv = json.loads(vpath.read_text(encoding="utf-8"))
    for k, v in picks.items():
        if not k.startswith("blossom:"):
            continue
        ck = k.split(":", 1)[1]
        entry = {"thumb": v["url"], "page": v["page"], "license": v["license"], "credit": v["credit"], "source": "inat"}
        for name, e in cp.items():
            if name == ck or e.get("similar") == ck:
                cp[name] = {**entry, **({"similar": e["similar"]} if e.get("similar") else {})}
        for name, c in cv.items():
            if name == ck or (cp.get(name) or {}).get("similar") == ck:
                c["photo"] = {**(c.get("photo") or {}), **entry}
    bt = tree_overrides("btree", cp)
    for name, c in cv.items():
        if name in bt:
            c["tree"] = bt[name]
        else:
            c.pop("tree", None)
    cpath.write_text(json.dumps(cp, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    vpath.write_text(json.dumps(cv, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    # foliage: species photo {url, attr, license, obs, place, faves}
    fpath = ROOT / "site/public/data/foliage/foliage.json"
    F = json.loads(fpath.read_text(encoding="utf-8"))
    fol = foliage_overrides(picks)
    ft = tree_overrides("ftree")
    for s in F["species"]:
        if s["key"] in fol:
            s["photo"] = fol[s["key"]]
        if s["key"] in ft:
            s["tree"] = ft[s["key"]]
        else:
            s.pop("tree", None)
    fpath.write_text(json.dumps(F, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"  applied {len(picks)} picks", flush=True)


def foliage_overrides(picks=None) -> dict:
    """{species key: foliage.json photo} for the foliage build (pick_photos) and apply()."""
    if picks is None:
        picks = json.loads(PICKS_JSON.read_text(encoding="utf-8")) if PICKS_JSON.exists() else {}
    out = {}
    for k, v in picks.items():
        if k.startswith("foliage:"):
            out[k.split(":", 1)[1]] = {"url": v["url"], "attr": f"{'' if v['license'] in ('CC0', 'Public domain') else '(c) '}{v['credit']} ({v['license']})", "credit": v["credit"], "license": v["license"].lower().replace(" ", "-"),
                                       "page": v["page"], "place": "", "faves": 0}
    return out


# ------------------------------------------------------------------ whole-tree photos (Round 6: the tree first, close-ups second)
TREE_RAW = RAW / "trees"
BLOSSOM_Q = {   # cultivar → Commons search for the tree in bloom (iNat taxon photos are added where a taxon exists)
    "akebono": "Akebono cherry tree", "yoshino": "Prunus yedoensis tree", "kanzan": "Kanzan cherry tree", "shirotae": "Prunus Shirotae tree",
    "ukon": "Prunus Ukon tree", "taihaku": "Prunus Tai Haku tree", "shirofugen": "Prunus Shirofugen tree", "amanogawa": "Prunus Amanogawa",
    "weeping": "weeping cherry tree bloom", "accolade": "Prunus Accolade tree", "pinkperfection": "Prunus Pink Perfection tree",
    "snowgoose": "Prunus Snow Goose tree", "umineko": "Prunus Umineko", "whitcomb": "Prunus Whitcomb", "higan": "Prunus subhirtella Autumnalis tree",
    "sargent": "Prunus sargentii tree", "royalburgundy": "Prunus Royal Burgundy tree", "jpcherry": "Prunus serrulata tree bloom",
    "blireana": "Prunus blireana tree", "purpleplum": "Prunus cerasifera Nigra tree", "cherryplum": "Prunus cerasifera tree flowering",
    "hillier": "Prunus Spire tree", "apricot": "Prunus mume tree", "wildcherry": "Prunus avium tree flowering", "bittercherry": "Prunus emarginata tree",
    "chokecherry": "Prunus virginiana tree flowering", "birdcherry": "Prunus padus tree flowering", "fruitcherry": "Prunus cerasus tree flowering",
    "plum": "Prunus domestica tree flowering", "paperbark": "Prunus serrula tree", "manchurian": "Prunus maackii tree", "cherry": "cherry blossom tree street",
}
BLOSSOM_TAXON = {"yoshino": "Prunus × yedoensis", "kanzan": "Prunus serrulata", "jpcherry": "Prunus serrulata", "sargent": "Prunus sargentii",
                 "cherryplum": "Prunus cerasifera", "purpleplum": "Prunus cerasifera", "apricot": "Prunus mume", "wildcherry": "Prunus avium",
                 "bittercherry": "Prunus emarginata", "chokecherry": "Prunus virginiana", "birdcherry": "Prunus padus", "fruitcherry": "Prunus cerasus",
                 "plum": "Prunus domestica", "paperbark": "Prunus serrula", "manchurian": "Prunus maackii", "weeping": "Prunus pendula"}
OAK_TREE_Q = {"oak-tree": ("Quercus garryana tree", 68632), "oak-tree-bare": ("Quercus garryana winter", None),
              "oak-meadow": ("Garry oak meadow", None), "arb-tree": ("Arbutus menziesii tree", 51046), "arb-trunk": ("Arbutus menziesii trunk", None)}


def inat_taxon_by_name(name):
    r = get_json(f"{INAT}/taxa", {"q": name, "per_page": 1, "is_active": "true"}, min_interval=1.1)["results"]
    return inat_taxon(r[0]["id"]) if r else []


def tree_targets():
    cv = json.loads((ROOT / "site/public/data/blossom/cultivars.json").read_text(encoding="utf-8"))
    F = json.loads((ROOT / "site/public/data/foliage/foliage.json").read_text(encoding="utf-8"))
    t = {}
    for k in cv:
        t[f"btree:{k}"] = (BLOSSOM_Q.get(k, f"{cv[k]['name']} cherry tree"), BLOSSOM_TAXON.get(k))
    for sp in F["species"]:
        latin = sp["key"][0].upper() + sp["key"][1:]
        t[f"ftree:{sp['key']}"] = (f"{latin} tree autumn" if " " in sp["key"] else f"{sp['common']} {latin} tree autumn", sp["key"] if " " in sp["key"] else None)
    for k, (q, tid) in OAK_TREE_Q.items():
        t[f"otree:{k}"] = (q, tid)
    return t


def tree_candidates(only=None):
    """Commons file search for each tree kind + its iNat taxon photos (CC0 / CC BY / CC BY-NC), cached per target."""
    TREE_RAW.mkdir(parents=True, exist_ok=True)
    path = TREE_RAW / "candidates.json"
    cand = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    for key, (q, taxon) in tree_targets().items():
        if (only and not any(key.startswith(o) for o in only)) or (key in cand and not only):
            continue
        c = commons(q, 10)
        try:
            c += inat_taxon(taxon) if isinstance(taxon, int) else inat_taxon_by_name(taxon) if taxon else []
        except Exception as e:      # a missing taxon just means Commons only
            print(f"  {key}: iNat {e}", flush=True)
        cand[key] = c
        path.write_text(json.dumps(cand, indent=1), encoding="utf-8")
        print(f"  {key}: {len(c)}", flush=True)


def tree_sheets(prefix="", per=3, cols=8, start=0, file="candidates.json"):
    """contact sheets, `per` targets each: one row of up to `cols` numbered tiles per target"""
    from PIL import Image, ImageDraw
    cand = json.loads((TREE_RAW / file).read_text(encoding="utf-8"))
    s = requests.Session(); s.headers["User-Agent"] = "openplaces/0.1 (Open Places tree pages: a few example photos, run by hand)"
    out = TREE_RAW / "sheets"; out.mkdir(exist_ok=True)
    keys = [k for k in cand if k.startswith(prefix)]
    tile = 150
    for si in range(start * per, len(keys), per):
        grp = keys[si:si + per]
        sheet = Image.new("RGB", (cols * (tile + 4) + 4, len(grp) * (tile + 34)), "white"); d = ImageDraw.Draw(sheet)
        for gi, k in enumerate(grp):
            y = gi * (tile + 34)
            d.text((4, y + 2), k, fill="black")
            for i, x in enumerate(cand[k][:cols]):
                im = Image.new("RGB", (tile, tile), "grey")
                for attempt in range(4):        # thumbnails are rate limited too: back off and retry
                    try:
                        r = s.get(x["thumb"], timeout=30)
                        if r.status_code == 429:
                            time.sleep(8 * (attempt + 1)); continue
                        r.raise_for_status()
                        im = Image.open(io.BytesIO(r.content)).convert("RGB"); im.thumbnail((tile, tile)); break
                    except Exception:
                        time.sleep(3)
                sheet.paste(im, (4 + i * (tile + 4), y + 14)); d.text((6 + i * (tile + 4), y + 16 + tile), f"{i} {x['license'][:12]}", fill="black")
                time.sleep(0.8)
        sheet.save(out / f"{'' if file == 'candidates.json' else file.split('.')[0] + '_'}{prefix.replace(':', '') or 'all'}_{si // per:02d}.jpg", quality=78)
        print(f"  sheet {si // per}: {', '.join(grp)}", flush=True)


# pick → (candidate list, index[, credit when the source's is unusable]); lists: "btree:…"/"ftree:…"/"otree:…" (trees/candidates.json),
# "x:<query>" (trees/extra_oak.json), "p:btree:…" (trees/pass2.json, a second search for cultivars), "oaks:…" (candidates.json). Chosen from the contact sheets on 2026-11-23.
TREE_PICKS: dict[str, tuple] = {
    "otree:oak-tree": ("oaks:oak-bark", 10),
    "otree:oak-tree-bare": ("x:Oregon white oak tree", 0, "iNaturalist observer (photo 65323285)"),
    "otree:arb-tree": ("x:Pacific madrone tree", 5),
    # blossom cultivars in flower, whole tree (akebono borrows the Yoshino tree: same look, no good Akebono photo)
    "btree:yoshino": ("btree:yoshino", 2),
    "btree:kanzan": ("btree:kanzan", 1),
    "btree:ukon": ("btree:ukon", 0),
    "btree:amanogawa": ("btree:amanogawa", 5),
    "btree:weeping": ("btree:weeping", 4),
    "btree:sargent": ("btree:sargent", 4),
    "btree:jpcherry": ("btree:jpcherry", 0),
    "btree:purpleplum": ("btree:purpleplum", 0),
    "btree:cherryplum": ("btree:cherryplum", 2),
    "btree:apricot": ("btree:apricot", 2),
    "btree:wildcherry": ("btree:wildcherry", 4),
    "btree:birdcherry": ("btree:birdcherry", 1),
    "btree:fruitcherry": ("btree:fruitcherry", 2),
    "btree:plum": ("btree:plum", 4),
    "btree:paperbark": ("btree:paperbark", 3),
    "btree:cherry": ("btree:cherry", 5),
    "btree:akebono": ("btree:yoshino", 2),
    "btree:higan": ("p:btree:higan", 0),
    # foliage species in fall colour, whole tree (red maple's best photo sits in the silver maple search)
    "ftree:liquidambar styraciflua": ("ftree:liquidambar styraciflua", 7),
    "ftree:acer palmatum": ("ftree:acer palmatum", 4),
    "ftree:ginkgo biloba": ("ftree:ginkgo biloba", 4),
    "ftree:parrotia persica": ("ftree:parrotia persica", 0),
    "ftree:nyssa sylvatica": ("ftree:nyssa sylvatica", 2),
    "ftree:acer saccharum": ("ftree:acer saccharum", 7),
    "ftree:oxydendrum arboreum": ("ftree:oxydendrum arboreum", 0),
    "ftree:cercidiphyllum japonicum": ("ftree:cercidiphyllum japonicum", 7),
    "ftree:quercus coccinea": ("ftree:quercus coccinea", 7),
    "ftree:acer griseum": ("ftree:acer griseum", 1),
    "ftree:acer ginnala": ("ftree:acer ginnala", 2),
    "ftree:acer circinatum": ("ftree:acer circinatum", 7),
    "ftree:cornus florida": ("ftree:cornus florida", 7),
    "ftree:cornus kousa": ("ftree:cornus kousa", 0),
    "ftree:pyrus calleryana": ("ftree:pyrus calleryana", 7),
    "ftree:stewartia": ("ftree:stewartia", 0),
    "ftree:larix": ("ftree:larix", 4),
    "ftree:metasequoia glyptostroboides": ("ftree:metasequoia glyptostroboides", 3),
    "ftree:taxodium distichum": ("ftree:taxodium distichum", 5),
    "ftree:zelkova serrata": ("ftree:zelkova serrata", 0),
    "ftree:rhus": ("ftree:rhus", 5),
    "ftree:fraxinus americana": ("ftree:fraxinus americana", 0),
    "ftree:quercus rubra": ("ftree:quercus rubra", 1),
    "ftree:fagus": ("ftree:fagus", 4),
    "ftree:betula": ("ftree:betula", 3),
    "ftree:liriodendron tulipifera": ("ftree:liriodendron tulipifera", 0),
    "ftree:acer campestre": ("ftree:acer campestre", 6),
    "ftree:acer saccharinum": ("ftree:acer saccharinum", 7),
    "ftree:sorbus": ("ftree:sorbus", 4),
    "ftree:carpinus": ("ftree:carpinus", 0),
    "ftree:cotinus": ("ftree:cotinus", 1),
    "ftree:acer platanoides": ("ftree:acer platanoides", 2),
    "ftree:gleditsia triacanthos": ("ftree:gleditsia triacanthos", 7),
    "ftree:tilia": ("ftree:tilia", 0),
    "ftree:ulmus": ("ftree:ulmus", 0),
    "ftree:fraxinus": ("ftree:fraxinus", 7),
    "ftree:fraxinus pennsylvanica": ("ftree:fraxinus pennsylvanica", 0),
    "ftree:juglans": ("ftree:juglans", 0),
    "ftree:populus": ("ftree:populus", 1),
    "ftree:salix": ("ftree:salix", 2),
    "ftree:crataegus": ("ftree:crataegus", 2),
    "ftree:magnolia": ("ftree:magnolia", 0),
    "ftree:quercus": ("ftree:quercus", 0),
    "ftree:quercus garryana": ("ftree:quercus garryana", 5),
    "ftree:acer": ("ftree:acer", 7),
    "ftree:cornus": ("ftree:cornus", 5),
    "ftree:aesculus": ("ftree:aesculus", 2),
    "ftree:platanus": ("ftree:platanus", 7),
    "ftree:catalpa": ("ftree:catalpa", 1),
    "ftree:ailanthus": ("ftree:ailanthus", 0),
    "ftree:morus": ("ftree:morus", 0),
    "ftree:castanea": ("ftree:castanea", 4),
    "ftree:alnus": ("ftree:alnus", 1),
    "ftree:acer rubrum": ("ftree:acer saccharinum", 1),
}


def choose_trees():
    lists = {**json.loads((RAW / "candidates.json").read_text(encoding="utf-8")),
             **json.loads((TREE_RAW / "candidates.json").read_text(encoding="utf-8")),
             **{f"x:{k}": v for k, v in json.loads((TREE_RAW / "extra_oak.json").read_text(encoding="utf-8")).items()},
             **{f"p:{k}": v for k, v in json.loads((TREE_RAW / "pass2.json").read_text(encoding="utf-8")).items()}}
    picks = json.loads(PICKS_JSON.read_text(encoding="utf-8")) if PICKS_JSON.exists() else {}
    picks = {k: v for k, v in picks.items() if k.split(":")[0] not in ("btree", "ftree", "otree")}
    for key, (src, i, *cr) in TREE_PICKS.items():
        x = lists[src][i]
        picks[key] = {"what": "tree", "thumb": x["thumb"], "url": x["url"], "license": x["license"], "credit": cr[0] if cr else author(x["credit"]),
                      "page": x["page"], "source": "iNaturalist" if x["src"].startswith("inat") else "Wikimedia Commons"}
    PICKS_JSON.write_text(json.dumps(picks, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    apply(picks)


def tree_overrides(kind: str, similar_from: dict | None = None) -> dict:
    """{cultivar or species key: whole-tree photo} in the page's photo shape (btree → cultivars.json, ftree → foliage.json).
    similar_from: cultivar_photos.json, so a cultivar that borrows another's close-up borrows its tree too."""
    picks = json.loads(PICKS_JSON.read_text(encoding="utf-8")) if PICKS_JSON.exists() else {}
    out = {}
    for k, v in picks.items():
        if not k.startswith(kind + ":"):
            continue
        name = k.split(":", 1)[1]
        out[name] = ({"thumb": v["url"], "page": v["page"], "license": v["license"], "credit": v["credit"], "source": "inat" if v["source"] == "iNaturalist" else "commons"}
                     if kind == "btree" else {"url": v["url"], "attr": f"{'' if v['license'] in ('CC0', 'Public domain') else '(c) '}{v['credit']} ({v['license']})", "credit": v["credit"], "license": v["license"].lower().replace(" ", "-"), "page": v["page"]})
    for name, e in (similar_from or {}).items():
        if name not in out and e.get("similar") in out:
            out[name] = out[e["similar"]]
    return out


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "candidates"
    if cmd == "candidates":
        candidates(sys.argv[2:] or None)
    elif cmd == "trees":
        tree_candidates(sys.argv[2:] or None)
    elif cmd == "tree-sheets":
        tree_sheets(*(sys.argv[2:3] or [""]))
    else:
        {"choose": choose, "apply": apply, "choose-trees": choose_trees}[cmd]()
