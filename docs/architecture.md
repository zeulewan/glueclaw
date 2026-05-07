---
title: Architecture
layout: default
nav_order: 2
---

# Architecture

OpenClaw provider plugin that spawns Claude CLI subprocesses using Max plan OAuth instead of API keys. Per-agent state is anchored to OpenClaw's resolved workspace directory so multi-agent setups stay isolated end-to-end.

## Request flow

1. OpenClaw gateway receives a user message.
2. Gateway calls GlueClaw's `createStreamFn` with a `ProviderCreateStreamFnContext` carrying `modelId`, `agentDir`, `workspaceDir`, and optionally `sessionKey` / `sessionId`.
3. `index.ts` resolves the agent id from `ctx.sessionKey` (preferred) or `ctx.agentDir`, then forwards `workspaceDir`, the resolved agent id, and the session key into `createClaudeCliStreamFn`.
4. `createClaudeCliStreamFn` resolves the model (`glueclaw-sonnet` → `claude-sonnet-4-6`), scrubs the system prompt for [detection triggers](detection-patterns.md), and deletes `ANTHROPIC_API_KEY*` from the subprocess environment so the CLI uses Max plan OAuth.
5. The agent's per-workspace `sessions.json` is loaded; if a Claude session id is cached for this conversation, `--resume <id>` is added.
6. Claude CLI is spawned with `cwd = ctx.workspaceDir` (so each agent gets its own Claude project storage in `~/.claude/projects/<workspaceDir-hash>/`):
   ```
   claude --dangerously-skip-permissions -p \
       --output-format stream-json --verbose --include-partial-messages \
       [--resume <session_id>] [--system-prompt <scrubbed>] \
       --model <claude-id> [--strict-mcp-config --mcp-config <tmp>] \
       <user prompt>
   ```
7. The stream loop reads NDJSON events via `readline`:
   - `system` (subtype `init`) — captures Claude session id; persisted **only on success** (see #37).
   - `stream_event` with `text_delta` — accumulated and forwarded to the gateway.
   - `assistant` — fallback text source if no streaming deltas arrived.
   - `result` — terminal event. If `is_error: true` or `subtype: "error_during_execution"`, the cached session id is dropped and an error event is emitted carrying the real claude error text.
8. Response tokens are unscrubbed (3 renamed tokens translated back) and emitted to the gateway as `start` → `text_delta`\* → `done`.

## Auth model

GlueClaw never sees an API key. The subprocess environment is copied from `process.env` and both `ANTHROPIC_API_KEY` and `ANTHROPIC_API_KEY_OLD` are deleted. Claude CLI then falls back to its OAuth session from `claude` login, billed against the Max plan subscription.

The plugin registers with a synthetic auth key (`glueclaw-local`) so OpenClaw's auth pipeline is satisfied without real credentials.

## Per-agent isolation

GlueClaw consumes `ctx.workspaceDir` from `ProviderCreateStreamFnContext` (available in OpenClaw 2026.5.x+) and uses it as:

- The `cwd` for the spawned Claude CLI subprocess. Claude scopes conversation storage by cwd hash (`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`), so each agent gets its own project bucket.
- The root for GlueClaw's own session-id cache (`<workspaceDir>/.glueclaw/sessions.json`).

When `workspaceDir` is absent (older OpenClaw runtimes), GlueClaw falls back to the legacy global `~/.glueclaw` for both — preserving backward compatibility while keeping the per-workspace path on the happy path. See the [multi-agent guide](multi-agent.md) for layout details.

## Agent identity stamping

When the MCP loopback bridge is active (see "MCP bridge" below), GlueClaw exports `OPENCLAW_MCP_AGENT_ID` so the loopback can authenticate the Claude subprocess as the right OpenClaw agent. The id is resolved by the `resolveAgentId` helper in `src/session-key.ts`:

1. Parse `agent:<agentId>:<conversation>` out of `ctx.sessionKey` (the canonical form OpenClaw mints for gateway-driven turns).
2. Fall back to `agentDir` parsing — handle both `<state>/agents/<id>/agent` and `<state>/agents/<id>` layouts. A bare basename of `"agent"` is the leaf marker, never treated as an id.
3. Otherwise return `undefined`. If the loopback bridge would need to stamp identity but no id resolved, GlueClaw refuses (throws) instead of substituting a default — silent mis-stamping was the cause of [#36](https://github.com/zeulewan/glueclaw/issues/36).

## Resiliency

- **Request timeout** — each stream has a 120s default (`REQUEST_TIMEOUT_MS`, configurable via `GLUECLAW_REQUEST_TIMEOUT_MS`). On timeout the CLI is SIGTERM'd; SIGKILL after a 5s grace.
- **Atomic session writes** — `sessions.json` is written to a `.tmp` file then renamed.
- **Stale-resume auto-recovery** — when claude returns `is_error: true` (e.g. `errors[]: ["No conversation found with session ID: …"]`), GlueClaw drops the cached id and surfaces the real error text instead of falling back to `(no response)`. The next turn starts a fresh session. Driven by [#37](https://github.com/zeulewan/glueclaw/issues/37).
- **Session eviction** — each per-workspace map is capped at 1000 entries; oldest evicted on overflow.
- **Stderr capture** — CLI stderr is collected and concatenated into error event text for diagnostics (auth failures, rate limits, missing-stdin warnings).
- **Concurrent safety** — parallel streams with different session keys are independent. Same-key concurrent access uses last-writer-wins semantics without corruption.

## Detection scrubbing

OpenClaw's system prompt contains tokens that Anthropic's API rejects. `scrubPrompt()` rewrites them before sending to the CLI; `unscrubResponse()` reverses the renamed tokens in responses.

**Scrub (prompt → CLI):**

| Pattern                                      | Replacement             |
| -------------------------------------------- | ----------------------- |
| `personal assistant running inside OpenClaw` | `...inside GlueClaw`    |
| `HEARTBEAT_OK`                               | `GLUECLAW_ACK`          |
| `reply_to_current`                           | `reply_current`         |
| `[[reply_to:`                                | `[[reply:`              |
| `openclaw.inbound_meta`                      | `glueclaw.inbound_meta` |
| `generated by OpenClaw`                      | `generated by GlueClaw` |

**Unscrub (response → gateway):**

| Pattern         | Replacement        |
| --------------- | ------------------ |
| `GLUECLAW_ACK`  | `HEARTBEAT_OK`     |
| `reply_current` | `reply_to_current` |
| `[[reply:`      | `[[reply_to:`      |

## Prompt extraction

OpenClaw injects per-turn channel context as a trailing user-role message in `context.messages`. The block's first line is a labelled `<Section> (untrusted metadata):` header — for example `Sender (untrusted metadata):` (TUI / direct agent path) or `Conversation info (untrusted metadata):` (channel inbound, e.g. Telegram). The block contains JSON like `chat_id`, `sender_id`, etc., not the user's actual text.

`extractPromptText` walks user messages backward and returns the first one whose first non-empty line does **not** end with `(untrusted metadata):`, so the metadata wraps are always skipped and the actual user text wins. Driven by [#39](https://github.com/zeulewan/glueclaw/issues/39); previously only `Sender …` was matched, leaving `Conversation info …` to silently win the extraction race on Telegram channels.

The session-key derivation path (`src/session-key.ts`) intentionally does the **opposite** filter — it actively reads `Conversation info` blocks because that's where `chat_id` lives, and only skips `Sender` blocks. Two divergent filters, by design.

## Session persistence

Sessions enable multi-turn conversation memory across separate requests.

- **Storage:** `<workspaceDir>/.glueclaw/sessions.json` per agent (e.g. `~/.openclaw/workspaces/alice/.glueclaw/sessions.json`). Fallback: `~/.glueclaw/sessions.json` if the runtime didn't surface `workspaceDir`.
- **In-memory:** lazily-loaded `SessionStore` per workspace path; the gateway holds one `Map<workspacePath, SessionStore>` for the lifetime of the process.
- **Key format:** `glueclaw:<effectiveSessionKey>` — `sessionKey` (preferred), then `sessionId`, then `agentDir`, then `default`.
- **Capture:** Session id is set on `system/init`. **Not** persisted from `result` events when `is_error` is true (this prevents the stale-resume loop from forming).
- **Resume:** On the next turn, `--resume <id>` is added if a cached id exists; the system prompt is still re-injected so identity stays correctable across turns.
- **Recovery:** If a cached id is rejected by claude on the next turn, the cached id is dropped and a real error surfaces (see "Resiliency").

## MCP bridge

Gives the Claude CLI subprocess access to OpenClaw gateway tools (`message`, `sessions_*`, `memory_*`, `web_search`, etc.).

1. `getMcpLoopback()` bootstraps OpenClaw's in-process MCP loopback and reads its live port + owner token.
2. If an older patched OpenClaw install exposes `__GLUECLAW_MCP_PORT` / `__GLUECLAW_MCP_TOKEN`, those are accepted as a compatibility fallback.
3. `writeMcpConfig()` creates a temporary `mcp.json` pointing to `http://127.0.0.1:<port>/mcp` with auth headers including the resolved `OPENCLAW_MCP_AGENT_ID`.
4. CLI is invoked with `--strict-mcp-config --mcp-config <path>`.
5. The temp config is cleaned up in a `finally` block.

If the loopback would be wired up but `agentId` couldn't be resolved, GlueClaw refuses to spawn rather than mis-stamp identity (see "Agent identity stamping" above).

## Installer

`install.sh` runs 6 idempotent steps:

| Step | What it does                                                                      |
| ---- | --------------------------------------------------------------------------------- |
| 1    | `npm install` — project dependencies                                              |
| 2    | Adds `GLUECLAW_KEY=local` to shell profile                                        |
| 3    | Registers plugin with `openclaw plugins install --link` (fallback: manual config) |
| 4    | Configures 3 models, sets default to `glueclaw-sonnet`, allows gateway tools      |
| 5    | Writes auth profile to `~/.openclaw/agents/main/agent/auth-profiles.json`         |
| 6    | Starts the gateway on port 18789 and waits for readiness                          |

Re-run after OpenClaw updates to refresh plugin registration and model config.

## Source files

| File                   | Purpose                                                                           |
| ---------------------- | --------------------------------------------------------------------------------- |
| `index.ts`             | Plugin entry: provider registration, model catalog, ctx → opts wiring             |
| `src/stream.ts`        | Subprocess spawn, NDJSON parsing, scrub/unscrub, per-workspace session store, MCP |
| `src/session-key.ts`   | `resolveSessionKey`, `resolveAgentId`, `deriveTurnSessionKey`, metadata helpers   |
| `src/catalog.ts`       | Model catalog augmentation                                                        |
| `src/healthcheck.ts`   | Detection-trigger binary search helpers                                           |
| `src/openclaw.d.ts`    | Type declarations for the OpenClaw plugin SDK                                     |
| `openclaw.plugin.json` | Plugin manifest: provider id, auth env vars, auth choices                         |
| `install.sh`           | Installer: deps, config, auth, gateway startup                                    |
| `vitest.config.ts`     | Test runner config (forks pool, 30s timeout)                                      |

## Test coverage

117 automated tests across three layers. See [testing](testing.md) for details.

| Layer       | What it validates                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit        | `scrubPrompt`, `unscrubResponse`, `buildUsage`, `buildMsg`, `resolveSessionKey`, `resolveAgentId`, `deriveTurnSessionKey`, MCP config/bootstrap              |
| Integration | Mock CLI NDJSON scenarios, request timeout, stderr capture, MCP env stamping, system prompt resume, concurrency, stale-resume recovery, workspaceDir routing |
| E2E         | Real Claude CLI with Max plan OAuth, session resume, OpenClaw plugin registration                                                                            |
