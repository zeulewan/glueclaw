#!/bin/bash
# GlueClaw installer — Claude Max for OpenClaw
#
# Prerequisites: openclaw, claude CLI, node/npm
# Re-run safe: idempotent on all steps
# Modifies: ~/.openclaw/, shell RC, OpenClaw dist (backed up)
set -e

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Helpers ---

die() {
  echo "  Error: $1" >&2
  exit 1
}

warn() {
  echo "  Warning: $1" >&2
}

oc_config() {
  _oc_path="$1"
  _oc_val="$2"
  _oc_err=""
  _oc_err="$(openclaw config set "$_oc_path" "$_oc_val" 2>&1)" || {
    warn "Failed to set $_oc_path: $_oc_err"
    return 1
  }
}

sedi() {
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

ensure_line() {
  _el_file="$1"
  _el_pattern="$2"
  _el_line="$3"
  if ! grep -q "$_el_pattern" "$_el_file" 2>/dev/null; then
    echo "$_el_line" >>"$_el_file"
  fi
}

write_auth_profile() {
  _wa_file="$1"
  _wa_json='{"type":"api_key","provider":"glueclaw","key":"glueclaw-local"}'
  if [ -f "$_wa_file" ] && command -v node >/dev/null 2>&1; then
    node -e "
      var fs = require('fs');
      var profile = JSON.parse(process.argv[1]);
      var data = {};
      try { data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); } catch(e) {}
      if (!data.profiles) data.profiles = {};
      data.profiles['glueclaw:default'] = profile;
      fs.writeFileSync(process.argv[2], JSON.stringify(data, null, 2));
    " "$_wa_json" "$_wa_file" || warn "Node auth merge failed"
  elif [ -f "$_wa_file" ] && command -v python3 >/dev/null 2>&1; then
    python3 -c "
import json, sys
profile = json.loads(sys.argv[1])
path = sys.argv[2]
with open(path) as f: data = json.load(f)
data.setdefault('profiles', {})['glueclaw:default'] = profile
with open(path, 'w') as f: json.dump(data, f, indent=2)
" "$_wa_json" "$_wa_file" || warn "Python auth merge failed"
  else
    printf '{"profiles":{"glueclaw:default":%s}}\n' "$_wa_json" >"$_wa_file"
  fi
}

# --- Early validation ---

[ -z "${HOME:-}" ] && die "HOME is not set"

echo ""
echo "  GlueClaw - Claude Max for OpenClaw"
echo ""

# --- Preflight ---

command -v openclaw >/dev/null 2>&1 || die "openclaw not found. Install: npm install -g openclaw"
command -v claude >/dev/null 2>&1 || die "claude CLI not found. Install Claude Code first."
echo "  OpenClaw: $(openclaw --version 2>/dev/null | head -n 1)"
echo "  Claude:   $(claude --version 2>/dev/null | head -n 1)"
echo ""

# Find OpenClaw dist
OPENCLAW_BIN="$(command -v openclaw)"
OPENCLAW_ROOT="$(dirname "$OPENCLAW_BIN")/../lib/node_modules/openclaw"
# Suppress not-found: fallback path may not exist
[ ! -d "$OPENCLAW_ROOT/dist" ] && OPENCLAW_ROOT="$(npm root -g 2>/dev/null)/openclaw"
[ ! -d "$OPENCLAW_ROOT/dist" ] && die "Cannot find OpenClaw dist"
OPENCLAW_DIST="$OPENCLAW_ROOT/dist"

# Detect shell config
if [ -f "${HOME}/.zshrc" ]; then
  SHELL_RC="${HOME}/.zshrc"
elif [ -f "${HOME}/.bashrc" ]; then
  SHELL_RC="${HOME}/.bashrc"
else
  SHELL_RC="${HOME}/.profile"
fi

# --- Cleanup trap ---

GW_PID=""
cleanup() {
  if [ -n "$GW_PID" ] && kill -0 "$GW_PID" 2>/dev/null; then
    kill "$GW_PID" 2>/dev/null || true
  fi
}
trap cleanup INT TERM

# --- 1. Dependencies ---

echo "[1/7] Installing dependencies..."
cd "$PLUGIN_DIR"
npm install --silent || die "npm install failed"

# --- 2. Environment ---

echo "[2/7] Setting up environment..."
ensure_line "$SHELL_RC" "GLUECLAW_KEY" "export GLUECLAW_KEY=local"
export GLUECLAW_KEY=local

# --- 3. Plugin registration ---

echo "[3/7] Registering plugin..."
# Try the official plugin install first
if ! GLUECLAW_KEY=local openclaw plugins install "$PLUGIN_DIR" --link --dangerously-force-unsafe-install 2>/dev/null; then
  # Fallback: register manually via config commands
  oc_config plugins.load.paths "[\"/${PLUGIN_DIR#/}\"]" || true
  oc_config plugins.entries.glueclaw '{"enabled":true}' || true
  oc_config plugins.installs.glueclaw "{\"source\":\"path\",\"sourcePath\":\"$PLUGIN_DIR\",\"installPath\":\"$PLUGIN_DIR\",\"version\":\"1.0.0\"}" || true
fi

# --- 4. Model config ---

echo "[4/7] Configuring models..."
oc_config models.providers.glueclaw \
  '{"baseUrl":"local://glueclaw","models":[{"id":"glueclaw-opus","name":"GlueClaw Opus","contextWindow":1000000},{"id":"glueclaw-sonnet","name":"GlueClaw Sonnet","contextWindow":200000},{"id":"glueclaw-haiku","name":"GlueClaw Haiku","contextWindow":200000}]}'
# Suppress not-found: key may not exist yet
oc_config gateway.mode local
# Only set default model if not already configured
if ! grep -q "agents" "$HOME/.openclaw/openclaw.json" 2>/dev/null || grep -q '"model": null' "$HOME/.openclaw/openclaw.json" 2>/dev/null; then
  oc_config agents.defaults.model glueclaw/glueclaw-sonnet
  echo "  Default model set to glueclaw/glueclaw-sonnet"
else
  echo "  Keeping existing default model (switch with: /model glueclaw/glueclaw-sonnet)"
fi
oc_config gateway.tools.allow \
  '["sessions_spawn","sessions_send","cron","gateway","nodes"]'

# --- 5. Auth profile ---

echo "[5/7] Setting up auth..."
AGENT_DIR="${HOME}/.openclaw/agents/main/agent"
mkdir -p "$AGENT_DIR" || die "Cannot create $AGENT_DIR"
AUTH_FILE="$AGENT_DIR/auth-profiles.json"
write_auth_profile "$AUTH_FILE"

# --- 6. Patch: MCP bridge ---

echo "[6/7] Patching gateway for MCP bridge..."
# Suppress not-found: glob may not match any .js files
SERVER_FILE=$(grep -rl "mcp loopback listening" "$OPENCLAW_DIST"/*.js 2>/dev/null | head -n 1)
if [ -n "$SERVER_FILE" ] && ! grep -q "__GLUECLAW_MCP" "$SERVER_FILE"; then
  cp "$SERVER_FILE" "${SERVER_FILE}.glueclaw-bak" || die "Cannot backup $SERVER_FILE"
  # shellcheck disable=SC2016
  sedi 's/logDebug(`mcp loopback listening/process.env.__GLUECLAW_MCP_PORT = String(address.port); process.env.__GLUECLAW_MCP_TOKEN = token; logDebug(`mcp loopback listening/' "$SERVER_FILE" ||
    die "Failed to patch $SERVER_FILE"
  echo "  Patched $(basename "$SERVER_FILE")"
else
  echo "  Already patched"
fi

# --- 7. Restart gateway ---

echo "[7/7] Starting gateway..."
pkill -f "openclaw.*gateway" 2>/dev/null || true
# Suppress exit code: stop may fail if not running
openclaw gateway stop 2>/dev/null || true
sleep 2

# Check port is free before binding
if command -v lsof >/dev/null 2>&1; then
  if lsof -i :18789 >/dev/null 2>&1; then
    warn "Port 18789 still in use, gateway may fail to start"
  fi
fi

openclaw gateway run --bind loopback --port 18789 --force >/dev/null 2>&1 &
GW_PID=$!
echo "  Waiting for gateway..."

_i=0
while [ "$_i" -lt 20 ]; do
  # Check gateway process is still alive
  if ! kill -0 "$GW_PID" 2>/dev/null; then
    die "Gateway exited unexpectedly"
  fi
  grep -q '"glueclaw:default"' "$HOME/.openclaw/openclaw.json" 2>/dev/null && break
  sleep 1
  _i=$((_i + 1))
done

if ! grep -q '"glueclaw:default"' "$HOME/.openclaw/openclaw.json" 2>/dev/null; then
  warn "Gateway may not be ready (timed out after 20s)"
fi

# Gateway started successfully — don't kill it on exit
GW_PID=""

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
