# Contributing

## Setup

```bash
git clone https://github.com/zeulewan/glueclaw.git
cd glueclaw
bash install.sh
```

See [docs/index.md](docs/index.md) for prerequisites and details.

## Testing

See [docs/testing.md](docs/testing.md). At minimum:

- `openclaw agent --agent main --message "say banana"` returns text
- TUI multi-turn works
- No zombie claude processes after messages

## Adding detection scrubs

When Anthropic adds a new trigger:

1. Follow the binary search in
   [docs/detection-patterns.md](docs/detection-patterns.md)
2. Add a `.replace()` to the scrub chain in `src/stream.ts`
3. If the token needs round-trip translation (like HEARTBEAT_OK), add the
   reverse in `endStream` and the streaming delta handler
4. Update [docs/detection-patterns.md](docs/detection-patterns.md)
5. Test on both TUI and Telegram paths (different prompts)

## Code structure

| File            | Lines | Purpose                                                      |
| --------------- | ----- | ------------------------------------------------------------ |
| `index.ts`      | ~107  | Plugin registration                                          |
| `src/stream.ts` | ~382  | Subprocess spawning, NDJSON parsing, scrub chain, MCP bridge |
| `install.sh`    | ~233  | Installer with cross-platform support                        |

See [docs/architecture.md](docs/architecture.md) for technical details and
[docs/troubleshooting.md](docs/troubleshooting.md) for common issues.
