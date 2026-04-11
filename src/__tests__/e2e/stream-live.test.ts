import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createClaudeCliStreamFn } from "../../stream.js";

/**
 * Strip vitest env vars so child processes (Claude CLI) don't inherit them.
 * OpenClaw suppresses stdout when VITEST=true is in the environment.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  return env;
}

/* Check if Claude CLI is available and authenticated */
let cliAvailable = false;
try {
  const result = spawnSync("claude", ["auth", "status"], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["pipe", "pipe", "pipe"],
    env: cleanEnv(),
  });
  if (result.status === 0) {
    const status = JSON.parse(result.stdout);
    cliAvailable = status.loggedIn === true;
  }
} catch {
  cliAvailable = false;
}

const runLive = cliAvailable && process.env.RUN_LIVE_TESTS === "1";

describe.skipIf(!runLive)("Stream live — Max plan auth", () => {
  it("createClaudeCliStreamFn produces response via real CLI", async () => {
    const streamFn = createClaudeCliStreamFn({
      sessionKey: `e2e-max-${Date.now()}`,
      modelOverride: "claude-sonnet-4-6",
    });

    const model = {
      id: "glueclaw-sonnet",
      api: "anthropic-messages",
      provider: "glueclaw",
    } as any;

    const context = {
      systemPrompt: "",
      messages: [
        { role: "user" as const, content: "Reply with exactly: pong" },
      ],
    } as any;

    const stream = await streamFn(model, context, {});
    const events: Array<{ type: string; [key: string]: unknown }> = [];

    for await (const event of stream) {
      events.push(event as any);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain("start");
    expect(types).toContain("done");

    const doneEvent = events.find((e) => e.type === "done") as any;
    expect(doneEvent).toBeDefined();
    expect(doneEvent.reason).toBe("stop");

    const text = doneEvent.message.content[0].text.toLowerCase();
    expect(text).toContain("pong");
  }, 120_000);

  it("resumes session across calls with multi-turn memory", async () => {
    const sessionKey = `e2e-resume-${Date.now()}`;
    const model = {
      id: "glueclaw-sonnet",
      api: "anthropic-messages",
      provider: "glueclaw",
    } as any;

    // Call 1: Ask Claude to remember a word
    const streamFn1 = createClaudeCliStreamFn({
      sessionKey,
      modelOverride: "claude-sonnet-4-6",
    });
    const ctx1 = {
      systemPrompt: "",
      messages: [
        {
          role: "user" as const,
          content:
            "Remember this word exactly: mango. Just confirm you will remember it.",
        },
      ],
    } as any;

    const events1: Array<{ type: string; [key: string]: unknown }> = [];
    const stream1 = await streamFn1(model, ctx1, {});
    for await (const event of stream1) {
      events1.push(event as any);
    }
    const done1 = events1.find((e) => e.type === "done");
    expect(done1).toBeDefined();

    // Call 2: Same sessionKey triggers --resume with saved session ID
    const streamFn2 = createClaudeCliStreamFn({
      sessionKey,
      modelOverride: "claude-sonnet-4-6",
    });
    const ctx2 = {
      systemPrompt: "",
      messages: [
        {
          role: "user" as const,
          content: "What word did I ask you to remember?",
        },
      ],
    } as any;

    const events2: Array<{ type: string; [key: string]: unknown }> = [];
    const stream2 = await streamFn2(model, ctx2, {});
    for await (const event of stream2) {
      events2.push(event as any);
    }

    const done2 = events2.find((e) => e.type === "done") as any;
    expect(done2).toBeDefined();
    expect(done2.message.content[0].text.toLowerCase()).toContain("mango");
  }, 240_000);
});
