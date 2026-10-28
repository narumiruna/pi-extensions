import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";

function aggregate(errors: unknown[], label: string): AggregateError {
  const first = errors[0];
  const detail = first instanceof Error ? first.message : typeof first === "string" ? first : "Unknown error";
  return new AggregateError(errors, `${label}: ${detail}`);
}

export interface FullscreenHandoffOptions {
  /** Whether this flow still owns entry. Checked again after native drain. */
  isCurrent?(): boolean;
  /** Whether the shared parent terminal is still live, even after a context change. */
  canRestoreParent?(): boolean;
}

export interface FullscreenHandoff<Child extends TUI> {
  /** Enter once. The synchronous factory owns options, input policy, and cleanup of a child it cannot return. */
  enter(createChild: () => Child): Promise<Child | undefined>;
  /** Cancel entry and restore ownership once. Cleanup failures remain observable. */
  restore(): Promise<void>;
  /** Supply only the handle owned by the caller's parent custom interaction. */
  setOverlayHandle(handle: OverlayHandle): void;
}

/**
 * Transfer one terminal between two TUIs. The caller retains UI completion,
 * cancellation actions, layouts, domain work, and non-TUI mode guards.
 */
export function createFullscreenHandoff<Child extends TUI>(
  parent: TUI,
  options: FullscreenHandoffOptions = {},
): FullscreenHandoff<Child> {
  let child: Child | undefined;
  let overlay: OverlayHandle | undefined;
  let entry: Promise<Child | undefined> | undefined;
  let entering: Promise<Child | undefined> | undefined;
  let restoration: Promise<void> | undefined;
  let restoring = false;
  let drainedEntry = false;
  let parentStopped = false;
  const current = () => !restoring && (options.isCurrent?.() ?? true);

  const restore = (): Promise<void> => {
    restoring = true;
    restoration ??= Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      const attempt = (action: () => void) => {
        try {
          action();
        } catch (error) {
          errors.push(error);
        }
      };
      // The native drain's finally block restores its saved input handler. Join
      // it before another drain or any stop/start operation can change that handler.
      try {
        await entry;
      } catch {
        /* Entry failures belong to enter(), not cleanup. */
      }
      if (parentStopped) {
        try {
          await parent.terminal.drainInput?.();
        } catch (error) {
          errors.push(error);
        }
      }
      if (drainedEntry && !parentStopped) {
        // Entry drain changes keyboard protocols even when no child is created.
        parentStopped = true;
        attempt(() => parent.stop({ preserveScreen: true }));
      }
      if (child) attempt(() => child?.stop({ preserveScreen: true }));
      if (parentStopped) {
        attempt(() => overlay?.setHidden(true));
        attempt(() => {
          if (options.canRestoreParent?.() ?? true) {
            attempt(() => parent.start());
            attempt(() => parent.renderNow(false));
          }
        });
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw aggregate(errors, "Fullscreen terminal restoration failed");
    });
    return restoration;
  };

  return {
    enter(createChild) {
      if (restoring) return restore().then(() => undefined);
      if (entering) return entering;
      // Defer physical transfer until the active input callback has unwound,
      // including on hosts without a native drain API.
      entry = Promise.resolve().then(async () => {
        if (!current()) return undefined;
        drainedEntry = parent.terminal.drainInput !== undefined;
        await parent.terminal.drainInput?.();
        if (!current()) return undefined;
        parentStopped = true;
        parent.stop({ preserveScreen: true });
        if (!current()) return undefined;
        child = createChild();
        if (!current()) return undefined;
        child.start();
        if (!current()) return undefined;
        return child;
      });
      entering = (async () => {
        try {
          const value = await entry;
          if (value && current()) return value;
        } catch (error) {
          try {
            await restore();
          } catch (cleanupError) {
            throw aggregate([error, cleanupError], "Fullscreen entry and restoration failed");
          }
          throw error;
        }
        await restore();
        return undefined;
      })();
      return entering;
    },
    restore,
    setOverlayHandle(handle) {
      overlay = handle;
      if (restoring) handle.setHidden(true);
    },
  };
}
