// Test-only extension for appearance-capture.mjs; never loaded by the package.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, TuiAltScreen } from "@earendil-works/pi-tui";
import type {
  BtwAnsweringView as AnsweringComponent,
  BtwTranscriptPager as PagerComponent,
} from "../src/transcript-pager.js";

interface CaptureResult {
  state: string;
  dimensions: number[];
  nativeKind: string;
  nativeAnsi: string[];
  btwAnsi?: string[];
  native?: string[];
  btw?: string[];
}

export const question = "Explain **native spacing** 中文 🙂.";
export const answer = "Use the public message components.\n\n```ts\nconst side = true;\n```";
export function response(text = answer): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    stopReason: "stop",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

export default function appearanceFixture(pi: ExtensionAPI) {
  pi.registerFlag("appearance-config", { description: "Test-only capture input", type: "string" });
  const loadConfig = () => {
    const path = pi.getFlag("appearance-config");
    if (typeof path !== "string") throw new Error("appearance-config must name a JSON fixture");
    return JSON.parse(readFileSync(path, "utf8"));
  };
  pi.on("session_start", () => {
    const config = loadConfig();
    writeFileSync(config.ready, "ready\n");
  });
  let started: (() => void) | undefined;
  let release: (() => void) | undefined;
  pi.on("before_agent_start", async (_event, ctx) => {
    ctx.ui.setWorkingVisible(true);
    started?.();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    // Abort while the run is still starting; Pi cancels at agent_start before its request.
    ctx.abort();
  });
  pi.on("before_provider_request", () => {
    const config = loadConfig();
    writeFileSync(config.violation, "Unexpected provider request");
  });
  pi.registerCommand("appearance-capture", {
    description: "Capture deterministic appearance evidence without a provider",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") throw new Error("Appearance capture requires TUI mode");
      const config = loadConfig();
      const waiting = config.state === "waiting" || config.state === "queued";
      const draft = config.state === "multiline" ? "First line 中文\nSecond line 🙂\nThird line" : "";
      ctx.ui.setEditorText(draft);
      ctx.ui.setWorkingMessage("Answering…");
      if (waiting) {
        const ready = new Promise<void>((resolve) => {
          started = resolve;
        });
        pi.sendUserMessage("Pending 中文 🙂");
        await ready;
        if (config.state === "queued") {
          pi.sendUserMessage("Next question", { deliverAs: "steer" });
          pi.sendUserMessage("Then compare borders", { deliverAs: "steer" });
          // Drain the public sendUserMessage continuations before measuring pending rows.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      try {
        await ctx.ui.custom((nativeTui, theme, keys, done) => {
          if (!(nativeTui instanceof TuiAltScreen)) throw new Error("Capture requires native fullscreen Pi");
          nativeTui.renderNow(true);
          const result: CaptureResult = {
            state: config.state,
            dimensions: [nativeTui.terminal.columns, nativeTui.terminal.rows],
            nativeKind: "native-cli",
            nativeAnsi: nativeTui.getScreenLines(),
          };
          const capture = async () => {
            const { BtwTranscriptPager, BtwAnsweringView } = await import(
              pathToFileURL(`${config.sourceRoot}/packages/pi-btw/src/transcript-pager.ts`).href
            );
            const turns =
              config.state === "empty"
                ? []
                : config.state === "error"
                  ? [{ kind: "error", question, answer: "Fixture failure" }]
                  : [{ kind: "answered", question, answer, response: response() }];
            const terminal = {
              columns: nativeTui.terminal.columns,
              rows: nativeTui.terminal.rows,
              kittyProtocolActive: false,
              start() {},
              stop() {},
              write() {},
              hideCursor() {},
              showCursor() {},
              drainInput: async () => {},
              moveBy() {},
              clearLine() {},
              clearFromCursor() {},
              clearScreen() {},
              setTitle() {},
              setProgress() {},
              setProgramStatus() {},
            };
            const tui = new TuiAltScreen(terminal, false);
            let view: PagerComponent | AnsweringComponent | undefined;
            try {
              const thinking = { level: "medium", levels: ["off", "medium", "high"], keybindings: keys, onChange() {} };
              const options = {
                keybindings: keys,
                thinking,
                initialQuestion: draft,
                model: { provider: "anthropic", id: "claude-sonnet-4-5" },
              };
              const component: PagerComponent | AnsweringComponent = waiting
                ? new BtwAnsweringView(tui, theme, turns, "Pending 中文 🙂", () => {}, "medium", {
                    keybindings: keys,
                    model: options.model,
                    steering: {
                      questions: config.state === "queued" ? ["Next question", "Then compare borders"] : [],
                      onSubmit() {},
                      thinking,
                    },
                  })
                : new BtwTranscriptPager(tui, theme, turns, () => {}, options);
              view = component;
              if (config.state.startsWith("focus-"))
                component.setWorkspaceFocus(config.state === "focus-main" ? "main" : "side", "F6");
              tui.setLayoutRoot(component.getFullscreenLayout());
              tui.setFocus(component);
              tui.start();
              tui.renderNow(true);
              result.btwAnsi = tui.getScreenLines();
              const plain = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line).trimEnd());
              result.native = plain(result.nativeAnsi);
              result.btw = plain(result.btwAnsi);
              writeFileSync(config.output, `${JSON.stringify(result, null, 2)}\n`);
            } finally {
              view?.dispose();
              tui.stop();
              ctx.ui.setWorkingVisible(false);
              done(undefined);
            }
          };
          void capture().catch((error) => {
            writeFileSync(
              config.output,
              JSON.stringify({ error: String(error), stack: error instanceof Error ? error.stack : undefined }),
            );
            done(undefined);
          });
          return new Text("");
        });
      } finally {
        release?.();
        ctx.shutdown();
      }
    },
  });
}
