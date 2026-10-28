import {
  copyToClipboard as copyToHostClipboard,
  type ExtensionCommandContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, type OverlayHandle, ScrollView, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { createFullscreenHandoff, FullscreenHandoff } from "@narumitw/pi-tui-kit";
import {
  type BtwFullscreenTui,
  createBtwFullscreenTui,
  hasManualSelectionCopyApi,
  openUrlInBrowser,
} from "./fullscreen-renderer.js";
import {
  type BtwKeybindingOverrides,
  BtwPasteGuard,
  getBtwShortcuts,
  resolveBtwShortcuts,
  setBtwHostInputBlockers,
  setBtwKeybindings,
  setBtwShortcuts,
} from "./keybindings.js";
import type { BtwMainThreadUpdateSubscription } from "./main-thread-updates.js";
import type { BtwLayout } from "./settings.js";
import { sanitizeSingleLine } from "./text.js";
import { type BtwFullscreenLayoutComponent, BtwMainThreadInput, BtwSplitPane } from "./workspace-layout.js";

type BtwCustomOptions = Parameters<ExtensionCommandContext["ui"]["custom"]>[1];
type BtwCustomFactory<T> = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: T) => void,
) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>;

type FocusInspectableTui = TUI & {
  getFocusedComponent?(): Component | null;
};

export interface BtwFullscreenOptions {
  signal?: AbortSignal;
  canRestoreParent?(): boolean;
  keybindings?: BtwKeybindingOverrides;
  copyOnSelect?: boolean;
  layout?: BtwLayout;
  sidePaneRatio?: number;
  persistSidePaneRatio?(ratio: number, signal: AbortSignal): Promise<void>;
  subscribeMainThreadUpdates?: BtwMainThreadUpdateSubscription;
}

export type BtwFullscreenTuiFactory = (
  parent: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  options: BtwFullscreenOptions,
) => BtwFullscreenTui;

export interface BtwFullscreenDependencies {
  createTui?: BtwFullscreenTuiFactory;
  openUrl?: (url: string) => void;
  copyToClipboard?: (text: string) => Promise<void>;
  manualSelectionCopySupported?: boolean;
}

export type RunBtwFullscreen = <T>(
  ctx: ExtensionCommandContext,
  run: (ctx: ExtensionCommandContext) => Promise<T>,
  options?: BtwFullscreenOptions,
) => Promise<T>;

type FullscreenOutcome<T> = { kind: "completed"; value: T } | { kind: "failed"; error: unknown };

class FullscreenUiDisposedError extends Error {
  constructor() {
    super("The dedicated pi-btw UI was disposed.");
    this.name = "FullscreenUiDisposedError";
  }
}

export async function runBtwFullscreen<T>(
  ctx: ExtensionCommandContext,
  run: (ctx: ExtensionCommandContext) => Promise<T>,
  options: BtwFullscreenOptions = {},
  dependencies: BtwFullscreenDependencies = {},
): Promise<T> {
  const { createFullscreenHandoff } = await import("@narumitw/pi-tui-kit/fullscreen-handoff");
  if (ctx.signal?.aborted || options.signal?.aborted || options.canRestoreParent?.() === false) {
    throw new FullscreenUiDisposedError();
  }
  const createTui =
    dependencies.createTui ??
    ((parent: TUI, theme: Theme, keybindings: KeybindingsManager, fullscreenOptions: BtwFullscreenOptions) =>
      createBtwFullscreenTui(
        parent,
        theme,
        keybindings,
        fullscreenOptions.copyOnSelect ?? true,
        dependencies.manualSelectionCopySupported ?? hasManualSelectionCopyApi(),
        dependencies.openUrl ?? openUrlInBrowser,
        dependencies.copyToClipboard ?? copyToHostClipboard,
      ));
  let liveEditorText = ctx.ui.getEditorText();
  let restoreEditor = false;
  let host: BtwFullscreenHost<T> | undefined;
  const outcome = await ctx.ui.custom<FullscreenOutcome<T>>(
    (parent, theme, keybindings, done) => {
      host = new BtwFullscreenHost(
        parent,
        theme,
        keybindings,
        ctx,
        run,
        (value) => {
          try {
            if (options.canRestoreParent?.() === false) {
              done(value);
              return;
            }
            liveEditorText = ctx.ui.getEditorText();
            restoreEditor = true;
          } catch {
            // A replaced session owns a different editor and must not receive stale text.
          }
          done(value);
        },
        createTui,
        options,
        createFullscreenHandoff,
      );
      return host;
    },
    {
      overlay: true,
      onHandle: (handle) => host?.setParentOverlay(handle),
    },
  );
  if (restoreEditor && options.canRestoreParent?.() !== false) {
    try {
      if (ctx.ui.getEditorText() !== liveEditorText) ctx.ui.setEditorText(liveEditorText);
    } catch {
      // A replaced session owns a different editor and must not receive stale restoration.
    }
  }
  if (outcome.kind === "failed") throw outcome.error;
  return outcome.value;
}

class BtwFullscreenHost<T> implements Component {
  private fullscreen: BtwFullscreenTui | undefined;
  private readonly handoff: FullscreenHandoff<BtwFullscreenTui>;
  private cancelActiveCustom: (() => void) | undefined;
  private hardCancelActiveCustom: (() => void) | undefined;
  private removeHardCancelListener: (() => void) | undefined;
  private removeUpstreamAbortListener: (() => void) | undefined;
  private started = false;
  private disposed = false;
  private finished = false;
  private parentRestorePromise: Promise<void> | undefined;
  private readonly cleanupErrors: unknown[] = [];
  private removeMainThreadUpdateListener: (() => void) | undefined;
  private mainThreadRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly mainThreadInput: BtwMainThreadInput;
  private readonly lifetimeController = new AbortController();
  private readonly pendingSidePaneWrites = new Set<Promise<void>>();
  private sidePaneRatio: number | undefined;
  private sidePaneWriteGeneration = 0;
  private confirmedSidePaneWriteGeneration = 0;

  constructor(
    private readonly parent: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly ctx: ExtensionCommandContext,
    private readonly run: (ctx: ExtensionCommandContext) => Promise<T>,
    private readonly done: (outcome: FullscreenOutcome<T>) => void,
    private readonly createTui: BtwFullscreenTuiFactory,
    private readonly options: BtwFullscreenOptions,
    createHandoff: typeof createFullscreenHandoff,
  ) {
    const initialMainInput = getFocusedComponent(parent);
    this.mainThreadInput = new BtwMainThreadInput(
      initialMainInput,
      () => {
        const target = getFocusedComponent(parent);
        return target === this ? initialMainInput : target;
      },
      () => this.fullscreen?.requestRender(),
    );
    this.handoff = createHandoff<BtwFullscreenTui>(parent, {
      isCurrent: () =>
        !this.disposed &&
        !this.finished &&
        !this.lifetimeController.signal.aborted &&
        this.options.canRestoreParent?.() !== false,
      canRestoreParent: () => this.options.canRestoreParent?.() !== false,
    });
    this.sidePaneRatio = options.sidePaneRatio;
    queueMicrotask(() => void this.start());
  }

  setParentOverlay(overlay: OverlayHandle): void {
    this.handoff.setOverlayHandle(overlay);
  }

  render(width: number): string[] {
    return [truncateToWidth(this.theme.fg("muted", "Opening btw side thread…"), width)];
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed || this.finished) return;
    this.disposed = true;
    this.lifetimeController.abort();
    try {
      this.cancelActiveCustom?.();
    } finally {
      this.queueParentRestore();
    }
  }

  private async start(): Promise<void> {
    if (this.started || this.finished) return;
    this.started = true;
    let outcome: FullscreenOutcome<T>;
    try {
      this.watchUpstreamCancellation();
      if (this.disposed) throw new FullscreenUiDisposedError();
      if ((this.options.layout ?? "fullscreen") !== "fullscreen") {
        getParentFullscreenLayout(this.parent);
        getParentFullscreenScrollView(this.parent);
      }
      this.fullscreen = await this.handoff.enter(() =>
        this.createTui(this.parent, this.theme, this.keybindings, this.options),
      );
      if (!this.fullscreen || this.disposed || this.finished || this.options.canRestoreParent?.() === false) {
        throw new FullscreenUiDisposedError();
      }
      this.watchMainThreadUpdates();
      const shortcuts = resolveBtwShortcuts(
        this.options.keybindings,
        this.keybindings,
        this.options.copyOnSelect ?? true,
      );
      setBtwShortcuts(this.fullscreen, shortcuts);
      setBtwKeybindings(this.fullscreen, this.keybindings);
      setBtwHostInputBlockers(
        this.fullscreen,
        this.options.copyOnSelect === false ? this.keybindings.getKeys("app.message.copy") : [],
      );
      // Negotiate before warning when possible: the first dispatched user input uses
      // the current mode. Recheck each input, including later mode transitions.
      let previousWarnings: readonly string[] = [];
      const reportWarnings = () => {
        const warnings = shortcuts.warnings;
        for (const warning of warnings) {
          if (previousWarnings.includes(warning)) continue;
          try {
            this.ctx.ui.notify(`Pi BTW: ${warning}`, "warning");
          } catch {
            /* A replaced context must not prevent terminal cleanup. */
          }
        }
        previousWarnings = warnings;
      };
      const pasteGuard = new BtwPasteGuard();
      // Waiting for the custom promise would leave follow-up keys bound to the side TUI.
      const addHardCancelListener =
        this.fullscreen.addInputListenerBeforeAll?.bind(this.fullscreen) ??
        this.fullscreen.addInputListenerBeforeViewport?.bind(this.fullscreen) ??
        this.fullscreen.addInputListener.bind(this.fullscreen);
      this.removeHardCancelListener = addHardCancelListener((data) => {
        reportWarnings();
        if (pasteGuard.consume(data) || !shortcuts.matches(data, "exit")) return undefined;
        this.disposed = true;
        this.lifetimeController.abort();
        try {
          this.hardCancelActiveCustom?.();
        } finally {
          // ProcessTerminal.stop() destroys its active input buffer. Keep cancellation
          // synchronous, then drain input before the physical Windows terminal handoff.
          // Pi has no public input injection, so do not replay bytes already coalesced
          // behind the hard-cancel key.
          this.queueParentRestore();
        }
        return { consume: true };
      });
      const value = await this.runUntilCancelled();
      await this.waitForSidePaneWrites();
      outcome = { kind: "completed", value };
    } catch (error) {
      await this.waitForSidePaneWrites();
      outcome = { kind: "failed", error };
    }

    try {
      this.cancelActiveCustom?.();
    } catch (error) {
      this.cleanupErrors.push(error);
    }
    this.queueParentRestore();
    await this.parentRestorePromise;
    if (this.cleanupErrors.length) {
      outcome = {
        kind: "failed",
        error: combineErrors(
          outcome.kind === "failed" ? [outcome.error, ...this.cleanupErrors] : this.cleanupErrors,
          "Pi BTW flow and terminal cleanup failed",
        ),
      };
    }
    this.finished = true;
    this.done(outcome);
  }

  private async runUntilCancelled(): Promise<T> {
    const signal = this.lifetimeController.signal;
    let removeAbort: (() => void) | undefined;
    let cancellation: ReturnType<typeof setImmediate> | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      // Let synchronous root cancellation and its promise continuations settle
      // normally; abandon only a continuation that ignores the owned signal.
      const onAbort = () => {
        cancellation ??= setImmediate(() => reject(new FullscreenUiDisposedError()));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) onAbort();
    });
    try {
      // Observe late failures even when cancellation settles the owning UI first.
      if (signal.aborted) throw new FullscreenUiDisposedError();
      return await Promise.race([this.run(this.createContext()), cancelled]);
    } finally {
      removeAbort?.();
      if (cancellation) clearImmediate(cancellation);
    }
  }

  private watchUpstreamCancellation(): void {
    const signals = [this.ctx.signal, this.options.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    if (!signal) return;
    const onAbort = () => this.dispose();
    signal.addEventListener("abort", onAbort, { once: true });
    this.removeUpstreamAbortListener = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) onAbort();
  }

  private queueParentRestore(): void {
    if (this.parentRestorePromise) return;
    const restoration = this.handoff.restore().catch((error: unknown) => {
      this.cleanupErrors.push(error);
    });
    this.parentRestorePromise = Promise.resolve().then(async () => {
      this.restoreParent();
      await restoration;
    });
  }

  private watchMainThreadUpdates(): void {
    if ((this.options.layout ?? "fullscreen") === "fullscreen") return;
    this.removeMainThreadUpdateListener = this.options.subscribeMainThreadUpdates?.(() => {
      this.mainThreadInput.refreshTarget();
      if (this.mainThreadRefreshTimer || this.disposed || this.finished) return;
      this.mainThreadRefreshTimer = setTimeout(() => {
        this.mainThreadRefreshTimer = undefined;
        if (!this.disposed && !this.finished) this.fullscreen?.requestRender();
      }, 0);
      this.mainThreadRefreshTimer.unref();
    });
  }

  private restoreParent(): void {
    if (this.mainThreadRefreshTimer) {
      clearTimeout(this.mainThreadRefreshTimer);
      this.mainThreadRefreshTimer = undefined;
    }
    const removeMainThreadUpdateListener = this.removeMainThreadUpdateListener;
    this.removeMainThreadUpdateListener = undefined;
    try {
      removeMainThreadUpdateListener?.();
    } catch (error) {
      this.cleanupErrors.push(error);
    }
    try {
      this.mainThreadInput.dispose();
    } catch (error) {
      this.cleanupErrors.push(error);
    }
    const removeUpstreamAbortListener = this.removeUpstreamAbortListener;
    this.removeUpstreamAbortListener = undefined;
    try {
      removeUpstreamAbortListener?.();
    } catch (error) {
      this.cleanupErrors.push(error);
    }
    const removeHardCancelListener = this.removeHardCancelListener;
    this.removeHardCancelListener = undefined;
    try {
      removeHardCancelListener?.();
    } catch (error) {
      this.cleanupErrors.push(error);
    }
  }

  private createContext(): ExtensionCommandContext {
    const ui = new Proxy(this.ctx.ui, {
      get: (target, property) => {
        if (property === "custom") {
          return <Value>(factory: BtwCustomFactory<Value>, options?: BtwCustomOptions) =>
            this.showCustom(factory, options);
        }
        if (property === "notify") {
          return (message: string, level?: Parameters<ExtensionCommandContext["ui"]["notify"]>[1]) => {
            if (this.disposed || this.finished) return;
            target.notify(message, level);
            const display = sanitizeSingleLine(message);
            if (display) this.fullscreen?.flash?.(display);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function"
          ? (...args: unknown[]) => {
              if (
                this.disposed ||
                this.finished ||
                this.lifetimeController.signal.aborted ||
                this.options.canRestoreParent?.() === false
              ) {
                throw new FullscreenUiDisposedError();
              }
              return Reflect.apply(value, target, args);
            }
          : value;
      },
    });
    const signal = this.ctx.signal
      ? AbortSignal.any([this.ctx.signal, this.lifetimeController.signal])
      : this.lifetimeController.signal;
    return new Proxy(this.ctx, {
      get: (target, property) => {
        if (property === "ui") return ui;
        if (property === "signal") return signal;
        return Reflect.get(target, property, target);
      },
    });
  }

  private showCustom<Value>(factory: BtwCustomFactory<Value>, options?: BtwCustomOptions): Promise<Value> {
    const fullscreen = this.fullscreen;
    if (!fullscreen || this.disposed || this.finished) {
      return Promise.reject(new FullscreenUiDisposedError());
    }
    if (this.cancelActiveCustom) {
      return Promise.reject(new Error("pi-btw attempted to open overlapping custom UI."));
    }

    return new Promise<Value>((resolve, reject) => {
      let component: (Component & { dispose?(): void }) | undefined;
      let overlay: OverlayHandle | undefined;
      let splitPane: BtwSplitPane | undefined;
      let removePaneFocusListener: (() => void) | undefined;
      let mounted = false;
      let layoutMounted = false;
      let factorySettled = false;
      let closed = false;
      let promiseSettled = false;
      let componentDisposed = false;
      let pendingValue: Value | undefined;
      let hasPendingValue = false;

      const disposeComponent = () => {
        if (!component || componentDisposed) return;
        componentDisposed = true;
        try {
          component.dispose?.();
        } catch (error) {
          this.cleanupErrors.push(error);
        }
      };
      const unmount = () => {
        const cleanupErrors: unknown[] = [];
        const removeFocusListener = removePaneFocusListener;
        removePaneFocusListener = undefined;
        try {
          removeFocusListener?.();
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          splitPane?.dispose();
        } catch (error) {
          cleanupErrors.push(error);
        }
        splitPane = undefined;
        try {
          if (overlay) overlay.hide();
          else if (mounted && layoutMounted) fullscreen.setLayoutRoot(undefined);
          else if (mounted && component) fullscreen.removeChild(component);
        } catch (error) {
          cleanupErrors.push(error);
        }
        if (overlay || mounted) {
          try {
            fullscreen.setFocus(null);
            fullscreen.requestRender();
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        disposeComponent();
        if (cleanupErrors.length) throw combineErrors(cleanupErrors, "Pi BTW custom UI cleanup failed");
      };
      const complete = () => {
        if (promiseSettled || !hasPendingValue) return;
        promiseSettled = true;
        this.cancelActiveCustom = undefined;
        this.hardCancelActiveCustom = undefined;
        if (!factorySettled) {
          resolve(pendingValue as Value);
          return;
        }
        try {
          unmount();
          resolve(pendingValue as Value);
        } catch (error) {
          reject(error);
        }
      };
      const close = (value: Value) => {
        if (closed || promiseSettled) return;
        closed = true;
        pendingValue = value;
        hasPendingValue = true;
        complete();
      };
      const fail = (error: unknown) => {
        if (promiseSettled) return;
        closed = true;
        promiseSettled = true;
        this.cancelActiveCustom = undefined;
        this.hardCancelActiveCustom = undefined;
        try {
          unmount();
          reject(error);
        } catch (cleanupError) {
          reject(combineErrors([error, cleanupError], "Pi BTW custom UI and cleanup failed"));
        }
      };
      this.cancelActiveCustom = () => {
        if (promiseSettled) return;
        disposeComponent();
        if (!promiseSettled) fail(new FullscreenUiDisposedError());
      };
      this.hardCancelActiveCustom = () => {
        if (promiseSettled) return;
        try {
          component?.handleInput?.("\u0003");
        } catch (error) {
          fail(error);
          return;
        }
        this.cancelActiveCustom?.();
      };

      let created: ReturnType<BtwCustomFactory<Value>>;
      try {
        created = factory(fullscreen, this.theme, this.keybindings, close);
      } catch (error) {
        factorySettled = true;
        fail(error);
        return;
      }
      Promise.resolve(created)
        .then(async (value) => {
          component = value;
          factorySettled = true;
          if (promiseSettled) {
            disposeComponent();
            return;
          }
          if (closed) {
            complete();
            return;
          }
          const workspaceLayout = this.options.layout ?? "fullscreen";
          if (!options?.overlay && workspaceLayout !== "fullscreen") {
            await this.waitForSidePaneWrites();
            if (promiseSettled) {
              disposeComponent();
              return;
            }
            if (closed) {
              complete();
              return;
            }
            if (this.disposed || this.finished || this.fullscreen !== fullscreen) {
              fail(new FullscreenUiDisposedError());
              return;
            }
          }
          if (options?.overlay) {
            const overlayOptions =
              typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
            overlay = fullscreen.showOverlay(component, overlayOptions);
            options.onHandle?.(overlay);
          } else {
            fullscreen.clear();
            mounted = true;
            if (workspaceLayout !== "fullscreen") {
              layoutMounted = true;
              const sideLayout = isFullscreenLayoutComponent(component) ? component.getFullscreenLayout() : component;
              splitPane = new BtwSplitPane({
                sideComponent: component,
                sideLayout,
                mainThread: this.parent,
                mainLayout: getParentFullscreenLayout(this.parent),
                mainScrollView: getParentFullscreenScrollView(this.parent),
                mainInput: this.mainThreadInput,
                sideScrollView: isFullscreenLayoutComponent(component) ? component.getPrimaryScrollView?.() : undefined,
                layout: workspaceLayout,
                shortcuts: getBtwShortcuts(fullscreen),
                theme: this.theme,
                terminalColumns: () => fullscreen.terminal.columns,
                terminalRows: () => fullscreen.terminal.rows,
                hasFocusedOverlay: () => fullscreen.hasFocusedOverlay?.() ?? false,
                setFocus: (target) => fullscreen.setFocus(target),
                setViewportTarget: (target) => fullscreen.setViewportTarget?.(target),
                requestRender: () => fullscreen.requestRender(),
                sidePaneRatio: this.sidePaneRatio,
                ...(this.options.persistSidePaneRatio
                  ? { persistSidePaneRatio: (ratio: number) => this.persistSidePaneRatio(ratio) }
                  : {}),
              });
              const addPaneFocusListener =
                fullscreen.addInputListenerBeforeViewport?.bind(fullscreen) ??
                fullscreen.addInputListener.bind(fullscreen);
              removePaneFocusListener = addPaneFocusListener((data) => {
                const consumed = splitPane?.handleTerminalInput(data);
                return consumed ? { consume: true } : undefined;
              });
              fullscreen.setLayoutRoot(splitPane.getFullscreenLayout());
            } else if (isFullscreenLayoutComponent(component)) {
              layoutMounted = true;
              fullscreen.setLayoutRoot(component.getFullscreenLayout());
            } else {
              fullscreen.addChild(component);
            }
            fullscreen.setFocus(component);
            fullscreen.requestRender();
          }
        })
        .catch(fail);
    });
  }

  private persistSidePaneRatio(ratio: number): Promise<void> {
    const persist = this.options.persistSidePaneRatio;
    if (!persist) {
      this.sidePaneRatio = ratio;
      return Promise.resolve();
    }
    const writeGeneration = ++this.sidePaneWriteGeneration;
    let task!: Promise<void>;
    task = Promise.resolve()
      .then(() => persist(ratio, this.lifetimeController.signal))
      .then(() => {
        if (this.lifetimeController.signal.aborted || writeGeneration <= this.confirmedSidePaneWriteGeneration) {
          return;
        }
        this.confirmedSidePaneWriteGeneration = writeGeneration;
        this.sidePaneRatio = ratio;
      })
      .catch((error: unknown) => {
        if (!this.lifetimeController.signal.aborted) {
          const message = sanitizeSingleLine(
            `Pi BTW pane width was not saved; the previous value remains active: ${formatError(error)}`,
          );
          try {
            this.ctx.ui.notify(message, "error");
          } catch {
            // A replaced command context must not prevent rollback or cleanup.
          }
          this.fullscreen?.flash?.(message);
        }
        throw error;
      })
      .finally(() => this.pendingSidePaneWrites.delete(task));
    this.pendingSidePaneWrites.add(task);
    return task;
  }

  private async waitForSidePaneWrites(): Promise<void> {
    while (this.pendingSidePaneWrites.size > 0) {
      await Promise.allSettled([...this.pendingSidePaneWrites]);
    }
  }
}

// Keep an existing aggregate intact unless it overlaps causes already collected.
function combineErrors(errors: readonly unknown[], message: string): unknown {
  const causes: unknown[] = [];
  const seen = new Set<unknown>();
  const remember = (error: unknown): void => {
    if (seen.has(error)) return;
    seen.add(error);
    if (error instanceof AggregateError) error.errors.forEach(remember);
  };
  const overlaps = (error: unknown, visited = new Set<unknown>()): boolean => {
    if (seen.has(error)) return true;
    if (visited.has(error)) return false;
    visited.add(error);
    return error instanceof AggregateError && error.errors.some((cause: unknown) => overlaps(cause, visited));
  };
  const append = (error: unknown): void => {
    if (seen.has(error)) return;
    if (error instanceof AggregateError && overlaps(error)) {
      seen.add(error);
      error.errors.forEach(append);
      return;
    }
    causes.push(error);
    remember(error);
  };
  errors.forEach(append);
  return causes.length === 1 ? causes[0] : new AggregateError(causes, message);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getFocusedComponent(tui: TUI): Component | null {
  return (tui as FocusInspectableTui).getFocusedComponent?.() ?? null;
}

// Pi does not expose the mounted fullscreen layout root. Reusing this runtime
// field lets Pi's own layout engine constrain its transcript and dock to the pane.
function getParentFullscreenLayout(tui: TUI): Component | undefined {
  if (tui.mode !== "fullscreen") return undefined;
  const layoutRoot = Reflect.get(tui, "layoutRoot") as unknown;
  if (!isComponent(layoutRoot)) {
    throw new Error("Pi BTW cannot compose this fullscreen layout; use the fullscreen BTW layout or update Pi.");
  }
  return layoutRoot;
}

// Use the viewport chosen by Pi's actual layout pass. A children walk cannot
// reproduce native visibility, zero-width allocation, or nested scroll ordering.
function getParentFullscreenScrollView(tui: TUI): ScrollView | undefined {
  if (tui.mode !== "fullscreen") return undefined;
  const layout = Reflect.get(tui, "currentLayout") as { primaryScrollView?: unknown } | undefined;
  if (!layout || !(layout.primaryScrollView instanceof ScrollView)) {
    throw new Error("Pi BTW cannot identify this fullscreen viewport; use the fullscreen BTW layout or update Pi.");
  }
  return layout.primaryScrollView;
}

function isComponent(value: unknown): value is Component {
  return (
    typeof value === "object" &&
    value !== null &&
    "render" in value &&
    typeof value.render === "function" &&
    "invalidate" in value &&
    typeof value.invalidate === "function"
  );
}

function isFullscreenLayoutComponent(component: Component): component is BtwFullscreenLayoutComponent {
  return "getFullscreenLayout" in component && typeof component.getFullscreenLayout === "function";
}
