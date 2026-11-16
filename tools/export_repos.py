"""Export each dashboard as its own standalone repository.

  python tools/export_repos.py [project ...] [--with-data]     # default: all projects; data files are add-only

This monorepo stays the single source of truth. For every project it writes export/<repo>/ containing only that
dashboard: its pipeline (plus the shared HTTP/ECCC helpers), its data, a one-page Vite site with the dashboard at the
root, a GitHub Actions workflow that refreshes the data daily and publishes to GitHub Pages, and its own README.
Files are rewritten in place, so an existing export (and its .git folder) is updated rather than replaced.
"""
from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "export"
OWNER = "markandrewjenkins"

PROJECTS = {
    "blossom": ("cherry-blossom-watch", "Cherry Blossom Watch"),
    "darksky": ("dark-sky-finder", "Dark Sky Finder"),
    "hazards": ("fire-water-rock", "Fire, Water & Rock"),
    "water": ("snowpack-to-tap", "Snowpack to Tap"),
    "salish": ("salish-sea-live", "Salish Sea Live"),
    "toronto": ("toronto-city-pulse", "Toronto City Pulse"),
    "grid": ("california-duck-curve", "California Duck Curve"),
    "foliage": ("fall-foliage-watch", "Fall Foliage Watch"),
    "sunday": ("sunday-wander", "Sunday Wander"),
    "langford": ("langford-boom-tracker", "Langford Boom Tracker"),
    "blink": ("public-transit", "Public Transit"),     # repo not created yet (was route-95-reliability; Route 95 is now its Greater Victoria set piece)
    # "waves": ("west-coast-water", "West Coast Water"),   # shelved 2026-11-13; code kept in pipelines/waves, site/waves
    "golf": ("fairway-forecast", "Fairway Forecast"),
    "air": ("air-traffic", "Air Traffic"),     # repo not created yet
    "ships": ("waterways", "Waterways"),     # working name; repo not created yet
}
# Data files never exported (no licence stated by the publisher; local preview only until permission is given).
EXCLUDE = {"langford": {"tracker.json", "orthos.json"}}
SKIP = {"__pycache__", ".pytest_cache"}


def copytree(src: Path, dst: Path, *, ignore_raw: bool = False, add_only: bool = False, exclude: set = frozenset()) -> None:
    """Mirror src into dst: copy new and changed files, delete files that no longer exist upstream.
    add_only: copy only files dst doesn't have yet, and delete nothing (for data the published repo refreshes itself)."""
    dst.mkdir(parents=True, exist_ok=True)
    want = set()
    for f in src.rglob("*"):
        rel = f.relative_to(src)
        if any(p in SKIP for p in rel.parts) or (ignore_raw and "raw" in rel.parts) or f.name in exclude:
            continue
        want.add(rel)
        t = dst / rel
        if f.is_dir():
            t.mkdir(parents=True, exist_ok=True)
        elif add_only and t.exists():
            continue
        elif not t.exists() or t.read_bytes() != f.read_bytes():
            t.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, t)
    for name in exclude:                      # remove anything excluded that an earlier export may have copied
        for t in dst.rglob(name):
            t.unlink()
    if add_only:
        return
    for t in sorted(dst.rglob("*"), reverse=True):
        rel = t.relative_to(dst)
        if rel not in want and not any(p in SKIP for p in rel.parts):
            t.rmdir() if t.is_dir() else t.unlink()


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or path.read_text(encoding="utf-8") != text:
        path.write_text(text, encoding="utf-8", newline="\n")


def section(md: str, heading: str) -> str:
    """Body of a '## heading' section of the monorepo README."""
    m = re.search(rf"^## {re.escape(heading)}\n(.*?)(?=^## |\Z)", md, re.S | re.M)
    return m.group(1).strip() if m else ""


def workflow_step(yml: str, title: str) -> str:
    """The project's data-refresh step, or "" for a project whose live data loads in the browser (Dark Sky Finder)."""
    m = re.search(rf'^      - name: "{re.escape(title)}:.*?(?=^      - )', yml, re.S | re.M)
    return m.group(0) if m else ""


def export(proj: str) -> Path:
    repo, title = PROJECTS[proj]
    dst = OUT / repo
    site = dst / "site"
    print(f"{title} → {dst.relative_to(ROOT)}")

    # ---- pipelines: the shared helpers plus this project only
    write(dst / "pipelines" / "__init__.py", (ROOT / "pipelines" / "__init__.py").read_text(encoding="utf-8"))
    copytree(ROOT / "pipelines" / "common", dst / "pipelines" / "common")
    copytree(ROOT / "pipelines" / proj, dst / "pipelines" / proj)
    if (ROOT / "data" / proj).exists():
        copytree(ROOT / "data" / proj, dst / "data" / proj, ignore_raw=True)

    # ---- site: the dashboard becomes the root page
    html = (ROOT / "site" / proj / "index.html").read_text(encoding="utf-8")
    html = html.replace('href="../src/', 'href="./src/').replace('src="../src/', 'src="./src/')
    html = re.sub(r'\s*<a class="crumb" href="\.\./">[^<]*</a>', "", html)
    write(site / "index.html", html)
    copytree(ROOT / "site" / "src" / "shared", site / "src" / "shared")
    copytree(ROOT / "site" / "src" / proj, site / "src" / proj)
    for f in (site / "src" / proj).glob("*.js"):
        js = f.read_text(encoding="utf-8")
        js2 = js.replace('"../data/', '"./data/')                 # data paths resolve against the page, now at the root
        if js2 != js:
            write(f, js2)
    # once published, each repo refreshes its own data daily: don't overwrite it with this folder's older copy
    copytree(ROOT / "site" / "public" / "data" / proj, site / "public" / "data" / proj, add_only=not WITH_DATA,
             exclude=EXCLUDE.get(proj, frozenset()))
    vite = (ROOT / "site" / "vite.config.js").read_text(encoding="utf-8")
    vite = re.sub(r"// Multi-page static site.*?\nconst pages = \[.*?\];",
                  "// One-page static site: the dashboard is index.html; the design system lives in src/shared.\nconst pages = [\"index\"];",
                  vite, flags=re.S)
    vite = vite.replace('p.replace("/index", "")', 'p === "index" ? "main" : p')
    vite = vite.replace("// shared vendor chunks so every project page reuses the cached map and chart libraries",
                        "// vendor chunks cache separately from the dashboard code")
    write(site / "vite.config.js", vite)
    pkg = json.loads((ROOT / "site" / "package.json").read_text(encoding="utf-8"))
    pkg["name"] = repo
    write(site / "package.json", json.dumps(pkg, indent=2) + "\n")
    lock = (ROOT / "site" / "package-lock.json").read_text(encoding="utf-8").replace('"openplaces"', f'"{repo}"')
    write(site / "package-lock.json", lock)

    # ---- repo files
    write(dst / "requirements.txt", (ROOT / "requirements.txt").read_text(encoding="utf-8"))
    write(dst / ".gitignore", ".venv/\nnode_modules/\nsite/dist/\ndata/*/raw/\ndata/osm/\ndata/dem/\n*.log\n__pycache__/\n")
    write(dst / ".gitattributes", "* text=auto\n*.png binary\n*.parquet binary\n")

    yml = (ROOT / ".github" / "workflows" / "refresh.yml").read_text(encoding="utf-8")
    step = workflow_step(yml, title)
    head, rest = yml.split('      - name: "Cherry Blossom Watch', 1)
    tail = rest[rest.index("      - uses: actions/setup-node"):]
    head = head.replace("# Refresh every project's data, rebuild the site and publish it to GitHub Pages.",
                        f"# Refresh {title}'s data, rebuild the site and publish it to GitHub Pages.")
    write(dst / ".github" / "workflows" / "refresh.yml", head + step + tail)

    md = (ROOT / "README.md").read_text(encoding="utf-8")
    row = next(l for l in md.splitlines() if l.startswith("| ") and f"](site/{proj}/)" in l)
    cells = [c.strip() for c in row.strip("|").split("|")]
    blurb, region = cells[1].split(" — ", 1)[1], cells[2]
    skin = next((l for l in md.splitlines() if l.startswith(f"| {title} |")), None)
    skin_name, skin_desc = ([c.strip() for c in skin.strip("|").split("|")][1:3] if skin else ("", ""))
    fetch = "\n".join(l.strip() for l in step.splitlines() if l.strip().startswith("python -m")) \
        or f"python -m pipelines.{proj}.fetch all\npython -m pipelines.{proj}.build"
    fetch = "\n".join(f".venv/Scripts/{l}" for l in fetch.splitlines())
    live = f"https://{OWNER}.github.io/{repo}/"
    readme = f"""# {title}

{blurb[0].upper() + blurb[1:]}. Region: {region}.

**Live dashboard: {live}**

Built only on free, open government and citizen-science data. A Python pipeline fetches and models the data,
and a static Vite + d3 + MapLibre page presents it. GitHub Actions refreshes everything daily and publishes it
to GitHub Pages.

## Method in brief

{section(md, f"{title}: method in brief")}

## Design

The page has a Classic design and a themed alternative, **{skin_name}** ({skin_desc.lower()}), switched with the
button in the top bar or with `?skin=alt` / `?skin=classic` in the URL. Each has a day and a night version.

## Running locally

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # macOS/Linux: .venv/bin/pip
{fetch}
cd site && npm ci && npm run dev
```

Data licences are listed at the foot of the dashboard.
"""
    write(dst / "README.md", readme)
    return dst


WITH_DATA = "--with-data" in sys.argv     # also overwrite existing data files (e.g. after a model change)

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")       # the progress lines use "→"; Windows consoles default to cp1252
    for p in [a for a in sys.argv[1:] if not a.startswith("--")] or list(PROJECTS):
        export(p)
