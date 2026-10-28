import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";

const guard = new URL("../scripts/publish-packed-packages.mjs", import.meta.url).href;
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const integrity = (bytes: Uint8Array, algorithm = "sha256") =>
  `${algorithm}-${createHash(algorithm).update(bytes).digest("base64")}`;
type Call = { tool: string; args: string[]; name?: string; result?: string; integrity?: string };
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
  const bytes = [Buffer.from("native core exact packed bytes"), Buffer.from("native consumer exact packed bytes")];
  const releases: Release[] = [];
  for (const [index, name] of ["@test/core", "@test/consumer"].entries()) {
    const dir = path.join(cwd, "packages", String(index));
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        name,
        version: "2.0.0",
        ...(index ? { dependencies: { "@test/core": "workspace:./packages/0" } } : {}),
      }),
    );
    const tarball = { path: `${index}.tgz`, integrity: integrity(bytes[index]) };
    await writeFile(path.join(pack, tarball.path), bytes[index]);
    releases.push({ name, version: "2.0.0", kind: "publish", access: "public", tag: "latest", tarball });
  }
  const save = (mode = "full") =>
    writeFile(
      path.join(pack, "publish-plan.json"),
      JSON.stringify({
        version: 1,
        plan:
          mode === "omitted"
            ? [[releases[1]]]
            : mode === "tag-only"
              ? [[{ name: "@test/core", version: "2.0.0", kind: "tag-only" }], [releases[1]]]
              : [[releases[1], releases[0]]],
      }),
    );
  await save();
  let available = false;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
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
const names = ['@test/core', '@test/consumer'];
const tags = names.map(name => name + '@2.0.0');
try {
  if (tool === 'npm' && args[0] === 'view') {
    assert.deepEqual(args, ['view', '@test/core@2.0.0', '--json']);
    assert.equal(process.cwd(), root);
    log({ result: 'metadata' });
    console.log(JSON.stringify(${JSON.stringify(metadata)}));
  } else if (tool === 'npm' && args[0] === 'publish') {
    const index = ['0', '1'].indexOf(path.basename(process.cwd()));
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
    log({ name: names[index], result: already ? 'already-published' : 'published', integrity });
    if (already) {
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
  const report = path.join(cwd, "report.ndjson");
  await writeFile(path.join(cwd, "calls.ndjson"), "");
  const calls = async (): Promise<Call[]> =>
    (await readFile(path.join(cwd, "calls.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const events = async () =>
    (await readFile(report, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const execute = async () => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      process.send('ready');
      await new Promise(resolve => process.once('message', resolve));
      process.disconnect();
      const { publishPackedPackages } = await import(${JSON.stringify(guard)});
      try { await publishPackedPackages(${JSON.stringify(["--from-pack-dir", pack])}); }
      catch (error) { console.error(error.message); process.exitCode = 1; }
    `,
      ],
      {
        cwd,
        detached: true,
        // Installed publish accepts its official report environment API, not --output.
        env: { PATH: bin, HOME: cwd, CI: "true", NO_COLOR: "1", CHANGESETS_OUTPUT: report },
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
    try {
      assert.deepEqual(await once(child, "message"), ["ready", undefined]);
      // The server is listening and the child has acknowledged readiness.
      const deadline = setTimeout(terminate, 3_500);
      try {
        child.send("start");
        const [code, signal] = await closed;
        assert.equal(signal, null, output);
        assert.ok(!(await calls()).some((call) => call.result === "DENIED"), output);
        return { code, output };
      } finally {
        clearTimeout(deadline);
      }
    } finally {
      terminate();
      await closed;
    }
  };
  return {
    cwd,
    bytes,
    save,
    execute,
    calls,
    events,
    requests,
    available: () => {
      available = true;
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
    assert.deepEqual(f.requests, ["/core.tgz"]);
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
    assert.deepEqual(f.requests, ["/core.tgz", "/core.tgz"]);
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
