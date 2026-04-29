# RFC-002: Inter-agent message authentication — requester session stamping

**Status:** Implemented

Follow-up to RFC-001.

---

## Problem

After RFC-001, `sessions_send` is invocable as a native MCP tool, but the
end-to-end inter-agent authentication contract is still broken. When agent
A invokes `sessions_send` to deliver a message to agent B, the gateway
*does* extend B's `extraSystemPrompt` with an `Agent-to-agent message
context:` block — but the line that should carry A's identity arrives
with a useless filesystem path:

```
Agent 1 (requester) session: /home/pacolobo/.openclaw/agents/roy.
Agent 2 (target) session: agent:evacastro:telegram:direct:540382330.
```

Agent B can read the line but cannot verify it: a path is not a session
key, and it does not let B compare against `agent:roy:*` to confirm the
message actually originated from agent A's session.

---

## Root cause

OpenClaw's MCP loopback server stamps the requester block from whatever
the calling subprocess sent in the `x-session-key` header (modulo
`resolveScopedSessionKey()` normalization). GlueClaw was setting that
header to `opts.sessionKey`, which in turn was the result of
`resolveSessionKey(ctx)` at provider registration time.

OpenClaw 2026.4.x does not propagate session identity into the
provider's `createStreamFn(ctx)` call: `ctx.sessionKey` and
`ctx.sessionId` are both undefined, leaving only `ctx.agentDir` (the
on-disk path of the agent). `resolveSessionKey()` therefore fell
through to that path, and the path got forwarded as
`x-session-key` → ended up in the receiver's stamped block.

The previous code was correct *given* that OpenClaw populated
`sessionKey`/`sessionId` on the registration ctx — but with the
runtime we have, both fields are empty.

---

## Solution

Derive the canonical session key **per turn** from artifacts the
gateway already places into the prompt, and use it for the MCP
`x-session-key` header (and also for the Claude CLI resume bucket,
restoring the per-conversation session scoping originally intended by
[#4](https://github.com/zeulewan/glueclaw/pull/4)).

`src/session-key.ts` exposes a new `deriveTurnSessionKey()` helper.
Two cases, in order of preference:

1. **Inter-agent inbound** — the system prompt is extended with an
   `Agent-to-agent message context:` block. The line
   `Agent 2 (target) session: agent:<agentId>:<channel>:<kind>:<id>`
   *is* this turn's session key (the target = the agent currently
   running). Use it verbatim.

2. **Channel inbound (Telegram)** — the most recent user message
   begins with a `Conversation info (untrusted metadata):` JSON block
   carrying `"chat_id": "<channel>:<id>"`. Construct
   `agent:<agentId>:<channel>:<kind>:<id>` from it. Telegram convention:
   - positive `id` → `direct`
   - `id` starting with `-100` → `supergroup` (with the prefix stripped)
   - other negative `id` → `group`

3. Otherwise the helper returns `undefined`, callers fall back to the
   registration-time `opts.sessionKey` (the path), and behavior matches
   pre-RFC-002.

In `src/stream.ts`, every invocation of the per-turn `streamFn` now
runs `deriveTurnSessionKey()` first and uses the result as
`effectiveSessionKey` for both:

- `sessionMap` bucketing (Claude CLI `--resume` is now scoped per
  conversation, not per agent path — closes the gap left by #4).
- The `OPENCLAW_MCP_SESSION_KEY` env var that ends up as
  `x-session-key` in the MCP loopback request.

### What it is *not*

- **Not cryptographic.** The bar set by this RFC is "the gateway —
  which is already trusted — stamps requester identity into the
  receiver's system context, distinct from the message body". Signing
  inter-agent payloads is out of scope.

- **Not a replacement for OpenClaw eventually propagating session
  identity into `createStreamFn`.** When that happens (proposed in
  [openclaw#73488](https://github.com/openclaw/openclaw/pull/73488)),
  `resolveSessionKey()` will start returning the canonical key
  directly and the per-turn derivation becomes redundant. The fallback
  chain is kept so this code keeps working in either world.

---

## Implementation context

- **File:** `src/session-key.ts` (new helper) and `src/stream.ts` (call site).
- **No build step required:** OpenClaw loads the TypeScript directly via `tsx`.
- **Requires:** restart the gateway after the change.

---

## Post-implementation verification

End-to-end Roy → Eva, observed in the gateway journal with a temporary
verification log:

```
agent=roy        effectiveSessionKey=agent:roy:telegram:direct:540382330        derivedFrom=derived
agent=evacastro  incomingRequester=agent:roy:telegram:direct:540382330
```

That is: the sender's session key is derived correctly from its turn
context, sent over MCP, and surfaces verbatim in the receiver's
`extraSystemPrompt` as

```
Agent 1 (requester) session: agent:roy:telegram:direct:540382330.
```

Eva (the receiver) can now verify the prefix `agent:roy:` and the
conversation scope before acting on the message body.

---

## Discarded alternatives

| Option | Why not |
|--------|---------|
| Keep using `agentDir` and ask OpenClaw to "just accept paths" | Inverts the layering — every session-aware policy in the gateway expects a real session key |
| Maintain a separate `(agentId, lastChatId) → sessionKey` map | Redundant — every relevant turn already carries the data we need in either the system prompt or the latest user message |
| Add new MCP headers (`x-glueclaw-agent-dir`, etc.) and patch OpenClaw to resolve sessions from them | Cross-repo change; bypasses the gateway's existing session resolution logic |
| Wait for [openclaw#73488](https://github.com/openclaw/openclaw/pull/73488) to land | Fix is local-only and the fallback chain remains compatible once #73488 lands |
