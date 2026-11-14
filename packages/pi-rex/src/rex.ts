import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEditorStatusPublisher, type EditorStatusPublisher } from "@narumitw/pi-tui-kit/editor-status-publisher";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { createRexQuery, errorText, type RexSnapshot, readRexSnapshot } from "./rex-snapshot.js";
import { type RexDisplay, renderRexWidget, rexSummary } from "./rex-widget.js";

export const WIDGET_KEY = "rex";
export const POLL_INTERVAL_MS = 2000;
type ReadSnapshot = (signal: AbortSignal) => Promise<RexSnapshot>;

class RexMonitor {
  private readonly controller = new AbortController();
  private readonly publisher: EditorStatusPublisher<RexDisplay>;
  private display: RexDisplay = { entries: [], warnings: [], loading: true };
  private timer?: ReturnType<typeof setTimeout>;
  private task?: Promise<void>;
  private cleanup?: Promise<void>;
  private notificationError?: unknown;
  private stopped = false;

  constructor(
    private readonly ctx: ExtensionContext,
    private readonly isCurrent: () => boolean,
    private readonly read: ReadSnapshot,
  ) {
    const here = { sessionId: process.env.REX_SESSION, blockId: process.env.REX_BLOCK };
    this.publisher = createEditorStatusPublisher({
      key: WIDGET_KEY,
      name: "Rex",
      context: ctx,
      isCurrent,
      summary: rexSummary,
      render: (snapshot, theme, width, rows) => renderRexWidget(snapshot, theme, width, rows, here),
    });
  }

  start() {
    this.publisher.publish(this.display);
    this.backgroundRefresh();
  }

  expand() {
    if (this.current()) this.publisher.setCollapsed(false);
  }

  private current() {
    return !this.stopped && this.isCurrent();
  }

  refresh(): Promise<void> {
    if (!this.current()) return Promise.resolve();
    if (this.task) return this.task;
    clearTimeout(this.timer);
    this.timer = undefined;
    // Defer the read so task ownership is installed before a synchronous failure.
    this.task = Promise.resolve()
      .then(async () => {
        if (!this.current()) return;
        let next: RexDisplay;
        try {
          next = await this.read(this.controller.signal);
        } catch (error) {
          if (!this.current() || this.controller.signal.aborted) return;
          next = { ...this.display, error: errorText(error) };
        }
        if (!this.current() || this.controller.signal.aborted) return;
        const changed = JSON.stringify(next) !== JSON.stringify(this.display);
        this.display = next;
        if (changed) this.publisher.publish(next);
      })
      .finally(() => {
        this.task = undefined;
        if (this.current()) {
          this.timer = setTimeout(() => this.backgroundRefresh(), POLL_INTERVAL_MS);
          this.timer.unref();
        }
      });
    return this.task;
  }

  private backgroundRefresh() {
    void this.refresh().catch(async (error: unknown) => {
      // Publication failed, not the Rex query. Stop polling and release the mount.
      const notify = this.current();
      const cleanup = this.dispose();
      try {
        if (notify) this.ctx.ui.notify(`Rex widget failed: ${sanitizeTerminalText(errorText(error))}`, "error");
      } catch (notificationError) {
        this.notificationError = new AggregateError([error, notificationError], "Rex failure notification failed");
      } finally {
        // The runner observes cleanup failures again at session_shutdown.
        await cleanup.catch(() => undefined);
      }
    });
  }

  dispose(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.controller.abort();
    let cleanupError: unknown;
    try {
      this.publisher.dispose();
    } catch (error) {
      cleanupError = error;
    }
    this.cleanup = (async () => {
      await this.task?.catch(() => undefined);
      if (cleanupError !== undefined || this.notificationError !== undefined) {
        this.cleanup = undefined;
        throw cleanupError ?? this.notificationError;
      }
    })();
    return this.cleanup;
  }
}

export default function rex(
  pi: ExtensionAPI,
  read: ReadSnapshot = (signal) => readRexSnapshot(createRexQuery(pi.exec), signal),
) {
  let generation = 0;
  let ownerToken: symbol | undefined;
  let requestedManager: ExtensionContext["sessionManager"] | undefined;
  let owner: { manager: ExtensionContext["sessionManager"]; monitor: RexMonitor } | undefined;

  pi.on("session_start", async (_event, ctx) => {
    const token = ++generation;
    requestedManager = ctx.sessionManager;
    const previous = owner;
    if (previous) {
      await previous.monitor.dispose();
      if (owner === previous) owner = undefined;
    }
    if (token !== generation || ctx.mode !== "tui" || !ctx.hasUI) return;
    const marker = Symbol();
    ownerToken = marker;
    const next = {
      manager: ctx.sessionManager,
      monitor: new RexMonitor(ctx, () => ownerToken === marker, read),
    };
    owner = next;
    try {
      next.monitor.start();
    } catch (error) {
      try {
        await next.monitor.dispose();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Rex initialization and cleanup failed");
      } finally {
        if (owner === next) {
          owner = undefined;
          ownerToken = undefined;
        }
      }
      throw error;
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (requestedManager === ctx.sessionManager) {
      generation++;
      requestedManager = undefined;
    }
    const previous = owner;
    if (!previous || previous.manager !== ctx.sessionManager) return;
    try {
      await previous.monitor.dispose();
    } finally {
      if (owner === previous) {
        owner = undefined;
        ownerToken = undefined;
      }
    }
  });

  pi.registerCommand("rex", {
    description: "Refresh and expand the Rex Pi session widget",
    getArgumentCompletions: () => null,
    handler: async (args, ctx) => {
      const reject = (message: string) => {
        if (ctx.hasUI) ctx.ui.notify(message, "error");
        else throw new Error(message);
      };
      if (args.trim()) return reject("Usage: /rex (no arguments)");
      if (ctx.mode !== "tui") return reject("/rex requires Pi TUI mode");
      const current = owner;
      if (!current || current.manager !== ctx.sessionManager) return reject("Rex widget is not active");
      current.monitor.expand();
      await current.monitor.refresh();
    },
  });
}
