import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  type TranscriptContext,
  toToolDeclaration,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionUIContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { INLINE_FORMATTING_PROMPT } from "../src/prompt.js";

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
type Request = ReturnType<typeof captureRequest>;
const CUSTOM_HINT = "Use the runtime fixture format.\n  Keep this line indented.";
const promptSection = (text: string) => `<inline_formatting>\n${text}\n</inline_formatting>`;
const question = (turn: number) => `Fixture question ${turn}`;
const answer = (turn: number) => `Fixture answer ${turn}`;

// The faux provider receives Pi's structured request before any wire adapter.
// Compare model content, not timestamps, usage, IDs, or executable tools.
function captureRequest({ messages }: TranscriptContext) {
  return {
    prompt: getCurrentSystemPrompt(messages),
    tools: getCurrentTools(messages).map(toToolDeclaration),
    messages: messages.map((message) => {
      const { role, content } = message;
      if (role === "system") {
        return JSON.stringify({
          role,
          content,
          sections: message.sections,
          toolsAdded: message.toolsAdded?.map(toToolDeclaration),
          toolsRemoved: message.toolsRemoved?.map(({ name }) => ({ name })),
        });
      }
      if (role === "user" || role === "assistant") return JSON.stringify({ role, content });
      throw new Error(`Unexpected role in the text-only fixture: ${role}`);
    }),
  };
}

function expectNextTurn(previous: Request, next: Request, turn: number, patch?: string | null) {
  expect(JSON.stringify(next.tools)).toBe(JSON.stringify(previous.tools));
  expect(next.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
  expect(next.messages.slice(previous.messages.length)).toEqual([
    JSON.stringify({ role: "assistant", content: [{ type: "text", text: answer(turn - 1) }] }),
    ...(patch === undefined
      ? []
      : [JSON.stringify({ role: "system", content: "", sections: { inline_formatting: patch } })]),
    JSON.stringify({ role: "user", content: [{ type: "text", text: question(turn) }] }),
  ]);
}

test("keeps real Pi request prefixes stable and patches the hint on reload and resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-inline-runtime-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  const settingsPath = join(agentDir, "pi-inline.json");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let session: Session | undefined;
  let widget: (Component & { dispose?(): void }) | undefined;
  const errors: unknown[] = [];

  async function closeSession() {
    const current = session;
    session = undefined;
    try {
      await current?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      current?.dispose();
      widget?.dispose?.();
      widget = undefined;
    }
  }

  try {
    await Promise.all([mkdir(agentDir), mkdir(cwd)]);
    const { default: inlineExtension } = await import("../src/index.js");
    const faux = fauxProvider({ tokensPerSecond: Infinity, tokenSize: { min: 100, max: 100 } });
    const model = faux.getModel();
    assert.ok(model);
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const tools = ["read", "grep"];

    // Mount and dispose the extension's real widget, but never start the terminal.
    const tui = new TuiMainScreen(new ProcessTerminal());
    vi.spyOn(tui, "requestRender").mockImplementation(() => {});
    const ui = {
      notify(message) {
        errors.push(message);
      },
      setWidget(_key, content) {
        widget?.dispose?.();
        widget = typeof content === "function" ? content(tui, {} as Theme) : undefined;
      },
    } satisfies Pick<ExtensionUIContext, "notify" | "setWidget">;

    async function startSession(sessionManager: SessionManager) {
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noContextFiles: true,
        noSkills: true,
        noThemes: true,
        extensionFactories: [inlineExtension],
      });
      await resourceLoader.reload();
      expect(resourceLoader.getExtensions().errors).toEqual([]);
      const created = await createAgentSession({
        cwd,
        agentDir,
        sessionManager,
        settingsManager,
        resourceLoader,
        modelRuntime,
        model,
        tools,
      });
      session = created.session;
      await session.bindExtensions({
        mode: "tui",
        uiContext: ui as ExtensionUIContext,
        onError: (error) => errors.push(error),
      });
      return session;
    }

    async function request(active: Session, turn: number) {
      let captured: Request | undefined;
      faux.setResponses([
        (context) => {
          captured = captureRequest(context);
          return fauxAssistantMessage(answer(turn));
        },
      ]);
      await active.prompt(question(turn));
      expect(errors).toEqual([]);
      expect(faux.state.callCount).toBe(turn);
      expect(active.getLastAssistantText()).toBe(answer(turn));
      assert.ok(captured, "Pi sent the request to the faux provider");
      return captured;
    }

    const original = await startSession(SessionManager.create(cwd, join(root, "sessions")));
    const first = await request(original, 1);
    expect(first.prompt).toContain(promptSection(INLINE_FORMATTING_PROMPT));
    expect(first.tools.map(({ name }) => name)).toEqual(tools);

    // Saving alone does not change the active session's hint.
    await writeFile(settingsPath, JSON.stringify({ promptHintText: CUSTOM_HINT }));
    const second = await request(original, 2);
    expect(second.prompt).toBe(first.prompt);
    expectNextTurn(first, second, 2);

    const sessionPath = original.sessionFile;
    const sessionId = original.sessionId;
    assert.ok(sessionPath);
    const beforeReload = await readFile(sessionPath, "utf8");
    await original.reload();
    expect(await readFile(sessionPath, "utf8")).toBe(beforeReload);
    const edited = await request(original, 3);
    expect(edited.prompt).toBe(
      first.prompt.replace(promptSection(INLINE_FORMATTING_PROMPT), promptSection(CUSTOM_HINT)),
    );
    expectNextTurn(second, edited, 3, promptSection(CUSTOM_HINT));
    const editedNext = await request(original, 4);
    expect(editedNext.prompt).toBe(edited.prompt);
    expectNextTurn(edited, editedNext, 4);

    const beforeResume = await readFile(sessionPath, "utf8");
    expect(beforeResume.startsWith(beforeReload)).toBe(true);
    await closeSession();
    await writeFile(settingsPath, JSON.stringify({ promptHintEnabled: false, promptHintText: CUSTOM_HINT }));
    const resumed = await startSession(SessionManager.open(sessionPath));
    expect(resumed.sessionId).toBe(sessionId);
    expect(await readFile(sessionPath, "utf8")).toBe(beforeResume);

    const disabled = await request(resumed, 5);
    expect(disabled.prompt).toBe(edited.prompt.replace(`\n\n${promptSection(CUSTOM_HINT)}`, ""));
    expectNextTurn(editedNext, disabled, 5, null);
    const disabledNext = await request(resumed, 6);
    expect(disabledNext.prompt).toBe(disabled.prompt);
    expectNextTurn(disabled, disabledNext, 6);
    expect((await readFile(sessionPath, "utf8")).startsWith(beforeResume)).toBe(true);
    expect(
      resumed.sessionManager.getBranch().flatMap((entry) => {
        if (entry.type !== "message" || entry.message.role !== "system") return [];
        const patch = entry.message.sections?.inline_formatting;
        return patch === undefined ? [] : [patch];
      }),
    ).toEqual([promptSection(INLINE_FORMATTING_PROMPT), promptSection(CUSTOM_HINT), null]);
  } finally {
    try {
      await closeSession();
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  }
});
