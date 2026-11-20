import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionHandler,
  ExtensionUIContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import { INLINE_FORMATTING_PROMPT } from "../src/prompt.js";
import { savePromptHint } from "../src/settings.js";
import { showInlineSettings } from "../src/settings-menu.js";

vi.mock("../src/settings-menu.js", () => ({ showInlineSettings: vi.fn() }));
vi.mock("../src/settings.js", { spy: true });

afterEach(() => vi.unstubAllEnvs());

type Menu = Parameters<typeof showInlineSettings>[1];

async function fixture(onTestFinished: (cleanup: () => void | Promise<void>) => void) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-inline-command-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  vi.stubEnv("PI_CODING_AGENT_DIR", cwd);
  const { default: extension } = await import("../src/index.js");
  const settingsPath = join(cwd, "pi-inline.json");
  const handlers = new Map<string, unknown>();
  const register = vi.fn<ExtensionAPI["registerCommand"]>();
  extension({
    on: (event: string, handler: unknown) => handlers.set(event, handler),
    registerCommand: register,
    registerMarkdownTransformer: vi.fn(),
  } as unknown as ExtensionAPI);
  const start = handlers.get("session_start") as ExtensionHandler<SessionStartEvent>;
  const shutdown = handlers.get("session_shutdown") as ExtensionHandler<SessionShutdownEvent>;
  const beforeStart = handlers.get("before_agent_start") as ExtensionHandler<BeforeAgentStartEvent>;
  const commands = new Map(register.mock.calls);
  const tui = new TuiMainScreen(new ProcessTerminal());
  vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  let widget: { dispose?(): void } | undefined;
  const confirm = vi.fn<ExtensionUIContext["confirm"]>().mockResolvedValue(false);
  const notify = vi.fn<ExtensionUIContext["notify"]>();
  const setWidget = vi.fn<ExtensionUIContext["setWidget"]>((_key, content) => {
    widget?.dispose?.();
    widget = typeof content === "function" ? content(tui, {} as ExtensionUIContext["theme"]) : undefined;
  });
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    sessionManager: {},
    ui: { confirm, notify, setWidget },
  } as unknown as ExtensionCommandContext;
  const restart = () => start({ type: "session_start", reason: "startup" }, ctx);
  const stop = async () => {
    await shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
  };
  const reload = vi.fn<ExtensionCommandContext["reload"]>(async () => {
    await shutdown({ type: "session_shutdown", reason: "reload" }, ctx);
    await start({ type: "session_start", reason: "reload" }, ctx);
  });
  ctx.reload = reload;
  const menu = vi.mocked(showInlineSettings).mockReset().mockResolvedValue(false);
  await restart();
  onTestFinished(stop);
  return {
    confirm,
    menu,
    notify,
    reload,
    restart,
    stop,
    writeSettings: (value: unknown) => writeFile(settingsPath, JSON.stringify(value)),
    readSettings: async () => JSON.parse(await readFile(settingsPath, "utf8")) as unknown,
    async run(route = "inline") {
      const command = commands.get(route);
      if (!command) throw new Error(`Unregistered command: ${route}`);
      await command.handler("", ctx);
    },
    async currentHint() {
      const options: BeforeAgentStartEvent["systemPromptOptions"] = {
        cwd,
        selectedTools: [],
        hiddenTools: [],
        toolSnippets: {},
        toolGuidelines: {},
        promptGuidelines: [],
        appendSystemPrompt: "",
        sections: {},
        contextFiles: [],
        skills: [],
      };
      await beforeStart(
        {
          type: "before_agent_start",
          messageType: "user",
          prompt: "test",
          systemPrompt: "",
          systemPromptOptions: options,
        },
        ctx,
      );
      return options.sections.inline_formatting;
    },
  };
}

test("saves a changed toggle before asking and keeps the active hint when reload is declined", async ({
  onTestFinished,
}) => {
  const host = await fixture(onTestFinished);
  host.menu.mockImplementationOnce(async (_, options) =>
    options.save({ key: "promptHintEnabled", value: false }, options.signal),
  );
  let savedAtConfirm: unknown;
  host.confirm.mockImplementationOnce(async () => {
    savedAtConfirm = await host.readSettings();
    return false;
  });
  await host.run("inline-markup");
  expect(host.confirm).toHaveBeenCalledOnce();
  expect(savedAtConfirm).toEqual({ promptHintEnabled: false });
  expect(host.reload).not.toHaveBeenCalled();
  expect(await host.currentHint()).toBe(INLINE_FORMATTING_PROMPT);

  await host.run();
  expect(host.menu).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({
      saved: { enabled: false, text: INLINE_FORMATTING_PROMPT },
      active: { enabled: true, text: INLINE_FORMATTING_PROMPT },
    }),
  );
  await host.restart();
  expect(await host.currentHint()).toBeUndefined();
});

test("does not ask for reload for an unchanged value or a cancelled menu", async ({ onTestFinished }) => {
  const host = await fixture(onTestFinished);
  await host.run();
  host.menu.mockImplementationOnce(async (_, options) =>
    options.save({ key: "promptHintEnabled", value: true }, options.signal),
  );
  await host.run();
  await expect(host.readSettings()).rejects.toMatchObject({ code: "ENOENT" });
  expect(host.confirm).not.toHaveBeenCalled();
  expect(host.reload).not.toHaveBeenCalled();
});

test("reports a save that committed during hard cancel without reopening the UI", async ({ onTestFinished }) => {
  const host = await fixture(onTestFinished);
  host.menu.mockImplementationOnce(async (_, options) => {
    await options.save({ key: "promptHintEnabled", value: false }, options.signal);
    return "saved-after-cancel";
  });
  await host.run();
  expect(await host.readSettings()).toEqual({ promptHintEnabled: false });
  expect(host.notify).toHaveBeenCalledExactlyOnceWith("The prompt hint was saved. Run /reload to apply it.", "info");
  expect(host.confirm).not.toHaveBeenCalled();
  expect(host.reload).not.toHaveBeenCalled();
  expect(await host.currentHint()).toBe(INLINE_FORMATTING_PROMPT);
});

test("loads saved text on accepted reload and reports a failed reload without applying it", async ({
  onTestFinished,
}) => {
  const host = await fixture(onTestFinished);
  const first = "First hint.\nUse local citations.";
  const second = "Second hint.";
  host.confirm.mockResolvedValue(true);
  host.reload.mockRejectedValueOnce(new Error("unavailable"));
  host.menu.mockImplementationOnce(async (_, options) =>
    options.save({ key: "promptHintText", value: first }, options.signal),
  );
  await host.run();
  expect(await host.readSettings()).toEqual({ promptHintText: first });
  expect(host.notify).toHaveBeenCalledWith(expect.stringContaining("Run /reload"), "error");
  expect(await host.currentHint()).toBe(INLINE_FORMATTING_PROMPT);
  host.menu.mockImplementationOnce(async (_, options) =>
    options.save({ key: "promptHintText", value: second }, options.signal),
  );
  await host.run();
  expect(host.reload).toHaveBeenCalledTimes(2);
  expect(host.confirm).toHaveBeenCalledTimes(2);
  expect(await host.currentHint()).toBe(second);
});

test("ignores a confirmed reload from a replaced session", async ({ onTestFinished }) => {
  const host = await fixture(onTestFinished);
  const question = Promise.withResolvers<AbortSignal | undefined>();
  const answer = Promise.withResolvers<boolean>();
  host.menu.mockImplementationOnce(async (_, options) =>
    options.save({ key: "promptHintEnabled", value: false }, options.signal),
  );
  host.confirm.mockImplementationOnce(async (_title, _message, options) => {
    question.resolve(options?.signal);
    return answer.promise;
  });
  const command = host.run();
  const signal = await question.promise;
  expect(signal?.aborted).toBe(false);
  await host.restart();
  expect(signal?.aborted).toBe(true);
  answer.resolve(true);
  await command;
  expect(host.reload).not.toHaveBeenCalled();
  expect(await host.currentHint()).toBeUndefined();
});

test("shutdown waits for a publishing write and never asks to reload the old session", async ({ onTestFinished }) => {
  const host = await fixture(onTestFinished);
  const publication = Promise.withResolvers<boolean>();
  const writing = Promise.withResolvers<Menu>();
  vi.mocked(savePromptHint).mockReturnValueOnce(publication.promise);
  host.menu.mockImplementationOnce(async (_, options) => {
    const result = options.save({ key: "promptHintEnabled", value: false }, options.signal);
    writing.resolve(options);
    return result;
  });
  const command = host.run();
  const activeMenu = await writing.promise;
  const stopped = vi.fn();
  const shutdown = host.stop().then(stopped);
  expect(activeMenu.signal.aborted).toBe(true);
  await Promise.resolve();
  expect(stopped).not.toHaveBeenCalled();
  publication.resolve(true);
  await Promise.all([command, shutdown]);
  expect(stopped).toHaveBeenCalledOnce();
  expect(host.confirm).not.toHaveBeenCalled();
});
