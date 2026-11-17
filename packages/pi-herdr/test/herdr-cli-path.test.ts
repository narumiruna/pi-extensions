import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";

type ResolverOptions = { cwd?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform };
type RunnerOptions = ResolverOptions & { execFileImpl?: (...args: unknown[]) => void };
const helper = (await import(
  pathToFileURL(resolve("packages/pi-herdr/skills/pi-herdr/scripts/spawn-peer.mjs")).href
)) as {
  resolveHerdrExecutable(options?: ResolverOptions): Promise<string>;
  createRunner(options: RunnerOptions): (args: string[]) => Promise<string>;
  parseArguments(args: string[]): unknown;
  runCli(args: string[], dependencies: Record<string, unknown>): Promise<number>;
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-cli-path-"));
  directories.push(root);
  const project = join(root, "checkout");
  const cwd = join(project, "nested");
  const local = join(project, "bin");
  const trusted = join(root, "trusted-bin");
  for (const directory of [cwd, local, trusted, join(project, ".git")]) await mkdir(directory, { recursive: true });
  async function candidate(directory: string, name = process.platform === "win32" ? "herdr.exe" : "herdr") {
    const path = join(directory, name);
    // Selection tests never execute these inert fixture files.
    await writeFile(path, "inert resolver fixture\n");
    await chmod(path, 0o700);
    return path;
  }
  return { root, project, cwd, local, trusted, candidate };
}

test("default runner skips checkout and relative PATH candidates and executes only the canonical outside path", async () => {
  const f = await fixture();
  await f.candidate(f.cwd);
  await f.candidate(f.local);
  const trusted = await f.candidate(f.trusted);
  const commands: string[] = [];
  const env = { PATH: ["", ".", "../bin", f.local, f.trusted].join(delimiter) };
  const run = helper.createRunner({
    cwd: f.cwd,
    env,
    execFileImpl(command, _args, _options, callback) {
      commands.push(command as string);
      (callback as (error: null, stdout: string) => void)(null, "{}");
    },
  });
  await run(["status"]);
  await run(["agent", "list"]);
  assert.deepEqual(commands, [await realpath(trusted), await realpath(trusted)]);
});

test("unsafe-only or absent PATH fails without executing a candidate", async () => {
  const f = await fixture();
  await f.candidate(f.local);
  for (const PATH of [undefined, "", ".", [f.local, "../bin"].join(delimiter)]) {
    let executions = 0;
    const run = helper.createRunner({
      cwd: f.cwd,
      env: { PATH },
      execFileImpl() {
        executions += 1;
      },
    });
    await assert.rejects(run(["status"]), /outside the project/u);
    assert.equal(executions, 0);
  }
});

test.skipIf(process.platform === "win32")("resolves symlinks before rejecting project-local targets", async () => {
  const f = await fixture();
  const local = await f.candidate(f.local);
  const linkDirectory = join(f.root, "outside-link");
  await mkdir(linkDirectory);
  await symlink(local, join(linkDirectory, "herdr"));
  const trusted = await f.candidate(f.trusted);
  assert.equal(
    await helper.resolveHerdrExecutable({ cwd: f.cwd, env: { PATH: [linkDirectory, f.trusted].join(delimiter) } }),
    await realpath(trusted),
  );
  await assert.rejects(
    helper.resolveHerdrExecutable({ cwd: f.cwd, env: { PATH: linkDirectory } }),
    /outside the project/u,
  );
});

test("Windows selection ignores implicit cwd lookup and uses a canonical external executable", async () => {
  const f = await fixture();
  await f.candidate(f.cwd, "herdr.exe");
  await f.candidate(f.local, "herdr.exe");
  const trusted = await f.candidate(f.trusted, "herdr.exe");
  assert.equal(
    await helper.resolveHerdrExecutable({
      cwd: f.cwd,
      env: { Path: [".", f.local, f.trusted].join(";") },
      platform: "win32",
    }),
    await realpath(trusted),
  );
});

test("cli-path preflight prints the trusted path without spawning and validates context first", async () => {
  const signals = new EventEmitter();
  const output: string[] = [];
  let resolutions = 0;
  let spawns = 0;
  const dependencies = {
    env: { HERDR_ENV: "1", HERDR_PANE_ID: "pane", HERDR_SOCKET_PATH: "/unused" },
    stdout: { write: (value: string) => output.push(value) },
    signals,
    resolveCli: async () => {
      resolutions += 1;
      return resolve("/trusted/herdr");
    },
    spawn: async () => {
      spawns += 1;
    },
  };
  assert.deepEqual(helper.parseArguments(["--cli-path"]), { cliPath: true });
  assert.equal(await helper.runCli(["--cli-path"], dependencies), 0);
  assert.equal(output.join(""), `${resolve("/trusted/herdr")}\n`);
  assert.equal(resolutions, 1);
  assert.equal(spawns, 0);
  assert.equal(await helper.runCli(["--cli-path"], { ...dependencies, env: { HERDR_ENV: "1" } }), 1);
  assert.equal(resolutions, 1);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});
