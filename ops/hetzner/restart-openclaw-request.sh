#!/usr/bin/env bash
set -euo pipefail

REQ=/opt/openclaw/data/control/restart-openclaw.request
LOG=/opt/openclaw/data/control/restart-openclaw.log
CHAT_ID=1048910165

[ -f "$REQ" ] || exit 0
rm -f "$REQ"
echo "$(date -Is) restart requested" >> "$LOG"

BOT_TOKEN=$(python3 - <<'PY'
import json
with open('/opt/openclaw/data/.openclaw/openclaw.json') as f:
    cfg = json.load(f)
print(cfg['channels']['telegram']['accounts']['default']['botToken'])
PY
)

notify() {
  curl -fsS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    --data-urlencode "text=$1" >/dev/null || true
}

systemctl restart openclaw

for i in $(seq 1 45); do
  if docker exec openclaw openclaw health >/dev/null 2>&1; then
    echo "$(date -Is) openclaw healthy after restart" >> "$LOG"
    notify "🦞 Back online after OpenClaw restart."
    exit 0
  fi
  sleep 2
done

echo "$(date -Is) restart happened but health did not pass in 90s" >> "$LOG"
notify "🦞 OpenClaw restart was triggered, but health did not pass within 90s. Check Hetzner."
exit 1
