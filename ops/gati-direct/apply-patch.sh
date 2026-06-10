#!/usr/bin/env bash
# Gati SJE direct-ingress patch applier.
#
# This re-injects the compiled Telegram ingress patch into the active OpenClaw
# dist bundle. It is idempotent and safe to run after `npm install`, package
# upgrades, or any time `gati-sje-healthcheck.sh` reports the compiled patch
# is missing.
#
# Usage:
#   bash scripts/gati-direct/apply-patch.sh           # apply if missing
#   bash scripts/gati-direct/apply-patch.sh --force   # re-apply even if present
#   bash scripts/gati-direct/apply-patch.sh --check   # only verify, no write

set -euo pipefail

MODE="${1:-apply}"
WORKSPACE="/home/openclaw/.openclaw/workspace"
HELPERS="${WORKSPACE}/scripts/gati-direct/canonical-helpers.js"
DIST_DIR="/data/.npm-global/lib/node_modules/openclaw/dist"

if [ ! -f "${HELPERS}" ]; then
    echo "GATI_PATCH_FAIL helpers_missing=${HELPERS}" >&2
    exit 2
fi

# Locate the active Telegram bot dist file.
BOT_FILE=""
for f in "${DIST_DIR}"/bot-*.js; do
    case "$f" in
        *bot-deps-*|*bot-message-context.*|*bot-native-commands.*) continue ;;
    esac
    if grep -q "formatTelegramInboundLogLine" "$f" 2>/dev/null \
       && grep -q "createTelegramMessageProcessor" "$f" 2>/dev/null; then
        BOT_FILE="$f"
        break
    fi
done

if [ -z "$BOT_FILE" ]; then
    echo "GATI_PATCH_FAIL bot_file_not_found dist_dir=${DIST_DIR}" >&2
    exit 3
fi

# Check existing patch status (need BOTH helper and call site).
has_helper=0
has_callsite=0
grep -q "async function tryHandleGatiSjeDirectIngress" "$BOT_FILE" && has_helper=1
grep -q "if (await tryHandleGatiSjeDirectIngress" "$BOT_FILE" && has_callsite=1

if [ "$has_helper" = 1 ] && [ "$has_callsite" = 1 ]; then
    if [ "$MODE" = "--check" ]; then
        echo "GATI_PATCH_OK already_present file=$BOT_FILE"
        exit 0
    fi
    if [ "$MODE" != "--force" ]; then
        echo "GATI_PATCH_OK already_present file=$BOT_FILE"
        exit 0
    fi
fi

if [ "$MODE" = "--check" ]; then
    echo "GATI_PATCH_MISSING file=$BOT_FILE helper=$has_helper callsite=$has_callsite"
    exit 1
fi

# Backup before modifying.
BACKUP="${BOT_FILE}.gati-bak.$(date +%s)"
cp "$BOT_FILE" "$BACKUP"

python3 "${WORKSPACE}/scripts/gati-direct/patch-bot.py" "$BOT_FILE" "$HELPERS"

# Verify patch syntax.
if ! node --check "$BOT_FILE" 2>/dev/null; then
    echo "GATI_PATCH_FAIL syntax_error_after_patch file=$BOT_FILE backup=$BACKUP" >&2
    cp "$BACKUP" "$BOT_FILE"
    exit 20
fi

# Verify call site & helper block both exist.
if ! grep -q "async function tryHandleGatiSjeDirectIngress" "$BOT_FILE"; then
    echo "GATI_PATCH_FAIL helper_missing_after_patch file=$BOT_FILE backup=$BACKUP" >&2
    cp "$BACKUP" "$BOT_FILE"
    exit 21
fi

if ! grep -q "if (await tryHandleGatiSjeDirectIngress" "$BOT_FILE"; then
    echo "GATI_PATCH_FAIL callsite_missing_after_patch file=$BOT_FILE backup=$BACKUP" >&2
    cp "$BACKUP" "$BOT_FILE"
    exit 22
fi

echo "GATI_PATCH_OK applied file=$BOT_FILE backup=$BACKUP"
