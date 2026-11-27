import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npmInvocation } from "../scripts/npm-invocation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const external = await mkdtemp(join(tmpdir(), "pi-floating-artifacts-"));
const project = join(external, "consumer");
await mkdir(project);
console.log(`Floating-frame evidence: ${external}`);
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const npm = (cwd, args) => {
  const [command, argv] = npmInvocation(args);
  return execFileSync(command, argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
};
const manifests = [];
const dependencies = {};
for (const id of ["pi-tui-kit", "pi-btw", "pi-plan-mode"]) {
  const directory = join(root, "packages", id);
  const manifest = await json(join(directory, "package.json"));
  const [artifact] = JSON.parse(npm(directory, ["pack", "--ignore-scripts", "--json", "--pack-destination", external]));
  assert.ok(artifact.integrity);
  const paths = new Set(artifact.files.map((file) => file.path));
  if (manifest.pi) assert.ok(paths.has("dist/index.ts"));
  else for (const file of ["dist/floating-frame.js", "dist/floating-frame.d.ts"]) assert.ok(paths.has(file));
  dependencies[manifest.name] = `file:${join(external, artifact.filename)}`;
  manifests.push({ name: manifest.name, version: manifest.version, integrity: artifact.integrity });
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    dependencies[name] = (await json(join(root, "node_modules", name, "package.json"))).version;
  }
}
await writeFile(join(external, "artifacts.json"), JSON.stringify(manifests, null, 2));
await writeFile(
  join(project, "package.json"),
  JSON.stringify({ private: true, type: "module", dependencies }, null, 2),
);
const install = ["install", "--ignore-scripts", "--no-audit", "--no-fund"];
try {
  npm(project, [...install, "--offline"]);
} catch (error) {
  if (!/ENOTCACHED|only-if-cached|cache miss/iu.test(`${error.stdout ?? ""}\n${error.stderr ?? ""}`)) throw error;
  npm(project, install);
}
for (const { name, version } of manifests) {
  const installed = join(project, "node_modules", name);
  assert.equal(await realpath(installed), installed);
  assert.equal((await json(join(installed, "package.json"))).version, version);
  if (name === "@narumitw/pi-tui-kit") continue;
  const chunks = await readdir(join(installed, "dist/chunks"));
  const source = await Promise.all(
    chunks.filter((name) => name.endsWith(".ts")).map((name) => readFile(join(installed, "dist/chunks", name), "utf8")),
  );
  assert.ok(
    source.some((code) => /["']@narumitw\/pi-tui-kit\/floating-frame["']/u.test(code)),
    `${name} must load the published Kit boundary`,
  );
}
await writeFile(
  join(project, "usage.ts"),
  `
import { FloatingFrame as RootFrame } from '@narumitw/pi-tui-kit';
import { FloatingFrame, type FloatingFrameOptions, type FloatingViewport } from '@narumitw/pi-tui-kit/floating-frame';
declare const options: FloatingFrameOptions;
const frame: RootFrame = new FloatingFrame(options);
const viewport: FloatingViewport = frame.viewport;
frame.move(1, 0);
frame.resize(0, 1);
void viewport;
`,
);
execFileSync(
  process.execPath,
  [
    join(root, "node_modules/typescript/bin/tsc"),
    "--strict",
    "--skipLibCheck",
    "--module",
    "NodeNext",
    "--target",
    "ES2024",
    "--noEmit",
    "usage.ts",
  ],
  { cwd: project, stdio: "inherit" },
);
await writeFile(join(project, "smoke.mjs"), `await (${runInstalled.toString()})();\n`);
execFileSync(process.execPath, [join(project, "smoke.mjs")], { cwd: project, stdio: "inherit" });

async function runInstalled() {
  const { default: assert } = await import("node:assert/strict");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { setImmediate } = await import("node:timers/promises");
  const root = process.cwd();
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const sdk = await import("@earendil-works/pi-coding-agent");
  const tui = await import("@earendil-works/pi-tui");
  const { FullscreenTerminal } = await import("@narumitw/pi-tui-kit/testing");
  const { FloatingFrame } = await import("@narumitw/pi-tui-kit/floating-frame");
  assert.equal((await import("@narumitw/pi-tui-kit")).FloatingFrame, FloatingFrame);
  const theme = { fg: (_role, text) => text, bg: (_role, text) => text, bold: (text) => text };
  sdk.initTheme("dark");

  for (const name of ["pi-btw", "pi-plan-mode"]) {
    const planning = name === "pi-plan-mode";
    await writeFile(
      join(agentDir, `${name}.json`),
      JSON.stringify(planning ? { planPane: "floating", defaultPlanTools: ["read"] } : { layout: "floating" }),
    );
    const loader = new sdk.DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: sdk.SettingsManager.inMemory({}),
      additionalExtensionPaths: [join(root, "node_modules/@narumitw", name)],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const session = {
      getSessionId: () => name,
      getSessionName: () => undefined,
      getSessionFile: () => undefined,
      getLeafId: () => null,
      getBranch: () => [],
      getEntries: () => [],
    };
    const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "fixture", reasoning: false };
    const registry = {
      getAvailable: () => [model],
      streamSimple: () => ({
        result: async () => ({
          role: "assistant",
          content: [{ type: "text", text: "Isolated BTW answer" }],
          stopReason: "stop",
        }),
      }),
    };
    const runner = new sdk.ExtensionRunner(loaded.extensions, loaded.runtime, root, session, registry);
    const toolNames = ["read", "plan_mode_complete", "plan_mode_question"];
    runner.bindCore(
      {
        sendMessage() {},
        sendUserMessage() {},
        appendEntry() {},
        setSessionName() {},
        getSessionName() {},
        setLabel() {},
        getActiveTools: () => toolNames,
        getAllTools: () =>
          toolNames.map((name) => ({
            name,
            description: "fixture",
            source: name === "read" ? "builtin" : "extension",
          })),
        refreshTools() {},
        getCommands: () => [],
        getThinkingLevel: () => "off",
        setThinkingLevel() {},
      },
      {
        getModel: () => model,
        getScopedModels: () => [],
        isIdle: () => true,
        isProjectTrusted: () => true,
        getSignal: () => undefined,
        waitForIdle: async () => {},
        abort() {},
        hasPendingMessages: () => false,
        getSystemPromptOptions: () => ({ cwd: root }),
      },
    );
    const terminal = new FullscreenTerminal();
    terminal.columns = 100;
    terminal.rows = 32;
    const parent = new tui.TuiMainScreen(terminal);
    const main = { render: () => ["main editor"], invalidate() {}, handleInput() {} };
    parent.addChild(main);
    parent.setFocus(main);
    parent.start();
    let mounted;
    const errors = [];
    runner.onError((error) => errors.push(error));
    runner.setUIContext(
      {
        theme,
        notify() {},
        setWidget() {},
        setStatus() {},
        getEditorText: () => "main draft",
        onTerminalInput: (fn) => parent.addInputListener(fn),
        async custom(factory, options) {
          if (!options?.overlay) return undefined;
          let handle;
          let component;
          let finished = false;
          const result = Promise.withResolvers();
          component = await factory(parent, theme, tui.getKeybindings(), (value) => {
            if (finished) return;
            finished = true;
            handle?.hide();
            component?.dispose?.();
            result.resolve(value);
          });
          if (!finished) {
            const raw = options.overlayOptions;
            handle = parent.showOverlay(component, typeof raw === "function" ? raw() : raw);
            mounted = { component, handle };
            options.onHandle?.(handle);
          }
          return result.promise;
        },
      },
      "tui",
    );
    try {
      await runner.emit({ type: "session_start", reason: "startup" });
      const command = runner.getCommand(planning ? "plan" : "btw");
      assert.ok(command);
      const running = command.handler(planning ? "start" : "Isolated BTW question", runner.createCommandContext());
      if (planning) {
        await running;
        const complete = runner.getToolDefinition("plan_mode_complete");
        assert.ok(complete);
        const signal = new AbortController().signal;
        await complete.execute(
          "artifact-plan",
          { plan: "# Isolated Plan\n\nFixture only." },
          signal,
          undefined,
          runner.createToolContext("artifact-plan", signal),
        );
        await runner.emit({ type: "agent_settled", aborted: false });
      }
      const expected = planning ? /Isolated Plan/u : /Isolated BTW answer/u;
      const output = () => {
        parent.renderNow();
        const bounds = mounted?.handle.getBounds();
        return bounds ? mounted.component.render(bounds.width).map(tui.stripTerminalSequences).join("\n") : "";
      };
      const deadline = performance.now() + 3000;
      while (!expected.test(output()) && errors.length === 0 && performance.now() < deadline) await setImmediate();
      assert.deepEqual(errors, []);
      assert.match(output(), expected);
      assert.equal(mounted.handle.isFocused(), !planning);
      await writeFile(join(root, `../${name}-wide.txt`), output());
      Object.assign(terminal, { columns: 45, rows: 17 });
      const narrow = output();
      assert.ok(narrow.length > 0);
      assert.ok(narrow.split("\n").every((line) => tui.visibleWidth(line) <= 45));
      await writeFile(join(root, `../${name}-narrow.txt`), narrow);
      if (!planning) {
        terminal.input("\u0003");
        await running;
      }
      console.log(`PASS: ${name} package-directory Jiti floating overlay and wide/narrow captures`);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      loaded.runtime.invalidate("floating artifact smoke complete");
      parent.stop();
    }
  }
}
