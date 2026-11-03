import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

const cliRequire = createRequire(createRequire(import.meta.url).resolve("@changesets/cli/bin.js"));
const { cac } = await import(cliRequire.resolve("cac"));
export function nativeOptions(args: string[]) {
  const parser = cac("changeset");
  parser.command("publish").option("--from-pack-dir <dir>", "Packed directory");
  return parser.parse([process.execPath, "changeset", "publish", ...args], { run: false }).options;
}

const script = "../scripts/publish-packed-packages.mjs";
const { publishPackedPackages } = await import(script);
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
export const integrity = (bytes: Uint8Array, algorithm = "sha256") =>
  `${algorithm}-${createHash(algorithm).update(bytes).digest("base64")}`;
export type Release = {
  name: string;
  version: string;
  kind: string;
  access?: string;
  tag?: string;
  tarball?: { path: string; integrity: string };
};
type Manifest = { name: string; version: string; [key: string]: unknown };
type Result = { code: number; stdout?: string; stderr?: string };

export async function fixture(field = "dependencies", range = "^2.0.0") {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "packed-publish-test-"));
  temporary.push(cwd);
  await writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "test-root", private: true, workspaces: ["packages/*"] }),
  );
  await writeFile(path.join(cwd, "package-lock.json"), "{}");
  const manifests: Manifest[] = [
    { name: "@test/core", version: "2.0.0" },
    { name: "@test/consumer", version: "3.0.0", [field]: { "@test/core": range } },
  ];
  const bytes = [Buffer.from("exact core packed bytes"), Buffer.from("exact consumer packed bytes")];
  const releases: Release[] = [];
  for (const [index, manifest] of manifests.entries()) {
    const dir = path.join(cwd, "packages", String(index));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify(manifest));
    releases.push({
      name: manifest.name,
      version: manifest.version,
      kind: "publish",
      access: "public",
      tag: "latest",
      tarball: { path: `packages/original-${index}.tgz`, integrity: integrity(bytes[index]) },
    });
  }
  const pack = path.join(cwd, "packed");
  await mkdir(path.join(pack, "packages"), { recursive: true });
  for (const [index, release] of releases.entries())
    await writeFile(path.join(pack, release.tarball?.path ?? ""), bytes[index]);
  const save = async (plan: Release[][] = [[releases[1], releases[0]]], version = 1) =>
    writeFile(path.join(pack, "publish-plan.json"), JSON.stringify({ version, plan }));
  await save();
  const calls: string[] = [];
  const nativePlans: Release[][] = [];
  const nativeArgs: string[][] = [];
  const nativeDirectories: string[] = [];
  const waits: number[] = [];
  const logs: string[] = [];
  let clock = 0;
  let onWait: () => unknown = () => {};
  let onView: (signal: AbortSignal) => unknown = () => {};
  const wait = async (ms: number, _value?: unknown, options?: { signal: AbortSignal }) => {
    options?.signal.throwIfAborted();
    waits.push(ms);
    clock += ms;
    await onWait();
    options?.signal.throwIfAborted();
  };
  const now = () => clock;
  const log = (message: string) => logs.push(message);
  let metadata: unknown = {
    name: "@test/core",
    version: "2.0.0",
    dist: { tarball: "https://registry.example/core.tgz", integrity: integrity(bytes[0], "sha512") },
  };
  let viewResult: Result | undefined;
  let publishCode = 0;
  let fetchBytes = bytes[0];
  let status = 200;
  const output = path.join(cwd, "report.ndjson");
  const run = async (
    command: string,
    args: string[],
    options: { cwd: string; capture?: boolean; signal?: AbortSignal },
  ) => {
    assert.equal(options.cwd, cwd);
    if (command === "npm") {
      assert.deepEqual(args, ["view", "@test/core@2.0.0", "--json"]);
      assert.equal(options.capture, true);
      calls.push("view");
      assert.ok(options.signal instanceof AbortSignal);
      await onView(options.signal);
      return viewResult ?? { code: 0, stdout: JSON.stringify(metadata) };
    }
    assert.equal(command, process.execPath);
    assert.equal(options.signal, undefined);
    assert.equal(args[1], "publish");
    assert.match(args[0], /@changesets\/cli\/bin.js$/u);
    const directory = nativeOptions(args.slice(2)).fromPackDir;
    assert.equal(typeof directory, "string");
    nativeDirectories.push(directory);
    const document = JSON.parse(await readFile(path.join(directory, "publish-plan.json"), "utf8"));
    assert.equal(document.version, 1);
    assert.equal(document.plan.length, 1);
    const chunk: Release[] = document.plan[0];
    nativePlans.push(chunk);
    nativeArgs.push(args.slice(4));
    for (const release of chunk) {
      calls.push(release.name);
      if (release.tarball) {
        const original = releases.findIndex((entry) => entry.name === release.name);
        assert.deepEqual(await readFile(path.join(directory, release.tarball.path)), bytes[original]);
        assert.deepEqual(release, releases[original]);
      }
      if (args.includes("--output") && publishCode === 0)
        await appendFile(
          output,
          `${JSON.stringify({ type: "git-tag", packageName: release.name, tag: `${release.name}@${release.version}` })}\n`,
        );
    }
    return { code: publishCode };
  };
  const fetch = async (url: URL, options: RequestInit) => {
    calls.push("fetch");
    assert.equal(url.href, "https://registry.example/core.tgz");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(fetchBytes, { status });
  };
  return {
    cwd,
    pack,
    bytes,
    releases,
    save,
    calls,
    nativePlans,
    nativeArgs,
    nativeDirectories,
    waits,
    logs,
    output,
    run,
    fetch,
    now,
    advance: (ms: number) => {
      clock += ms;
    },
    onView: (value: typeof onView) => {
      onView = value;
    },
    execute: (args: string[] = [], fetchOverride: unknown = fetch, overrides: Record<string, unknown> = {}) =>
      publishPackedPackages(["--from-pack-dir", pack, ...args], {
        cwd,
        run,
        fetch: fetchOverride,
        wait,
        log,
        now,
        ...overrides,
      }),
    executeEquals: (args: string[]) =>
      publishPackedPackages([`--from-pack-dir=${pack}`, ...args], { cwd, run, fetch, wait, log, now }),
    onWait: (value: () => unknown) => {
      onWait = value;
    },
    metadata: (value: unknown) => {
      metadata = value;
    },
    viewResult: (value: Result | undefined) => {
      viewResult = value;
    },
    publishCode: (value: number) => {
      publishCode = value;
    },
    fetchBytes: (value: typeof fetchBytes) => {
      fetchBytes = value;
    },
    status: (value: number) => {
      status = value;
    },
  };
}
