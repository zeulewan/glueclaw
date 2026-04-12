import { spawn } from "node:child_process";

/**
 * Binary-search a prompt (split into lines) to find the single line
 * that causes a test function to reject. The testFn receives a joined
 * prompt string and should return true if it passes, false if it fails.
 *
 * Returns the offending line, or null if the full prompt passes.
 */
export async function binarySearchTrigger(
  lines: string[],
  testFn: (chunk: string) => Promise<boolean>,
): Promise<string | null> {
  if (lines.length === 0) return null;

  const fullPasses = await testFn(lines.join("\n"));
  if (fullPasses) return null;

  if (lines.length === 1) return lines[0] ?? null;

  let lo = 0;
  let hi = lines.length;

  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const firstHalf = lines.slice(lo, mid).join("\n");
    const fails = !(await testFn(firstHalf));
    if (fails) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return lines[lo] ?? null;
}

/**
 * Test whether the current scrubbed system prompt passes Claude CLI
 * without triggering a 400 error. If it fails, binary-searches to
 * identify the offending line.
 */
export async function runHealthcheck(opts: {
  claudeBin?: string;
  systemPrompt: string;
  scenario?: string;
}): Promise<{ ok: boolean; trigger: string | null }> {
  const claudeBin = opts.claudeBin ?? "claude";
  const scenario = opts.scenario ?? "healthcheck";

  const testPrompt = async (prompt: string): Promise<boolean> => {
    return new Promise((resolve) => {
      const env = { ...process.env, MOCK_SCENARIO: scenario };
      const args = [
        "--dangerously-skip-permissions",
        "-p",
        "--output-format",
        "stream-json",
        "--system-prompt",
        prompt,
        "--model",
        "claude-sonnet-4-6",
        "say pong",
      ];
      const proc = spawn(claudeBin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });

      let exitCode = 0;
      proc.on("close", (code: number | null) => {
        exitCode = code ?? 0;
        resolve(exitCode === 0);
      });
      proc.on("error", () => resolve(false));
    });
  };

  const lines = opts.systemPrompt.split("\n");
  const fullPasses = await testPrompt(opts.systemPrompt);
  if (fullPasses) return { ok: true, trigger: null };

  const trigger = await binarySearchTrigger(lines, testPrompt);
  return { ok: false, trigger };
}

// CLI entry point: npx tsx src/healthcheck.ts
const isMain =
  typeof process !== "undefined" && process.argv[1]?.endsWith("healthcheck.ts");
if (isMain) {
  const { scrubPrompt } = await import("./stream.js");
  const promptFile = process.argv[2];

  let prompt: string;
  if (promptFile) {
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(promptFile, "utf8");
    prompt = scrubPrompt(raw);
    console.log(`GlueClaw healthcheck (prompt: ${promptFile})`);
  } else {
    prompt = "You are a helpful assistant running inside GlueClaw.";
    console.log("GlueClaw healthcheck (connectivity test)");
  }

  console.log("  Testing scrubbed prompt against Claude CLI...\n");

  const result = await runHealthcheck({ systemPrompt: prompt });
  if (result.ok) {
    console.log("  PASS: scrubbed prompt accepted");
  } else {
    console.log("  FAIL: prompt rejected");
    if (result.trigger) console.log(`  Trigger line: ${result.trigger}`);
    if (promptFile) {
      console.log(
        "\n  To narrow further, run with the full OpenClaw system prompt.",
      );
    }
  }
  process.exit(result.ok ? 0 : 1);
}
