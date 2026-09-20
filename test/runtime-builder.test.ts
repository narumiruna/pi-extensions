import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { type BuildMetadata, listFiles, type RuntimeBuilder } from "./runtime-builder-contract.js";

const banner = "// @generated runtime fixture";
interface Configuration {
  packageRoot: string;
  temporaryPrefix: string;
  banner: string;
  forbiddenEagerInputs?: string[];
  forbiddenEagerExternals?: string[];
  validateGraph?: () => void;
  validateFiles?: () => Promise<void>;
}
const builderUrl = pathToFileURL(resolve("scripts/runtime-builder.mjs")).href;
const { createRuntimeBuilder } = (await import(builderUrl)) as {
  createRuntimeBuilder(config: Configuration): RuntimeBuilder;
};

test("root tooling declares its esbuild dependency without relying on workspace hoisting", async () => {
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const lockfile = JSON.parse(await readFile(resolve("package-lock.json"), "utf8"));
  const version = manifest.devDependencies.esbuild;
  assert.equal(typeof version, "string", "the shared builder must own a root esbuild devDependency");
  assert.match(version, /^\d+\.\d+\.\d+$/u, "pin the builder to an exact esbuild version");
  assert.equal(lockfile.packages[""].devDependencies.esbuild, version);
  assert.equal(lockfile.packages["node_modules/esbuild"].version, version);
});

async function fixture(run: (builder: RuntimeBuilder, root: string, config: Configuration) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "runtime-builder-"));
  const config = { packageRoot: root, temporaryPrefix: ".runtime", banner };
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/index.ts"), "export default function extension() {}\n");
    await run(createRuntimeBuilder(config), root, config);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function previousOutput(root: string) {
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist/previous.ts"), "previous");
}

async function assertPrevious(root: string) {
  assert.deepEqual(await listFiles(join(root, "dist")), ["previous.ts"]);
  assert.equal(await readFile(join(root, "dist/previous.ts"), "utf8"), "previous");
  assert.deepEqual((await readdir(root)).sort(), ["dist", "src"]);
}

function metadata(): BuildMetadata {
  return {
    outputs: {
      "dist/index.ts": {
        entryPoint: "src/index.ts",
        inputs: { "src/index.ts": {} },
        imports: [{ path: "dist/chunks/eager.ts", kind: "import-statement" }],
      },
      "dist/chunks/eager.ts": {
        inputs: { "src/eager.ts": {} },
        imports: [
          { path: "dist/index.ts", kind: "import-statement" },
          { path: "dist/chunks/lazy.ts", kind: "dynamic-import" },
          { path: "external-package", kind: "import-statement", external: true },
        ],
      },
      "dist/chunks/lazy.ts": { inputs: { "src/lazy.ts": {} }, imports: [] },
    },
  };
}

test("shared eager traversal follows static cycles but not dynamic or external edges", async () => {
  await fixture(async (_builder, root, config) => {
    const builder = createRuntimeBuilder({ ...config, forbiddenEagerInputs: ["src/lazy.ts"] });
    assert.deepEqual([...builder.validateEagerGraph(metadata()).eagerInputs].sort(), [
      "/src/eager.ts",
      "/src/index.ts",
    ]);
    for (const absolute of [false, true]) {
      const graph = metadata();
      const eager = graph.outputs?.["dist/chunks/eager.ts"];
      assert.ok(eager);
      eager.inputs = { [absolute ? join(root, "src/lazy.ts") : ".\\src\\lazy.ts"]: {} };
      assert.throws(() => builder.validateEagerGraph(graph), /First-use implementation is eager/u);
    }
    const eagerExternal = createRuntimeBuilder({ ...config, forbiddenEagerExternals: ["external-package"] });
    assert.throws(() => eagerExternal.validateEagerGraph(metadata()), /Eager external dependency/u);
    assert.throws(() => builder.validateEagerGraph({}), /no src\/index.ts entrypoint/u);
    const bundled = metadata();
    const lazy = bundled.outputs?.["dist/chunks/lazy.ts"];
    assert.ok(lazy);
    lazy.inputs = { [join(root, "node_modules/dependency/index.ts")]: {} };
    assert.throws(() => builder.validateEagerGraph(bundled), /Bundled package input/u);
  });
});

test("shared validation inventories exact static, re-export, dynamic and require imports", async () => {
  await fixture(async (builder, root) => {
    const output = join(root, "dist");
    await mkdir(join(output, "chunks"), { recursive: true });
    await writeFile(join(output, "chunks/present.ts"), `${banner}\nexport const value = 1;`);
    await writeFile(join(output, "chunks/present.ts.map"), "{}");
    await writeFile(join(output, "index.ts.map"), "{}");
    const statements = [
      (path: string) => `import "${path}";`,
      (path: string) => `export { value } from "${path}";`,
      (path: string) => `export * from "${path}";`,
      (path: string) => `export const load = () => import("${path}");`,
      (path: string) => `export const load = () => require("${path}");`,
    ];
    for (const statement of statements) {
      await writeFile(join(output, "index.ts"), `${banner}\n${statement("./chunks/present.ts")}`);
      await builder.validateGeneratedFiles(output);
      for (const specifier of [
        "./chunks/missing.ts",
        "./chunks/present",
        "./chunks/present.js",
        "./chunks/present.mjs",
        "./chunks/present.ts.map",
        "./chunks",
        "../src/index.ts",
        "../outside.ts",
      ]) {
        await writeFile(join(output, "index.ts"), `${banner}\n${statement(specifier)}`);
        await assert.rejects(builder.validateGeneratedFiles(output), /no exact runtime target/u, statement(specifier));
      }
    }
    await writeFile(
      join(output, "index.ts"),
      `${banner}\nexport const text = './missing.ts'; // import './also-missing.ts'\n`,
    );
    await builder.validateGeneratedFiles(output);
  });
});

for (const scenario of ["marker", "map", "entry", "javascript", "symlink"] as const) {
  test(`shared validation rejects missing ${scenario} invariants`, async () => {
    await fixture(async (builder, root) => {
      const output = join(root, "dist");
      await builder.buildRuntime();
      if (scenario === "marker") await writeFile(join(output, "index.ts"), "export default 1;");
      if (scenario === "map") await rm(join(output, "index.ts.map"));
      if (scenario === "entry") await rm(join(output, "index.ts"));
      if (scenario === "javascript") await writeFile(join(output, "stale.js"), "stale");
      if (scenario === "symlink") await symlink(join(root, "src/index.ts"), join(output, "linked.ts"));
      await assert.rejects(builder.validateGeneratedFiles(output), /missing|retains a .js|non-regular/u);
    });
  });
}

for (const scenario of ["build", "graph", "files", "validation", "publication"] as const) {
  test(`shared ${scenario} failure cleans staging without replacing prior output`, async () => {
    await fixture(async (builder, root, config) => {
      await previousOutput(root);
      const fail = () => {
        throw new Error("injected failure");
      };
      if (scenario === "build") await writeFile(join(root, "src/index.ts"), "export {");
      if (scenario === "graph") builder = createRuntimeBuilder({ ...config, validateGraph: fail });
      if (scenario === "files") builder = createRuntimeBuilder({ ...config, validateFiles: async () => fail() });
      await assert.rejects(
        builder.buildRuntime({
          validateOutput:
            scenario === "validation"
              ? async () => fail()
              : scenario === "publication"
                ? async (staging) => {
                    await rm(staging, { recursive: true });
                  }
                : undefined,
        }),
      );
      await assertPrevious(root);
    });
  });
}

test("a per-build validation seam cannot bypass common validation", async () => {
  await fixture(async (_builder, root, config) => {
    await previousOutput(root);
    const builder = createRuntimeBuilder({ ...config, forbiddenEagerInputs: ["src/index.ts"] });
    let overrideCalled = false;
    await assert.rejects(
      builder.buildRuntime({
        validateOutput: async () => {
          overrideCalled = true;
        },
      }),
      /First-use implementation is eager/u,
    );
    assert.equal(overrideCalled, false);
    await assertPrevious(root);
  });
});

for (const scenario of ["backup", "first-publication", "restoration"] as const) {
  test(`shared publication handles ${scenario} rename failure`, async () => {
    await fixture(async (builder, root) => {
      if (scenario !== "first-publication") await previousOutput(root);
      const staging = join(root, ".runtime-dist-fixture");
      await mkdir(staging);
      await writeFile(join(staging, "next.ts"), "next");
      let calls = 0;
      await assert.rejects(
        builder.publishRuntime(staging, join(root, "dist"), {
          renamePath: async (source, destination) => {
            calls++;
            if (scenario !== "restoration" || calls >= 2) throw new Error(`injected rename ${calls}`);
            await rename(source, destination);
          },
        }),
        scenario === "restoration" ? /restoration failed; previous output is in/u : /injected rename/u,
      );
      assert.equal(await readFile(join(staging, "next.ts"), "utf8"), "next");
      if (scenario === "backup") assert.equal(await readFile(join(root, "dist/previous.ts"), "utf8"), "previous");
      if (scenario === "first-publication") assert.equal((await readdir(root)).includes("dist"), false);
      if (scenario === "restoration") {
        const backup = (await readdir(root)).find((name) => name.startsWith("dist.backup-"));
        assert.ok(backup);
        assert.equal(await readFile(join(root, backup, "previous.ts"), "utf8"), "previous");
      }
    });
  });
}

test("output symlinks, including broken links, are rejected without touching targets", async () => {
  await fixture(async (builder, root) => {
    for (const target of [join(root, "src"), join(root, "absent")]) {
      await symlink(target, join(root, "dist"), "dir");
      await assert.rejects(builder.buildRuntime(), /must not be a symlink/u);
      await rm(join(root, "dist"));
    }
    assert.equal(await readFile(join(root, "src/index.ts"), "utf8"), "export default function extension() {}\n");
    await builder.buildRuntime();
    await assert.rejects(builder.publishRuntime(join(root, "dist"), join(root, "dist")), /must differ/u);
  });
});

test("publication rejects unowned, nested and symlink staging paths", async () => {
  await fixture(async (builder, root) => {
    await previousOutput(root);
    for (const staging of [join(root, "src"), join(root, ".runtime-dist-parent/nested")]) {
      await assert.rejects(builder.publishRuntime(staging, join(root, "dist")), /build-owned sibling/u);
      await assertPrevious(root);
    }
    const linked = join(root, ".runtime-dist-linked");
    await symlink(join(root, "src"), linked, "dir");
    await assert.rejects(
      builder.publishRuntime(linked, join(root, "dist")),
      /staging directory must not be a symlink/u,
    );
    await rm(linked);
    await assertPrevious(root);
    assert.equal(await readFile(join(root, "src/index.ts"), "utf8"), "export default function extension() {}\n");
  });
});

test("publication revalidates output ownership after asynchronous validation", async () => {
  await fixture(async (builder, root) => {
    await assert.rejects(
      builder.buildRuntime({
        validateOutput: async () => {
          await symlink(join(root, "src"), join(root, "dist"), "dir");
        },
      }),
      /must not be a symlink/u,
    );
    assert.equal(await readFile(join(root, "src/index.ts"), "utf8"), "export default function extension() {}\n");
    assert.deepEqual((await readdir(root)).sort(), ["dist", "src"]);
  });
});
