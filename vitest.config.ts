import { availableParallelism } from "node:os";
import { configDefaults, defineConfig } from "vitest/config";
import { sharedModuleTests } from "./test/shared-module-tests.js";

export default defineConfig({
  test: {
    environment: "node",
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "commit.gpgsign",
      GIT_CONFIG_VALUE_0: "false",
    },
    hookTimeout: 30_000,
    // Keep includes on the children: inherited arrays concatenate, so a root include
    // would make the shared project run the isolated inventory too.
    projects: [
      {
        extends: true,
        test: {
          name: "isolated",
          include: ["test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...sharedModuleTests],
        },
      },
      {
        extends: true,
        test: { name: "shared", include: [...sharedModuleTests], isolate: false },
      },
    ],
    globalSetup: ["./test/vitest.global-setup.ts"],
    // Integration files spawn Git, LSP, and MCP children in addition to their workers.
    // Two fork workers leave room for cold Jiti loads and their child processes
    // without enlarging the five-second per-test budget. CLI overrides remain available.
    maxWorkers: Math.min(2, availableParallelism()),
    pool: "forks",
    reporters: ["default", "./test/vitest.timing-reporter.ts"],
    runner: "./test/vitest.runner.ts",
    setupFiles: ["./test/vitest.setup.ts"],
    teardownTimeout: 10_000,
    testTimeout: 5_000,
  },
});
