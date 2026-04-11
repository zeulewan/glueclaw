#!/usr/bin/env node
/**
 * Mock Claude CLI — outputs NDJSON events that mimic the real Claude CLI.
 * Controlled via environment variables:
 *   MOCK_SCENARIO: "simple" | "streaming" | "assistant" | "malformed" | "scrub" |
 *                  "scrub-streaming" | "error" | "empty" | "args-echo"
 *   MOCK_SESSION_ID: session ID to emit (default: "test-session-123")
 */

const scenario = process.env.MOCK_SCENARIO ?? "simple";
const sessionId = process.env.MOCK_SESSION_ID ?? "test-session-123";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

switch (scenario) {
  case "simple":
    emit({ type: "system", subtype: "init", session_id: sessionId });
    emit({
      type: "result",
      session_id: sessionId,
      result: "banana",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    break;

  case "streaming":
    emit({ type: "system", subtype: "init", session_id: sessionId });
    emit({
      type: "stream_event",
      event: { delta: { type: "text_delta", text: "ban" } },
    });
    emit({
      type: "stream_event",
      event: { delta: { type: "text_delta", text: "ana" } },
    });
    emit({
      type: "result",
      session_id: sessionId,
      result: "banana",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    break;

  case "assistant":
    emit({ type: "system", subtype: "init", session_id: sessionId });
    emit({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello from assistant" }] },
    });
    emit({
      type: "result",
      session_id: sessionId,
      result: "hello from assistant",
      usage: { input_tokens: 8, output_tokens: 3 },
    });
    break;

  case "malformed":
    emit({ type: "system", subtype: "init", session_id: sessionId });
    process.stdout.write("this is not json\n");
    process.stdout.write("{broken json\n");
    process.stdout.write("\n");
    emit({
      type: "result",
      session_id: sessionId,
      result: "survived malformed lines",
      usage: { input_tokens: 5, output_tokens: 3 },
    });
    break;

  case "scrub":
    emit({ type: "system", subtype: "init", session_id: sessionId });
    emit({
      type: "result",
      session_id: sessionId,
      result: "GLUECLAW_ACK reply_current [[reply:user]]",
      usage: { input_tokens: 10, output_tokens: 8 },
    });
    break;

  case "scrub-streaming":
    emit({ type: "system", subtype: "init", session_id: sessionId });
    emit({
      type: "stream_event",
      event: { delta: { type: "text_delta", text: "reply_current " } },
    });
    emit({
      type: "stream_event",
      event: { delta: { type: "text_delta", text: "[[reply:user]]" } },
    });
    emit({
      type: "result",
      session_id: sessionId,
      usage: { input_tokens: 10, output_tokens: 8 },
    });
    break;

  case "error":
    process.stderr.write("Error: authentication failed\n");
    process.exit(1);
    break;

  case "empty":
    break;

  case "args-echo":
    emit({ type: "system", subtype: "init", session_id: sessionId });
    emit({
      type: "result",
      session_id: sessionId,
      result: JSON.stringify(process.argv.slice(2)),
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    break;

  default:
    process.stderr.write(`Unknown scenario: ${scenario}\n`);
    process.exit(1);
}
