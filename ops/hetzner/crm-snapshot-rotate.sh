#!/bin/bash
# Daily dated backup of the CRM snapshot + python-universe outputs → on-box restore points.
# Keeps 14 days. Protects against a bad build / accidental delete. (NOT box loss — that's the
# off-box ~/vianne-box-backups tarball + the offsite-DR TODO.) Read-only w.r.t. the live files.
# Cron (host root): 42 7 * * * /opt/openclaw/crm-snapshot-rotate.sh >/dev/null 2>&1  (after the 07:10 deep)
set -uo pipefail
SRC=/opt/openclaw/data/crm
DST="$SRC/backups"
DAY=$(date -u +%Y%m%d)
mkdir -p "$DST"
for f in crm-snapshot.json customer-universe-rebuilt.json customer-universe-audit.json crm-refresh-status.json; do
  [ -f "$SRC/$f" ] && cp "$SRC/$f" "$DST/${f%.json}-$DAY.json"
done
chown -R 1001:1001 "$DST" 2>/dev/null || true
chmod 600 "$DST"/*.json 2>/dev/null || true
# prune backups older than 14 days
find "$DST" -name '*.json' -type f -mtime +14 -delete 2>/dev/null || true
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"crm-snapshot-rotate\",\"day\":\"$DAY\",\"kept\":$(find "$DST" -name '*.json' -type f | wc -l | tr -d ' ')}"
