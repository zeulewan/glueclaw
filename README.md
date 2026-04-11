# GlueClaw

Glue Claude back into OpenClaw. **May be buggy!.**

Uses the official Claude CLI and scrubs out
[Anthropic's detection triggers](DETECTION_PATTERNS.md)
from the system prompt due to
[Anthropic not allowing its use](https://iili.io/BuL3tKN.png).
Tested with Telegram. As far as I can tell all
functions work such as heartbeats.

## Install

Requires [OpenClaw](https://docs.openclaw.ai) and
[Claude Code](https://claude.ai/claude-code) logged in
with Max. Non-destructive, won't touch your existing
config or sessions. Works with OpenClaw 2026.4.2+.

```bash
git clone https://github.com/zeulewan/glueclaw.git \
  && cd glueclaw && bash install.sh
```

## How it works

Uses the official Claude CLI:

```bash
claude --dangerously-skip-permissions -p \
    --output-format stream-json \
    --verbose --include-partial-messages \
    --system-prompt <scrubbed prompt> \
    --model <model> \
    --resume <session-id> \
    "<user message>"
```

For this to stop working, they'd have to block the
json streaming mode or the custom system prompt mode.

## Models

| Model | Claude Model | Context |
| ----- | ------------ | ------- |
| `glueclaw/glueclaw-opus` | Opus 4.6 | 1M |
| `glueclaw/glueclaw-sonnet` | Sonnet 4.6 | 200k |
| `glueclaw/glueclaw-haiku` | Haiku 4.5 | 200k |

Switch in TUI: `/model glueclaw/glueclaw-opus`

## Notes

- Tested with Telegram and OpenClaw TUI
- Switching between GlueClaw and other backends
  (e.g. Codex) works seamlessly via `/model`
- The installer patches one file in OpenClaw's dist
  (`server-*.js`) to expose the MCP loopback token
  to plugins. A `.glueclaw-bak` backup is created.
  Updating OpenClaw (`npm install -g openclaw`)
  restores the original - just re-run
  `bash install.sh` to re-apply the patch.

## Disclaimer

This project uses only official, documented Claude
Code CLI flags. No reverse engineering, no credential
extraction, no API spoofing. It's your Max
subscription, your `claude` binary, your machine. Use
at your own risk. Not affiliated with or endorsed by
Anthropic or OpenClaw.

## Uninstall

Switch to another model and restore the patched file
from backup:

```bash
openclaw config set agents.defaults.model \
  anthropic/claude-sonnet-4-6
cd "$(dirname "$(which openclaw)")/../lib/\
node_modules/openclaw/dist" && \
  for f in *.glueclaw-bak; do \
    [ -f "$f" ] && mv "$f" "${f%.glueclaw-bak}"; \
  done
openclaw gateway restart
```
