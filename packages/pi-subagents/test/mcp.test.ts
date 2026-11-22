import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { resolveMcpServers } from "../src/mcp-selection.js";
import { MessageBroker } from "../src/message-broker.js";
import { runChild } from "../src/process.js";

const fixture = resolve("packages/pi-subagents/test/fixtures/mcp-server.mjs");
const startConfig = (log: string, behavior = "") => ({ command: process.execPath, args: [fixture, log, behavior] });

test("validates exact MCP names and preserves first occurrence order", () => {
  assert.deepEqual(resolveMcpServers(undefined), []);
  assert.deepEqual(resolveMcpServers([]), []);
  assert.deepEqual(resolveMcpServers(["docs-api", "Office_2", "docs-api"]), ["docs-api", "Office_2"]);
  for (const invalid of [
    null,
    "docs",
    [""],
    ["docs\n"],
    [" docs"],
    ["mcp__*"],
    [23],
    ["a".repeat(129)],
    Array(33).fill("a"),
  ]) {
    assert.throws(() => resolveMcpServers(invalid), /exact server names/u);
  }
});

test("a child uses selected user and project MCP servers but starts no other server", async ({ signal }) => {
  await withMcpFixture(
    signal,
    { projectTrusted: true, names: ["Docs-API", "project"], tools: ["codemode"] },
    async (child) => {
      const off = startConfig(child.unselected);
      await child.configure(
        { "Docs-API": startConfig(child.log), other: off, disabled: { ...off, enabled: false } },
        {
          "Docs-API": { exposure: "deferred", toolExposure: { direct: "direct", hidden: "hidden" } },
          project: { ...startConfig(child.projectLog), exposure: "hidden", toolExposure: { direct: "direct" } },
        },
      );
      const result = await child.run(`
  pi.registerMcpServer("not_from_file", ${JSON.stringify(off)});
  const code = ${JSON.stringify(`
const names = ALL_TOOLS.map(tool => tool.name);
if (names.some(name => /mcp__other|mcp__not_from_file|__hidden|mcp__project__indirect/.test(name))) throw Error("Unexpected MCP tool");
const result = await tools.mcp__Docs_API__indirect({});
if (!JSON.stringify(result).includes("fixture:indirect")) throw Error("MCP codemode result missing");
text("mcp-script-passed");
`)};
  faux.setResponses([
    () => {
      const names = pi.getActiveTools();
      if (!names.includes("mcp__Docs_API__direct") || !names.includes("mcp__project__direct") || names.includes("mcp__Docs_API__indirect")) {
        throw Error("Unexpected direct tool declarations: " + names.join(","));
      }
      return fauxAssistantMessage([fauxToolCall("mcp__Docs_API__direct", {}), fauxToolCall("codemode", {code})]);
    },
    (context) => {
      const results = context.messages.filter(message => message.role === "toolResult");
      for (const text of ["fixture:direct", "mcp-script-passed"]) {
        if (!results.some(result => !result.isError && JSON.stringify(result.content).includes(text))) {
          throw Error("Missing successful tool result: " + text + " " + JSON.stringify(results));
        }
      }
      return fauxAssistantMessage("mcp-passed");
    },
  ]);
`);
      assert.equal(result.state, "completed", JSON.stringify(result));
      assert.equal(result.result, "mcp-passed");
      assert.match(await readFile(child.log, "utf8"), /^start\n(?:direct\nindirect|indirect\ndirect)\nstop\n$/u);
      assert.equal(await readFile(child.projectLog, "utf8"), "start\nstop\n");
      await assert.rejects(readFile(child.unselected), { code: "ENOENT" });
    },
  );
});

test("cancelling an active child gives Pi time to close its selected stdio server", async ({ signal, skip }) => {
  if (process.platform === "win32") skip();
  await withMcpFixture(signal, { projectTrusted: true, names: ["docs"], tools: ["codemode"] }, async (child) => {
    await child.configure({ docs: startConfig(child.log, "wait-for-term") });
    const result = await child.run(
      `
  const code = ${JSON.stringify(`
const result = await tools.mcp__docs__indirect({});
if (!JSON.stringify(result).includes("fixture:indirect")) throw Error("MCP server did not respond");
const sent = JSON.parse(await tools.subagent_send({message: "MCP ready"}));
await tools.subagent_wait({requestId: sent.requestId});
`)};
  faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode", {code})])]);
`,
      true,
    );
    assert.equal(result.state, "cancelled", JSON.stringify(result));
    assert.equal(await readFile(child.log, "utf8"), "start\nindirect\nstop\n");
  });
});

for (const { label, trusted, project, expected } of [
  { label: "untrusted project config", trusted: false, project: { exposure: "direct" }, expected: /not configured/u },
  { label: "disabled override", trusted: true, project: { enabled: false }, expected: /unavailable or disabled/u },
  {
    label: "invalid config",
    trusted: true,
    project: { command: 7, args: ["SECRET"] },
    expected: /Invalid or conflicting/u,
  },
  {
    label: "invalid override",
    trusted: true,
    project: { env: { PRIVATE: "SECRET" } },
    expected: /Invalid project override/u,
  },
  {
    label: "project provider auth",
    trusted: true,
    project: { url: "https://invalid.example/mcp", auth: { provider: "SECRET" } },
    expected: /cannot use provider authentication/u,
  },
  { label: "conflicting namespace", trusted: true, project: undefined, expected: /conflicting name/u },
]) {
  test(`invalid MCP selection fails before a model request or any connection: ${label}`, async ({ signal }) => {
    await withMcpFixture(
      signal,
      { projectTrusted: trusted, names: ["valid", "selected-name"], tools: [] },
      async (child) => {
        const selected = startConfig(child.log);
        const user = { valid: startConfig(child.unselected), ...(trusted ? { "selected-name": selected } : {}) };
        const overrides = project ? { "selected-name": project } : { selected_name: selected };
        await child.configure(user, overrides);
        const result = await child.run('faux.setResponses([fauxAssistantMessage("unexpected model request")]);');
        assert.equal(result.state, "failed", JSON.stringify(result));
        assert.match(result.error ?? "", expected);
        assert.doesNotMatch(result.error ?? "", /SECRET|mcp\.json/u);
        assert.equal(result.result, undefined);
        await assert.rejects(readFile(child.log), { code: "ENOENT" });
        await assert.rejects(readFile(child.unselected), { code: "ENOENT" });
      },
    );
  });
}

async function withMcpFixture(
  signal: AbortSignal,
  options: { projectTrusted: boolean; names: string[]; tools: string[] },
  test: (child: {
    log: string;
    projectLog: string;
    unselected: string;
    configure(user: object, project?: object): Promise<void>;
    run(responses: string, cancelAfterMessage?: boolean): ReturnType<typeof runChild>;
  }) => Promise<void>,
) {
  const root = await mkdtemp(resolve("packages/pi-subagents/.pi-subagents-mcp-test-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const providerPath = join(root, "provider.ts");
  const previous = process.env.PI_CODING_AGENT_DIR;
  const controller = new AbortController();
  const broker = new MessageBroker({ onMessage: () => controller.abort() });
  let child: ReturnType<typeof runChild> | undefined;
  try {
    await Promise.all([mkdir(join(cwd, CONFIG_DIR_NAME), { recursive: true }), mkdir(agentDir)]);
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ codemode: { mode: "on" }, retry: { enabled: false } }),
    );
    await broker.start();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await test({
      log: join(root, "selected.log"),
      projectLog: join(root, "project.log"),
      unselected: join(root, "unselected.log"),
      async configure(user, project) {
        await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: user }));
        if (project) await writeFile(join(cwd, CONFIG_DIR_NAME, "mcp.json"), JSON.stringify({ mcpServers: project }));
      },
      async run(responses, cancelAfterMessage = false) {
        await writeFile(
          providerPath,
          `import { fauxProvider, fauxToolCall, fauxAssistantMessage } from "@earendil-works/pi-ai";
export default function(pi) {
  const faux = fauxProvider({provider:"child-mcp-fixture", models:[{id:"fixture"}], tokensPerSecond:Infinity});
  ${responses}
  pi.registerProvider(faux.provider);
}
`,
        );
        signal.throwIfAborted();
        child = runChild({
          task: "Use only the MCP fixture tools selected for this job.",
          cwd,
          tools: options.tools,
          mcpServers: options.names,
          skills: [],
          extensions: [{ path: providerPath, tools: [] }],
          toolSources: {},
          projectTrusted: options.projectTrusted,
          provider: "child-mcp-fixture",
          model: "fixture",
          thinkingLevel: "off",
          communication: broker.issueCredentials({ jobId: "mcp-test", generation: 1 }),
          signal: AbortSignal.any(cancelAfterMessage ? [signal, controller.signal] : [signal]),
        });
        return child;
      },
    });
  } finally {
    controller.abort();
    await child;
    await broker.shutdown();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}
