import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inc, satisfies } from "semver";
import { test } from "vitest";

const cli = createRequire(import.meta.url).resolve("@changesets/cli/bin.js");
const guard = pathToFileURL(path.resolve(".github/scripts/publish-packed-packages.mjs")).href;
const { publishPackedPackages } = await import(guard);

type Manifest = {
  name: string;
  version: string;
  bin?: Record<string, string>;
  pi?: unknown;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
type Release = { name: string; version: string; kind: string; access: string; tag: string };
type PublishPlan = { version: number; plan: Release[][] };

function read<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8"));
}

function manifestPath(root: string, name: string) {
  return path.join(root, "packages", path.basename(name), "package.json");
}

const manifest = (root: string, name: string) => read<Manifest>(manifestPath(root, name));
const sync = manifest(process.cwd(), "@narumitw/pi-sync");
const daemon = manifest(process.cwd(), "@narumitw/pi-sync-daemon");
const kit = manifest(process.cwd(), "@narumitw/pi-tui-kit");
const sdk = "@earendil-works/pi-coding-agent";
const sdkAlias = "@narumitw/sync-node-sdk";
const release = (name: string, version: string | null): Release => {
  assert.ok(version);
  return { kind: "publish", name, version, access: "public", tag: "latest" };
};

async function fixture(bumps: Record<string, "patch" | "major">, run: (root: string) => void | Promise<void>) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-sync-release-"));
  const save = (relativePath: string, content: string, mode?: number) => {
    const file = path.join(root, relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, { mode });
  };
  const saveJson = (relativePath: string, value: unknown) => save(relativePath, JSON.stringify(value));
  const published = Object.fromEntries([daemon, kit, sync].map(({ name, version }) => [name, version]));
  try {
    saveJson("package.json", { name: "sync-release-fixture", private: true, workspaces: ["packages/*"] });
    saveJson("package-lock.json", { lockfileVersion: 3, packages: {} });
    for (const pkg of [daemon, kit, sync]) saveJson(path.relative(root, manifestPath(root, pkg.name)), pkg);
    save(".changeset/config.json", readFileSync(".changeset/config.json", "utf8"));
    save(
      ".changeset/fixture.md",
      [
        "---",
        ...Object.entries(bumps).map(([name, bump]) => `"${name}": ${bump}`),
        "---",
        "",
        "Release the selected packages.",
        "",
      ].join("\n"),
    );
    // No real npm or Git can run. Allow only the installed CLI's version and plan lookups.
    save(
      "bin/npm",
      `#!${process.execPath}
const [command, name, flag, ...rest] = process.argv.slice(2);
const versions = ${JSON.stringify(published)};
if (command !== "info" || flag !== "--json" || rest.length || !Object.hasOwn(versions, name)) process.exit(97);
const version = versions[name];
console.log(JSON.stringify({ versions: [version], "dist-tags": { latest: version } }));
`,
      0o755,
    );
    save(
      "bin/git",
      `#!${process.execPath}
const log = ["log", "--diff-filter=AC", "--follow", "--max-count=1", "--pretty=format:%H:%p", ".changeset/fixture.md"];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(log)) process.exit(97);
`,
      0o755,
    );
    const changesets = (...args: string[]) =>
      execFileSync(process.execPath, [cli, ...args], {
        cwd: root,
        stdio: "pipe",
        env: { PATH: path.join(root, "bin"), HOME: root, CI: "true", npm_config_registry: "http://127.0.0.1:1" },
      });
    changesets("version");
    changesets("publish-plan", "--output", "publish-plan.json");
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const plan = (root: string) => read<PublishPlan>(path.join(root, "publish-plan.json"));
const integrity = (body: string, algorithm: string) =>
  `${algorithm}-${createHash(algorithm).update(body).digest("base64")}`;

test("Sync has a local daemon build input but no standalone daemon runtime dependency or bin", () => {
  assert.equal(daemon.name, "@narumitw/pi-sync-daemon");
  assert.equal(daemon.pi, undefined);
  assert.deepEqual(daemon.bin, { "pi-sync-daemon": "./dist/cli.js" });
  assert.equal(sync.bin, undefined);
  assert.ok(satisfies(daemon.version, sync.devDependencies[daemon.name]));
  assert.ok(satisfies(kit.version, sync.dependencies[kit.name]));
  assert.equal(sync.dependencies[sdkAlias], `npm:${sdk}@${daemon.dependencies[sdk]}`);
  for (const field of [sync.dependencies, sync.optionalDependencies, sync.peerDependencies]) {
    for (const name of [daemon.name, "sync-daemon", "@narumitw/sync-daemon", "pi-sync-daemon"]) {
      assert.equal(field?.[name], undefined);
    }
  }
});

for (const bump of ["patch", "major"] as const) {
  test(`a daemon-only ${bump} publishes independently without bumping Sync`, async () => {
    await fixture({ [daemon.name]: bump }, (root) => {
      const daemonVersion = inc(daemon.version, bump);
      const versionedDaemon = manifest(root, daemon.name);
      const versionedSync = manifest(root, sync.name);
      assert.equal(versionedDaemon.version, daemonVersion);
      assert.deepEqual(versionedDaemon.bin, daemon.bin);
      assert.equal(versionedSync.version, sync.version);
      // An out-of-range daemon bump can update the local build input without releasing an embedded copy.
      assert.equal(
        versionedSync.devDependencies[daemon.name],
        bump === "major" ? `^${daemonVersion}` : sync.devDependencies[daemon.name],
      );
      assert.deepEqual(versionedSync.dependencies, sync.dependencies);
      assert.deepEqual(plan(root), { version: 1, plan: [[release(daemon.name, daemonVersion)]] });
    });
  });
}

test("an explicit Sync adoption Changeset releases Sync without releasing the daemon", async () => {
  await fixture({ [sync.name]: "patch" }, (root) => {
    const nextSync = inc(sync.version, "patch");
    assert.equal(manifest(root, sync.name).version, nextSync);
    assert.deepEqual(manifest(root, daemon.name), daemon);
    assert.deepEqual(plan(root), { version: 1, plan: [[release(sync.name, nextSync)]] });
  });
});

test("a coordinated release verifies Kit before Sync without waiting for the daemon registry", async () => {
  await fixture({ [daemon.name]: "major", [kit.name]: "patch", [sync.name]: "patch" }, async (root) => {
    const daemonRelease = release(daemon.name, inc(daemon.version, "major"));
    const kitRelease = release(kit.name, inc(kit.version, "patch"));
    const syncRelease = release(sync.name, inc(sync.version, "patch"));
    const versionedSync = manifest(root, sync.name);
    assert.equal(versionedSync.devDependencies[daemon.name], `^${daemonRelease.version}`);
    assert.deepEqual(versionedSync.dependencies, { ...sync.dependencies, [kit.name]: `^${kitRelease.version}` });
    const publishPlan = plan(root);
    const byName = (a: Release, b: Release) => a.name.localeCompare(b.name);
    assert.deepEqual(
      publishPlan.plan.map((chunk) => chunk.toSorted(byName)),
      [[daemonRelease, kitRelease].toSorted(byName), [syncRelease]],
    );

    // Stub packed bytes are enough to exercise guard ordering and artifact verification.
    const pack = path.join(root, "packed");
    mkdirSync(pack);
    const packed = publishPlan.plan.map((chunk) =>
      chunk.map((entry) => {
        const file = `${path.basename(entry.name)}.tgz`;
        writeFileSync(path.join(pack, file), entry.name);
        return { ...entry, tarball: { path: file, integrity: integrity(entry.name, "sha256") } };
      }),
    );
    writeFileSync(path.join(pack, "publish-plan.json"), JSON.stringify({ ...publishPlan, plan: packed }));

    const tarball = "https://registry.invalid/kit.tgz";
    const verify = (body: string) => {
      const calls: string[] = [];
      const execute = publishPackedPackages(["--from-pack-dir", pack], {
        cwd: root,
        // All subprocesses and downloads are replaced; unexpected requests fail closed.
        run: async (command: string, args: string[]) => {
          if (command === "npm") {
            assert.deepEqual(args, ["view", `${kit.name}@${kitRelease.version}`, "--json"]);
            calls.push("view Kit");
            return {
              code: 0,
              stdout: JSON.stringify({ ...kitRelease, dist: { tarball, integrity: integrity(body, "sha512") } }),
            };
          }
          assert.equal(command, process.execPath);
          assert.deepEqual(args.slice(0, 3), [cli, "publish", "--from-pack-dir"]);
          assert.equal(args.length, 4);
          const { plan: chunks } = plan(args[3]);
          assert.equal(chunks.length, 1);
          const names = chunks[0].map(({ name }) => name).sort();
          calls.push(names.join(", "));
          return { code: 0 };
        },
        fetch: async (url: URL) => {
          assert.equal(url.href, tarball);
          calls.push("download Kit");
          return new Response(body);
        },
        wait: () => assert.fail("Unexpected registry retry"),
      });
      return { calls, execute };
    };
    const verified = verify(kit.name);
    await verified.execute;
    const beforeSync = [[daemon.name, kit.name].sort().join(", "), "view Kit", "download Kit"];
    assert.deepEqual(verified.calls, [...beforeSync, sync.name]);
    const mismatch = verify("not the packed Kit tarball");
    await assert.rejects(mismatch.execute, /Registry artifact differs from packed artifact: @narumitw\/pi-tui-kit@/u);
    assert.deepEqual(mismatch.calls, beforeSync);
  });
});
