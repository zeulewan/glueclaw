import { basename, dirname } from "node:path";

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
 * Resolve the OpenClaw agent id from registration context.
 *
 * Precedence:
 *   1. `sessionKey` matching `agent:<agentId>:…` — the key OpenClaw mints for
 *      gateway-driven turns. Authoritative when present.
 *   2. `agentDir` path. Two layouts seen:
 *        - `<state>/agents/<agentId>/agent`  → take parent basename
 *        - `<state>/agents/<agentId>`        → take basename
 *      A bare basename of `"agent"` is the leaf marker, not an id, and would
 *      collapse every agent to the same string — never accept it.
 *   3. `undefined` — caller must decide whether to fail or degrade. We never
 *      substitute a default like `"main"` here, because identity stamping
 *      that's wrong-but-syntactically-valid silently breaks MCP auth for
 *      every non-default agent (see zeulewan/glueclaw#36).
 */
export function resolveAgentId(ctx: {
  sessionKey?: string;
  agentDir?: string;
}): string | undefined {
  const fromSessionKey = ctx.sessionKey
    ?.trim()
    .match(/^agent:([^:]+):/)?.[1]
    ?.trim();
  if (fromSessionKey) return fromSessionKey;

  const dir = ctx.agentDir?.trim();
  if (dir) {
    const last = basename(dir);
    if (last === "agent") {
      const parent = basename(dirname(dir));
      if (parent && parent !== "agents") return parent;
    } else if (last) {
      return last;
    }
  }

  return undefined;
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
 *   - **Channel inbound (Telegram):** the most recent user message starts
 *     with the gateway's `Conversation info` JSON block carrying
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
  const targetSession = targetMatch?.[1];
  if (targetSession) return targetSession;

  const lastUserText = extractLastUserText(params.messages);
  if (lastUserText) {
    const chatId = extractLeadingConversationChatId(lastUserText);
    const chatMatch = chatId?.match(/^([a-z]+):(-?\d+)$/i);
    const channel = chatMatch?.[1]?.toLowerCase();
    const rawId = chatMatch?.[2];
    if (channel && rawId) {
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
  // We deliberately skip "Sender (untrusted metadata):" blocks but allow
  // "Conversation info (untrusted metadata):" through — the latter is the
  // *only* place a channel's chat_id appears, and reading it is the whole
  // point of this function. The prompt-extraction path in stream.ts has a
  // broader filter because it wants to skip *all* runtime-context wraps.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") {
      if (!isSenderMetadataBlock(c)) return c;
      continue;
    }
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
      if (txt && !isSenderMetadataBlock(txt)) return txt;
    }
  }
  return undefined;
}

function isSenderMetadataBlock(text: string): boolean {
  return text.trimStart().startsWith("Sender (untrusted metadata):");
}

function extractLeadingConversationChatId(text: string): string | undefined {
  const json = extractLeadingConversationInfoJson(text);
  if (!json) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) return undefined;
  const chatId = (parsed as { chat_id?: unknown }).chat_id;
  return typeof chatId === "string" ? chatId : undefined;
}

function extractLeadingConversationInfoJson(text: string): string | undefined {
  const header = text.match(/^\s*Conversation info(?:\s*\([^)]+\))?:\s*/i)?.[0];
  if (!header) return undefined;

  let start = header.length;
  while (start < text.length && /\s/.test(text.charAt(start))) start++;
  if (text.charAt(start) !== "{") return undefined;

  return extractBalancedJsonObject(text, start);
}

function extractBalancedJsonObject(
  text: string,
  start: number,
): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text.charAt(i);

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return undefined;
}

function classifyChatId(raw: string): { kind: string; id: string } {
  if (!raw.startsWith("-")) return { kind: "direct", id: raw };
  if (raw.startsWith("-100")) return { kind: "supergroup", id: raw.slice(4) };
  return { kind: "group", id: raw.slice(1) };
}
