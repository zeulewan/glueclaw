# GlueClaw

Glue Claude back into OpenClaw.

Uses the official Claude CLI and scrubs out [Anthropic's detection triggers](docs/detection-patterns.md) from the system prompt due to [Anthropic not allowing its use](https://iili.io/BuL3tKN.png). Tested with Telegram. As far as I can tell all functions work such as heartbeats.

[X post](https://x.com/zeulewan/status/2042769065408680223)

## Install

Requires [OpenClaw](https://docs.openclaw.ai) 2026.4.10+, [Claude Code](https://claude.ai/claude-code) logged in with Max, and Node.js 22+. Non-destructive, won't touch your existing config or sessions.

### npm (recommended)

```bash
npm install @zeulewan/glueclaw-provider && bash node_modules/@zeulewan/glueclaw-provider/install.sh
```

### git

```bash
git clone https://github.com/zeulewan/glueclaw.git && cd glueclaw && bash install.sh
```

See [installation docs](docs/index.md) for uninstall and details.

## How it works

Uses the official Claude CLI:

```
claude --dangerously-skip-permissions -p \
    --output-format stream-json \
    --verbose --include-partial-messages \
    --system-prompt <scrubbed prompt> \
    --model <model> \
    --resume <session-id> \
    "<user message>"
```

The only way this breaks is if Anthropic changes how `--system-prompt` or `--output-format stream-json` work, which would affect all Claude Code integrations.

## Models

| Model                      | Claude Model | Context |
| -------------------------- | ------------ | ------- |
| `glueclaw/glueclaw-opus`   | Opus 4.6     | 1M      |
| `glueclaw/glueclaw-sonnet` | Sonnet 4.6   | 1M      |
| `glueclaw/glueclaw-haiku`  | Haiku 4.5    | 200k    |

Switch in TUI: `/model glueclaw/glueclaw-opus`

## Notes

- Tested with Telegram and OpenClaw TUI
- Switching between GlueClaw and other backends (e.g. Codex) works seamlessly via `/model`
- The installer patches one file in OpenClaw's dist to expose the MCP loopback token to plugins. A `.glueclaw-bak` backup is created.

## Disclaimer

Uses only official, documented Claude Code CLI flags. No reverse engineering, no credential extraction, no API spoofing. Use at your own risk. Not affiliated with Anthropic. Compatible with OpenClaw's [plugin allowlist system](https://github.com/openclaw/openclaw/commit/dc008f9).

## Docs

https://zeulewan.github.io/glueclaw/
