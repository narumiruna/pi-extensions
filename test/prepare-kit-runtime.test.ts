import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";

const builderUrl = pathToFileURL(resolve("scripts/prepare-kit-runtime.mjs")).href;
const { prepareKitRuntime } = (await import(builderUrl)) as {
  prepareKitRuntime(
    packageRoot: string,
    operations?: { renamePath?: (source: string, destination: string) => Promise<void> },
  ): Promise<void>;
};

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "prepare-kit-"));
  try {
    await mkdir(join(root, "src/nested"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(join(root, "src/index.ts"), "export const value: number = 1;");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function inventory(directory: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const file = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await inventory(directory, file));
    else result[file.replaceAll("\\", "/")] = await readFile(join(directory, file), "utf8");
  }
  return result;
}

async function previousOutput(root: string) {
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist/previous.js"), "previous");
}

async function assertPrevious(root: string) {
  assert.deepEqual(await inventory(join(root, "dist")), { "previous.js": "previous" });
  assert.deepEqual((await readdir(root)).sort(), ["dist", "package.json", "src"]);
}

test("Git Kit preparation preserves exact paths, maps, external imports and lazy evaluation without declarations", async () => {
  await fixture(async (root) => {
    await writeFile(
      join(root, "src/index.ts"),
      'export { value } from "./nested/value.js"; export const load = () => import("./nested/lazy.js");',
    );
    await writeFile(
      join(root, "src/nested/value.ts"),
      'import { basename } from "node:path"; export const value = basename("ready");',
    );
    await writeFile(
      join(root, "src/nested/lazy.ts"),
      'import { writeFileSync } from "node:fs"; writeFileSync(new URL("../../lazy-loaded", import.meta.url), "loaded"); export const value = 42;',
    );
    await writeFile(join(root, "src/ignored.d.ts"), "deliberately invalid declaration input {");
    await prepareKitRuntime(root);
    const first = await inventory(join(root, "dist"));
    assert.deepEqual(Object.keys(first).sort(), [
      "index.js",
      "index.js.map",
      "nested/lazy.js",
      "nested/lazy.js.map",
      "nested/value.js",
      "nested/value.js.map",
    ]);
    assert.match(first["index.js"] ?? "", /import\("\.\/nested\/lazy\.js"\)/u);
    assert.match(first["nested/value.js"] ?? "", /from "node:path"/u);
    await writeFile(join(root, "dist/stale.js"), "stale");
    await prepareKitRuntime(root);
    assert.deepEqual(await inventory(join(root, "dist")), first);
    const runtimeUrl = pathToFileURL(join(root, "dist/index.js")).href;
    const runtime = await import(runtimeUrl);
    assert.equal(runtime.value, "ready");
    assert.equal(existsSync(join(root, "lazy-loaded")), false);
    assert.equal((await runtime.load()).value, 42);
    assert.equal(await readFile(join(root, "lazy-loaded"), "utf8"), "loaded");
  });
});

for (const [name, statement] of [
  ["static import", (specifier: string) => `import "${specifier}";`],
  ["named re-export", (specifier: string) => `export { value } from "${specifier}";`],
  ["star re-export", (specifier: string) => `export * from "${specifier}";`],
  ["dynamic import", (specifier: string) => `export const load = () => import("${specifier}");`],
] as const) {
  test(`Kit preparation validates every emitted ${name} against an exact JavaScript target`, async () => {
    await fixture(async (root) => {
      await writeFile(join(root, "src/nested/value.ts"), "export const value = 1;");
      await writeFile(join(root, "src/index.ts"), statement("./nested/value.js"));
      await prepareKitRuntime(root);
      const previous = await inventory(join(root, "dist"));
      for (const specifier of [
        "./nested/missing.js",
        "./nested/value.ts",
        "./nested/value",
        "./nested",
        "../src/index.js",
      ]) {
        await writeFile(join(root, "src/index.ts"), statement(specifier));
        await assert.rejects(prepareKitRuntime(root), /no exact runtime target/u, specifier);
        assert.deepEqual(await inventory(join(root, "dist")), previous);
        assert.deepEqual((await readdir(root)).sort(), ["dist", "package.json", "src"]);
      }
      await writeFile(
        join(root, "src/index.ts"),
        'export const text = "import(\'./missing.js\')"; // import "./also-missing.js"',
      );
      await prepareKitRuntime(root);
    });
  });
}

test("Kit compilation failure preserves the prior output and removes staging", async () => {
  await fixture(async (root) => {
    await previousOutput(root);
    await writeFile(join(root, "src/index.ts"), "export {");
    await assert.rejects(prepareKitRuntime(root), /Expected identifier/u);
    await assertPrevious(root);
  });
});

for (const failure of ["backup", "publication", "first-publication", "restoration"] as const) {
  test(`Kit preparation recovers from ${failure} failure without partial publication`, async () => {
    await fixture(async (root) => {
      if (failure !== "first-publication") await previousOutput(root);
      let calls = 0;
      let backup = "";
      await assert.rejects(
        prepareKitRuntime(root, {
          renamePath: async (source, destination) => {
            calls++;
            if (calls === 1) backup = destination;
            if (
              failure === "backup" ||
              failure === "first-publication" ||
              (calls >= 2 && (failure === "restoration" || calls === 2))
            ) {
              throw new Error("injected rename failure");
            }
            await rename(source, destination);
          },
        }),
        failure === "restoration" ? /restoration failed; previous output is in/u : /injected rename failure/u,
      );
      if (failure === "restoration") {
        assert.deepEqual(await inventory(backup), { "previous.js": "previous" });
        assert.equal(existsSync(join(root, "dist")), false);
        assert.deepEqual((await readdir(root)).sort(), [backup.slice(root.length + 1), "package.json", "src"].sort());
      } else if (failure === "first-publication") {
        assert.deepEqual((await readdir(root)).sort(), ["package.json", "src"]);
      } else await assertPrevious(root);
    });
  });
}

for (const kind of ["file", "symlink", "dangling symlink"] as const) {
  test(`Kit preparation rejects ${kind} output without changing its target`, async () => {
    await fixture(async (root) => {
      const output = join(root, "dist");
      if (kind === "file") await writeFile(output, "previous");
      else await symlink(join(root, kind === "symlink" ? "src" : "absent"), output, "dir");
      await assert.rejects(prepareKitRuntime(root), /real directory, not a symlink or file/u);
      assert.equal(await readFile(join(root, "src/index.ts"), "utf8"), "export const value: number = 1;");
      assert.deepEqual((await readdir(root)).sort(), ["dist", "package.json", "src"]);
    });
  });
}

test("clean production Git preparation loads root-listed Edit Scope source and its lazy menu through native Jiti", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "prepare-git-production-"));
  try {
    for (const packageId of ["pi-tui-kit", "pi-edit-scope"]) {
      const target = join(checkout, "packages", packageId);
      await mkdir(target, { recursive: true });
      await copyFile(resolve("packages", packageId, "package.json"), join(target, "package.json"));
      await cp(resolve("packages", packageId, "src"), join(target, "src"), { recursive: true });
    }
    for (const file of [
      "package.json",
      "scripts/prepare.mjs",
      "scripts/prepare-kit-runtime.mjs",
      ".husky/install.mjs",
      "packages/pi-inspect/scripts/build.mjs",
    ]) {
      await mkdir(dirname(join(checkout, file)), { recursive: true });
      await copyFile(resolve(file), join(checkout, file));
    }
    await mkdir(join(checkout, "packages/pi-inspect/src/web"), { recursive: true });
    await writeFile(
      join(checkout, "packages/pi-inspect/src/web/app.tsx"),
      'import "./app.css"; console.log("production");',
    );
    await writeFile(join(checkout, "packages/pi-inspect/src/web/app.css"), "body { color: red; }");
    const rootManifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
    const kitManifest = JSON.parse(await readFile(resolve("packages/pi-tui-kit/package.json"), "utf8"));
    const scopeManifest = JSON.parse(await readFile(resolve("packages/pi-edit-scope/package.json"), "utf8"));
    const dependencies = new Set([
      ...Object.keys(rootManifest.dependencies),
      ...Object.keys(kitManifest.dependencies),
      ...Object.keys(kitManifest.peerDependencies),
      ...Object.keys(scopeManifest.peerDependencies),
    ]);
    for (const name of dependencies) {
      const target = join(checkout, "node_modules", name);
      await mkdir(dirname(target), { recursive: true });
      await symlink(resolve("node_modules", name), target, "dir");
    }
    const kit = join(checkout, "packages/pi-tui-kit");
    const kitLink = join(checkout, "node_modules/@narumitw/pi-tui-kit");
    await mkdir(dirname(kitLink), { recursive: true });
    await symlink(kit, kitLink, "dir");
    assert.equal(existsSync(join(kit, "dist")), false);
    assert.equal(existsSync(join(kit, "scripts")), false, "the production fixture has no TypeScript build script");
    const result = spawnSync(process.execPath, ["scripts/prepare.mjs"], {
      cwd: checkout,
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "production" },
    });
    assert.equal(result.status, 0, result.stderr);
    const generated = await inventory(join(kit, "dist"));
    assert.ok(generated["index.js"]);
    assert.equal(
      Object.keys(generated).some((file) => file.endsWith(".ts")),
      false,
    );
    assert.ok(existsSync(join(checkout, "packages/pi-inspect/browser-dist/app.js")));
    await writeFile(join(checkout, "smoke.mjs"), productionSmoke);
    const evidence = await runSmoke(checkout);
    assert.match(evidence, /PASS clean Git source, lazy menu, Kit lazy questionnaire, lifecycle/u);
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
});

function runSmoke(checkout: string): Promise<string> {
  return new Promise((resolveSmoke, reject) => {
    const child = spawn(process.execPath, ["smoke.mjs"], {
      cwd: checkout,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PI_CODING_AGENT_DIR: join(checkout, "agent"),
        JITI_FS_CACHE: "false",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let output = "";
    let deadline: ReturnType<typeof setTimeout> | undefined;
    assert.ok(child.stdout && child.stderr);
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    child.on("message", (message) => {
      if ((message as { type?: string })?.type !== "ready" || deadline) return;
      deadline = setTimeout(() => child.kill("SIGKILL"), 4000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(deadline);
      if (code === 0 && deadline) resolveSmoke(output);
      else reject(new Error(`Production Git Jiti smoke failed (${code}): ${output}`));
    });
  });
}

const productionSmoke = String.raw`
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
process.send?.({ type: "ready" });
const require = createRequire(import.meta.url);
for (const tool of ["typescript", "@biomejs/biome", "vitest", "husky"]) {
  assert.throws(() => require.resolve(tool), { code: "MODULE_NOT_FOUND" }, tool);
}
assert.ok(require.resolve("esbuild"));
await mkdir(process.env.PI_CODING_AGENT_DIR);
const sdk = await import("@earendil-works/pi-coding-agent");
sdk.initTheme("dark", false);
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const entry = manifest.pi.extensions.find((file) => file === "./packages/pi-edit-scope/src/index.ts");
assert.ok(entry);
const loader = new sdk.DefaultResourceLoader({
  cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
  settingsManager: sdk.SettingsManager.inMemory({}),
  additionalExtensionPaths: [join(process.cwd(), entry)],
});
await loader.reload();
const loaded = loader.getExtensions();
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
const extension = loaded.extensions[0];
assert.deepEqual([...extension.commands.keys()], ["edit-scope", "scope"]);
assert.equal(extension.tools.size, 0);
assert.equal(extension.path, join(process.cwd(), entry));
const { createTuiHarness } = await import("@narumitw/pi-tui-kit/testing");
const { runQuestionnaire } = await import("@narumitw/pi-tui-kit");
const harness = createTuiHarness();
const notices = [];
const ctx = {
  cwd: process.cwd(), mode: "tui", hasUI: true,
  isIdle: () => true, hasPendingMessages: () => false, isProjectTrusted: () => false,
  sessionManager: { getBranch: () => [], getEntries: () => [], getSessionId: () => "production-git" },
  // Geometry is exercised by native package host tests; this harness verifies the lazy artifact.
  ui: { custom: (factory) => harness.custom(factory), notify: (message, type) => notices.push({ message, type }), setWidget() {} },
};
const emit = async (type) => {
  for (const handler of extension.handlers.get(type) ?? []) await handler({ type, reason: "startup" }, ctx);
};
try {
  await emit("session_start");
  const menu = extension.commands.get("edit-scope").handler("", ctx);
  await Promise.race([harness.waitForOpen(), menu.then(() => { throw new Error("Menu closed before opening"); })]);
  const frame = harness.render().join("\n");
  harness.send("\x03");
  await menu;
  assert.match(frame, /Edit Scope/u);
  assert.equal(harness.isOpen, false);
  const questionnaire = runQuestionnaire(ctx, {
    questions: [{ id: "proof", header: "Lazy", prompt: "Generated lazy boundary", options: [{ label: "Ready" }] }],
  });
  await Promise.race([harness.waitForOpen(), questionnaire.then(() => { throw new Error("Questionnaire closed before opening"); })]);
  const questionFrame = harness.render().join("\n");
  harness.send("\x03");
  assert.equal((await questionnaire).kind, "closed");
  assert.match(questionFrame, /Generated lazy boundary/u);
  assert.deepEqual(notices, []);
  assert.equal(existsSync(join(process.env.PI_CODING_AGENT_DIR, "pi-scope.json")), false);
} finally {
  harness.dispose();
  await emit("session_shutdown");
  loaded.runtime.invalidate("production Git smoke complete");
}
console.log("PASS clean Git source, lazy menu, Kit lazy questionnaire, lifecycle");
`;
