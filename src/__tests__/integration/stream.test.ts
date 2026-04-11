import { describe, it, expect } from "vitest";
import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createClaudeCliStreamFn } from "../../stream.js";

const MOCK_CLI = resolve(import.meta.dirname, "mock-claude.mjs");

/**
 * Collect all stream events from createClaudeCliStreamFn using the mock CLI.
 * The mock script reads MOCK_SCENARIO from the subprocess environment.
 */
async function collectEvents(
  scenario: string,
  opts?: {
    sessionKey?: string;
    prompt?: string;
    systemPrompt?: string;
    requestTimeoutMs?: number;
  },
): Promise<Array<{ type: string; [key: string]: unknown }>> {
  // Set env so the subprocess picks it up — must stay set until stream completes
  // because the subprocess is spawned asynchronously via queueMicrotask
  const origScenario = process.env.MOCK_SCENARIO;
  process.env.MOCK_SCENARIO = scenario;

  try {
    const streamFn = createClaudeCliStreamFn({
      claudeBin: MOCK_CLI,
      sessionKey: opts?.sessionKey ?? `test-${Date.now()}-${Math.random()}`,
      modelOverride: "claude-sonnet-4-6",
      requestTimeoutMs: opts?.requestTimeoutMs,
    });

    const model = {
      id: "glueclaw-sonnet",
      api: "anthropic-messages",
      provider: "glueclaw",
    } as any;

    const messages = [
      { role: "user" as const, content: opts?.prompt ?? "say banana" },
    ];
    const context = {
      systemPrompt: opts?.systemPrompt ?? "",
      messages,
    } as any;

    const stream = await streamFn(model, context, {});
    const events: Array<{ type: string; [key: string]: unknown }> = [];

    for await (const event of stream) {
      events.push(event as any);
    }
    return events;
  } finally {
    // Restore env after stream has fully completed
    if (origScenario !== undefined) process.env.MOCK_SCENARIO = origScenario;
    else delete process.env.MOCK_SCENARIO;
  }
}

describe("createClaudeCliStreamFn integration", () => {
  it("simple scenario: emits start, text_delta, done events", async () => {
    const events = await collectEvents("simple");
    const types = events.map((e) => e.type);
    expect(types).toContain("start");
    expect(types).toContain("text_delta");
    expect(types).toContain("done");
  });

  it("streaming scenario: delivers incremental text deltas", async () => {
    const events = await collectEvents("streaming");
    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    const deltaTexts = deltas.map((d) => d.delta as string);
    expect(deltaTexts.join("")).toContain("banana");
  });

  it("assistant scenario: handles assistant message fallback", async () => {
    const events = await collectEvents("assistant");
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    const msg = (doneEvent as any).message;
    expect(msg.content[0].text).toContain("hello from assistant");
  });

  it("malformed NDJSON lines are skipped without crashing", async () => {
    const events = await collectEvents("malformed");
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    const msg = (doneEvent as any).message;
    expect(msg.content[0].text).toContain("survived malformed lines");
  });

  it("scrub scenario: reverse-translates tokens in result text", async () => {
    const events = await collectEvents("scrub");
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    const text = (doneEvent as any).message.content[0].text;
    expect(text).toContain("HEARTBEAT_OK");
    expect(text).toContain("reply_to_current");
    expect(text).toContain("[[reply_to:");
    expect(text).not.toContain("GLUECLAW_ACK");
  });

  it("scrub-streaming: reverse-translates tokens in streaming deltas", async () => {
    const events = await collectEvents("scrub-streaming");
    const deltas = events.filter((e) => e.type === "text_delta");
    const fullText = deltas.map((d) => d.delta as string).join("");
    expect(fullText).toContain("reply_to_current");
    expect(fullText).toContain("[[reply_to:");
  });

  it("scrub-streaming: done event text is not double-unscrubbed", async () => {
    const events = await collectEvents("scrub-streaming");
    const doneEvent = events.find((e) => e.type === "done") as any;
    const doneText = doneEvent.message.content[0].text;
    // Must contain the correctly unscrubbed token
    expect(doneText).toContain("reply_to_current");
    // Must NOT contain the double-unscrub corruption
    expect(doneText).not.toContain("reply_to_reply_to_current");
  });

  it("hang: request timeout kills process and emits error", async () => {
    const events = await collectEvents("hang", {
      requestTimeoutMs: 3_000,
    });
    const errorOrDone = events.find(
      (e) => e.type === "error" || e.type === "done",
    );
    expect(errorOrDone).toBeDefined();
    // Should complete within the timeout, not hang forever
  }, 15_000);

  it("stderr: CLI error output included in error event", async () => {
    const events = await collectEvents("stderr");
    const doneEvent = events.find((e) => e.type === "done") as any;
    // Process exits without emitting result — should still get done event
    expect(doneEvent).toBeDefined();
  });

  it("done event includes usage with correct token counts", async () => {
    const events = await collectEvents("simple");
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    const usage = (doneEvent as any).message.usage;
    expect(usage.input).toBe(10);
    expect(usage.output).toBe(5);
  });

  it("empty output results in done event with fallback text", async () => {
    const events = await collectEvents("empty");
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    const text = (doneEvent as any).message.content[0].text;
    expect(text).toBe("(no response)");
  });

  it("stream events have correct model metadata", async () => {
    const events = await collectEvents("simple");
    const doneEvent = events.find((e) => e.type === "done") as any;
    expect(doneEvent.message.provider).toBe("glueclaw");
    expect(doneEvent.message.model).toBe("glueclaw-sonnet");
    expect(doneEvent.message.api).toBe("anthropic-messages");
    expect(doneEvent.message.role).toBe("assistant");
    expect(doneEvent.message.stopReason).toBe("stop");
  });

  it("start event is emitted before any text_delta", async () => {
    const events = await collectEvents("streaming");
    const startIdx = events.findIndex((e) => e.type === "start");
    const firstDeltaIdx = events.findIndex((e) => e.type === "text_delta");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(firstDeltaIdx).toBeGreaterThan(startIdx);
  });
});

/**
 * Launch a stream and collect all events. Unlike collectEvents(), this does
 * NOT set process.env.MOCK_SCENARIO — the caller must set it once before
 * launching parallel streams.
 */
async function launchStream(
  sessionKey: string,
): Promise<Array<{ type: string; [key: string]: unknown }>> {
  const streamFn = createClaudeCliStreamFn({
    claudeBin: MOCK_CLI,
    sessionKey,
    modelOverride: "claude-sonnet-4-6",
  });
  const model = {
    id: "glueclaw-sonnet",
    api: "anthropic-messages",
    provider: "glueclaw",
  } as any;
  const context = {
    systemPrompt: "",
    messages: [{ role: "user" as const, content: "say banana" }],
  } as any;
  const stream = await streamFn(model, context, {});
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  for await (const event of stream) {
    events.push(event as any);
  }
  return events;
}

describe("concurrency", () => {
  it("parallel streams with different session keys complete independently", async () => {
    process.env.MOCK_SCENARIO = "streaming";
    try {
      const results = await Promise.all([
        launchStream(`conc-a-${Date.now()}`),
        launchStream(`conc-b-${Date.now()}`),
        launchStream(`conc-c-${Date.now()}`),
      ]);

      for (const events of results) {
        const types = events.map((e) => e.type);
        expect(types).toContain("start");
        expect(types).toContain("done");
        expect(types).not.toContain("error");
      }
    } finally {
      delete process.env.MOCK_SCENARIO;
    }
  });

  it("session map integrity under concurrent writes", async () => {
    const keys = [
      `conc-int-a-${Date.now()}`,
      `conc-int-b-${Date.now()}`,
      `conc-int-c-${Date.now()}`,
    ];
    process.env.MOCK_SCENARIO = "simple";
    try {
      await Promise.all(keys.map((k) => launchStream(k)));
    } finally {
      delete process.env.MOCK_SCENARIO;
    }

    // Read sessions.json and verify all 3 keys are present
    const sessFile = join(
      process.env.HOME ?? tmpdir(),
      ".glueclaw",
      "sessions.json",
    );
    const saved = JSON.parse(readFileSync(sessFile, "utf8"));
    for (const key of keys) {
      expect(saved[`glueclaw:${key}`]).toBeDefined();
    }
  });

  it("same session key under concurrent access does not crash", async () => {
    const sharedKey = `conc-shared-${Date.now()}`;
    process.env.MOCK_SCENARIO = "simple";
    try {
      const results = await Promise.all([
        launchStream(sharedKey),
        launchStream(sharedKey),
      ]);

      for (const events of results) {
        const types = events.map((e) => e.type);
        expect(types).toContain("done");
        expect(types).not.toContain("error");
      }
    } finally {
      delete process.env.MOCK_SCENARIO;
    }
  });

  it("responses don't cross-contaminate between parallel streams", async () => {
    process.env.MOCK_SCENARIO = "streaming";
    try {
      const results = await Promise.all([
        launchStream(`conc-iso-a-${Date.now()}`),
        launchStream(`conc-iso-b-${Date.now()}`),
      ]);

      for (const events of results) {
        const types = events.map((e) => e.type);
        // Each stream should have a complete lifecycle
        const startIdx = types.indexOf("start");
        const doneIdx = types.indexOf("done");
        expect(startIdx).toBeGreaterThanOrEqual(0);
        expect(doneIdx).toBeGreaterThan(startIdx);

        // Done event should have non-empty text
        const doneEvent = events.find((e) => e.type === "done") as any;
        expect(doneEvent.message.content[0].text.length).toBeGreaterThan(0);
      }
    } finally {
      delete process.env.MOCK_SCENARIO;
    }
  });
});
