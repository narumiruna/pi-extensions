import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const expectedNpm = "11.20.0";
const expectedConfig = {
  "strict-allow-scripts": "true",
  "min-release-age": "3",
  "ignore-scripts": "false",
  "dangerously-allow-all-scripts": "false",
  "min-release-age-exclude": "@narumitw/pi-tui-kit",
  before: "null",
};

function npm(args) {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Do not echo npm's output: user configuration can contain credentials.
  if (result.error || result.status !== 0) throw new Error("Could not read npm installation policy.");
  return result.stdout.trim();
}

try {
  if (process.argv.length !== 2) throw new Error("Installation preflight does not accept command-line overrides.");
  const expectedNode = readFileSync(path.join(root, ".node-version"), "utf8").trim();
  if (process.versions.node !== expectedNode || npm(["--version"]) !== expectedNpm) {
    throw new Error(`Use Node.js from .node-version with its bundled npm (${expectedNpm}).`);
  }

  // npm rejects a non-empty CLI/env allow-scripts policy in project installs.
  // Lower-priority .npmrc allow-scripts entries are ignored by package.json's
  // allowScripts policy and must not be misidentified as active overrides.
  for (const [key, value] of Object.entries(process.env)) {
    if (/^npm_config_allow[-_]scripts$/iu.test(key) && value?.split(",").some((entry) => entry.trim())) {
      throw new Error("Remove the npm_config_allow_scripts environment override.");
    }
  }

  const lines = npm(["config", "get", ...Object.keys(expectedConfig)]).split("\n");
  for (const [key, expected] of Object.entries(expectedConfig)) {
    if (lines.filter((line) => line === `${key}=${expected}`).length !== 1) {
      throw new Error(`Unexpected npm ${key}; restore the repository installation policy.`);
    }
  }
  if (lines.length !== Object.keys(expectedConfig).length) throw new Error("Unexpected npm policy output.");
  console.log("Validated Node.js, bundled npm, and effective installation policy.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Installation preflight failed.");
  process.exitCode = 1;
}
