#!/bin/bash
# Vianne CRM staleness alerter (Option 0) — READ-ONLY freshness watchdog.
# Reads the CRM snapshot + refresh-status, recomputes ages NOW, and sends ONE internal Telegram to
# Dhruvit ONLY when the snapshot/sources are stale or the last refresh failed/aborted. It NEVER
# touches buyers, NEVER refreshes data, NEVER edits config, NEVER restarts anything. Quiet when fresh.
# Mirrors /opt/openclaw/oc-version-notify.sh. DRY_RUN=1 prints the decision instead of sending.
# Env overrides: SNAP_STALE_DAYS (default 2).
set -uo pipefail
SNAP=/opt/openclaw/data/crm/crm-snapshot.json
STATUS=/opt/openclaw/data/crm/crm-refresh-status.json
LOG=/opt/openclaw/crm-stale-notify.log
STATE=/opt/openclaw/crm-stale-notify.state
SNAP_STALE_DAYS=${SNAP_STALE_DAYS:-2}
# Re-alert interval for a STILL-unresolved same problem (default 6h). Lets this run
# every ~20 min (fast build-failure detection) without spamming: a given problem
# alerts once, then at most every REALERT_SECONDS until it changes or clears.
REALERT_SECONDS=${REALERT_SECONDS:-21600}
CHAT_ID=1048910165
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
NOW_EPOCH=$(date -u +%s)

DECISION=$(python3 - "$SNAP" "$STATUS" "$SNAP_STALE_DAYS" <<'PY'
import json, sys, datetime
snap_path, status_path, snap_thr = sys.argv[1], sys.argv[2], float(sys.argv[3])
now = datetime.datetime.now(datetime.timezone.utc)
def age_days(iso):
    if not iso: return None
    try:
        t = datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except Exception:
        return None
    if t.tzinfo is None: t = t.replace(tzinfo=datetime.timezone.utc)
    return (now - t).total_seconds() / 86400.0
try:
    s = json.load(open(snap_path))
except Exception:
    print("STALE\t\U0001FAB8 Vianne CRM snapshot is unreadable on the box - rebuild/redeploy needed (npm run crm:refresh -- --deploy on the Mac)."); sys.exit(0)
reasons = []
sa = age_days(s.get("generatedAt"))
if sa is not None and sa > snap_thr:
    reasons.append("snapshot %.1fd old (built %s)" % (sa, str(s.get("generatedAt"))[:10]))
for x in (s.get("source_freshness") or {}).get("sources") or []:
    if x.get("wired") is False or not x.get("loaded"): continue
    a = age_days(x.get("last_refresh")); thr = x.get("threshold_days")
    if a is not None and thr is not None and a > thr:
        reasons.append("%s %.0fd>%sd" % (x.get("source"), a, thr))
try:
    run = (json.load(open(status_path)).get("run") or {})
    if run.get("ok") is False:
        reasons.append("last refresh %s" % ("ABORTED" if run.get("aborted") else "FAILED"))
except Exception:
    pass
if not reasons:
    print("FRESH"); sys.exit(0)
print("STALE\t\U0001FAB8 Vianne CRM freshness: " + "; ".join(reasons) + ". Refresh on the Mac:  npm run crm:refresh -- --deploy  (or ask Claude/OP).")
PY
)

KIND=${DECISION%%$'\t'*}
MSG=${DECISION#*$'\t'}
if [ "$KIND" = "FRESH" ] || [ -z "$KIND" ]; then
  printf '{"fingerprint":"ok","last_sent_epoch":0}\n' > "$STATE" 2>/dev/null || true
  echo "{\"ts\":\"$STAMP\",\"event\":\"crm-stale-notify\",\"status\":\"fresh\"}" >> "$LOG"
  exit 0
fi

# STALE — dedupe so this can run every ~20 min without spamming: alert when the problem
# is NEW/changed, or when REALERT_SECONDS have passed since the last send for the SAME
# problem. (A persisting problem re-pings every REALERT_SECONDS until it clears.)
FP=$(printf '%s' "$MSG" | tr -d '0-9.' | md5sum | cut -d' ' -f1)  # identity, not exact age
PREV_FP=""; PREV_TS=0
if [ -r "$STATE" ]; then
  PREV_FP=$(python3 -c "import json;print(json.load(open('$STATE')).get('fingerprint',''))" 2>/dev/null || echo "")
  PREV_TS=$(python3 -c "import json;print(int(json.load(open('$STATE')).get('last_sent_epoch',0)))" 2>/dev/null || echo 0)
fi
if [ "$FP" = "$PREV_FP" ] && [ $((NOW_EPOCH - PREV_TS)) -lt "$REALERT_SECONDS" ]; then
  echo "{\"ts\":\"$STAMP\",\"event\":\"crm-stale-notify\",\"status\":\"deduped\"}" >> "$LOG"
  exit 0
fi
if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "[DRY_RUN] stale — would send: $MSG"
  echo "{\"ts\":\"$STAMP\",\"event\":\"crm-stale-notify\",\"status\":\"stale_dryrun\"}" >> "$LOG"
  exit 0
fi
TOKEN=$(docker exec openclaw sh -lc 'python3 -c "import json;print(json.load(open(\"/data/.openclaw/openclaw.json\"))[\"channels\"][\"telegram\"][\"accounts\"][\"default\"][\"botToken\"])"' 2>/dev/null)
[ -z "$TOKEN" ] && { echo "{\"ts\":\"$STAMP\",\"event\":\"crm-stale-notify\",\"status\":\"no_token\"}" >> "$LOG"; exit 0; }
if curl -s --max-time 20 "https://api.telegram.org/bot${TOKEN}/sendMessage" --data-urlencode chat_id=${CHAT_ID} --data-urlencode "text=${MSG}" | grep -q '"ok":true'; then
  printf '{"fingerprint":"%s","last_sent_epoch":%s}\n' "$FP" "$NOW_EPOCH" > "$STATE" 2>/dev/null || true
  echo "{\"ts\":\"$STAMP\",\"event\":\"crm-stale-notify\",\"status\":\"alerted\"}" >> "$LOG"
else
  echo "{\"ts\":\"$STAMP\",\"event\":\"crm-stale-notify\",\"status\":\"send_failed\"}" >> "$LOG"
fi
