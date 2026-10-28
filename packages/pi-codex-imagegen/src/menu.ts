import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu, runTask, sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import { showImagegenOutputPath } from "./output-path-input.js";
import { showImagegenPrompt } from "./prompt-editor.js";
import type { ImagegenSettings } from "./settings.js";
import { showImagegenSettings } from "./settings-screen.js";

export interface ImagegenMenuOwner {
  signal: AbortSignal;
  isCurrent(): boolean;
  getSettings(): ImagegenSettings;
  settingsPath: string;
  /** Non-secret local metadata only; must not resolve or refresh credentials. */
  getAuthStatus(): string;
  isBusy(): boolean;
  /** Resolves after persistence and runtime application; rejects after rollback. */
  saveSettings(patch: Partial<ImagegenSettings>): Promise<void>;
  /** Must honor the signal, including disposal, and publish only while current. */
  generate(prompt: string, path: string, signal: AbortSignal): Promise<void>;
}

/** The command owns mode and argument rejection; this function opens TUI only. */
export async function showImagegenMenu(ctx: ExtensionCommandContext, owner: ImagegenMenuOwner): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  const current = () => !owner.signal.aborted && owner.isCurrent();
  while (current()) {
    let route: "generate" | "settings" | undefined;
    const menu = defineMenu<undefined, "main" | "status" | "help", "generate" | "settings">({
      start: "main",
      screens: {
        main: () => ({
          kind: "actions",
          title: "Codex Image Generation",
          lines: ["Codex internal image endpoint", `Activity: ${owner.isBusy() ? "Generating" : "Idle"}`],
          items: [
            {
              id: "generate",
              label: "Generate Image",
              action: "generate",
              description: "Send a prompt to ChatGPT and save one image",
              disabled: owner.isBusy(),
              disabledReason: "An image generation is already active",
            },
            { id: "settings", label: "Settings", action: "settings" },
            { id: "status", label: "Status", to: "status" },
            { id: "help", label: "Help", to: "help" },
          ],
          hint: "close",
        }),
        status: () => ({
          kind: "detail",
          title: "Image Generation Status",
          lines: [
            `Authentication: ${sanitizeTerminalText(owner.getAuthStatus())}`,
            "Endpoint: ChatGPT/Codex internal image API",
            "Local metadata does not verify account entitlement or live readiness.",
            `Tool access: ${owner.getSettings().toolEnabled ? "enabled" : "disabled"}`,
            "Each generation requires an output path.",
            `User settings: ${sanitizeTerminalText(owner.settingsPath)}`,
            `Activity: ${owner.isBusy() ? "Generating" : "Idle"}`,
          ],
        }),
        help: () => ({
          kind: "detail",
          title: "Image Generation Help",
          lines: [
            "Generate Image sends your prompt to ChatGPT and saves one image at the exact path you enter. Provider quota and account restrictions apply.",
            "Relative paths use the generation request's working directory. Existing files are overwritten and symlinks are followed.",
            "Use Pi's compatible Codex OAuth login. A Codex CLI login alone is not imported. Status never refreshes credentials.",
            "Settings save immediately in user scope. Closing Settings does not undo saved changes. Tool access does not control manual generation.",
            "Tool access changes apply at an idle boundary and change the model-visible tool definitions.",
            "Cancellation aborts the owned request, but cannot guarantee remote cancellation, a quota refund, or rollback of file writes. Partial or completed writes can remain.",
            "Requests are not retried automatically. Image editing, reference images, masks, and batches are not supported.",
          ],
        }),
      },
      actions: {
        generate: () => {
          route = "generate";
          return { kind: "close" };
        },
        settings: () => {
          route = "settings";
          return { kind: "close" };
        },
      },
    });
    const navigation = await runMenu(ctx, menu, {
      getState: () => undefined,
      signal: owner.signal,
      isCurrent: owner.isCurrent.bind(owner),
      onError: () => {
        if (current()) ctx.ui.notify("Image generation menu failed.", "error");
      },
    });
    if (!current() || navigation.kind !== "closed" || !route) return;
    // Standalone interactions start only after the root navigator releases the terminal.
    if (route === "settings") {
      const settings = await showImagegenSettings(ctx, owner);
      if (!current() || settings !== "back") return;
      continue;
    }
    if (owner.isBusy()) continue;
    const prompt = await showImagegenPrompt(ctx, owner);
    if (!current()) return;
    if (prompt.kind === "back") continue;
    if (prompt.kind !== "submitted") return;
    const destination = await showImagegenOutputPath(ctx, owner);
    if (!current()) return;
    if (destination.kind === "back") continue;
    if (destination.kind !== "submitted") return;
    if (owner.isBusy()) {
      ctx.ui.notify("An image generation is already active.", "warning");
      continue;
    }
    const generation = await runTask(ctx, {
      label: "Generating image…",
      signal: owner.signal,
      isCurrent: owner.isCurrent.bind(owner),
      task: async ({ signal }) => {
        if (signal.aborted || !current()) return;
        await owner.generate(prompt.prompt, destination.path, signal);
      },
      // Never display raw provider errors or prompts through the generic error reporter.
      onError: () => {
        if (current())
          ctx.ui.notify("Image generation failed. See the extension guidance before trying again.", "error");
      },
    });
    if (!current() || generation.kind === "stale" || generation.kind === "cancelled") return;
  }
}
