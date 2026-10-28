import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runModelSelector, runSecretInput, runThinkingSelector } from "@narumitw/pi-tui-kit";
import { appendLog, type ShowcaseState } from "./menu.js";
import type { ShowTuiKitShowcaseOptions } from "./runtime.js";

const MODELS = [
  { provider: "demo-alpha", id: "synthetic-fast", name: "Synthetic fast model" },
  { provider: "demo-beta", id: "synthetic-deep", name: "Synthetic deep model" },
  { provider: "demo-alpha", id: "synthetic-balanced", name: "Synthetic balanced model" },
];

export async function runSyntheticInput(
  ctx: ExtensionCommandContext,
  state: ShowcaseState,
  kind: "secret" | "model" | "thinking",
  options: ShowTuiKitShowcaseOptions,
): Promise<void> {
  const lifecycle = {
    signal: options.signal,
    isCurrent: options.isCurrent,
    onError: () => {
      if (!options.signal.aborted && options.isCurrent() && ctx.hasUI) {
        ctx.ui.notify("Synthetic input failed. Reopen the example to retry.", "error");
      }
    },
  };
  if (kind === "secret") {
    // Do not keep the result in state, history, logs, or notifications. Dropping
    // references is not a claim of secure JavaScript-memory erasure.
    let result = await runSecretInput(ctx, { ...lifecycle, title: "Synthetic secret only — never enter credentials" });
    const submitted = result.kind === "submitted";
    result = { kind: "closed", reason: "back" };
    if (options.signal.aborted || !options.isCurrent()) return;
    appendLog(state, submitted ? "Synthetic secret accepted (payload discarded)." : "Synthetic secret cancelled.");
    return;
  }
  if (kind === "model") {
    const result = await runModelSelector(ctx, {
      ...lifecycle,
      models: MODELS,
      currentModel: state.model,
      defaultModel: state.defaultModel,
      lines: ["Synthetic models only. Select changes demo memory; Save records a default intent only."],
    });
    if (options.signal.aborted || !options.isCurrent()) return;
    if (result.kind === "selected") state.model = result.model;
    if (result.kind === "saveDefault") state.defaultModel = result.model;
    if (result.kind === "selected" || result.kind === "saveDefault") {
      appendLog(state, `Synthetic model ${result.kind}: ${result.model.id} (memory only).`);
    }
    return;
  }
  const result = await runThinkingSelector(ctx, {
    ...lifecycle,
    availableLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    currentLevel: state.thinking,
    defaultLevel: state.defaultThinking,
  });
  if (options.signal.aborted || !options.isCurrent()) return;
  if (result.kind === "selected") state.thinking = result.level;
  if (result.kind === "saveDefault") state.defaultThinking = result.level;
  if (result.kind === "selected" || result.kind === "saveDefault") {
    appendLog(state, `Synthetic thinking ${result.kind}: ${result.level} (memory only).`);
  }
}
