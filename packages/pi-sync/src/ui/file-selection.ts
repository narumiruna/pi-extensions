import fs from "node:fs/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { loadConfig } from "../settings/config.js";
import { localConfigPath } from "../settings/config-file.js";
import { updateSyncSetup } from "../settings/settings-management.js";
import { agentDir } from "../snapshot/session-paths.js";
import {
  BUILT_IN_SYNC_ROOTS,
  isSafeCustomIncludePath,
  normalizeSyncInclude,
  syncIncludeSelection,
} from "../sync/sync-policy.js";

const BUILT_IN_PREFIX = "builtin:";
const CUSTOM_PREFIX = "custom:";
const SESSIONS_ID = "sessions";
const ADD_CUSTOM_ID = "add-custom";

interface SelectionDraft {
  builtIns: Set<string>;
  custom: Set<string>;
  sessions: boolean;
}

export async function showFileSelection(ctx: ExtensionCommandContext, setupName?: string, signal?: AbortSignal) {
  const config = await loadConfig(setupName);
  if (signal?.aborted) return;
  const selection = syncIncludeSelection(config.include);
  const original: SelectionDraft = {
    builtIns: new Set(selection.builtIns),
    custom: new Set(selection.custom),
    sessions: selection.sessions,
  };
  const draft = cloneDraft(original);
  const customCandidates = await listCustomCandidates(draft.custom);

  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      [
        `pi-sync included content for sync setup ${safeTerminalText(config.setupName)}:`,
        `include: ${config.include.map(safeTerminalText).join(", ") || "none"}`,
        `Edit sync.include in ${safeTerminalText(localConfigPath())}.`,
      ].join("\n"),
      "info",
    );
    return;
  }

  while (!signal?.aborted) {
    await showDraftEditor(ctx, config.setupName, draft, customCandidates, signal);
    if (signal?.aborted || sameDraft(original, draft)) return;
    const choice = await showDraftReview(ctx, original, draft, signal);
    if (signal?.aborted) return;
    if (choice === "Continue editing") continue;
    if (choice !== "Save changes") {
      ctx.ui.notify("Included-content changes discarded.", "info");
      return;
    }
    try {
      if (!original.sessions && draft.sessions) {
        const acknowledged = await ctx.ui.confirm(
          "Include session conversations?",
          "Session JSONL may contain prompts, tool output, file paths, images, and secrets. Continue only with storage you trust.",
          { signal },
        );
        if (signal?.aborted) return;
        if (!acknowledged) {
          ctx.ui.notify("Session inclusion was not saved.", "info");
          return;
        }
      }
      const include = [
        ...BUILT_IN_SYNC_ROOTS.filter((candidate) => draft.builtIns.has(candidate)),
        ...draft.custom,
        ...(draft.sessions ? ["sessions"] : []),
      ];
      if (signal?.aborted) return;
      await updateSyncSetup(
        config.setupName,
        (setup) => ({
          ...setup,
          sync: { ...setup.sync, include },
        }),
        { expectedInclude: config.include, signal },
      );
      if (signal?.aborted) return;
      ctx.ui.notify(
        `Saved included content for sync setup “${safeTerminalText(config.setupName)}”. It applies to the next manual or automatic sync.`,
        "info",
      );
    } catch (error) {
      if (signal?.aborted) return;
      ctx.ui.notify(
        `Could not save pi-sync file selection: ${safeTerminalText(error instanceof Error ? error.message : String(error))}`,
        "error",
      );
    }
    return;
  }
}

async function showDraftEditor(
  ctx: ExtensionCommandContext,
  setupName: string,
  draft: SelectionDraft,
  customCandidates: string[],
  signal?: AbortSignal,
) {
  const menu = defineMenu<undefined, "editor", "toggle" | "addCustom", ExtensionCommandContext>({
    start: "editor",
    screens: {
      editor: () => ({
        kind: "multiSelect",
        title: `Included Content · ${safeTerminalText(setupName)}`,
        lines: ["Draft only · leaving this screen opens Save, Discard, or Continue editing."],
        viewportSize: 12,
        items: [
          ...BUILT_IN_SYNC_ROOTS.map((relativePath) => ({
            id: `${BUILT_IN_PREFIX}${relativePath}`,
            label: relativePath,
            description: relativePath.includes(".")
              ? `Sync the top-level ${relativePath} file when present.`
              : `Recursively sync every safe file under ${relativePath}/.`,
            selected: draft.builtIns.has(relativePath),
          })),
          ...customCandidates.map((relativePath) => ({
            id: `${CUSTOM_PREFIX}${relativePath}`,
            label: safeTerminalText(relativePath),
            description: "Additional safe agent-relative file or directory.",
            selected: draft.custom.has(relativePath),
          })),
          {
            id: SESSIONS_ID,
            label: "sessions",
            description:
              "Session JSONL may contain prompts, tool output, paths, images, and secrets. Sync only to storage you trust.",
            selected: draft.sessions,
          },
        ],
        action: "toggle",
        actions: [
          {
            id: ADD_CUSTOM_ID,
            label: "Add custom path…",
            description: "Include an agent-relative file or directory even when it exists only remotely.",
            action: "addCustom",
          },
        ],
        hint: "close",
        doneLabel: "Review changes",
      }),
    },
    actions: {
      toggle: async ({ itemId, selected }) => {
        updateDraft(draft, itemId, selected === true);
        return { kind: "stay" };
      },
      addCustom: async ({ ctx: actionCtx, signal: actionSignal }) => {
        const entered = await actionCtx.ui.input(
          "Add included content",
          "Agent-relative path, for example custom.toml or snippets",
          { signal: actionSignal },
        );
        if (actionSignal.aborted) return { kind: "stay" };
        const requested = entered?.trim();
        if (!requested) return { kind: "stay" };
        const existing = customCandidates.find((candidate) => candidate.toLowerCase() === requested.toLowerCase());
        const relativePath = existing ?? requested;
        if (draft.custom.has(relativePath)) return { kind: "stay" };
        try {
          if (!isSafeCustomIncludePath(relativePath)) {
            throw new Error("Enter a safe agent-relative file or directory path.");
          }
          normalizeSyncInclude([
            ...draft.builtIns,
            ...draft.custom,
            ...(draft.sessions ? ["sessions"] : []),
            relativePath,
          ]);
        } catch (error) {
          if (actionSignal.aborted) return { kind: "stay" };
          actionCtx.ui.notify(
            `Could not add included content: ${safeTerminalText(error instanceof Error ? error.message : String(error))}`,
            "error",
          );
          return { kind: "stay" };
        }
        if (!existing) {
          customCandidates.push(relativePath);
          customCandidates.sort((left, right) => left.localeCompare(right));
        }
        draft.custom.add(relativePath);
        return { kind: "stay" };
      },
    },
  });
  await runMenu(ctx, menu, {
    getState: () => undefined,
    signal,
    isCurrent: () => !signal?.aborted,
  });
}

async function showDraftReview(
  ctx: ExtensionCommandContext,
  original: SelectionDraft,
  draft: SelectionDraft,
  signal?: AbortSignal,
) {
  let choice: "Save changes" | "Discard changes" | "Continue editing" | undefined;
  const menu = defineMenu<undefined, "review", "choose", ExtensionCommandContext>({
    start: "review",
    screens: {
      review: () => ({
        kind: "actions",
        title: "Review included-content changes",
        lines: formatDraftPreview(original, draft).split("\n").slice(2),
        items: [
          { id: "save", label: "Save changes", action: "choose" },
          { id: "discard", label: "Discard changes", action: "choose" },
          { id: "continue", label: "Continue editing", action: "choose" },
        ],
        hint: "close",
      }),
    },
    actions: {
      choose: async ({ itemId }) => {
        choice = itemId === "save" ? "Save changes" : itemId === "continue" ? "Continue editing" : "Discard changes";
        return { kind: "close" };
      },
    },
  });
  await runMenu(ctx, menu, {
    getState: () => undefined,
    signal,
    isCurrent: () => !signal?.aborted,
  });
  return choice;
}

function updateDraft(draft: SelectionDraft, id: string, included: boolean) {
  if (id.startsWith(BUILT_IN_PREFIX)) return updateSet(draft.builtIns, id.slice(BUILT_IN_PREFIX.length), included);
  if (id.startsWith(CUSTOM_PREFIX)) return updateSet(draft.custom, id.slice(CUSTOM_PREFIX.length), included);
  if (id === SESSIONS_ID) {
    draft.sessions = included;
    return;
  }
  throw new Error(`Unknown file selection: ${id}`);
}

function updateSet(set: Set<string>, value: string, included: boolean) {
  if (included) set.add(value);
  else set.delete(value);
}

function formatDraftPreview(original: SelectionDraft, draft: SelectionDraft) {
  const lines = ["Review included-content changes", ""];
  for (const item of new Set([...original.builtIns, ...draft.builtIns, ...original.custom, ...draft.custom])) {
    const before = original.builtIns.has(item) || original.custom.has(item);
    const after = draft.builtIns.has(item) || draft.custom.has(item);
    if (before !== after) lines.push(`${after ? "Include" : "Exclude"}: ${safeTerminalText(item)}`);
  }
  if (original.sessions !== draft.sessions) lines.push(`${draft.sessions ? "Include" : "Exclude"}: sessions`);
  lines.push("", "Saving does not start a network sync.");
  return lines.join("\n");
}

async function listCustomCandidates(configured: Set<string>) {
  const candidates = new Map([...configured].map((item) => [item.toLowerCase(), item]));
  try {
    for (const entry of await fs.readdir(agentDir(), { withFileTypes: true })) {
      if ((!entry.isFile() && !entry.isDirectory()) || !isSafeCustomIncludePath(entry.name)) continue;
      if (!candidates.has(entry.name.toLowerCase())) candidates.set(entry.name.toLowerCase(), entry.name);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return [...candidates.values()].sort((left, right) => left.localeCompare(right));
}

function cloneDraft(value: SelectionDraft): SelectionDraft {
  return {
    builtIns: new Set(value.builtIns),
    custom: new Set(value.custom),
    sessions: value.sessions,
  };
}

function sameDraft(left: SelectionDraft, right: SelectionDraft) {
  return (
    left.sessions === right.sessions && sameSet(left.builtIns, right.builtIns) && sameSet(left.custom, right.custom)
  );
}

function sameSet(left: Set<string>, right: Set<string>) {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function safeTerminalText(value: string) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Escape untrusted terminal controls.
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?");
}
