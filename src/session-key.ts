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
