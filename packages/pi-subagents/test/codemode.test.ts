import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { toolSourceId } from "../src/attachment-utils.js";
import { MessageBroker } from "../src/message-broker.js";
import { runChild } from "../src/process.js";

for (const mode of ["on", "only"] as const) {
  test(`native child codemode executes selected tools and communication in ${mode} mode`, async ({ signal }) => {
    const root = await mkdtemp(resolve("packages/pi-subagents/.pi-subagents-codemode-test-"));
    const agentDir = join(root, "agent");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const messages: string[] = [];
    const broker = new MessageBroker({
      onMessage(message) {
        messages.push(message.message);
        broker.replyFromMain(message.requestId, "main-answer");
      },
    });
    const controller = new AbortController();
    let child: ReturnType<typeof runChild> | undefined;
    try {
      await mkdir(agentDir);
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({ codemode: { mode }, retry: { enabled: false } }),
      );
      await writeFile(join(root, "input.txt"), "selected-read-result");
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const script = `
const names = ALL_TOOLS.map(tool => tool.name).sort();
if (JSON.stringify(names) !== JSON.stringify(["fixture_selected", "read", "subagent_send", "subagent_wait"])) {
  throw new Error("Unexpected callable tools: " + names.join(","));
}
if (typeof models.classify !== "function") throw new Error("Missing native model API");
const reads = await Promise.all([tools.read({path:"input.txt"}), tools.read({path:"input.txt"})]);
if (await tools.fixture_selected({}) !== "selected-extension-result") throw new Error("Extension call failed");
if (!reads.every(result => result.includes("selected-read-result"))) throw new Error("Read failed");
const sent = JSON.parse(await tools.subagent_send({message:"child-script-request"}));
const answer = await tools.subagent_wait({requestId:sent.requestId});
if (!answer.includes("main-answer")) throw new Error("Communication failed");
text("native-script-passed");
`;
      const providerPath = join(root, "provider.ts");
      await writeFile(
        providerPath,
        `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
export default function(pi) {
  for (const exposure of ["direct", "codemode", "deferred", "model-only", "hidden"]) {
    pi.registerTool({
      name:"excluded_" + exposure.replace("-", "_"), label:"Excluded", description:"Must remain excluded",
      exposure, parameters:Type.Object({}),
      execute:async () => { throw new Error("Unselected tool executed"); },
    });
  }
  pi.registerTool({
    name:"fixture_selected", label:"Selected", description:"Selected extension tool",
    parameters:Type.Object({}),
    execute:async () => ({content:[{type:"text",text:"selected-extension-result"}],details:undefined}),
  });
  const faux = fauxProvider({provider:"child-codemode-fixture", models:[{id:"fixture"}], tokensPerSecond:Infinity});
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", {code:${JSON.stringify(script)}})]),
    (context) => {
      const results = context.messages.filter(message => message.role === "toolResult");
      if (!results.some(result => !result.isError && JSON.stringify(result.content).includes("native-script-passed"))) {
        throw new Error("Native codemode did not pass: " + JSON.stringify(results));
      }
      return fauxAssistantMessage("child-codemode-passed");
    },
  ]);
  pi.registerProvider(faux.provider);
}
`,
      );
      await broker.start();
      signal.throwIfAborted();
      child = runChild({
        task: "Run the deterministic codemode script.",
        cwd: root,
        tools: ["read", "codemode"],
        skills: [],
        extensions: [{ path: providerPath, tools: ["fixture_selected"] }],
        toolSources: { fixture_selected: [toolSourceId(providerPath)] },
        projectTrusted: true,
        provider: "child-codemode-fixture",
        model: "fixture",
        thinkingLevel: "off",
        communication: broker.issueCredentials({ jobId: "codemode-test", generation: 1 }),
        signal: AbortSignal.any([signal, controller.signal]),
        onControl: () => {},
      });
      const result = await child;
      assert.equal(result.state, "completed", JSON.stringify(result));
      assert.equal(result.result, "child-codemode-passed");
      assert.deepEqual(messages, ["child-script-request"]);
    } finally {
      controller.abort();
      await child;
      await broker.shutdown();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });
}
