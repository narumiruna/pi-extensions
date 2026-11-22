import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";

const guard = new URL("../.github/scripts/publish-packed-packages.mjs", import.meta.url).href;
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const integrity = (bytes: Uint8Array, algorithm = "sha256") =>
  `${algorithm}-${createHash(algorithm).update(bytes).digest("base64")}`;
type Call = { tool: string; args: string[]; name?: string; result?: string; integrity?: string; staging?: string };
type Release = {
  name: string;
  version: string;
  kind: string;
  access: string;
  tag: string;
  tarball: { path: string; integrity: string };
};

async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "packed-native-"));
  temporary.push(cwd);
  const bin = path.join(cwd, "bin");
  const pack = path.join(cwd, "packed");
  await Promise.all([bin, pack, path.join(cwd, ".changeset")].map((dir) => mkdir(dir)));
  await writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "fixture", private: true, workspaces: ["packages/*"] }),
  );
  await writeFile(path.join(cwd, "package-lock.json"), "{}");
  await writeFile(
    path.join(cwd, ".changeset/config.json"),
    JSON.stringify({ bumpVersionsWithWorkspaceProtocolOnly: false }),
  );
  const names = ["@test/core", "@test/consumer", "@test/independent"];
  const bytes = names.map((name) => Buffer.from(`native ${name} exact packed bytes`));
  const releases: Release[] = [];
  for (const [index, name] of names.entries()) {
    const dir = path.join(cwd, "packages", String(index));
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        name,
        version: "2.0.0",
        ...(index === 1 ? { dependencies: { "@test/core": "workspace:./packages/0" } } : {}),
      }),
    );
    const tarball = { path: `${index}.tgz`, integrity: integrity(bytes[index]) };
    await writeFile(path.join(pack, tarball.path), bytes[index]);
    releases.push({ name, version: "2.0.0", kind: "publish", access: "public", tag: "latest", tarball });
  }
  const planFile = path.join(pack, "publish-plan.json");
  const save = (mode = "full") => {
    const [core, consumer, independent] = releases;
    const plan = {
      full: [[consumer, core]],
      omitted: [[consumer]],
      "tag-only": [[{ name: core.name, version: core.version, kind: "tag-only" }], [consumer]],
      "with-independent": [[consumer, independent, core]],
      "core-only": [[core]],
    }[mode];
    assert.ok(plan);
    return writeFile(planFile, JSON.stringify({ version: 1, plan }));
  };
  await save();
  let available = false;
  let unavailableRequests = Number.POSITIVE_INFINITY;
  const requests: string[] = [];
  let registryPid: number | undefined;
  const metadataReady = Promise.withResolvers<{ pid: number; closed: Promise<void> }>();
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/metadata-ready?")) {
      registryPid = Number(new URL(request.url, "http://localhost").searchParams.get("pid"));
      metadataReady.resolve({
        pid: registryPid,
        closed: new Promise<void>((resolve) => response.once("close", resolve)),
      });
      return;
    }
    requests.push(request.url ?? "");
    if (requests.length > unavailableRequests) available = true;
    response.writeHead(available && request.url === "/core.tgz" ? 200 : 404);
    response.end(available ? bytes[0] : "not yet available");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const metadata = {
    name: "@test/core",
    version: "2.0.0",
    dist: { tarball: `http://127.0.0.1:${address.port}/core.tgz`, integrity: integrity(bytes[0], "sha512") },
  };
  // Absolute Node shebang and an isolated PATH: neither executable can invoke or
  // fall back to real npm/git. Every unrecognized invocation is recorded and fails.
  const shim = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = ${JSON.stringify(cwd)};
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const log = (entry) => fs.appendFileSync(path.join(root, 'calls.ndjson'), JSON.stringify({ tool, args, ...entry }) + '\\n');
const names = ${JSON.stringify(names)};
const tags = names.map(name => name + '@2.0.0');
try {
  if (tool === 'npm' && args[0] === 'view') {
    assert.deepEqual(args, ['view', '@test/core@2.0.0', '--json']);
    assert.equal(process.cwd(), root);
    const pendingPath = path.join(root, 'metadata-pending');
    const pending = fs.existsSync(pendingPath) ? Number(fs.readFileSync(pendingPath, 'utf8')) : 0;
    if (fs.existsSync(path.join(root, 'metadata-stall'))) {
      process.on('SIGTERM', () => log({ result: 'metadata-term' }));
      require('node:http').get(${JSON.stringify(new URL("/metadata-ready", metadata.dist.tarball).href)} + '?pid=' + process.pid).on('error', () => {});
    } else if (pending > 0) {
      fs.writeFileSync(pendingPath, String(pending - 1));
      log({ result: 'metadata-pending' });
      console.log(JSON.stringify({ error: { code: 'E404' } }));
      process.exitCode = 1;
    } else {
      log({ result: 'metadata' });
      console.log(JSON.stringify(${JSON.stringify(metadata)}));
    }
  } else if (tool === 'npm' && args[0] === 'publish') {
    const index = names.findIndex((_, index) => String(index) === path.basename(process.cwd()));
    assert.notEqual(index, -1);
    assert.equal(process.cwd(), path.join(root, 'packages', String(index)));
    assert.deepEqual(args.slice(2), ['--json', '--access', 'public', '--tag', 'latest']);
    assert.equal(args.length, 7);
    assert.equal(path.basename(args[1]), index + '.tgz');
    const bytes = fs.readFileSync(path.resolve(process.cwd(), args[1]));
    const integrity = 'sha256-' + createHash('sha256').update(bytes).digest('base64');
    assert.equal(integrity, ${JSON.stringify(bytes.map((value) => integrity(value)))}[index]);
    const marker = path.join(root, 'published-' + index);
    const already = fs.existsSync(marker);
    const denied = index === 2 && fs.existsSync(path.join(root, 'deny-independent'));
    log({ name: names[index], result: denied ? 'publish-forbidden' : already ? 'already-published' : 'published', integrity, staging: path.dirname(path.resolve(process.cwd(), args[1])) });
    if (denied) {
      console.log(JSON.stringify({ error: { code: 'E403', summary: 'fixture publish failure' } }));
      process.exitCode = 1;
    } else if (already) {
      console.log(JSON.stringify({ error: { code: 'EPUBLISHCONFLICT', summary: 'cannot publish over the previously published versions' } }));
      process.exitCode = 1;
    } else {
      fs.writeFileSync(marker, 'published');
      console.log('{}');
    }
  } else if (tool === 'git' && args.length === 1 && args[0] === 'tag') {
    log({ result: 'list-tags' });
    console.log(tags.filter((_, index) => fs.existsSync(path.join(root, 'tag-' + index))).join('\\n'));
  } else if (tool === 'git' && args.length === 5 && args.slice(0, 4).join(' ') === 'ls-remote --tags origin -l' && tags.includes(args[4])) {
    log({ result: 'remote-tag-absent' });
  } else if (tool === 'git' && args.length === 4 && args[0] === 'tag' && tags.includes(args[1]) && args[2] === '-m' && args[3] === args[1]) {
    fs.writeFileSync(path.join(root, 'tag-' + tags.indexOf(args[1])), 'acknowledged, not a real git tag');
    log({ result: 'tag-acknowledged' });
  } else throw new Error('Unexpected command');
} catch (error) {
  log({ result: 'DENIED', message: error.message });
  console.error(error.message);
  process.exitCode = 97;
}
`;
  for (const tool of ["npm", "git"]) {
    await writeFile(path.join(bin, tool), shim);
    await chmod(path.join(bin, tool), 0o755);
  }
  const report = (stage?: string) => path.join(cwd, `${stage ?? "unsplit"}-report.ndjson`);
  await writeFile(path.join(cwd, "calls.ndjson"), "");
  const calls = async (): Promise<Call[]> =>
    (await readFile(path.join(cwd, "calls.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const events = async (stage?: string) =>
    (await readFile(report(stage), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const execute = async ({
    stage,
    shutdownSignal,
    minimumRetryElapsed = 0,
  }: {
    stage?: "prerequisites" | "verify-registry" | "remaining";
    shutdownSignal?: "SIGINT" | "SIGTERM";
    minimumRetryElapsed?: number;
  } = {}) => {
    if (shutdownSignal) await writeFile(path.join(cwd, "metadata-stall"), "stall");
    const args = JSON.stringify(["--from-pack-dir", pack, ...(stage ? ["--stage", stage] : [])]);
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      process.send('ready');
      await new Promise(resolve => process.once('message', resolve));
      process.disconnect();
      if (${Boolean(shutdownSignal)}) {
        process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(guard))}, ...${args}];
        await import(${JSON.stringify(guard)});
      } else {
        const { publishPackedPackages } = await import(${JSON.stringify(guard)});
        let clock = 0;
        try { await publishPackedPackages(${args}, { now: () => clock, wait: async (ms) => { clock += Math.max(ms, ${minimumRetryElapsed}); } }); }
        catch (error) { console.error(error.message); process.exitCode = 1; }
      }
    `,
      ],
      {
        cwd,
        detached: true,
        // Installed publish accepts its official report environment API, not --output.
        env: { PATH: bin, HOME: cwd, CI: "true", NO_COLOR: "1", CHANGESETS_OUTPUT: report(stage) },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    let output = "";
    child.stdout?.on("data", (data) => {
      output += data;
    });
    child.stderr?.on("data", (data) => {
      output += data;
    });
    const closed = once(child, "close");
    const terminate = () => {
      if (!child.pid) return;
      try {
        // Release the guard, native CLI, and shims together if an assertion or deadline fails.
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const terminateRegistry = () => {
      if (!registryPid) return;
      try {
        process.kill(-registryPid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    try {
      assert.deepEqual(await once(child, "message"), ["ready", undefined]);
      // The server is listening and the child has acknowledged readiness.
      let watchdogFired = false;
      const deadline = setTimeout(() => {
        watchdogFired = true;
        terminate();
        terminateRegistry();
      }, 3_500);
      try {
        child.send("start");
        let interruptedStage: string | undefined;
        if (shutdownSignal) {
          const ready = await Promise.race([
            metadataReady.promise,
            closed.then(() => {
              throw new Error(output);
            }),
          ]);
          interruptedStage = (await calls()).find((call) => call.staging)?.staging;
          if (stage === "verify-registry") assert.equal(interruptedStage, undefined);
          else {
            assert.ok(interruptedStage);
            await readFile(path.join(interruptedStage, "publish-plan.json"));
          }
          assert.ok(child.pid);
          process.kill(-child.pid, shutdownSignal);
          await ready.closed;
        }
        const [code, signal] = await closed;
        assert.equal(watchdogFired, false, `Publish child exceeded its readiness safety deadline: ${output}`);
        assert.equal(signal, shutdownSignal ?? null, output);
        if (interruptedStage)
          await assert.rejects(readFile(path.join(interruptedStage, "publish-plan.json")), { code: "ENOENT" });
        assert.ok(!(await calls()).some((call) => call.result === "DENIED"), output);
        return { code, output };
      } finally {
        clearTimeout(deadline);
      }
    } finally {
      terminate();
      terminateRegistry();
      await closed;
    }
  };
  return {
    cwd,
    planFile,
    bytes,
    save,
    report,
    execute,
    calls,
    events,
    requests,
    delayMetadata: (attempts: number) => writeFile(path.join(cwd, "metadata-pending"), String(attempts)),
    availableAfterRequests: (count: number) => {
      unavailableRequests = count;
    },
    available: (value = true) => {
      available = value;
    },
    close: async () => {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await closed;
    },
  };
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test.skipIf(process.platform === "win32")(
    `CLI ${signal} cancels detached metadata work before staging cleanup and preserves signal status`,
    async () => {
      const f = await fixture();
      try {
        const result = await f.execute({ shutdownSignal: signal });
        assert.equal(result.code, null, result.output);
        assert.match(result.output, /Registry readiness cancelled/u);
        assert.ok(!result.output.includes("Registry readiness deadline exceeded"));
        const calls = await f.calls();
        assert.equal(calls.filter((call) => call.result === "metadata-term").length, 1);
        assert.deepEqual(
          calls.filter((call) => call.args[0] === "publish").map((call) => call.name),
          ["@test/core"],
        );
        assert.deepEqual(
          (await f.events()).map((event) => event.packageName),
          ["@test/core"],
        );
      } finally {
        await f.close();
      }
    },
  );
}

test.skipIf(process.platform === "win32")(
  "read-only CLI SIGTERM closes npm without any report or publish call",
  async () => {
    const f = await fixture();
    try {
      const result = await f.execute({ stage: "verify-registry", shutdownSignal: "SIGTERM" });
      assert.equal(result.code, null, result.output);
      assert.match(result.output, /Registry readiness cancelled/u);
      assert.deepEqual(
        (await f.calls()).map(({ tool, result }) => [tool, result]),
        [["npm", "metadata-term"]],
      );
      await assert.rejects(readFile(f.report("verify-registry")), { code: "ENOENT" });
    } finally {
      await f.close();
    }
  },
);

const publishCalls = (calls: Call[]) => calls.filter(({ tool, args }) => tool === "npm" && args[0] === "publish");

test("a failed registry job can retry the original packed inputs without re-running prerequisite publication", async () => {
  const f = await fixture();
  try {
    const packedPlan = await readFile(f.planFile);
    const first = await f.execute({ stage: "prerequisites" });
    assert.equal(first.code, 0, first.output);
    assert.deepEqual(
      (await f.events("prerequisites")).map(({ packageName }) => packageName),
      ["@test/core"],
    );
    const callsBeforeGate = await f.calls();

    await f.delayMetadata(1);
    const failedGate = await f.execute({ stage: "verify-registry", minimumRetryElapsed: 300_000 });
    assert.equal(failedGate.code, 1, failedGate.output);
    assert.match(failedGate.output, /deadline exceeded.*E404/u);
    f.available();
    const ready = await f.execute({ stage: "verify-registry" });
    assert.equal(ready.code, 0, ready.output);
    assert.deepEqual(
      (await f.calls()).slice(callsBeforeGate.length).map(({ tool, args, result }) => [tool, args[0], result]),
      [
        ["npm", "view", "metadata-pending"],
        ["npm", "view", "metadata"],
      ],
    );
    await assert.rejects(readFile(f.report("verify-registry")), { code: "ENOENT" });

    const last = await f.execute({ stage: "remaining" });
    assert.equal(last.code, 0, last.output);
    assert.deepEqual(
      (await f.events("remaining")).map(({ packageName }) => packageName),
      ["@test/consumer"],
    );

    f.available(false);
    const beforeReplay = (await f.calls()).length;
    const replay = await f.execute({ stage: "remaining", minimumRetryElapsed: 30_000 });
    assert.equal(replay.code, 1, replay.output);
    assert.match(replay.output, /elapsed 30000 ms.*Registry artifact unavailable/u);
    assert.deepEqual(
      (await f.calls()).slice(beforeReplay).map(({ tool, args }) => [tool, args[0]]),
      [["npm", "view"]],
    );
    assert.deepEqual(f.requests, Array(3).fill("/core.tgz"));
    assert.deepEqual(await readFile(f.planFile), packedPlan);
    assert.deepEqual(
      publishCalls(await f.calls()).map(({ name, result, integrity: hash }) => [name, result, hash]),
      [
        ["@test/core", "published", integrity(f.bytes[0])],
        ["@test/consumer", "published", integrity(f.bytes[1])],
      ],
    );
  } finally {
    await f.close();
  }
});

test("a native failure keeps partial events and replay submits already-published bytes without repairing tags", async () => {
  const f = await fixture();
  try {
    await f.save("with-independent");
    const first = await f.execute({ stage: "prerequisites" });
    assert.equal(first.code, 0, first.output);
    f.available();
    const gate = await f.execute({ stage: "verify-registry" });
    assert.equal(gate.code, 0, gate.output);
    const deny = path.join(f.cwd, "deny-independent");
    await writeFile(deny, "deny");
    const failed = await f.execute({ stage: "remaining" });
    assert.equal(failed.code, 1, failed.output);
    assert.match(failed.output, /Native Changesets publish failed/u);
    assert.deepEqual(
      (await f.events("remaining")).map(({ packageName }) => packageName),
      ["@test/consumer"],
    );

    // Simulate a fresh runner report and a tag not saved to GitHub on the previous attempt.
    await Promise.all([deny, f.report("remaining"), path.join(f.cwd, "tag-1")].map((file) => rm(file)));
    const replay = await f.execute({ stage: "remaining" });
    assert.equal(replay.code, 0, replay.output);
    assert.deepEqual(
      (await f.events("remaining")).map(({ packageName }) => packageName),
      ["@test/independent"],
    );
    await assert.rejects(readFile(path.join(f.cwd, "tag-1")), { code: "ENOENT" });
    const calls = await f.calls();
    assert.deepEqual(
      publishCalls(calls)
        .map(({ name, result }) => `${name} ${result}`)
        .sort(),
      [
        "@test/consumer already-published",
        "@test/consumer published",
        "@test/core published",
        "@test/independent publish-forbidden",
        "@test/independent published",
      ],
    );
    assert.equal(calls.filter(({ result }) => result === "tag-acknowledged").length, 3);
  } finally {
    await f.close();
  }
});

test("empty publishing stage creates only an empty Action report and a core-only plan needs no registry gate", async () => {
  const f = await fixture();
  try {
    await f.save("core-only");
    const first = await f.execute({ stage: "prerequisites" });
    assert.equal(first.code, 0, first.output);
    assert.deepEqual(await f.events("prerequisites"), []);
    const gate = await f.execute({ stage: "verify-registry" });
    assert.equal(gate.code, 0, gate.output);
    assert.deepEqual(await f.calls(), []);
    await assert.rejects(readFile(f.report("verify-registry")), { code: "ENOENT" });
    const last = await f.execute({ stage: "remaining" });
    assert.equal(last.code, 0, last.output);
    assert.deepEqual(
      publishCalls(await f.calls()).map(({ name }) => name),
      ["@test/core"],
    );
    assert.deepEqual(f.requests, []);
  } finally {
    await f.close();
  }
});

test("actual native publish reports core, blocks on missing bytes, and retries the same plan", async () => {
  const f = await fixture();
  try {
    const first = await f.execute();
    assert.equal(first.code, 1, first.output);
    assert.match(first.output, /Registry artifact unavailable/u);
    assert.deepEqual(await f.events(), [{ type: "git-tag", tag: "@test/core@2.0.0", packageName: "@test/core" }]);
    assert.deepEqual(
      (await f.calls()).filter((call) => call.args[0] === "publish").map((call) => [call.name, call.result]),
      [["@test/core", "published"]],
    );
    assert.deepEqual(f.requests, Array(15).fill("/core.tgz"));
    f.available();
    const retry = await f.execute();
    assert.equal(retry.code, 0, retry.output);
    assert.deepEqual(
      (await f.events()).map((event) => event.packageName),
      ["@test/core", "@test/consumer"],
    );
    const calls = await f.calls();
    assert.deepEqual(
      calls.filter((call) => call.args[0] === "publish").map((call) => [call.name, call.result]),
      [
        ["@test/core", "published"],
        ["@test/core", "already-published"],
        ["@test/consumer", "published"],
      ],
    );
    assert.equal(calls.filter((call) => call.result === "tag-acknowledged").length, 2);
    assert.deepEqual(f.requests, Array(16).fill("/core.tgz"));
  } finally {
    await f.close();
  }
});

test("actual native publish waits for metadata and tarball propagation within one run", async () => {
  const f = await fixture();
  try {
    await f.delayMetadata(2);
    f.availableAfterRequests(2);
    const result = await f.execute();
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(
      (await f.events()).map((event) => event.packageName),
      ["@test/core", "@test/consumer"],
    );
    const calls = await f.calls();
    assert.deepEqual(
      calls.filter((call) => call.args[0] === "publish").map((call) => call.name),
      ["@test/core", "@test/consumer"],
    );
    assert.equal(calls.filter((call) => call.result === "metadata-pending").length, 2);
    assert.equal(calls.filter((call) => call.result === "metadata").length, 3);
    assert.equal(result.output.match(/retrying in 2000 ms/gu)?.length, 4);
    assert.deepEqual(f.requests, Array(3).fill("/core.tgz"));
  } finally {
    await f.close();
  }
});

for (const mode of ["tag-only", "omitted"]) {
  test(`actual native fresh ${mode} plan still gates the consumer`, async () => {
    const f = await fixture();
    try {
      await f.save(mode);
      const blocked = await f.execute();
      assert.equal(blocked.code, 1, blocked.output);
      assert.match(blocked.output, /Registry artifact unavailable/u);
      assert.ok(!(await f.calls()).some((call) => call.args[0] === "publish"));
      f.available();
      const ready = await f.execute();
      assert.equal(ready.code, 0, ready.output);
      assert.deepEqual(
        (await f.calls()).filter((call) => call.args[0] === "publish").map((call) => call.name),
        ["@test/consumer"],
      );
      assert.deepEqual(
        (await f.events()).map((event) => event.packageName),
        mode === "tag-only" ? ["@test/core", "@test/consumer"] : ["@test/consumer"],
      );
    } finally {
      await f.close();
    }
  });
}
