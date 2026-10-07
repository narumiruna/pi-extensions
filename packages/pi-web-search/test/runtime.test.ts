import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemoryCredentialStore, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { EXPOSURES, type Settings } from "../src/settings.js";

const fauxSpecifier = "@earendil-works/pi-ai/providers/faux";

// Keep only provider-visible content and ordered definitions, not accounting or IDs.
function normalizedMessages(messages: TranscriptContext["messages"]) {
  return messages.map((message) => {
    const copy = { ...message } as Record<string, unknown>;
    for (const key of ["timestamp", "usage", "responseId", "stopReason", "model", "api", "provider"]) delete copy[key];
    return copy;
  });
}
async function harness(exposure: Settings["exposure"] = "codemode") {
  const root = await mkdtemp(join(tmpdir(), "pi-web-search-runtime-"));
  const agentDir = join(root, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  await mkdir(agentDir);
  const path = join(agentDir, "pi-web-search.json");
  const configure = (next: Settings["exposure"]) =>
    writeFile(path, JSON.stringify({ exposure: next, accountId: "a".repeat(32), apiToken: "TOP_SECRET" }), {
      mode: 0o600,
    });
  await configure(exposure);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const module = (await import(fauxSpecifier)) as typeof import("@earendil-works/pi-ai/providers/faux");
  const faux = module.createFauxCore({
    api: `web-search-${crypto.randomUUID()}`,
    provider: `web-search-${crypto.randomUUID()}`,
    models: [{ id: "fixture", contextWindow: 100_000, maxTokens: 4000 }],
  });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
  const registry = new ModelRegistry(runtime);
  const registerFaux = () =>
    registry.registerProvider(faux.provider, {
      api: faux.api,
      apiKey: "fixture",
      baseUrl: "http://localhost",
      streamSimple: faux.streamSimple,
      models: faux.models,
    });
  registerFaux();
  const model = registry.find(faux.provider, "fixture");
  assert.ok(model);
  const settingsManager = SettingsManager.inMemory({
    defaultTools: ["+codemode"],
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    additionalExtensionPaths: [resolve("packages/pi-web-search"), "builtin:codemode"],
    extensionFactories: [{ name: "codemode", builtin: true, factory: createCodemodeExtension({ models: false }) }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    resourceLoader: loader,
    modelRuntime: runtime,
    model,
    settingsManager,
    sessionManager: SessionManager.inMemory(root),
  });
  const errors: unknown[] = [];
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
  return {
    root,
    path,
    session,
    faux,
    module,
    configure,
    registerFaux,
    errors,
    async close() {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    },
  };
}

const matrix = {
  codemode: { active: false, callable: true, inline: true },
  direct: { active: true, callable: true, inline: false },
  deferred: { active: false, callable: true, inline: false },
  "model-only": { active: true, callable: false, inline: false },
  hidden: { active: false, callable: false, inline: false },
};

test.each(EXPOSURES)("Jiti-loaded exposure %s follows Pi's real active/callable/inline branches", async (exposure) => {
  const h = await harness(exposure);
  try {
    assert.equal(h.session.getAllTools().find((tool) => tool.name === "web_search")?.exposure, exposure);
    assert.equal(h.session.getActiveToolNames().includes("web_search"), matrix[exposure].active);
    assert.equal(h.session.getCallableToolNames().includes("web_search"), matrix[exposure].callable);
    assert.equal(
      h.session.agent.state.tools.find((tool) => tool.name === "codemode")?.description.includes("web_search"),
      matrix[exposure].inline,
    );
    if (exposure !== "hidden") {
      h.session.setActiveToolsByName([...h.session.getActiveToolNames(), "web_search"]);
      assert.ok(h.session.getActiveToolNames().includes("web_search"));
      assert.equal(h.session.getCallableToolNames().includes("web_search"), exposure !== "model-only");
      h.session.setActiveToolsByName(h.session.getActiveToolNames().filter((name) => name !== "web_search"));
      assert.equal(
        h.session.getCallableToolNames().includes("web_search"),
        exposure === "codemode" || exposure === "deferred",
      );
    }
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("all explicit exposure transitions change only our declaration and reload user settings", async () => {
  const h = await harness();
  try {
    const other = h.session.getActiveToolNames();
    for (const from of EXPOSURES) {
      await h.configure(from);
      await h.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
      for (const to of EXPOSURES) {
        await h.configure(to);
        await h.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
        assert.equal(h.session.getActiveToolNames().includes("web_search"), matrix[to].active, `${from} -> ${to}`);
        assert.equal(h.session.getCallableToolNames().includes("web_search"), matrix[to].callable, `${from} -> ${to}`);
        assert.deepEqual(
          h.session.getActiveToolNames().filter((name) => name !== "web_search"),
          other,
        );
        await h.configure(from);
        await h.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
      }
    }
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test.each(EXPOSURES)("real AgentSession.reload reconciles every transition from %s", async (from) => {
  const h = await harness(from);
  try {
    const other = h.session.getActiveToolNames().filter((name) => name !== "web_search");
    for (const to of EXPOSURES) {
      await h.configure(from);
      await h.session.reload();
      if (from !== "hidden") h.session.setActiveToolsByName([...h.session.getActiveToolNames(), "web_search"]);
      await h.configure(to);
      await h.session.reload();
      assert.equal(h.session.getAllTools().find((tool) => tool.name === "web_search")?.exposure, to);
      assert.equal(h.session.getActiveToolNames().includes("web_search"), matrix[to].active, `${from} -> ${to}`);
      assert.equal(h.session.getCallableToolNames().includes("web_search"), matrix[to].callable, `${from} -> ${to}`);
      assert.deepEqual(
        h.session.getActiveToolNames().filter((name) => name !== "web_search"),
        other,
      );
    }
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test.each(["codemode", "deferred"] as const)(
  "non-reload session start preserves explicit %s activation",
  async (exposure) => {
    const h = await harness(exposure);
    try {
      h.session.setActiveToolsByName([...h.session.getActiveToolNames(), "web_search"]);
      const active = h.session.getActiveToolNames();
      await h.session.extensionRunner.emit({ type: "session_start", reason: "new" });
      assert.deepEqual(h.session.getActiveToolNames(), active);
      assert.deepEqual(h.errors, []);
    } finally {
      await h.close();
    }
  },
);

test("Codemode discovers web_search, receives structured data, and preserves ordinary request prefixes", async () => {
  const h = await harness();
  const contexts: TranscriptContext["messages"][] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [{ url: "https://example.com/", title: "Example" }],
            metadata: { requestId: "fixture" },
          }),
        ),
    ),
  );
  try {
    const capture = (answer: ReturnType<typeof h.module.fauxAssistantMessage>) => (context: TranscriptContext) => {
      contexts.push(structuredClone(context.messages));
      return answer;
    };
    h.faux.setResponses([
      capture(
        h.module.fauxAssistantMessage(
          h.module.fauxToolCall("codemode", {
            code: 'const matches = await searchTools("web_search"); const definition = await describeTool("web_search"); const result = await tools.web_search({query:"current information"}); return {found:matches.some(t=>t.name==="web_search"),defined:!!definition,provider:result.provider,url:result.items[0].url};',
          }),
        ),
      ),
      capture(h.module.fauxAssistantMessage("done")),
      capture(h.module.fauxAssistantMessage("second turn")),
    ]);
    const active = h.session.getActiveToolNames();
    await h.session.prompt("Search the web.");
    await h.session.prompt("Continue without changing tools.");
    assert.equal(h.faux.state.callCount, 3);
    const messages = h.session.agent.state.messages;
    const result = messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
    assert.ok(result && result.role === "toolResult");
    assert.equal(result.isError, false);
    assert.match(JSON.stringify(result.content), /found.*true/);
    assert.match(JSON.stringify(result.content), /example.com/);
    assert.match(JSON.stringify(result.content), /ceramic/);
    assert.doesNotMatch(JSON.stringify(messages), /TOP_SECRET/);
    assert.deepEqual(h.session.getActiveToolNames(), active);
    const first = normalizedMessages(contexts[0]);
    assert.deepEqual(normalizedMessages(contexts[1]).slice(0, first.length), first);
    assert.deepEqual(normalizedMessages(contexts[2]).slice(0, first.length), first);
    assert.deepEqual(h.errors, []);
  } finally {
    vi.unstubAllGlobals();
    await h.close();
  }
});

test.each(EXPOSURES)(
  "ordinary provider-visible prefixes stay stable after an explicit %s transition",
  async (exposure) => {
    const h = await harness();
    const contexts: TranscriptContext["messages"][] = [];
    try {
      h.faux.setResponses(
        Array.from({ length: 3 }, () => (context: TranscriptContext) => {
          contexts.push(structuredClone(context.messages));
          return h.module.fauxAssistantMessage("done");
        }),
      );
      await h.session.prompt("Before explicit exposure transition.");
      await h.configure(exposure);
      await h.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
      await h.session.prompt("First request in the new prefix epoch.");
      const active = h.session.getActiveToolNames();
      await h.session.prompt("Ordinary turn in the same epoch.");
      assert.equal(contexts.length, 3);
      const baseline = normalizedMessages(contexts[1]);
      assert.deepEqual(normalizedMessages(contexts[2]).slice(0, baseline.length), baseline);
      assert.deepEqual(h.session.getActiveToolNames(), active);
      assert.equal(active.includes("web_search"), matrix[exposure].active);
      assert.deepEqual(h.errors, []);
    } finally {
      await h.close();
    }
  },
);

test.each(EXPOSURES)("real reload to %s preserves ordinary provider prefixes in the new epoch", async (exposure) => {
  const h = await harness("direct");
  const contexts: TranscriptContext["messages"][] = [];
  try {
    h.faux.setResponses(
      Array.from({ length: 3 }, () => (context: TranscriptContext) => {
        contexts.push(structuredClone(context.messages));
        return h.module.fauxAssistantMessage("done");
      }),
    );
    await h.session.prompt("Before real reload.");
    await h.configure(exposure);
    await h.session.reload();
    // Pi reload intentionally resets provider registrations; restore only the test provider.
    h.registerFaux();
    await h.session.prompt("First turn after real reload.");
    const active = h.session.getActiveToolNames();
    await h.session.prompt("Ordinary turn in the same epoch.");
    assert.equal(contexts.length, 3);
    const baseline = normalizedMessages(contexts[1]);
    assert.deepEqual(normalizedMessages(contexts[2]).slice(0, baseline.length), baseline);
    assert.deepEqual(h.session.getActiveToolNames(), active);
    assert.equal(active.includes("web_search"), matrix[exposure].active);
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("print-mode slash command has observable help, rejects arguments and does not call a model", async () => {
  const h = await harness();
  try {
    await h.session.prompt("/web-search");
    await h.session.prompt("/web-search invalid trailing");
    assert.equal(h.faux.state.callCount, 0);
    assert.match(JSON.stringify(h.errors), /Interactive settings are available in TUI mode only/);
    assert.match(JSON.stringify(h.errors), /does not accept arguments/);
    assert.doesNotMatch(JSON.stringify(h.errors), /TOP_SECRET/);
    assert.equal(h.errors.length, 2);
  } finally {
    await h.close();
  }
});
