import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "vitest";

const exec = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");

interface BuildResult {
  status: number | null;
  error?: string;
}
interface Invocation {
  command: string;
  args: string[];
  options: { cwd: string; stdio: string; shell?: boolean };
}

async function fixture(
  platform: string,
  result: BuildResult,
  action: (fixture: { root: string; compiler: string; run(): Promise<void>; calls: Invocation[] }) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi daemon build &-"));
  const root = path.join(directory, "packages/pi-sync-daemon");
  const compiler = path.join(directory, "node_modules/typescript/bin/tsc");
  const preload = path.join(directory, "spawn.mjs");
  const log = path.join(directory, "calls.jsonl");
  const calls: Invocation[] = [];
  try {
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "dist"));
    await mkdir(path.dirname(compiler), { recursive: true });
    await writeFile(compiler, "// compiler resolution fixture\n");
    await writeFile(
      path.join(directory, "node_modules/typescript/package.json"),
      JSON.stringify({
        name: "typescript",
        bin: { tsc: "./bin/tsc" },
        exports: { "./package.json": "./package.json" },
      }),
    );
    for (const file of ["build.mjs", "build-record.mjs"]) {
      await copyFile(
        path.join(repositoryRoot, "packages/pi-sync-daemon/scripts", file),
        path.join(root, "scripts", file),
      );
    }
    await writeFile(path.join(directory, "tsconfig.json"), "{}");
    for (const file of ["package.json", "tsconfig.json", "tsconfig.build.json"]) {
      await writeFile(path.join(root, file), "{}");
    }
    await writeFile(path.join(root, "src/cli.ts"), "export {};\n");
    await writeFile(path.join(root, "dist/stale.js"), "stale");
    await writeFile(path.join(root, ".daemon-build.json"), "stale");
    await writeFile(log, "");
    // Replace only compilation; exercise the real cleanup, input capture, and build-record publication.
    await writeFile(
      preload,
      `import childProcess from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
childProcess.spawnSync = (command, args, options) => {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command, args, options }) + '\\n');
  if (existsSync(join(options.cwd, '.daemon-build.json')) || existsSync(join(options.cwd, 'dist'))) {
    throw new Error('stale output survived until compilation');
  }
  const result = ${JSON.stringify(result)};
  if (result.status === 0 && !result.error) {
    mkdirSync(join(options.cwd, 'dist'));
    writeFileSync(join(options.cwd, 'dist/cli.js'), 'export {};\\n');
  }
  return { ...result, error: result.error ? new Error(result.error) : undefined };
};
syncBuiltinESMExports();
`,
    );
    await action({
      root,
      compiler,
      calls,
      async run() {
        try {
          await exec(
            process.execPath,
            ["--import", pathToFileURL(preload).href, path.join(root, "scripts/build.mjs")],
            {
              cwd: directory,
            },
          );
        } finally {
          calls.push(
            ...(await readFile(log, "utf8"))
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line)),
          );
        }
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const platform of ["win32", "linux"]) {
  test(`daemon compilation uses Node and the compiler entry without a shell (${platform})`, async () => {
    await fixture(platform, { status: 0 }, async ({ root, compiler, run, calls }) => {
      await run();
      assert.deepEqual(calls, [
        {
          command: process.execPath,
          args: [compiler, "-p", "tsconfig.build.json"],
          options: { cwd: `${root}${path.sep}`, stdio: "inherit" },
        },
      ]);
      const record = JSON.parse(await readFile(path.join(root, ".daemon-build.json"), "utf8"));
      assert.deepEqual(
        record.runtime.map(([file]: [string, string]) => file),
        ["cli.js"],
      );
      assert.ok(record.inputs.some(([file]: [string, string]) => file === "src/cli.ts"));
      await assert.rejects(readFile(path.join(root, "dist/stale.js")), { code: "ENOENT" });
    });
  });
}

for (const result of [{ status: 23 }, { status: null }, { status: null, error: "fixture spawn failure" }]) {
  test(`daemon compilation failure does not publish a build record (${JSON.stringify(result)})`, async () => {
    await fixture("win32", result, async ({ root, run, calls }) => {
      await assert.rejects(run(), { code: result.status ?? 1 });
      assert.equal(calls.length, 1);
      await assert.rejects(readFile(path.join(root, ".daemon-build.json")), { code: "ENOENT" });
      await assert.rejects(readFile(path.join(root, "dist/cli.js")), { code: "ENOENT" });
    });
  });
}
