/**
 * Pick the most specific identity-bearing key OpenClaw exposed for this
 * conversation, so each conversation gets its own Claude CLI session.
 *
 * Precedence:
 *   1. `sessionKey` — semantic, stable across session resets for the same
 *      logical conversation (channel/group/sender-encoded). Best.
 *   2. `sessionId` — UUID of the current `<uuid>.jsonl` file. Rotates on reset.
 *   3. `agentDir` — collapses all conversations of one agent into one bucket.
 *      Used only when OpenClaw is older than openclaw/openclaw#73488 and
 *      doesn't propagate session identity to provider plugins.
 *   4. `"default"` — final safety net; should never hit in practice.
 */
export function resolveSessionKey(ctx: {
  sessionKey?: string;
  sessionId?: string;
  agentDir?: string;
}): string {
  const pick = (...candidates: Array<string | undefined>) => {
    for (const c of candidates) {
      const trimmed = c?.trim();
      if (trimmed) return trimmed;
    }
    return undefined;
  };
  return pick(ctx.sessionKey, ctx.sessionId, ctx.agentDir) ?? "default";
}

/**
 * Derive the canonical OpenClaw session key for the current turn, so we
 * can advertise it to the gateway via the MCP `x-session-key` header
 * (which becomes `Agent 1 (requester) session: …` in the receiver's
 * `extraSystemPrompt`).
 *
 * OpenClaw 2026.4.x does not propagate the session key into the provider's
 * `streamFn(model, context, options)` call, so we recover it from
 * artifacts the gateway *does* leave in the prompt:
 *
 *   - **Inter-agent inbound:** the system prompt is extended with an
 *     `Agent-to-agent message context` block whose
 *     `Agent 2 (target) session: agent:<id>:<chan>:…` line is literally
 *     this turn's session key. Use it verbatim.
 *
 *   - **Channel inbound (Telegram):** the most recent user message
 *     starts with a `Conversation info` JSON block carrying
 *     `"chat_id": "<channel>:<id>"`. Construct
 *     `agent:<agentId>:<channel>:<kind>:<id>` from it. Telegram
 *     convention: positive id → `direct`, `-100…` → `supergroup`,
 *     other negative → `group`.
 *
 *   - Otherwise: return undefined and let callers fall back to the
 *     registration-time key (path-based `agentDir`).
 */
export function deriveTurnSessionKey(params: {
  agentId?: string;
  systemPrompt?: string;
  messages?: Array<{
    role: string;
    content: unknown;
  }>;
}): string | undefined {
  const agentId = params.agentId?.trim();
  if (!agentId) return undefined;

  const sp = params.systemPrompt ?? "";
  const targetMatch = sp.match(
    new RegExp(
      `Agent 2 \\(target\\) session:\\s*(agent:${escapeRegExp(agentId)}:[^.\\s]+)`,
    ),
  );
  if (targetMatch) return targetMatch[1];

  const lastUserText = extractLastUserText(params.messages);
  if (lastUserText) {
    const chatMatch = lastUserText.match(
      /"chat_id"\s*:\s*"([a-z]+):(-?\d+)"/i,
    );
    if (chatMatch) {
      const channel = chatMatch[1].toLowerCase();
      const rawId = chatMatch[2];
      const { kind, id } = classifyChatId(rawId);
      return `agent:${agentId}:${channel}:${kind}:${id}`;
    }
  }

  return undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractLastUserText(
  messages: Array<{ role: string; content: unknown }> | undefined,
): string | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const txt = c
        .filter(
          (b: unknown): b is { type: string; text: string } =>
            typeof b === "object" &&
            b !== null &&
            (b as { type?: unknown }).type === "text" &&
            typeof (b as { text?: unknown }).text === "string",
        )
        .map((b) => b.text)
        .join("\n");
      if (txt) return txt;
    }
  }
  return undefined;
}

function classifyChatId(raw: string): { kind: string; id: string } {
  if (!raw.startsWith("-")) return { kind: "direct", id: raw };
  if (raw.startsWith("-100")) return { kind: "supergroup", id: raw.slice(4) };
  return { kind: "group", id: raw.slice(1) };
}
