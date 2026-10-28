import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";

const repositoryRoot = process.cwd();
const kitName = "@narumitw/pi-tui-kit";
const npmCli = path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
const versionCommand = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).scripts[
  "version-packages"
] as string;

describe("Version PR command with an unpublished npm workspace Kit", { concurrent: false }, () => {
  let fixture = "";
  const requests: string[] = [];
  const children = new Set<ChildProcess>();
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "No packages are published in this fixture" }));
  });
  let env: NodeJS.ProcessEnv;
  let versioned = false;
  let lockHash = "";

  async function npm(args: string[]) {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [npmCli, ...args], {
        cwd: fixture,
        env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.add(child);
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (data: string) => {
        stdout += data;
      });
      child.stderr.setEncoding("utf8").on("data", (data: string) => {
        stderr += data;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        children.delete(child);
        resolve({ code, stdout, stderr });
      });
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    return result;
  }

  beforeAll(async () => {
    const pinnedNode = readFileSync(path.join(repositoryRoot, ".node-version"), "utf8").trim();
    assert.equal(process.version, `v${pinnedNode}`, "Run this fixture with fnm exec --using=<.node-version>");
    assert.equal(versionCommand, "changeset version && npm install --package-lock-only --ignore-scripts");
    fixture = mkdtempSync(path.join(tmpdir(), "pi-changesets-version-"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    for (const filename of ["user.npmrc", "global.npmrc"]) writeFileSync(path.join(fixture, filename), "");
    env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/iu.test(key))),
      CI: "true",
      PATH: [path.dirname(process.execPath), path.join(repositoryRoot, "node_modules/.bin"), process.env.PATH].join(
        path.delimiter,
      ),
      npm_config_userconfig: path.join(fixture, "user.npmrc"),
      npm_config_globalconfig: path.join(fixture, "global.npmrc"),
      npm_config_cache: path.join(fixture, "cache"),
      npm_config_registry: `http://127.0.0.1:${address.port}`,
      npm_config_fetch_retries: "0",
      npm_config_audit: "false",
      npm_config_fund: "false",
    };
    writeJson("package.json", {
      name: "version-pr-fixture",
      private: true,
      workspaces: ["packages/*"],
      scripts: { "version-packages": versionCommand },
    });
    writeJson("packages/pi-tui-kit/package.json", { name: kitName, version: "0.9998.3" });
    writeJson("packages/pi-consumer/package.json", {
      name: "@fixture/pi-consumer",
      version: "1.2.3",
      dependencies: { [kitName]: "^0.9998.1" },
    });
    mkdirSync(path.join(fixture, ".changeset"));
    copyFileSync(path.join(repositoryRoot, ".changeset/config.json"), path.join(fixture, ".changeset/config.json"));
    copyFileSync(path.join(repositoryRoot, ".npmrc"), path.join(fixture, ".npmrc"));
    writeFileSync(path.join(fixture, ".changeset/kit.md"), `---\n"${kitName}": minor\n---\n\nAdd a Kit API.\n`);
    await npm(["install", "--package-lock-only", "--ignore-scripts"]);
    assert.equal(readLock().packages["packages/pi-tui-kit"].version, "0.9998.3");
    assert.deepEqual(requests, []);
  });

  afterAll(async () => {
    for (const child of children) {
      if (!child.pid) continue;
      try {
        if (process.platform === "win32") child.kill();
        else process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await Promise.all(
      [...children].map((child) => new Promise<void>((resolve) => child.once("close", () => resolve()))),
    );
    server.closeAllConnections();
    try {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      if (fixture) rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("runs the actual version-packages script and updates the lockfile without registry requests", async () => {
    const before = hashLock();
    await npm(["run", "version-packages"]);
    assert.equal(readJson("packages/pi-tui-kit/package.json").version, "0.9999.0");
    assert.deepEqual(readJson("packages/pi-consumer/package.json"), {
      name: "@fixture/pi-consumer",
      version: "1.2.4",
      dependencies: { [kitName]: "^0.9999.0" },
    });
    const lock = readLock();
    assert.equal(lock.packages["packages/pi-tui-kit"].version, "0.9999.0");
    assert.equal(lock.packages["packages/pi-consumer"].version, "1.2.4");
    assert.deepEqual(lock.packages["packages/pi-consumer"].dependencies, { [kitName]: "^0.9999.0" });
    assert.deepEqual(lock.packages[`node_modules/${kitName}`], { resolved: "packages/pi-tui-kit", link: true });
    assert.equal(
      Object.keys(lock.packages).some((key) => key.endsWith(`/node_modules/${kitName}`)),
      false,
    );
    assert.deepEqual(requests, []);
    lockHash = hashLock();
    assert.notEqual(lockHash, before);
    versioned = true;
  });

  test("npm ci installs the unpublished workspace Kit without fetching it or changing the lock hash", async () => {
    assert.ok(versioned, "The preceding Version PR command must succeed");
    await npm(["ci"]);
    const installedKit = path.join(fixture, "node_modules", kitName);
    assert.equal(realpathSync(installedKit), realpathSync(path.join(fixture, "packages/pi-tui-kit")));
    assert.equal(JSON.parse(readFileSync(path.join(installedKit, "package.json"), "utf8")).version, "0.9999.0");
    assert.equal(hashLock(), lockHash);
    assert.deepEqual(requests, []);
  });

  function writeJson(filename: string, value: unknown) {
    mkdirSync(path.dirname(path.join(fixture, filename)), { recursive: true });
    writeFileSync(path.join(fixture, filename), `${JSON.stringify(value, null, 2)}\n`);
  }

  function readJson(filename: string) {
    return JSON.parse(readFileSync(path.join(fixture, filename), "utf8"));
  }

  function readLock() {
    return readJson("package-lock.json");
  }

  function hashLock() {
    return createHash("sha256")
      .update(readFileSync(path.join(fixture, "package-lock.json")))
      .digest("hex");
  }
});
