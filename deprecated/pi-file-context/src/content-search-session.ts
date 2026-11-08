import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { type ContentSearchMatch, searchProjectContents } from "./content-search.js";
import { contentSearchCardCapacity, renderContentSearchScreen } from "./content-search-ui.js";
import type { LoadedProjectTextFile } from "./file-context.js";

interface ContentSearchSessionOptions {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  files: readonly string[];
  cwd?: string;
  loadFile: (path: string, signal?: AbortSignal) => Promise<LoadedProjectTextFile>;
  onPreview: (match: ContentSearchMatch) => void;
  onReference: (path: string) => void;
  onSwitchFiles: () => void;
  onCancel: () => void;
}

export class ContentSearchSession {
  private readonly input = new Input();
  private matches: ContentSearchMatch[] = [];
  private selectedIndex = 0;
  private scrollOffset = 0;
  private caseSensitive = false;
  private fuzzy = false;
  private truncated = false;
  private skippedFiles = 0;
  private loading = false;
  private request = 0;
  private controller: AbortController | undefined;
  private error: string | undefined;
  private disposed = false;

  constructor(private readonly options: ContentSearchSessionOptions) {}

  set focused(value: boolean) {
    this.input.focused = value;
  }

  activate(): void {
    this.disposed = false;
    if (this.input.getValue().trim()) this.startSearch();
  }

  deactivate(): void {
    this.focused = false;
    this.cancelSearch();
  }

  render(width: number, availableRows: number, opening: boolean, externalError?: string): string[] {
    const capacity = contentSearchCardCapacity(availableRows);
    this.keepSelectionVisible(capacity);
    const queryLabel = this.options.theme.fg("muted", "Search: ");
    const queryWidth = Math.max(1, width - visibleWidth(queryLabel));
    const queryLine = `${queryLabel}${this.input.render(queryWidth)[0] ?? ""}`;
    return renderContentSearchScreen({
      theme: this.options.theme,
      width,
      availableRows,
      queryLine,
      query: this.input.getValue(),
      cwd: this.options.cwd,
      matches: this.matches,
      selectedIndex: this.selectedIndex,
      scrollOffset: this.scrollOffset,
      caseSensitive: this.caseSensitive,
      fuzzy: this.fuzzy,
      loading: this.loading,
      opening,
      truncated: this.truncated,
      skippedFiles: this.skippedFiles,
      error: externalError ?? this.error,
    });
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, Key.ctrl("f"))) {
      this.options.onSwitchFiles();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.options.onCancel();
      return;
    }
    if (matchesKey(data, Key.alt("c"))) {
      this.caseSensitive = !this.caseSensitive;
      this.startSearch();
      return;
    }
    if (matchesKey(data, Key.alt("f"))) {
      this.fuzzy = !this.fuzzy;
      this.startSearch();
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.up")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.down")) {
      this.selectedIndex = Math.min(Math.max(0, this.matches.length - 1), this.selectedIndex + 1);
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.pageUp")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 10);
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.pageDown")) {
      this.selectedIndex = Math.min(Math.max(0, this.matches.length - 1), this.selectedIndex + 10);
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.confirm")) {
      const match = this.matches[this.selectedIndex];
      if (match) this.options.onPreview(match);
      return;
    }
    if (this.options.keybindings.matches(data, "tui.input.tab")) {
      const match = this.matches[this.selectedIndex];
      if (match) this.options.onReference(match.path);
      return;
    }

    const previousQuery = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== previousQuery) this.startSearch();
  }

  invalidate(): void {
    this.input.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelSearch();
  }

  private startSearch(): void {
    this.cancelSearch();
    const query = this.input.getValue();
    this.matches = [];
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.truncated = false;
    this.skippedFiles = 0;
    this.error = undefined;
    if (!query.trim()) return;

    const request = this.request;
    const controller = new AbortController();
    this.controller = controller;
    this.loading = true;
    void searchProjectContents(this.options.files, this.options.loadFile, query, {
      caseSensitive: this.caseSensitive,
      fuzzy: this.fuzzy,
      signal: controller.signal,
    })
      .then((result) => {
        if (!this.isCurrent(request, controller)) return;
        this.matches = result.matches;
        this.truncated = result.truncated;
        this.skippedFiles = result.skippedFiles;
      })
      .catch((error: unknown) => {
        if (this.isCurrent(request, controller) && !isAbortError(error)) {
          this.error = formatError(error);
        }
      })
      .finally(() => {
        if (request === this.request) {
          this.loading = false;
          this.controller = undefined;
        }
        if (!this.disposed) this.options.tui.requestRender();
      });
  }

  private cancelSearch(): void {
    this.request += 1;
    this.controller?.abort();
    this.controller = undefined;
    this.loading = false;
  }

  private isCurrent(request: number, controller: AbortController): boolean {
    return !this.disposed && request === this.request && this.controller === controller && !controller.signal.aborted;
  }

  private keepSelectionVisible(capacity: number): void {
    if (this.selectedIndex < this.scrollOffset) this.scrollOffset = this.selectedIndex;
    if (this.selectedIndex >= this.scrollOffset + capacity) {
      this.scrollOffset = this.selectedIndex - capacity + 1;
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
