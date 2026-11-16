#!/usr/bin/env bash
# Push each exported dashboard (export/<repo>) to github.com/markandrewjenkins/<repo>.
# Create the empty public repos on GitHub first. Re-run any time after `python tools/export_repos.py`.
# Each published repo refreshes its own data daily, so before pushing we rebase onto GitHub's copy and keep its side
# of any data conflict (it is newer than this folder).
# usage: bash tools/push_repos.sh [repo ...]      (default: all nine)
set -u
cd "$(dirname "$0")/../export"
for r in ${@:-cherry-blossom-watch dark-sky-finder fire-water-rock snowpack-to-tap salish-sea-live toronto-city-pulse california-duck-curve fall-foliage-watch sunday-wander}; do
  echo "== $r"
  ( cd "$r" && git add -A && { git diff --cached --quiet || git commit -q -m "Update from source"; } \
    && { git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/markandrewjenkins/$r.git"; } \
    && { ! git ls-remote --exit-code origin main >/dev/null 2>&1 || { git fetch -q origin && git rebase -q -X ours origin/main; }; } \
    && git push -u origin main ) || echo "!! $r failed: does github.com/markandrewjenkins/$r exist?"
done
