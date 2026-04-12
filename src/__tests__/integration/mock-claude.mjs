#!/usr/bin/env node
/**
 * Mock Claude CLI — outputs NDJSON events that mimic the real Claude CLI.
 * Controlled via environment variables:
 *   MOCK_SCENARIO: "simple" | "streaming" | "assistant" | "malformed" | "scrub" |
 *                  "scrub-streaming" | "error" | "empty" | "args-echo" |
 *                  "hang" | "stderr"
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
      result: "pong",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    break;

  case "streaming":
    emit({ type: "system", subtype: "init", session_id: sessionId });
    emit({
      type: "stream_event",
      event: { delta: { type: "text_delta", text: "po" } },
    });
    emit({
      type: "stream_event",
      event: { delta: { type: "text_delta", text: "ng" } },
    });
    emit({
      type: "result",
      session_id: sessionId,
      result: "pong",
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

  case "hang":
    // Emit init then hang forever — never emits result
    emit({ type: "system", subtype: "init", session_id: sessionId });
    // Keep process alive indefinitely
    setInterval(() => {}, 60_000);
    break;

  case "stderr":
    // Emit error text to stderr then exit non-zero
    process.stderr.write("Error: authentication failed\n");
    process.exit(1);
    break;

  case "tool-use":
    emit({ type: "system", subtype: "init", session_id: sessionId });
    emit({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_mock_001",
            name: "Bash",
            input: { command: "ls /tmp" },
          },
        ],
      },
    });
    emit({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            tool_use_id: "toolu_mock_001",
            type: "tool_result",
            content: "file1\nfile2",
            is_error: false,
          },
        ],
      },
    });
    emit({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Found 2 files in /tmp." }],
      },
    });
    emit({
      type: "result",
      session_id: sessionId,
      result: "Found 2 files in /tmp.",
      usage: { input_tokens: 20, output_tokens: 15 },
    });
    break;

  case "multi-tool":
    emit({ type: "system", subtype: "init", session_id: sessionId });
    emit({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_mock_010",
            name: "Read",
            input: { file_path: "/tmp/a.txt" },
          },
        ],
      },
    });
    emit({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            tool_use_id: "toolu_mock_010",
            type: "tool_result",
            content: "hello",
            is_error: false,
          },
        ],
      },
    });
    emit({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_mock_011",
            name: "Bash",
            input: { command: "echo world" },
          },
        ],
      },
    });
    emit({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            tool_use_id: "toolu_mock_011",
            type: "tool_result",
            content: "world",
            is_error: false,
          },
        ],
      },
    });
    emit({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Done with both tools." }],
      },
    });
    emit({
      type: "result",
      session_id: sessionId,
      result: "Done with both tools.",
      usage: { input_tokens: 30, output_tokens: 20 },
    });
    break;

  case "healthcheck": {
    // Simulate Anthropic detection: reject if system prompt contains HEALTHCHECK_REJECT_LINE
    const spIdx = process.argv.indexOf("--system-prompt");
    const prompt = spIdx >= 0 ? (process.argv[spIdx + 1] ?? "") : "";
    if (prompt.includes("HEALTHCHECK_REJECT_LINE")) {
      process.stderr.write("Error: API 400 — content policy violation\n");
      process.exit(1);
    }
    emit({ type: "system", subtype: "init", session_id: sessionId });
    emit({
      type: "result",
      session_id: sessionId,
      result: "pong",
      usage: { input_tokens: 10, output_tokens: 1 },
    });
    break;
  }

  default:
    process.stderr.write(`Unknown scenario: ${scenario}\n`);
    process.exit(1);
}
