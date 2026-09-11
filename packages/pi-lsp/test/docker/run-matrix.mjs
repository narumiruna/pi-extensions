#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dockerDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dockerDir, "../../../..");
const matrix = JSON.parse(readFileSync(path.join(dockerDir, "matrix.json"), "utf8"));
const requested = process.argv.slice(2);
if (requested.length !== 1 || requested[0] === "--all") {
  throw new Error("Run exactly one LSP profile at a time: node packages/pi-lsp/test/docker/run-matrix.mjs <server>");
}
const selectedProfile = matrix.profiles.find(({ name }) => name === requested[0]);
if (!selectedProfile) throw new Error(`Unknown profile: ${requested[0]}`);
const rawDir = path.join(dockerDir, "results", "raw");
mkdirSync(rawDir, { recursive: true });
let failed = false;

for (const profile of [selectedProfile]) {
  const image = `pi-lsp-smoke:${profile.name.replaceAll(/[^a-z0-9_.-]/giu, "-")}`;
  console.error(`\n=== Building ${profile.name} ===`);
  const build = spawnSync(
    "docker",
    [
      "build",
      "--file",
      path.join(dockerDir, profile.dockerfile ?? "Dockerfile"),
      "--build-arg",
      `NIXPKGS_REV=${matrix.nixpkgsRevision}`,
      "--build-arg",
      `NIX_PACKAGES=${profile.nixPackages.join(" ")}`,
      "--build-arg",
      `SETUP_COMMAND_B64=${Buffer.from(profile.setupCommand ?? "").toString("base64")}`,
      "--tag",
      image,
      root,
    ],
    { stdio: "inherit" },
  );
  if (build.status !== 0) {
    failed = true;
    writeFileSync(
      path.join(rawDir, `${profile.name}.json`),
      `${JSON.stringify({ profile: profile.name, passed: false, buildFailed: true }, null, 2)}\n`,
    );
    continue;
  }

  console.error(`=== Running ${profile.name} ===`);
  const run = spawnSync("docker", ["run", "--rm", "--env", `PROFILE=${profile.name}`, image], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (run.stderr) process.stderr.write(run.stderr);
  let parsed;
  try {
    parsed = JSON.parse(run.stdout.trim());
  } catch (error) {
    parsed = {
      profile: profile.name,
      passed: false,
      parseFailure: error instanceof Error ? error.message : String(error),
      stdout: run.stdout,
    };
  }
  writeFileSync(path.join(rawDir, `${profile.name}.json`), `${JSON.stringify(parsed, null, 2)}\n`);
  console.error(`${profile.name}: ${parsed.passed ? "PASS" : "FAIL"}`);
  if (run.status !== 0 || !parsed.passed) failed = true;
}

if (failed) process.exitCode = 1;
