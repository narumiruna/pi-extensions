#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { readWorkspaces } from "./workspace-graph.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function dependencyProblems({ root = repositoryRoot, env = process.env, execute = spawnSync } = {}) {
  const failures = [];
  const manifests = [
    "package.json",
    ...readWorkspaces(root).map(({ directoryName }) => `packages/${directoryName}/package.json`),
  ];
  for (const file of manifests) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    for (const [name, peer] of Object.entries(manifest.peerDependencies ?? {})) {
      const dev = manifest.devDependencies?.[name];
      // Non-registry dev sources are checked at their resolved version by npm below.
      if (typeof dev !== "string" || !semver.validRange(dev) || !semver.validRange(peer)) continue;
      if (!semver.subset(dev, peer)) {
        failures.push(
          `${file}: devDependencies["${name}"] (${dev}) must be within peerDependencies["${name}"] (${peer}); align the tested version and supported peer range.`,
        );
      }
    }
  }

  const command = env.npm_execpath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const prefix = env.npm_execpath ? [env.npm_execpath] : [];
  // npm owns peer resolution, hoisting, optional peers, aliases, overrides and workspace links.
  // A manifest-only comparison cannot detect a hoisted dependency resolving the wrong peer.
  const result = execute(
    command,
    [...prefix, "ls", "--all", "--depth=Infinity", "--include=dev", "--include=optional", "--include=peer", "--json"],
    {
      cwd: root,
      env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error) {
    failures.push(
      `package.json/package-lock.json: cannot inspect installed dependencies (${result.error.message}); run npm install and retry npm run check:dependencies.`,
    );
    return failures;
  }
  let tree;
  try {
    tree = JSON.parse(result.stdout);
    if (!tree || typeof tree !== "object" || Array.isArray(tree)) throw new Error("not a dependency tree");
  } catch {
    failures.push(
      "package.json/package-lock.json: npm ls did not return a dependency tree; run npm install and retry npm run check:dependencies.",
    );
    return failures;
  }
  // npm permits extraneous packages; they do not make a declared dependency incompatible.
  const problems = Array.isArray(tree.problems)
    ? tree.problems.filter((problem) => !String(problem).startsWith("extraneous:"))
    : [];
  if (result.status !== 0 || problems.length > 0) {
    failures.push(
      "package.json/package-lock.json: installed dependencies are incompatible or incomplete; align the named dependency/peer ranges, run npm install, and retry npm run check:dependencies.",
    );
    for (const problem of problems) failures.push(String(problem));
  }
  return failures;
}

if (import.meta.main) {
  try {
    const failures = dependencyProblems();
    if (failures.length > 0) {
      console.error("Dependency compatibility check failed:");
      for (const failure of failures) console.error(`- ${failure}`);
      process.exitCode = 1;
    } else console.log("Dependency compatibility check passed: dev/peer ranges and installed dependencies agree.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
