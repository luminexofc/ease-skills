#!/bin/sh
# Restart contract: bring the preview back after a hibernate/revive.
# Resolve the app root from this script's own location so the same file works
# whatever the checkout path is, rather than assuming an absolute workspace dir.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

# Drop a leftover built-output preview so a stale build never keeps serving.
node scripts/preview.mjs stop || true

if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  exit 0
fi

npm run dev >>/tmp/app-startup.log 2>&1 &
