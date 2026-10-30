#!/usr/bin/env bash
# One-time setup on a new machine: check tools, fetch the dataset at a pinned commit, create .env.
set -euo pipefail
cd "$(dirname "$0")/.."

DATA_REPO="https://github.com/jigjoy-ai/einstein-matchmaker-data.git"
DATA_COMMIT="4fb99b3749adf0d10b5977089ff4c73f4f522240"   # 29 Oct 2026 11:05 CET; update deliberately

need() { command -v "$1" >/dev/null || { echo "missing: $1 ($2)"; exit 1; }; }
need git "install git"
need node "install Node.js 22"
need npm "comes with Node.js"
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 12) ? 0 : 1)' || { echo "Node.js 20.12 or newer required (22 recommended), found $(node -v)"; exit 1; }

if [ -d data/einstein/.git ]; then
  echo "dataset: present ($(git -C data/einstein rev-parse --short HEAD))"
else
  git clone -q "$DATA_REPO" data/einstein
  git -C data/einstein checkout -q "$DATA_COMMIT"
  echo "dataset: cloned at ${DATA_COMMIT:0:7}"
fi
latest=$(git ls-remote "$DATA_REPO" HEAD 2>/dev/null | cut -f1 || true)
[ -n "$latest" ] && [ "$latest" != "$DATA_COMMIT" ] && echo "note: the dataset repo has a newer commit (${latest:0:7}). Check what changed before moving the pin."

[ -f .env ] || { cp .env.example .env; chmod 600 .env; echo ".env: created from .env.example, readable only by you (add one provider key)"; }
[ -f package.json ] && npm ci --silent && echo "npm: dependencies installed"

[ -d data/einstein/data ] || { echo "dataset files missing in data/einstein/data"; exit 1; }
echo "ready. Try: npm run demo -- --replay"
