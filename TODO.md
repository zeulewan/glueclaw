# GlueClaw TODO

## Critical

- **Conversation memory** - each message is stateless, no context from previous
  turns. Needs persistent subprocess (like ClawMux) or session resume that
  doesn't trigger detection.

## Important

- **Heartbeat untested** - GLUECLAW_ACK translation is in place but never
  verified with a real heartbeat poll
- **Cron untested** - should work via MCP bridge but never verified
- **Gateway disconnect timing** - TUI sometimes fails to connect if started too
  soon after gateway startup

## Bugs

- **Duplicate messages on Telegram** - some messages appear twice, likely
  streaming text_delta + result event both triggering delivery. Not all
  messages, intermittent.

## Nice to have

- **Tool activity indicators** - TUI shows spinner but no "Running Bash..."
  status. Would need dist patch to inject events into gateway event bus.
- **Model picker** - `/model` search doesn't list glueclaw models
  (augmentModelCatalog type mismatch). Models work when set via config.
- **Duplicate text** - occasional double output from `openclaw agent` CLI
  command (TUI is fine)

## Future

- **Persistent subprocess** - keep one `claude` process alive per session
  instead of spawning per turn. Eliminates startup latency, enables conversation
  memory, matches ClawMux architecture.
- **Autofix detection** - healthcheck cron that binary searches and patches new
  Anthropic triggers automatically
- **npm publish** - `openclaw plugins install glueclaw` instead of git clone
