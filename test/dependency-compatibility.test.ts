import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";

const { dependencyProblems } = (await import(pathToFileURL(resolve("scripts/check-dependencies.mjs")).href)) as {
  dependencyProblems(options: {
    root: string;
    execute?: (...args: unknown[]) => { status: number | null; stdout?: string; error?: Error };
  }): string[];
};

async function json(root: string, file: string, value: unknown) {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), JSON.stringify(value));
}

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-dependency-compatibility-"));
  try {
    await json(root, "package.json", { name: "fixture", private: true, version: "1.0.0", workspaces: ["packages/*"] });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the root dependency command exits nonzero for a mismatch and succeeds after repair", async () => {
  await fixture(async (root) => {
    const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
    await mkdir(join(root, "scripts"));
    for (const script of ["check-dependencies.mjs", "workspace-graph.mjs"]) {
      await copyFile(resolve("scripts", script), join(root, "scripts", script));
    }
    await json(root, "node_modules/companion/package.json", { name: "companion", version: "1.2.0" });
    await cp(resolve("node_modules/semver"), join(root, "node_modules/semver"), { recursive: true });
    const npm = process.env.npm_execpath;
    const check = () =>
      spawnSync(
        npm ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm",
        [...(npm ? [npm] : []), "run", "check:dependencies"],
        { cwd: root, env: process.env, encoding: "utf8" },
      );
    for (const [peer, valid] of [
      ["1.0.4", false],
      ["^1.2.0", true],
    ] as const) {
      await json(root, "package.json", {
        name: "fixture",
        private: true,
        version: "1.0.0",
        scripts: { "check:dependencies": manifest.scripts["check:dependencies"] },
        devDependencies: { companion: "1.2.0" },
        peerDependencies: { companion: peer },
      });
      const result = check();
      if (valid) {
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /Dependency compatibility check passed/u);
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /package\.json:.*devDependencies.*companion.*peerDependencies.*align/u);
      }
    }
  });
});

test("rejects the aa919c68 durable dev/peer mismatch from PR 1598", async () => {
  await fixture(async (root) => {
    await json(root, "packages/pi-langfuse/package.json", {
      name: "@narumitw/pi-langfuse",
      version: "1.0.0",
      peerDependencies: { "@earendil-works/pi-durable": "1.0.4" },
      peerDependenciesMeta: { "@earendil-works/pi-durable": { optional: true } },
      devDependencies: { "@earendil-works/pi-durable": "1.2.0" },
    });
    assert.ok(
      dependencyProblems({ root }).some((problem) =>
        /packages\/pi-langfuse\/package\.json:.*pi-durable.*1\.2\.0.*1\.0\.4.*align/u.test(problem),
      ),
    );
  });
});

test("rejects the 2e3c3ce1 hoisted OpenTelemetry peer mismatch from PR 1684", async () => {
  await fixture(async (root) => {
    await json(root, "package.json", {
      name: "fixture",
      private: true,
      version: "1.0.0",
      workspaces: ["packages/*"],
      dependencies: { "@opentelemetry/sdk-logs": "3.0.0", "@opentelemetry/api": "1.9.1" },
    });
    await json(root, "node_modules/@opentelemetry/sdk-logs/package.json", {
      name: "@opentelemetry/sdk-logs",
      version: "3.0.0",
      peerDependencies: { "@opentelemetry/api": ">=1.10.0 <1.11.0" },
    });
    await json(root, "node_modules/@opentelemetry/api/package.json", { name: "@opentelemetry/api", version: "1.9.1" });
    await json(root, "packages/pi-langfuse/package.json", {
      name: "@narumitw/pi-langfuse",
      version: "1.0.0",
      dependencies: { "@opentelemetry/api": "1.10.0" },
    });
    await json(root, "packages/pi-langfuse/node_modules/@opentelemetry/api/package.json", {
      name: "@opentelemetry/api",
      version: "1.10.0",
    });
    await mkdir(join(root, "node_modules/@narumitw"), { recursive: true });
    await symlink(join(root, "packages/pi-langfuse"), join(root, "node_modules/@narumitw/pi-langfuse"), "dir");
    // The consumer's newer nested copy cannot satisfy the hoisted SDK's peer.
    const problems = dependencyProblems({ root });
    assert.ok(
      problems.some((problem) => /invalid: @opentelemetry\/api@1\.9\.1/u.test(problem)),
      problems.join("\n"),
    );
    await json(root, "package.json", {
      name: "fixture",
      private: true,
      version: "1.0.0",
      workspaces: ["packages/*"],
      dependencies: { "@opentelemetry/sdk-logs": "3.0.0", "@opentelemetry/api": "1.10.0" },
    });
    await json(root, "node_modules/@opentelemetry/api/package.json", { name: "@opentelemetry/api", version: "1.10.0" });
    assert.deepEqual(dependencyProblems({ root }), []);
  });
});

test("absent optional peers are valid but installed incompatible optional peers fail", async () => {
  await fixture(async (root) => {
    await json(root, "package.json", {
      name: "fixture",
      private: true,
      version: "1.0.0",
      dependencies: { plugin: "1.0.0" },
    });
    await json(root, "node_modules/plugin/package.json", {
      name: "plugin",
      version: "1.0.0",
      peerDependencies: { companion: "^2.0.0" },
      peerDependenciesMeta: { companion: { optional: true } },
    });
    assert.deepEqual(dependencyProblems({ root }), []);
    await json(root, "package.json", {
      name: "fixture",
      private: true,
      version: "1.0.0",
      dependencies: { plugin: "1.0.0", companion: "*" },
    });
    await json(root, "node_modules/companion/package.json", { name: "companion", version: "1.0.0" });
    assert.ok(dependencyProblems({ root }).some((problem) => /invalid: companion@1\.0\.0/u.test(problem)));
    await json(root, "node_modules/companion/package.json", { name: "companion", version: "2.0.0" });
    assert.deepEqual(dependencyProblems({ root }), []);
  });
});

test("dev ranges must stay within the supported peer range even when the installed version works", async () => {
  await fixture(async (root) => {
    for (const [dev, peer, valid] of [
      ["^1.0.0", ">=1.2.0 <2", false],
      ["^1.2.0", ">=1.0.0 <2", true],
      ["1.2.0", "*", true],
      ["1.2.0 || 2.0.0", "^1.0.0", false],
    ] as const) {
      await json(root, "package.json", {
        name: "fixture",
        private: true,
        version: "1.0.0",
        devDependencies: { companion: dev },
        peerDependencies: { companion: peer },
      });
      await json(root, "node_modules/companion/package.json", { name: "companion", version: "1.2.0" });
      assert.equal(dependencyProblems({ root }).length === 0, valid, `${dev} / ${peer}`);
    }
  });
});

test("extraneous packages alone do not invalidate declared dependency compatibility", async () => {
  await fixture(async (root) => {
    await json(root, "node_modules/extra/package.json", { name: "extra", version: "1.0.0" });
    assert.deepEqual(dependencyProblems({ root }), []);
  });
});

test("dependency inspection fails closed on missing packages, subprocess errors, and malformed output", async () => {
  await fixture(async (root) => {
    await json(root, "package.json", { name: "fixture", private: true, dependencies: { missing: "1.0.0" } });
    assert.ok(dependencyProblems({ root }).some((problem) => /missing: missing@1\.0\.0/u.test(problem)));
    for (const result of [
      { status: null, error: new Error("spawn failed") },
      { status: 0, stdout: "not json" },
      { status: 0, stdout: "null" },
      { status: null, stdout: "{}" },
      { status: 1, stdout: "{}" },
      { status: 0, stdout: '{"problems":["invalid: dependency"]}' },
    ]) {
      assert.ok(dependencyProblems({ root, execute: () => result }).length > 0);
    }
  });
});
