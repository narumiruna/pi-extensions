import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "commit.gpgsign",
      GIT_CONFIG_VALUE_0: "false",
    },
    hookTimeout: 30_000,
    include: ["test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    globalSetup: ["./test/vitest.global-setup.ts"],
    pool: "forks",
    runner: "./test/vitest.runner.ts",
    setupFiles: ["./test/vitest.setup.ts"],
    teardownTimeout: 10_000,
    testTimeout: 5_000,
  },
});
