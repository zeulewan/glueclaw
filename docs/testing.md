---
title: Testing
layout: default
nav_order: 3
---

# Testing

## Automated tests

61 tests across three layers. All pass on a Max plan workstation.

```bash
npm test                           # unit + integration (~3s)
RUN_LIVE_TESTS=1 npm run test:e2e  # live CLI + OpenClaw e2e (~30s)
RUN_LIVE_TESTS=1 npm test          # everything (~32s)
```

| Layer            | Tests | What it covers                                                                     |
| ---------------- | ----- | ---------------------------------------------------------------------------------- |
| Unit             | 37    | scrubPrompt, unscrubResponse, buildUsage, buildMsg, getMcpLoopback, writeMcpConfig |
| Integration      | 17    | Mock CLI (11 NDJSON scenarios), timeout, stderr capture, concurrency               |
| E2E: OpenClaw    | 3     | Plugin registration, provider exposure, agent smoke test                           |
| E2E: live CLI    | 2     | Real Claude CLI response, scrubbed prompt acceptance                               |
| E2E: stream live | 2     | createClaudeCliStreamFn with real CLI + Max plan OAuth, session resume             |

### Integration test breakdown

| Test                         | What it validates                                                                |
| ---------------------------- | -------------------------------------------------------------------------------- |
| simple, streaming, assistant | Basic NDJSON event parsing and stream lifecycle                                  |
| malformed                    | Malformed NDJSON lines skipped without crash                                     |
| scrub, scrub-streaming       | Detection token unscrubbing in result and delta paths                            |
| double-unscrub guard         | endStream doesn't re-unscrub already-processed streaming text                    |
| empty                        | Empty CLI output produces "(no response)" fallback                               |
| hang + timeout               | Request timeout kills hung process, emits error (3s test)                        |
| stderr capture               | CLI stderr included in error events for diagnostics                              |
| 4 concurrency tests          | Parallel streams, session map integrity, same-key safety, no cross-contamination |

### What the tests prove

- **Auth path validated**: `createClaudeCliStreamFn` deletes `ANTHROPIC_API_KEY`, forcing Max plan OAuth. Tested end-to-end on a real Max plan workstation.
- **Session resume works**: Two sequential calls with the same session key, second call retrieves context from first via `--resume`.
- **Concurrency safe**: 3 parallel streams complete independently. Session file is valid JSON after concurrent writes. Same session key doesn't crash under concurrent access.
- **Crash resilient**: Hung CLI killed after timeout. SIGKILL fallback if SIGTERM ignored. Atomic session writes prevent corruption.

## Manual procedures

### Smoke test

```bash
export GLUECLAW_KEY=local
openclaw agent --agent main --message "say banana" 2>&1 | tail -n 1
# Expected: banana
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
