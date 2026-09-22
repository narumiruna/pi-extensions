import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type OverlayHandle, type TUI, TuiAltScreen, truncateToWidth } from "@earendil-works/pi-tui";
import type {
  CustomInteractionComponent,
  RunCustomInteractionOptions,
  RunCustomInteractionResult,
} from "@narumitw/pi-tui-kit/custom-interaction";

export type NotesFullscreenTuiFactory = (parent: TUI) => TuiAltScreen;

interface FullscreenInteractionDependencies {
  createTui?: NotesFullscreenTuiFactory;
}

type FullscreenOutcome<Value> =
  | { kind: "completed"; value: Value }
  | { kind: "stale" }
  | { kind: "error"; error: unknown };

export async function runFullscreenInteraction<Value>(
  ctx: ExtensionCommandContext,
  options: RunCustomInteractionOptions<Value>,
  dependencies: FullscreenInteractionDependencies = {},
): Promise<RunCustomInteractionResult<Value>> {
  if (options.signal?.aborted || !(options.isCurrent?.() ?? true)) return { kind: "stale" };
  if (ctx.mode !== "tui" || !ctx.hasUI) return { kind: "unsupported", mode: ctx.mode };

  let host: FullscreenInteractionHost<Value> | undefined;
  let outcome: FullscreenOutcome<Value> | undefined;
  let uiFailed = false;
  let uiError: unknown;
  try {
    outcome = await ctx.ui.custom<FullscreenOutcome<Value> | undefined>(
      (parent, theme, keybindings, done) => {
        host = new FullscreenInteractionHost({
          ctx,
          parent,
          theme,
          keybindings,
          done,
          options,
          createTui:
            dependencies.createTui ??
            ((source) =>
              new TuiAltScreen(source.terminal, source.getShowHardwareCursor(), undefined, {
                mouse: true,
              })),
        });
        return host;
      },
      {
        overlay: true,
        onHandle: (handle) => host?.setParentOverlay(handle),
      },
    );
  } catch (error) {
    uiFailed = true;
    uiError = error;
  }
  if (uiFailed || outcome === undefined) host?.dispose();
  try {
    await host?.waitForPending();
  } catch (error) {
    uiFailed = true;
    uiError = error;
  }
  if (uiFailed) outcome = { kind: "error", error: uiError };

  if (options.signal?.aborted || !(options.isCurrent?.() ?? true) || outcome?.kind === "stale") {
    return { kind: "stale" };
  }
  if (outcome?.kind === "completed") return outcome;
  if (outcome?.kind === "error") {
    await options.onError?.(ctx, outcome.error);
    return outcome;
  }
  return { kind: "stale" };
}

interface FullscreenInteractionHostOptions<Value> {
  ctx: ExtensionCommandContext;
  parent: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  done(outcome: FullscreenOutcome<Value>): void;
  options: RunCustomInteractionOptions<Value>;
  createTui: NotesFullscreenTuiFactory;
}

class FullscreenInteractionHost<Value> implements Component {
  private readonly lifetime = new AbortController();
  private readonly signal: AbortSignal;
  private readonly startPromise: Promise<void>;
  private removeUpstreamAbort = () => {};
  private parentOverlay: OverlayHandle | undefined;
  private fullscreen: TuiAltScreen | undefined;
  private component: CustomInteractionComponent | undefined;
  private parentStopped = false;
  private fullscreenStarted = false;
  private componentDisposed = false;
  private stopping = false;
  private finished = false;
  private finishPromise: Promise<void> | undefined;
  private startFailed = false;
  private startError: unknown;

  constructor(private readonly host: FullscreenInteractionHostOptions<Value>) {
    this.signal = host.options.signal
      ? AbortSignal.any([host.options.signal, this.lifetime.signal])
      : this.lifetime.signal;
    const abort = () => void this.finish({ kind: "stale" });
    host.options.signal?.addEventListener("abort", abort, { once: true });
    this.removeUpstreamAbort = () => host.options.signal?.removeEventListener("abort", abort);
    this.startPromise = Promise.resolve()
      .then(() => this.start())
      .catch((error: unknown) => {
        this.startFailed = true;
        this.startError = error;
      });
    void this.startPromise.then(() => {
      if (this.startFailed) void this.finish({ kind: "error", error: this.startError });
    });
    if (host.options.signal?.aborted) abort();
  }

  setParentOverlay(handle: OverlayHandle): void {
    this.parentOverlay = handle;
  }

  render(width: number): string[] {
    return [truncateToWidth(this.host.theme.fg("muted", "Opening Pi Notes fullscreen workspace…"), width)];
  }

  invalidate(): void {}

  dispose(): void {
    void this.finish({ kind: "stale" });
  }

  async waitForPending(): Promise<void> {
    await this.startPromise;
    await this.finishPromise;
  }

  private async start(): Promise<void> {
    if (this.stopping) return;
    if (this.signal.aborted || !(this.host.options.isCurrent?.() ?? true)) {
      void this.finish({ kind: "stale" });
      return;
    }
    this.host.parent.stop({ preserveScreen: true });
    this.parentStopped = true;
    if (this.stopping) return;

    this.fullscreen = this.host.createTui(this.host.parent);
    this.fullscreenStarted = true;
    this.fullscreen.start();
    if (this.stopping) return;

    this.component = await this.host.options.create({
      ctx: this.host.ctx,
      tui: this.fullscreen,
      theme: this.host.theme,
      keybindings: this.host.keybindings,
      signal: this.signal,
      complete: (value) => {
        const outcome =
          this.signal.aborted || !(this.host.options.isCurrent?.() ?? true)
            ? ({ kind: "stale" } as const)
            : ({ kind: "completed", value } as const);
        void this.finish(outcome);
      },
    });
    if (this.stopping) return;
    if (this.signal.aborted || !(this.host.options.isCurrent?.() ?? true)) {
      void this.finish({ kind: "stale" });
      return;
    }
    this.fullscreen.setLayoutRoot(this.component);
    this.fullscreen.setFocus(this.component);
    this.fullscreen.requestRender();
  }

  private finish(outcome: FullscreenOutcome<Value>): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    this.stopping = true;
    this.lifetime.abort(new DOMException("Pi Notes fullscreen interaction closed", "AbortError"));
    this.removeUpstreamAbort();
    this.removeUpstreamAbort = () => {};
    this.finishPromise = (async () => {
      await this.startPromise;
      let cleanupError: unknown;
      try {
        this.disposeComponent();
      } catch (error) {
        cleanupError = error;
      }
      try {
        await this.component?.waitForPending?.();
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        this.fullscreen?.setFocus(null);
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        this.fullscreen?.setLayoutRoot(undefined);
      } catch (error) {
        cleanupError ??= error;
      }
      if (this.fullscreenStarted) {
        try {
          await this.fullscreen?.terminal.drainInput();
        } catch (error) {
          cleanupError ??= error;
        }
        try {
          this.fullscreen?.stop({ preserveScreen: true });
        } catch (error) {
          cleanupError ??= error;
        }
      }
      try {
        this.parentOverlay?.setHidden(true);
      } catch (error) {
        cleanupError ??= error;
      }
      if (this.parentStopped) {
        try {
          this.host.parent.start();
          this.host.parent.renderNow(false);
        } catch (error) {
          cleanupError ??= error;
        }
      }
      if (this.finished) return;
      this.finished = true;
      const stale = this.host.options.signal?.aborted || !(this.host.options.isCurrent?.() ?? true);
      this.host.done(
        stale ? { kind: "stale" } : cleanupError === undefined ? outcome : { kind: "error", error: cleanupError },
      );
    })();
    return this.finishPromise;
  }

  private disposeComponent(): void {
    if (!this.component || this.componentDisposed) return;
    this.componentDisposed = true;
    this.component.dispose?.();
  }
}
