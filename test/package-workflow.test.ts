import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
async function fixture(
  action: (fixture: { run(command: string, name: string, status?: number): Promise<string[][]> }) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-package-workflow-"));
  const bin = path.join(root, "bin");
  const log = path.join(root, "calls.jsonl");
  try {
    await fs.mkdir(bin);
    for (const [directory, manifest] of [
      ["pi-sync", { name: "@narumitw/pi-sync", pi: { extensions: ["./src/index.ts"] } }],
      ["pi-sync-daemon", { name: "@narumitw/pi-sync-daemon", bin: { "pi-sync-daemon": "./dist/cli.js" } }],
      ["plain-service", { name: "plain-service", bin: { "plain-service": "./dist/cli.js" } }],
    ] as const) {
      const folder = path.join(root, "packages", directory);
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, "package.json"), JSON.stringify(manifest));
    }
    for (const command of ["npm", "pi"]) {
      const source = `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(process.env.TEST_WORKFLOW_LOG, JSON.stringify([${JSON.stringify(command)}, ...process.argv.slice(2)]) + '\\n');\nif (process.argv[2] === 'view') process.exit(Number(process.env.TEST_VIEW_STATUS));\n`;
      await fs.writeFile(path.join(bin, command), source, { mode: 0o755 });
      if (process.platform === "win32")
        await fs.writeFile(path.join(bin, `${command}.cmd`), `@"${process.execPath}" "%~dp0${command}" %*\r\n`);
    }
    await action({
      run: async (command, name, status = 0) => {
        await fs.writeFile(log, "");
        await exec(process.execPath, [script, command, name], {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            TEST_WORKFLOW_LOG: log,
            TEST_VIEW_STATUS: String(status),
          },
        });
        return (await fs.readFile(log, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
