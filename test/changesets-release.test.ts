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

const kitName = "@narumitw/pi-tui-kit";
const consumerName = "@fixture/pi-consumer";
const compatibleName = "@fixture/pi-compatible";
const unrelatedName = "@fixture/pi-unrelated";

for (const scenario of [
  { title: "minor automatically patches an out-of-range consumer", bump: "minor", selected: false, kit: "0.50.0" },
  {
    title: "compatible patch raises an explicitly selected consumer floor",
    bump: "patch",
    selected: true,
    kit: "0.49.4",
  },
  { title: "compatible patch leaves unselected consumers unchanged", bump: "patch", selected: false, kit: "0.49.4" },
]) {
  test(`Changesets Kit ${scenario.title} and produces dependency-ordered publish chunks`, () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "pi-changesets-"));
    try {
      const config = JSON.parse(readFileSync(changesetConfig, "utf8"));
      assert.equal(config.bumpVersionsWithWorkspaceProtocolOnly, false);
      assert.equal(config.updateInternalDependencies, "patch");
      assert.deepEqual(config.fixed, []);
      assert.deepEqual(config.linked, []);
      assert.equal(config.___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH, undefined);
      writeJson(path.join(fixture, "package.json"), {
        name: "fixture-root",
        private: true,
        workspaces: ["packages/*"],
      });
      writeJson(path.join(fixture, "package-lock.json"), {
        lockfileVersion: 3,
        packages: { "": { name: "fixture-root", workspaces: ["packages/*"] } },
      });
      const compatibleRange = scenario.bump === "minor" ? "^0.49.1 || ^0.50.0" : "^0.49.1";
      const manifests = [
        { name: kitName, version: "0.49.3" },
        { name: consumerName, version: "1.2.3", dependencies: { [kitName]: "^0.49.1" } },
        { name: compatibleName, version: "2.3.4", dependencies: { [kitName]: compatibleRange } },
        { name: unrelatedName, version: "4.5.6" },
      ];
      for (const manifest of manifests) {
        writeJson(path.join(fixture, "packages", path.basename(manifest.name), "package.json"), manifest);
      }
      const compatiblePath = path.join(fixture, "packages/pi-compatible/package.json");
      const compatibleBefore = readFileSync(compatiblePath, "utf8");
      mkdirSync(path.join(fixture, ".changeset"));
      copyFileSync(changesetConfig, path.join(fixture, ".changeset/config.json"));
      writeFileSync(
        path.join(fixture, ".changeset/independent.md"),
        [
          "---",
          `"${kitName}": ${scenario.bump}`,
          ...(scenario.selected ? [`"${consumerName}": patch`] : []),
          `"${unrelatedName}": minor`,
          "---",
          "",
          "Release selected packages independently.",
          "",
        ].join("\n"),
      );
      execFileSync(process.execPath, [changesetBin, "version"], { cwd: fixture, stdio: "pipe" });

      const consumerReleased = scenario.bump === "minor" || scenario.selected;
      const consumerVersion = consumerReleased ? "1.2.4" : "1.2.3";
      assert.equal(readJson(path.join(fixture, "packages/pi-tui-kit/package.json")).version, scenario.kit);
      assert.deepEqual(readJson(path.join(fixture, "packages/pi-consumer/package.json")), {
        name: consumerName,
        version: consumerVersion,
        dependencies: { [kitName]: consumerReleased ? `^${scenario.kit}` : "^0.49.1" },
      });
      assert.equal(readFileSync(compatiblePath, "utf8"), compatibleBefore);
      assert.equal(existsSync(path.join(fixture, "packages/pi-compatible/CHANGELOG.md")), false);
      assert.equal(readJson(path.join(fixture, "packages/pi-unrelated/package.json")).version, "4.6.0");
      for (const [name, version] of [
        [kitName, scenario.kit],
        [unrelatedName, "4.6.0"],
        ...(consumerReleased ? [[consumerName, consumerVersion]] : []),
      ]) {
        const changelog = readFileSync(path.join(fixture, "packages", path.basename(name), "CHANGELOG.md"), "utf8");
        assert.ok(changelog.includes(`## ${version}\n`), changelog);
      }
      assert.equal(existsSync(path.join(fixture, "packages/pi-consumer/CHANGELOG.md")), consumerReleased);
      assert.deepEqual(readdirSync(path.join(fixture, ".changeset")).sort(), ["config.json"]);

      // This shim has no fallback: every command other than the exact info request fails closed.
      // The CLI publish-plan path is real; npm publication and Git tags are never invoked.
      const binDirectory = path.join(fixture, "bin");
      mkdirSync(binDirectory);
      const callsPath = path.join(fixture, "npm-calls.ndjson");
      const publishedVersions = Object.fromEntries(manifests.map(({ name, version }) => [name, version]));
      writeFileSync(
        path.join(binDirectory, "npm"),
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          "const args = process.argv.slice(2);",
          'fs.appendFileSync(process.env.NPM_CALLS, JSON.stringify(args) + "\\n");',
          `const versions = ${JSON.stringify(publishedVersions)};`,
          'if (args.length !== 3 || args[0] !== "info" || args[2] !== "--json" || !Object.hasOwn(versions, args[1])) process.exit(97);',
          'console.log(JSON.stringify({ versions: [versions[args[1]]], "dist-tags": { latest: versions[args[1]] } }));',
        ].join("\n"),
        { mode: 0o755 },
      );
      execFileSync(process.execPath, [changesetBin, "publish-plan", "--output", "publish-plan.json"], {
        cwd: fixture,
        stdio: "pipe",
        env: {
          ...process.env,
          PATH: [binDirectory, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
          NPM_CALLS: callsPath,
          npm_config_registry: "http://127.0.0.1:1",
        },
      });
      const plan = JSON.parse(readFileSync(path.join(fixture, "publish-plan.json"), "utf8"));
      assert.equal(plan.version, 1);
      const release = (name: string, version: string) => ({
        kind: "publish",
        name,
        version,
        access: "public",
        tag: "latest",
      });
      assert.deepEqual(
        plan.plan[0].sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)),
        [release(kitName, scenario.kit), release(unrelatedName, "4.6.0")].sort((a, b) => a.name.localeCompare(b.name)),
      );
      assert.deepEqual(plan.plan.slice(1), consumerReleased ? [[release(consumerName, consumerVersion)]] : []);
      const calls = readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        calls.sort((a, b) => a[1].localeCompare(b[1])),
        manifests.map(({ name }) => ["info", name, "--json"]).sort((a, b) => a[1].localeCompare(b[1])),
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}

for (const { label, packageNames, minorConsumers } of [
  { label: "fullscreen handoff", packageNames: ["pi-tui-kit", "pi-starship", "pi-btw"], minorConsumers: [] },
  {
    label: "editor status presentation",
    packageNames: ["pi-tui-kit", "pi-progress", "pi-subagents", "pi-herdr"],
    minorConsumers: ["@narumitw/pi-progress", "@narumitw/pi-subagents"],
  },
]) {
  test(`${label} release propagates the Kit API floor to its real consumers`, () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "pi-kit-api-release-"));
    try {
      const manifests = packageNames.map((name) =>
        JSON.parse(readFileSync(path.join(repositoryRoot, "packages", name, "package.json"), "utf8")),
      );
      const [kit, ...consumers] = manifests;
      const [major, minor] = kit.version.split(".").map(Number);
      assert.equal(major, 0, "Revisit the caret-floor fixture when Kit reaches a stable major");
      const apiVersion = `${major}.${minor + 1}.0`;
      writeJson(path.join(fixture, "package.json"), {
        name: "kit-api-release-fixture",
        private: true,
        workspaces: ["packages/*"],
      });
      writeJson(path.join(fixture, "package-lock.json"), {
        lockfileVersion: 3,
        packages: { "": { name: "kit-api-release-fixture", workspaces: ["packages/*"] } },
      });
      mkdirSync(path.join(fixture, ".changeset"));
      copyFileSync(changesetConfig, path.join(fixture, ".changeset/config.json"));
      for (const manifest of manifests) {
        writeJson(path.join(fixture, "packages", path.basename(manifest.name), "package.json"), {
          name: manifest.name,
          version: manifest.version,
          ...(manifest.name === kitName ? {} : { dependencies: { [kitName]: manifest.dependencies[kitName] } }),
        });
      }
      writeFileSync(
        path.join(fixture, ".changeset/kit-api.md"),
        [
          "---",
          `"${kit.name}": minor`,
          ...consumers.map(
            (consumer) => `"${consumer.name}": ${minorConsumers.includes(consumer.name) ? "minor" : "patch"}`,
          ),
          "---",
          "",
          `Release ${label} without moving consumer input or domain state.`,
          "",
        ].join("\n"),
      );
      // Versioning is local only: no install, registry access, publication, or Git tags.
      execFileSync(process.execPath, [changesetBin, "version"], { cwd: fixture, stdio: "pipe" });
      assert.equal(readJson(path.join(fixture, "packages/pi-tui-kit/package.json")).version, apiVersion);
      for (const consumer of consumers) {
        const released = readJson(path.join(fixture, "packages", path.basename(consumer.name), "package.json"));
        const [consumerMajor, consumerMinor, consumerPatch] = consumer.version.split(".").map(Number);
        assert.equal(
          released.version,
          minorConsumers.includes(consumer.name)
            ? `${consumerMajor}.${consumerMinor + 1}.0`
            : `${consumerMajor}.${consumerMinor}.${consumerPatch + 1}`,
        );
        assert.equal(released.dependencies?.[kitName], `^${apiVersion}`);
        assert.notEqual(released.dependencies?.[kitName], consumer.dependencies[kitName]);
      }
      assert.deepEqual(readdirSync(path.join(fixture, ".changeset")).sort(), ["config.json"]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}

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
