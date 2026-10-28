#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptsDirectory, "../../..");

export function runShowcase({ execute = spawnSync, logError = console.error } = {}) {
  const commands = [
    [process.execPath, [path.join(scriptsDirectory, "build.mjs")]],
    [
      "pi",
      ["--no-extensions", "--no-skills", "--no-session", "-e", path.join(scriptsDirectory, "showcase/extension.ts")],
    ],
  ];
  for (const [command, args] of commands) {
    const result = execute(command, args, { cwd: root, stdio: "inherit" });
    if (result.error) {
      logError(result.error.message);
      return 1;
    }
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = runShowcase();
}
