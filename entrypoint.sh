#!/bin/bash
set -e

# ==============================================================================
# OpenClaw Railway Template - Entrypoint Script
# Handles Railway PORT binding and graceful startup
# ==============================================================================

# Railway provides PORT environment variable
if [ -n "$PORT" ]; then
    echo "Railway environment detected"
    echo "Binding wrapper server to port $PORT"

    # Show available access points if private networking is available
    if [ -n "$RAILWAY_PRIVATE_DOMAIN" ]; then
        echo ""
        echo "Service accessible at:"
        echo "  - Public: via your Railway public domain"
        echo "  - Private: http://$RAILWAY_PRIVATE_DOMAIN:$PORT"
        echo ""
        echo "IMPORTANT: Always include :$PORT when connecting via private networking!"
        echo ""
    fi
else
    # Fallback for local development
    export PORT=8080
    echo "Local development mode"
    echo "Using default port $PORT"
fi

# Fix volume ownership (Railway mounts volumes as root)
# Only fix /data (the volume mount). /app and openclaw npm install are baked
# into the image with correct ownership — no need to chown them at runtime.
# Skip node_modules trees (thousands of files) to keep startup fast (<5s).
if [ "$(id -u)" = "0" ]; then
    find /data -not -path "*/node_modules/*" -exec chown openclaw:openclaw {} + 2>/dev/null || true
fi

# Ensure Playwright browser is accessible by openclaw user
if [ -d "/ms-playwright" ]; then
    chmod -R o+rx /ms-playwright 2>/dev/null || true
fi

# Ensure data directories exist with correct permissions
mkdir -p "$OPENCLAW_STATE_DIR" "$OPENCLAW_WORKSPACE_DIR" "$OPENCLAW_WORKSPACE_DIR/memory" "$OPENCLAW_STATE_DIR/workspace/memory"
chmod 700 "$OPENCLAW_STATE_DIR" "$OPENCLAW_WORKSPACE_DIR" 2>/dev/null || true

# Ensure npm global prefix directory exists for in-app upgrades
NPM_PREFIX="${NPM_CONFIG_PREFIX:-/data/.npm-global}"
NPM_MODULE_DIR="$NPM_PREFIX/lib/node_modules/openclaw"
NPM_ENTRY="$NPM_MODULE_DIR/dist/entry.js"
NPM_BIN_DIR="$NPM_PREFIX/bin"
NPM_BIN="$NPM_BIN_DIR/openclaw"
BAKED_MODULE_DIR="/usr/local/lib/node_modules/openclaw"
BAKED_ENTRY="$BAKED_MODULE_DIR/dist/entry.js"
SEED_MARKER="$NPM_PREFIX/.openclaw-seeded-version"

mkdir -p "$NPM_PREFIX"

# Fix ownership of newly created directories
if [ "$(id -u)" = "0" ]; then
    find /data -maxdepth 2 -not -path "*/node_modules/*" -exec chown openclaw:openclaw {} + 2>/dev/null || true
fi

# Seed the persistent npm prefix from the Docker-baked install on first boot.
# If the prefix was auto-seeded previously and still matches that seeded
# version, refresh it on redeploys so new image versions become active.
# If the runtime version differs from the seed marker, treat it as user-managed
# and leave it alone.
SEEDED_NPM_PREFIX="false"
BAKED_VERSION="$(node -e "try{const p=require(process.argv[1]);process.stdout.write(p.version||'')}catch{}" "$BAKED_MODULE_DIR/package.json")"
RUNTIME_VERSION=""
SEEDED_VERSION=""

seed_persistent_openclaw() {
    local temp_module_dir="$NPM_PREFIX/lib/node_modules/.openclaw-seed-$$"
    local temp_bin="$NPM_BIN_DIR/.openclaw-seed-bin-$$"
    local backup_module_dir="$NPM_PREFIX/lib/node_modules/.openclaw-backup-$$"
    local backup_bin="$NPM_BIN_DIR/.openclaw-backup-bin-$$"

    mkdir -p "$NPM_PREFIX/lib/node_modules" "$NPM_BIN_DIR"
    rm -rf "$temp_module_dir" "$backup_module_dir"
    rm -f "$temp_bin" "$backup_bin"

    if ! cp -a "$BAKED_MODULE_DIR" "$temp_module_dir"; then
        rm -rf "$temp_module_dir"
        rm -f "$temp_bin"
        return 1
    fi

    if ! cat > "$temp_bin" <<'EOF'
#!/bin/bash
PREFIX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$PREFIX_DIR/lib/node_modules/openclaw/dist/entry.js" "$@"
EOF
    then
        rm -rf "$temp_module_dir"
        rm -f "$temp_bin"
        return 1
    fi

    if ! chmod +x "$temp_bin"; then
        rm -rf "$temp_module_dir"
        rm -f "$temp_bin"
        return 1
    fi

    if [ -e "$NPM_MODULE_DIR" ] && ! mv "$NPM_MODULE_DIR" "$backup_module_dir"; then
        rm -rf "$temp_module_dir"
        rm -f "$temp_bin"
        return 1
    fi

    if [ -e "$NPM_BIN" ] && ! mv "$NPM_BIN" "$backup_bin"; then
        if [ -e "$backup_module_dir" ]; then
            mv "$backup_module_dir" "$NPM_MODULE_DIR" || true
        fi
        rm -rf "$temp_module_dir"
        rm -f "$temp_bin"
        return 1
    fi

    if mv "$temp_module_dir" "$NPM_MODULE_DIR" && mv "$temp_bin" "$NPM_BIN"; then
        if ! printf '%s\n' "$BAKED_VERSION" > "$SEED_MARKER"; then
            echo "WARNING: Failed to write OpenClaw seed marker at $SEED_MARKER" >&2
        fi
        rm -rf "$backup_module_dir"
        rm -f "$backup_bin"
        return 0
    fi

    rm -rf "$NPM_MODULE_DIR"
    rm -f "$NPM_BIN"
    if [ -e "$backup_module_dir" ]; then
        mv "$backup_module_dir" "$NPM_MODULE_DIR" || true
    fi
    if [ -e "$backup_bin" ]; then
        mv "$backup_bin" "$NPM_BIN" || true
    fi
    rm -rf "$temp_module_dir"
    rm -f "$temp_bin"
    return 1
}

if [ -f "$NPM_MODULE_DIR/package.json" ]; then
    RUNTIME_VERSION="$(node -e "try{const p=require(process.argv[1]);process.stdout.write(p.version||'')}catch{}" "$NPM_MODULE_DIR/package.json")"
fi
if [ -f "$SEED_MARKER" ]; then
    SEEDED_VERSION="$(tr -d '\n' < "$SEED_MARKER")"
fi

SEED_ACTION=""
if [ ! -f "$NPM_ENTRY" ] && [ -f "$BAKED_ENTRY" ]; then
    echo "Seeding persistent OpenClaw install into $NPM_PREFIX"
    SEED_ACTION="seed"
elif [ -f "$NPM_ENTRY" ] && [ -n "$BAKED_VERSION" ] && [ -n "$SEEDED_VERSION" ] && [ "$RUNTIME_VERSION" = "$SEEDED_VERSION" ] && [ "$RUNTIME_VERSION" != "$BAKED_VERSION" ]; then
    echo "Refreshing auto-seeded OpenClaw install to baked version $BAKED_VERSION"
    SEED_ACTION="refresh"
fi

if [ -n "$SEED_ACTION" ] && [ -f "$BAKED_ENTRY" ]; then
    if seed_persistent_openclaw; then
        SEEDED_NPM_PREFIX="true"
    else
        echo "WARNING: Failed to $SEED_ACTION persistent OpenClaw install; falling back to Docker-baked runtime" >&2
    fi
fi

if [ "$SEEDED_NPM_PREFIX" = "true" ] && [ "$(id -u)" = "0" ]; then
    chown -R openclaw:openclaw "$NPM_PREFIX" 2>/dev/null || true
fi

# Create symlinks from openclaw home into the persistent volume
# so $HOME/.openclaw resolves to /data/.openclaw and tool data persists
ln -sfn "$OPENCLAW_STATE_DIR" /home/openclaw/.openclaw
mkdir -p /data/.local /data/.npm
ln -sfn /data/.local /home/openclaw/.local
ln -sfn /data/.npm /home/openclaw/.npm
chown -h openclaw:openclaw /home/openclaw/.openclaw /home/openclaw/.local /home/openclaw/.npm
chown openclaw:openclaw /data/.local /data/.npm

# Sync pre-bundled skills into the skills directory
# Always overwrites bundled skill files to ensure Railway-aware instructions are current
# (e.g. replaces upstream SKILL.md that references localhost with our $SEARXNG_URL version)
SKILLS_DIR="$OPENCLAW_STATE_DIR/skills"
if [ -d "/bundled-skills" ]; then
    mkdir -p "$SKILLS_DIR"
    for skill_dir in /bundled-skills/*/; do
        skill_name=$(basename "$skill_dir")
        cp -r "$skill_dir" "$SKILLS_DIR/$skill_name"
        echo "Synced bundled skill: $skill_name"
    done
fi

# Start heavy-cron-loop.sh in background (replaces wa-realtime-sync +
# mcp-zombie-cleanup OpenClaw crons). Bypasses the worker-init saturation
# bug by running python scripts directly without spawning agentTurn workers.
# Watchdog cron (every 15 min) restarts it if it dies.
HEAVY_LOOP_SCRIPT="$OPENCLAW_WORKSPACE_DIR/scripts/heavy-cron-loop.sh"
HEAVY_LOOP_LOG="$OPENCLAW_STATE_DIR/logs/heavy-cron-loop.stdout"
if [ -x "$HEAVY_LOOP_SCRIPT" ]; then
    mkdir -p "$(dirname "$HEAVY_LOOP_LOG")"
    chown openclaw:openclaw "$HEAVY_LOOP_LOG" 2>/dev/null || true
    if [ "$(id -u)" = "0" ]; then
        su -s /bin/bash openclaw -c "nohup bash '$HEAVY_LOOP_SCRIPT' >> '$HEAVY_LOOP_LOG' 2>&1 &"
    else
        nohup bash "$HEAVY_LOOP_SCRIPT" >> "$HEAVY_LOOP_LOG" 2>&1 &
        disown 2>/dev/null || true
    fi
    echo "Started heavy-cron-loop in background (logs: $HEAVY_LOOP_LOG)"
else
    echo "heavy-cron-loop.sh not found at $HEAVY_LOOP_SCRIPT (will be started by watchdog cron when available)"
fi

# Start loop-supervisor.sh in background. Calls heavy-cron-loop-watchdog.sh
# every 5 min, which restarts the heavy-cron-loop if it died. Pure shell —
# no OpenClaw cron / agent dispatch involved. Replaces the disabled
# heavy-cron-loop-watchdog OpenClaw cron with a zero-saturation alternative.
SUPERVISOR_SCRIPT="$OPENCLAW_WORKSPACE_DIR/scripts/loop-supervisor.sh"
SUPERVISOR_LOG="$OPENCLAW_STATE_DIR/logs/loop-supervisor.stdout"
if [ -x "$SUPERVISOR_SCRIPT" ]; then
    mkdir -p "$(dirname "$SUPERVISOR_LOG")"
    chown openclaw:openclaw "$SUPERVISOR_LOG" 2>/dev/null || true
    if [ "$(id -u)" = "0" ]; then
        su -s /bin/bash openclaw -c "nohup bash '$SUPERVISOR_SCRIPT' >> '$SUPERVISOR_LOG' 2>&1 &"
    else
        nohup bash "$SUPERVISOR_SCRIPT" >> "$SUPERVISOR_LOG" 2>&1 &
        disown 2>/dev/null || true
    fi
    echo "Started loop-supervisor in background (logs: $SUPERVISOR_LOG)"
else
    echo "loop-supervisor.sh not found at $SUPERVISOR_SCRIPT (loop will not be auto-restarted on death)"
fi

# Log startup info
echo ""
echo "OpenClaw Railway Template"
echo "========================"
echo "State directory: $OPENCLAW_STATE_DIR"
echo "Workspace directory: $OPENCLAW_WORKSPACE_DIR"
echo "Internal gateway port: $INTERNAL_GATEWAY_PORT"
echo "External port: $PORT"
if [ -d "/ms-playwright" ] && [ -n "$(ls /ms-playwright 2>/dev/null)" ]; then
    echo "Browser: Chromium (Playwright) available"
else
    echo "Browser: Not available"
fi
echo ""

# Start the wrapper server (drop to openclaw user if running as root)
if [ "$(id -u)" = "0" ]; then
    exec su -s /bin/bash openclaw -c "exec node /app/src/server.js"
else
    exec node /app/src/server.js
fi
