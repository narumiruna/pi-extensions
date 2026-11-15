import { spawnSync } from "node:child_process";
import { chmodSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
const result = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["exec", "--", "tsc", "-p", "tsconfig.build.json"],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
chmodSync(new URL("../dist/cli.js", import.meta.url), 0o755);
