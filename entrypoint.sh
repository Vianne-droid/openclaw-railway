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

mkdir -p "$NPM_PREFIX" "$NPM_PREFIX/lib/node_modules" "$NPM_BIN_DIR"

# Ensure the persistent npm install is writable by the runtime user.
# This repairs Railway volume state left behind by older root-run installs or
# manual root npm upgrades. Without this, in-app upgrades can fail with EACCES
# while unlinking files inside /data/.npm-global/lib/node_modules/openclaw or
# npm temp dirs like .openclaw-*.
if [ "$(id -u)" = "0" ]; then
    shopt -s nullglob
    npm_owned_paths=("$NPM_PREFIX" "$NPM_PREFIX/lib" "$NPM_PREFIX/lib/node_modules" "$NPM_BIN_DIR")
    [ -e "$NPM_MODULE_DIR" ] && npm_owned_paths+=("$NPM_MODULE_DIR")
    for p in "$NPM_PREFIX/lib/node_modules"/.openclaw-*; do
        npm_owned_paths+=("$p")
    done
    for p in "$NPM_BIN_DIR"/openclaw "$NPM_BIN_DIR"/.openclaw-*; do
        [ -e "$p" ] && npm_owned_paths+=("$p")
    done
    chown -R openclaw:openclaw "${npm_owned_paths[@]}" 2>/dev/null || true
    shopt -u nullglob
fi

# Fix ownership of newly created directories
if [ "$(id -u)" = "0" ]; then
    find /data -maxdepth 2 -not -path "*/node_modules/*" -exec chown openclaw:openclaw {} + 2>/dev/null || true
fi

# OpenClaw 2026.5.26 validates plugin code ownership before loading plugins.
# Runtime state stays owned by openclaw, but trusted plugin code must be
# root-owned or it is blocked as suspicious when loaded from the persistent
# Railway volume. Keep it readable/traversable after dropping to openclaw so
# the gateway and updater can still scan plugin manifests.
if [ "$(id -u)" = "0" ]; then
    for p in \
        "$OPENCLAW_STATE_DIR/extensions/claude-mem" \
        "$OPENCLAW_STATE_DIR/extensions/conversation-logger" \
        "$OPENCLAW_STATE_DIR/extensions/gati-sje-direct"
    do
        if [ -e "$p" ]; then
            chown -R root:root "$p" 2>/dev/null || true
            find "$p" -type d -exec chmod 755 {} + 2>/dev/null || true
            find "$p" -type f -exec chmod a+r,go-w {} + 2>/dev/null || true
        fi
    done
fi

# Seed the persistent npm prefix from the Docker-baked install on first boot.
# On redeploys, refresh the persistent install whenever the Docker-baked
# version is strictly newer than the version on the volume. Never downgrade:
# if the volume copy is newer than the baked image, treat it as user-managed.
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

version_gt() {
    [ -n "$1" ] && [ -n "$2" ] && [ "$1" != "$2" ] && \
        [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n1)" = "$1" ]
}

SEED_ACTION=""
if [ ! -f "$NPM_ENTRY" ] && [ -f "$BAKED_ENTRY" ]; then
    echo "Seeding persistent OpenClaw install into $NPM_PREFIX"
    SEED_ACTION="seed"
elif [ -f "$NPM_ENTRY" ] && version_gt "$BAKED_VERSION" "$RUNTIME_VERSION"; then
    echo "Upgrading persistent OpenClaw install ${RUNTIME_VERSION:-unknown} -> baked $BAKED_VERSION"
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

# Bootstrap external plugins required by the current OpenClaw release.
# In 2026.5.x, several runtimes/harnesses (codex app-server, whatsapp channel,
# brave search, acpx) were extracted out of the core npm package into separate
# @openclaw/* plugins. The Dockerfile only installs openclaw itself, so on a
# fresh /data volume — or after a major core upgrade — required plugins can be
# missing. Symptom: "Requested agent harness 'codex' is not registered" with
# permanent fallback off the configured primary model.
#
# This block is idempotent: it only installs plugins whose package.json is not
# already present under $OPENCLAW_STATE_DIR/npm/node_modules. It's non-fatal so
# the gateway still starts even if install fails (e.g. offline build).
PLUGINS_HOME="$OPENCLAW_STATE_DIR/npm/node_modules"
VILIX_MCP_SDK_VERSION="${VILIX_MCP_SDK_VERSION:-1.29.0}"
VILIX_SDK_BAKED="/opt/openclaw-vilix-sdk/node_modules/@modelcontextprotocol/sdk"
VILIX_SDK_BAKED_MODULES="/opt/openclaw-vilix-sdk/node_modules"
VILIX_SDK_TARGET="$PLUGINS_HOME/@modelcontextprotocol/sdk"

restore_vilix_mcp_sdk() {
    local target_index="$VILIX_SDK_TARGET/dist/esm/client/index.js"
    local target_transport="$VILIX_SDK_TARGET/dist/esm/client/streamableHttp.js"
    local target_dep="$VILIX_SDK_TARGET/node_modules/zod/package.json"
    local target_scope="$PLUGINS_HOME/@modelcontextprotocol"
    local temp_target="$target_scope/.sdk-restore-$$"
    local temp_prefix="/tmp/openclaw-vilix-sdk-$$"
    local source_sdk="$VILIX_SDK_BAKED"
    local source_modules="$VILIX_SDK_BAKED_MODULES"

    if [ -f "$target_index" ] && [ -f "$target_transport" ] && [ -f "$target_dep" ]; then
        return 0
    fi

    echo "Restoring Vilix MCP SDK dependency into $VILIX_SDK_TARGET"
    mkdir -p "$target_scope"
    rm -rf "$temp_target" "$temp_prefix"
    mkdir -p "$temp_target"

    if [ ! -d "$source_sdk" ]; then
        echo "Baked Vilix MCP SDK missing; attempting npm fallback for @modelcontextprotocol/sdk@$VILIX_MCP_SDK_VERSION" >&2
        if npm install --prefix "$temp_prefix" --save-exact --omit=dev "@modelcontextprotocol/sdk@$VILIX_MCP_SDK_VERSION" >/tmp/openclaw-vilix-sdk-restore.log 2>&1; then
            source_sdk="$temp_prefix/node_modules/@modelcontextprotocol/sdk"
            source_modules="$temp_prefix/node_modules"
        else
            echo "WARNING: Vilix MCP SDK restore failed; see /tmp/openclaw-vilix-sdk-restore.log" >&2
            rm -rf "$temp_target" "$temp_prefix"
            return 1
        fi
    fi

    if ! (cd "$source_sdk" && tar -cf - .) | (cd "$temp_target" && tar -xf -); then
        echo "WARNING: Failed to copy Vilix MCP SDK package" >&2
        rm -rf "$temp_target" "$temp_prefix"
        return 1
    fi

    mkdir -p "$temp_target/node_modules"
    if [ -d "$source_modules" ]; then
        if ! (cd "$source_modules" && tar --exclude='./@modelcontextprotocol/sdk' -cf - .) | (cd "$temp_target/node_modules" && tar -xf -); then
            echo "WARNING: Failed to copy Vilix MCP SDK dependencies" >&2
            rm -rf "$temp_target" "$temp_prefix"
            return 1
        fi
    fi

    rm -rf "$VILIX_SDK_TARGET"
    if mv "$temp_target" "$VILIX_SDK_TARGET"; then
        chown -R openclaw:openclaw "$target_scope" 2>/dev/null || true
        rm -rf "$temp_prefix"
        echo "Vilix MCP SDK restored: @modelcontextprotocol/sdk@$VILIX_MCP_SDK_VERSION"
        return 0
    fi

    echo "WARNING: Failed to move Vilix MCP SDK into place" >&2
    rm -rf "$temp_target" "$temp_prefix"
    return 1
}

restore_vilix_mcp_sdk || true

# codex is installed/version-synced by the dedicated block below (its 2026.6.x
# install path moved to npm/projects/, so the generic check never finds it);
# brave-plugin removed: env OPENCLAW_DISABLED_PLUGINS disables brave anyway.
REQUIRED_PLUGINS=(@openclaw/whatsapp @openclaw/acpx)
CORE_NPM_VER=""; CORE_BAKED_VER=""
[ -f "$NPM_MODULE_DIR/package.json" ] && CORE_NPM_VER="$(node -e "try{process.stdout.write(require(process.argv[1]).version||'')}catch{}" "$NPM_MODULE_DIR/package.json" 2>/dev/null)"
[ -f "$BAKED_MODULE_DIR/package.json" ] && CORE_BAKED_VER="$(node -e "try{process.stdout.write(require(process.argv[1]).version||'')}catch{}" "$BAKED_MODULE_DIR/package.json" 2>/dev/null)"
EFFECTIVE_CORE_VERSION="$(printf '%s\n%s\n' "$CORE_NPM_VER" "$CORE_BAKED_VER" | grep -v '^$' | sort -V | tail -1)"
plugins_to_sync=()
for pkg in "${REQUIRED_PLUGINS[@]}"; do
    pkg_json="$PLUGINS_HOME/$pkg/package.json"
    pkg_ver=""
    [ -f "$pkg_json" ] && pkg_ver="$(node -e "try{process.stdout.write(require(process.argv[1]).version||'')}catch{}" "$pkg_json" 2>/dev/null)"
    if [ ! -f "$pkg_json" ] || { [ -n "$EFFECTIVE_CORE_VERSION" ] && [ "$pkg_ver" != "$EFFECTIVE_CORE_VERSION" ]; }; then
        if [ -n "$EFFECTIVE_CORE_VERSION" ]; then
            plugins_to_sync+=("$pkg@$EFFECTIVE_CORE_VERSION")
        else
            plugins_to_sync+=("$pkg")
        fi
    fi
done
if [ ${#plugins_to_sync[@]} -gt 0 ]; then
    echo "Syncing external plugins: ${plugins_to_sync[*]}"
    if [ "$(id -u)" = "0" ]; then
        chown -R openclaw:openclaw "$PLUGINS_HOME/@openclaw" 2>/dev/null || true
        for spec in "${plugins_to_sync[@]}"; do
            su -s /bin/bash openclaw -c "openclaw plugins install '$spec' --force" \
                || echo "WARNING: external plugin sync failed for $spec; gateway will start without it" >&2
        done
    else
        for spec in "${plugins_to_sync[@]}"; do
            openclaw plugins install "$spec" --force \
                || echo "WARNING: external plugin sync failed for $spec; gateway will start without it" >&2
        done
    fi
else
    echo "External plugins match core: ${REQUIRED_PLUGINS[*]}"
fi

if [ "$(id -u)" = "0" ]; then
    for pkg in "${REQUIRED_PLUGINS[@]}"; do
        p="$PLUGINS_HOME/$pkg"
        if [ -e "$p" ]; then
            chown -R root:root "$p" 2>/dev/null || true
            find "$p" -type d -exec chmod 755 {} + 2>/dev/null || true
            find "$p" -type f -exec chmod a+r,go-w {} + 2>/dev/null || true
        fi
    done
fi

# Also fix ownership of any other @openclaw/* plugins present on the volume
# (e.g. slack) so OpenClaw 2026.5.26+ does not block them as "suspicious
# ownership" (uid=1001). REQUIRED_PLUGINS above covers the relay-critical ones;
# this catches the rest. Idempotent.
if [ "$(id -u)" = "0" ] && [ -d "$PLUGINS_HOME/@openclaw" ]; then
    for p in "$PLUGINS_HOME/@openclaw"/*; do
        if [ -d "$p" ]; then
            chown -R root:root "$p" 2>/dev/null || true
            find "$p" -type d -exec chmod 755 {} + 2>/dev/null || true
            find "$p" -type f -exec chmod a+r,go-w {} + 2>/dev/null || true
        fi
    done
fi

# ------------------------------------------------------------------------------
# Ensure the Codex plugin version matches the core OpenClaw version.
# A skew (e.g. core 2026.5.27 + @openclaw/codex 2026.5.20) breaks the native
# hook relay: on the older codex plugin the relay is NOT kept alive across the
# per-turn "fresh fallback", so every tool call AFTER the first turn fails with
# "Native hook relay unavailable" (deterministic turn-2 failure). The
# keep-relay-alive fix shipped in 2026.5.27, so the plugin must track core.
# Idempotent: only acts when the versions differ. Restores root ownership after.
# ------------------------------------------------------------------------------
if [ "$(id -u)" = "0" ]; then
    # The wrapper runs whichever core is HIGHER (baked vs persisted npm-global),
    # so the codex plugin must match that EFFECTIVE version — not whichever file
    # we read first. A stale older npm-global copy must NOT win (that bug shipped
    # codex .26 against core .27 and broke the codex harness: "does not support
    # openai/gpt-5.5 (provider is not one of: codex)").
    CORE_NPM_VER=""; CORE_BAKED_VER=""
    [ -f "$NPM_MODULE_DIR/package.json" ] && CORE_NPM_VER="$(node -e "try{process.stdout.write(require(process.argv[1]).version||'')}catch{}" "$NPM_MODULE_DIR/package.json" 2>/dev/null)"
    [ -f "$BAKED_MODULE_DIR/package.json" ] && CORE_BAKED_VER="$(node -e "try{process.stdout.write(require(process.argv[1]).version||'')}catch{}" "$BAKED_MODULE_DIR/package.json" 2>/dev/null)"
    CORE_VER="$(printf '%s\n%s\n' "$CORE_NPM_VER" "$CORE_BAKED_VER" | grep -v '^$' | sort -V | tail -1)"
    CODEX_PKG="$PLUGINS_HOME/@openclaw/codex/package.json"
    # 2026.6.x installs codex under npm/projects/openclaw-codex-*/ - check there too,
    # otherwise the version-sync misfires (reinstall) on every boot.
    if [ ! -f "$CODEX_PKG" ]; then
        ALT_CODEX_PKG="$(ls -1d /data/.openclaw/npm/projects/openclaw-codex-*/node_modules/@openclaw/codex/package.json 2>/dev/null | head -1)"
        [ -n "$ALT_CODEX_PKG" ] && CODEX_PKG="$ALT_CODEX_PKG"
    fi
    CODEX_VER=""
    [ -f "$CODEX_PKG" ] && CODEX_VER="$(node -e "try{process.stdout.write(require(process.argv[1]).version||'')}catch{}" "$CODEX_PKG" 2>/dev/null)"
    if [ -n "$CORE_VER" ] && [ "$CODEX_VER" != "$CORE_VER" ]; then
        echo "Codex plugin skew (plugin=${CODEX_VER:-none} core=$CORE_VER); syncing codex plugin to $CORE_VER"
        chown -R openclaw:openclaw "$PLUGINS_HOME/@openclaw" 2>/dev/null || true
        su -s /bin/bash openclaw -c "openclaw plugins install @openclaw/codex@$CORE_VER --force" \
            || echo "WARNING: codex plugin version-sync to $CORE_VER failed" >&2
        for p in "$PLUGINS_HOME/@openclaw"/*; do
            [ -d "$p" ] || continue
            chown -R root:root "$p" 2>/dev/null || true
            find "$p" -type d -exec chmod 755 {} + 2>/dev/null || true
            find "$p" -type f -exec chmod a+r,go-w {} + 2>/dev/null || true
        done
    else
        echo "Codex plugin version matches core (${CODEX_VER:-none})"
    fi
fi

# ------------------------------------------------------------------------------
# Patch: extend the Codex native-hook-relay wait timeout from 5s to 10s.
#
# Root cause (OpenClaw upstream issue #76793, still OPEN as of 2026.5.27):
# Codex's PreToolUse "native hook relay" prefers a fast in-process direct
# localhost bridge and only falls back to the authenticated gateway RPC
# (nativeHook.invoke) if the bridge isn't ready within DEFAULT_RELAY_TIMEOUT_MS
# (= 5e3 / 5s). On this Railway container, ACP runtime-ready latency is ~5.4s
# (event-loop stalls of 1.6-2.4s under MCP/browser load), so the 5s wait loses
# the race, Codex falls back to the gateway RPC, that path isn't reliably
# registered -> "native hook relay not found" / "Native hook relay unavailable",
# and the FIRST tool call of the turn (usually the mandatory Vilix get_context)
# fails closed. Intermittent: warm relays win, cold turns lose.
#
# .27 already shipped PR #73950 (shared relay registry) + #83987 (deferred
# unregister); the remaining unfixed piece is this timeout/latency window.
# Bumping 5e3 -> 1e4 (10s) lets the direct bridge register before fallback.
# Idempotent and re-applied every boot so it survives openclaw auto-updates.
# REMOVE this block once #76793 ships in the pinned OpenClaw version.
# ------------------------------------------------------------------------------
if [ "$(id -u)" = "0" ]; then
    relay_patched=0
    for dist in "$NPM_MODULE_DIR/dist" "$BAKED_MODULE_DIR/dist"; do
        [ -d "$dist" ] || continue
        for f in "$dist"/native-hook-relay-*.js; do
            [ -f "$f" ] || continue
            if grep -q 'DEFAULT_RELAY_TIMEOUT_MS = 5e3' "$f" 2>/dev/null; then
                owner="$(stat -c '%U:%G' "$f" 2>/dev/null || echo openclaw:openclaw)"
                if sed -i 's/DEFAULT_RELAY_TIMEOUT_MS = 5e3/DEFAULT_RELAY_TIMEOUT_MS = 1e4/g' "$f"; then
                    chown "$owner" "$f" 2>/dev/null || true
                    echo "Patched Codex native-hook-relay wait 5s->10s (#76793 workaround): $f"
                    relay_patched=1
                fi
            fi
        done
    done
    if [ "$relay_patched" = "0" ]; then
        echo "native-hook-relay wait: nothing to patch (already 10s, or constant moved — recheck #76793)"
    fi
fi

# ------------------------------------------------------------------------------
# Patch: Claude Fable 5 adaptive thinking support.
#
# Fable 5 rejects the older Anthropic thinking controls:
# - thinking: { type: "disabled" }
# - thinking: { type: "enabled", budget_tokens: ... }
#
# It expects adaptive thinking plus output_config.effort. OpenClaw 2026.6.5 does
# not know this model yet, so the runtime can send the old payload when
# reasoning is enabled. Apply this at every boot so it survives container
# recreation until upstream ships native Fable support.
# ------------------------------------------------------------------------------
if [ "$(id -u)" = "0" ]; then
    FABLE_PATCH_DIRS="$NPM_MODULE_DIR/dist:$BAKED_MODULE_DIR/dist" node <<'NODE' || echo "WARNING: Fable 5 adaptive thinking patch failed" >&2
const fs = require('fs');

const dirs = (process.env.FABLE_PATCH_DIRS || '').split(':').filter(Boolean);

function replaceOnce(content, from, to, label, file) {
  if (content.includes(to)) return { content, changed: false };
  if (!content.includes(from)) throw new Error(`missing ${label} anchor in ${file}`);
  return { content: content.replace(from, to), changed: true };
}

function patchFile(file, patcher) {
  if (!fs.existsSync(file)) return;
  const before = fs.readFileSync(file, 'utf8');
  const after = patcher(before, file);
  if (after !== before) {
    fs.writeFileSync(file, after);
    console.log(`Patched Fable 5 adaptive thinking support: ${file}`);
  }
}

function patchAnthropic(content, file) {
  let out = content;
  out = replaceOnce(
    out,
    `/**
* Check if a model supports adaptive thinking (Opus 4.6+, Sonnet 4.6)
*/
function supportsAdaptiveThinking(modelId) {
\treturn modelId.includes("opus-4-6") || modelId.includes("opus-4.6") || modelId.includes("opus-4-8") || modelId.includes("opus-4.8") || modelId.includes("opus-4-7") || modelId.includes("opus-4.7") || modelId.includes("sonnet-4-6") || modelId.includes("sonnet-4.6");
}`,
    `/**
* Check if a model supports adaptive thinking (Opus 4.6+, Sonnet 4.6, Fable 5)
*/
function isClaudeFable5Model(modelId) {
\treturn modelId.includes("fable-5") || modelId.includes("fable.5");
}
function supportsAdaptiveThinking(modelId) {
\treturn modelId.includes("opus-4-6") || modelId.includes("opus-4.6") || modelId.includes("opus-4-8") || modelId.includes("opus-4.8") || modelId.includes("opus-4-7") || modelId.includes("opus-4.7") || modelId.includes("sonnet-4-6") || modelId.includes("sonnet-4.6") || isClaudeFable5Model(modelId);
}`,
    'direct provider adaptive support',
    file
  ).content;
  out = replaceOnce(
    out,
    `\t\tcase "high": return "high";
\t\tcase "max": return "max";`,
    `\t\tcase "high": return "high";
\t\tcase "xhigh": return isClaudeFable5Model(model.id) ? "xhigh" : "high";
\t\tcase "max": return "max";`,
    'direct provider xhigh mapping',
    file
  ).content;
  out = replaceOnce(
    out,
    `\tif (!options?.reasoning) return streamAnthropic(model, context, {
\t\t...base,
\t\tthinkingEnabled: false
\t});`,
    `\tif (!options?.reasoning) return streamAnthropic(model, context, {
\t\t...base,
\t\tthinkingEnabled: isClaudeFable5Model(model.id),
\t\teffort: isClaudeFable5Model(model.id) ? "high" : void 0
\t});`,
    'direct provider default adaptive mode',
    file
  ).content;
  return out;
}

function patchTransport(content, file) {
  let out = content;
  out = replaceOnce(
    out,
    `function isClaudeOpus46Model(modelId) {
\treturn modelId.includes("opus-4-6") || modelId.includes("opus-4.6");
}
function supportsAdaptiveThinking(modelId) {
\treturn isClaudeOpus47OrNewerModel(modelId) || isClaudeOpus46Model(modelId) || modelId.includes("sonnet-4-6") || modelId.includes("sonnet-4.6");
}`,
    `function isClaudeOpus46Model(modelId) {
\treturn modelId.includes("opus-4-6") || modelId.includes("opus-4.6");
}
function isClaudeFable5Model(modelId) {
\treturn modelId.includes("fable-5") || modelId.includes("fable.5");
}
function supportsAdaptiveThinking(modelId) {
\treturn isClaudeOpus47OrNewerModel(modelId) || isClaudeOpus46Model(modelId) || modelId.includes("sonnet-4-6") || modelId.includes("sonnet-4.6") || isClaudeFable5Model(modelId);
}`,
    'transport adaptive support',
    file
  ).content;
  out = replaceOnce(
    out,
    `\t\tcase "xhigh":
\t\t\tif (isClaudeOpus47OrNewerModel(modelId)) return "xhigh";
\t\t\treturn isClaudeOpus46Model(modelId) ? "max" : "high";
\t\tcase "max": return isClaudeOpus47OrNewerModel(modelId) ? "max" : "high";`,
    `\t\tcase "xhigh":
\t\t\tif (isClaudeOpus47OrNewerModel(modelId) || isClaudeFable5Model(modelId)) return "xhigh";
\t\t\treturn isClaudeOpus46Model(modelId) ? "max" : "high";
\t\tcase "max": return isClaudeOpus47OrNewerModel(modelId) || isClaudeFable5Model(modelId) ? "max" : "high";`,
    'transport xhigh/max mapping',
    file
  ).content;
  out = replaceOnce(
    out,
    `\tif (!options?.reasoning) {
\t\tresolved.thinkingEnabled = false;
\t\treturn resolved;
\t}`,
    `\tif (!options?.reasoning) {
\t\tif (isClaudeFable5Model(model.id)) {
\t\t\tresolved.thinkingEnabled = true;
\t\t\tresolved.effort = "high";
\t\t\treturn resolved;
\t\t}
\t\tresolved.thinkingEnabled = false;
\t\treturn resolved;
\t}`,
    'transport default adaptive mode',
    file
  ).content;
  return out;
}

for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    const file = `${dir}/${name}`;
    try {
      if (/^anthropic-.*\.js$/.test(name)) patchFile(file, patchAnthropic);
      if (/^provider-stream-.*\.js$/.test(name)) patchFile(file, patchTransport);
    } catch (err) {
      console.error("WARNING: Fable patch skipped " + file + ": " + err.message);
    }
  }
}
NODE
fi

# ------------------------------------------------------------------------------
# Patch: Gati SJE direct Telegram ingress.
#
# The @vjgati_bot fast lookup path is injected into OpenClaw's compiled
# Telegram bot bundle. Rebuilds/restarts can refresh that bundle from a clean
# OpenClaw package, so re-apply the patch at startup before the gateway process
# starts. This is fail-open: if the patch cannot be applied, OpenClaw still
# starts and the heartbeat reports the missing anchors.
# ------------------------------------------------------------------------------
if [ "$(id -u)" = "0" ]; then
    GATI_DIRECT_PATCH="$OPENCLAW_WORKSPACE_DIR/scripts/gati-direct/apply-patch.sh"
    if [ -x "$GATI_DIRECT_PATCH" ]; then
        if "$GATI_DIRECT_PATCH" --check >/dev/null 2>&1; then
            echo "Gati SJE direct ingress patch already present"
        elif "$GATI_DIRECT_PATCH"; then
            echo "Patched Gati SJE direct Telegram ingress"
        else
            echo "WARNING: Gati SJE direct ingress patch failed; fast lookup may be unavailable" >&2
        fi
    else
        echo "WARNING: Gati SJE direct patch script missing at $GATI_DIRECT_PATCH" >&2
    fi
fi

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
