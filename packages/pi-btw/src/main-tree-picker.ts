import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionEntry,
  type SessionTreeNode,
  TreeSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Key, matchesKey } from "@earendil-works/pi-tui";
import { showBtwCustomPreservingEditor } from "./menu.js";
import { sanitizeSingleLine } from "./text.js";

export type MainEntryPickResult = { kind: "selected"; entryId: string } | { kind: "back" } | { kind: "closed" };

export interface MainThreadTreeSelector extends Component, Focusable {
  onCopy?: (text: string | undefined) => void;
  setViewLabel?(entryId: string, label: string | undefined, labelTimestamp?: string): void;
  dispose?(): void;
}

export interface MainThreadTreeSelectorOptions {
  tree: SessionTreeNode[];
  currentLeafId: string | null;
  terminalRows: number;
  onSelect: (entryId: string) => void;
  onCancel: () => void;
  onCopy: (entryId: string | undefined, displayText: string | undefined) => void;
  onLabelChange: (entryId: string, label: string | undefined) => void;
}

export interface MainThreadTreePickerDependencies {
  createSelector?: (options: MainThreadTreeSelectorOptions) => MainThreadTreeSelector;
  copyToClipboard?: (text: string, signal: AbortSignal) => Promise<void>;
}

class MainThreadTreePickerComponent implements Component, Focusable {
  constructor(
    private readonly selector: MainThreadTreeSelector,
    private readonly onClose: () => void,
  ) {}

  get focused(): boolean {
    return this.selector.focused;
  }

  set focused(value: boolean) {
    this.selector.focused = value;
  }

  get wantsKeyRelease(): boolean | undefined {
    return this.selector.wantsKeyRelease;
  }

  render(width: number): string[] {
    return this.selector.render(width);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("c"))) {
      this.onClose();
      return;
    }
    this.selector.handleInput?.(data);
  }

  invalidate(): void {
    this.selector.invalidate();
  }

  dispose(): void {
    this.selector.dispose?.();
    this.onClose();
  }
}

export async function pickMainEntry(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  dependencies: MainThreadTreePickerDependencies = {},
): Promise<MainEntryPickResult> {
  let rawTree: SessionTreeNode[];
  let currentLeafId: string | null;
  try {
    rawTree = ctx.sessionManager.getTree();
    currentLeafId = ctx.sessionManager.getLeafId();
  } catch {
    return { kind: "closed" };
  }

  if (rawTree.length === 0) {
    notifySafely(ctx, "No main-thread entries are available", "warning");
    return { kind: "back" };
  }

  const tree = sanitizeTreeForDisplay(rawTree);
  const rawCopyText = collectRawCopyText(rawTree);
  const savedLabels = collectSavedLabels(rawTree);
  const createSelector = dependencies.createSelector ?? createNativeTreeSelector;
  const copy = dependencies.copyToClipboard ?? copyText;
  const copyControllers = new Set<AbortController>();
  const copyTasks = new Set<Promise<void>>();
  const abortCopies = () => {
    for (const controller of copyControllers) {
      controller.abort(new Error("The main-thread tree picker closed"));
    }
  };
  const result = await showBtwCustomPreservingEditor<MainEntryPickResult>(ctx, (tui, _theme, _keybindings, done) => {
    let settled = false;
    let selector: MainThreadTreeSelector | undefined;
    const finish = (value: MainEntryPickResult) => {
      if (settled) return;
      settled = true;
      abortCopies();
      done(value);
    };
    const onCopy = (entryId: string | undefined, displayText: string | undefined) => {
      if (settled) return;
      const text = entryId ? rawCopyText.get(entryId) : displayText;
      if (!text) {
        notifySafely(ctx, "Selected entry has no text to copy", "warning");
        return;
      }
      const controller = new AbortController();
      copyControllers.add(controller);
      let operation: Promise<void>;
      try {
        operation = copy(text, controller.signal);
      } catch (error: unknown) {
        operation = Promise.reject(error);
      }
      let task!: Promise<void>;
      task = operation
        .then(() => {
          if (!settled) notifySafely(ctx, "Copied selected message", "info");
        })
        .catch((error: unknown) => {
          if (!settled && !controller.signal.aborted) {
            notifySafely(ctx, `Could not copy selected message: ${formatError(error)}`, "error");
          }
        })
        .finally(() => {
          copyControllers.delete(controller);
          copyTasks.delete(task);
        });
      copyTasks.add(task);
    };
    const restoreLabel = (entryId: string) => {
      const previous = savedLabels.get(entryId);
      selector?.setViewLabel?.(entryId, previous?.label, previous?.labelTimestamp);
      tui.requestRender();
    };
    const onLabelChange = (entryId: string, label: string | undefined) => {
      if (settled) return;
      try {
        if (!ctx.sessionManager.getEntry(entryId)) {
          restoreLabel(entryId);
          notifySafely(ctx, "The selected main-thread entry is no longer available", "warning");
          return;
        }
        const persistedLabel = label === undefined ? undefined : sanitizeSingleLine(label);
        pi.setLabel(entryId, persistedLabel);
        savedLabels.set(entryId, { label: persistedLabel });
        selector?.setViewLabel?.(entryId, persistedLabel);
        tui.requestRender();
      } catch (error: unknown) {
        restoreLabel(entryId);
        notifySafely(ctx, `Could not update tree label: ${formatError(error)}`, "error");
      }
    };
    selector = createSelector({
      tree,
      currentLeafId,
      terminalRows: tui.terminal.rows,
      onSelect: (entryId) => finish({ kind: "selected", entryId }),
      onCancel: () => finish({ kind: "back" }),
      onCopy,
      onLabelChange,
    });
    return new MainThreadTreePickerComponent(selector, () => finish({ kind: "closed" }));
  });
  abortCopies();
  await Promise.allSettled([...copyTasks]);

  return result ?? { kind: "closed" };
}

function createNativeTreeSelector(options: MainThreadTreeSelectorOptions): MainThreadTreeSelector {
  const selector = new TreeSelectorComponent(
    options.tree,
    options.currentLeafId,
    options.terminalRows,
    options.onSelect,
    options.onCancel,
    options.onLabelChange,
  );
  selector.onCopy = (displayText) => options.onCopy(selector.getTreeList().getSelectedNode()?.entry.id, displayText);
  const result = selector as MainThreadTreeSelector;
  result.setViewLabel = (entryId, label, labelTimestamp) =>
    selector.getTreeList().updateNodeLabel(entryId, label, labelTimestamp);
  return result;
}

function sanitizeTreeForDisplay(tree: readonly SessionTreeNode[]): SessionTreeNode[] {
  return tree.map((node) => {
    const result: SessionTreeNode = {
      entry: sanitizeEntryForDisplay(node.entry),
      children: sanitizeTreeForDisplay(node.children),
    };
    if (node.label !== undefined) result.label = sanitizeSingleLine(node.label);
    if (node.labelTimestamp !== undefined) {
      result.labelTimestamp = sanitizeSingleLine(node.labelTimestamp);
    }
    return result;
  });
}

function sanitizeEntryForDisplay(entry: SessionEntry): SessionEntry {
  switch (entry.type) {
    case "message": {
      const message = { ...entry.message } as Record<string, unknown>;
      if ("content" in entry.message) message.content = sanitizeDisplayContent(entry.message.content);
      for (const key of ["role", "errorMessage", "command", "toolName"] as const) {
        const value = message[key];
        if (typeof value === "string") message[key] = sanitizeSingleLine(value);
      }
      return { ...entry, message } as unknown as SessionEntry;
    }
    case "custom_message":
      return {
        ...entry,
        customType: sanitizeSingleLine(entry.customType),
        content: sanitizeDisplayContent(entry.content) as typeof entry.content,
      };
    case "compaction":
      return { ...entry, summary: sanitizeSingleLine(entry.summary) };
    case "branch_summary":
      return { ...entry, summary: sanitizeSingleLine(entry.summary) };
    case "model_change":
      return {
        ...entry,
        provider: sanitizeSingleLine(entry.provider),
        modelId: sanitizeSingleLine(entry.modelId),
      };
    case "thinking_level_change":
      return { ...entry, thinkingLevel: sanitizeSingleLine(entry.thinkingLevel) };
    case "custom":
      return { ...entry, customType: sanitizeSingleLine(entry.customType) };
    case "label":
      return {
        ...entry,
        label: entry.label === undefined ? undefined : sanitizeSingleLine(entry.label),
      };
    case "session_info":
      return {
        ...entry,
        name: entry.name === undefined ? undefined : sanitizeSingleLine(entry.name),
      };
  }
}

function sanitizeDisplayContent(content: unknown): unknown {
  if (typeof content === "string") return sanitizeSingleLine(content);
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (block === null || typeof block !== "object" || !("type" in block)) return block;
    if (block.type === "text" && "text" in block && typeof block.text === "string") {
      return { ...block, text: sanitizeSingleLine(block.text) };
    }
    if (block.type === "toolCall") {
      const copy = { ...block } as Record<string, unknown>;
      if (typeof copy.name === "string") copy.name = sanitizeSingleLine(copy.name);
      copy.arguments = sanitizeToolArguments(copy.arguments, new WeakMap());
      return copy;
    }
    return block;
  });
}

function sanitizeToolArguments(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return sanitizeSingleLine(value);
  if (value === null || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) result.push(sanitizeToolArguments(item, seen));
    return result;
  }
  const result: Record<string, unknown> = {};
  seen.set(value, result);
  for (const [key, item] of Object.entries(value)) {
    result[key] = sanitizeToolArguments(item, seen);
  }
  return result;
}

function collectRawCopyText(tree: readonly SessionTreeNode[]): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (nodes: readonly SessionTreeNode[]) => {
    for (const node of nodes) {
      const text = getRawCopyText(node.entry);
      if (text !== undefined) result.set(node.entry.id, text);
      visit(node.children);
    }
  };
  visit(tree);
  return result;
}

function getRawCopyText(entry: SessionEntry): string | undefined {
  let text: string | undefined;
  if (entry.type === "message") {
    if (entry.message.role === "bashExecution") text = entry.message.command;
    else if ("content" in entry.message) {
      text = extractRawText(entry.message.content);
      if (!text && entry.message.role === "assistant") text = entry.message.errorMessage;
    }
  } else if (entry.type === "custom_message") text = extractRawText(entry.content);
  else if (entry.type === "compaction" || entry.type === "branch_summary") text = entry.summary;
  return text?.trim() ? text : undefined;
}

function extractRawText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block !== null &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("");
}

interface SavedLabel {
  label: string | undefined;
  labelTimestamp?: string;
}

function collectSavedLabels(tree: readonly SessionTreeNode[]): Map<string, SavedLabel> {
  const result = new Map<string, SavedLabel>();
  const visit = (nodes: readonly SessionTreeNode[]) => {
    for (const node of nodes) {
      result.set(node.entry.id, {
        label: node.label === undefined ? undefined : sanitizeSingleLine(node.label),
        labelTimestamp: node.labelTimestamp === undefined ? undefined : sanitizeSingleLine(node.labelTimestamp),
      });
      visit(node.children);
    }
  };
  visit(tree);
  return result;
}

async function copyText(text: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await copyToClipboard(text);
  signal.throwIfAborted();
}

function notifySafely(
  ctx: ExtensionCommandContext,
  message: string,
  level: Parameters<ExtensionCommandContext["ui"]["notify"]>[1],
): void {
  try {
    ctx.ui.notify(sanitizeSingleLine(message), level);
  } catch {
    // The command context may have been replaced while the selector was open.
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
