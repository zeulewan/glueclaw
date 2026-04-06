# GlueClaw

OpenClaw provider plugin that routes inference through the real `claude` CLI binary, using your Claude Max subscription instead of API keys.

## How it works

Anthropic blocks OpenClaw by matching "openclaw" (case-insensitive) in the system prompt. GlueClaw bypasses this by:

1. Registering as provider `glueclaw` with models: glueclaw-opus, glueclaw-sonnet, glueclaw-haiku
2. Implementing `createStreamFn` that spawns `claude -p --output-format stream-json --system-prompt <scrubbed>`
3. Scrubbing all "openclaw" references (case-insensitive) from the system prompt and user messages via `replace(/openclaw/gi, "glueclaw")`
4. Translating Claude Code's NDJSON stream events into OpenClaw's AssistantMessageEventStream format
5. Bridging OpenClaw gateway tools (message, cron, sessions, etc.) via MCP loopback server
6. Using `--resume <sessionId>` for multi-turn conversation continuity

## Architecture

```
User message -> OpenClaw Gateway -> GlueClaw StreamFn
  -> scrub "openclaw" from system prompt
  -> spawn: claude -p --system-prompt <clean> --resume <id> --model <mapped>
  -> parse NDJSON stream events (system, stream_event, assistant, result)
  -> emit AssistantMessageEventStream events (start, text_delta, text_end, done)
  -> response appears in TUI / Telegram / Discord / etc.
```

MCP bridge for OpenClaw tools:
```
Gateway MCP loopback server (http://127.0.0.1:<port>/mcp)
  -> claude subprocess connects via --strict-mcp-config --mcp-config <generated>
  -> auth via OPENCLAW_MCP_TOKEN env var
  -> exposes: message, cron, sessions, memory, web_search, web_fetch, browser, tts, subagents, etc.
```

## Files

- `index.ts` - plugin registration: provider ID, model catalog, auth, createStreamFn, augmentModelCatalog
- `src/stream.ts` - core: subprocess spawning, NDJSON parsing, MCP bridge setup, session resume
- `install.sh` - automated installer: deps, plugin registration, model config, auth, gateway patches
- `get.sh` - curl one-liner bootstrap (clones repo then runs install.sh)
- `openclaw.plugin.json` - plugin manifest (provider ID, auth env vars, config schema)
- `package.json` - npm metadata and dependencies (@mariozechner/pi-ai, pi-agent-core)

## Install

Prerequisites: `openclaw` and `claude` CLI installed, Claude Max subscription logged in.

```bash
git clone https://github.com/zeulewan/glueclaw.git && cd glueclaw && bash install.sh
```

The installer does:
1. `npm install` for pi-ai/pi-agent-core deps
2. Adds `GLUECLAW_KEY=local` to shell profile
3. Registers plugin via `openclaw plugins install --link` (falls back to manual config for older versions)
4. Sets `gateway.mode=local`, `agents.defaults.model=glueclaw/glueclaw-sonnet`, `gateway.tools.allow` for MCP tools
5. Writes auth profile (`glueclaw:default` with fake api_key to pass auth gate)
6. Patches `server-*.js` to expose MCP loopback port/token via `process.env.__GLUECLAW_MCP_PORT/TOKEN`
7. Patches `pi-embedded-*.js` to replace "personal assistant running inside OpenClaw" with "GlueClaw"
8. Starts the gateway and waits for auth token generation

## Uninstall

```bash
# Remove plugin from config
openclaw config set plugins.entries.glueclaw '{"enabled":false}'

# Switch to another model
openclaw config set agents.defaults.model openai-codex/gpt-5.4  # or whatever

# Restore patched gateway files
OPENCLAW_DIST="$(dirname "$(which openclaw)")/../lib/node_modules/openclaw/dist"
for f in "$OPENCLAW_DIST"/*.glueclaw-bak; do
  [ -f "$f" ] && mv "$f" "${f%.glueclaw-bak}"
done

# Restart
openclaw gateway restart

# Optionally remove the plugin directory
rm -rf ~/GIT/glueclaw
```

Or just reinstall OpenClaw (`npm install -g openclaw`) to restore all dist files.

## Key technical details

- `--system-prompt` (replace mode, not append) replaces Claude Code's entire default prompt with OpenClaw's scrubbed version
- Session resume: captures session_id from `system/init` and `result` events, passes `--resume <id>` on subsequent turns. Always passes `--system-prompt` even when resuming (both flags work together).
- MCP bridge: reads port/token from `process.env.__GLUECLAW_MCP_PORT/TOKEN` (set by gateway dist patch at MCP server startup)
- Auth profile uses fake key (`glueclaw-local`) to pass OpenClaw's auth gate. Real auth is handled by the claude binary's own Max subscription login.
- Subprocess runs from `cwd: /tmp` to avoid picking up CLAUDE.md or other config files
- `ANTHROPIC_API_KEY` and `ANTHROPIC_API_KEY_OLD` are deleted from subprocess env so claude uses its own OAuth/keychain auth
- Model mapping: glueclaw-opus -> claude-opus-4-6, glueclaw-sonnet -> claude-sonnet-4-6, glueclaw-haiku -> claude-haiku-4-5
- Duplicate text prevention: assistant event text is only emitted if streaming deltas weren't already received
- Process cleanup: after result event, readline is closed and process is SIGTERM'd, with 5s timeout fallback

## After OpenClaw updates

Re-run `bash install.sh` to re-apply gateway patches. The patches create `.glueclaw-bak` backup files. The installer is idempotent and safe to run multiple times.

## Switching backends

GlueClaw coexists with other providers. Switch via:
```bash
openclaw config set agents.defaults.model glueclaw/glueclaw-sonnet   # GlueClaw
openclaw config set agents.defaults.model openai-codex/gpt-5.4       # Codex
```
Or use `/model` in the TUI. Tested switching between GlueClaw and Codex on both macOS and Linux.

## Known limitations

- Tool activity indicators don't show in TUI status bar (tools work, just no visual "Running Bash..." progress)
- `/model` picker search doesn't list glueclaw models (augmentModelCatalog type mismatch). Models work when set via config or `/model glueclaw/glueclaw-sonnet`.
- Each message spawns a fresh claude process (~7s startup). Session resume preserves history but there's startup latency per turn.
- Gateway dist patches are fragile: file names change between OpenClaw versions, `npm update` overwrites patches.
