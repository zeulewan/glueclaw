# GlueClaw

Glue Claude back into OpenClaw. May be buggy.

Uses the official Claude code and scrubs out any mention of "OpenClaw" from the system prompt due to [Anthropic not allowing its use](https://iili.io/BuL3tKN.png). Tested with Telegram. As far as I can tell all functions work such as heartbeats.

## Install

Requires [OpenClaw](https://docs.openclaw.ai) and [Claude Code](https://claude.ai/claude-code) logged in with Max. Non-destructive, won't touch your existing config or sessions. Works with OpenClaw 2026.4.2+.

```bash
git clone https://github.com/zeulewan/glueclaw.git && cd glueclaw && bash install.sh
```

## Models

| Model | Claude Model | Context |
|-------|-------------|---------|
| `glueclaw/glueclaw-opus` | Opus 4.6 | 1M |
| `glueclaw/glueclaw-sonnet` | Sonnet 4.6 | 200k |
| `glueclaw/glueclaw-haiku` | Haiku 4.5 | 200k |

Switch in TUI: `/model glueclaw/glueclaw-opus`

## Notes

- Tested with Telegram and OpenClaw TUI
- Switching between GlueClaw and other backends (e.g. Codex) works seamlessly via `/model`
- The installer patches one file in OpenClaw's dist (`server-*.js`) to expose the MCP loopback token to plugins. A `.glueclaw-bak` backup is created. Updating OpenClaw (`npm install -g openclaw`) restores the original - just re-run `bash install.sh` to re-apply the patch.

## Uninstall

Switch to another model and restore the patched file from backup:

```bash
openclaw config set agents.defaults.model anthropic/claude-sonnet-4-6   # or your preferred model
cd "$(dirname "$(which openclaw)")/../lib/node_modules/openclaw/dist" && for f in *.glueclaw-bak; do [ -f "$f" ] && mv "$f" "${f%.glueclaw-bak}"; done
openclaw gateway restart
```
