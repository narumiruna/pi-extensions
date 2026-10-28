#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { formatError } from "./script-support.mjs";

const hostPackage = "@earendil-works/pi-coding-agent";

function resolveHostEntry() {
  try {
    return import.meta.resolve(hostPackage);
  } catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  }

  // Pi maps host peers inside its loader, not inside standalone Node scripts.
  // Resolve beside the real CLI so npm and Bun global installs need no extra copy.
  const names = process.platform === "win32" ? ["pi.exe", "pi.cmd", "pi"] : ["pi"];
  for (const directory of process.env.PATH?.split(delimiter) ?? []) {
    for (const name of names) {
      const candidate = resolve(directory, name);
      try {
        accessSync(candidate, constants.X_OK);
        if (!statSync(candidate).isFile()) continue;
      } catch {
        continue;
      }
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `console.log(JSON.stringify(import.meta.resolve(${JSON.stringify(hostPackage)})))`,
        ],
        {
          cwd: dirname(realpathSync(candidate)),
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 64 * 1024,
        },
      );
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`Cannot resolve ${hostPackage} beside the first pi executable on PATH: ${result.stderr}`);
      }
      const entry = JSON.parse(result.stdout);
      if (typeof entry !== "string" || !entry.startsWith("file:")) {
        throw new Error("Pi resolution did not return a local module URL.");
      }
      return entry;
    }
  }
  throw new Error("Pi is not resolvable from this skill and no pi executable is available on PATH.");
}

if (process.argv.length > 2) {
  console.error("Usage: node scripts/config-path.mjs");
  process.exitCode = 2;
} else {
  try {
    const { getAgentDir } = await import(resolveHostEntry());
    process.stdout.write(`${JSON.stringify(resolve(getAgentDir(), "pi-starship.toml"))}\n`);
  } catch (error) {
    console.error(`Unable to locate pi-starship.toml: ${formatError(error)}`);
    console.error(
      "Make the intended Pi installation available on PATH, or ask for an explicit settings path. No settings were changed.",
    );
    process.exitCode = 1;
  }
}
