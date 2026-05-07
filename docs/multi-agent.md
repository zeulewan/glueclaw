---
title: Multi-agent
layout: default
nav_order: 4
---

# Multi-agent

OpenClaw lets you run multiple isolated agents (workspaces + identities + routing) under a single gateway. GlueClaw builds on `ctx.workspaceDir` from `ProviderCreateStreamFnContext` so each agent gets its own Claude project storage and its own session-id cache. This page walks through setup, the on-disk layout, and a verification recipe that proves isolation end to end.

## Why isolate per agent

Without per-agent state, every agent's Claude conversations land in the same project bucket and share one session map. That's the regime that originally caused [#36](https://github.com/zeulewan/glueclaw/issues/36) (MCP loopback stamped every agent as `main`) and made multi-agent transcripts effectively bleed.

With per-agent state:

- Claude's session storage is keyed by cwd hash — different `workspaceDir` → different `~/.claude/projects/<hash>/` directory.
- GlueClaw's session-id cache is per-workspace — `<workspaceDir>/.glueclaw/sessions.json` per agent.
- MCP loopback identity is stamped from the resolved agent id, not a hardcoded default.
- Channel routing (e.g. Telegram bindings) targets a specific agent without context bleed.

## Adding an agent

```bash
# Make a workspace dir for the new agent (any path you want).
mkdir -p ~/.openclaw/workspaces/alice

# Register it with OpenClaw. --non-interactive requires --workspace.
openclaw agents add alice \
  --workspace ~/.openclaw/workspaces/alice \
  --model glueclaw/glueclaw-sonnet \
  --non-interactive

openclaw agents list
```

`openclaw agents list` should show the new agent with its workspace, agent dir, and model. The `agents add` command writes the new agent into `~/.openclaw/openclaw.json` under `agents.list`.

After adding agents, **fully restart the gateway** so it picks up the new config. Note: `tmux kill-session` may not actually stop the gateway — see [the troubleshooting note](troubleshooting.md#gateway-restart-is-a-no-op-state-survives-across-tmux-kill-session). Verify with `ss -ltnp | grep 18789` and check that the pid changes.

## On-disk layout

For an agent with workspace `~/.openclaw/workspaces/alice`:

```
~/.openclaw/
├── openclaw.json                         # global config; agents.list[].workspace points here
├── agents/
│   └── alice/
│       ├── agent/                        # OpenClaw's agent state dir (auth profiles, identity, etc.)
│       └── sessions/                     # OpenClaw's per-agent session jsonl + index
│           ├── sessions.json
│           └── <session-id>.jsonl
└── workspaces/
    └── alice/
        ├── HEARTBEAT.md                  # optional, agent-specific heartbeat instructions
        └── .glueclaw/
            └── sessions.json             # GlueClaw's per-agent claude-session-id cache

~/.claude/
└── projects/
    └── -home-zeul--openclaw-workspaces-alice/   # Claude CLI's per-cwd project bucket
        └── <session-id>.jsonl
```

The `main` (default) agent's workspace is conventionally `~/.openclaw/workspace` (singular, no agent subdir). Both layouts are supported.

## Channel routing (Telegram, etc.)

`openclaw agents bind <agent> <channel[:accountId]>` adds a routing rule so inbound messages on that channel land on the named agent. `openclaw agents bindings` lists current routes. See `openclaw channels` for the channel side.

## Verification

This recipe proves three things at once: agent identity is correctly stamped (#36), per-agent transcript isolation works (no cross-bleed), and the per-workspace session cache is wired (#38).

```bash
# Setup: three sonnet agents.
mkdir -p ~/.openclaw/workspaces/{alice,bob}
openclaw agents add alice --workspace ~/.openclaw/workspaces/alice \
  --model glueclaw/glueclaw-sonnet --non-interactive
openclaw agents add bob   --workspace ~/.openclaw/workspaces/bob \
  --model glueclaw/glueclaw-sonnet --non-interactive
# Restart gateway after agents add (kill by pid, not tmux).

# Round 1: each agent stores a unique secret.
openclaw agent --agent main  --message "Remember this secret: zulu-1.   Reply only: noted"
openclaw agent --agent alice --message "Remember this secret: yankee-2. Reply only: noted"
openclaw agent --agent bob   --message "Remember this secret: xray-3.   Reply only: noted"

# Round 2: each agent recalls its OWN secret.
openclaw agent --agent main  --message "What was the secret? Reply with only the secret value."
openclaw agent --agent alice --message "What was the secret? Reply with only the secret value."
openclaw agent --agent bob   --message "What was the secret? Reply with only the secret value."
# Expected: zulu-1 / yankee-2 / xray-3 — each agent its own, no bleed.

# Round 3: each agent self-identifies via the MCP loopback.
for a in main alice bob; do
  openclaw agent --agent "$a" --message \
    "Use the agents_list tool. Reply ONLY: my agent id is <id>"
done
# Expected: my agent id is main / my agent id is alice / my agent id is bob.

# Confirm three distinct per-workspace session files.
for ws in ~/.openclaw/workspace ~/.openclaw/workspaces/alice ~/.openclaw/workspaces/bob; do
  echo "$ws:"; cat "$ws/.glueclaw/sessions.json"
done
# Expected: three different Claude session ids, three different files.
```

If round 3 reports `main` for every agent, the running build is missing the [#36](https://github.com/zeulewan/glueclaw/issues/36) fix. If round 2 returns `(no response)` for any agent, see the [`(no response)` troubleshooting](troubleshooting.md#agent-replies-no-response-with-result-success) — it's almost certainly the stale-resume path, fixed in [#37](https://github.com/zeulewan/glueclaw/issues/37).

## Gotchas

- **Resume across model changes:** Claude's transcript is sticky to its session id, including the model's "what tools do I have" world-model. If you swap an agent's model and want a clean slate, drop the GlueClaw cache for that agent (`echo '{}' > <workspaceDir>/.glueclaw/sessions.json`) **and** delete the corresponding claude project transcripts (`rm -f ~/.claude/projects/<encoded-cwd>/*.jsonl`). Restart the gateway by pid — see the [tmux gotcha](troubleshooting.md#gateway-restart-is-a-no-op-state-survives-across-tmux-kill-session).
- **Tool-availability differences:** Haiku has a narrower default tool surface than Sonnet — `agents_list` may not be in scope. Use Sonnet for the verification recipe above to keep the test focused on isolation rather than tool gating.
- **Older OpenClaw runtimes:** if `ProviderCreateStreamFnContext` doesn't surface `workspaceDir`, GlueClaw falls back to the legacy global `~/.glueclaw/`. Per-agent isolation degrades to global state in that case — upgrade OpenClaw to 2026.5+ for full isolation.
- **`agents.list` is an array:** in `openclaw.json`, agents are stored as a list, not a keyed object. Use the `openclaw agents` CLI to mutate it; `openclaw config set agents.<id>.<field>` won't validate.
