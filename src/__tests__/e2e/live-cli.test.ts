import { describe, it, expect } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  return env;
}

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

function runClaude(
  prompt: string,
  opts?: { systemPrompt?: string },
): Promise<{ result?: string; events: any[] }> {
  return new Promise((resolve) => {
    const args = [
      "--dangerously-skip-permissions",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
    ];
    if (opts?.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
    args.push(prompt);

    const proc = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: cleanEnv(),
    });
    proc.stdin.end();

    const events: any[] = [];
    let resultText: string | undefined;

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line: string) => {
      if (!line.trim()) return;
      try {
        const data = JSON.parse(line);
        events.push(data);
        if (data.type === "result") {
          resultText = data.result;
          rl.close();
          proc.kill("SIGTERM");
        }
      } catch {
        // skip malformed
      }
    });

    proc.on("close", () => resolve({ result: resultText, events }));
    proc.on("error", () => resolve({ result: undefined, events }));

    // Safety timeout — generous to handle cold starts and hooks
    setTimeout(() => {
      proc.kill("SIGTERM");
    }, 110_000);
  });
}

// Live CLI tests call the real Claude API — each invocation takes 30-60s.
// Run with: RUN_LIVE_TESTS=1 npm run test:e2e
const runLive = cliAvailable && process.env.RUN_LIVE_TESTS === "1";

describe.skipIf(!runLive)("Live Claude CLI", () => {
  it("responds correctly and produces valid NDJSON events", async () => {
    const { result, events } = await runClaude("say pong");
    expect(result).toBeDefined();
    expect(result!.toLowerCase()).toContain("pong");
    // Verify event structure
    const types = events.map((e: any) => e.type);
    expect(types).toContain("system");
    expect(types).toContain("result");
    const resultEvt = events.find((e: any) => e.type === "result");
    expect(resultEvt.session_id).toBeDefined();
    expect(resultEvt.is_error).toBe(false);
  }, 120_000);

  it("scrubbed prompt does not trigger API 400 error", async () => {
    const { result, events } = await runClaude("acknowledge", {
      systemPrompt:
        "You are a personal assistant running inside GlueClaw. Reply with GLUECLAW_ACK.",
    });
    expect(result).toBeDefined();
    const hasError = events.some(
      (e: any) => e.type === "error" || (e.type === "result" && e.is_error),
    );
    expect(hasError).toBe(false);
  }, 120_000);
});
