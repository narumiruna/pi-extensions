// Manual artifact verification. Run: node test/fullscreen-handoff-artifact-smoke.mjs
// Uses existing dist output; never builds, publishes, or loads workspace implementation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const external = await mkdtemp(join(tmpdir(), "fullscreen-handoff-artifact-"));
const artifacts = join(external, "artifacts");
const project = join(external, "consumer");
await mkdir(artifacts);
await mkdir(project);
console.log(`Evidence retained at ${external}`);
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
function command(file, args, cwd) {
  console.log(`$ (cd ${cwd} && ${file} ${args.join(" ")})`);
  try {
    return execFileSync(file, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    // Preserve complete compiler/npm diagnostics, without environment or credential dumps.
    if (error.stdout) process.stderr.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  }
}
const packages = [];
const dependencies = {};
const peers = new Set(["@earendil-works/pi-ai"]);
for (const id of ["pi-tui-kit", "pi-starship", "pi-btw"]) {
  const source = join(root, "packages", id);
  const manifest = await json(join(source, "package.json"));
  const [packed] = JSON.parse(
    command("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", artifacts], source),
  );
  const tarball = join(artifacts, packed.filename);
  const paths = new Set(
    command("tar", ["-tzf", tarball], external)
      .trim()
      .split("\n")
      .map((path) => path.replace(/^package\//u, "")),
  );
  const archived = JSON.parse(command("tar", ["-xOf", tarball, "package/package.json"], external));
  assert.deepEqual(archived, manifest);
  for (const path of paths) {
    assert.ok(
      path === "package.json" || manifest.files.some((entry) => path === entry || path.startsWith(`${entry}/`)),
      `Undeclared packed path: ${id}/${path}`,
    );
  }
  for (const entry of manifest.files)
    assert.ok(
      [...paths].some((path) => path === entry || path.startsWith(`${entry}/`)),
      `Missing files declaration: ${id}/${entry}`,
    );
  for (const entry of manifest.pi?.extensions ?? []) assert.ok(paths.has(entry.replace(/^\.\//u, "")));
  if (id === "pi-tui-kit") {
    for (const entry of Object.values(manifest.exports)) {
      for (const target of Object.values(entry))
        assert.ok(paths.has(target.replace(/^\.\//u, "")), `Missing export: ${target}`);
    }
    assert.ok(manifest.exports["./fullscreen-handoff"]);
    for (const target of Object.values(manifest.exports["./fullscreen-handoff"])) {
      const contents = command("tar", ["-xOf", tarball, `package/${target.replace(/^\.\//u, "")}`], external);
      assert.match(contents, /createFullscreenHandoff/u);
    }
  }
  const evidence = {
    name: manifest.name,
    version: manifest.version,
    integrity: packed.integrity,
    tarball,
    files: [...paths].sort(),
  };
  packages.push(evidence);
  dependencies[manifest.name] = `file:${tarball}`;
  for (const peer of Object.keys(manifest.peerDependencies ?? {})) peers.add(peer);
}
for (const name of [...peers, "@types/node"]) {
  dependencies[name] = (await json(join(root, "node_modules", name, "package.json"))).version;
}
await writeFile(
  join(project, "package.json"),
  JSON.stringify({ name: "fullscreen-artifact-consumer", private: true, type: "module", dependencies }, null, 2),
);
await writeFile(join(external, "artifact-evidence.json"), JSON.stringify({ packages, dependencies }, null, 2));
const installArgs = ["install", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"];
try {
  process.stdout.write(command("npm", installArgs, project));
} catch (error) {
  const diagnostics = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
  if (!/ENOTCACHED|cache mode is 'only-if-cached'|cache miss/iu.test(diagnostics)) throw error;
  const reason =
    "Offline npm cache unavailable; registry install permitted for dependencies only. Exact local package tarballs remain pinned.";
  console.log(reason);
  await writeFile(join(external, "registry-fallback.txt"), `${reason}\n${diagnostics}`);
  process.stdout.write(
    command(
      "npm",
      installArgs.filter((arg) => arg !== "--offline"),
      project,
    ),
  );
}
for (const artifact of packages) {
  const installed = join(project, "node_modules", artifact.name);
  assert.equal(await realpath(installed), installed, "Local tarballs must not become workspace links");
  const manifest = await json(join(installed, "package.json"));
  assert.equal(manifest.name, artifact.name);
  assert.equal(manifest.version, artifact.version);
  if (artifact.name !== "@narumitw/pi-tui-kit") {
    const consumerRequire = createRequire(join(installed, "package.json"));
    const kitRoot = consumerRequire.resolve
      .paths("@narumitw/pi-tui-kit")
      .map((path) => join(path, "@narumitw/pi-tui-kit"))
      .find((path) => existsSync(join(path, "package.json")));
    assert.equal(await realpath(kitRoot), join(project, "node_modules/@narumitw/pi-tui-kit"));
  }
}
await writeFile(
  join(project, "consumer.ts"),
  `
import { createFullscreenHandoff as rootFactory, type FullscreenHandoff as RootHandoff, type FullscreenHandoffOptions as RootOptions } from '@narumitw/pi-tui-kit';
import { createFullscreenHandoff, type FullscreenHandoff, type FullscreenHandoffOptions } from '@narumitw/pi-tui-kit/fullscreen-handoff';
import { TuiMainScreen, TuiAltScreen, type Terminal } from '@earendil-works/pi-tui';
declare const terminal: Terminal;
const parent = new TuiMainScreen(terminal);
const options: FullscreenHandoffOptions = { isCurrent: () => true, canRestoreParent: () => true };
const rootOptions: RootOptions = options;
const focused: FullscreenHandoff<TuiAltScreen> = createFullscreenHandoff(parent, options);
const root: RootHandoff<TuiAltScreen> = rootFactory(parent, rootOptions);
const same: typeof root = focused;
void same;
void focused.enter(() => new TuiAltScreen(terminal));
// @ts-expect-error Child creation must be synchronous.
void focused.enter(async () => new TuiAltScreen(terminal));
// @ts-expect-error The root export must also reject asynchronous child creation.
void root.enter(async () => new TuiAltScreen(terminal));
`,
);
await writeFile(
  join(project, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        strict: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2024",
        noEmit: true,
        types: ["node"],
        skipLibCheck: true,
      },
      files: ["consumer.ts"],
    },
    null,
    2,
  ),
);
// Pi 1.3.0 has unrelated declaration errors (JSON attributes, PlatformPath, optional MCP).
// Check the strict consumer contract, not third-party declaration internals.
console.log("Typecheck limit: skipLibCheck=true; strict consumer and negative factory tests remain enabled.");
process.stdout.write(
  command(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "-p", join(project, "tsconfig.json")],
    project,
  ),
);
await writeFile(
  join(project, "runtime.mjs"),
  `import assert from 'node:assert/strict';\nimport { join } from 'node:path';\nimport { mkdir } from 'node:fs/promises';\nawait (${runtimeProof.toString()})();\n`,
);
process.stdout.write(command(process.execPath, [join(project, "runtime.mjs")], project));
console.log(
  JSON.stringify(
    {
      result: "PASS",
      evidence: external,
      packages: packages.map(({ files, ...identity }) => identity),
      peers: dependencies,
    },
    null,
    2,
  ),
);

async function runtimeProof() {
  // This function executes outside the repository. Every implementation import is installed.
  process.env.PI_CODING_AGENT_DIR = join(process.cwd(), "agent");
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  const sdk = await import("@earendil-works/pi-coding-agent");
  const tui = await import("@earendil-works/pi-tui");
  const kit = await import("@narumitw/pi-tui-kit");
  const focused = await import("@narumitw/pi-tui-kit/fullscreen-handoff");
  const { FullscreenTerminal } = await import("@narumitw/pi-tui-kit/testing");
  assert.equal(kit.createFullscreenHandoff, focused.createFullscreenHandoff);
  sdk.initTheme("dark", false);
  const theme = {
    fg: (_role, text) => text,
    bg: (_role, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    underline: (text) => text,
  };
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  async function until(predicate, label) {
    for (let attempt = 0; attempt < 10000; attempt++) {
      if (predicate()) return;
      await turn();
    }
    throw new Error(`Readiness not reached: ${label}`);
  }
  function gate() {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  for (const mode of ["regular", "fullscreen"]) {
    const terminal = new FullscreenTerminal();
    const parent = mode === "regular" ? new tui.TuiMainScreen(terminal) : new tui.TuiAltScreen(terminal);
    const input = new tui.Input();
    const history = new tui.ScrollView(
      { render: () => Array(100).fill("history"), invalidate() {} },
      { primary: true, follow: "end" },
    );
    if (mode === "fullscreen")
      parent.setLayoutRoot(new tui.VStack([{ component: history, basis: 0, grow: 1, minSize: 1 }, input]));
    else parent.addChild(input);
    parent.setFocus(input);
    parent.start();
    const handoff = focused.createFullscreenHandoff(parent);
    try {
      let entering;
      parent.addInputListener((data) => {
        if (data !== "open") return;
        entering = handoff.enter(() => new tui.TuiAltScreen(terminal));
        return { consume: true };
      });
      terminal.input("open");
      const child = await entering;
      assert.ok(child instanceof tui.TuiAltScreen);
      let childInput = 0;
      let restoring;
      child.addInputListener((data) => {
        childInput++;
        if (data !== "close") return;
        restoring = handoff.restore();
        return { consume: true };
      });
      terminal.input("close");
      await restoring;
      await handoff.restore();
      terminal.input("z");
      assert.equal(input.getValue(), "z");
      if (mode === "fullscreen") {
        parent.renderNow();
        const before = history.scrollTop;
        assert.ok(before > 0);
        terminal.input("\x1b[5~");
        assert.ok(history.scrollTop < before);
      }
      assert.equal(childInput, 1);
      assert.deepEqual(
        terminal.events.map(({ name }) => name),
        ["start", "drain", "stop", "start", "drain", "stop", "start"],
      );
      assert.ok(terminal.events.every(({ depth }) => depth === 0));
    } finally {
      await handoff.restore();
      parent.stop({ preserveScreen: true });
    }
    console.log(`PASS isolated focused handoff: ${mode} parent, restored native input`);
  }
  // Minimal public-API host: real terminal dispatch and owned custom overlay completion.
  for (const id of ["pi-starship", "pi-btw"]) {
    const loader = new sdk.DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: process.env.PI_CODING_AGENT_DIR,
      settingsManager: sdk.SettingsManager.inMemory({}),
      additionalExtensionPaths: [join(process.cwd(), "node_modules/@narumitw", id)],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    loaded.runtime.getThinkingLevel = () => "off";
    const terminal = new FullscreenTerminal();
    const parent = new tui.TuiMainScreen(terminal);
    const notifications = [];
    const frames = [];
    const active = new Set();
    let mounts = 0;
    let editorText = "parent draft";
    const ctx = {
      cwd: process.cwd(),
      mode: "tui",
      hasUI: true,
      model: {
        id: "artifact-mock",
        name: "Artifact mock",
        api: "openai-completions",
        provider: "artifact-mock",
        baseUrl: "http://unused.invalid",
        reasoning: false,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      scopedModels: [],
      isIdle: () => true,
      hasPendingMessages: () => false,
      isProjectTrusted: () => false,
      waitForIdle: async () => {},
      getContextUsage: () => undefined,
      sessionManager: {
        getSessionId: () => "artifact-session",
        getSessionName: () => undefined,
        getBranch: () => [],
        getEntries: () => [],
      },
      modelRegistry: {
        getAvailable: () => [],
        getAll: () => [],
        isUsingOAuth: () => false,
        getApiKeyAndHeaders: async () => ({ ok: false, error: "mock: no credentials" }),
        streamSimple: () => {
          throw new Error("Provider invocation forbidden in artifact smoke");
        },
      },
      ui: {
        theme,
        notify: (message, level) => notifications.push({ message, level }),
        setStatus() {},
        setWidget() {},
        setFooter() {},
        onTerminalInput: () => () => {},
        getEditorText: () => editorText,
        setEditorText: (text) => {
          editorText = text;
        },
        custom: async (factory, options) =>
          new Promise((resolve, reject) => {
            let component;
            let handle;
            let closed = false;
            const done = (value) => {
              if (closed) return;
              closed = true;
              handle?.hide();
              active.delete(done);
              component?.dispose?.();
              resolve(value);
            };
            active.add(done);
            Promise.resolve(factory(parent, theme, tui.getKeybindings(), done))
              .then((value) => {
                component = value;
                if (closed) {
                  component?.dispose?.();
                  return;
                }
                handle = parent.showOverlay(component);
                options?.onHandle?.(handle);
                frames.push(component);
                mounts++;
              })
              .catch(reject);
          }),
      },
    };
    const emit = async (type) => {
      for (const handler of extension.handlers.get(type) ?? [])
        await handler(type === "session_start" ? { type, reason: "startup" } : { type }, ctx);
    };
    parent.start();
    try {
      await emit("session_start");
      const command = extension.commands.get(id === "pi-starship" ? "starship" : "btw");
      assert.ok(command);
      if (id === "pi-starship") {
        await command.handler("status", { ...ctx, mode: "rpc" });
        assert.match(notifications.at(-1)?.message ?? "", /source:/iu);
      }
      let before = mounts;
      const menu = command.handler("", ctx);
      await until(() => mounts > before, `${id} main menu`);
      assert.match(frames.at(-1).render(80).join("\n"), id === "pi-starship" ? /starship/iu : /BTW|side|question/iu);
      terminal.input("\x03");
      await menu;
      if (id === "pi-starship") {
        // Select the real Chat action, without submitting a prompt or using credentials.
        before = mounts;
        const chat = command.handler("", ctx);
        await until(() => mounts > before, "Starship menu before chat");
        before = mounts;
        terminal.input("\r");
        await until(
          () => mounts > before && terminal.events.filter(({ name }) => name === "start").length >= 2,
          "Starship native fullscreen chat",
        );
        await turn();
        const drain = gate();
        const started = gate();
        terminal.drain = () => {
          started.resolve();
          return drain.promise;
        };
        let settled = false;
        const shutdown = emit("session_shutdown").then(() => {
          settled = true;
        });
        await started.promise;
        assert.equal(settled, false);
        drain.resolve();
        await shutdown;
        await chat;
        assert.equal(settled, true);
        terminal.drain = () => Promise.resolve();
      }
      assert.equal(active.size, 0);
      assert.ok(!notifications.some(({ level }) => level === "error"), JSON.stringify(notifications));
      console.log(
        `PASS isolated Jiti package directory: ${id}, lazy menu${id === "pi-starship" ? ", status/chat, gated shutdown drain" : ", shutdown"}`,
      );
    } finally {
      await emit("session_shutdown");
      for (const done of active) done(undefined);
      parent.stop({ preserveScreen: true });
      loaded.runtime.invalidate("artifact smoke complete");
    }
  }
}
