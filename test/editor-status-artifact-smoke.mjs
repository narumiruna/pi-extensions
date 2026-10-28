// Bounded offline artifact verification; build packages before running this file.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidence = await mkdtemp(join(tmpdir(), "pi-editor-status-artifacts-"));
const artifacts = join(evidence, "artifacts");
const project = join(evidence, "consumer");
await mkdir(artifacts);
await mkdir(project);
console.log(`Artifact evidence: ${evidence}`);
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
function command(file, args, cwd) {
  return execFileSync(file, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
}
const packages = [];
const dependencies = {};
const peers = new Set(["@earendil-works/pi-ai"]);
for (const id of ["pi-tui-kit", "pi-progress", "pi-subagents", "pi-herdr"]) {
  const source = join(root, "packages", id);
  const manifest = await json(join(source, "package.json"));
  const [packed] = JSON.parse(
    command("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", artifacts], source),
  );
  const tarball = join(artifacts, packed.filename);
  const entries = command("tar", ["-tzf", tarball], evidence)
    .trim()
    .split("\n")
    .map((entry) => entry.replace(/^package\//u, ""));
  const archived = JSON.parse(command("tar", ["-xOf", tarball, "package/package.json"], evidence));
  assert.deepEqual(archived, manifest);
  for (const entry of entries)
    assert.ok(
      entry === "package.json" || manifest.files.some((path) => entry === path || entry.startsWith(`${path}/`)),
      `Undeclared file: ${id}/${entry}`,
    );
  assert.ok(entries.includes("LICENSE"));
  assert.ok(entries.includes("README.md"));
  for (const entry of manifest.pi?.extensions ?? []) assert.ok(entries.includes(entry.replace(/^\.\//u, "")));
  if (manifest.exports) {
    for (const entry of Object.values(manifest.exports))
      for (const target of Object.values(entry))
        assert.ok(entries.includes(target.replace(/^\.\//u, "")), `Missing export: ${target}`);
  }
  packages.push({
    name: manifest.name,
    version: manifest.version,
    integrity: packed.integrity,
    sha256: createHash("sha256")
      .update(await readFile(tarball))
      .digest("hex"),
    tarball,
    files: entries,
  });
  dependencies[manifest.name] = `file:${tarball}`;
  for (const peer of Object.keys(manifest.peerDependencies ?? {})) peers.add(peer);
}
for (const peer of peers) dependencies[peer] = (await json(join(root, "node_modules", peer, "package.json"))).version;
await writeFile(
  join(project, "package.json"),
  JSON.stringify({ name: "editor-status-artifact-consumer", private: true, type: "module", dependencies }, null, 2),
);
// No registry fallback: the smoke must not resolve a different Kit artifact.
process.stdout.write(command("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], project));
for (const artifact of packages) {
  const installed = join(project, "node_modules", artifact.name);
  assert.equal(await realpath(installed), installed, "Artifacts must not be workspace links");
  if (artifact.name !== "@narumitw/pi-tui-kit") {
    const consumerRequire = createRequire(join(installed, "package.json"));
    // Kit exposes ESM imports, not a CommonJS require condition. Check the
    // consumer's package search root here; the child exercises actual ESM/Jiti.
    const kitRoot = consumerRequire.resolve
      .paths("@narumitw/pi-tui-kit")
      ?.map((directory) => join(directory, "@narumitw/pi-tui-kit"))
      .find((directory) => existsSync(join(directory, "package.json")));
    assert.ok(kitRoot, `${artifact.name} cannot find Kit`);
    assert.equal(await realpath(kitRoot), join(project, "node_modules/@narumitw/pi-tui-kit"));
  }
}
const runtime = join(project, "runtime.mjs");
await writeFile(
  runtime,
  `import assert from "node:assert/strict";\nimport {join} from "node:path";\nimport {mkdir} from "node:fs/promises";\nprocess.send?.({type:"ready"});\nawait (${runtimeProof.toString()})();\n`,
);
await runReadyChild(runtime, project);
await writeFile(
  join(evidence, "evidence.json"),
  JSON.stringify({ result: "PASS", packages, peers: dependencies }, null, 2),
);
console.log(
  JSON.stringify(
    { result: "PASS", evidence, packages: packages.map(({ files: _files, ...identity }) => identity) },
    null,
    2,
  ),
);

function runReadyChild(entry, cwd) {
  return new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, [entry], { cwd, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let output = "";
    let ready = false;
    let deadline;
    const startup = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Artifact child did not start"));
    }, 30_000);
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    child.on("message", (message) => {
      if (message?.type !== "ready" || ready) return;
      ready = true;
      clearTimeout(startup);
      deadline = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Ready artifact child exceeded its operation deadline"));
      }, 30_000);
    });
    child.once("error", (error) => {
      clearTimeout(startup);
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(startup);
      clearTimeout(deadline);
      process.stdout.write(output);
      if (ready && code === 0 && output.includes("PASS installed package lifecycle and lazy menus")) resolveChild();
      else reject(new Error(`Artifact child failed (${code}): ${output}`));
    });
  });
}

async function runtimeProof() {
  process.env.PI_CODING_AGENT_DIR = join(process.cwd(), "agent");
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "artifact-pane";
  process.env.HERDR_SOCKET_PATH = join(process.cwd(), "unused.sock");
  await mkdir(process.env.PI_CODING_AGENT_DIR);
  const sdk = await import("@earendil-works/pi-coding-agent");
  const kit = await import("@narumitw/pi-tui-kit");
  const { createRpcHarness } = await import("@narumitw/pi-tui-kit/testing");
  sdk.initTheme("dark", false);
  for (const [entry, name] of [
    ["publisher", "createEditorStatusPublisher"],
    ["view", "createEditorStatusView"],
    ["collection", "createEditorStatusCollection"],
  ]) {
    const focused = await import(`@narumitw/pi-tui-kit/editor-status-${entry}`);
    assert.equal(kit[name], focused[name]);
  }
  const view = kit.createEditorStatusView({ onChange() {}, canCompact: () => true });
  view.setTrigger("user-message");
  view.userMessage();
  assert.equal(view.mode, "compact");
  view.dispose();
  const collection = kit.createEditorStatusCollection({
    maxItems: 2,
    maxContentSize: 10,
    measure: (value) => value.length,
  });
  collection.replace([{ id: "one", revision: "1", value: "first" }]);
  collection.item("one").compact();
  assert.equal(collection.snapshot()[0].mode, "compact");
  assert.equal("upsert" in collection, false);
  collection.dispose();
  const theme = { fg: (_role, text) => text, bold: (text) => text, strikethrough: (text) => text };
  const mounted = new Map();
  let mounts = 0;
  const ui = {
    theme,
    setWidget(key, content) {
      mounted.get(key)?.dispose?.();
      mounted.delete(key);
      if (content === undefined) return;
      assert.equal(typeof content, "function");
      mounted.set(key, content({ terminal: { rows: 24 }, requestRender() {} }, theme));
      mounts++;
    },
  };
  const publisher = kit.createEditorStatusPublisher({
    key: "fixture",
    context: { mode: "tui", hasUI: true, ui },
    isCurrent: () => true,
    render: (value, activeTheme, width) =>
      new kit.EditorStatusWidget({ theme: activeTheme, renderBody: () => [value] }).render(width),
  });
  publisher.publish("before");
  publisher.publish("after");
  assert.equal(mounts, 1);
  assert.equal(mounted.get("fixture").render(20)[1], "after");
  publisher.dispose();
  assert.equal(mounted.size, 0);
  for (const id of ["pi-progress", "pi-subagents", "pi-herdr"]) {
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
    const rpc = createRpcHarness([{ kind: "select", response: "Close" }]);
    const widgets = [];
    const notices = [];
    const context = {
      mode: "rpc",
      hasUI: true,
      cwd: process.cwd(),
      isIdle: () => true,
      isProjectTrusted: () => false,
      sessionManager: {
        getBranch: () => [],
        getEntries: () => [],
        getSessionId: () => "artifact-session",
        getSessionName: () => undefined,
      },
      ui: {
        ...rpc.ui,
        theme,
        setStatus() {},
        setWidget: (key, content) => {
          assert.ok(content === undefined || Array.isArray(content));
          widgets.push({ key, content });
        },
        notify: (message, type) => notices.push({ message, type }),
      },
      modelRegistry: {
        getAvailable: () => [],
        getAll: () => [],
        streamSimple() {
          throw new Error("Provider invocation forbidden");
        },
      },
    };
    const emit = async (name, payload) => {
      for (const handler of extension.handlers.get(name) ?? []) await handler(payload, context);
    };
    try {
      await emit("session_start", { reason: "startup" });
      if (id === "pi-progress") {
        const tool = extension.tools.get("update_progress");
        assert.ok(tool);
        await tool.definition.execute(
          "artifact-update",
          { steps: [{ text: "installed", status: "in_progress" }] },
          undefined,
          () => {},
          context,
        );
        assert.ok(widgets.some(({ content }) => content?.join("\n").includes("installed")));
      }
      const commandName = id.slice(3);
      await extension.commands.get(commandName).handler("", context);
      rpc.assertConsumed();
      assert.equal(notices.filter(({ type }) => type === "error").length, 0, JSON.stringify(notices));
    } finally {
      await emit("session_shutdown", { reason: "quit" });
      loaded.runtime.invalidate("artifact smoke complete");
    }
    console.log(`PASS installed Jiti ${id}: lifecycle, lazy menu, RPC protocol, no provider`);
  }
  console.log("PASS installed package lifecycle and lazy menus");
}
