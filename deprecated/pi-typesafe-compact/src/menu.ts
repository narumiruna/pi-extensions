import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MenuDefinition } from "@narumitw/pi-tui-kit";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import type { TypeSafeCompactSettingsRuntime, TypeSafeCompactSettingsState } from "./settings.js";

export interface TypeSafeCompactMenuOwner {
  signal: AbortSignal;
  isCurrent(): boolean;
}

type Screen = "main" | "settings" | "status" | "help";
type Action = "set-key" | "remove-key";
type RequestedAction = Action | undefined;

function displayText(value: unknown): string {
  return sanitizeTerminalText(String(value)).trim();
}

function redactedError(error: unknown, secret?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return displayText(secret ? message.split(secret).join("[REDACTED]") : message).slice(0, 2_000);
}

function createMenu(requested: {
  value: RequestedAction;
}): MenuDefinition<TypeSafeCompactSettingsState, Screen, Action, ExtensionCommandContext> {
  return {
    start: "main",
    screens: {
      main: ({ state }) => ({
        kind: "actions",
        title: "TypeSafe Compact",
        lines: [
          `TypeSafe API key: ${state.settings.apiKey ? "Configured" : "Missing"}`,
          `Evaluator: ${state.settings.apiKey && state.kind === "loaded" ? "JEV jev-latest" : "Pi-native fallback"}`,
        ],
        items: [
          { id: "settings", label: "Settings", to: "settings" },
          { id: "status", label: "Status", to: "status" },
          { id: "help", label: "Help", to: "help" },
          { id: "close", label: "Close", close: true },
        ],
        hint: "close",
      }),
      settings: ({ state }) => ({
        kind: "actions",
        title: "TypeSafe Compact Settings",
        lines: [
          `User settings: ${displayText(state.path)}`,
          state.kind === "invalid"
            ? `Read only: ${displayText(state.issue ?? "invalid settings")}`
            : `TypeSafe API key: ${state.settings.apiKey ? "Configured" : "Missing"}`,
        ],
        items: [
          {
            id: "set-key",
            label: state.settings.apiKey ? "Replace TypeSafe API key" : "Set TypeSafe API key",
            description: "Open a masked TUI input. The value is never displayed.",
            action: "set-key",
            disabled: state.kind === "invalid",
            disabledReason: state.kind === "invalid" ? "Repair the invalid settings file first." : undefined,
          },
          {
            id: "remove-key",
            label: "Remove TypeSafe API key",
            description: "Disable JEV evaluation and use Pi-native compaction.",
            action: "remove-key",
            disabled: state.kind !== "loaded" || !state.settings.apiKey,
            disabledReason:
              state.kind === "invalid" ? "Repair the invalid settings file first." : "No API key is stored.",
          },
          { id: "back", label: "Back", to: "main" },
        ],
      }),
      status: ({ state }) => ({
        kind: "detail",
        title: "TypeSafe Compact Status",
        lines: [
          `Settings file: ${displayText(state.path)}`,
          `Settings state: ${state.kind}`,
          `TypeSafe API key: ${state.settings.apiKey ? "Configured" : "Missing"}`,
          `Effective compaction: ${state.settings.apiKey && state.kind === "loaded" ? "JEV selects units; active Pi model summarizes" : "Pi native"}`,
        ],
        hint: "back",
      }),
      help: () => ({
        kind: "detail",
        title: "TypeSafe Compact Help",
        lines: [
          "Pi keeps its normal /compact command and automatic thresholds.",
          "JEV independently selects old history units for summarization.",
          "The model active when compaction starts writes the summary.",
          "Tool calls and tool results are not forced to share one decision.",
          "If evaluation fails, Pi-native compaction takes over.",
        ],
        hint: "back",
      }),
    },
    actions: {
      "set-key": async () => {
        requested.value = "set-key";
        return { kind: "close" };
      },
      "remove-key": async () => {
        requested.value = "remove-key";
        return { kind: "close" };
      },
    },
  };
}

export async function showTypeSafeCompactMenu(
  runtime: TypeSafeCompactSettingsRuntime,
  ctx: ExtensionCommandContext,
  owner: TypeSafeCompactMenuOwner,
): Promise<void> {
  const current = runtime.get();
  if (ctx.mode === "rpc" && ctx.hasUI) {
    ctx.ui.notify(
      `TypeSafe API key: ${current.settings.apiKey ? "configured" : "missing"}. Edit TypeSafe compaction settings at ${displayText(current.path)}.`,
      "info",
    );
    return;
  }
  if (ctx.mode !== "tui") throw new Error("/typesafe-compact requires TUI or RPC UI support");
  if (owner.signal.aborted || !owner.isCurrent()) return;

  const { defineMenu, runConfirmation, runMenu, runSecretInput } = await import("@narumitw/pi-tui-kit");
  if (owner.signal.aborted || !owner.isCurrent()) return;
  const requested: { value: RequestedAction } = { value: undefined };
  const result = await runMenu(ctx, defineMenu(createMenu(requested)), {
    getState: () => runtime.get(),
    signal: owner.signal,
    isCurrent: owner.isCurrent,
    onError: (currentCtx, error) => {
      currentCtx.ui.notify(
        `TypeSafe compaction menu failed: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`,
        "error",
      );
    },
  });
  if (result.kind === "stale" || owner.signal.aborted || !owner.isCurrent()) return;

  if (requested.value === "set-key") {
    const input = await runSecretInput(ctx, {
      title: "TypeSafe API key",
      required: true,
      signal: owner.signal,
      isCurrent: owner.isCurrent,
    });
    if (input.kind !== "submitted" || owner.signal.aborted || !owner.isCurrent()) return;
    try {
      await runtime.setApiKey(input.value);
      if (owner.signal.aborted || !owner.isCurrent()) return;
      ctx.ui.notify(`TypeSafe API key saved to ${displayText(runtime.get().path)}.`, "info");
    } catch (error) {
      if (owner.signal.aborted || !owner.isCurrent()) return;
      ctx.ui.notify(
        `Could not save pi-typesafe-compact.json: ${sanitizeTerminalText(redactedError(error, input.value))}`,
        "error",
      );
    }
    return;
  }

  if (requested.value === "remove-key") {
    const confirmation = await runConfirmation(ctx, {
      title: "Remove TypeSafe API key?",
      message: "JEV evaluation will stop and Pi-native compaction will be used.",
      confirmLabel: "Remove key",
      cancelLabel: "Keep key",
      signal: owner.signal,
      isCurrent: owner.isCurrent,
    });
    if (confirmation.kind !== "confirmed" || owner.signal.aborted || !owner.isCurrent()) return;
    try {
      await runtime.removeApiKey();
      if (owner.signal.aborted || !owner.isCurrent()) return;
      ctx.ui.notify("TypeSafe API key removed; Pi-native compaction is active.", "info");
    } catch (error) {
      if (owner.signal.aborted || !owner.isCurrent()) return;
      ctx.ui.notify(
        `Could not update pi-typesafe-compact.json: ${sanitizeTerminalText(redactedError(error))}`,
        "error",
      );
    }
  }
}
