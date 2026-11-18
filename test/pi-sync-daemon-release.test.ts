import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inc } from "semver";
import { test } from "vitest";

const repositoryRoot = process.cwd();
const cli = path.join(repositoryRoot, "node_modules/.bin/changeset");
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));

test("scoped daemon versioning updates Pi Sync's floor and plans a public dependency-first release", () => {
  const daemon = read(path.join(repositoryRoot, "packages/pi-sync-daemon/package.json"));
  const client = read(path.join(repositoryRoot, "packages/pi-sync/package.json"));
  assert.equal(daemon.name, "@narumitw/pi-sync-daemon");
  assert.equal(daemon.pi, undefined);
  assert.deepEqual(daemon.bin, { "pi-sync-daemon": "./dist/cli.js" });
  assert.ok(client.dependencies[daemon.name]);
  for (const oldName of ["sync-daemon", "@narumitw/sync-daemon", "pi-sync-daemon"]) {
    assert.equal(Object.hasOwn(client.dependencies, oldName), false);
  }
  const root = mkdtempSync(path.join(os.tmpdir(), "scoped-daemon-release-"));
  const save = (file: string, value: unknown) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), JSON.stringify(value));
  };
  try {
    save("package.json", { name: "scoped-release-fixture", private: true, workspaces: ["packages/*"] });
    save("package-lock.json", { lockfileVersion: 3, packages: {} });
    save("packages/pi-sync-daemon/package.json", { name: daemon.name, version: daemon.version, bin: daemon.bin });
    save("packages/pi-sync/package.json", {
      name: client.name,
      version: client.version,
      dependencies: { [daemon.name]: client.dependencies[daemon.name] },
    });
    mkdirSync(path.join(root, ".changeset"));
    copyFileSync(path.join(repositoryRoot, ".changeset/config.json"), path.join(root, ".changeset/config.json"));
    // Versioning consumes pending Changesets, so keep the release input local to this fixture.
    writeFileSync(
      path.join(root, ".changeset/scoped-daemon.md"),
      `---\n"${daemon.name}": minor\n"${client.name}": patch\n---\n\nRelease the scoped daemon and Pi Sync.\n`,
    );
    execFileSync(process.execPath, [cli, "version"], { cwd: root, stdio: "pipe" });
    const versionedDaemon = read(path.join(root, "packages/pi-sync-daemon/package.json"));
    const versionedClient = read(path.join(root, "packages/pi-sync/package.json"));
    assert.equal(versionedDaemon.version, inc(daemon.version, "minor"));
    assert.equal(versionedClient.version, inc(client.version, "patch"));
    assert.deepEqual(versionedDaemon.bin, daemon.bin);
    assert.deepEqual(versionedClient.dependencies, { [daemon.name]: `^${versionedDaemon.version}` });

    // Every registry query is handled by this shim; it cannot publish or fall back to npm.
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "npm"),
      `#!${process.execPath}
const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== "info" || args[2] !== "--json") process.exit(97);
if (args[1] === process.env.FIXTURE_NEW_PACKAGE) {
  console.log(JSON.stringify({ error: { code: "E404" } }));
  process.exitCode = 1;
} else if (args[1] === process.env.FIXTURE_CLIENT_PACKAGE) {
  const version = process.env.FIXTURE_CLIENT_VERSION;
  console.log(JSON.stringify({ versions: [version], "dist-tags": { latest: version } }));
} else process.exit(97);
`,
      { mode: 0o755 },
    );
    execFileSync(process.execPath, [cli, "publish-plan", "--output", "publish-plan.json"], {
      cwd: root,
      stdio: "pipe",
      env: {
        ...process.env,
        PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
        FIXTURE_NEW_PACKAGE: daemon.name,
        FIXTURE_CLIENT_PACKAGE: client.name,
        FIXTURE_CLIENT_VERSION: client.version,
        npm_config_registry: "http://127.0.0.1:1",
      },
    });
    const { plan } = read(path.join(root, "publish-plan.json"));
    assert.deepEqual(
      plan.map((chunk: Array<{ name: string; access: string }>) => chunk.map(({ name, access }) => ({ name, access }))),
      [[{ name: daemon.name, access: "public" }], [{ name: client.name, access: "public" }]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
