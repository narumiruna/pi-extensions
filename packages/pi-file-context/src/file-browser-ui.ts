import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ProjectBrowserItem } from "./file-browser.js";
import { safeTerminalText } from "./file-browser.js";

interface FileBrowserRenderOptions {
  theme: Theme;
  keybindings: KeybindingsManager;
  width: number;
  height: number;
  items: readonly ProjectBrowserItem[];
  selectedIndex: number;
  scrollOffset: number;
  currentDirectory: string;
  searchLine: string;
  searchActive: boolean;
  repositoryLabel: string;
  statuses?: ReadonlyMap<string, { code: string }>;
  loading: boolean;
  error?: string;
}

export function renderFileBrowser(options: FileBrowserRenderOptions): string[] {
  const location = options.currentDirectory ? `/${options.currentDirectory}` : "/";
  const title = options.theme.fg(
    "accent",
    options.theme.bold(`File Context · files · ${location}${options.repositoryLabel}`),
  );
  const visibleItems = options.items.slice(options.scrollOffset, options.scrollOffset + options.height);
  const itemLines = visibleItems.map((item, visibleIndex) => {
    const index = options.scrollOffset + visibleIndex;
    const prefix = index === options.selectedIndex ? "> " : "  ";
    const status = item.kind === "file" ? (options.statuses?.get(item.path)?.code ?? "  ") : "  ";
    const suffix = item.kind === "directory" ? "/" : "";
    const line = `${prefix}${status} ${item.label}${suffix}`;
    return truncateToWidth(
      index === options.selectedIndex ? options.theme.bg("selectedBg", options.theme.fg("text", line)) : line,
      options.width,
      "",
    );
  });
  if (itemLines.length === 0) {
    itemLines.push(truncateToWidth(options.theme.fg("muted", "  No matching files"), options.width, ""));
  }
  const state = options.loading
    ? options.theme.fg("warning", "Loading…")
    : options.error
      ? options.theme.fg("error", safeTerminalText(options.error))
      : options.theme.fg("muted", formatFileBrowserHint(options));
  return [
    truncateToWidth(title, options.width, ""),
    truncateToWidth(options.searchLine, options.width, ""),
    ...itemLines,
    truncateToWidth(state, options.width, ""),
  ];
}

function formatFileBrowserHint(options: FileBrowserRenderOptions): string {
  const selected = options.items[options.selectedIndex];
  const countLabel = options.searchActive
    ? `${options.items.length} matching ${options.items.length === 1 ? "file" : "files"}`
    : `${options.items.length} ${options.items.length === 1 ? "item" : "items"}`;
  const navigation = navigationHint(options.keybindings);
  const confirm = bindingHint(options.keybindings, "tui.select.confirm", ["enter"]);
  const tab = bindingHint(options.keybindings, "tui.input.tab", ["tab"]);
  const cancel = uniqueKeys([
    ...bindingKeys(options.keybindings, "tui.select.cancel", ["escape"]),
    formatHintKey("ctrl+c"),
  ]).join("/");
  return [
    countLabel,
    `${navigation} navigate`,
    `${confirm} ${selected?.kind === "directory" ? "open folder" : "preview"}`,
    ...(selected?.kind === "file" ? [`${tab} reference`] : []),
    "Ctrl+F contents",
    `${cancel} ${options.currentDirectory && !options.searchActive ? "back" : "cancel"}`,
  ].join(" · ");
}

function navigationHint(keybindings: KeybindingsManager): string {
  const up = bindingKeys(keybindings, "tui.select.up", ["up"]);
  const down = bindingKeys(keybindings, "tui.select.down", ["down"]);
  if (up.includes("↑") && down.includes("↓")) {
    return uniqueKeys(["↑↓", ...up.filter((key) => key !== "↑"), ...down.filter((key) => key !== "↓")]).join("/");
  }
  return uniqueKeys([...up, ...down]).join("/");
}

export function bindingHint(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
  fallback: readonly string[],
): string {
  return bindingKeys(keybindings, binding, fallback).join("/");
}

function bindingKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
  fallback: readonly string[],
): string[] {
  const getKeys = keybindings.getKeys?.bind(keybindings);
  const keys = getKeys?.(binding) ?? fallback;
  return uniqueKeys(keys.map(formatHintKey));
}

function uniqueKeys(keys: readonly string[]): string[] {
  return [...new Set(keys.filter(Boolean))];
}

function formatHintKey(key: string): string {
  const normalized = safeTerminalText(key).toLowerCase();
  if (normalized === "up") return "↑";
  if (normalized === "down") return "↓";
  if (normalized === "left") return "←";
  if (normalized === "right") return "→";
  if (normalized === "return" || normalized === "enter") return "Enter";
  if (normalized === "escape" || normalized === "esc") return "Esc";
  if (normalized === "tab") return "Tab";
  return normalized
    .split("+")
    .map((part, index) =>
      part === "ctrl" || part === "alt" || part === "shift" || (index > 0 && part.length === 1)
        ? `${part[0]?.toUpperCase()}${part.slice(1)}`
        : part,
    )
    .join("+");
}
