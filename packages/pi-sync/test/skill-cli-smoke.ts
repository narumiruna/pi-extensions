import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Standalone RPC transport smoke; the local canned provider does not evaluate answer quality.
// Run from the repository root after building: node packages/pi-sync/test/skill-cli-smoke.ts
const piPackage = new URL("../package.json", import.meta.resolve("@earendil-works/pi-coding-agent"));
const piManifest = JSON.parse(await fs.readFile(piPackage, "utf8"));
const piCli = fileURLToPath(new URL(piManifest.bin.pi, piPackage));
const directory = await fs.mkdtemp(path.join(tmpdir(), "pi-sync-skill-cli-"));
const agentDir = path.join(directory, "agent");
const workspace = path.join(directory, "workspace");
const requests: Record<string, unknown>[] = [];
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    requests.push(JSON.parse(body));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({
        id: "skill-smoke",
        object: "chat.completion.chunk",
        created: 0,
        model: "skill-smoke",
        choices: [
          { index: 0, delta: { role: "assistant", content: "Transport fixture only." }, finish_reason: "stop" },
        ],
      })}\n\ndata: [DONE]\n\n`,
    );
  } catch {
    response.writeHead(500);
    response.end();
  }
});
let child: ReturnType<typeof spawn> | undefined;
let exited: Promise<number | null> | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
let stderr = "";
try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await fs.mkdir(agentDir);
  await fs.mkdir(workspace);
  await fs.writeFile(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "skill-smoke": {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          apiKey: "local-fixture-only",
          models: [{ id: "skill-smoke", contextWindow: 64000, maxTokens: 512 }],
        },
      },
    }),
  );
  const reloadFixture = path.join(directory, "reload-fixture.ts");
  await fs.writeFile(
    reloadFixture,
    `export default function (pi) {
      pi.registerCommand("skill-smoke-reload", {
        description: "Test-only reload through the public command context",
        handler: async (_args, ctx) => { await ctx.reload(); return; },
      });
    }\n`,
  );
  const packagePath = path.resolve("packages/pi-sync");
  child = spawn(
    process.execPath,
    [
      piCli,
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-mcp",
      "--no-context-files",
      "--no-prompt-templates",
      "--no-tools",
      "--offline",
      "--provider",
      "skill-smoke",
      "--model",
      "skill-smoke",
      "-e",
      packagePath,
      "-e",
      reloadFixture,
    ],
    {
      cwd: workspace,
      env: { ...process.env, HOME: directory, PI_CODING_AGENT_DIR: agentDir },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const cli = child;
  const listeners = new Set<(record: Record<string, unknown>) => void>();
  const rejectors = new Set<(error: Error) => void>();
  const fail = (error: Error) => {
    for (const reject of rejectors) reject(error);
    rejectors.clear();
    listeners.clear();
  };
  exited = new Promise((resolve) => cli.once("close", (code) => resolve(code)));
  cli.once("error", fail);
  cli.stdin?.on("error", fail);
  cli.once("exit", (code) => fail(new Error(`Pi exited ${code}: ${stderr}`)));
  cli.stderr?.on("data", (data) => {
    stderr += data.toString();
  });
  let buffer = "";
  cli.stdout?.setEncoding("utf8");
  cli.stdout?.on("data", (data) => {
    buffer += data;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record.type === "extension_error") fail(new Error(line));
        for (const listener of listeners) listener(record);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
  function waitFor(predicate: (record: Record<string, unknown>) => boolean) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      rejectors.add(reject);
      const listener = (record: Record<string, unknown>) => {
        if (!predicate(record)) return;
        listeners.delete(listener);
        rejectors.delete(reject);
        resolve(record);
      };
      listeners.add(listener);
    });
  }
  let nextId = 0;
  async function send(type: string, values: Record<string, unknown> = {}) {
    const id = String(nextId++);
    const result = waitFor((record) => record.type === "response" && record.id === id);
    cli.stdin?.write(`${JSON.stringify({ id, type, ...values })}\n`);
    const response = await result;
    assert.equal(response.success, true, JSON.stringify(response));
    return response;
  }
  const ready = await send("get_commands");
  // Operation timing starts only after a child readiness handshake, not during cold startup.
  deadline = setTimeout(() => {
    fail(new Error(`Skill RPC smoke deadline: ${stderr}`));
    cli.kill("SIGTERM");
  }, 30_000);
  assert.match(JSON.stringify(ready), /skill:configure-pi-sync/u);
  assert.match(JSON.stringify(ready), /"name":"sync"/u);
  async function prompt(message: string) {
    const settled = waitFor((record) => record.type === "agent_settled");
    await Promise.all([send("prompt", { message }), settled]);
  }
  function latestUserMessage() {
    const messages = requests.at(-1)?.messages;
    assert.ok(Array.isArray(messages));
    const latest = messages.filter((message) => message.role === "user").at(-1);
    assert.ok(latest);
    return JSON.stringify(latest);
  }
  await prompt("Transport control prompt; do not call tools.");
  assert.equal(requests.length, 1);
  assert.doesNotMatch(
    JSON.stringify(requests[0]),
    /configure-pi-sync/u,
    "manual-only metadata must not enter ordinary prompts",
  );
  const questions = [
    "How do I set up Git without automatic sync?",
    "Where do I enter my WebDAV app password?",
    "What does ./ mean for R2 and S3?",
    "How do the four automatic controls differ?",
    "Can I include sessions safely?",
    "Can you replace my version 2 settings with defaults?",
    "Which version supports localFields, including an empty array?",
    "Which version supports mergeContent and partialSync?",
  ];
  for (const question of questions) {
    await prompt(`/skill:configure-pi-sync ${question}`);
    const request = latestUserMessage();
    assert.match(request, /<skill name=\\"configure-pi-sync/u);
    assert.ok(request.includes(question));
    assert.ok(request.includes("This skill provides guidance only"));
    assert.ok(request.includes("Do not read, create, edit, validate, back up, or migrate"));
  }
  const beforeReload = requests.length;
  await send("prompt", { message: "/skill-smoke-reload" });
  const afterReload = await send("get_commands");
  assert.match(JSON.stringify(afterReload), /skill:configure-pi-sync/u);
  assert.equal(requests.length, beforeReload, "reload must not contact the provider");
  await prompt("/skill:configure-pi-sync What changed after reload?");
  assert.match(latestUserMessage(), /This skill provides guidance only/u);
  assert.match(latestUserMessage(), /What changed after reload\?/u);
  cli.stdin?.end();
  assert.equal(await exited, 0, stderr);
  clearTimeout(deadline);
  await assert.rejects(fs.stat(path.join(agentDir, "pi-sync.json")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(agentDir, "pi-sync.local.json")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(agentDir, "pi-sync")), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(workspace), []);
  console.log(
    JSON.stringify({
      result: "PASS",
      mode: "rpc",
      entry: "packages/pi-sync",
      explicitQuestions: questions.length,
      localFixtureRequests: requests.length,
      externalProviderRequests: 0,
      tools: "disabled",
      privateSettingsCreated: false,
      syncStateCreated: false,
      publicContextReload: true,
      nativeTuiReload: "not exercised",
      answerQuality: "not evaluated by canned provider",
    }),
  );
} finally {
  clearTimeout(deadline);
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const kill = setTimeout(() => child?.kill("SIGKILL"), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(kill);
    }
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(directory, { force: true, recursive: true });
}
