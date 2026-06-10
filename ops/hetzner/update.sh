#!/bin/bash
# Controlled OpenClaw update for the Hetzner box.
# Builds the target version, swaps it in, verifies health, and AUTO-ROLLS-BACK
# to the previous image if the new one fails to come up. Update is NEVER automatic.
# Usage:  /opt/openclaw/update.sh 2026.5.28
set -uo pipefail
NEW="${1:-}"
[ -z "$NEW" ] && { echo "usage: $0 <openclaw-version, e.g. 2026.5.28>"; exit 1; }
UNIT=/etc/systemd/system/openclaw.service
CUR=$(docker exec openclaw sh -lc 'openclaw --version' 2>/dev/null | grep -oE '[0-9]{4}\.[0-9]+\.[0-9]+' | head -1)
OLD_IMG=$(grep -oE 'openclaw:[0-9.]+' "$UNIT" | head -1)
echo "[update] current=$CUR  target=$NEW  rollback-image=$OLD_IMG"
cd /opt/openclaw/build || { echo "[update] no build dir /opt/openclaw/build"; exit 1; }
cp -f Dockerfile "Dockerfile.bak-pre-$NEW"
sed -i "s/ARG OPENCLAW_VERSION=.*/ARG OPENCLAW_VERSION=$NEW/" Dockerfile
echo "[update] building openclaw:$NEW (~8-10 min; live OP keeps running during build)..."
if ! docker build --build-arg OPENCLAW_VERSION="$NEW" --build-arg INSTALL_BROWSER=true -t "openclaw:$NEW" . ; then
  echo "[update] BUILD FAILED — nothing swapped, still live on $CUR ($OLD_IMG)"; exit 1
fi
echo "[update] swapping systemd unit -> openclaw:$NEW (brief restart)..."
sed -i "s#openclaw:[0-9.]*#openclaw:$NEW#" "$UNIT"
systemctl daemon-reload
systemctl restart openclaw
echo "[update] waiting for health..."
ok=0
for i in $(seq 1 20); do curl -sf -m5 http://127.0.0.1:8080/health >/dev/null 2>&1 && { ok=1; break; }; sleep 6; done
if [ "$ok" != 1 ]; then
  echo "[update] HEALTH FAILED -> AUTO-ROLLBACK to $OLD_IMG"
  sed -i "s#openclaw:[0-9.]*#$OLD_IMG#" "$UNIT"
  systemctl daemon-reload; systemctl restart openclaw
  echo "[update] rolled back to $OLD_IMG. Update aborted (your OP is back on the old version)."
  exit 2
fi
RUN=$(docker exec openclaw sh -lc 'openclaw --version' 2>/dev/null)
RELAY=$(docker logs --since 3m openclaw 2>&1 | grep -c "Native hook relay unavailable")
HARNESS=$(docker logs --since 3m openclaw 2>&1 | grep -c "does not support openai")
echo "[update] LIVE: $RUN | relay-errors=$RELAY harness-errors=$HARNESS | rollback image kept: $OLD_IMG"
if [ "$RELAY" = 0 ] && [ "$HARNESS" = 0 ]; then
  echo "[update] OK clean update to $NEW"
else
  echo "[update] WARN errors present. To roll back:"
  echo "  sed -i 's#openclaw:[0-9.]*#$OLD_IMG#' $UNIT && systemctl daemon-reload && systemctl restart openclaw"
fi
