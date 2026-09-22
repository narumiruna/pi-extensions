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
  MAX_SCAN_DEPTH,
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

test("embedded AgentSession streams, invokes scoped current-note tools, persists, and leaves parent state unchanged", async () => {
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

test.each([
  {
    toolName: "edit_current_note",
    mutationArguments: (revision: string) => ({
      revision,
      oldText: "old text",
      newText: "renamed and edited",
    }),
    expectedContent: "# Current\n\nrenamed and edited\n",
  },
  {
    toolName: "replace_current_note",
    mutationArguments: (revision: string) => ({ revision, content: "# Renamed and replaced\n" }),
    expectedContent: "# Renamed and replaced\n",
  },
] as const)(
  "embedded AgentSession serializes a rename-first $toolName batch against the renamed path",
  async ({ toolName, mutationArguments, expectedContent }) => {
    const { agentDir, storage } = await fixture();
    const { runtime, faux, model } = await fauxRuntime();
    const initial = await storage.readNote("current.md");
    const newPath = `topics/${toolName}.md`;
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("rename_current_note", {
          revision: initial.revision,
          newPath,
        }),
        fauxToolCall(toolName, mutationArguments(initial.revision)),
      ]),
      fauxAssistantMessage("Renamed and updated the note."),
    ]);
    const noteChanges: string[] = [];
    const child = await createNotesChildSession(
      {
        agentDir,
        storage,
        notePath: "current.md",
        parentModel: model,
        thinkingLevel: "off",
        onNoteChanged: ({ relativePath }) => noteChanges.push(relativePath),
      },
      { createModelRuntime: async () => runtime },
    );

    try {
      assert.match(child.session.systemPrompt, /call rename_current_note first/iu);
      assert.match(child.session.systemPrompt, /calls execute in source order/iu);
      await child.session.prompt("Rename and update the note in one response.", { expandPromptTemplates: false });
      await assert.rejects(storage.readNote("current.md"), /ENOENT|no such/iu);
      assert.equal((await storage.readNote(newPath)).content, expectedContent);
      assert.deepEqual(noteChanges, [newPath, newPath]);
      const toolResults = child.session.messages.filter((message) => message.role === "toolResult");
      assert.deepEqual(
        toolResults.map(({ toolName: resultToolName }) => resultToolName),
        ["rename_current_note", toolName],
      );
      assert.equal(
        toolResults.every(({ isError }) => !isError),
        true,
      );
    } finally {
      child.session.dispose();
    }
  },
);

test("current-note tools enforce revisions, keep the source path implicit, and follow a successful rename", async () => {
  const { storage } = await fixture();
  const tools = createCurrentNoteTools(storage, "current.md", () => {
    throw new Error("render callback failed after publication");
  });
  assert.deepEqual(
    tools.map(({ name }) => name),
    CHILD_TOOL_NAMES,
  );
  for (const tool of tools.slice(0, 3)) assert.doesNotMatch(JSON.stringify(tool.parameters), /path/iu);
  assert.match(JSON.stringify(tools[3]?.parameters), /newPath/u);
  assert.match(JSON.stringify(tools[3]?.parameters), new RegExp(`at most ${MAX_SCAN_DEPTH}`, "u"));
  assert.doesNotMatch(JSON.stringify(tools[3]?.parameters), /sourcePath|oldPath/iu);
  assert.equal(tools[3]?.executionMode, "sequential");

  const readTool = tools[0];
  assert.ok(readTool);
  const read = await readTool.execute("read", {}, undefined, undefined, {} as never);
  const text = read.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  assert.match(text, /Path: current\.md/u);
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

  const edited = await storage.readNote("current.md");
  const renameTool = tools[3];
  assert.ok(renameTool);
  const rename = await renameTool.execute(
    "rename",
    { revision: edited.revision, newPath: "topics/bounded-note.md" },
    undefined,
    undefined,
    {} as never,
  );
  const renameText = rename.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  assert.match(renameText, /current\.md.*topics\/bounded-note\.md/iu);
  assert.ok(Buffer.byteLength(renameText, "utf8") < 50_000);
  await assert.rejects(storage.readNote("current.md"), /ENOENT|no such/iu);

  const afterRename = await readTool.execute("read-renamed", {}, undefined, undefined, {} as never);
  const afterRenameText = afterRename.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  assert.match(afterRenameText, /Path: topics\/bounded-note\.md/u);
  const renamed = await storage.readNote("topics/bounded-note.md");
  const replaceTool = tools[2];
  assert.ok(replaceTool);
  await replaceTool.execute(
    "replace-renamed",
    { revision: renamed.revision, content: "# Renamed\n" },
    undefined,
    undefined,
    {} as never,
  );

  assert.equal((await storage.readNote("topics/bounded-note.md")).content, "# Renamed\n");
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

test("workspace cancellation interrupts embedded prompt authentication", async () => {
  const { agentDir, storage } = await fixture();
  const { runtime, model } = await fauxRuntime();
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  let signalAuthStarted!: () => void;
  const authStarted = new Promise<void>((resolve) => {
    signalAuthStarted = resolve;
  });
  runtime.hasConfiguredAuth = () => false;
  runtime.checkAuth = async (_providerId, options) => {
    receivedSignal = options?.signal;
    signalAuthStarted();
    return await new Promise<never>(() => {});
  };
  const child = await createNotesChildSession(
    {
      agentDir,
      storage,
      notePath: "current.md",
      parentModel: model,
      thinkingLevel: "off",
      signal: controller.signal,
    },
    { createModelRuntime: async () => runtime },
  );
  try {
    const prompt = child.session.prompt("Wait for authentication.", { expandPromptTemplates: false });
    await authStarted;
    controller.abort(new DOMException("workspace closed", "AbortError"));
    await assert.rejects(prompt, /workspace closed/iu);
    assert.equal(receivedSignal?.aborted, true);
  } finally {
    child.session.dispose();
  }
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
