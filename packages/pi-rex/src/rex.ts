import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { RexAgentWidget } from "./rex-agent-widget.js";
import { navigateRexPane, paneChoice } from "./rex-navigation.js";
import {
  createRexCommand,
  createRexQuery,
  errorText,
  type PiPane,
  type RexCommand,
  type RexQuery,
  type RexSnapshot,
  readRexSnapshot,
} from "./rex-snapshot.js";
import type { RexDisplay } from "./rex-widget.js";

export const WIDGET_KEY = "rex";
export const POLL_INTERVAL_MS = 2000;
type ReadSnapshot = (signal: AbortSignal) => Promise<RexSnapshot>;

class RexMonitor {
  private readonly controller = new AbortController();
  private readonly widgetState = { collapsed: false };
  private mount?: { widget?: RexAgentWidget; tui?: TUI };
  private needsClear = false;
  private navigation?: AbortController;
  private navigationTask?: Promise<void>;
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
    private readonly query: RexQuery,
    private readonly run: RexCommand,
  ) {}

  start() {
    this.publish();
    this.backgroundRefresh();
  }

  expand() {
    if (!this.current()) return;
    this.widgetState.collapsed = false;
    this.mount?.widget?.invalidate();
    this.mount?.tui?.requestRender();
  }

  private clearWidget() {
    this.mount = undefined;
    if (!this.needsClear || !this.isCurrent()) return;
    this.ctx.ui.setWidget(WIDGET_KEY, undefined);
    this.needsClear = false;
  }

  private publish() {
    if (!this.current()) return;
    if (this.mount) {
      this.mount.widget?.invalidate();
      this.mount.tui?.requestRender();
      return;
    }
    const token: NonNullable<RexMonitor["mount"]> = {};
    this.mount = token;
    this.needsClear = true;
    try {
      this.ctx.ui.setWidget(
        WIDGET_KEY,
        (tui) => {
          token.tui = tui;
          token.widget = new RexAgentWidget({
            display: () => this.display,
            theme: () => this.ctx.ui.theme,
            rows: () => tui.terminal.rows,
            isCurrent: () => this.current() && this.mount === token,
            state: this.widgetState,
            here: { sessionId: process.env.REX_SESSION, blockId: process.env.REX_BLOCK },
            navigate: (target) => {
              void this.switchPane(target);
            },
            disposed: () => {
              if (this.mount !== token) return;
              this.mount = undefined;
              this.needsClear = false;
              this.navigation?.abort();
            },
          });
          return token.widget;
        },
        { placement: "aboveEditor" },
      );
    } catch (error) {
      try {
        this.clearWidget();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Rex widget publication and cleanup failed");
      }
      throw error;
    }
  }

  cancelSwitch() {
    if (!this.current()) return;
    this.navigation?.abort();
    this.ctx.ui.notify(
      this.navigation ? "Rex switch cancelled; server focus may already have changed" : "No Rex switch is in progress",
      "info",
    );
  }

  switchPane(target?: PiPane): Promise<void> {
    if (!this.current()) return Promise.resolve();
    if (this.navigationTask) return this.navigationTask;
    const controller = new AbortController();
    this.navigation = controller;
    const signal = AbortSignal.any([controller.signal, this.controller.signal]);
    this.navigationTask = Promise.resolve()
      .then(async () => {
        signal.throwIfAborted();
        if (!target) {
          await this.refresh();
          signal.throwIfAborted();
          if (!this.current()) return;
          if (this.display.error || this.display.loading)
            throw new Error("Rex snapshot is unavailable; refresh before switching");
          const entries = this.display.entries;
          if (!entries.length) throw new Error("No Pi sessions found in Rex");
          const labels = entries.map(paneChoice);
          const choice = await this.ctx.ui.select("Switch to Rex agent", labels, { signal });
          signal.throwIfAborted();
          if (!this.current() || choice === undefined) return;
          target = entries[labels.indexOf(choice)];
          if (!target) throw new Error("Invalid Rex agent selection");
        }
        signal.throwIfAborted();
        if (!this.current()) return;
        if (this.display.error || this.display.loading)
          throw new Error("Rex snapshot is unavailable; refresh before switching");
        await navigateRexPane(this.query, this.run, target, this.ctx.ui.select.bind(this.ctx.ui), signal);
        signal.throwIfAborted();
      })
      .catch((error: unknown) => {
        if (!this.current() || signal.aborted) return;
        try {
          this.ctx.ui.notify(`Rex switch failed: ${sanitizeTerminalText(errorText(error))}`, "error");
        } catch (notificationError) {
          this.notificationError = notificationError;
        }
      })
      .finally(() => {
        this.navigation = undefined;
        this.navigationTask = undefined;
      });
    return this.navigationTask;
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
        if (changed) {
          this.display = next;
          this.publish();
        }
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
    this.navigation?.abort();
    let cleanupError: unknown;
    try {
      this.clearWidget();
    } catch (error) {
      cleanupError = error;
    }
    this.cleanup = (async () => {
      await Promise.allSettled([this.task, this.navigationTask]);
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
      monitor: new RexMonitor(
        ctx,
        () => ownerToken === marker,
        read,
        createRexQuery(pi.exec),
        createRexCommand(pi.exec),
      ),
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
    description: "Refresh the Rex widget or switch to a Rex agent",
    getArgumentCompletions: (prefix) => {
      const values = ["switch", "cancel"].filter((value) => value.startsWith(prefix));
      return values.length ? values.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const reject = (message: string) => {
        if (ctx.hasUI) ctx.ui.notify(message, "error");
        else throw new Error(message);
      };
      const route = args.trim();
      if (route && route !== "switch" && route !== "cancel") return reject("Usage: /rex [switch|cancel]");
      if (ctx.mode !== "tui") return reject("/rex requires Pi TUI mode");
      const current = owner;
      if (!current || current.manager !== ctx.sessionManager) return reject("Rex widget is not active");
      if (route === "cancel") {
        current.monitor.cancelSwitch();
        return;
      }
      current.monitor.expand();
      if (route === "switch") await current.monitor.switchPane();
      else await current.monitor.refresh();
    },
  });
}
