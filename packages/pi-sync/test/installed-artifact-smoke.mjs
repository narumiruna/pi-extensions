import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [syncArgument, hostArgument, standaloneArgument] = process.argv.slice(2);
assert.ok(
  syncArgument && hostArgument && standaloneArgument,
  "expected installed Sync, Pi host install root, and installed standalone daemon paths",
);
assert.equal(process.platform, "linux", "this smoke verifies the child command line using Linux /proc");
assert.ok(!process.env.NODE_PATH, "unset NODE_PATH before running the smoke");
const [sync, host, standalone] = await Promise.all(
  [syncArgument, hostArgument, standaloneArgument].map((path) => realpath(path)),
);
const manifest = async (root) => JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const extensionManifest = await manifest(sync);
const daemon = join(sync, "dist/daemon");
const embedded = await manifest(daemon);
const runtime = join(daemon, "dist");
const cli = join(runtime, "cli.js");
assert.notEqual(embedded.version, extensionManifest.version);
assert.equal(embedded.version, (await manifest(standalone)).version);
assert.throws(() => createRequire(join(sync, "package.json")).resolve("@narumitw/pi-sync-daemon"), {
  code: "MODULE_NOT_FOUND",
});
const { ensureDaemon, findDaemon, stopDaemon, waitForDaemonExit } = await import(
  pathToFileURL(join(runtime, "index.js"))
);
const { runtimePaths } = await import(pathToFileURL(join(runtime, "identity.js")));
const root = await realpath(await mkdtemp(join(tmpdir(), "pi-sync-installed-")));
const agentDir = root;
process.env.PI_CODING_AGENT_DIR = agentDir;
let loaded;
let ctx;
let observedOwner;
const ownedChildren = [];
const alternateDirs = [];
try {
  const sdk = await import(pathToFileURL(join(host, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")));
  const probe = join(root, "peer-probe.ts");
  await writeFile(
    probe,
    `import { parseSettingsDocument } from ${JSON.stringify(join(runtime, "engine/sync/json-document.js"))};
import { showConflicts } from ${JSON.stringify(join(runtime, "engine/sync/conflict-review.js"))};
import { forwardResolverStream } from ${JSON.stringify(join(runtime, "engine/sync/resolver-stream.js"))};
export default function () {
  parseSettingsDocument(Buffer.from('{}'));
  if (typeof showConflicts !== 'function' || typeof forwardResolverStream !== 'function') throw new Error('Missing exports');
}
`,
  );
  const install = resolve(sync, "../..");
  const installURL = pathToFileURL(`${install}/`).href;
  const hostLoads = new Set();
  const hook = registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith(installURL) && /\/(?:@earendil-works\/pi-[^/]+|@narumitw\/sync-node-sdk)\//u.test(url))
        hostLoads.add(url);
      return nextLoad(url, context);
    },
  });
  try {
    const loader = new sdk.DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: sdk.SettingsManager.inMemory({}),
      additionalExtensionPaths: [join(sync, extensionManifest.pi.extensions[0]), probe],
    });
    await loader.reload();
    loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 2);
    const notices = [];
    ctx = {
      cwd: root,
      hasUI: true,
      mode: "rpc",
      sessionManager: { getSessionId: () => "installed-sync" },
      isIdle: () => true,
      hasPendingMessages: () => false,
      isProjectTrusted: () => false,
      ui: { notify: (message) => notices.push(message), setStatus() {}, setWidget() {} },
    };
    await emit("session_start", "startup");
    await loaded.extensions[0].commands.get("sync").handler("help", ctx);
    assert.ok(
      notices.some((message) => message.includes("daemon [")),
      notices.join("\n"),
    );
    assert.deepEqual([...hostLoads], [], "Jiti must not load Pi SDK code from the extension install");
  } finally {
    hook.deregister();
  }

  await checkNativeDependencies();
  const first = await ensureDaemon(agentDir);
  observedOwner = first.identity;
  await checkEmbeddedOwner(first);
  assert.equal((await ensureDaemon(agentDir)).identity.instance, first.identity.instance);

  const paths = await runtimePaths(agentDir);
  const identity = await readFile(paths.identity);
  await writeFile(paths.identity, JSON.stringify({ ...JSON.parse(identity), version: 99 }));
  try {
    await assert.rejects(ensureDaemon(agentDir), /incompatible daemon identity/u);
  } finally {
    await writeFile(paths.identity, identity);
  }
  assert.equal((await findDaemon(agentDir)).identity.instance, first.identity.instance);
  await stopOwner();

  const standaloneOwner = await startOwner(join(standalone, "dist/cli.js"));
  const reused = await ensureDaemon(agentDir);
  assert.equal(reused.identity.pid, standaloneOwner.pid, "reuse an equal standalone owner");
  await stopOwner();

  const newer = await startOwner(await alternateCli("999.0.0"));
  assert.equal((await ensureDaemon(agentDir)).identity.pid, newer.pid, "never downgrade an authenticated newer owner");
  await stopOwner();

  const older = await startOwner(await alternateCli("0.0.0"));
  const replacement = await ensureDaemon(agentDir);
  observedOwner = replacement.identity;
  assert.notEqual(replacement.identity.pid, older.pid);
  await waitForDaemonExit(older);
  await checkEmbeddedOwner(replacement);
  console.log(
    `PASS Pi ${(await manifest(join(host, "node_modules/@earendil-works/pi-coding-agent"))).version}: Jiti /sync help, Node resolver, authenticated daemon ${embedded.version}, equal/newer reuse, older replacement, incompatible refusal, and standalone CLI`,
  );
} finally {
  try {
    if (ctx) await emit("session_shutdown", "reload");
  } finally {
    loaded?.runtime.invalidate("installed artifact smoke complete");
    try {
      await stopOwner();
    } finally {
      try {
        await Promise.all(
          ownedChildren.map(({ child, closed }) => {
            if (child.exitCode === null && child.signalCode === null) child.kill();
            return closed;
          }),
        );
      } finally {
        const state = (await runtimePaths(agentDir)).directory;
        await Promise.all([state, root, ...alternateDirs].map((path) => rm(path, { force: true, recursive: true })));
      }
    }
  }
}

async function emit(type, reason) {
  for (const handler of loaded?.extensions[0]?.handlers.get(type) ?? []) await handler({ type, reason }, ctx);
}

async function checkEmbeddedOwner(owner) {
  const args = (await readFile(`/proc/${owner.identity.pid}/cmdline`, "utf8")).split("\0");
  assert.equal(await realpath(args[1]), cli);
  const status = JSON.parse(execFileSync(process.execPath, [cli, "status", "--root", agentDir], { encoding: "utf8" }));
  assert.equal(status.running, true);
  assert.equal(status.buildVersion, embedded.version);
  assert.equal(status.pid, owner.identity.pid);
}

async function stopOwner() {
  const owner = await findDaemon(agentDir);
  if (owner) {
    observedOwner = owner.identity;
    await stopDaemon(agentDir);
  }
  if (observedOwner) await waitForDaemonExit(observedOwner);
  observedOwner = undefined;
}

async function alternateCli(version) {
  const directory = await mkdtemp(join(dirname(daemon), ".owner-smoke-"));
  alternateDirs.push(directory);
  await cp(daemon, directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ version }));
  return join(directory, "dist/cli.js");
}

async function startOwner(path) {
  const child = fork(path, ["serve", "--root", agentDir], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const closed = new Promise((resolve) => child.once("close", resolve));
  ownedChildren.push({ child, closed });
  observedOwner = await new Promise((resolve, reject) => {
    child.on("message", (message) => {
      if (message.type === "ready") resolve(message.identity);
      if (message.type === "error") reject(new Error(message.message));
    });
    child.once("error", reject);
    child.once("exit", (status) => reject(new Error(`Owner exited before readiness: ${status}`)));
  });
  return observedOwner;
}

async function checkNativeDependencies() {
  // Run the same bootstrap used by the installed CLI, in a fresh Node process.
  const program = `
import assert from 'node:assert/strict';
import { findPackageJSON, registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
const loaded = new Set();
registerHooks({ load(url, context, nextLoad) { loaded.add(url); return nextLoad(url, context); } });
await import('./child-sdk.mjs');
const sdk = import.meta.resolve('@narumitw/sync-node-sdk');
assert.ok(!loaded.has(sdk));
const { prepareResolverHost } = await import('./resolver-host.js');
const host = await prepareResolverHost(process.env.PI_CODING_AGENT_DIR, { provider: 'unbound', id: 'unbound', signature: 'unbound', authSource: 'none' });
assert.match(host.unavailable, /definition or auth source/);
await host.settle();
assert.ok(loaded.has(sdk));
const manifest = JSON.parse(readFileSync(findPackageJSON('@narumitw/sync-node-sdk', import.meta.url), 'utf8'));
for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-tui']) {
  assert.equal(JSON.parse(readFileSync(findPackageJSON(name, sdk), 'utf8')).version, manifest.dependencies[name]);
}
(await import('./engine/sync/json-document.js')).parseSettingsDocument(Buffer.from('{}'));
await import('./engine/sync/conflict-review.js');
await import('./engine/backends/webdav/webdav-backend.js');
`;
  execFileSync(process.execPath, ["--input-type=module", "-e", program], { cwd: runtime, stdio: "inherit" });
}
