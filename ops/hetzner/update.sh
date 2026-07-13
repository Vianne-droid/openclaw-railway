#!/bin/bash
# Controlled OpenClaw update for the Hetzner box.
# Builds the target version, swaps it in, verifies health, and AUTO-ROLLS-BACK
# to the previous image if the new one fails to come up. Update is NEVER automatic.
# Usage:  /opt/openclaw/update.sh 2026.5.28
set -uo pipefail
NEW="${1:-}"
[ -z "$NEW" ] && { echo "usage: $0 <openclaw-version, e.g. 2026.5.28>"; exit 1; }
UNIT="${OPENCLAW_UNIT:-/etc/systemd/system/openclaw.service}"
BUILD_DIR="${OPENCLAW_BUILD_DIR:-/opt/openclaw/build}"
HEALTH_URL="${OPENCLAW_HEALTH_URL:-http://127.0.0.1:8080/health/ready}"
FAIL_LOG_DIR="${OPENCLAW_FAIL_LOG_DIR:-/opt/openclaw/logs}"
HEALTH_ATTEMPTS="${OPENCLAW_HEALTH_ATTEMPTS:-60}"
HEALTH_INTERVAL_SECONDS="${OPENCLAW_HEALTH_INTERVAL_SECONDS:-6}"
case "$HEALTH_ATTEMPTS:$HEALTH_INTERVAL_SECONDS" in
  *[!0-9:]*|0:*|*:0) echo "[update] invalid health wait settings"; exit 1 ;;
esac
CUR=$(docker exec openclaw sh -c 'if [ -x /opt/openclaw-bin/openclaw ]; then /opt/openclaw-bin/openclaw --version; else openclaw --version; fi' 2>/dev/null | grep -oE '[0-9]{4}\.[0-9]+\.[0-9]+' | head -1)
OLD_IMG=$(grep -oE 'openclaw:[A-Za-z0-9._-]+' "$UNIT" | head -1)
[ -z "$OLD_IMG" ] && { echo "[update] no OpenClaw image found in $UNIT"; exit 1; }
echo "[update] current=$CUR  target=$NEW  rollback-image=$OLD_IMG"
# Real rollback anchor: same-version rebuilds overwrite the OLD_IMG tag, so tag the
# currently-running image by ID before building.
CUR_IMG_ID=$(docker inspect -f '{{.Image}}' openclaw 2>/dev/null || true)
ROLLBACK_IMG="$OLD_IMG"
if [ -n "$CUR_IMG_ID" ]; then
  ROLLBACK_TAG="openclaw:rollback-$(date +%Y%m%d%H%M)"
  if docker tag "$CUR_IMG_ID" "$ROLLBACK_TAG"; then
    ROLLBACK_IMG="$ROLLBACK_TAG"
    echo "[update] rollback anchor: $ROLLBACK_IMG ($CUR_IMG_ID)"
  fi
fi
cd "$BUILD_DIR" || { echo "[update] no build dir $BUILD_DIR"; exit 1; }
cp -f Dockerfile "Dockerfile.bak-pre-$NEW"
sed -i "s/ARG OPENCLAW_VERSION=.*/ARG OPENCLAW_VERSION=$NEW/" Dockerfile
echo "[update] building openclaw:$NEW (~8-10 min; live OP keeps running during build)..."
if ! docker build --build-arg OPENCLAW_VERSION="$NEW" --build-arg INSTALL_BROWSER=true -t "openclaw:$NEW" . ; then
  echo "[update] BUILD FAILED — nothing swapped, still live on $CUR ($OLD_IMG)"; exit 1
fi
echo "[update] swapping systemd unit -> openclaw:$NEW (brief restart)..."
sed -E -i "s#openclaw:[A-Za-z0-9._-]+#openclaw:$NEW#" "$UNIT"
systemctl daemon-reload
systemctl restart openclaw
MAX_HEALTH_WAIT=$((HEALTH_ATTEMPTS * HEALTH_INTERVAL_SECONDS))
echo "[update] waiting for health (up to ${MAX_HEALTH_WAIT}s; first boot may run state migrations)..."
ok=0
for i in $(seq 1 "$HEALTH_ATTEMPTS"); do
  curl -sf -m5 "$HEALTH_URL" >/dev/null 2>&1 && { ok=1; break; }
  sleep "$HEALTH_INTERVAL_SECONDS"
done
if [ "$ok" != 1 ]; then
  FAIL_LOG="$FAIL_LOG_DIR/update-health-failure-${NEW}-$(date -u +%Y%m%dT%H%M%SZ).log"
  mkdir -p "$FAIL_LOG_DIR"
  chmod 700 "$FAIL_LOG_DIR"
  {
    echo "OpenClaw update health failure"
    echo "timestamp_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "target=$NEW"
    echo "rollback=$ROLLBACK_IMG"
    echo
    systemctl status openclaw --no-pager -l || true
    echo
    docker logs --tail 500 openclaw || true
  } >"$FAIL_LOG" 2>&1
  chmod 600 "$FAIL_LOG"
  echo "[update] HEALTH FAILED; diagnostics saved to $FAIL_LOG"
  echo "[update] AUTO-ROLLBACK to $ROLLBACK_IMG"
  sed -E -i "s#openclaw:[A-Za-z0-9._-]+#$ROLLBACK_IMG#" "$UNIT"
  systemctl daemon-reload; systemctl restart openclaw
  echo "[update] rolled back to $ROLLBACK_IMG. Update aborted (your OP is back on the prior image)."
  exit 2
fi
echo "[update] running doctor (official post-update step)..."
timeout 120 docker exec -u openclaw openclaw openclaw doctor 2>&1 | tail -5 || echo "[update] WARN: doctor non-zero/timeout (non-fatal)"
RUN=$(docker exec openclaw sh -c 'if [ -x /opt/openclaw-bin/openclaw ]; then /opt/openclaw-bin/openclaw --version; else openclaw --version; fi' 2>/dev/null)
RELAY=$(docker logs --since 3m openclaw 2>&1 | grep -c "Native hook relay unavailable")
HARNESS=$(docker logs --since 3m openclaw 2>&1 | grep -c "does not support openai")
echo "[update] LIVE: $RUN | relay-errors=$RELAY harness-errors=$HARNESS | rollback image kept: $ROLLBACK_IMG"
if [ "$RELAY" = 0 ] && [ "$HARNESS" = 0 ]; then
  echo "[update] OK clean update to $NEW"
else
  echo "[update] WARN errors present. To roll back:"
  echo "  sed -E -i 's#openclaw:[A-Za-z0-9._-]+#$ROLLBACK_IMG#' $UNIT && systemctl daemon-reload && systemctl restart openclaw"
fi
