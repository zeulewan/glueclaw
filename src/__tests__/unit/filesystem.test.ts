import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { writeMcpConfig } from "../../stream.js";

describe("writeMcpConfig", () => {
  let cleanup: (() => void) | undefined;
  let configPath: string | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    configPath = undefined;
  });

  it("creates a temp directory and config file", () => {
    const result = writeMcpConfig(9999);
    configPath = result.path;
    cleanup = result.cleanup;
    expect(existsSync(configPath)).toBe(true);
  });

  it("config JSON has correct structure", () => {
    const result = writeMcpConfig(9999);
    configPath = result.path;
    cleanup = result.cleanup;
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers.openclaw).toBeDefined();
    expect(config.mcpServers.openclaw.type).toBe("http");
    expect(config.mcpServers.openclaw.headers).toBeDefined();
    expect(config.mcpServers.openclaw.headers.Authorization).toBe(
      "Bearer ${OPENCLAW_MCP_TOKEN}",
    );
  });

  it("URL contains the provided port", () => {
    const result = writeMcpConfig(4567);
    configPath = result.path;
    cleanup = result.cleanup;
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.mcpServers.openclaw.url).toBe("http://127.0.0.1:4567/mcp");
  });

  it("cleanup removes the temp directory", () => {
    const result = writeMcpConfig(9999);
    configPath = result.path;
    const dir = configPath.replace(/\/mcp\.json$/, "");
    expect(existsSync(dir)).toBe(true);
    result.cleanup();
    expect(existsSync(dir)).toBe(false);
    cleanup = undefined; // already cleaned up
  });

  it("cleanup is safe to call twice", () => {
    const result = writeMcpConfig(9999);
    configPath = result.path;
    result.cleanup();
    // Second call should not throw
    expect(() => result.cleanup()).not.toThrow();
    cleanup = undefined;
  });
});
