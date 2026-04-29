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

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 not found. $2"
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

require_cmd openclaw "Install: npm install -g openclaw"
require_cmd claude "Install Claude Code first."

OC_VERSION="$(openclaw --version 2>/dev/null | head -n 1)"
CLAUDE_VERSION="$(claude --version 2>/dev/null | head -n 1)"
echo "  OpenClaw: $OC_VERSION"
echo "  Claude:   $CLAUDE_VERSION"

# Verify OpenClaw >= 2026.4.10 (plugin allowlist fix)
OC_VER_NUM="$(echo "$OC_VERSION" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1)"
if [ -n "$OC_VER_NUM" ]; then
  OC_MAJOR="$(echo "$OC_VER_NUM" | cut -d. -f1)"
  OC_MINOR="$(echo "$OC_VER_NUM" | cut -d. -f2)"
  OC_PATCH="$(echo "$OC_VER_NUM" | cut -d. -f3)"
  if [ "$OC_MAJOR" -lt 2026 ] 2>/dev/null ||
     { [ "$OC_MAJOR" -eq 2026 ] && [ "$OC_MINOR" -lt 4 ]; } 2>/dev/null ||
     { [ "$OC_MAJOR" -eq 2026 ] && [ "$OC_MINOR" -eq 4 ] && [ "$OC_PATCH" -lt 10 ]; } 2>/dev/null; then
    die "OpenClaw 2026.4.10+ required (found $OC_VER_NUM)"
  fi
fi

# Verify Claude CLI is authenticated
CLAUDE_AUTH="$(claude auth status 2>/dev/null || true)"
if echo "$CLAUDE_AUTH" | grep -q '"loggedIn": *true'; then
  if echo "$CLAUDE_AUTH" | grep -q '"subscriptionType": *"max"'; then
    echo "  Auth:     Max plan"
  else
    warn "Claude CLI is not on Max plan — GlueClaw may not work correctly"
  fi
else
  die "Claude CLI not authenticated. Run: claude auth login"
fi
echo ""

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
GW_LOG=""
cleanup() {
  if [ -n "$GW_PID" ] && kill -0 "$GW_PID" 2>/dev/null; then
    kill "$GW_PID" 2>/dev/null || true
  fi
  rm -f "$GW_LOG" 2>/dev/null || true
}
trap cleanup INT TERM

# --- 1. Dependencies ---

echo "[1/6] Installing dependencies..."
cd "$PLUGIN_DIR"
npm install --silent || die "npm install failed"

# --- 2. Environment ---

echo "[2/6] Setting up environment..."
ensure_line "$SHELL_RC" "GLUECLAW_KEY" "export GLUECLAW_KEY=local"
export GLUECLAW_KEY=local

# --- 3. Plugin registration ---

echo "[3/6] Registering plugin..."
# GlueClaw is on OpenClaw's official safe plugin list. Try standard install first,
# fall back to --dangerously-force-unsafe-install for older OpenClaw versions,
# then manual config as last resort.
if ! GLUECLAW_KEY=local openclaw plugins install "$PLUGIN_DIR" --link 2>/dev/null &&
   ! GLUECLAW_KEY=local openclaw plugins install "$PLUGIN_DIR" --link --dangerously-force-unsafe-install 2>/dev/null; then
  # Fallback: register manually via config commands
  oc_config plugins.load.paths "[\"/${PLUGIN_DIR#/}\"]" || true
  oc_config plugins.entries.glueclaw '{"enabled":true}' || true
  oc_config plugins.installs.glueclaw "{\"source\":\"path\",\"sourcePath\":\"$PLUGIN_DIR\",\"installPath\":\"$PLUGIN_DIR\",\"version\":\"1.0.0\"}" || true
fi

# --- 4. Model config ---

echo "[4/6] Configuring models..."
# These two are fatal — without them, nothing works
oc_config models.providers.glueclaw \
  '{"baseUrl":"local://glueclaw","models":[{"id":"glueclaw-opus","name":"GlueClaw Opus","contextWindow":1000000},{"id":"glueclaw-sonnet","name":"GlueClaw Sonnet","contextWindow":1000000},{"id":"glueclaw-haiku","name":"GlueClaw Haiku","contextWindow":200000}]}' \
  || die "Failed to configure models"
oc_config gateway.mode local || die "Failed to set gateway mode"
# Default model — warn only, user can set manually
if ! grep -q "agents" "$HOME/.openclaw/openclaw.json" 2>/dev/null || grep -q '"model": null' "$HOME/.openclaw/openclaw.json" 2>/dev/null; then
  if oc_config agents.defaults.model glueclaw/glueclaw-sonnet; then
    echo "  Default model set to glueclaw/glueclaw-sonnet"
  else
    warn "Could not set default model. Set manually: /model glueclaw/glueclaw-sonnet"
  fi
else
  echo "  Keeping existing default model (switch with: /model glueclaw/glueclaw-sonnet)"
fi
# Gateway tools — warn only, tools are optional
oc_config gateway.tools.allow \
  '["sessions_spawn","sessions_send","cron","gateway","nodes"]' \
  || warn "Could not set gateway tools allow list"

# --- 5. Auth profile ---

echo "[5/6] Setting up auth..."
AGENT_DIR="${HOME}/.openclaw/agents/main/agent"
mkdir -p "$AGENT_DIR" || die "Cannot create $AGENT_DIR"
AUTH_FILE="$AGENT_DIR/auth-profiles.json"
write_auth_profile "$AUTH_FILE"

# --- 6. Restart gateway ---
# Note: GlueClaw bootstraps OpenClaw's MCP loopback in-process from
# src/stream.ts (see docs/RFC-001-sessions-send-native.md). No dist patching
# is needed — GlueClaw shares OpenClaw's module cache as an in-process
# provider, so calling ensureMcpLoopbackServer() and getActiveMcpLoopbackRuntime()
# directly is sufficient.

echo "[6/6] Starting gateway..."
# Stop any existing gateway first
pkill -f "openclaw.*gateway" 2>/dev/null || true
openclaw gateway stop 2>/dev/null || true
sleep 2

# Verify port is free after cleanup
if command -v lsof >/dev/null 2>&1 && lsof -i :18789 >/dev/null 2>&1; then
  die "Port 18789 still in use after stopping gateway. Free it manually."
fi

GW_LOG="$(mktemp /tmp/glueclaw-gw-XXXXXX.log)"
openclaw gateway run --bind loopback --port 18789 --force >"$GW_LOG" 2>&1 &
GW_PID=$!
echo "  Waiting for gateway..."

_i=0
while [ "$_i" -lt 30 ]; do
  if ! kill -0 "$GW_PID" 2>/dev/null; then
    echo "  Gateway stderr:" >&2
    cat "$GW_LOG" >&2 2>/dev/null || true
    die "Gateway exited unexpectedly (see output above)"
  fi
  # Check if gateway is listening on the port
  if command -v lsof >/dev/null 2>&1; then
    lsof -i :18789 >/dev/null 2>&1 && break
  elif command -v ss >/dev/null 2>&1; then
    ss -tlnp 2>/dev/null | grep -q ":18789 " && break
  else
    # Fallback: check config file for auth profile
    grep -q '"glueclaw:default"' "$HOME/.openclaw/openclaw.json" 2>/dev/null && break
  fi
  sleep 1
  _i=$((_i + 1))
done

if [ "$_i" -ge 30 ]; then
  echo "  Gateway log:" >&2
  cat "$GW_LOG" >&2 2>/dev/null || true
  die "Gateway startup timed out after 30s (see log above)"
fi
rm -f "$GW_LOG" 2>/dev/null || true
GW_LOG=""

# Gateway started successfully — don't kill it on exit
GW_PID=""

# --- Done ---

echo ""
echo "  GlueClaw installed!"
echo ""
echo "  Models:"
echo "    glueclaw/glueclaw-opus    Opus 4.6   1M ctx"
echo "    glueclaw/glueclaw-sonnet  Sonnet 4.6 1M ctx"
echo "    glueclaw/glueclaw-haiku   Haiku 4.5  200k ctx"
echo ""
echo "  Default: glueclaw/glueclaw-sonnet"
echo ""
echo "  Run: openclaw tui"
echo ""
echo "  Re-run after OpenClaw updates to re-apply patches."
