import { spawnSync } from "node:child_process";
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRecordName, captureDaemonInputs, recordDaemonBuild } from "./build-record.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
rmSync(join(root, buildRecordName), { force: true });
const before = await captureDaemonInputs(root);
rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
const result = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["exec", "--", "tsc", "-p", "tsconfig.build.json"],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
chmodSync(new URL("../dist/cli.js", import.meta.url), 0o755);
await recordDaemonBuild(root, before);
