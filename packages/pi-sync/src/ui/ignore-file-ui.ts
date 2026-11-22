import { resolve } from "node:path";
import { type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";
import { piDaemonClient } from "../daemon/pi-client.js";
import { captureMutationOwner } from "../sync/sync-local.js";
import { runCancellableTask } from "./cancellable-operation.js";
import { trackOperationDialogs } from "./operation-dialogs.js";
import { safeTerminalText } from "./terminal-text.js";

type IgnoreOperation = "switch" | "migrate";

export async function ignoreFileSettingsAvailable(ctx: ExtensionCommandContext, signal?: AbortSignal) {
  if (signal?.aborted) return false;
  try {
    const client = piDaemonClient(ctx);
    const result = await client.run("ignore.capabilities", {}, signal, ctx);
    client.validate();
    return !signal?.aborted && (result as { available?: unknown } | undefined)?.available === true;
  } catch {
    return false;
  }
}

export function manualIgnoreFileGuidance(filename: string) {
  return `Edit existing ignore rules manually: ${safeTerminalText(resolve(getAgentDir(), filename))}. Edits apply to every setup using this local file on its next sync; they do not rewrite remote history.`;
}

export async function showIgnoreFileAction(
  ctx: ExtensionCommandContext,
  setup: string,
  action: IgnoreOperation,
  filename: string,
  signal: AbortSignal,
  offerToken?: string,
) {
  if (signal.aborted || !ctx.hasUI || ctx.mode !== "tui") return;
  const validateOwner = captureMutationOwner(ctx, signal);
  const client = piDaemonClient(ctx);
  const isCurrent = () => {
    try {
      validateOwner();
      client.validate();
      return true;
    } catch {
      return false;
    }
  };
  try {
    let payload: Record<string, unknown> = offerToken ? { offerToken } : {};
    if (action === "switch") {
      const entered = await askIgnoreFilename(ctx, filename, signal);
      if (!isCurrent() || !entered || entered === filename) return;
      payload = { filename: entered, expectedFilename: filename };
    }
    if (!isCurrent()) return;
    const result = await runCancellableTask(
      ctx,
      action === "migrate"
        ? "Preparing ignore-file migration review…"
        : "Checking the selected ignore file for review…",
      (workSignal, onCommit, onDialog) =>
        client.run(
          `ignore.${action}`,
          { setup, ...payload },
          workSignal,
          trackOperationDialogs(ctx, onDialog),
          onCommit,
        ),
      { signal, isCurrent, cancelledMessage: null, commitAware: true, cancelAcrossDialogs: true },
    );
    if (isCurrent() && result.kind === "completed" && result.value === "saved") {
      ctx.ui.notify(
        action === "migrate"
          ? "Ignore-file policy saved locally. No transfer started."
          : "Ignore file selected. No transfer started.",
        "info",
      );
    }
  } catch (error) {
    if (isCurrent())
      ctx.ui.notify(`Pi Sync: ${safeTerminalText(error instanceof Error ? error.message : String(error))}`, "error");
  }
}

async function askIgnoreFilename(ctx: ExtensionCommandContext, filename: string, signal: AbortSignal) {
  const cancel = new AbortController();
  const stop = ctx.ui.onTerminalInput((data) => {
    if (!isKeyRelease(data) && matchesKey(data, Key.ctrl("c"))) {
      cancel.abort();
      return { consume: true };
    }
  });
  const inputSignal = AbortSignal.any([signal, cancel.signal]);
  try {
    const entered = await ctx.ui.input(`Existing ignore filename (current: ${safeTerminalText(filename)})`, undefined, {
      signal: inputSignal,
    });
    return inputSignal.aborted ? undefined : entered;
  } finally {
    stop();
  }
}
