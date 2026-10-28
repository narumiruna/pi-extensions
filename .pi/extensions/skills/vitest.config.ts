import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  cacheDir: fileURLToPath(new URL("../../../node_modules/.cache/skills-vite", import.meta.url)),
  test: { include: ["test/**/*.test.ts"], testTimeout: 5_000 },
});
