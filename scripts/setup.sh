#!/usr/bin/env bash
# One-time setup on a new machine: check tools, fetch the dataset at a pinned commit, create .env.
set -euo pipefail
cd "$(dirname "$0")/.."

DATA_REPO="https://github.com/jigjoy-ai/einstein-matchmaker-data.git"
DATA_COMMIT="4fb99b3749adf0d10b5977089ff4c73f4f522240"   # 29 Oct 2026 11:05 CET; update deliberately, note it in PROGRESS.md

need() { command -v "$1" >/dev/null || { echo "missing: $1 ($2)"; exit 1; }; }
need git "install git"
need node "install Node.js 20 or newer"
need npm "comes with Node.js"
need python3 "used by .claude/skills/prenup-dataset/peek.py"
node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || { echo "Node.js 20+ required, found $(node -v)"; exit 1; }

if [ -d data/einstein/.git ]; then
  echo "dataset: present ($(git -C data/einstein rev-parse --short HEAD))"
else
  git clone -q "$DATA_REPO" data/einstein
  git -C data/einstein checkout -q "$DATA_COMMIT"
  echo "dataset: cloned at ${DATA_COMMIT:0:7}"
fi
latest=$(git ls-remote "$DATA_REPO" HEAD 2>/dev/null | cut -f1 || true)
[ -n "$latest" ] && [ "$latest" != "$DATA_COMMIT" ] && echo "note: the dataset repo has a newer commit (${latest:0:7}). Check what changed before moving the pin."

[ -f .env ] || { cp .env.example .env; echo ".env: created from .env.example (add one provider key)"; }
[ -f package.json ] && npm ci --silent && echo "npm: dependencies installed"

python3 -I .claude/skills/prenup-dataset/peek.py schema >/dev/null && echo "peek.py: ok"
echo "ready. Open this folder in Claude Code or Cursor and say: read PROGRESS.md and continue."
