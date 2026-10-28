import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";

const cliRequire = createRequire(createRequire(import.meta.url).resolve("@changesets/cli/bin.js"));
const { cac } = await import(cliRequire.resolve("cac"));
function nativeOptions(args: string[]) {
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
const integrity = (bytes: Uint8Array, algorithm = "sha256") =>
  `${algorithm}-${createHash(algorithm).update(bytes).digest("base64")}`;
type Release = {
  name: string;
  version: string;
  kind: string;
  access?: string;
  tag?: string;
  tarball?: { path: string; integrity: string };
};
type Manifest = { name: string; version: string; [key: string]: unknown };
type Result = { code: number; stdout?: string };

async function fixture(field = "dependencies", range = "^2.0.0") {
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
  const run = async (command: string, args: string[], options: { cwd: string; capture?: boolean }) => {
    assert.equal(options.cwd, cwd);
    if (command === "npm") {
      assert.deepEqual(args, ["view", "@test/core@2.0.0", "--json"]);
      assert.equal(options.capture, true);
      calls.push("view");
      return viewResult ?? { code: 0, stdout: JSON.stringify(metadata) };
    }
    assert.equal(command, process.execPath);
    assert.equal(args[1], "publish");
    assert.match(args[0], /@changesets\/cli\/bin.js$/u);
    const directory = nativeOptions(args.slice(2)).fromPackDir;
    assert.equal(typeof directory, "string");
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
    output,
    execute: (args: string[] = [], fetchOverride: unknown = fetch) =>
      publishPackedPackages(["--from-pack-dir", pack, ...args], { cwd, run, fetch: fetchOverride }),
    executeEquals: (args: string[]) => publishPackedPackages([`--from-pack-dir=${pack}`, ...args], { cwd, run, fetch }),
    metadata: (value: unknown) => {
      metadata = value;
    },
    viewResult: (value: Result) => {
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

for (const status of [200, 404]) {
  test(`production fetch verifies exact artifact over local HTTP (${status})`, async () => {
    const f = await fixture();
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(status);
      response.end(f.bytes[0]);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      f.metadata({
        name: "@test/core",
        version: "2.0.0",
        dist: {
          tarball: `http://127.0.0.1:${address.port}/core.tgz`,
          integrity: integrity(f.bytes[0], "sha512"),
        },
      });
      if (status === 200) {
        await f.execute([], globalThis.fetch);
        assert.equal(f.calls.at(-1), "@test/consumer");
      } else {
        await assert.rejects(f.execute([], globalThis.fetch), /artifact unavailable/u);
        assert.ok(!f.calls.includes("@test/consumer"));
      }
      assert.equal(requests, 1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  });
}

test("guard chunks preserve packed entries, paths, bytes, forwarded args and simulated report events", async () => {
  const f = await fixture();
  await f.execute(["--output", f.output, "--otp", "123456"]);
  assert.deepEqual(f.calls, ["@test/core", "view", "fetch", "@test/consumer"]);
  assert.deepEqual(f.nativePlans, [[f.releases[0]], [f.releases[1]]]);
  assert.deepEqual(f.nativeArgs, Array(2).fill(["--output", f.output, "--otp", "123456"]));
  assert.equal((await readFile(f.output, "utf8")).trim().split("\n").length, 2);
});

test("native tag suppression is forwarded unchanged", async () => {
  const f = await fixture();
  await f.execute(["--no-git-tag", "--"]);
  assert.deepEqual(f.nativeArgs, [
    ["--no-git-tag", "--"],
    ["--no-git-tag", "--"],
  ]);
});

for (const range of [
  "workspace:*",
  "workspace:^",
  "workspace:~",
  "workspace:^2.0.0",
  "workspace:~2.0.0",
  "workspace:2.0.0",
  "workspace:>=2.0.0 <3",
  "workspace:packages/0",
  "workspace:./packages/0",
  "workspace:packages/other/../0",
]) {
  test(`native workspace range ${range} gates current internal artifact`, async () => {
    const f = await fixture("dependencies", range);
    await f.execute();
    assert.deepEqual(f.calls, ["@test/core", "view", "fetch", "@test/consumer"]);
  });
}

test("optional dependency ranges take precedence over dependency and peer ranges", async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.cwd, "packages/1/package.json"),
    JSON.stringify({
      name: "@test/consumer",
      version: "3.0.0",
      dependencies: { "@test/core": "^2.0.0" },
      peerDependencies: { "@test/core": "^2.0.0" },
      optionalDependencies: { "@test/core": "^1.0.0" },
    }),
  );
  await f.execute();
  assert.ok(!f.calls.includes("view"));
});

test("cyclic runtime releases fail before native publication", async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.cwd, "packages/0/package.json"),
    JSON.stringify({
      name: "@test/core",
      version: "2.0.0",
      dependencies: { "@test/consumer": "^3.0.0" },
    }),
  );
  await assert.rejects(f.execute(), /Cyclic/u);
  assert.deepEqual(f.calls, []);
});

test("registry integrity uses strongest supported SRI algorithm", async () => {
  const f = await fixture();
  f.metadata({
    name: "@test/core",
    version: "2.0.0",
    dist: {
      tarball: "https://registry.example/core.tgz",
      integrity: `${integrity(Buffer.from("wrong"), "sha512")} ${integrity(f.bytes[0], "sha1")}`,
    },
  });
  await assert.rejects(f.execute(), /integrity mismatch/u);
  assert.ok(!f.calls.includes("@test/consumer"));
});

for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
  test(`${field} requires exact registry availability`, async () => {
    const f = await fixture(field);
    await f.execute();
    assert.deepEqual(f.calls, ["@test/core", "view", "fetch", "@test/consumer"]);
  });
}
for (const [field, range] of [
  ["devDependencies", "^2.0.0"],
  ["dependencies", "^1.0.0"],
  ["dependencies", "invalid-range"],
  ["dependencies", "file:../0"],
  ["dependencies", "link:../0"],
  ["dependencies", "npm:@test/core@2.0.0"],
  ["dependencies", "workspace:^1.0.0"],
  ["dependencies", "workspace:invalid-range"],
]) {
  test(`${field} ${range} does not gate unrelated versions`, async () => {
    const f = await fixture(field, range);
    await f.execute();
    assert.equal(f.nativePlans.length, 1);
    assert.ok(!f.calls.includes("view"));
  });
}

for (const mode of ["tag-only", "omitted", "retry"]) {
  test(`${mode} dependencies still require exact registry artifact`, async () => {
    const f = await fixture();
    if (mode === "tag-only") {
      f.releases[0] = { name: "@test/core", version: "2.0.0", kind: "tag-only" };
      await f.save([[f.releases[0]], [f.releases[1]]]);
    } else if (mode === "omitted") await f.save([[f.releases[1]]]);
    f.status(404);
    await assert.rejects(f.execute(), /artifact unavailable/u);
    assert.ok(f.calls.includes("view"));
    assert.ok(!f.calls.includes("@test/consumer"));
  });
}

test("tag-only and absent-plan dependencies succeed with registry SRI without a local packed artifact", async () => {
  for (const tagOnly of [false, true]) {
    const f = await fixture();
    const core: Release = { name: "@test/core", version: "2.0.0", kind: "tag-only" };
    await f.save(tagOnly ? [[core], [f.releases[1]]] : [[f.releases[1]]]);
    await f.execute();
    assert.ok(f.calls.includes("fetch"));
    assert.equal(f.calls.at(-1), "@test/consumer");
  }
});

for (const failure of [
  "empty-metadata",
  "metadata-404",
  "wrong-version",
  "wrong-name",
  "missing-dist",
  "file-url",
  "invalid-url",
  "missing-integrity",
  "artifact-404",
  "sri-mismatch",
  "local-mismatch",
]) {
  test(`blocks consumers on ${failure} and retains earlier native report events`, async () => {
    const f = await fixture();
    const dist = { tarball: "https://registry.example/core.tgz", integrity: integrity(f.bytes[0], "sha512") };
    switch (failure) {
      case "empty-metadata":
        f.viewResult({ code: 0, stdout: "" });
        break;
      case "metadata-404":
        f.viewResult({ code: 1, stdout: '{"error":{"code":"E404"}}' });
        break;
      case "wrong-version":
        f.metadata({ name: "@test/core", version: "1.0.0", dist });
        break;
      case "wrong-name":
        f.metadata({ name: "other", version: "2.0.0", dist });
        break;
      case "missing-dist":
        f.metadata({ name: "@test/core", version: "2.0.0" });
        break;
      case "file-url":
        dist.tarball = "file:///tmp/package.tgz";
        break;
      case "invalid-url":
        dist.tarball = "not a URL";
        break;
      case "missing-integrity":
        dist.integrity = "";
        break;
      case "artifact-404":
        f.status(404);
        break;
      case "sri-mismatch":
        f.fetchBytes(Buffer.from("corrupt bytes"));
        break;
      case "local-mismatch": {
        const different = Buffer.from("different but registry-consistent bytes");
        f.fetchBytes(different);
        dist.integrity = integrity(different, "sha512");
        break;
      }
    }
    if (["file-url", "invalid-url", "missing-integrity", "local-mismatch"].includes(failure))
      f.metadata({ name: "@test/core", version: "2.0.0", dist });
    await assert.rejects(f.execute(["--output", f.output]));
    assert.ok(!f.calls.includes("@test/consumer"));
    const events = (await readFile(f.output, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "git-tag");
    assert.equal(events[0].packageName, "@test/core");
  });
}

test("failed native publication stops before registry queries or consumer invocation", async () => {
  const f = await fixture();
  f.publishCode(1);
  await assert.rejects(f.execute(), /publish failed/u);
  assert.deepEqual(f.calls, ["@test/core"]);
});

for (const failure of [
  "tampered",
  "missing",
  "unsafe",
  "absolute",
  "wrong-version",
  "invalid-plan",
  "missing-plan",
  "missing-tarball",
]) {
  test(`local ${failure} fails preflight before any native invocation`, async () => {
    const f = await fixture();
    const consumer = f.releases[1];
    switch (failure) {
      case "tampered":
        await writeFile(path.join(f.pack, consumer.tarball?.path ?? ""), "tampered");
        break;
      case "missing":
        await rm(path.join(f.pack, consumer.tarball?.path ?? ""));
        break;
      case "unsafe":
        if (consumer.tarball) consumer.tarball.path = "../escape.tgz";
        await f.save();
        break;
      case "absolute":
        if (consumer.tarball) consumer.tarball.path = "/tmp/escape.tgz";
        await f.save();
        break;
      case "wrong-version":
        consumer.version = "1.0.0";
        await f.save();
        break;
      case "invalid-plan":
        await f.save(undefined, 2);
        break;
      case "missing-plan":
        await rm(path.join(f.pack, "publish-plan.json"));
        break;
      case "missing-tarball":
        delete consumer.tarball;
        await f.save();
        break;
    }
    await assert.rejects(f.execute());
    assert.deepEqual(f.calls, []);
  });
}

for (const invalid of [null, {}, { version: 1, plan: [null] }, { version: 1, plan: [[null]] }]) {
  test(`rejects malformed plan ${JSON.stringify(invalid)} before any native invocation`, async () => {
    const f = await fixture();
    await writeFile(path.join(f.pack, "publish-plan.json"), JSON.stringify(invalid));
    await assert.rejects(f.execute());
    assert.deepEqual(f.calls, []);
  });
}

test("duplicate release entries fail before native publication", async () => {
  const f = await fixture();
  await f.save([[f.releases[0]], [f.releases[0], f.releases[1]]]);
  await assert.rejects(f.execute(), /Invalid release/u);
  assert.deepEqual(f.calls, []);
});

for (const spelling of ["from-pack-dir", "fromPackDir", "from-packDir", "fromPack-dir"]) {
  for (const negated of [false, true]) {
    for (const equals of [false, true]) {
      const flag = `--${negated ? "no-" : ""}${spelling}`;
      const override = equals ? [`${flag}=replacement`] : negated ? [flag] : [flag, "replacement"];
      test(`rejects packed override ${override.join(" ")} before any native invocation`, async () => {
        const f = await fixture();
        // Use installed CAC, not a first-canonical-argument stub. Negated = forms are
        // rejected conservatively too, although MRI retains = in their key.
        if (!negated || !equals) {
          const parsed = nativeOptions(["--from-pack-dir", "guarded", ...override]);
          assert.notEqual(parsed.fromPackDir, "guarded");
          if (negated) assert.equal(parsed.fromPackDir, false);
        }
        await assert.rejects(f.execute(override), /canonical|Duplicate/u);
        assert.deepEqual(f.calls, []);
      });
    }
  }
}

test("one canonical equals argument preserves unrelated native arguments", async () => {
  const f = await fixture();
  // Exercise equals input separately from fixture.execute's canonical pair.
  await assert.rejects(
    publishPackedPackages([`--from-pack-dir=${f.pack}`, "--no-fromPackDir"], {
      cwd: f.cwd,
      run: () => assert.fail("must reject before invoking native CLI"),
    }),
    /canonical/u,
  );
  await f.executeEquals(["--output", f.output, "--otp=123456", "--no-git-tag", "--", "positional"]);
  assert.deepEqual(
    f.nativeArgs,
    Array(2).fill(["--output", f.output, "--otp=123456", "--no-git-tag", "--", "positional"]),
  );
});

for (const range of ["workspace:.", "workspace:*", "^1.0.0"]) {
  test(`root workspace reference ${range} fails closed before publication`, async () => {
    const f = await fixture();
    await writeFile(
      path.join(f.cwd, "package.json"),
      JSON.stringify({ name: "test-root", version: "1.0.0", private: true, workspaces: ["packages/*"] }),
    );
    await writeFile(
      path.join(f.cwd, "packages/1/package.json"),
      JSON.stringify({ name: "@test/consumer", version: "3.0.0", dependencies: { "test-root": range } }),
    );
    await assert.rejects(f.execute(), /root runtime dependency/u);
    assert.deepEqual(f.calls, []);
  });
}

test("runtime graph policy matches the current root config", async () => {
  const config = JSON.parse(await readFile(new URL("../.changeset/config.json", import.meta.url), "utf8"));
  assert.equal(config.bumpVersionsWithWorkspaceProtocolOnly, false);
});

test("registry parse and fetch errors do not expose metadata or URLs", async () => {
  for (const failure of ["json", "fetch", "body"]) {
    const f = await fixture();
    const secret = "https://user:secret@registry.example/private-token";
    if (failure === "json") f.viewResult({ code: 0, stdout: `invalid ${secret}` });
    await assert.rejects(
      f.execute([], async () => {
        if (failure === "body")
          return {
            ok: true,
            arrayBuffer: async () => {
              throw new Error(secret);
            },
          };
        throw new Error(secret);
      }),
      (error: Error) => !error.message.includes(secret) && /registry|Registry/u.test(error.message),
    );
  }
});

test("packed mode is mandatory and duplicate pack paths are rejected", async () => {
  for (const args of [[], ["--from-pack-dir"], ["--from-pack-dir=a", "--from-pack-dir=b"]]) {
    await assert.rejects(publishPackedPackages(args));
  }
});
