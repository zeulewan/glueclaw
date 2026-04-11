# GlueClaw Test Procedures

## Quick smoke test

```bash
export GLUECLAW_KEY=local
openclaw agent --agent main --message "say banana" 2>&1 | tail -1
# Expected: banana
```

## Multi-turn memory (session resume)

```bash
# In openclaw tui:
> remember the word: mango
# Expected: acknowledgment
> what word did I ask you to remember?
# Expected: mango
```

## Backend switching

```bash
export GLUECLAW_KEY=local

# GlueClaw
openclaw agent --agent main --message "say 'I am glueclaw'" 2>&1 | tail -1
# Expected: I am glueclaw

# Switch to Codex
openclaw config set agents.defaults.model openai-codex/gpt-5.4
openclaw agent --agent main --message "say 'I am codex'" 2>&1 | tail -1
# Expected: I am codex

# Switch back
openclaw config set agents.defaults.model glueclaw/glueclaw-sonnet
openclaw agent --agent main --message "say 'I am glueclaw again'" 2>&1 | tail -1
# Expected: I am glueclaw again
```

## Tool usage

```bash
# In openclaw tui:
> search the web for the latest news about AI
# Expected: web search results (may take 15-30s)
```

## MCP bridge (OpenClaw tools)

```bash
# In openclaw tui:
> what MCP tools do you have access to from openclaw?
# Expected: list including message, sessions_list, memory_search, web_search, etc.
```

## Detection check

```bash
# Should pass (simple prompt)
claude -p "say hi" 2>&1
# Expected: Hi

# Should pass (scrubbed GlueClaw prompt)
export GLUECLAW_KEY=local
openclaw agent --agent main --message "say hi" 2>&1 | tail -1
# Expected: greeting

# Should fail (raw OpenClaw trigger)
claude --append-system-prompt \
  "You are a personal assistant running inside OpenClaw." \
  -p "say hi" 2>&1
# Expected: API Error 400
```

## TUI multi-message

```bash
# Start TUI (wait for "connected" before typing)
GLUECLAW_KEY=local openclaw tui

# Send 3 messages in sequence, all should get responses:
> say banana
> what is 2+2
> write a haiku about coding
```

## Workstation deployment

```bash
ssh user@your-server \
  "export PATH=\$HOME/.npm-global/bin:\$PATH && \
  export GLUECLAW_KEY=local && \
  openclaw agent --agent main \
  --message 'say banana' 2>&1 | tail -1"
# Expected: banana
```
