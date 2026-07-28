#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const typescriptRoot = dirname(require.resolve("typescript/package.json"));
rmSync(join(packageRoot, "dist"), { recursive: true, force: true });
execFileSync(process.execPath, [join(typescriptRoot, "bin", "tsc"), "-p", "tsconfig.build.json"], {
	cwd: packageRoot,
	stdio: "inherit",
});
