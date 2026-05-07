---
title: Troubleshooting
layout: default
nav_order: 6
---

# Troubleshooting

Symptom → diagnosis index. Each section starts with the user-visible behaviour, then the root cause to check, then the fix.

## Agent replies `(no response)` with `result: success`

**Symptom:** `openclaw agent` (or TUI / channel inbound) returns `finalAssistantRawText: "(no response)"`, but the JSON `executionTrace.attempts[0].result` is `"success"` and `usage` is mostly zeros.

**Most likely cause:** stale Claude `--resume` id. GlueClaw cached a Claude session id from a prior turn, but Claude no longer has that conversation (project storage cleared, OAuth rotated, etc.). On older GlueClaw builds, claude's error result had `is_error: true` but the empty text was masked by the `text || "(no response)"` fallback, and the bogus session id from the error response was *re-persisted*, locking the agent into a permanent failure loop.

**Fix on builds with the [#37](https://github.com/zeulewan/glueclaw/issues/37) fix:** the next turn auto-recovers — the cached id is dropped on first error and a real claude error surfaces in the response. Wait one turn and retry.

**Fix on older builds:**

1. Stop the gateway (see "Gateway 'restart' is a no-op" below — `tmux kill-session` is not enough; kill by pid).
2. Wipe the session cache:
   - Per-workspace builds: `echo '{}' > <workspaceDir>/.glueclaw/sessions.json`
   - Legacy builds: `echo '{}' > ~/.glueclaw/sessions.json`
3. Optionally also clear claude's project transcripts at `~/.claude/projects/<encoded-cwd>/` if you want a *fully* clean slate.
4. Restart the gateway.

## Agent replies `Error: Failed to authenticate. API Error: 401 …`

**Symptom:** the new error path correctly surfaces a claude HTTP 401. Older builds masked this as the same `(no response)` symptom above.

**Cause:** the local `claude` OAuth session has lapsed. Verify with `claude` (or `claude /login` if it doesn't prompt).

**Fix:** re-authenticate interactively on the box where the gateway runs. Claude Max via claude.ai is the right path for GlueClaw — Anthropic API keys are never used, so `ANTHROPIC_API_KEY` envvars don't help.

## Telegram (or other channel) replies feel like the agent didn't read my message

**Symptom:** every Telegram inbound from a non-`main`-named agent gets a generic / no-op reply (`NO_REPLY`, "I didn't get a question", a short greeting unrelated to the user's text). Direct `openclaw agent --message` works fine. Using the same agent via the embedded TUI also works fine.

**Cause:** OpenClaw injects per-turn channel context as a trailing user-role message in `context.messages`. For TUI / direct paths the wrapper starts with `Sender (untrusted metadata):`. For channel inbound (e.g. Telegram), the wrapper is preceded by an extra `Conversation info (untrusted metadata):` block carrying `chat_id`, `sender_id`, etc. Older GlueClaw's prompt extractor only matched the `Sender …` prefix, so `Conversation info …` was returned as the user's "prompt" — claude saw a metadata JSON blob with no question and replied accordingly. Driven by [#39](https://github.com/zeulewan/glueclaw/issues/39).

**Fix:** upgrade to a build with #39 merged. The detector now matches *any* `<Section> (untrusted metadata):` header, and the divergent session-key derivation (which still wants the `Conversation info` block to read `chat_id`) is preserved on a separate narrow filter.

## Non-`main` agent identifies as "main" via MCP tools

**Symptom:** ask a non-default agent to call `agents_list` or otherwise self-identify; the response says it's `main` (or `agent`) instead of its real id.

**Cause:** older GlueClaw computed `agentId` as `basename(ctx.agentDir)`. For the standard `~/.openclaw/agents/<id>/agent` layout, that returns the literal trailing segment `"agent"`, which then fell through `opts.agentId ?? "main"` and stamped the MCP loopback as `"main"`. Coincidentally correct for the default agent, silently wrong for every other agent. Driven by [#36](https://github.com/zeulewan/glueclaw/issues/36).

**Fix:** upgrade to a build with #36 merged. `resolveAgentId` now parses `ctx.sessionKey` first (`agent:<agentId>:<conversation>`), then handles both `<state>/agents/<id>/agent` and `<state>/agents/<id>` directory layouts. The `?? "main"` fallback is gone — if id can't be resolved, GlueClaw refuses to wire MCP loopback rather than mis-stamp.

To verify post-upgrade, see the [Multi-agent verification](multi-agent.md#verification) recipe.

## Gateway "restart" is a no-op (state survives across `tmux kill-session`)

**Symptom:** you wipe `sessions.json` and restart the gateway via tmux, but on the next turn the same stale Claude session id is still in `--resume`. Disk wipes get overwritten by the in-memory map.

**Cause:** depending on how the gateway was originally launched (e.g. `install.sh`'s "starting gateway" step on a host with the systemd unit disabled), the openclaw process may be **daemonized away from the parent shell** (PPID becomes 1). `tmux kill-session` on a session that doesn't actually own the process is a no-op. The gateway keeps running, keeps its `sessionStores` in-memory map intact, and periodically flushes back to disk — re-burying any wipe you just did.

**How to verify:**

```bash
ss -ltnp | grep 18789
# pid X
ps -o pid,ppid,args -p <X>
# PPID = 1 → orphaned / daemonized; tmux can't reach it
```

**Fix:**

```bash
kill -TERM <pid>     # actually stop the process
# then:
tmux new-session -d -s oc-gw "openclaw gateway --port 18789"
```

Or `systemctl --user restart openclaw-gateway` on hosts where the systemd unit is enabled.

## Zombie claude subprocesses

Claude subprocesses may not exit on edge cases. The stream function sends SIGTERM on result and SIGKILL after a 5s grace, but you can confirm with `ps aux | grep [c]laude` and kill manually if needed.

## Gateway disconnect on first connect

The TUI says "disconnected" if started before the gateway has finished booting. Wait a few seconds and reconnect. The gateway log (e.g. `journalctl --user -u openclaw-gateway -f` or whichever path your launcher uses) will show `http server listening` once it's ready.

## Session tools missing inside claude

GlueClaw bootstraps OpenClaw's MCP loopback in-process. The installer no longer patches OpenClaw's dist files.

If session tools such as `sessions_send` are missing inside the spawned claude:

- Check `install.sh` output for errors during step 3 (plugin registration) and step 5 (auth profile).
- Verify OpenClaw's dist directory exists where node can find it: `ls "$(dirname "$(command -v openclaw)")/../lib/node_modules/openclaw/dist"`.
- Restart the gateway after upgrading either OpenClaw or GlueClaw.
- Confirm `agentId` is resolving — if a build with #36 refuses to wire the loopback because identity is unresolvable, the spawned claude will simply have no MCP tools rather than mis-stamped ones.

## Session resume not working (multi-turn memory)

For resume to work, both must exist for the active agent:

- The GlueClaw session map entry — at `<workspaceDir>/.glueclaw/sessions.json` (or legacy `~/.glueclaw/sessions.json`).
- Claude's project transcript — at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.

If only the GlueClaw entry exists (e.g. `~/.claude/projects/...` was cleared), the next turn will hit the stale-resume path. With #37 merged this auto-recovers; without it, the agent locks into `(no response)` (see "Agent replies `(no response)`" above).

To force a clean slate without restarting the gateway, the cache wipe alone is **not enough** because the in-memory map will get flushed back. Stop the gateway, wipe both stores, then start again.

## Detection failures (`400 Bad Request` from claude)

If you see claude returning a 400 with body mentioning system-prompt patterns, see [detection-patterns.md](detection-patterns.md) for the full trigger list and the binary-search procedure for finding new ones.

## Agent's "world-model" of available tools is stuck on an old set

**Symptom:** an agent insists certain tools (e.g. `agents_list`) aren't available, even after you've fixed config or model selection so they should be.

**Cause:** Claude's session storage is anchored to the cwd hash. If a session was started under one tool surface and is being `--resume`'d, the model's notion of "what tools I have" is sticky to that transcript even after config changes. This shows up especially after switching an agent's model (e.g. haiku → sonnet) without also rotating its session.

**Fix:** start the agent fresh.

```bash
# 1. Actually stop the gateway (see "Gateway 'restart' is a no-op").
# 2. Drop the agent's GlueClaw session-id cache.
echo '{}' > <workspaceDir>/.glueclaw/sessions.json

# 3. Optional but recommended: also drop claude's project transcripts.
rm -f ~/.claude/projects/<encoded-cwd>/*.jsonl

# 4. Restart the gateway. The next turn opens a brand-new claude session.
```
