import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionHandler,
  ExtensionUIContext,
  MarkdownTransformContext,
  MarkdownTransformer,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { type Component, ProcessTerminal, rgbColor, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { expect, vi } from "vitest";
import { showInlineSettings } from "../src/settings-menu.js";

export const previewTheme = {
  colors: new Proxy({}, { get: () => rgbColor(88, 60, 137) }),
  getBgAnsi: () => "",
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  style: (text: string) => text,
} as unknown as ExtensionUIContext["theme"];

export async function startInlineSession(
  extension: typeof import("../src/index.js").default,
  cwd: string,
  tui: TUI = new TuiMainScreen(new ProcessTerminal()),
) {
  const on = vi.fn<(event: string, handler: unknown) => void>();
  const registerMarkdownTransformer = vi.fn<(transform: MarkdownTransformer) => void>();
  const registerCommand = vi.fn<ExtensionAPI["registerCommand"]>();
  extension({ on, registerCommand, registerMarkdownTransformer } as unknown as ExtensionAPI);
  const start = on.mock.calls.find(([event]) => event === "session_start")?.[1] as ExtensionHandler<SessionStartEvent>;
  const shutdown = on.mock.calls.find(
    ([event]) => event === "session_shutdown",
  )?.[1] as ExtensionHandler<SessionShutdownEvent>;
  const beforeAgentStart = on.mock.calls.find(
    ([event]) => event === "before_agent_start",
  )?.[1] as ExtensionHandler<BeforeAgentStartEvent>;
  const invalidate = vi.spyOn(tui, "invalidate");
  const requestRender = vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  let widget: (Component & { dispose?(): void }) | undefined;
  const setWidget = vi.fn<ExtensionUIContext["setWidget"]>((_key, content) => {
    widget?.dispose?.();
    widget = typeof content === "function" ? content(tui, previewTheme) : undefined;
  });
  const settings = vi.mocked(showInlineSettings).mockReset().mockResolvedValue(false);
  const ctx = { cwd, mode: "tui", sessionManager: {}, ui: { setWidget } } as unknown as ExtensionCommandContext;
  const startWidget = (mode: ExtensionContext["mode"] = "tui") =>
    start({ type: "session_start", reason: "startup" }, { ...ctx, mode });
  await startWidget();
  const commands = new Map(registerCommand.mock.calls);
  expect([...commands.keys()]).toEqual(["inline"]);
  expect(registerMarkdownTransformer).toHaveBeenCalledOnce();
  expect(setWidget).toHaveBeenCalledOnce();
  const [[transform]] = registerMarkdownTransformer.mock.calls;

  return {
    invalidate,
    requestRender,
    settings,
    setWidget,
    startWidget,
    renderWidget: (width: number) => widget?.render(width) ?? [],
    runCommand: (args = "", mode: ExtensionContext["mode"] = "tui") =>
      commands.get("inline")?.handler(args, { ...ctx, mode }),
    setWikilinks(enabled: boolean) {
      settings.mockImplementationOnce(async (_ctx, { setWikilinks }) => {
        setWikilinks(enabled);
        return false;
      });
      return commands.get("inline")?.handler("", ctx);
    },
    render(markdown: string, messageType: MarkdownTransformContext["messageType"] = "user") {
      return transform(markdown, { messageType, isStreaming: false, availableWidth: 80 });
    },
    async promptSections(mode: ExtensionContext["mode"] = "tui") {
      const systemPromptOptions: BeforeAgentStartEvent["systemPromptOptions"] = {
        cwd: ctx.cwd,
        selectedTools: [],
        hiddenTools: [],
        toolSnippets: {},
        toolGuidelines: {},
        promptGuidelines: [],
        appendSystemPrompt: "",
        sections: { other: "Keep this section." },
        contextFiles: [],
        skills: [],
      };
      await beforeAgentStart(
        { type: "before_agent_start", messageType: "user", prompt: "test", systemPrompt: "", systemPromptOptions },
        { ...ctx, mode },
      );
      return systemPromptOptions.sections;
    },
    stop: () => shutdown({ type: "session_shutdown", reason: "quit" }, ctx),
  };
}

export function stubRawInput(): () => void {
  const raw = Object.getOwnPropertyDescriptor(process.stdin, "isRaw");
  Object.defineProperty(process.stdin, "isRaw", { configurable: true, value: true });
  return () => {
    if (raw) Object.defineProperty(process.stdin, "isRaw", raw);
    else Reflect.deleteProperty(process.stdin, "isRaw");
  };
}
