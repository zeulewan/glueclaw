# Contributing to GlueClaw

## Setup

```bash
git clone https://github.com/zeulewan/glueclaw.git
cd glueclaw
npm install
bash install.sh
```

## How it works

GlueClaw is an OpenClaw provider plugin. It spawns the real `claude` CLI as a
subprocess and translates between Claude Code's stream-json format and
OpenClaw's AssistantMessageEventStream.

The key challenge is Anthropic's detection of OpenClaw system prompts. The scrub
chain in `src/stream.ts` removes known triggers. See `DETECTION_PATTERNS.md` for
documented triggers and the binary search procedure for finding new ones.

## Testing

See `TESTS.md` for test procedures. At minimum, verify:

- `openclaw agent --agent main --message "say banana"` returns text
- TUI multi-turn works
- No zombie claude processes after messages

## Adding new detection scrubs

When Anthropic adds a new trigger:

1. Follow the binary search in `DETECTION_PATTERNS.md`
2. Add a `.replace()` to the scrub chain in `src/stream.ts`
3. If the token needs round-trip translation (like HEARTBEAT_OK), add the
   reverse in `endStream` and the streaming delta handler
4. Update `DETECTION_PATTERNS.md` with the finding
5. Test on both TUI and Telegram paths (they get different prompts)

## Common issues

- **Zombie processes**: claude subprocesses not exiting. Check
  `ps aux | grep claude`. The stream function kills the process on result, but
  edge cases exist.
- **Gateway disconnect**: TUI says "disconnected" if started before gateway is
  ready. Just reconnect.
- **MCP patch**: the install script patches one dist file. Different OpenClaw
  versions have different filenames. The script searches by content
  (`grep -rl`), not filename.
- **Session resume**: sessions persist to `~/.glueclaw/sessions.json`. Claude
  Code stores session data in `~/.claude/projects/-home-user--glueclaw/`. Both
  must exist for resume to work.

## Code structure

- `index.ts` (70 lines) - plugin registration, nothing complex
- `src/stream.ts` (220 lines) - all the logic: spawn, parse, scrub, translate,
  persist
- `install.sh` (140 lines) - installer with cross-platform support
