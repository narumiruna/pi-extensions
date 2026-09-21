import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, test } from "vitest";
import { createCurrentNoteTools, createNotesChildSession, noteSessionKey } from "../src/child-session.js";
import {
  CHILD_TOOL_NAMES,
  MAX_MARKDOWN_BYTES,
  MAX_SESSION_FILES_PER_NOTE,
  NOTES_SYSTEM_PROMPT,
} from "../src/constants.js";
import { NotesStorage } from "../src/storage.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-notes-child-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const storage = new NotesStorage(agentDir);
  await storage.initialize();
  await writeFile(join(storage.paths.notes, "current.md"), "# Current\n\nold text\n", "utf8");
  await writeFile(join(storage.paths.notes, "other.md"), "# Other\n", "utf8");
  return { root, agentDir, storage };
}

async function fauxRuntime() {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
  const faux = createFauxCore({
    api: `pi-notes-faux-${crypto.randomUUID()}`,
    provider: `pi-notes-faux-${crypto.randomUUID()}`,
  });
  runtime.registerProvider(faux.getModel().provider, {
    api: faux.api,
    apiKey: "notes-test",
    baseUrl: "http://localhost",
    streamSimple: faux.streamSimple,
    models: faux.models.map((model) => ({
      id: model.id,
      name: model.name,
      api: model.api,
      baseUrl: model.baseUrl,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  });
  const model = runtime.getModel(faux.getModel().provider, faux.getModel().id);
  assert.ok(model);
  return { runtime, faux, model };
}

test("embedded AgentSession streams, invokes pathless current-note tools, persists, and leaves parent state unchanged", async () => {
  const { agentDir, storage } = await fixture();
  const { runtime, faux, model } = await fauxRuntime();
  const initial = await storage.readNote("current.md");
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read_current_note", {})),
    fauxAssistantMessage(
      fauxToolCall("edit_current_note", {
        revision: initial.revision,
        oldText: "old text",
        newText: "new text",
      }),
    ),
    fauxAssistantMessage("Updated the note."),
  ]);
  const parentState = { messages: ["parent"], tools: ["read", "edit"] };
  const baseline = structuredClone(parentState);
  const noteChanges: string[] = [];
  const child = await createNotesChildSession(
    {
      agentDir,
      storage,
      notePath: "current.md",
      parentModel: model,
      thinkingLevel: "off",
      onNoteChanged: ({ revision }) => noteChanges.push(revision),
    },
    { createModelRuntime: async () => runtime },
  );
  const events: string[] = [];
  const unsubscribe = child.session.subscribe((event) => events.push(event.type));
  try {
    assert.equal(child.resumed, false);
    assert.deepEqual(child.session.getActiveToolNames(), CHILD_TOOL_NAMES);
    assert.equal(child.session.systemPrompt, expectedSystemPrompt(storage.paths.notes));
    assert.deepEqual(child.session.promptTemplates, []);
    assert.deepEqual(parentState, baseline);
    await child.session.prompt("Read the note and update old text.", { expandPromptTemplates: false });
    assert.equal((await storage.readNote("current.md")).content, "# Current\n\nnew text\n");
    assert.equal(await readFile(join(storage.paths.notes, "other.md"), "utf8"), "# Other\n");
    assert.equal(noteChanges.length, 1);
    assert.ok(events.includes("message_update"));
    assert.ok(events.includes("tool_execution_end"));
    assert.deepEqual(parentState, baseline);
    await child.session.abort();
  } finally {
    unsubscribe();
    child.session.dispose();
  }

  const resumed = await createNotesChildSession(
    {
      agentDir,
      storage,
      notePath: "current.md",
      parentModel: model,
      thinkingLevel: "off",
    },
    { createModelRuntime: async () => runtime },
  );
  try {
    assert.equal(resumed.resumed, true);
    assert.ok(resumed.session.messages.some((message) => message.role === "user"));
  } finally {
    resumed.session.dispose();
  }
});

test("tool definitions have no path parameter, enforce revisions, and keep output bounded", async () => {
  const { storage } = await fixture();
  const tools = createCurrentNoteTools(storage, "current.md", () => {
    throw new Error("render callback failed after publication");
  });
  assert.deepEqual(
    tools.map(({ name }) => name),
    CHILD_TOOL_NAMES,
  );
  for (const tool of tools) assert.doesNotMatch(JSON.stringify(tool.parameters), /path/iu);

  const readTool = tools[0];
  assert.ok(readTool);
  const read = await readTool.execute("read", {}, undefined, undefined, {} as never);
  const text = read.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  assert.ok(Buffer.byteLength(text, "utf8") < 50_000);
  const initial = await storage.readNote("current.md");
  const editTool = tools[1];
  assert.ok(editTool);
  await editTool.execute(
    "edit",
    { revision: initial.revision, oldText: "old text", newText: "bounded" },
    undefined,
    undefined,
    {} as never,
  );
  await assert.rejects(
    editTool.execute(
      "stale",
      { revision: initial.revision, oldText: "bounded", newText: "wrong" },
      undefined,
      undefined,
      {} as never,
    ),
    /stale/iu,
  );
  assert.equal((await storage.readNote("current.md")).content, "# Current\n\nbounded\n");
  assert.equal((await storage.readNote("other.md")).content, "# Other\n");
});

test("models.json providers are reconstructed while parent-only dynamic providers fail explicitly", async () => {
  const { agentDir, storage } = await fixture();
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "notes-local": {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          apiKey: "local-placeholder",
          models: [{ id: "notes-model" }],
        },
      },
    }),
    "utf8",
  );
  await mkdir(join(agentDir, "skills", "should-not-load"), { recursive: true });
  await writeFile(join(agentDir, "skills", "should-not-load", "SKILL.md"), "---\nname: hidden\n---\n", "utf8");
  await writeFile(join(agentDir, "AGENTS.md"), "MALICIOUS-CONTEXT-MARKER", "utf8");

  const configured = await createNotesChildSession({
    agentDir,
    storage,
    notePath: "current.md",
    parentModel: { provider: "notes-local", id: "notes-model", api: "openai-completions" } as Model<Api>,
    thinkingLevel: "off",
  });
  try {
    assert.equal(configured.session.model?.provider, "notes-local");
    assert.equal(configured.session.model?.id, "notes-model");
    assert.equal(configured.session.systemPrompt, expectedSystemPrompt(storage.paths.notes));
    assert.doesNotMatch(configured.session.systemPrompt, /MALICIOUS-CONTEXT-MARKER|hidden/u);
    assert.deepEqual(configured.session.promptTemplates, []);
  } finally {
    configured.session.dispose();
  }

  await assert.rejects(
    createNotesChildSession({
      agentDir,
      storage,
      notePath: "current.md",
      parentModel: {
        provider: "extension-only-provider",
        id: "extension-only-model",
        api: "extension-only-api",
      } as Model<Api>,
      thinkingLevel: "off",
    }),
    /not available.*not inherited/iu,
  );
});

test("malformed newer history is skipped without modifying the note", async () => {
  const { agentDir, storage } = await fixture();
  const { runtime, faux, model } = await fauxRuntime();
  faux.setResponses([fauxAssistantMessage("Saved history.")]);
  const first = await createNotesChildSession(
    {
      agentDir,
      storage,
      notePath: "current.md",
      parentModel: model,
      thinkingLevel: "off",
    },
    { createModelRuntime: async () => runtime },
  );
  await first.session.prompt("Persist this conversation.", { expandPromptTemplates: false });
  first.session.dispose();
  const sessionDirectory = join(storage.paths.sessions, noteSessionKey("current.md"));
  await writeFile(join(sessionDirectory, "zzzz-invalid.jsonl"), "not json\n", "utf8");

  const reopened = await createNotesChildSession(
    {
      agentDir,
      storage,
      notePath: "current.md",
      parentModel: model,
      thinkingLevel: "off",
    },
    { createModelRuntime: async () => runtime },
  );
  try {
    assert.equal(reopened.resumed, true);
    assert.match(reopened.recoveryWarning ?? "", /ignored 1 invalid/iu);
    assert.equal((await storage.readNote("current.md")).content, "# Current\n\nold text\n");
  } finally {
    reopened.session.dispose();
  }
});

function expectedSystemPrompt(notesRoot: string): string {
  return `${NOTES_SYSTEM_PROMPT}\n\n<cwd>\n${notesRoot.replaceAll("\\", "/")}\n</cwd>`;
}

test("child creation observes cancellation before runtime or session side effects", async () => {
  const { agentDir, storage } = await fixture();
  const { model } = await fauxRuntime();
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled child startup", "AbortError"));
  let runtimeCalls = 0;
  await assert.rejects(
    createNotesChildSession(
      {
        agentDir,
        storage,
        notePath: "current.md",
        parentModel: model,
        thinkingLevel: "off",
        signal: controller.signal,
      },
      {
        createModelRuntime: async () => {
          runtimeCalls += 1;
          throw new Error("must not run");
        },
      },
    ),
    /cancelled child startup/iu,
  );
  assert.equal(runtimeCalls, 0);
  assert.deepEqual(await readdirRecursive(storage.paths.sessions), []);
});

test("provider failures remain in the isolated child and do not modify either note", async () => {
  const { agentDir, storage } = await fixture();
  const { runtime, faux, model } = await fauxRuntime();
  faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "injected provider failure",
    }),
  ]);
  const child = await createNotesChildSession(
    {
      agentDir,
      storage,
      notePath: "current.md",
      parentModel: model,
      thinkingLevel: "off",
    },
    { createModelRuntime: async () => runtime },
  );
  try {
    await child.session.prompt("Fail without editing.", { expandPromptTemplates: false });
    const failure = child.session.messages.find(
      (message) => message.role === "assistant" && message.stopReason === "error",
    );
    assert.ok(failure);
    assert.equal("errorMessage" in failure, true);
    assert.match(
      "errorMessage" in failure && typeof failure.errorMessage === "string" ? failure.errorMessage : "",
      /injected provider failure/iu,
    );
    assert.equal((await storage.readNote("current.md")).content, "# Current\n\nold text\n");
    assert.equal((await storage.readNote("other.md")).content, "# Other\n");
  } finally {
    child.session.dispose();
  }
});

test("per-note session discovery rejects an excessive saved-session list", async () => {
  const { agentDir, storage } = await fixture();
  const { runtime, model } = await fauxRuntime();
  const directory = join(storage.paths.sessions, noteSessionKey("current.md"));
  await mkdir(directory);
  await Promise.all(
    Array.from({ length: MAX_SESSION_FILES_PER_NOTE + 1 }, (_, index) =>
      writeFile(join(directory, `${String(index).padStart(3, "0")}.jsonl`), "invalid\n", "utf8"),
    ),
  );
  await assert.rejects(
    createNotesChildSession(
      {
        agentDir,
        storage,
        notePath: "current.md",
        parentModel: model,
        thinkingLevel: "off",
      },
      { createModelRuntime: async () => runtime },
    ),
    new RegExp(`at most ${MAX_SESSION_FILES_PER_NOTE}`, "iu"),
  );
});

async function readdirRecursive(root: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    output.push(entry.name);
    if (entry.isDirectory()) {
      for (const child of await readdir(join(root, entry.name))) output.push(`${entry.name}/${child}`);
    }
  }
  return output;
}

test("read tool output remains below Pi limits at the maximum accepted note size", async () => {
  const { storage } = await fixture();
  const content = "x".repeat(MAX_MARKDOWN_BYTES - 1);
  await writeFile(join(storage.paths.notes, "current.md"), content, "utf8");
  const readTool = createCurrentNoteTools(storage, "current.md")[0];
  assert.ok(readTool);
  const result = await readTool.execute("read", {}, undefined, undefined, {} as never);
  const output = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  assert.ok(Buffer.byteLength(output, "utf8") < 50_000);
  assert.ok(output.split("\n").length < 2_000);
});
