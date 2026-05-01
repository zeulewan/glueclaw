---
title: Troubleshooting
layout: default
nav_order: 5
---

# Troubleshooting

## Zombie claude processes

Claude subprocesses may not exit on edge cases. Check with
`ps aux | grep claude` and kill manually. The stream function sends SIGTERM on
result, but race conditions exist.

## Gateway disconnect

TUI says "disconnected" if started before the gateway is ready. Wait a few
seconds and reconnect.

## Session tools missing

GlueClaw starts OpenClaw's MCP loopback in-process. The installer no longer
patches OpenClaw's dist files.

If session tools such as `sessions_send` are missing:

- Check `install.sh` output for errors
- Verify OpenClaw's dist directory exists:
  `ls "$(dirname "$(command -v openclaw)")/../lib/node_modules/openclaw/dist"`
- Restart the gateway after updating GlueClaw

## Session resume not working

Both of these must exist:

- `~/.glueclaw/sessions.json` (GlueClaw session map)
- `~/.claude/projects/...` (Claude Code session data)

If resume fails, delete `~/.glueclaw/sessions.json` to force a fresh session.

## Detection failures

See [detection-patterns.md](detection-patterns.md) for the full trigger list and
binary search procedure.
