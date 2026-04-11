import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    testTimeout: 30_000,
    // Use forks pool so child processes have proper stdio behavior.
    // Vitest's default threads pool can interfere with stdout capture.
    pool: "forks",
  },
});
