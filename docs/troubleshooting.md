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

## MCP patch not applied

The installer patches one `.js` file in OpenClaw's dist. Different OpenClaw
versions use different filenames. The installer searches by content
(`grep -rl "mcp loopback listening"`), not by filename.

If the patch fails:

- Check `install.sh` output for errors
- Verify the dist directory exists:
  `ls "$(dirname "$(command -v openclaw)")/../lib/node_modules/openclaw/dist"`
- Re-run `bash install.sh` after updating OpenClaw

## Session resume not working

Both of these must exist:

- `~/.glueclaw/sessions.json` (GlueClaw session map)
- `~/.claude/projects/...` (Claude Code session data)

If resume fails, delete `~/.glueclaw/sessions.json` to force a fresh session.

## Detection failures

See [detection-patterns.md](detection-patterns.md) for the full trigger list and
binary search procedure.
