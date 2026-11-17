import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";

const { runBuilds } = (await import(pathToFileURL(resolve("scripts/run-builds.mjs")).href)) as {
  runBuilds(options: {
    root: string;
    workspaceNames?: string[];
    execute?: (...args: unknown[]) => { status: number | null; error?: Error };
  }): number;
};

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-build-order-"));
  try {
    const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ private: true, workspaces: ["packages/*"], scripts: { build: manifest.scripts.build } }),
    );
    await mkdir(join(root, "scripts"));
    for (const script of ["run-builds.mjs", "workspace-graph.mjs"]) {
      await copyFile(resolve("scripts", script), join(root, "scripts", script));
    }
    await mkdir(join(root, "node_modules"));
    await symlink(resolve("node_modules/semver"), join(root, "node_modules/semver"), "dir");
    await workspace(root, "pi-tui-kit", {}, true);
    await workspace(root, "bridge", { "@narumitw/pi-tui-kit": "^1.0.0" }, false);
    await workspace(root, "pi-agentfs", { "@narumitw/bridge": "^1.0.0" }, true);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function workspace(root: string, directory: string, dependencies: Record<string, string>, build: boolean) {
  const target = join(root, "packages", directory);
  await mkdir(target, { recursive: true });
  await writeFile(
    join(target, "package.json"),
    JSON.stringify({
      name: `@narumitw/${directory}`,
      version: "1.0.0",
      type: "module",
      dependencies,
      scripts: build ? { build: "node build.mjs" } : {},
    }),
  );
  const prerequisite =
    directory === "pi-agentfs" ? 'await fs.access(new URL("../pi-tui-kit/dist/index.d.ts", import.meta.url));' : "";
  await writeFile(
    join(target, "build.mjs"),
    `import fs from "node:fs/promises";
${prerequisite}
await fs.mkdir(new URL("./dist/", import.meta.url));
await fs.writeFile(new URL("./dist/index.d.ts", import.meta.url), "export {};\\n");
await fs.appendFile(new URL("../../order.log", import.meta.url), ${JSON.stringify(`${directory}\n`)});
`,
  );
}

function build(root: string, command = "build") {
  const npm = process.env.npm_execpath;
  return spawnSync(
    npm ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm",
    npm ? [npm, "run", command] : ["run", command],
    {
      cwd: root,
      env: process.env,
      encoding: "utf8",
    },
  );
}

test("root builds cold dependencies before alphabetically earlier consumers, once, through no-build packages", async () => {
  await fixture(async (root) => {
    const result = build(root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(await readFile(join(root, "order.log"), "utf8"), "pi-tui-kit\npi-agentfs\n");
  });
});

test("the pre-c846a729 workspace-order workaround fails the same cold fixture", async () => {
  await fixture(async (root) => {
    // c846a729 fixed this command by hand-ordering Kit in workspaces; ordering is now graph-owned.
    const manifestPath = join(root, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.scripts.historical = "npm --workspaces --if-present run build";
    await writeFile(manifestPath, JSON.stringify(manifest));
    const result = build(root, "historical");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ENOENT.*pi-tui-kit.*dist.*index\.d\.ts/u);
  });
});

test("selected builds include transitive prerequisites and skip unrelated builds", async () => {
  await fixture(async (root) => {
    await workspace(root, "unrelated", {}, true);
    assert.equal(runBuilds({ root, workspaceNames: ["@narumitw/pi-agentfs"] }), 0);
    assert.equal(await readFile(join(root, "order.log"), "utf8"), "pi-tui-kit\npi-agentfs\n");
  });
});

test("the renamed daemon builds before Pi Sync from a cold workspace", async () => {
  await fixture(async (root) => {
    await workspace(root, "pi-sync-daemon", {}, true);
    await workspace(root, "pi-sync", { "@narumitw/pi-sync-daemon": "^1.0.0" }, true);
    assert.equal(runBuilds({ root, workspaceNames: ["@narumitw/pi-sync"] }), 0);
    assert.equal(await readFile(join(root, "order.log"), "utf8"), "pi-sync-daemon\npi-sync\n");
  });
});

test("a failed prerequisite stops consumers, including signal and spawn failures", async () => {
  await fixture(async (root) => {
    for (const failure of [{ status: 7 }, { status: null }, { status: null, error: new Error("cannot spawn") }]) {
      const calls: unknown[][] = [];
      const status = runBuilds({
        root,
        execute: (...args) => {
          calls.push(args);
          return failure;
        },
      });
      assert.equal(status, failure.status ?? 1);
      assert.equal(calls.length, 1);
      assert.ok(JSON.stringify(calls).includes("@narumitw/pi-tui-kit"));
    }
  });
});

test("cycles and unknown workspaces fail before any build starts", async () => {
  await fixture(async (root) => {
    let calls = 0;
    const execute = () => {
      calls++;
      return { status: 0 };
    };
    assert.throws(() => runBuilds({ root, workspaceNames: ["missing"], execute }), /Unknown build workspace: missing/u);
    await workspace(root, "pi-tui-kit", { "@narumitw/pi-agentfs": "^1.0.0" }, true);
    assert.throws(
      () => runBuilds({ root, execute }),
      /Workspace dependency cycle:.*bridge.*pi-tui-kit.*pi-agentfs.*bridge.*package\.json/u,
    );
    assert.equal(calls, 0);
  });
});
