import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: { include: ["packages/pi-inspect/test/*.test.ts"], testTimeout: 5000, maxWorkers: 2 },
});
