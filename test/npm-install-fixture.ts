import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

export const repositoryRoot = path.resolve(import.meta.dirname, "..");
const npmCli =
  process.env.npm_execpath ?? path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
const policy = readFileSync(path.join(repositoryRoot, ".npmrc"), "utf8");
const markerScript = "node -e \"require('node:fs').writeFileSync('marker', 'executed')\"";

type Manifest = Record<string, unknown>;
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function createNpmRegistry() {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-npm-policy-"));
  const tarballs = new Map<string, Buffer>();
  const packages = new Map<string, Record<string, Manifest>>();
  const requests: string[] = [];
  const children = new Set<ChildProcess>();
  const server = createServer((request, response) => {
    const url = decodeURIComponent(request.url ?? "");
    requests.push(url);
    const tarball = tarballs.get(url);
    if (tarball) {
      response.end(tarball);
      return;
    }
    const versions = packages.get(url.slice(1));
    if (!versions) {
      response.writeHead(404);
      response.end("{}");
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        name: url.slice(1),
        "dist-tags": { latest: "1.0.1" },
        time: {
          "1.0.0": new Date(Date.now() - 14 * 86_400_000).toISOString(),
          "1.0.1": new Date(Date.now() - 86_400_000).toISOString(),
        },
        versions,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const registry = `http://127.0.0.1:${address.port}`;
  const userConfig = path.join(root, "user.npmrc");
  const globalConfig = path.join(root, "global.npmrc");
  writeFileSync(userConfig, "");
  writeFileSync(globalConfig, "");
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/iu.test(key))),
    CI: "true",
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    npm_config_cache: path.join(root, "cache"),
    npm_config_registry: registry,
    npm_config_audit: "false",
    npm_config_fund: "false",
  };

  function addPackage(name: string, extra: Manifest = {}) {
    const versions: Record<string, Manifest> = {};
    for (const version of ["1.0.0", "1.0.1"]) {
      const source = path.join(root, `${name.replace("/", "-")}-${version}`);
      mkdirSync(path.join(source, "package"), { recursive: true });
      const manifest = { name, version, ...extra };
      writeFileSync(path.join(source, "package/package.json"), JSON.stringify(manifest));
      const archive = `${source}.tgz`;
      execFileSync("tar", ["-czf", archive, "-C", source, "package"]);
      const data = readFileSync(archive);
      const url = `/${name}/-/${path.posix.basename(name)}-${version}.tgz`;
      tarballs.set(url, data);
      versions[version] = {
        ...manifest,
        dist: { tarball: registry + url, integrity: `sha512-${createHash("sha512").update(data).digest("base64")}` },
      };
    }
    packages.set(name, versions);
  }
  try {
    addPackage("policy-script", { scripts: { postinstall: markerScript } });
    addPackage("policy-plain");
    addPackage("@narumitw/policy-plain");
    addPackage("@narumitw/pi-tui-kit", {
      dependencies: { "policy-plain": "^1.0.0", "policy-script": "^1.0.0" },
    });
    addPackage("policy-incompatible", {
      os: [process.platform === "darwin" ? "linux" : "darwin"],
      scripts: { install: markerScript },
    });
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  function fixture(manifest: Manifest = {}) {
    const cwd = mkdtempSync(path.join(root, "consumer-"));
    writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "consumer", version: "1.0.0", ...manifest }));
    writeFileSync(path.join(cwd, ".npmrc"), policy);
    return cwd;
  }

  function command(cwd: string, args: string[], overrides: NodeJS.ProcessEnv = {}): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, args, {
        cwd,
        env: { ...env, ...overrides },
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
      child.on("error", (error) => {
        stderr += error.message;
      });
      child.on("close", (code) => {
        children.delete(child);
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  }

  function cancelCommands() {
    for (const child of children) {
      if (!child.pid) continue;
      try {
        if (process.platform === "win32") child.kill();
        else process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }

  return {
    root,
    env,
    registry,
    requests,
    fixture,
    command,
    cancelCommands,
    npm: (cwd: string, args: string[], overrides?: NodeJS.ProcessEnv) => command(cwd, [npmCli, ...args], overrides),
    lockedVersion: (cwd: string, name = "policy-plain") =>
      JSON.parse(readFileSync(path.join(cwd, "package-lock.json"), "utf8")).packages[`node_modules/${name}`]?.version as
        | string
        | undefined,
    marker: (cwd: string, name = "policy-script") => existsSync(path.join(cwd, "node_modules", name, "marker")),
    async close() {
      cancelCommands();
      server.closeAllConnections();
      try {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

export function expectSuccess(result: CommandResult) {
  assert.equal(result.code, 0, result.stderr || result.stdout);
}
