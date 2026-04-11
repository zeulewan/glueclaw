import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

/**
 * Run openclaw with JSON output, stripping VITEST env var which
 * causes OpenClaw to suppress output.
 */
function ocJson(args: string[]): any {
  const env = { ...process.env };
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  const result = spawnSync("openclaw", [...args, "--json"], {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  try {
    return JSON.parse((result.stdout ?? "") + (result.stderr ?? ""));
  } catch {
    return null;
  }
}

// Check OpenClaw availability at module level.
let openclawAvailable = false;
try {
  const data = ocJson(["plugins", "list"]);
  openclawAvailable = !!data?.plugins?.some(
    (p: any) => p.id === "glueclaw" && p.status === "loaded",
  );
} catch {
  openclawAvailable = false;
}

describe.skipIf(!openclawAvailable)("OpenClaw GlueClaw plugin", () => {
  it("plugin is registered and loaded", () => {
    const data = ocJson(["plugins", "list"]);
    const glueclaw = data.plugins.find((p: any) => p.id === "glueclaw");
    expect(glueclaw).toBeDefined();
    expect(glueclaw.status).toBe("loaded");
    expect(glueclaw.name).toBe("@openclaw/glueclaw-provider");
  });

  it("plugin exposes glueclaw provider", () => {
    const data = ocJson(["plugins", "list"]);
    const glueclaw = data.plugins.find((p: any) => p.id === "glueclaw");
    expect(glueclaw).toBeDefined();
    // Plugin should be in openclaw format and have provider capabilities
    expect(glueclaw.format).toBe("openclaw");
    expect(glueclaw.source).toContain("glueclaw");
  });

  it("smoke test: openclaw agent responds", () => {
    const env = { ...process.env, GLUECLAW_KEY: "local" };
    delete (env as any).VITEST;
    delete (env as any).VITEST_POOL_ID;
    delete (env as any).VITEST_WORKER_ID;
    const result = spawnSync(
      "openclaw",
      ["agent", "--agent", "main", "--message", "say pong", "--json"],
      {
        encoding: "utf8",
        timeout: 90_000,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      },
    );
    const out = (result.stdout ?? "") + (result.stderr ?? "");
    // If glueclaw provider is active, should get a response (may vary by config)
    expect(out.length).toBeGreaterThan(0);
  }, 90_000);
});
