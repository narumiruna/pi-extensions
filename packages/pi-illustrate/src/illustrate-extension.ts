import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getCapabilities, getCellDimensions, Text } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import { Type } from "typebox";
import { effectiveAppearance, PreviewSession } from "./preview-session.js";
import { LIMITS, rasterWidth } from "./rasterizer.js";
import { createRecord, isIllustrateTool, projectModelImages, readRecord } from "./records.js";
import { SettingsStore, validCols } from "./settings.js";

type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

interface SessionOwner {
  ctx: ExtensionContext;
  store: SettingsStore;
  preview: PreviewSession;
  controller: AbortController;
  isCurrent(): boolean;
  dispose(): Promise<void>;
}

const commonParameters = {
  cols: Type.Optional(
    Type.Union([StringEnum(["auto"] as const), Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })], {
      description:
        "Image width in terminal columns, or auto to follow available width. Omission uses the user default.",
    }),
  ),
  sendToModel: Type.Optional(
    Type.Boolean({ description: "Also send an immutable PNG to the model. Defaults to false; may use image tokens." }),
  ),
};

export default function illustrateExtension(pi: ExtensionAPI): void {
  const owners = new WeakMap<object, SessionOwner>();
  let current: SessionOwner | undefined;
  let epoch = 0;
  let pendingStart: { manager: object; generation: number } | undefined;

  function restoreBranch(owner: SessionOwner): void {
    const ids = new Set<string>();
    for (const entry of owner.ctx.sessionManager.getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "toolResult" || !isIllustrateTool(entry.message.toolName))
        continue;
      const record = readRecord(entry.message.details);
      if (!entry.message.isError && record && entry.message.toolName === `illustrate_${record.layout.kind}`)
        ids.add(entry.message.toolCallId);
    }
    owner.preview.retain(ids);
  }

  async function start(ctx: ExtensionContext): Promise<void> {
    const generation = ++epoch;
    pendingStart = { manager: ctx.sessionManager, generation };
    const previous = current;
    current = undefined;
    if (previous) await previous.dispose();
    if (generation !== epoch) return;
    const store = new SettingsStore(getAgentDir());
    const controller = new AbortController();
    const preview = new PreviewSession(() => store.settings);
    let disposal: Promise<void> | undefined;
    const owner: SessionOwner = {
      ctx,
      store,
      preview,
      controller,
      isCurrent: () => current === owner && generation === epoch && !controller.signal.aborted,
      dispose() {
        if (disposal) return disposal;
        controller.abort();
        disposal = Promise.all([preview.dispose(), store.flush()]).then(() => {});
        return disposal;
      },
    };
    current = owner;
    owners.set(ctx.sessionManager, owner);
    const loaded = await store.load();
    if (!owner.isCurrent()) {
      await owner.dispose();
      return;
    }
    restoreBranch(owner);
    if (pendingStart?.generation === generation) pendingStart = undefined;
    if (loaded.warning) {
      if (ctx.hasUI) ctx.ui.notify(sanitizeTerminalText(loaded.warning), "warning");
      else throw new Error(sanitizeTerminalText(loaded.warning));
    }
  }

  pi.on("session_start", async (_event, ctx) => start(ctx));
  pi.on("session_tree", async (_event, ctx) => start(ctx));
  pi.on("session_shutdown", async (_event, ctx) => {
    const owner = owners.get(ctx.sessionManager);
    if (pendingStart?.manager === ctx.sessionManager) {
      epoch++;
      pendingStart = undefined;
    }
    if (!owner) return;
    if (current === owner) {
      current = undefined;
      epoch++;
    }
    owners.delete(ctx.sessionManager);
    await owner.dispose();
  });
  // The conversation-only context hook folds Pi's system/tool patches after any changed message.
  // Preserve those public transcript records verbatim while adding only our immutable image content.
  pi.on("context_with_system", (event) => ({ messages: projectModelImages(event.messages) }));

  function renderCall(_args: unknown, theme: Theme, context: ToolRenderContext) {
    const text = new Text(theme.fg("toolTitle", "Illustrate"), 0, 0);
    const owner = current;
    return {
      render(width: number) {
        if (owner?.isCurrent()) owner.preview.noteWidth(context.toolCallId, width);
        return text.render(width);
      },
      invalidate: () => text.invalidate(),
    };
  }

  function renderResult(
    kind: "svg" | "mermaid",
    result: { content: Array<{ type: string; text?: string }>; details?: unknown },
    _options: ToolRenderResultOptions,
    theme: Theme,
    context: ToolRenderContext,
  ) {
    const owner = current;
    const record = readRecord(result.details);
    if (!record || record.layout.kind !== kind || context.isError || !owner?.isCurrent() || !context.showImages) {
      owner?.preview.release(context.toolCallId);
      const text = result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text ?? "")
        .join("\n");
      return new Text(sanitizeTerminalText(text).slice(0, 2000), 0, 0);
    }
    return owner.preview.component(context.toolCallId, record, theme, context.invalidate);
  }

  async function execute(
    kind: "svg" | "mermaid",
    id: string,
    source: string,
    params: { cols?: unknown; sendToModel?: boolean },
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ) {
    if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("Pi Illustrate requires TUI mode and Kitty graphics.");
    if (getCapabilities().images !== "kitty")
      throw new Error("Kitty graphics are unavailable. tmux, screen, and non-Kitty image protocols are not supported.");
    if (typeof source !== "string" || source.length === 0 || source.length > LIMITS.sourceChars)
      throw new Error("Diagram source must contain 1 to 50000 characters.");
    if (params.cols !== undefined && !validCols(params.cols))
      throw new Error("cols must be auto or a positive safe integer.");
    if (params.sendToModel !== undefined && typeof params.sendToModel !== "boolean")
      throw new Error("sendToModel must be a boolean.");
    if (params.sendToModel && !ctx.model?.input.includes("image"))
      throw new Error("The selected model does not support image input.");
    const owner = owners.get(ctx.sessionManager);
    if (!owner?.isCurrent()) throw new Error("Pi Illustrate session is not ready.");
    const combined = signal ? AbortSignal.any([signal, owner.controller.signal]) : owner.controller.signal;
    const check = () => {
      if (combined.aborted || !owner.isCurrent()) throw new Error("Diagram rendering cancelled.");
    };
    check();
    const cols = params.cols ?? owner.store.settings.defaultCols;
    const sendToModel = params.sendToModel === true;
    const layout = await owner.preview.service.layout(kind, source, combined);
    check();
    const appearance = effectiveAppearance(owner.store.settings, ctx.ui.theme.appearance);
    const artifact = await owner.preview.service.raster(
      layout,
      appearance,
      rasterWidth(layout, owner.preview.initialWidth(id, cols)),
      combined,
    );
    check();
    if (sendToModel && !ctx.model?.input.includes("image"))
      throw new Error("The selected model no longer supports image input.");
    const details = createRecord(layout, cols, sendToModel ? artifact : undefined);
    owner.preview.seed(id, details, artifact, appearance);
    return {
      content: [
        {
          type: "text" as const,
          text: `Rendered ${kind === "svg" ? "SVG" : "Mermaid"} diagram (${artifact.width}×${artifact.height} px). ${sendToModel ? "An immutable PNG is included for the model." : "Terminal preview only; no image is sent to the model."}`,
        },
      ],
      details,
    };
  }

  pi.registerTool({
    name: "illustrate_svg",
    label: "Illustrate SVG",
    description:
      "Display self-contained static SVG through Kitty graphics in Pi TUI. No external resources or file writes. Image delivery to the model is opt-in with sendToModel.",
    parameters: Type.Object({ svg: Type.String({ minLength: 1, maxLength: 50_000 }), ...commonParameters }),
    execute: (id, params, signal, _update, ctx) => execute("svg", id, params.svg, params, signal, ctx),
    renderCall,
    renderResult: (result, options, theme, context) => renderResult("svg", result, options, theme, context),
  });
  pi.registerTool({
    name: "illustrate_mermaid",
    label: "Illustrate Mermaid",
    description:
      "Render Mermaid locally with Pele and display it through Kitty graphics in Pi TUI. Follows Pi appearance by default. No remote service or file writes. Image delivery to the model is opt-in with sendToModel.",
    parameters: Type.Object({ source: Type.String({ minLength: 1, maxLength: 50_000 }), ...commonParameters }),
    execute: (id, params, signal, _update, ctx) => execute("mermaid", id, params.source, params, signal, ctx),
    renderCall,
    renderResult: (result, options, theme, context) => renderResult("mermaid", result, options, theme, context),
  });

  pi.registerCommand("illustrate", {
    description: "Open diagram settings, terminal status, and help",
    handler: async (args, ctx) => {
      if (args.trim()) throw new Error("Usage: /illustrate (no arguments).");
      if (ctx.mode !== "tui") {
        const message = `/illustrate requires TUI mode. User settings: ${sanitizeTerminalText(`${getAgentDir()}/pi-illustrate.json`)}`;
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
        else throw new Error(message);
        return;
      }
      const owner = owners.get(ctx.sessionManager);
      if (!owner?.isCurrent()) throw new Error("Pi Illustrate session is not ready.");
      const { showIllustrateMenu } = await import("./menu.js");
      if (!owner.isCurrent()) return;
      await showIllustrateMenu(ctx, {
        signal: owner.controller.signal,
        isCurrent: owner.isCurrent,
        getSettings: () => owner.store.settings,
        settingsPath: owner.store.path,
        async saveSettings(patch) {
          await owner.store.save(patch, {
            signal: owner.controller.signal,
            isCurrent: owner.isCurrent,
            apply: () => {
              if (owner.isCurrent()) owner.preview.refresh();
            },
          });
          if (!owner.isCurrent()) return;
        },
        getStatus() {
          const settings = owner.store.settings;
          const cell = getCellDimensions();
          return [
            `Image protocol: ${getCapabilities().images ?? "unavailable"} (Kitty required)`,
            `Mermaid appearance: ${effectiveAppearance(settings, ctx.ui.theme.appearance)} (${settings.mermaidAppearance === "auto" ? "Pi appearance" : "user override"})`,
            `Default columns: ${settings.defaultCols}`,
            `Cell size: ${cell.widthPx}×${cell.heightPx} px (Pi cache; may be estimated)`,
            `Active raster work: ${owner.preview.active}`,
          ];
        },
      });
    },
  });
}
