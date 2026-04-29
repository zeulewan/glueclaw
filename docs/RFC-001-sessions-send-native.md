# RFC-001: `sessions_send` as a native tool inside GlueClaw sessions

**Status:** Implemented

---

## Problem

Agents running through GlueClaw cannot use `sessions_send` (and other OpenClaw
session tools) as native tools inside their Claude session. The tool is
described in the system prompt but is never injected as a real function call.

Independent verification confirmed that inter-agent messages are only treated
as legitimate when they arrive carrying the `Agent 1 (requester) session:
agent:<id>:...` context inside the `extraSystemPrompt`. That context is only
stamped by the gateway when the message flows through the official
`sessions_send` path — not when it is sent from an external script via direct
WebSocket RPC.

---

## Root cause

OpenClaw exposes session tools to the Claude subprocess via a temporary HTTP
**MCP loopback** server, started by `ensureMcpLoopbackServer()`. The Claude
subprocess receives `--mcp-config <file>` pointing at that server.

`ensureMcpLoopbackServer()` is only bootstrapped automatically when the
resolved backend has `bundleMcp: true` — set today on CLI-style backends
(Codex, Google CLI) but **not** on provider-style backends like GlueClaw.
`bundleMcp` is a backend-registration flag, not an `openclaw.json` field, so
this cannot be fixed from configuration alone.

As a result, GlueClaw never bootstraps the loopback, so the Claude
subprocess is launched without `--mcp-config` and the gateway's session
tools are never exposed natively.

---

## Solution

GlueClaw **runs in-process inside the gateway** as a provider plugin. That
means it shares OpenClaw's ESM module cache: importing the same
`mcp-http-*.js` file the gateway loaded gives us back the singleton
runtime, and any `ensureMcpLoopbackServer()` already running becomes a no-op.

`src/stream.ts` exports an async `getMcpLoopback()` that:

1. Locates OpenClaw's `dist/` by inspecting `process.env.NODE_PATH` (the
   gateway sets it to `<install-root>/node_modules:...` before invoking
   plugins).
2. Imports the `mcp-http-*.js` module via a `file://` URL — same path,
   same module cache key, same singleton.
3. Calls `ensureMcpLoopbackServer()` (idempotent).
4. Calls `getActiveMcpLoopbackRuntime()` to read the live `{ port,
   ownerToken }` directly out of memory.
5. Caches the result for subsequent invocations.

The Claude subprocess is then spawned with `--mcp-config` pointing at a
temp file that wires the loopback URL + token into the MCP client headers.

### Why this is safe

- **Idempotent:** repeated calls hit the singleton; no port races.
- **Module-cache-shared:** `await import("file://.../mcp-http-*.js")`
  returns the same module instance the gateway already loaded — no
  duplicate state.
- **Failure is benign:** if the OpenClaw dist cannot be located or
  exports a renamed/incompatible API, the function returns `undefined`
  and the session runs without session tools — the same degraded state
  GlueClaw had before this RFC.
- **No mutation of the OpenClaw dist:** unlike the previous approach,
  this design does **not** touch any minified bundle or rely on regex
  patches against internal variable names.

### Minified-export aliases

The bundle exports session-tool helpers under terse aliases. We look up
both the alias and the original name so the code keeps working if a
future OpenClaw build switches them:

| Alias | Original |
|-------|----------|
| `n`   | `ensureMcpLoopbackServer` |
| `i`   | `getActiveMcpLoopbackRuntime` |
| `r`   | `createMcpLoopbackServerConfig` |
| `t`   | `closeMcpLoopbackServer` |

---

## Why this replaces the old `install.sh` patch

A previous version of `install.sh` patched OpenClaw's
`mcp-http-CFgfguST.js` with `sed`, injecting:

```js
process.env.__GLUECLAW_MCP_PORT = String(address.port);
process.env.__GLUECLAW_MCP_TOKEN = token;
```

The intent was to leak the loopback's `port`/`token` out through
environment variables so a separate `getMcpLoopback()` function could
read them. Two problems:

1. **Latent bug.** In OpenClaw 2026.4.24 the bundle has two tokens in
   that scope (`ownerToken` and `nonOwnerToken`); the bare identifier
   `token` is undefined and `ensureMcpLoopbackServer()` throws
   `ReferenceError: token is not defined`. The bug never manifested
   before this RFC because GlueClaw never reached that code path.
2. **Fragile.** Any rename inside OpenClaw's bundle silently breaks the
   `sed` regex on the next `install.sh` run after an OpenClaw update.

The new design discards the patch entirely. `install.sh` no longer
modifies any file outside the GlueClaw repo; the MCP bridge step is
gone (was step 6/7, now removed).

---

## Implementation context

- **File:** `src/stream.ts` (only)
- **No build step required:** OpenClaw loads the TypeScript directly via
  `tsx` (the plugin is registered with `--link`).
- **Requires:** restart the gateway (`systemctl --user restart
  openclaw-gateway`) so the new module is imported.
- **No OpenClaw dist mutation.** If a previous `install.sh` ran a `sed`
  patch against `mcp-http-*.js`, restore it from the upstream npm
  package or remove the inserted prefix manually before restarting.

---

## Post-implementation verification

1. Restart the gateway.
2. Send a message to an agent.
3. Verify in `/proc/<claude-pid>/cmdline` that the spawned `claude`
   subprocess is invoked with `--mcp-config <path>`.
4. From the active agent session, call `sessions_send` — it must execute
   as a native function call, not as external WebSocket RPC.
5. The receiving agent must get `Agent 1 (requester) session:
   agent:<id>:...` in its `extraSystemPrompt`.

---

## Discarded alternatives

| Option | Why not |
|--------|---------|
| `bundleMcp: true` in `openclaw.json` | Not a config field — only a backend registration property |
| External script + WebSocket `sessions.send` | Does not inject the inter-agent authentication `extraSystemPrompt` |
| `sed`-patch the OpenClaw dist + leak via `process.env` | Fragile against bundle renames; latent bug already discovered (`token is not defined`); unnecessary because GlueClaw is in-process |
| Register GlueClaw as a CLI backend instead of a provider | Major architectural change, incompatible with the current provider model |
