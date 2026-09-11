#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Range from "semver/classes/range.js";

export function publishPackagesSequentially({
  cwd = process.cwd(),
  changesetsOutput = process.env.CHANGESETS_OUTPUT,
  publishFailuresFile = process.env.PUBLISH_FAILURES_FILE,
  publishedPackagesFile = process.env.PUBLISHED_PACKAGES_FILE,
  run = spawnSync,
} = {}) {
  if (!changesetsOutput || !publishFailuresFile || !publishedPackagesFile) {
    throw new Error(
      "CHANGESETS_OUTPUT, PUBLISH_FAILURES_FILE, and PUBLISHED_PACKAGES_FILE are required by the release workflow.",
    );
  }

  mkdirSync(path.dirname(changesetsOutput), { recursive: true });
  mkdirSync(path.dirname(publishFailuresFile), { recursive: true });
  mkdirSync(path.dirname(publishedPackagesFile), { recursive: true });
  writeFileSync(changesetsOutput, "");
  writeFileSync(publishFailuresFile, "");
  writeFileSync(publishedPackagesFile, "");

  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "pi-publish-plan-"));
  const planPath = path.join(temporaryDirectory, "publish-plan.json");

  try {
    const changesetsCli = path.join(cwd, "node_modules", "@changesets", "cli", "bin.js");
    const planResult = run(process.execPath, [changesetsCli, "publish-plan", "--output", planPath], {
      cwd,
      env: process.env,
      stdio: "inherit",
    });
    if (planResult.error) throw planResult.error;
    if (planResult.status !== 0) return planResult.status ?? 1;

    const plan = readPublishPlan(planPath);
    const internalDependencies = readInternalDependencies(cwd);
    const blockedPackages = new Set();
    const published = [];
    const failed = [];
    const skipped = [];
    const tagged = [];

    for (const chunk of plan) {
      for (const release of chunk) {
        const tag = `${release.name}@${release.version}`;
        if (release.kind === "tag-only") {
          writeTagEvent(changesetsOutput, release, tag);
          tagged.push(tag);
          continue;
        }

        const blockers = [...(internalDependencies.get(release.name) ?? [])].filter((dependency) =>
          blockedPackages.has(dependency),
        );
        if (blockers.length > 0) {
          const reason = `blocked by failed release(s): ${blockers.join(", ")}`;
          blockedPackages.add(release.name);
          skipped.push(`${tag}: ${reason}`);
          recordFailure(publishFailuresFile, release, reason);
          writeErrorAnnotation(`Skipped dependent release ${tag}`, reason);
          continue;
        }

        console.log(`Publishing ${tag}...`);
        const result = run(
          "npm",
          ["publish", "--workspace", release.name, "--access", release.access, "--tag", release.tag],
          { cwd, env: process.env, stdio: "inherit" },
        );

        if (!result.error && result.status === 0) {
          writeTagEvent(changesetsOutput, release, tag);
          recordPublishedPackage(publishedPackagesFile, release);
          published.push(tag);
          continue;
        }

        const reason = result.error?.message ?? `npm publish exited with code ${result.status ?? 1}`;
        blockedPackages.add(release.name);
        failed.push(`${tag}: ${reason}`);
        recordFailure(publishFailuresFile, release, reason);
        writeErrorAnnotation(`Failed to publish ${tag}`, reason);
      }
    }

    printSummary("Published", published);
    printSummary("Tags to create", tagged);
    printSummary("Failed", failed);
    printSummary("Skipped dependents", skipped);
    return 0;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function readPublishPlan(planPath) {
  const value = JSON.parse(readFileSync(planPath, "utf8"));
  if (value?.version !== 1 || !Array.isArray(value.plan)) {
    throw new Error("Changesets returned an invalid publish plan.");
  }
  for (const chunk of value.plan) {
    if (!Array.isArray(chunk)) throw new Error("Changesets returned an invalid publish plan chunk.");
    for (const release of chunk) {
      if (
        (release?.kind !== "publish" && release?.kind !== "tag-only") ||
        typeof release.name !== "string" ||
        typeof release.version !== "string" ||
        (release.kind === "publish" && (typeof release.access !== "string" || typeof release.tag !== "string"))
      ) {
        throw new Error("Changesets returned an invalid publish plan entry.");
      }
    }
  }
  return value.plan;
}

function readInternalDependencies(cwd) {
  const manifests = readdirSync(path.join(cwd, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => JSON.parse(readFileSync(path.join(cwd, "packages", entry.name, "package.json"), "utf8")));
  const internalVersions = new Map(manifests.map((manifest) => [manifest.name, manifest.version]));
  return new Map(
    manifests.map((manifest) => {
      const runtimeDependencies = {
        ...manifest.dependencies,
        ...manifest.peerDependencies,
        ...manifest.optionalDependencies,
      };
      return [
        manifest.name,
        new Set(
          Object.entries(runtimeDependencies)
            .filter(([name, range]) => acceptsInternalVersion(range, internalVersions.get(name)))
            .map(([name]) => name),
        ),
      ];
    }),
  );
}

function acceptsInternalVersion(range, version) {
  if (typeof range !== "string" || typeof version !== "string" || range.includes(":")) {
    return false;
  }
  try {
    return new Range(range).test(version);
  } catch {
    return false;
  }
}

function recordFailure(outputPath, release, reason) {
  writeFileSync(outputPath, `${JSON.stringify({ packageName: release.name, version: release.version, reason })}\n`, {
    flag: "a",
  });
}

function recordPublishedPackage(outputPath, release) {
  writeFileSync(outputPath, `${JSON.stringify({ packageName: release.name, version: release.version })}\n`, {
    flag: "a",
  });
}

function writeTagEvent(outputPath, release, tag) {
  writeFileSync(outputPath, `${JSON.stringify({ type: "git-tag", tag, packageName: release.name })}\n`, { flag: "a" });
}

function writeErrorAnnotation(title, message) {
  console.error(`::error title=${escapeWorkflowProperty(title)}::${escapeWorkflowData(message)}`);
}

function escapeWorkflowData(value) {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeWorkflowProperty(value) {
  return escapeWorkflowData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

function printSummary(title, entries) {
  if (entries.length === 0) return;
  console.log(`${title}:\n${entries.map((entry) => `- ${entry}`).join("\n")}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exitCode = publishPackagesSequentially();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeErrorAnnotation("Package publication failed", message);
    process.exitCode = 1;
  }
}
