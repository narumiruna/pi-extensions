import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, test } from "vitest";

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

describe("clean production Git preparation", () => {
  let smoke: ReturnType<typeof runSmoke>;
  let service: ReturnType<typeof startProductionDaemon>;

  beforeEach(async ({ onTestFinished }) => {
    const checkout = await mkdtemp(join(tmpdir(), "prepare-git-production-"));
    let ownedSmoke: ReturnType<typeof runSmoke> | undefined;
    let ownedDaemon: ReturnType<typeof startProductionDaemon> | undefined;
    onTestFinished(async () => {
      try {
        await ownedSmoke?.dispose();
      } finally {
        try {
          await ownedDaemon?.dispose();
        } finally {
          await rm(checkout, { recursive: true, force: true });
        }
      }
    });
    for (const packageId of ["pi-tui-kit", "pi-files", "pi-sync-daemon", "pi-sync"]) {
      const target = join(checkout, "packages", packageId);
      await mkdir(target, { recursive: true });
      await copyFile(resolve("packages", packageId, "package.json"), join(target, "package.json"));
      await cp(resolve("packages", packageId, "src"), join(target, "src"), { recursive: true });
    }
    for (const file of [
      "package.json",
      "scripts/prepare.mjs",
      "scripts/prepare-kit-runtime.mjs",
      "scripts/prepare-workspace-runtime.mjs",
      "scripts/prepare-daemon-runtime.mjs",
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
    const filesManifest = JSON.parse(await readFile(resolve("packages/pi-files/package.json"), "utf8"));
    const daemonManifest = JSON.parse(await readFile(resolve("packages/pi-sync-daemon/package.json"), "utf8"));
    const syncManifest = JSON.parse(await readFile(resolve("packages/pi-sync/package.json"), "utf8"));
    const source = await inventory(resolve("packages/pi-files/src"));
    assert.deepEqual(await inventory(join(checkout, "packages/pi-files/src")), source);
    for (const file of ["index.ts", "files.ts", "file-context.ts", "scope/edit-scope.ts", "scope/picker.ts"]) {
      assert.ok(Object.hasOwn(source, file), `production fixture must include ${file}`);
    }
    assert.equal(existsSync(join(checkout, "packages/pi-files/dist")), false);
    const dependencies = new Set([
      ...Object.keys(rootManifest.dependencies),
      ...Object.keys(kitManifest.dependencies),
      ...Object.keys(kitManifest.peerDependencies),
      ...Object.keys(filesManifest.dependencies).filter((name) => name !== "@narumitw/pi-tui-kit"),
      ...Object.keys(filesManifest.peerDependencies),
      ...Object.keys(daemonManifest.dependencies),
      ...Object.keys(syncManifest.peerDependencies),
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
    const daemon = join(checkout, "packages/pi-sync-daemon");
    await symlink(daemon, join(checkout, "node_modules", daemonManifest.name), "dir");
    for (const name of Object.keys(daemonManifest.dependencies)) {
      const nested = resolve("packages/pi-sync-daemon/node_modules", name);
      const target = join(daemon, "node_modules", name);
      await mkdir(dirname(target), { recursive: true });
      await symlink(existsSync(nested) ? nested : resolve("node_modules", name), target, "dir");
    }
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
    assert.ok(existsSync(join(daemon, "dist/index.js")));
    assert.ok(existsSync(join(daemon, "dist/cli.js")));
    assert.equal(existsSync(join(daemon, "dist/index.d.ts")), false);
    assert.equal(
      Object.keys(generated).some((file) => file.endsWith(".ts")),
      false,
    );
    assert.ok(existsSync(join(checkout, "packages/pi-inspect/browser-dist/app.js")));
    await writeFile(join(checkout, "smoke.mjs"), productionSmoke);
    ownedSmoke = smoke = runSmoke(checkout);
    await smoke.ready;
    // Own the foreground service directly, including when the smoke child times out.
    ownedDaemon = service = startProductionDaemon(checkout);
    await service.ready;
  });

  test("loads root-listed Files source and its lazy menus through native Jiti", async () => {
    const evidence = await smoke.run(service.pid);
    assert.match(evidence, /PASS clean Git source, merged commands, lazy menus, Kit lazy questionnaire, lifecycle/u);
  });
});

function runSmoke(checkout: string) {
  let markReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolveReady, reject) => {
    markReady = resolveReady;
    rejectReady = reject;
  });
  let isReady = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let child!: ReturnType<typeof spawn>;
  let joinChild!: Promise<void>;
  const completion = new Promise<string>((resolveSmoke, reject) => {
    child = spawn(process.execPath, ["smoke.mjs"], {
      cwd: checkout,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PI_CODING_AGENT_DIR: join(checkout, "agent"),
        JITI_FS_CACHE: "false",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    joinChild = new Promise((done) => child.once("close", () => done()));
    let output = "";
    assert.ok(child.stdout && child.stderr);
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    child.on("message", (message) => {
      if ((message as { type?: string })?.type !== "ready" || isReady) return;
      isReady = true;
      markReady();
    });
    child.once("error", (error) => {
      rejectReady(error);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      if (code === 0 && deadline) resolveSmoke(output);
      else {
        const error = new Error(`Production Git Jiti smoke failed (${code}): ${output}`);
        rejectReady(error);
        reject(error);
      }
    });
  });
  // Setup owns the child even if SDK initialization fails before readiness.
  void completion.catch(() => {});
  return {
    ready,
    run: async (daemonPID: number) => {
      await ready;
      deadline = setTimeout(() => child.kill("SIGKILL"), 4000);
      child.send({ type: "run", daemonPID });
      return completion;
    },
    dispose: async () => {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await joinChild;
      await completion.catch(() => {});
    },
  };
}

function startProductionDaemon(checkout: string) {
  const child = spawn(
    process.execPath,
    ["packages/pi-sync-daemon/dist/cli.js", "serve", "--root", join(checkout, "agent")],
    {
      cwd: checkout,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let started = false;
  let failure = "";
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.stderr?.on("data", (value) => {
    failure = (failure + String(value)).slice(-4096);
  });
  child.once("error", rejectReady);
  child.on("message", (message) => {
    if ((message as { type?: string })?.type === "ready") {
      started = true;
      resolveReady();
    }
  });
  const closed = new Promise<void>((done) =>
    child.once("close", (code) => {
      if (!started) rejectReady(new Error(`Production daemon startup failed (${code}): ${failure}`));
      done();
    }),
  );
  return {
    get pid() {
      const pid = child.pid;
      assert.ok(pid);
      return pid;
    },
    ready,
    async dispose() {
      if (child.exitCode !== null || child.signalCode !== null) {
        await closed;
        return;
      }
      child.kill("SIGTERM");
      // Readiness was observed before any bounded graceful-shutdown deadline starts.
      const deadline = started ? setTimeout(() => child.kill("SIGKILL"), 1000) : undefined;
      try {
        await closed;
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}

const productionSmoke = String.raw`
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
const require = createRequire(import.meta.url);
await mkdir(process.env.PI_CODING_AGENT_DIR);
const sdk = await import("@earendil-works/pi-coding-agent");
sdk.initTheme("dark", false);
// SDK cold startup belongs to setup; operations start only when the test releases us.
const run = await new Promise((resolve) => {
  process.once("message", resolve);
  process.send?.({ type: "ready" });
});
assert.equal(run.type, "run");
process.disconnect?.();
for (const tool of ["typescript", "tsc-rs", "@biomejs/biome", "vitest"]) {
  assert.throws(() => require.resolve(tool), { code: "MODULE_NOT_FOUND" }, tool);
}
assert.ok(require.resolve("esbuild"));
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const entries = manifest.pi.extensions.filter((file) => /\/pi-(?:files|file-context|edit-scope)\//u.test(file));
assert.deepEqual(entries, ["./packages/pi-files/src/index.ts"]);
const [entry] = entries;
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
assert.deepEqual([...extension.commands.keys()].sort(), ["edit-scope", "file-context", "files", "scope"]);
for (const type of ["tool_call", "context_with_system", "session_start", "session_shutdown"]) {
  assert.ok(extension.handlers.has(type), type);
}
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
  ui: { custom: (factory) => harness.custom(factory), notify: (message, type) => notices.push({ message, type }), setWidget() {}, setStatus() {} },
};
const emit = async (type) => {
  for (const handler of extension.handlers.get(type) ?? []) await handler({ type, reason: "startup" }, ctx);
};
try {
  await emit("session_start");
  for (const [name, title] of [["files", /Files/u], ["scope", /Edit Scope/u]]) {
    const menu = extension.commands.get(name).handler("", ctx);
    await Promise.race([harness.waitForOpen(), menu.then(() => { throw new Error("Menu closed before opening"); })]);
    const frame = harness.render().join("\n");
    harness.send("\x03");
    await menu;
    assert.match(frame, title);
    assert.equal(harness.isOpen, false);
  }
  const questionnaire = runQuestionnaire(ctx, {
    questions: [{ id: "proof", header: "Lazy", prompt: "Generated lazy boundary", options: [{ label: "Ready" }] }],
  });
  await Promise.race([harness.waitForOpen(), questionnaire.then(() => { throw new Error("Questionnaire closed before opening"); })]);
  const questionFrame = harness.render().join("\n");
  harness.send("\x03");
  assert.equal((await questionnaire).kind, "closed");
  assert.match(questionFrame, /Generated lazy boundary/u);
  assert.deepEqual(notices, []);
  for (const file of ["pi-file-context.json", "pi-scope.json", "pi-files.json"]) {
    assert.equal(existsSync(join(process.env.PI_CODING_AGENT_DIR, file)), false, file);
  }
} finally {
  harness.dispose();
  await emit("session_shutdown");
  loaded.runtime.invalidate("production Git smoke complete");
}
const syncEntry = manifest.pi.extensions.find(file => file === "./packages/pi-sync/src/index.ts");
assert.ok(syncEntry);
const syncLoader = new sdk.DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: sdk.SettingsManager.inMemory({}), additionalExtensionPaths: [join(process.cwd(), syncEntry)] });
await syncLoader.reload(); const syncLoaded = syncLoader.getExtensions(); assert.deepEqual(syncLoaded.errors, []);
const syncExtension = syncLoaded.extensions[0]; assert.ok(syncExtension);
const syncNotices=[]; const syncCtx={...ctx, mode:"rpc", sessionManager:{getSessionId:()=>"production-sync"}, ui:{...ctx.ui,notify:message=>syncNotices.push(message)}};
try {
  for(const handler of syncExtension.handlers.get("session_start")??[]) await handler({type:"session_start",reason:"startup"},syncCtx);
  await syncExtension.commands.get("sync").handler("help",syncCtx);
  assert.ok(syncNotices.some(message=>message.includes("daemon [")));
  const api=await import("@narumitw/pi-sync-daemon");
  assert.equal((await api.findDaemon(process.env.PI_CODING_AGENT_DIR)).identity.pid,run.daemonPID);
  const owner=await api.ensureDaemon(process.env.PI_CODING_AGENT_DIR);
  try {
    assert.equal(owner.identity.pid,run.daemonPID);
    assert.equal((await api.findDaemon(process.env.PI_CODING_AGENT_DIR)).identity.instance,owner.identity.instance);
  }
  finally { await api.stopDaemon(process.env.PI_CODING_AGENT_DIR); }
} finally {
  for(const handler of syncExtension.handlers.get("session_shutdown")??[]) await handler({type:"session_shutdown",reason:"reload"},syncCtx);
  syncLoaded.runtime.invalidate("production sync Git smoke complete");
}
console.log("PASS clean Git source, merged commands, lazy menus, Kit lazy questionnaire, lifecycle, Sync source and daemon JavaScript without dev tools");
`;
