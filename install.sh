#!/bin/bash
set -e

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "  GlueClaw - Claude Max for OpenClaw"
echo ""

# --- Preflight ---

command -v openclaw >/dev/null 2>&1 || { echo "Error: openclaw not found. Install: npm install -g openclaw"; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "Error: claude CLI not found. Install Claude Code first."; exit 1; }
echo "  OpenClaw: $(openclaw --version 2>/dev/null | head -1)"
echo "  Claude:   $(claude --version 2>/dev/null | head -1)"
echo ""

# Find OpenClaw dist
OPENCLAW_ROOT="$(dirname "$(which openclaw)")/../lib/node_modules/openclaw"
[ ! -d "$OPENCLAW_ROOT/dist" ] && OPENCLAW_ROOT="$(npm root -g 2>/dev/null)/openclaw"
[ ! -d "$OPENCLAW_ROOT/dist" ] && { echo "Error: Cannot find OpenClaw dist"; exit 1; }
OPENCLAW_DIST="$OPENCLAW_ROOT/dist"

# Detect shell config
if [ -f "${HOME}/.zshrc" ]; then
  SHELL_RC="${HOME}/.zshrc"
elif [ -f "${HOME}/.bashrc" ]; then
  SHELL_RC="${HOME}/.bashrc"
else
  SHELL_RC="${HOME}/.profile"
fi

# Cross-platform sed -i
sedi() {
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

# --- 1. Dependencies ---

echo "[1/7] Installing dependencies..."
cd "$PLUGIN_DIR" && npm install --silent 2>/dev/null

# --- 2. Environment ---

echo "[2/7] Setting up environment..."
if ! grep -q "GLUECLAW_KEY" "$SHELL_RC" 2>/dev/null; then
  echo 'export GLUECLAW_KEY=local' >> "$SHELL_RC"
fi
export GLUECLAW_KEY=local

# --- 3. Plugin registration ---

echo "[3/7] Registering plugin..."
# Try the official plugin install first
if ! GLUECLAW_KEY=local openclaw plugins install "$PLUGIN_DIR" --link --dangerously-force-unsafe-install 2>/dev/null; then
  # Fallback: register manually via config commands
  openclaw config set plugins.load.paths "[\"/$(echo "$PLUGIN_DIR" | sed 's|^/||')\"]" 2>/dev/null || true
  openclaw config set plugins.entries.glueclaw '{"enabled":true}' 2>/dev/null || true
  openclaw config set plugins.installs.glueclaw "{\"source\":\"path\",\"sourcePath\":\"$PLUGIN_DIR\",\"installPath\":\"$PLUGIN_DIR\",\"version\":\"1.0.0\"}" 2>/dev/null || true
fi

# --- 4. Model config ---

echo "[4/7] Configuring models..."
openclaw config set models.providers.glueclaw \
  '{"baseUrl":"local://glueclaw","models":[{"id":"glueclaw-opus","name":"GlueClaw Opus","contextWindow":1000000},{"id":"glueclaw-sonnet","name":"GlueClaw Sonnet","contextWindow":200000},{"id":"glueclaw-haiku","name":"GlueClaw Haiku","contextWindow":200000}]}' \
  2>/dev/null
# Ensure gateway mode is set (fresh installs may be missing it)
openclaw config set gateway.mode local 2>/dev/null
# Only set default model if not already configured
if ! grep -q "agents" "$HOME/.openclaw/openclaw.json" 2>/dev/null || grep -q '"model": null' "$HOME/.openclaw/openclaw.json" 2>/dev/null; then
  openclaw config set agents.defaults.model glueclaw/glueclaw-sonnet 2>/dev/null
  echo "  Default model set to glueclaw/glueclaw-sonnet"
else
  echo "  Keeping existing default model (switch with: /model glueclaw/glueclaw-sonnet)"
fi
openclaw config set gateway.tools.allow \
  '["sessions_spawn","sessions_send","cron","gateway","nodes"]' \
  2>/dev/null

# --- 5. Auth profile ---

echo "[5/7] Setting up auth..."
AGENT_DIR="${HOME}/.openclaw/agents/main/agent"
mkdir -p "$AGENT_DIR"
AUTH_FILE="$AGENT_DIR/auth-profiles.json"

GLUECLAW_PROFILE='{"type":"api_key","provider":"glueclaw","key":"glueclaw-local"}'

if [ -f "$AUTH_FILE" ] && command -v node >/dev/null 2>&1; then
  # Use node (always available where openclaw is installed) to merge auth
  node -e "
    const fs = require('fs');
    let data = {};
    try { data = JSON.parse(fs.readFileSync('$AUTH_FILE', 'utf8')); } catch {}
    if (!data.profiles) data.profiles = {};
    data.profiles['glueclaw:default'] = $GLUECLAW_PROFILE;
    fs.writeFileSync('$AUTH_FILE', JSON.stringify(data, null, 2));
  " 2>/dev/null
elif [ -f "$AUTH_FILE" ] && command -v python3 >/dev/null 2>&1; then
  # Fallback to python3
  python3 -c "
import json
with open('$AUTH_FILE') as f: data = json.load(f)
data.setdefault('profiles', {})['glueclaw:default'] = $GLUECLAW_PROFILE
with open('$AUTH_FILE', 'w') as f: json.dump(data, f, indent=2)
" 2>/dev/null
else
  # Fresh file
  echo "{\"profiles\":{\"glueclaw:default\":$GLUECLAW_PROFILE}}" > "$AUTH_FILE"
fi

# --- 6. Patch: MCP bridge ---

echo "[6/7] Patching gateway for MCP bridge..."
SERVER_FILE=$(grep -rl "mcp loopback listening" "$OPENCLAW_DIST"/*.js 2>/dev/null | head -1)
if [ -n "$SERVER_FILE" ] && ! grep -q "__GLUECLAW_MCP" "$SERVER_FILE"; then
  cp "$SERVER_FILE" "${SERVER_FILE}.glueclaw-bak"
  sedi 's/logDebug(`mcp loopback listening/process.env.__GLUECLAW_MCP_PORT = String(address.port); process.env.__GLUECLAW_MCP_TOKEN = token; logDebug(`mcp loopback listening/' "$SERVER_FILE"
  echo "  Patched $(basename "$SERVER_FILE")"
else
  echo "  Already patched"
fi

# --- 7. Restart gateway ---

echo "[7/7] Starting gateway..."
pkill -f "openclaw.*gateway" 2>/dev/null || true
openclaw gateway stop 2>/dev/null || true
sleep 2
openclaw gateway run --bind loopback --port 18789 --force &>/dev/null &
echo "  Waiting for gateway..."
for i in $(seq 1 15); do
  grep -q "auth" "$HOME/.openclaw/openclaw.json" 2>/dev/null && break
  sleep 1
done

# --- Done ---

echo ""
echo "  GlueClaw installed!"
echo ""
echo "  Models:"
echo "    glueclaw/glueclaw-opus    Opus 4.6   1M ctx"
echo "    glueclaw/glueclaw-sonnet  Sonnet 4.6 200k ctx"
echo "    glueclaw/glueclaw-haiku   Haiku 4.5  200k ctx"
echo ""
echo "  Default: glueclaw/glueclaw-sonnet"
echo ""
echo "  Run: openclaw tui"
echo ""
echo "  Re-run after OpenClaw updates to re-apply patches."
