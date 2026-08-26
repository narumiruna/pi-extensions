import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	cacheDir: fileURLToPath(
		new URL("../../../node_modules/.cache/runtime-diagnostics-vite", import.meta.url),
	),
	test: {
		include: ["*.test.ts"],
		testTimeout: 5_000,
	},
});
