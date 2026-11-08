import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Run after the two package builds. Optional arguments are extracted package directories:
// node scripts/smoke-extension-status.mjs [sync-package-directory statusline-package-directory]
// This is a real package-bin CLI smoke, not a resource-loader substitute.
const self = fileURLToPath(import.meta.url);
const repository = resolve(dirname(self), "..");
const provider = "extension-status-offline";

if (process.argv[2] === "--bootstrap") {
  const [, , , cli, ...args] = process.argv;
  assert.ok(cli);
  const denyNetwork = (operation) => {
    process.send?.({ type: "network-attempt", operation });
    throw new Error(`Offline smoke rejected network operation: ${operation}`);
  };
  globalThis.fetch = async () => denyNetwork("fetch");
  // This also covers HTTP(S), undici, and WebSocket socket creation before DNS/connect.
  net.Socket.prototype.connect = () => denyNetwork("socket.connect");
  process.send?.({ type: "bootstrap-ready" });
  process.argv = [process.execPath, cli, ...args];
  await import(pathToFileURL(cli).href);
} else {
  const paths = process.argv.slice(2);
  assert.ok(
    paths.length === 0 || paths.length === 2,
    "Supply both Sync and Statusline package directories, or neither",
  );
  const syncPath = resolve(paths[0] ?? join(repository, "packages/pi-sync"));
  const statuslinePath = resolve(paths[1] ?? join(repository, "packages/pi-statusline"));
  const piRoot = join(repository, "node_modules/@earendil-works/pi-coding-agent");
  const manifest = JSON.parse(await readFile(join(piRoot, "package.json"), "utf8"));
  const cli = resolve(piRoot, manifest.bin.pi);
  for (const entries of [
    [{ name: "sync", path: syncPath }],
    [{ name: "statusline", path: statuslinePath }],
    [
      { name: "sync", path: syncPath },
      { name: "statusline", path: statuslinePath },
    ],
  ]) {
    await smoke(cli, entries);
  }
}

async function smoke(cli, entries) {
  let root;
  let child;
  let closed;
  let bootstrapSafety;
  let operationDeadline;
  const pending = new Map();
  const records = [];
  const networkAttempts = [];
  let partial = "";
  let stderr = "";
  let sequence = 0;
  let closing = false;
  let fail;
  const failure = new Promise((_, reject) => {
    fail = reject;
  });
  void failure.catch(() => undefined);
  const interrupt = () => fail(new Error("Offline smoke cancelled by SIGINT"));
  const terminate = () => fail(new Error("Offline smoke cancelled by SIGTERM"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    root = await mkdtemp(join(tmpdir(), "pi-extension-status-offline-"));
    const home = join(root, "home");
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    await Promise.all([home, agentDir, cwd].map((path) => mkdir(path, { recursive: true })));
    // RPC requires a selected model even when only slash commands run. This model is
    // synthetic, has no real credential, and cannot reach a provider. No Sync settings
    // exist, so startup/shutdown cannot select a storage backend or authorize work.
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          [provider]: {
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            apiKey: "not-a-credential",
            models: [{ id: "unused" }],
          },
        },
      }),
      { mode: 0o600 },
    );
    // Authoritative installed paths: main.js sets PI_OFFLINE before services and
    // skips RPC catalog refresh; ModelRuntime.create/refresh disables model network.
    // args.js preserves explicit -e with --no-extensions; rpc-mode.js disposes on EOF.
    const args = [
      "--mode",
      "rpc",
      "--no-session",
      "--offline",
      "--no-extensions",
      "--no-mcp",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-tools",
      "--provider",
      provider,
      "--model",
      "unused",
      ...entries.flatMap((entry) => ["-e", entry.path]),
    ];
    child = spawn(process.execPath, [self, "--bootstrap", cli, ...args], {
      cwd,
      // Deliberately do not inherit auth, proxy, extension, NODE_OPTIONS, or provider variables.
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_DATA_HOME: join(root, "data"),
        NODE_COMPILE_CACHE: join(root, "cache", "node"),
        PI_CODING_AGENT_DIR: agentDir,
        PI_TELEMETRY: "0",
      },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    const cliChild = child;
    closed = new Promise((done) => cliChild.once("close", (code, signal) => done({ code, signal })));
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      if (!closing) fail(new Error(`Pi exited before shutdown (${code ?? signal}): ${stderr}`));
    });
    child.stdin.on("error", fail);
    child.stderr.setEncoding("utf8").on("data", (data) => {
      stderr += data;
    });
    child.on("message", (message) => {
      if (message?.type === "network-attempt") {
        networkAttempts.push(message.operation);
        fail(new Error(`Unexpected network attempt: ${message.operation}`));
      }
    });
    child.stdout.setEncoding("utf8").on("data", (data) => {
      partial += data;
      while (true) {
        const newline = partial.indexOf("\n");
        if (newline < 0) break;
        const line = partial.slice(0, newline).replace(/\r$/u, "");
        partial = partial.slice(newline + 1);
        if (!line) continue;
        try {
          const record = JSON.parse(line);
          records.push(record);
          if (record.type === "extension_error" || record.type === "agent_start") {
            fail(new Error(`Unexpected runtime/model activity: ${line}`));
          }
          if (
            record.type === "extension_ui_request" &&
            ["select", "confirm", "input", "editor"].includes(record.method)
          ) {
            fail(new Error(`Unexpected interactive dialog: ${line}`));
          }
          if (record.type === "response" && record.id) {
            pending.get(record.id)?.(record);
            pending.delete(record.id);
          }
        } catch (error) {
          fail(error);
        }
      }
    });
    const request = async (command) => {
      const id = `extension-status-${++sequence}`;
      const response = new Promise((done) => pending.set(id, done));
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
      const result = await Promise.race([response, failure]);
      assert.equal(result.success, true, JSON.stringify(result));
      return result;
    };

    // A separate bootstrap safety bound includes process scheduling and module loading.
    // Operation timing starts only after the real RPC readiness response, never at spawn.
    bootstrapSafety = setTimeout(() => fail(new Error(`Pi bootstrap safety deadline exceeded: ${stderr}`)), 30_000);
    const ready = await request({ type: "get_commands" });
    clearTimeout(bootstrapSafety);
    // --no-skills disables discovery, not resources explicitly selected by a package -e.
    // RPC distinguishes extension, prompt, and skill commands; preserve the manual-only bundled skill.
    const expectedCommands = entries.map((entry) => `extension:${entry.name}`);
    if (entries.some((entry) => entry.name === "sync")) expectedCommands.push("skill:skill:configure-pi-sync");
    assert.deepEqual(
      ready.data.commands.map((command) => `${command.source}:${command.name}`).sort(),
      expectedCommands.sort(),
    );
    operationDeadline = setTimeout(() => fail(new Error(`Pi ready-operation deadline exceeded: ${stderr}`)), 10_000);
    for (const entry of entries) {
      const before = records.length;
      const response = await request({ type: "prompt", message: `/${entry.name} help` });
      assert.equal(response.data.disposition, "handled", `/${entry.name} help must not start a model run`);
      const help = records
        .slice(before)
        .filter((record) => record.type === "extension_ui_request" && record.method === "notify")
        .map((record) => record.message)
        .join("\n");
      assert.match(help, entry.name === "sync" ? /Usage: \/sync <command>/u : /\/statusline help/u);
    }
    const messages = await request({ type: "get_messages" });
    assert.deepEqual(messages.data.messages, []);
    closing = true;
    child.stdin.end();
    assert.deepEqual(await Promise.race([closed, failure]), { code: 0, signal: null });
    assert.equal(partial, "", "stdout must end on a JSONL boundary");
    assert.equal(stderr, "");
    assert.deepEqual(networkAttempts, []);
    console.log(
      JSON.stringify({
        result: "PASS",
        mode: "rpc",
        entries: entries.map((entry) => entry.path),
        lazyCommands: entries.map((entry) => `/${entry.name} help`),
        networkAttempts: 0,
        modelRuns: 0,
        shutdown: "clean EOF",
      }),
    );
  } finally {
    clearTimeout(bootstrapSafety);
    clearTimeout(operationDeadline);
    closing = true;
    try {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (closed) await closed;
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      pending.clear();
      if (root) await rm(root, { recursive: true, force: true });
    }
  }
}
