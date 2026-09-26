#!/usr/bin/env bash
# dev:reset (#469) — recover from a broken local dev state.
#
# Clears .env.local and node_modules, then re-runs first-time setup
# (recreate .env.local from the example template, reinstall dependencies).
# Contributors who get into a broken local state previously had no
# recovery path other than manually deleting files by hand.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> Resetting local dev environment"

if [ -f .env.local ]; then
  rm -f .env.local
  echo "  - removed .env.local"
fi

if [ -d node_modules ]; then
  rm -rf node_modules
  echo "  - removed node_modules"
fi

if [ -f .env.local.example ]; then
  cp .env.local.example .env.local
  echo "  - recreated .env.local from .env.local.example (fill in values as needed)"
else
  echo "  - .env.local.example not found, skipping .env.local recreation"
fi

echo "==> Reinstalling dependencies"
npm install

echo "==> Done. Run 'npm run dev' to start."
