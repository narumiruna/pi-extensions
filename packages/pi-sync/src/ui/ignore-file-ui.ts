import { resolve } from "node:path";
import { type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, isKeyRelease, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { HorizontalRule, hardWrapTerminalDocument, runCustomInteraction } from "@narumitw/pi-tui-kit";
import { piDaemonClient } from "../daemon/pi-client.js";
import { captureMutationOwner } from "../sync/sync-local.js";
import { runCancellableTask } from "./cancellable-operation.js";
import { confirmMergeReview } from "./merge-review.js";
import { safeTerminalText } from "./terminal-text.js";

interface IgnoreFile {
  filename: string;
  path: string;
  text: string;
  sourceDigest: string;
  identity: string;
  sharingSetups: string[];
}

type IgnoreOperation = "edit" | "switch" | "migrate";

type EditorResult = { kind: "draft"; text: string } | { kind: "cancelled" | "unsafe" };

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
  return `Edit existing ignore rules manually: ${safeTerminalText(resolve(getAgentDir(), filename))}`;
}

export async function showIgnoreFileAction(
  ctx: ExtensionCommandContext,
  setup: string,
  action: IgnoreOperation,
  filename: string,
  signal: AbortSignal,
  offerToken?: string,
) {
  if (signal.aborted || !ctx.hasUI) return;
  if (ctx.mode !== "tui") {
    if (ctx.mode === "rpc" && action === "edit") ctx.ui.notify(manualIgnoreFileGuidance(filename), "info");
    return;
  }
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
  const work = async (
    method: "read" | "save" | "switch" | "migrate",
    message: string,
    payload: Record<string, unknown> = {},
  ) => {
    const result = await runCancellableTask(
      ctx,
      message,
      (workSignal, onCommit) => client.run(`ignore.${method}`, { setup, ...payload }, workSignal, ctx, onCommit),
      {
        signal,
        isCurrent,
        cancelledMessage: null,
        commitAware: method !== "read",
        cancelAcrossDialogs: method !== "read",
      },
    );
    return isCurrent() && result.kind === "completed" ? result : undefined;
  };
  try {
    if (action === "migrate") {
      const result = await work("migrate", "Preparing ignore-file migration review…", offerToken ? { offerToken } : {});
      if (isCurrent() && result?.value === "saved")
        ctx.ui.notify("Ignore-file policy saved locally. No transfer started.", "info");
      return;
    }
    if (action === "switch") {
      const entered = await askIgnoreFilename(ctx, filename, signal);
      if (!isCurrent() || !entered || entered === filename) return;
      const result = await work("switch", "Checking the selected ignore file for review…", {
        filename: entered,
        expectedFilename: filename,
      });
      if (isCurrent() && result?.value === "saved") ctx.ui.notify("Ignore file selected. No transfer started.", "info");
      return;
    }
    const result = await work("read", "Opening existing ignore file…");
    if (!isCurrent() || !result) return;
    const source = decodeIgnoreFile(result.value);
    const path = safeTerminalText(source.path);
    if (!isEditorSafe(source.text)) {
      ctx.ui.notify(
        `Pi cannot edit this file without changing or hiding some characters. Edit ${path} manually.`,
        "warning",
      );
      return;
    }
    const sharing = source.sharingSetups.length
      ? `Also used by: ${source.sharingSetups.map((name) => `“${safeTerminalText(name)}”`).join(", ")}`
      : undefined;
    const draft = await editIgnoreText(ctx, source.text, path, sharing, signal, isCurrent);
    if (!isCurrent() || draft.kind !== "completed") return;
    if (draft.value.kind === "unsafe") {
      ctx.ui.notify(`Unsafe terminal characters in the draft. No save; edit ${path} manually.`, "warning");
      return;
    }
    if (draft.value.kind !== "draft" || draft.value.text === source.text) return;
    const text = draft.value.text;
    const lines = [
      path,
      ...(sharing ? [sharing] : []),
      "This replaces the local rules. Removing rules may expose more files on a later sync.",
      "No transfer starts; remote history is retained.",
    ];
    const confirmed = await confirmMergeReview(ctx, "Save ignore rules?", text, signal, isCurrent, "save rules", lines);
    if (!isCurrent() || !confirmed) return;
    const saved = await work("save", "Saving ignore rules…", {
      text,
      sourceDigest: source.sourceDigest,
      identity: source.identity,
    });
    if (isCurrent() && saved) ctx.ui.notify("Ignore rules saved. No transfer started.", "info");
  } catch (error) {
    if (isCurrent())
      ctx.ui.notify(`Pi Sync: ${safeTerminalText(error instanceof Error ? error.message : String(error))}`, "error");
  }
}

function decodeIgnoreFile(value: unknown): IgnoreFile {
  const file = value as Partial<IgnoreFile> | null;
  if (!file || typeof file.filename !== "string" || typeof file.path !== "string")
    throw new Error("Invalid ignore-file response from the daemon.");
  if (file.identity === undefined && file.text === undefined)
    throw new Error(`Ignore file does not exist: ${file.path}. No file was created.`);
  if (
    typeof file.text !== "string" ||
    typeof file.identity !== "string" ||
    file.identity.length === 0 ||
    typeof file.sourceDigest !== "string" ||
    !Array.isArray(file.sharingSetups) ||
    !file.sharingSetups.every((setup) => typeof setup === "string")
  )
    throw new Error("Invalid ignore-file response from the daemon.");
  return file as IgnoreFile;
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

function isEditorSafe(text: string) {
  const flattened = text.replaceAll("\n", "");
  return flattened === safeTerminalText(flattened);
}

function editIgnoreText(
  ctx: ExtensionCommandContext,
  original: string,
  path: string,
  sharing: string | undefined,
  signal: AbortSignal,
  isCurrent: () => boolean,
) {
  return runCustomInteraction<EditorResult, ExtensionCommandContext>(ctx, {
    signal,
    isCurrent,
    create: ({ tui, theme, keybindings, complete, signal: editorSignal }) => {
      const muted = (line: string) => theme.fg("muted", line);
      const editor = new Editor(tui, {
        borderColor: (line) => theme.fg("borderMuted", line),
        selectList: {
          selectedPrefix: (line) => theme.fg("accent", line),
          selectedText: (line) => theme.fg("accent", line),
          description: muted,
          scrollInfo: muted,
          noMatch: muted,
        },
      });
      editor.setText(original);
      let text = original;
      let beforeChange = original;
      editor.onChange = () => {
        beforeChange = text;
        text = editor.getExpandedText();
        if (!isEditorSafe(text)) complete({ kind: "unsafe" });
      };
      editor.onSubmit = () => complete({ kind: "draft", text: beforeChange });
      const rule = new HorizontalRule({ ruleStyle: (line) => theme.fg("border", line) });
      let layout: { width: number; first: number; count: number; editorOffset: number } | undefined;
      return {
        get focused() {
          return editor.focused;
        },
        set focused(value: boolean) {
          editor.focused = value;
        },
        get capturesViewportInput() {
          return true;
        },
        render(width: number) {
          layout = undefined;
          if (editorSignal.aborted || !Number.isFinite(width) || width <= 0) return [];
          const terminalRows = Number.isFinite(tui.terminal.rows) ? Math.floor(tui.terminal.rows) : 24;
          const rows = Math.max(1, terminalRows - 3);
          const border = rows >= 5 ? rule.render(width) : [];
          const editorRows = editor.render(width).slice(1, -1);
          const header = [
            theme.fg("accent", theme.bold("Edit ignore rules")),
            muted("Submit to review; cancel to discard."),
            ...[path, ...(sharing ? [sharing] : [])].flatMap((line) =>
              hardWrapTerminalDocument(line, width).map(muted),
            ),
          ].slice(0, rows - 2 * border.length - 1);
          const available = rows - 2 * border.length - header.length;
          const cursorRow = editorRows.findIndex((line) => line.includes(CURSOR_MARKER));
          const offset = Math.max(0, cursorRow - available + 1);
          const body = editorRows.slice(offset, offset + available);
          layout = { width, first: border.length + header.length, count: body.length, editorOffset: offset + 1 };
          return [...border, ...header, ...body, ...border].map((line) => truncateToWidth(line, width, ""));
        },
        invalidate() {
          layout = undefined;
          rule.invalidate();
          editor.invalidate();
        },
        handleInput(data: string) {
          if (editorSignal.aborted || isKeyRelease(data)) return;
          if (matchesKey(data, Key.ctrl("c")) || keybindings.matches(data, "tui.select.cancel")) {
            complete({ kind: "cancelled" });
            return;
          }
          editor.handleInput(data);
          if (!editorSignal.aborted) tui.requestRender();
        },
        handleMouse(event: Parameters<Editor["handleMouse"]>[0]) {
          if (editorSignal.aborted || !layout || layout.width !== event.width) return;
          const y = event.y - layout.first;
          if (y >= 0 && y < layout.count) return editor.handleMouse({ ...event, y: y + layout.editorOffset });
        },
      };
    },
  });
}
