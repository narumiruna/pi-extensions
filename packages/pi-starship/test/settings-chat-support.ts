import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { type Component, type OverlayHandle, type TUI, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import { FullscreenTerminal, fullscreenMounted } from "./settings-chat-fullscreen-support.js";

/** Keep menu tests on Kit, but route fullscreen chat through native terminal dispatch. */
export function settingsChatCustom(
  custom: ExtensionCommandContext["ui"]["custom"],
  onOptions?: (options: unknown) => void,
  onFullscreen?: (runtime: { terminal: FullscreenTerminal; child: TuiAltScreen; parent: TuiMainScreen }) => void,
): ExtensionCommandContext["ui"]["custom"] {
  initTheme("dark", false);
  return (factory, options) => {
    onOptions?.(options);
    if (!options?.overlay) return custom(factory);
    return custom(async (harnessTui, theme, keys, done) => {
      const terminal = new FullscreenTerminal();
      const syncDimensions = () => {
        terminal.rows = harnessTui.terminal.rows;
        terminal.columns = harnessTui.terminal.columns;
      };
      syncDimensions();
      const parent = new TuiMainScreen(terminal);
      parent.start();
      let child: TuiAltScreen | undefined;
      let root: (Component & { dispose?(): void; waitForPending?(): Promise<void> }) | undefined;
      let handle: OverlayHandle | undefined;
      const start = TuiAltScreen.prototype.start;
      const capture = vi.spyOn(TuiAltScreen.prototype, "start").mockImplementation(function (this: TuiAltScreen) {
        child = this;
        start.call(this);
      });
      const host = await factory(parent as TUI, theme, keys, (value) => {
        handle?.hide();
        parent.stop({ preserveScreen: true });
        capture.mockRestore();
        done(value);
      });
      handle = parent.showOverlay(host);
      options.onHandle?.(handle);
      await fullscreenMounted();
      capture.mockRestore();
      root = child?.getFocusedComponent() ?? undefined;
      if (child) onFullscreen?.({ terminal, child, parent });
      return {
        get focused() {
          return root && "focused" in root ? Boolean(root.focused) : false;
        },
        set focused(value: boolean) {
          if (root && "focused" in root) root.focused = value;
        },
        render() {
          syncDimensions();
          child?.renderNow(false);
          return child?.getScreenLines() ?? [];
        },
        handleInput(data: string) {
          terminal.input(data);
        },
        handleMouse(event) {
          const button = event.type === "wheel" ? (event.wheelDelta && event.wheelDelta < 0 ? 64 : 65) : 0;
          terminal.input(`\x1b[<${button};${event.x + 1};${event.y + 1}M`);
          if (event.type === "click") terminal.input(`\x1b[<${button};${event.x + 1};${event.y + 1}m`);
          return { handled: true };
        },
        invalidate() {
          root?.invalidate();
        },
        async waitForPending() {
          await root?.waitForPending?.();
        },
        dispose() {
          host.dispose?.();
        },
      };
    });
  };
}

export const testModel = {
  id: "configuration-test",
  name: "Configuration test",
  api: "openai-completions",
  provider: "configuration-test",
  baseUrl: "http://unused.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as const;
export function response(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content,
    api: testModel.api,
    provider: testModel.provider,
    model: testModel.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
  stream.push({ type: "done", reason: stopReason as "stop" | "length" | "toolUse", message });
  return stream;
}
