import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";

type ResolverOptions = { cwd?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform };
const helper = (await import(
  pathToFileURL(resolve("packages/pi-herdr/scripts/resolve-herdr-executable.mjs")).href
)) as {
  resolveHerdrExecutable(options?: ResolverOptions): Promise<string>;
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

test("resolver skips checkout and relative PATH candidates", async () => {
  const f = await fixture();
  await f.candidate(f.cwd);
  await f.candidate(f.local);
  const trusted = await f.candidate(f.trusted);
  const env = { PATH: ["", ".", "../bin", f.local, f.trusted].join(delimiter) };
  assert.equal(await helper.resolveHerdrExecutable({ cwd: f.cwd, env }), await realpath(trusted));
});

test("unsafe-only or absent PATH fails without executing a candidate", async () => {
  const f = await fixture();
  await f.candidate(f.local);
  for (const PATH of [undefined, "", ".", [f.local, "../bin"].join(delimiter)]) {
    await assert.rejects(helper.resolveHerdrExecutable({ cwd: f.cwd, env: { PATH } }), /outside the project/u);
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
