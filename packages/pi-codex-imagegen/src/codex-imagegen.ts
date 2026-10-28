import { stripVTControlCharacters } from "node:util";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionUIContext,
  getAgentDir,
  resizeImage,
  type ToolDefinition,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Container, Image, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { decodeImage, preflightOutput, publishImage } from "./artifacts.js";
import { generateImageRequest, getImageAuthStatus, MAX_PROMPT_CHARS } from "./image-client.js";
import { showImagegenMenu } from "./menu.js";
import { type ImagegenSettings, SettingsStore } from "./settings.js";

const TOOL_NAME = "codex_imagegen";
const MESSAGE_TYPE = "codex-imagegen:result";
const STATUS_KEY = "codex-imagegen";
const PARAMETERS = Type.Object({
  prompt: Type.String({ minLength: 1, maxLength: MAX_PROMPT_CHARS, description: "Describe one image to generate." }),
  path: Type.String({
    description:
      "Exact destination file path, relative to the session working directory or absolute. Uses write path handling, overwrites existing files, and follows symlinks. No extension is added or changed.",
  }),
  transparentBackground: Type.Optional(
    Type.Boolean({ description: "Request a transparent background instead of the saved default." }),
  ),
});
const OUTPUT_SCHEMA = Type.Object({
  path: Type.String(),
  mimeType: Type.String(),
  width: Type.Number(),
  height: Type.Number(),
  requestId: Type.Optional(Type.String()),
});

interface ArtifactDetails {
  path: string;
  mimeType: string;
  width: number;
  height: number;
  requestId?: string;
}
interface GeneratedImage extends ArtifactDetails {
  data: string;
}
interface SessionState {
  manager: ExtensionContext["sessionManager"];
  controller: AbortController;
  store: SettingsStore;
  busy: boolean;
  menuOpen: boolean;
  ui?: Pick<ExtensionUIContext, "setStatus">;
  active?: Promise<GeneratedImage>;
  menuTask?: Promise<void>;
  runtimeCurrent(): boolean;
  watchers: number;
  watcher?: ReturnType<typeof setInterval>;
}
interface Dependencies {
  request: typeof generateImageRequest;
  publish: typeof publishImage;
  menu: typeof showImagegenMenu;
}

/** Only display text is normalized; raw prompts, paths, and result details are retained. */
export function displayText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "");
}

// Bound model-visible text separately from terminal display sanitization.
function modelText(value: string, fallback: string): string {
  const result = truncateHead(value, { maxBytes: DEFAULT_MAX_BYTES - 128, maxLines: DEFAULT_MAX_LINES - 2 });
  return result.truncated ? `${result.content || fallback}\n[Text truncated.]` : result.content;
}

export function createImagegenExtension(overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = {
    request: generateImageRequest,
    publish: publishImage,
    menu: showImagegenMenu,
    ...overrides,
  };
  return (pi: ExtensionAPI) => {
    const sessions = new Map<ExtensionContext["sessionManager"], SessionState>();
    let current: SessionState | undefined;
    let exposure: boolean | undefined;
    let lifecycleGeneration = 0;

    const isCurrent = (state: SessionState) =>
      current === state &&
      sessions.get(state.manager) === state &&
      !state.controller.signal.aborted &&
      state.runtimeCurrent();
    const retainOwnership = (state: SessionState) => {
      ++state.watchers;
      if (!state.watcher) {
        // Direct SDK AgentSession.dispose() invalidates public ctx getters without
        // emitting session_shutdown. Poll only while an owned flow is active.
        state.watcher = setInterval(() => {
          if (isCurrent(state)) return;
          state.controller.abort(new DOMException("Image generation runtime disposed", "AbortError"));
          clearInterval(state.watcher);
          state.watcher = undefined;
        }, 100);
        state.watcher.unref();
      }
      let retained = true;
      return () => {
        if (!retained) return;
        retained = false;
        if (--state.watchers === 0) {
          clearInterval(state.watcher);
          state.watcher = undefined;
        }
      };
    };
    const requireState = (ctx: ExtensionContext) => {
      const state = sessions.get(ctx.sessionManager);
      if (!state || !isCurrent(state)) throw new Error("Image generation is unavailable in this session.");
      return state;
    };
    const check = (state: SessionState, signal?: AbortSignal, tool = false) => {
      signal?.throwIfAborted();
      if (!isCurrent(state)) throw new DOMException("Image generation session changed", "AbortError");
      if (tool && !state.store.settings.toolEnabled)
        throw new Error("codex_imagegen is disabled. Enable it in /codex-imagegen Settings.");
    };

    const generate = (
      ctx: ExtensionContext,
      state: SessionState,
      params: { prompt: string; path: string; transparentBackground?: boolean },
      callerSignal: AbortSignal | undefined,
      tool: boolean,
    ): Promise<GeneratedImage> => {
      check(state, callerSignal, tool);
      if (state.busy) throw new Error("An image generation is already running in this session.");
      const { prompt, path, transparentBackground } = params;
      if (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_PROMPT_CHARS)
        throw new Error("Enter an image prompt of 1 to 32000 characters.");
      if (typeof path !== "string") throw new Error("Provide an output path for image generation.");
      const settings = state.store.settings;
      const cwd = ctx.cwd;
      const signal = callerSignal ? AbortSignal.any([state.controller.signal, callerSignal]) : state.controller.signal;
      const ownsRequest = () => isCurrent(state) && !signal.aborted && (!tool || state.store.settings.toolEnabled);
      state.busy = true;
      const releaseOwnership = retainOwnership(state);
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "Generating image");
      const task = (async () => {
        await preflightOutput({
          cwd,
          path,
          signal,
          isCurrent: ownsRequest,
        });
        check(state, signal, tool);
        const response = await dependencies.request(
          ctx.modelRegistry,
          {
            prompt,
            transparentBackground: transparentBackground ?? settings.transparentBackground,
          },
          { signal, isCurrent: ownsRequest },
        );
        check(state, signal, tool);
        const image = decodeImage(response.base64);
        const saved = await dependencies.publish(image, {
          cwd,
          path,
          signal,
          isCurrent: ownsRequest,
        });
        check(state, signal, tool);
        return {
          path: saved.path,
          data: image.bytes.toString("base64"),
          mimeType: image.mimeType,
          width: image.width,
          height: image.height,
          ...(response.requestId ? { requestId: response.requestId } : {}),
        };
      })();
      state.active = task;
      const release = () => {
        if (state.active !== task) return;
        state.active = undefined;
        state.busy = false;
        releaseOwnership();
        if (isCurrent(state) && ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
      };
      void task.then(release, release);
      return task;
    };

    const definition: ToolDefinition<typeof PARAMETERS, ArtifactDetails> = {
      name: TOOL_NAME,
      label: "Codex Image Generation",
      description:
        "Generate one image through the Codex image endpoint using Pi's OpenAI Codex OAuth login. Writes to the required exact path, overwrites existing files, and follows symlinks like write. Consumes account quota. No automatic retries. Image editing is unsupported.",
      parameters: PARAMETERS,
      outputSchema: OUTPUT_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      async execute(_id, params, signal, _onUpdate, ctx) {
        try {
          const state = requireState(ctx);
          const result = await generate(ctx, state, params, signal, true);
          check(state, signal, true);
          const { data, ...details } = result;
          return {
            content: [
              { type: "text", text: modelText(`Saved image: ${result.path}`, "Image saved. See the structured path.") },
              { type: "image", data, mimeType: result.mimeType },
            ],
            details,
            structuredContent: details,
          };
        } catch (error) {
          const original = error instanceof Error ? error.message : String(error);
          const bounded = modelText(original, "Image generation failed.");
          if (bounded !== original) throw new Error(bounded);
          throw error;
        }
      },
      renderCall(args, theme) {
        return new Text(
          `${theme.fg("toolTitle", theme.bold("Codex image"))} ${displayText(args.prompt).slice(0, 160)}`,
          0,
          0,
        );
      },
      renderResult(result, _options, theme) {
        const path = result.details?.path;
        const errorText = result.content.find((block) => block.type === "text");
        const text = path
          ? `Saved image: ${displayText(path)}`
          : displayText(errorText?.type === "text" ? errorText.text : "Image generation failed.").slice(0, 500);
        return new Text(theme.fg(path ? "success" : "error", text), 0, 0);
      },
    };
    const setExposure = (enabled: boolean, force = false) => {
      if (!force && exposure === enabled) return;
      // Explicit user setting transitions are new prefix epochs. Ordinary turns never change the loadout.
      pi.registerTool({ ...definition, exposure: enabled ? "direct" : "hidden" });
      exposure = enabled;
    };
    setExposure(false);

    pi.registerMessageRenderer<ArtifactDetails>(MESSAGE_TYPE, (message, _options, theme) => {
      const content = new Container();
      const path = typeof message.details?.path === "string" ? message.details.path : "(path unavailable)";
      content.addChild(new Text(theme.fg("success", `Saved image: ${displayText(path)}`), 0, 0));
      const image =
        typeof message.content === "string" ? undefined : message.content.find((block) => block.type === "image");
      let showImages = false;
      try {
        showImages = pi.getSettings().terminal?.showImages !== false;
      } catch {
        /* Export-only loaders have no active session. */
      }
      if (image?.type === "image" && showImages) {
        content.addChild(new Image(image.data, image.mimeType, { fallbackColor: (text) => theme.fg("muted", text) }));
      }
      return content;
    });

    const dispose = async (state: SessionState) => {
      if (isCurrent(state)) state.ui?.setStatus(STATUS_KEY, undefined);
      state.controller.abort(new DOMException("Image generation session closed", "AbortError"));
      clearInterval(state.watcher);
      state.watcher = undefined;
      await Promise.allSettled([state.active, state.menuTask, state.store.flush()]);
      if (sessions.get(state.manager) === state) sessions.delete(state.manager);
      if (current === state) current = undefined;
    };

    pi.on("session_start", async (_event, ctx) => {
      const generation = ++lifecycleGeneration;
      if (current) await dispose(current);
      if (generation !== lifecycleGeneration) return;
      const state: SessionState = {
        manager: ctx.sessionManager,
        controller: new AbortController(),
        store: new SettingsStore(getAgentDir()),
        busy: false,
        menuOpen: false,
        ui: ctx.hasUI ? ctx.ui : undefined,
        watchers: 0,
        runtimeCurrent: () => {
          try {
            return ctx.sessionManager === state.manager;
          } catch {
            return false;
          }
        },
      };
      current = state;
      sessions.set(state.manager, state);
      setExposure(false);
      try {
        const loaded = await state.store.load();
        if (!isCurrent(state)) return;
        setExposure(loaded.settings.toolEnabled);
        if (loaded.warning) {
          if (ctx.hasUI) ctx.ui.notify(loaded.warning, "warning");
          else throw new Error("Invalid image generation settings.");
        }
      } catch {
        if (!isCurrent(state)) return;
        setExposure(false);
        const message = "Could not load valid image generation settings. The tool remains disabled.";
        if (ctx.hasUI) ctx.ui.notify(message, "error");
        else throw new Error(message);
      }
    });
    pi.on("session_shutdown", async (_event, ctx) => {
      ++lifecycleGeneration;
      const state = sessions.get(ctx.sessionManager);
      if (state) await dispose(state);
    });

    pi.registerCommand("codex-imagegen", {
      description: "Generate images and manage Codex image settings",
      handler: async (args, ctx) => {
        if (args.trim()) throw new Error("/codex-imagegen accepts no arguments. Open its menu without arguments.");
        if (ctx.mode !== "tui") {
          const message =
            "/codex-imagegen requires TUI mode. Edit pi-codex-imagegen.json manually; the enabled codex_imagegen tool also works headlessly.";
          if (ctx.hasUI) {
            ctx.ui.notify(message, "warning");
            return;
          }
          throw new Error(message);
        }
        const state = requireState(ctx);
        if (!ctx.isIdle() || state.busy || state.menuOpen)
          throw new Error("Wait for the current operation before opening /codex-imagegen.");
        state.menuOpen = true;
        const releaseOwnership = retainOwnership(state);
        try {
          const menuTask = dependencies.menu(ctx, {
            signal: state.controller.signal,
            isCurrent: () => isCurrent(state),
            getSettings: () => state.store.settings,
            settingsPath: state.store.path,
            getAuthStatus: () => getImageAuthStatus(ctx.modelRegistry),
            isBusy: () => state.busy,
            saveSettings: async (patch: Partial<ImagegenSettings>) => {
              check(state);
              if (!ctx.isIdle() || state.busy) throw new Error("Settings can change only while the session is idle.");
              await state.store.save(patch, {
                signal: state.controller.signal,
                isCurrent: () => isCurrent(state) && ctx.isIdle() && !state.busy,
                apply: (next) => {
                  if (isCurrent(state)) setExposure(next.toolEnabled, true);
                },
              });
              check(state);
            },
            generate: async (prompt, path, signal) => {
              const result = await generate(ctx, state, { prompt, path }, signal, false);
              check(state, signal);
              const { data, ...details } = result;
              const settings = pi.getSettings();
              let image = settings.images?.blockImages
                ? undefined
                : { type: "image" as const, data, mimeType: result.mimeType };
              if (image && settings.images?.autoResize !== false) {
                const resized = await resizeImage(Buffer.from(data, "base64"), result.mimeType);
                check(state, signal);
                if (resized) image = { type: "image", data: resized.data, mimeType: resized.mimeType };
              }
              if (pi.getSettings().images?.blockImages) image = undefined;
              // Append at the tail without starting a model turn. Original image bytes stay on disk.
              pi.sendMessage(
                {
                  customType: MESSAGE_TYPE,
                  content: [
                    {
                      type: "text",
                      text: modelText(`Saved image: ${result.path}`, "Image saved. See the structured path."),
                    },
                    ...(image ? [image] : []),
                  ],
                  details,
                  display: true,
                },
                { triggerTurn: false },
              );
            },
          });
          state.menuTask = menuTask;
          await menuTask;
        } finally {
          state.menuTask = undefined;
          state.menuOpen = false;
          releaseOwnership();
        }
      },
    });
  };
}

export default createImagegenExtension();
