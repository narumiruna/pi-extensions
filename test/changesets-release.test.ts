import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

const repositoryRoot = process.cwd();
const changesetBin = path.join(repositoryRoot, "node_modules", ".bin", "changeset");
const changesetConfig = path.join(repositoryRoot, ".changeset", "config.json");

test("Changesets bumps selected packages independently and preserves ordinary internal ranges", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "pi-changesets-"));
  try {
    writeJson(path.join(fixture, "package.json"), {
      name: "fixture-root",
      private: true,
      workspaces: ["packages/*"],
    });
    writeJson(path.join(fixture, "package-lock.json"), {
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "fixture-root",
          workspaces: ["packages/*"],
        },
      },
    });
    writeJson(path.join(fixture, "packages/pi-tui-kit/package.json"), {
      name: "@fixture/pi-tui-kit",
      version: "0.49.3",
    });
    writeJson(path.join(fixture, "packages/pi-consumer/package.json"), {
      name: "@fixture/pi-consumer",
      version: "1.2.3",
      dependencies: { "@fixture/pi-tui-kit": "^0.49.1" },
    });
    writeJson(path.join(fixture, "packages/pi-unchanged/package.json"), {
      name: "@fixture/pi-unchanged",
      version: "4.5.6",
    });
    mkdirSync(path.join(fixture, ".changeset"), { recursive: true });
    copyFileSync(changesetConfig, path.join(fixture, ".changeset/config.json"));
    writeFileSync(
      path.join(fixture, ".changeset/independent.md"),
      [
        "---",
        '"@fixture/pi-tui-kit": minor',
        '"@fixture/pi-consumer": patch',
        "---",
        "",
        "Release selected packages independently.",
        "",
      ].join("\n"),
    );

    execFileSync(changesetBin, ["version"], { cwd: fixture, stdio: "pipe" });

    const kit = readJson(path.join(fixture, "packages/pi-tui-kit/package.json"));
    const consumer = readJson(path.join(fixture, "packages/pi-consumer/package.json"));
    const unchanged = readJson(path.join(fixture, "packages/pi-unchanged/package.json"));
    assert.equal(kit.version, "0.50.0");
    assert.equal(consumer.version, "1.2.4");
    assert.deepEqual(consumer.dependencies, { "@fixture/pi-tui-kit": "^0.49.1" });
    assert.equal(unchanged.version, "4.5.6");
    assert.equal(existsSync(path.join(fixture, "packages/pi-unchanged/CHANGELOG.md")), false);
    assert.match(readFileSync(path.join(fixture, "packages/pi-tui-kit/CHANGELOG.md"), "utf8"), /## 0\.50\.0/u);
    assert.match(readFileSync(path.join(fixture, "packages/pi-consumer/CHANGELOG.md"), "utf8"), /## 1\.2\.4/u);
    assert.deepEqual(readdirSync(path.join(fixture, ".changeset")).sort(), ["config.json"]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("sequential publishing reports a failure and continues with later packages", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "pi-sequential-publish-"));
  try {
    const plan = {
      version: 1,
      plan: [
        [
          {
            kind: "publish",
            name: "@fixture/pi-alpha",
            version: "1.0.0",
            access: "public",
            tag: "latest",
          },
        ],
        [
          {
            kind: "publish",
            name: "@fixture/pi-broken",
            version: "2.0.0",
            access: "restricted",
            tag: "next",
          },
        ],
        [
          {
            kind: "publish",
            name: "@fixture/pi-dependent",
            version: "2.1.0",
            access: "public",
            tag: "latest",
          },
          {
            kind: "publish",
            name: "@fixture/pi-range-independent",
            version: "2.2.0",
            access: "public",
            tag: "latest",
          },
          {
            kind: "publish",
            name: "@fixture/pi-omega",
            version: "3.0.0",
            access: "public",
            tag: "latest",
          },
        ],
        [
          {
            kind: "publish",
            name: "@fixture/pi-transitive",
            version: "3.1.0",
            access: "public",
            tag: "latest",
          },
          {
            kind: "tag-only",
            name: "@fixture/pi-tag-only",
            version: "4.0.0",
          },
        ],
      ],
    };
    writeJson(path.join(fixture, "publish-plan.fixture.json"), plan);
    writeJson(path.join(fixture, "packages/pi-alpha/package.json"), {
      name: "@fixture/pi-alpha",
      version: "1.0.0",
    });
    writeJson(path.join(fixture, "packages/pi-broken/package.json"), {
      name: "@fixture/pi-broken",
      version: "2.0.0",
    });
    writeJson(path.join(fixture, "packages/pi-dependent/package.json"), {
      name: "@fixture/pi-dependent",
      version: "2.1.0",
      dependencies: { "@fixture/pi-broken": "^2.0.0" },
    });
    writeJson(path.join(fixture, "packages/pi-range-independent/package.json"), {
      name: "@fixture/pi-range-independent",
      version: "2.2.0",
      dependencies: { "@fixture/pi-broken": "^1.0.0" },
    });
    writeJson(path.join(fixture, "packages/pi-omega/package.json"), {
      name: "@fixture/pi-omega",
      version: "3.0.0",
      devDependencies: { "@fixture/pi-broken": "^2.0.0" },
    });
    writeJson(path.join(fixture, "packages/pi-transitive/package.json"), {
      name: "@fixture/pi-transitive",
      version: "3.1.0",
      peerDependencies: { "@fixture/pi-dependent": "^2.1.0" },
    });
    writeJson(path.join(fixture, "packages/pi-tag-only/package.json"), {
      name: "@fixture/pi-tag-only",
      version: "4.0.0",
    });

    const changesetsBin = path.join(fixture, "node_modules/@changesets/cli/bin.js");
    mkdirSync(path.dirname(changesetsBin), { recursive: true });
    writeFileSync(
      changesetsBin,
      [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const output = process.argv[process.argv.indexOf("--output") + 1];',
        'fs.copyFileSync(path.join(process.cwd(), "publish-plan.fixture.json"), output);',
      ].join("\n"),
    );

    const binDirectory = path.join(fixture, "bin");
    const npmBin = path.join(binDirectory, "npm");
    mkdirSync(binDirectory, { recursive: true });
    writeFileSync(
      npmBin,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'const workspace = process.argv[process.argv.indexOf("--workspace") + 1];',
        'fs.appendFileSync(process.env.PUBLISH_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");',
        'if (workspace === "@fixture/pi-broken") process.exit(17);',
      ].join("\n"),
      { mode: 0o755 },
    );

    const changesetsOutput = path.join(fixture, "changesets-output.ndjson");
    const failuresPath = path.join(fixture, "publish-failures.ndjson");
    const publishedPackagesPath = path.join(fixture, "published-packages.ndjson");
    const callsPath = path.join(fixture, "publish-calls.ndjson");
    const script = path.join(repositoryRoot, "scripts/publish-packages-sequentially.mjs");
    const result = spawnSync(process.execPath, [script], {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...process.env,
        CHANGESETS_OUTPUT: changesetsOutput,
        PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
        PUBLISH_CALLS: callsPath,
        PUBLISH_FAILURES_FILE: failuresPath,
        PUBLISHED_PACKAGES_FILE: publishedPackagesPath,
      },
    });

    assert.equal(result.status, 0);
    assert.match(
      result.stderr,
      /::error title=Failed to publish @fixture\/pi-broken@2\.0\.0::npm publish exited with code 17/u,
    );
    assert.match(
      result.stderr,
      /::error title=Skipped dependent release @fixture\/pi-dependent@2\.1\.0::blocked by failed release\(s\): @fixture\/pi-broken/u,
    );
    assert.match(
      result.stderr,
      /::error title=Skipped dependent release @fixture\/pi-transitive@3\.1\.0::blocked by failed release\(s\): @fixture\/pi-dependent/u,
    );
    assert.deepEqual(
      readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      [
        ["publish", "--workspace", "@fixture/pi-alpha", "--access", "public", "--tag", "latest"],
        ["publish", "--workspace", "@fixture/pi-broken", "--access", "restricted", "--tag", "next"],
        ["publish", "--workspace", "@fixture/pi-range-independent", "--access", "public", "--tag", "latest"],
        ["publish", "--workspace", "@fixture/pi-omega", "--access", "public", "--tag", "latest"],
      ],
    );
    assert.deepEqual(
      readFileSync(failuresPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      [
        {
          packageName: "@fixture/pi-broken",
          version: "2.0.0",
          reason: "npm publish exited with code 17",
        },
        {
          packageName: "@fixture/pi-dependent",
          version: "2.1.0",
          reason: "blocked by failed release(s): @fixture/pi-broken",
        },
        {
          packageName: "@fixture/pi-transitive",
          version: "3.1.0",
          reason: "blocked by failed release(s): @fixture/pi-dependent",
        },
      ],
    );
    assert.deepEqual(
      readFileSync(changesetsOutput, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      [
        {
          type: "git-tag",
          tag: "@fixture/pi-alpha@1.0.0",
          packageName: "@fixture/pi-alpha",
        },
        {
          type: "git-tag",
          tag: "@fixture/pi-range-independent@2.2.0",
          packageName: "@fixture/pi-range-independent",
        },
        {
          type: "git-tag",
          tag: "@fixture/pi-omega@3.0.0",
          packageName: "@fixture/pi-omega",
        },
        {
          type: "git-tag",
          tag: "@fixture/pi-tag-only@4.0.0",
          packageName: "@fixture/pi-tag-only",
        },
      ],
    );
    assert.deepEqual(
      readFileSync(publishedPackagesPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      [
        { packageName: "@fixture/pi-alpha", version: "1.0.0" },
        { packageName: "@fixture/pi-range-independent", version: "2.2.0" },
        { packageName: "@fixture/pi-omega", version: "3.0.0" },
      ],
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("publish workflow summarizes successes before reporting publication failures", () => {
  const workflow = readFileSync(path.join(repositoryRoot, ".github/workflows/publish.yml"), "utf8");
  const actionStep = workflow.indexOf("uses: changesets/action@");
  const summaryStep = workflow.indexOf("- name: Summarize published packages");
  const failureStep = workflow.indexOf("- name: Fail after package publication errors");

  assert.notEqual(actionStep, -1);
  assert.ok(summaryStep > actionStep);
  assert.ok(failureStep > summaryStep);
  const failuresFilePattern = /PUBLISH_FAILURES_FILE: \$\{\{ runner\.temp \}\}\/package-publish-failures\.ndjson/u;
  const publishedPackagesFilePattern = /PUBLISHED_PACKAGES_FILE: \$\{\{ runner\.temp \}\}\/published-packages\.ndjson/u;
  assert.match(workflow.slice(actionStep, summaryStep), publishedPackagesFilePattern);
  assert.match(workflow.slice(summaryStep, failureStep), publishedPackagesFilePattern);
  assert.match(workflow.slice(summaryStep, failureStep), /if: always\(\)/u);
  assert.match(workflow.slice(summaryStep, failureStep), /process\.env\.GITHUB_STEP_SUMMARY/u);
  assert.match(workflow.slice(actionStep, failureStep), failuresFilePattern);
  assert.match(workflow.slice(failureStep), failuresFilePattern);
  assert.match(workflow.slice(failureStep), /if: steps\.changesets\.outcome == 'success'/u);
  assert.match(workflow.slice(failureStep), /if \[\[ -s "\$PUBLISH_FAILURES_FILE" \]\]; then/u);
  assert.match(workflow.slice(failureStep), /exit 1/u);
});

function readJson(filePath: string): {
  version?: string;
  dependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, "\t")}\n`);
}
