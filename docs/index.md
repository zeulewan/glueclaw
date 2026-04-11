---
title: GlueClaw
---

# GlueClaw

OpenClaw provider plugin that routes inference through the Claude CLI using a Max subscription.

## Prerequisites

- [OpenClaw](https://docs.openclaw.ai) 2026.4.10+
- [Claude Code](https://claude.ai/claude-code) logged in with Max
- Node.js 18+

## Install

```bash
git clone https://github.com/zeulewan/glueclaw.git \
  && cd glueclaw && bash install.sh
```

The installer is idempotent. Re-run after OpenClaw updates to re-apply patches.

## Verify

```bash
export GLUECLAW_KEY=local
openclaw agent --agent main \
  --message "say banana" 2>&1 | tail -n 1
```

Expected: `banana`

## Models

| Model | Engine | Context |
|-------|--------|---------|
| `glueclaw/glueclaw-opus` | Claude Opus 4.6 | 1M |
| `glueclaw/glueclaw-sonnet` | Claude Sonnet 4.6 | 200k |
| `glueclaw/glueclaw-haiku` | Claude Haiku 4.5 | 200k |

## Test suite

54 automated tests, 0 skipped. Covers unit, integration, and end-to-end including real Claude CLI with Max plan auth and session resume.

```bash
npm test                        # unit + integration (~1s)
RUN_LIVE_TESTS=1 npm test       # full suite with live CLI (~30s)
```

See [testing](testing.md) for details.

## Uninstall

```bash
openclaw config set agents.defaults.model \
  anthropic/claude-sonnet-4-6
cd "$(dirname "$(command -v openclaw)")/../lib/\
node_modules/openclaw/dist" && \
  for f in *.glueclaw-bak; do \
    [ -f "$f" ] && mv "$f" "${f%.glueclaw-bak}"; \
  done
openclaw gateway restart
```

## More

- [Architecture](architecture.md)
- [Testing](testing.md)
- [Detection Patterns](detection-patterns.md)
- [Troubleshooting](troubleshooting.md)
