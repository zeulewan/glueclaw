---
title: Testing
layout: default
nav_order: 3
---

# Testing

## Automated tests

117 tests across three layers. All pass on a Max plan workstation.

```bash
npm test                           # unit + integration (~7s)
RUN_LIVE_TESTS=1 npm run test:e2e  # live CLI + OpenClaw e2e (~30s)
RUN_LIVE_TESTS=1 npm test          # everything (~37s)
```

| Layer            | What it covers                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit             | scrubPrompt, unscrubResponse, buildUsage, buildMsg, resolveSessionKey, resolveAgentId, deriveTurnSessionKey, MCP config/bootstrap, model catalog, healthcheck             |
| Integration      | Mock CLI NDJSON scenarios, timeout, stderr capture, MCP agent identity, system prompt resume, concurrency, stale-resume recovery, workspaceDir routing, prompt extraction |
| E2E: OpenClaw    | Plugin registration, provider exposure, agent smoke test                                                                                                                  |
| E2E: live CLI    | Real Claude CLI response, scrubbed prompt acceptance                                                                                                                      |
| E2E: stream live | createClaudeCliStreamFn with real CLI + Max plan OAuth, session resume                                                                                                    |

### Integration test breakdown

| Test                          | What it validates                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| simple, streaming, assistant  | Basic NDJSON event parsing and stream lifecycle                                                  |
| malformed                     | Malformed NDJSON lines skipped without crash                                                     |
| scrub, scrub-streaming        | Detection token unscrubbing in result and delta paths                                            |
| double-unscrub guard          | endStream doesn't re-unscrub already-processed streaming text                                    |
| empty                         | Empty CLI output produces "(no response)" fallback                                               |
| hang + timeout                | Request timeout kills hung process, emits error (3s test)                                        |
| stderr capture                | CLI stderr included in error events for diagnostics                                              |
| 4 concurrency tests           | Parallel streams, session map integrity, same-key safety, no cross-contamination                 |
| MCP agent identity (3 tests)  | `OPENCLAW_MCP_AGENT_ID` propagation, throws (not silent fallback) when agentId is unresolved     |
| Stale --resume recovery       | Error event surfaces real claude error text; bogus session_id from error is not persisted; cached id is dropped on resume failure |
| Auth-error surfacing          | When `errors[]` is empty, the user-visible error uses `data.result` text and `api_error_status` (HTTP code) |
| workspaceDir migration        | Claude is spawned with `cwd = ctx.workspaceDir`; sessions persist under `<workspaceDir>/.glueclaw/sessions.json` |
| Prompt extraction (Telegram)  | Trailing `Conversation info (untrusted metadata):` user-role messages are skipped so the actual user text wins |

### What the tests prove

- **Auth path validated**: `createClaudeCliStreamFn` deletes `ANTHROPIC_API_KEY`, forcing Max plan OAuth. Tested end-to-end on a real Max plan workstation.
- **Session resume works**: Two sequential calls with the same session key, second call retrieves context from first via `--resume`.
- **Stale-resume recovers automatically**: When claude rejects a cached session id (e.g. project storage cleared), the next turn surfaces the real error and clears the cache; the turn after that succeeds against a fresh session. No silent `(no response)` masking.
- **Per-agent isolation**: With `ctx.workspaceDir`, each agent's claude project is anchored at a distinct cwd hash and its session-id cache lives at `<workspaceDir>/.glueclaw/sessions.json`. Cross-agent bleed is structurally impossible.
- **Channel inbound stays readable**: Telegram-style `Conversation info (untrusted metadata):` wraps are filtered out of prompt extraction; the user's actual text wins. Session-key derivation (which needs `chat_id`) keeps a separate filter that only skips `Sender …` blocks.
- **Concurrency safe**: 3 parallel streams complete independently. Session file is valid JSON after concurrent writes. Same session key doesn't crash under concurrent access.
- **Crash resilient**: Hung CLI killed after timeout. SIGKILL fallback if SIGTERM ignored. Atomic session writes prevent corruption.

## Manual procedures

### Smoke test

```bash
export GLUECLAW_KEY=local
openclaw agent --agent main --message "say pong" 2>&1 | tail -n 1
# Expected: pong
```

### Multi-turn memory

In `openclaw tui`:

1. "remember the word: mango" — expect acknowledgment
2. "what word did I ask you to remember?" — expect "mango"

### Detection check

```bash
# Scrubbed prompt — should pass
openclaw agent --agent main --message "say hi" 2>&1 | tail -n 1

# Raw OpenClaw trigger — should fail with 400
claude --append-system-prompt \
  "You are a personal assistant running inside OpenClaw." \
  -p "say hi" 2>&1
```

### MCP bridge

In `openclaw tui`, ask "what MCP tools do you have access to from openclaw?" — expect a list including message, sessions_list, memory_search, web_search.

### Multi-agent isolation

See the [multi-agent guide](multi-agent.md#verification) for the full three-round bleed test. Short version: store a unique secret per agent, ask each to recall, ask each to self-identify via `agents_list`. Each agent must return its own secret and its own id — pre-#36 builds had every non-`main` agent reporting as `main`.
