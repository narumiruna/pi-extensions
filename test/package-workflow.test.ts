import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { findPackageJSON } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "vitest";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/run-package-workflow.mjs", import.meta.url));

test.each([
  ["sync", "@narumitw/pi-sync"],
  ["sync-daemon", "@narumitw/pi-sync-daemon"],
  ["pi-sync-daemon", "@narumitw/pi-sync-daemon"],
  ["plain-service", "plain-service"],
])("package pack resolves the exact workspace for %s", async (name, workspace) => {
  await fixture(async ({ run }) => {
    assert.deepEqual(await run("pack", name), [["npm", "--workspace", workspace, "pack", "--dry-run"]]);
  });
});
test.each([0, 1])("service install uses npm and checks visibility first (view=%s)", async (status) => {
  await fixture(async ({ run }) => {
    const calls = await run("install", "pi-sync-daemon", status);
    assert.deepEqual(
      calls,
      status === 0
        ? [
            ["npm", "view", "@narumitw/pi-sync-daemon", "version"],
            ["npm", "install", "--global", "@narumitw/pi-sync-daemon"],
          ]
        : [
            ["npm", "view", "@narumitw/pi-sync-daemon", "version"],
            ["npm", "--workspace", "@narumitw/pi-sync-daemon", "run", "build"],
            ["npm", "install", "--global", "./packages/pi-sync-daemon"],
          ],
    );
  });
});
test.each([0, 1])("extension install keeps the existing Pi alias behavior (view=%s)", async (status) => {
  await fixture(async ({ run }) => {
    assert.deepEqual(await run("install", "sync", status), [
      ["npm", "view", "@narumitw/pi-sync", "version"],
      ["pi", "install", status === 0 ? "npm:@narumitw/pi-sync" : "./packages/pi-sync"],
    ]);
  });
});
test("invalid package arguments cannot escape workspace resolution", async () => {
  await fixture(async ({ run }) => {
    await assert.rejects(run("pack", "../pi-sync-daemon"), /invalid package name/u);
  });
});
for (const platform of ["win32", "linux"]) {
  for (const npmExecpath of [undefined, path.join("npm path & spaces", "npm-cli.js")]) {
    test(`npm uses the executable CLI without a shell (${platform}, npm_execpath=${String(npmExecpath)})`, async () => {
      await fixture(
        async ({ run, calls }) => {
          await run("pack", "sync-daemon");
          const npmCli =
            npmExecpath ??
            (platform === "win32"
              ? path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")
              : undefined);
          assert.deepEqual(calls, [
            {
              command: npmCli ? process.execPath : "npm",
              args: [...(npmCli ? [npmCli] : []), "--workspace", "@narumitw/pi-sync-daemon", "pack", "--dry-run"],
              options: { stdio: "inherit" },
            },
          ]);
        },
        { platform, npmExecpath },
      );
    });
  }
}

test.each([0, 1])("Windows Pi installation uses the declared CLI bin without a shell (view=%s)", async (status) => {
  const manifestPath = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
  assert.ok(manifestPath);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  await fixture(
    async ({ run, calls }) => {
      await run("install", "sync", status);
      assert.deepEqual(calls.at(-1), {
        command: process.execPath,
        args: [
          path.resolve(path.dirname(manifestPath), manifest.bin.pi),
          "install",
          status === 0 ? "npm:@narumitw/pi-sync" : "./packages/pi-sync",
        ],
        options: { stdio: "inherit" },
      });
      assert.equal(calls[0]?.options.stdio, "ignore");
    },
    { platform: "win32" },
  );
});

for (const result of [{ status: 17 }, { status: null }, { status: null, error: "fixture spawn failure" }]) {
  test(`required command failures retain their status (${JSON.stringify(result)})`, async () => {
    await fixture(
      async ({ run, calls }) => {
        await assert.rejects(run("pack", "sync-daemon"), { code: result.status ?? 1 });
        assert.equal(calls.length, 1);
      },
      { platform: "win32", results: [result] },
    );
  });
}

test("a failed local service build stops before installation", async () => {
  await fixture(
    async ({ run, calls }) => {
      await assert.rejects(run("install", "sync-daemon", 1), { code: 23 });
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[1]?.args.slice(-4), ["--workspace", "@narumitw/pi-sync-daemon", "run", "build"]);
    },
    { platform: "win32", results: [{ status: 1 }, { status: 23 }] },
  );
});

test("optional registry failures continue but spawn failures stop", async () => {
  await fixture(
    async ({ run, calls }) => {
      await run("doctor", "@narumitw/pi-sync-daemon");
      assert.equal(calls.length, 5);
      assert.ok(calls.every(({ command }) => command === process.execPath));
    },
    { platform: "win32", results: [{ status: 1 }, { status: 0 }, { status: 1 }, { status: 1 }, { status: 1 }] },
  );
  await fixture(
    async ({ run, calls }) => {
      await assert.rejects(run("install", "sync-daemon"), /fixture spawn failure/u);
      assert.equal(calls.length, 1);
    },
    { platform: "win32", results: [{ status: null, error: "fixture spawn failure" }] },
  );
});

interface Invocation {
  command: string;
  args: string[];
  options: { stdio: string; shell?: boolean };
}
interface FixtureOptions {
  platform?: string;
  npmExecpath?: string;
  results?: { status: number | null; error?: string }[];
}

async function fixture(
  action: (fixture: {
    run(command: string, name: string, status?: number): Promise<string[][]>;
    calls: Invocation[];
  }) => Promise<void>,
  options: FixtureOptions = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi package workflow &-"));
  const log = path.join(root, "calls.jsonl");
  const preload = path.join(root, "spawn.mjs");
  const calls: Invocation[] = [];
  const platform = options.platform ?? process.platform;
  const npmCli =
    options.npmExecpath ??
    (platform === "win32" ? path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js") : undefined);
  try {
    for (const [directory, manifest] of [
      ["pi-sync", { name: "@narumitw/pi-sync", pi: { extensions: ["./src/index.ts"] } }],
      ["pi-sync-daemon", { name: "@narumitw/pi-sync-daemon", bin: { "pi-sync-daemon": "./dist/cli.js" } }],
      ["plain-service", { name: "plain-service", bin: { "plain-service": "./dist/cli.js" } }],
    ] as const) {
      const folder = path.join(root, "packages", directory);
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, "package.json"), JSON.stringify(manifest));
    }
    // Replace every child before loading the real CLI; no registry, installation, or shell can run.
    await fs.writeFile(
      preload,
      `import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
const results = ${JSON.stringify(options.results ?? [])};
let index = 0;
childProcess.spawnSync = (command, args, options) => {
  appendFileSync(process.env.TEST_WORKFLOW_LOG, JSON.stringify({ command, args, options }) + '\\n');
  const action = command === process.execPath ? args[1] : args[0];
  const result = results[index++] ?? { status: action === 'view' ? Number(process.env.TEST_VIEW_STATUS) : 0 };
  return { ...result, error: result.error ? new Error(result.error) : undefined };
};
syncBuiltinESMExports();
`,
    );
    await action({
      calls,
      run: async (command, name, status = 0) => {
        await fs.writeFile(log, "");
        const env = {
          ...process.env,
          npm_execpath: options.npmExecpath ?? "",
          TEST_WORKFLOW_LOG: log,
          TEST_VIEW_STATUS: String(status),
        };
        try {
          await exec(process.execPath, ["--import", pathToFileURL(preload).href, script, command, name], {
            cwd: root,
            env,
          });
        } finally {
          calls.length = 0;
          calls.push(
            ...(await fs.readFile(log, "utf8"))
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line)),
          );
        }
        return calls.map(({ command: executable, args }) => {
          if (executable !== process.execPath) return [executable, ...args];
          return [args[0] === npmCli ? "npm" : "pi", ...args.slice(1)];
        });
      },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
