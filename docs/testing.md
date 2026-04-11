# Testing

## Automated tests

54 tests across three layers. All pass on a Max plan workstation.

```bash
npm test                           # unit + integration (~1s)
RUN_LIVE_TESTS=1 npm run test:e2e  # live CLI + OpenClaw e2e (~30s)
RUN_LIVE_TESTS=1 npm test          # everything (~30s)
```

| Layer | Tests | What it covers |
|-------|-------|----------------|
| Unit | 37 | scrubPrompt, unscrubResponse, buildUsage, buildMsg, getMcpLoopback, writeMcpConfig |
| Integration | 10 | createClaudeCliStreamFn with mock CLI subprocess (9 NDJSON scenarios) |
| E2E: OpenClaw | 3 | Plugin registration, provider exposure, agent smoke test |
| E2E: live CLI | 2 | Real Claude CLI response, scrubbed prompt acceptance |
| E2E: stream live | 2 | createClaudeCliStreamFn with real CLI + Max plan OAuth, session resume |

The stream-live tests validate the production auth path: `createClaudeCliStreamFn` deletes `ANTHROPIC_API_KEY` from the subprocess env, forcing the CLI to authenticate via Max plan OAuth.

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
