---
title: Home
layout: default
nav_order: 1
---

# GlueClaw

OpenClaw provider plugin that routes inference through the Claude CLI using a Max subscription.

## Prerequisites

- [OpenClaw](https://docs.openclaw.ai) 2026.4.10+
- [Claude Code](https://claude.ai/claude-code) logged in with Max
- Node.js 22+

## Install

### npm (recommended)

```bash
npm install @zeulewan/glueclaw-provider \
  && bash node_modules/@zeulewan/glueclaw-provider/install.sh
```

### git

```bash
git clone https://github.com/zeulewan/glueclaw.git \
  && cd glueclaw && bash install.sh
```

The installer is idempotent. Re-run after OpenClaw updates to refresh plugin registration and model config.

## Verify

```bash
export GLUECLAW_KEY=local
openclaw agent --agent main \
  --message "say pong" 2>&1 | tail -n 1
```

Expected: `pong`

## Models

| Model                      | Engine            | Context |
| -------------------------- | ----------------- | ------- |
| `glueclaw/glueclaw-opus`   | Claude Opus 4.6   | 1M      |
| `glueclaw/glueclaw-sonnet` | Claude Sonnet 4.6 | 1M      |
| `glueclaw/glueclaw-haiku`  | Claude Haiku 4.5  | 200k    |

## Test suite

117 automated tests, 4 skipped. Covers unit, integration (including concurrency, timeout, stale-resume recovery, and per-workspace session routing), and end-to-end with real Claude CLI on Max plan auth.

```bash
npm test                        # unit + integration (~7s)
RUN_LIVE_TESTS=1 npm test       # full suite with live CLI (~30s)
```

See [testing](testing.md) for details.

## Uninstall

```bash
openclaw plugins uninstall glueclaw --keep-files
openclaw config set agents.defaults.model anthropic/claude-sonnet-4-6
# Stop the gateway by pid (tmux kill-session may not reach it — see
# troubleshooting), then start it again.
```

## More

- [Architecture](architecture.md)
- [Testing](testing.md)
- [Multi-agent](multi-agent.md)
- [Detection Patterns](detection-patterns.md)
- [Troubleshooting](troubleshooting.md)
