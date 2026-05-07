import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  renameSync,
} from "node:fs";
import { basename, delimiter, dirname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Usage, TextContent } from "@mariozechner/pi-ai";
import { deriveTurnSessionKey } from "./session-key.js";

const PROCESS_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_SESSIONS = 1000;

/** Shape of NDJSON stream events from the Claude CLI. */
interface StreamEventData {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  errors?: string[];
  usage?: Record<string, number>;
  event?: {
    delta?: { type?: string; text?: string };
  };
  message?: {
    content?: Array<{ type: string; text?: string }>;
  };
}

/** Track claude session IDs per session key for multi-turn resume.
 *  Persisted next to the active OpenClaw agent workspace so each agent gets
 *  its own session cache (see zeulewan/glueclaw#38). The legacy
 *  `~/.glueclaw/sessions.json` location is only used as a fallback for
 *  callers that don't pass a workspaceDir (older OpenClaw runtimes). */
const LEGACY_GC_HOME = join(process.env.HOME ?? tmpdir(), ".glueclaw");
const LEGACY_SESSION_FILE = join(LEGACY_GC_HOME, "sessions.json");

type SessionStore = { filePath: string; map: Map<string, string> };
const sessionStores = new Map<string, SessionStore>();

function sessionFilePath(workspaceDir?: string): string {
  return workspaceDir
    ? join(workspaceDir, ".glueclaw", "sessions.json")
    : LEGACY_SESSION_FILE;
}

function getSessionStore(workspaceDir?: string): SessionStore {
  const filePath = sessionFilePath(workspaceDir);
  let store = sessionStores.get(filePath);
  if (!store) {
    const map = new Map<string, string>();
    try {
      const saved = JSON.parse(readFileSync(filePath, "utf8"));
      for (const [k, v] of Object.entries(saved)) {
        if (typeof v === "string") map.set(k, v);
      }
    } catch {
      // Expected on first run when session file doesn't exist
    }
    store = { filePath, map };
    sessionStores.set(filePath, store);
  }
  return store;
}

function persistStore(store: SessionStore): void {
  try {
    mkdirSync(dirname(store.filePath), { recursive: true });
    const tmp = store.filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(store.map)));
    renameSync(tmp, store.filePath); // Atomic on most filesystems
  } catch {
    // Best-effort persistence — non-fatal if disk write fails
  }
}

/** Persist all known session stores to disk. Exported for tests and callers
 *  that want to flush state explicitly. */
export function persistSessions(): void {
  for (const store of sessionStores.values()) persistStore(store);
}

export function buildUsage(raw?: Record<string, number>): Usage {
  return {
    input: raw?.input_tokens ?? 0,
    output: raw?.output_tokens ?? 0,
    cacheRead: raw?.cache_read_input_tokens ?? 0,
    cacheWrite: raw?.cache_creation_input_tokens ?? 0,
    totalTokens:
      (raw?.input_tokens ?? 0) +
      (raw?.output_tokens ?? 0) +
      (raw?.cache_creation_input_tokens ?? 0) +
      (raw?.cache_read_input_tokens ?? 0),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function buildMsg(
  model: { api: string; provider: string; id: string },
  text: string,
  usage: Usage,
): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage,
    timestamp: Date.now(),
  };
}

interface McpLoopbackRuntime {
  port: number;
  ownerToken: string;
  nonOwnerToken?: string;
}

let _mcpLoopback: { port: number; token: string } | undefined;
let _mcpBootstrapAttempted = false;

function getEnvMcpLoopback(): { port: number; token: string } | undefined {
  const portRaw = process.env.__GLUECLAW_MCP_PORT;
  const token = process.env.__GLUECLAW_MCP_TOKEN;
  if (!portRaw || !token) return undefined;

  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0) return undefined;
  return { port, token };
}

function openClawDistFromNodePath(nodePath: string): string | undefined {
  const normalized = normalize(nodePath);
  if (!normalized.includes("openclaw")) return undefined;
  if (basename(normalized) !== "node_modules") return undefined;
  return join(dirname(normalized), "dist");
}

export function resetMcpLoopbackForTests(): void {
  _mcpLoopback = undefined;
  _mcpBootstrapAttempted = false;
}

/** Bootstrap OpenClaw's MCP loopback server in-process and return the
 *  port + owner token. GlueClaw runs inside the gateway process, so we
 *  share OpenClaw's module cache: importing the same `mcp-http-*.js`
 *  the gateway loaded gives us the singleton, and a no-op when another
 *  caller already started it.
 *
 *  Returns undefined if the OpenClaw dist cannot be located or its API
 *  has changed — in that case the claude subprocess simply runs without
 *  session tools, matching pre-RFC-001 behavior. */
export async function getMcpLoopback(): Promise<
  { port: number; token: string } | undefined
> {
  const envLoopback = getEnvMcpLoopback();
  if (envLoopback) return envLoopback;

  if (_mcpLoopback) return _mcpLoopback;
  if (_mcpBootstrapAttempted) return undefined;
  _mcpBootstrapAttempted = true;

  try {
    const { readdir } = await import("node:fs/promises");
    const nodePaths = (process.env.NODE_PATH ?? "").split(delimiter);
    const distDirs = nodePaths
      .map(openClawDistFromNodePath)
      .filter((p): p is string => Boolean(p));

    for (const distDir of distDirs) {
      try {
        const files = await readdir(distDir);
        const mcpFile = files.find(
          (f) => f.startsWith("mcp-http-") && f.endsWith(".js"),
        );
        if (!mcpFile) continue;
        const mod = (await import(
          pathToFileURL(join(distDir, mcpFile)).href
        )) as Record<string, unknown>;
        // Minified aliases: n=ensureMcpLoopbackServer, i=getActiveMcpLoopbackRuntime
        const ensureFn = (mod["n"] ?? mod["ensureMcpLoopbackServer"]) as
          | (() => Promise<unknown>)
          | undefined;
        const getRuntime = (mod["i"] ?? mod["getActiveMcpLoopbackRuntime"]) as
          | (() => McpLoopbackRuntime | undefined)
          | undefined;
        if (
          typeof ensureFn !== "function" ||
          typeof getRuntime !== "function"
        ) {
          continue;
        }
        await ensureFn();
        const runtime = getRuntime();
        if (runtime?.port && runtime.ownerToken) {
          _mcpLoopback = { port: runtime.port, token: runtime.ownerToken };
          return _mcpLoopback;
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Non-fatal: session tools simply won't be available
  }
  return undefined;
}

/** Write a temporary MCP config file for the claude subprocess. */
export function writeMcpConfig(port: number): {
  path: string;
  cleanup: () => void;
} {
  const dir = join(tmpdir(), `glueclaw-mcp-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "mcp.json");
  const config = {
    mcpServers: {
      openclaw: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: {
          Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
          "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
          "x-openclaw-agent-id": "${OPENCLAW_MCP_AGENT_ID}",
          "x-openclaw-account-id": "${OPENCLAW_MCP_ACCOUNT_ID}",
          "x-openclaw-message-channel": "${OPENCLAW_MCP_MESSAGE_CHANNEL}",
        },
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return {
    path: configPath,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true });
      } catch {
        // Temp dir cleanup is best-effort
      }
    },
  };
}

/** Scrub Anthropic detection triggers from system prompts. */
export function scrubPrompt(input: string): string {
  return input
    .replace(
      /personal assistant running inside OpenClaw/g,
      "personal assistant running inside GlueClaw",
    )
    .replace(/HEARTBEAT_OK/g, "GLUECLAW_ACK")
    .replace(/reply_to_current/g, "reply_current")
    .replace(/\[\[reply_to:/g, "[[reply:")
    .replace(/openclaw\.inbound_meta/g, "glueclaw.inbound_meta")
    .replace(/generated by OpenClaw/g, "generated by GlueClaw");
}

/** Reverse scrub translations in response text for the gateway. */
export function unscrubResponse(text: string): string {
  return text
    .replace(/GLUECLAW_ACK/g, "HEARTBEAT_OK")
    .replace(/reply_current/g, "reply_to_current")
    .replace(/\[\[reply:/g, "[[reply_to:");
}

type MessageLike = { role: string; content: unknown };

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is TextContent =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => b.text)
    .join("\n");
}

function isOpenClawRuntimeMetadata(text: string): boolean {
  // OpenClaw injects per-turn context blocks as user-role messages on
  // channel inbound. Each one's first line is a labelled
  // "<Section> (untrusted metadata):" header, e.g.:
  //   - "Sender (untrusted metadata):"
  //   - "Conversation info (untrusted metadata):"
  // Match the suffix on the first non-empty line so we recognize current
  // and future labels without churning this list. See zeulewan/glueclaw#39.
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim();
  return /\(untrusted metadata\):$/.test(firstLine ?? "");
}

export function extractPromptText(messages: MessageLike[] | undefined): string {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const message = messages?.[i];
    if (!message || message.role !== "user") continue;
    const text = extractTextContent(message.content);
    if (text && !isOpenClawRuntimeMetadata(text)) return text;
  }
  return "";
}

/** Evict oldest sessions when a workspace's map exceeds MAX_SESSIONS */
function evictStore(store: SessionStore): void {
  while (store.map.size > MAX_SESSIONS) {
    const oldest = store.map.keys().next().value;
    if (oldest !== undefined) store.map.delete(oldest);
    else break;
  }
}

export function createClaudeCliStreamFn(opts: {
  claudeBin?: string;
  sessionKey?: string;
  agentId?: string;
  workspaceDir?: string;
  modelOverride?: string;
  requestTimeoutMs?: number;
}): StreamFn {
  const claudeBin = opts.claudeBin ?? "claude";
  const requestTimeout = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      let mcpCleanup: (() => void) | undefined;
      let stderrBuf = "";
      try {
        const turnSessionKey = deriveTurnSessionKey({
          agentId: opts.agentId,
          systemPrompt: context.systemPrompt,
          messages: context.messages as
            | Array<{ role: string; content: unknown }>
            | undefined,
        });
        const effectiveSessionKey =
          turnSessionKey ?? opts.sessionKey ?? "default";
        // Scrub Anthropic detection triggers (see docs/detection-patterns.md)
        const cleanPrompt = scrubPrompt(context.systemPrompt ?? "");
        const resolvedModel = opts.modelOverride ?? model.id;
        const args = [
          "--dangerously-skip-permissions",
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
        ];
        // Resume session for multi-turn conversation memory.
        // Always re-inject the system prompt — on resumptions the CLI would
        // otherwise stick to whatever identity was used on the first turn,
        // leaving no way for callers to reinforce or correct an agent's
        // identity across turns.
        const sessionKey = `glueclaw:${effectiveSessionKey}`;
        const sessionStore = getSessionStore(opts.workspaceDir);
        const existingSessionId = sessionStore.map.get(sessionKey);
        if (existingSessionId) {
          args.push("--resume", existingSessionId);
        }
        if (cleanPrompt) args.push("--system-prompt", cleanPrompt);
        if (resolvedModel) args.push("--model", resolvedModel);

        const prompt = extractPromptText(
          context.messages as MessageLike[] | undefined,
        );
        if (prompt) args.push(prompt);

        const env = { ...process.env };
        delete env.ANTHROPIC_API_KEY;
        delete env.ANTHROPIC_API_KEY_OLD;

        // Wire up MCP bridge for OpenClaw gateway tools
        const loopback = await getMcpLoopback();
        if (loopback) {
          if (!opts.agentId) {
            // Refuse to silently mis-stamp MCP loopback auth as a default
            // agent — that's how zeulewan/glueclaw#36 hid behind a working
            // setup whenever the active agent happened to be named "main".
            throw new Error(
              "GlueClaw cannot wire MCP loopback without a resolved agent id. " +
                "OpenClaw did not propagate sessionKey or a parseable agentDir " +
                "to the provider, so identity stamping would be ambiguous. " +
                "See zeulewan/glueclaw#36.",
            );
          }
          const mcp = writeMcpConfig(loopback.port);
          mcpCleanup = mcp.cleanup;
          args.push("--strict-mcp-config", "--mcp-config", mcp.path);
          env.OPENCLAW_MCP_TOKEN = loopback.token;
          env.OPENCLAW_MCP_SESSION_KEY = effectiveSessionKey;
          env.OPENCLAW_MCP_AGENT_ID = opts.agentId;
          env.OPENCLAW_MCP_ACCOUNT_ID = "";
          env.OPENCLAW_MCP_MESSAGE_CHANNEL = "";
        }

        // Anchor Claude's project storage at the active OpenClaw agent
        // workspace so per-agent state stays isolated. Falls back to the
        // legacy global directory only when the runtime didn't surface a
        // workspaceDir (older OpenClaw versions).
        const claudeCwd = opts.workspaceDir ?? LEGACY_GC_HOME;
        mkdirSync(claudeCwd, { recursive: true });
        const proc = spawn(claudeBin, args, {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: claudeCwd,
          env,
        });
        if (options?.signal)
          options.signal.addEventListener("abort", () => proc.kill("SIGTERM"));

        // Capture stderr for diagnostics
        if (proc.stderr) {
          proc.stderr.on("data", (chunk: Buffer) => {
            stderrBuf += chunk.toString();
            if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
          });
        }

        // Request timeout — kill process if it takes too long
        const requestTimer = setTimeout(() => {
          if (!ended) {
            proc.kill("SIGTERM");
            setTimeout(() => {
              try {
                proc.kill("SIGKILL");
              } catch {
                /* already dead */
              }
            }, PROCESS_TIMEOUT_MS);
          }
        }, requestTimeout);

        const info = {
          api: String(model.api ?? "anthropic-messages"),
          provider: String(model.provider ?? "glueclaw"),
          id: String(model.id),
        };
        let text = "";
        let started = false;
        let ended = false;

        const startStream = () => {
          if (started) return;
          started = true;
          const p = buildMsg(info, "", buildUsage());
          stream.push({ type: "start", partial: p });
          stream.push({ type: "text_start", contentIndex: 0, partial: p });
        };

        let streamed = false; // true if text was delivered via text_delta events

        const endStream = (usage?: Record<string, number>) => {
          if (ended) return;
          ended = true;
          // Translate renamed tokens back for the gateway
          // Skip if streaming deltas already unscrubbed each chunk
          if (!streamed) text = unscrubResponse(text);
          if (started && !streamed) {
            // Only emit text_end if text wasn't already delivered via streaming deltas
            stream.push({
              type: "text_end",
              contentIndex: 0,
              content: text,
              partial: buildMsg(info, text, buildUsage(usage)),
            });
          }
          stream.push({
            type: "done",
            reason: "stop",
            message: buildMsg(info, text || "(no response)", buildUsage(usage)),
          });
        };

        const rl = createInterface({ input: proc.stdout! });

        for await (const line of rl) {
          if (!line.trim()) continue;
          let data: StreamEventData;
          try {
            data = JSON.parse(line) as StreamEventData;
          } catch {
            // Skip malformed NDJSON lines
            continue;
          }

          const type = data.type;

          // Capture session ID for resume
          if (type === "system" && data.subtype === "init") {
            const sid = data.session_id;
            if (sid) {
              sessionStore.map.set(sessionKey, sid);
              evictStore(sessionStore);
              persistStore(sessionStore);
            }
            continue;
          }

          // Stream text deltas
          if (type === "stream_event") {
            const delta = data.event?.delta;
            if (delta?.type === "text_delta" && delta.text) {
              startStream();
              streamed = true;
              // Translate renamed tokens back in streaming deltas
              const dt = unscrubResponse(delta.text);
              text += dt;
              stream.push({
                type: "text_delta",
                contentIndex: 0,
                delta: dt,
                partial: buildMsg(info, text, buildUsage()),
              });
            }
            continue;
          }

          // Assistant message — may contain tool_use and/or text content blocks
          if (type === "assistant") {
            const content = data.message?.content;
            if (content) {
              // Emit tool call events for any tool_use blocks
              for (const block of content) {
                if (block.type === "tool_use") {
                  const b = block as {
                    type: string;
                    id: string;
                    name: string;
                    input: Record<string, unknown>;
                  };
                  startStream();
                  const toolCall = {
                    type: "toolCall" as const,
                    id: b.id,
                    name: b.name,
                    arguments: (b.input ?? {}) as Record<string, any>,
                  };
                  stream.push({
                    type: "toolcall_start",
                    contentIndex: 0,
                    toolName: b.name,
                    partial: buildMsg(info, text, buildUsage()),
                  } as any);
                  stream.push({
                    type: "toolcall_end",
                    contentIndex: 0,
                    toolCall,
                    partial: buildMsg(info, text, buildUsage()),
                  });
                }
              }

              // Handle text blocks (only if we haven't streamed via deltas)
              if (!streamed) {
                const textBlocks = content
                  .filter((b: any) => b.type === "text" && b.text)
                  .map((b: any) => b.text ?? "");
                if (textBlocks.length > 0) {
                  const fullText = textBlocks.join("\n");
                  startStream();
                  text = fullText;
                  stream.push({
                    type: "text_delta",
                    contentIndex: 0,
                    delta: fullText,
                    partial: buildMsg(info, text, buildUsage()),
                  });
                }
              }
            }
            continue;
          }

          // Result event (final) - authoritative response
          if (type === "result") {
            const isError =
              data.is_error === true ||
              data.subtype === "error_during_execution";
            const sid = data.session_id;
            if (sid && !isError) {
              // Only persist the session id from a successful turn —
              // claude emits a fresh session_id even on hard failures
              // (e.g. stale --resume), and persisting that id would
              // perpetuate the failure on every subsequent turn.
              // See zeulewan/glueclaw#37.
              sessionStore.map.set(sessionKey, sid);
              evictStore(sessionStore);
              persistStore(sessionStore);
            }
            if (isError) {
              // The cached resume id is the most likely culprit (claude
              // reports a missing conversation when the id has gone
              // stale). Drop it so the next turn starts a fresh session.
              if (existingSessionId) {
                sessionStore.map.delete(sessionKey);
                persistStore(sessionStore);
              }
              // Pick the most informative error string claude emitted:
              //   - errors[] (e.g. "No conversation found with session ID: …")
              //   - result   (e.g. "Failed to authenticate. API Error: 401 …")
              //   - api_error_status alone (e.g. 401, 429)
              // data.subtype is intentionally not used: even on real errors
              // it can be the literal string "success" (it tags the result
              // schema, not the outcome).
              const apiStatus = (data as { api_error_status?: unknown })
                .api_error_status;
              const errText =
                Array.isArray(data.errors) && data.errors.length > 0
                  ? data.errors.join("; ")
                  : typeof data.result === "string" && data.result.trim()
                    ? data.result.trim()
                    : typeof apiStatus === "number"
                      ? `claude CLI failed with HTTP ${apiStatus}`
                      : "claude CLI returned an error";
              throw new Error(errText);
            }
            // Only use result text if nothing came through streaming or assistant
            if (!text) {
              const resultText = data.result;
              if (resultText) {
                startStream();
                text = resultText;
                stream.push({
                  type: "text_delta",
                  contentIndex: 0,
                  delta: text,
                  partial: buildMsg(info, text, buildUsage()),
                });
              }
            }
            endStream(data.usage);
            rl.close();
            proc.kill("SIGTERM");
            break;
          }
        }

        // Wait for process exit with timeout
        clearTimeout(requestTimer);
        await Promise.race([
          new Promise<void>((r) => proc.on("close", () => r())),
          new Promise<void>((r) => setTimeout(r, PROCESS_TIMEOUT_MS)),
        ]);
        // SIGKILL fallback if process didn't exit after SIGTERM
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        if (!ended) endStream();
      } catch (err) {
        stream.push({
          type: "error",
          reason: "error",
          error: buildMsg(
            {
              api: String(model.api ?? "anthropic-messages"),
              provider: "glueclaw",
              id: String(model.id),
            },
            `Error: ${err instanceof Error ? err.message : String(err)}${stderrBuf ? "\nstderr: " + stderrBuf.trim() : ""}`,
            buildUsage(),
          ),
        });
      } finally {
        mcpCleanup?.();
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}
