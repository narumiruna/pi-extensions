#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { readWorkspaces } from "./workspace-graph.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function dependencyProblems({ root = repositoryRoot, env = process.env, execute = spawnSync } = {}) {
  root = path.resolve(root);
  const failures = [];
  const manifests = [
    "package.json",
    ...readWorkspaces(root).map(({ directoryName }) => `packages/${directoryName}/package.json`),
  ];
  for (const file of manifests) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    for (const [name, peer] of Object.entries(manifest.peerDependencies ?? {})) {
      const peerRange = typeof peer === "string" ? semver.validRange(peer) : null;
      if (peerRange === null) continue;
      const dev = manifest.devDependencies?.[name];
      if (typeof dev === "string" && semver.validRange(dev) && !semver.subset(dev, peer)) {
        failures.push(
          `${file}: devDependencies["${name}"] (${dev}) must be within peerDependencies["${name}"] (${peer}); align the tested version and supported peer range.`,
        );
      }
      // npm replaces peer edges with same-name prod, optional, and dev edges.
      // Check the peer contract separately, regardless of the source of the installed package.
      const installed = findInstalledPeer(root, file, name);
      if (!installed) {
        if (manifest.peerDependenciesMeta?.[name]?.optional !== true) {
          failures.push(
            `${file}: ${name} required peer (${peer}) is missing; run npm install and retry npm run check:dependencies.`,
          );
        }
      } else if (
        !semver.valid(installed.version) ||
        // npm uses the trimmed original spec for its wildcard exception, not a normalized range.
        ((peer || "*").trim() !== "*" && !semver.satisfies(installed.version, peer))
      ) {
        failures.push(
          `${file}: ${name} installed version (${installed.version ?? "missing"}) from ${installed.file} does not satisfy peerDependencies (${peer}); align the installed version and supported peer range.`,
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

function findInstalledPeer(root, owner, name) {
  const lookupPaths = createRequire(path.join(root, owner)).resolve.paths(name) ?? [];
  for (const directory of lookupPaths) {
    const relative = path.relative(root, directory);
    // Do not use another install scope or Node's global fallback paths.
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    const file = path.join(directory, name, "package.json");
    if (!fs.existsSync(path.dirname(file))) continue;
    try {
      // Use Node's lookup paths, not package exports: package.json can be private.
      return { version: JSON.parse(fs.readFileSync(file, "utf8")).version, file: path.relative(root, file) };
    } catch (error) {
      throw new Error(`${path.relative(root, file)}: cannot read installed peer metadata.`, { cause: error });
    }
  }
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
