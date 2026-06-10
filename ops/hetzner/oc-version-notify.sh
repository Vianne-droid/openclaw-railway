#!/bin/bash
# Daily check: is a newer OpenClaw version on npm than what's running?
# If yes, send ONE Telegram notification to Dhruvit (notify only — never auto-updates).
# De-dupes via /opt/openclaw/.last-notified-version so you get one ping per new version.
set -uo pipefail
RUNNING=$(docker exec openclaw sh -lc 'openclaw --version' 2>/dev/null | grep -oE '[0-9]{4}\.[0-9]+\.[0-9]+' | head -1)
LATEST=$(docker exec openclaw sh -lc 'npm view openclaw version 2>/dev/null' | grep -oE '[0-9]{4}\.[0-9]+\.[0-9]+' | head -1)
[ -z "$RUNNING" ] && exit 0
[ -z "$LATEST" ] && exit 0
[ "$RUNNING" = "$LATEST" ] && exit 0
# higher-of-the-two check (don't notify if running is somehow ahead of npm)
HIGH=$(printf '%s\n%s\n' "$RUNNING" "$LATEST" | sort -V | tail -1)
[ "$HIGH" = "$RUNNING" ] && exit 0
# de-dup: only notify once per new version
LAST=$(cat /opt/openclaw/.last-notified-version 2>/dev/null || true)
[ "$LAST" = "$LATEST" ] && exit 0
TOKEN=$(docker exec openclaw sh -lc 'python3 -c "import json;print(json.load(open(\"/data/.openclaw/openclaw.json\"))[\"channels\"][\"telegram\"][\"accounts\"][\"default\"][\"botToken\"])"' 2>/dev/null)
[ -z "$TOKEN" ] && { echo "no bot token"; exit 0; }
MSG="🦞 OpenClaw update available: you're on ${RUNNING}, latest is ${LATEST}. Auto-update is OFF. When you want it: SSH in and run  /opt/openclaw/update.sh ${LATEST}  (builds, swaps, verifies, auto-rolls-back on failure), or just ask Claude/OP."
if curl -s --max-time 20 "https://api.telegram.org/bot${TOKEN}/sendMessage" --data-urlencode chat_id=1048910165 --data-urlencode "text=${MSG}" | grep -q '"ok":true'; then
  echo "$LATEST" > /opt/openclaw/.last-notified-version
  echo "notified: $RUNNING -> $LATEST"
else
  echo "notify send failed (will retry next run)"
fi
