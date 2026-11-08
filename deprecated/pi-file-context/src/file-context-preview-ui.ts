import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ContentSearchMatch } from "./content-search.js";
import { highlightContentRanges } from "./content-search-ui.js";
import { bindingHint } from "./file-browser-ui.js";
import type { LoadedProjectTextFile } from "./file-context.js";
import type { GitBlameInfo, GitFileContext, GitProjectInfo, GitRevisionFile } from "./git-context.js";

export interface SelectedContextState {
  count: number;
  totalBytes: number;
  maximumCount: number;
  maximumBytes: number;
  maximumSnippetLines?: number;
  maximumSnippetBytes?: number;
}

interface FilePreviewRenderOptions {
  theme: Theme;
  keybindings: KeybindingsManager;
  width: number;
  availableRows: number;
  file: LoadedProjectTextFile;
  fileGit?: GitFileContext;
  project?: GitProjectInfo;
  revision?: GitRevisionFile;
  contentMatch?: ContentSearchMatch;
  blame?: GitBlameInfo;
  cursor: number;
  anchor?: number;
  scrollOffset: number;
  error?: string;
  selectedContext?: SelectedContextState;
  canContinue: boolean;
  canEdit: boolean;
}

export function renderFilePreview(options: FilePreviewRenderOptions): string[] {
  const { file, theme, width } = options;
  const range = selectionRange(options.anchor, options.cursor);
  const selectedText = file.lines.slice(range.start, range.end + 1).join("\n");
  const selectedBytes = Buffer.byteLength(selectedText, "utf8");
  const estimatedTokens = Math.max(1, Math.ceil(selectedBytes / 4));
  const externalEditorKey = bindingHint(options.keybindings, "app.editor.external", []);
  const footer = options.error
    ? { lines: [escapeTerminalControls(options.error)], primaryIndexes: [0] }
    : previewFooterLines(
        width,
        range.start + 1,
        range.end + 1,
        estimatedTokens,
        selectedBytes,
        options.selectedContext,
        options.canContinue,
        options.canEdit ? externalEditorKey : "",
      );
  const previewHeight = Math.max(1, options.availableRows - 1 - (options.blame ? 1 : 0) - footer.lines.length);
  const scrollOffset = visiblePreviewOffset(options.scrollOffset, options.cursor, previewHeight);
  const digits = String(Math.max(1, file.lines.length)).length;
  const changedLines = new Set(options.fileGit?.hunks.flatMap((hunk) => hunk.changedLines) ?? []);
  const deletedAtLines = new Set(
    (options.fileGit?.hunks ?? [])
      .filter((hunk) => hunk.changedLines.length === 0 && hunk.oldCount > 0)
      .map((hunk) => Math.max(1, hunk.newStart)),
  );
  const previewLines = file.lines.slice(scrollOffset, scrollOffset + previewHeight).map((rawLine, visibleIndex) => {
    const index = scrollOffset + visibleIndex;
    const selected = index >= range.start && index <= range.end;
    const cursor = index === options.cursor ? ">" : " ";
    const marker = changedLines.has(index + 1) ? "+" : deletedAtLines.has(index + 1) ? "-" : " ";
    const number = String(index + 1).padStart(digits, " ");
    const contentMatch =
      options.contentMatch?.path === file.path &&
      options.contentMatch.lineNumber === index + 1 &&
      options.contentMatch.line === rawLine
        ? options.contentMatch
        : undefined;
    const content = contentMatch
      ? highlightContentRanges(rawLine, contentMatch.ranges, theme)
      : escapeTerminalControls(rawLine);
    const line = `${cursor}${marker}${number} │ ${content}`;
    const styled = selected
      ? theme.bg("selectedBg", theme.fg("text", line))
      : index === options.cursor
        ? theme.fg("accent", line)
        : line;
    return truncateToWidth(styled, width, "");
  });
  if (previewLines.length === 0) {
    previewLines.push(truncateToWidth(theme.fg("muted", "  Empty file"), width, ""));
  }
  const gitLabel = options.revision
    ? `${escapeTerminalControls(options.revision.revision)}@${options.revision.commit.slice(0, 12)} · historical`
    : options.project
      ? `${escapeTerminalControls(options.project.branch)}@${options.project.head.slice(0, 12)}${options.project.dirty ? " · dirty" : ""}${options.fileGit?.status ? ` · ${options.fileGit.status.label}` : " · clean"}`
      : "";
  const blameLabel = options.blame
    ? `L${options.cursor + 1} · ${options.blame.committed ? options.blame.commit.slice(0, 12) : "uncommitted"} · ${escapeTerminalControls(options.blame.author)} · ${escapeTerminalControls(options.blame.summary)}`
    : "";
  const titleLine = truncateToWidth(
    theme.fg("accent", theme.bold(`${escapeTerminalControls(file.path)}${gitLabel ? ` · ${gitLabel}` : ""}`)),
    width,
    "",
  );
  const blameLine = blameLabel ? truncateToWidth(theme.fg("muted", blameLabel), width, "") : undefined;
  const renderedFooter = footer.lines.map((line) =>
    truncateToWidth(theme.fg(options.error ? "error" : "muted", line), width, ""),
  );
  return fitPreviewRows(
    titleLine,
    blameLine,
    previewLines,
    renderedFooter,
    footer.primaryIndexes,
    options.availableRows,
  );
}

export function renderFilePreviewHelp(
  theme: Theme,
  keybindings: KeybindingsManager,
  width: number,
  availableRows: number,
  canEdit: boolean,
): string[] {
  const externalEditorKey = bindingHint(keybindings, "app.editor.external", []);
  const editDetailed = canEdit
    ? externalEditorKey
      ? `${externalEditorKey.padEnd(6, " ")} Edit the current worktree file in the external editor`
      : "Edit   External editor action is unbound"
    : "Edit   Historical revisions are read-only";
  const editCompact = canEdit
    ? externalEditorKey
      ? `${externalEditorKey} edit worktree`
      : "External editor unbound"
    : "Historical revision · read-only";
  const detailed = [
    theme.fg("accent", theme.bold("Preview actions")),
    "Enter  Add selected lines and close File Context",
    "A      Add selected lines and keep browsing",
    "Space  Set or clear the range anchor; arrows extend the range",
    "[ / ]  Select the previous or next changed hunk",
    "B      Blame: show ownership for the current line when Git is available",
    "H      History: browse earlier versions of this file",
    "R      Revision: open a commit, branch, or tag",
    "D      Git diff: review and add one explicit changed hunk",
    editDetailed,
    "Esc    Return to the preview without changing selected context",
  ];
  const compact = [
    theme.fg("accent", theme.bold("Preview actions")),
    "Enter add · A keep browsing · Space range",
    "↑↓ extend · [/] hunk · B blame",
    "H history · R revision · D Git diff",
    editCompact,
    "Esc back without changing context",
  ];
  const lines = availableRows < detailed.length ? compact : detailed;
  return fitRows(
    lines.map((line) => truncateToWidth(line, width, "")),
    availableRows,
  );
}

function previewFooterLines(
  width: number,
  startLine: number,
  endLine: number,
  tokens: number,
  selectedBytes: number,
  state: SelectedContextState | undefined,
  canContinue: boolean,
  externalEditorKey: string,
): { lines: string[]; primaryIndexes: number[] } {
  const nextCount = state ? state.count + 1 : undefined;
  const nextBytes = state ? state.totalBytes + selectedBytes : undefined;
  const selectedLines = endLine - startLine + 1;
  const snippetOverLimit =
    state !== undefined &&
    ((state.maximumSnippetLines !== undefined && selectedLines > state.maximumSnippetLines) ||
      (state.maximumSnippetBytes !== undefined && selectedBytes > state.maximumSnippetBytes));
  const aggregateOverLimit =
    state !== undefined &&
    nextCount !== undefined &&
    (nextCount > state.maximumCount || (nextBytes ?? 0) > state.maximumBytes);
  const warning = snippetOverLimit
    ? "Snippet limit exceeded"
    : aggregateOverLimit
      ? "Next prompt limit exceeded"
      : undefined;
  if (width < 74) {
    const selection = `L${startLine}-${endLine} · ~${tokens} tok`;
    const capacity = state ? (warning ?? `Next ${nextCount}/${state.maximumCount}`) : undefined;
    const lines = [
      [selection, capacity].filter(Boolean).join(" · "),
      canContinue ? "Enter add · A keep browsing" : "Enter add & close",
      "↑↓ move · Space range · Esc back",
      [externalEditorKey ? `${externalEditorKey} edit` : "", "? actions"].filter(Boolean).join(" · "),
      "B blame · H history · R revision",
      "D diff · [/] hunk",
    ];
    return { lines, primaryIndexes: [1, 3] };
  }
  const selection = `Lines ${startLine}-${endLine} · ~${tokens} tokens`;
  const capacity = state
    ? snippetOverLimit
      ? "Snippet limit exceeded; shorten the range before adding"
      : aggregateOverLimit
        ? "Next prompt limit exceeded; shorten the range or review selected context"
        : `Next prompt: ${nextCount}/${state.maximumCount} snippets · ~${estimateTokens(nextBytes ?? 0)} tokens`
    : undefined;
  const primaryActions = canContinue
    ? "Enter add & close · A add & continue · ↑↓ move · Space range · Esc back"
    : "Enter add & close · ↑↓ move · Space range · Esc back";
  const editActions = [externalEditorKey ? `${externalEditorKey} edit` : "", "? actions"].filter(Boolean).join(" · ");
  return {
    lines: [
      [selection, capacity].filter(Boolean).join(" · "),
      primaryActions,
      editActions,
      "B blame · H history · R revision · D diff · [/] hunk",
    ],
    primaryIndexes: [1, 2],
  };
}

function selectionRange(anchor: number | undefined, cursor: number) {
  const rangeAnchor = anchor ?? cursor;
  return {
    start: Math.min(rangeAnchor, cursor),
    end: Math.max(rangeAnchor, cursor),
  };
}

function visiblePreviewOffset(current: number, cursor: number, height: number): number {
  if (cursor < current) return cursor;
  if (cursor >= current + height) return cursor - height + 1;
  return current;
}

function estimateTokens(bytes: number): number {
  return bytes === 0 ? 0 : Math.max(1, Math.ceil(bytes / 4));
}

function fitPreviewRows(
  title: string,
  blame: string | undefined,
  previewLines: readonly string[],
  footerLines: readonly string[],
  primaryFooterIndexes: readonly number[],
  height: number,
): string[] {
  let visibleTitle: string | undefined = title;
  let visibleBlame = blame;
  const visiblePreview = [...previewLines];
  const visibleFooter = footerLines.map((line, index) => ({
    line,
    primary: primaryFooterIndexes.includes(index),
  }));
  const rowCount = () => (visibleTitle ? 1 : 0) + (visibleBlame ? 1 : 0) + visiblePreview.length + visibleFooter.length;

  while (rowCount() > height) {
    if (visibleBlame) {
      visibleBlame = undefined;
      continue;
    }
    if (visiblePreview.length > 1) {
      visiblePreview.pop();
      continue;
    }
    let optionalFooter = -1;
    for (let index = visibleFooter.length - 1; index >= 0; index -= 1) {
      if (!visibleFooter[index]?.primary) {
        optionalFooter = index;
        break;
      }
    }
    if (optionalFooter >= 0) {
      visibleFooter.splice(optionalFooter, 1);
      continue;
    }
    if (visibleTitle) {
      visibleTitle = undefined;
      continue;
    }
    if (visiblePreview.length > 0) {
      visiblePreview.pop();
      continue;
    }
    break;
  }

  return [
    ...(visibleTitle ? [visibleTitle] : []),
    ...(visibleBlame ? [visibleBlame] : []),
    ...visiblePreview,
    ...visibleFooter.map(({ line }) => line),
  ];
}

function fitRows(lines: string[], height: number): string[] {
  if (lines.length <= height) return lines;
  if (height <= 1) return lines.slice(0, 1);
  return [...lines.slice(0, height - 1), lines.at(-1) ?? ""];
}

function escapeTerminalControls(text: string): string {
  return [...text]
    .map((character) => {
      if (character === "\t") return "    ";
      const code = character.charCodeAt(0);
      if (code <= 31 || (code >= 127 && code <= 159)) {
        return `\\x${code.toString(16).padStart(2, "0")}`;
      }
      return character;
    })
    .join("");
}
