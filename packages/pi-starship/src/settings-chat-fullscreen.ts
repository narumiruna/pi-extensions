import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  isKeyRelease,
  matchesKey,
  type OverlayHandle,
  type TUI,
  TuiAltScreen,
  type TuiInputListener,
} from "@earendil-works/pi-tui";
import { createFullscreenHandoff } from "@narumitw/pi-tui-kit/fullscreen-handoff";
import type { WorkflowOwner } from "./command-configuration.js";

export type SettingsChatFullscreenComponent = Component & {
  dispose?(): void;
  waitForPending?(): Promise<void>;
  getFullscreenLayout?(): Component;
};

export interface SettingsChatFullscreenOptions<Value> {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  signal: AbortSignal;
  complete(value: Value): void;
}

export interface SettingsChatFullscreenDependencies {
  createTui?(parent: TUI, createDefault: () => TuiAltScreen): TuiAltScreen;
}

type Outcome<Value> = { value: Value } | { error: unknown };

// The base constructor registers the native viewport listener through this public
// method. Install the guard first, without reading or changing Pi's listener set.
class SettingsChatTui extends TuiAltScreen {
  declare private guardInstalled: boolean | undefined;
  declare guard: TuiInputListener | undefined;

  override addInputListener(listener: TuiInputListener): () => void {
    if (!this.guardInstalled) {
      this.guardInstalled = true;
      super.addInputListener((data) => this.guard?.(data));
    }
    return super.addInputListener(listener);
  }
}

/**
 * Pi recommends one renderer. This isolated chat intentionally transfers the
 * shared terminal to a native fullscreen viewport, then returns it before review.
 * The parent custom overlay owns only the handoff lifetime, never child layout.
 */
export async function runSettingsChatFullscreen<Value>(
  ctx: ExtensionCommandContext,
  owner: WorkflowOwner,
  create: (options: SettingsChatFullscreenOptions<Value>) => SettingsChatFullscreenComponent,
  cancelledValue: Value,
  dependencies: SettingsChatFullscreenDependencies = {},
): Promise<Value> {
  const current = () => !owner.signal.aborted && !ctx.signal?.aborted && owner.isCurrent();
  const canRestoreTerminal = () => (owner.canRestoreTerminal ?? owner.isSessionCurrent ?? owner.isCurrent)();
  if (ctx.mode !== "tui" || !current()) return cancelledValue;

  let mount: ((handle: OverlayHandle) => void) | undefined;
  let releaseHost: (() => Promise<void>) | undefined;
  let completedOutcome: Outcome<Value> | undefined;
  const outcome = await ctx.ui
    .custom<Outcome<Value>>(
      (parent, theme, keybindings, done) => {
        const controller = new AbortController();
        let child: TuiAltScreen | undefined;
        let component: SettingsChatFullscreenComponent | undefined;
        let entry: Promise<void> | undefined;
        let finished = false;
        let closing = false;
        let cleanup: Promise<void> | undefined;
        let pasting = false;
        let result: Outcome<Value> = { value: cancelledValue };
        const errors: unknown[] = [];
        const handoff = createFullscreenHandoff<TuiAltScreen>(parent, {
          isCurrent: () => !closing && current(),
          canRestoreParent: canRestoreTerminal,
        });
        const removers: (() => void)[] = [];
        const attempt = (action: () => void) => {
          try {
            action();
          } catch (error) {
            errors.push(error);
          }
        };

        const finish = (next: Outcome<Value>) => {
          if (closing) return cleanup;
          closing = true;
          result = next;
          // Root work must stop synchronously, even when a nested overlay has focus.
          controller.abort();
          cleanup = Promise.resolve().then(async () => {
            await entry;
            for (const remove of removers.splice(0)) attempt(remove);
            attempt(() => component?.dispose?.());
            try {
              await handoff.restore();
            } catch (error) {
              errors.push(error);
            }
            // Return input ownership promptly, then join cancelled root work.
            // A late stream must settle before the owning command releases its draft.
            try {
              await component?.waitForPending?.();
            } catch (error) {
              errors.push(error);
            }
            attempt(() => {
              if (!current() && !("error" in result)) result = { value: cancelledValue };
            });
            finished = true;
            if ("error" in result) errors.unshift(result.error);
            completedOutcome = errors.length
              ? { error: errors.length === 1 ? errors[0] : new AggregateError(errors, "Fullscreen cleanup failed") }
              : result;
            done(completedOutcome);
          });
          return cleanup;
        };
        releaseHost = () => finish({ value: cancelledValue }) ?? Promise.resolve();
        const cancel = () => finish({ value: cancelledValue });
        const guard: TuiInputListener = (data) => {
          if (closing) return { consume: true };
          if (!current()) {
            cancel();
            return { consume: true };
          }
          // A terminal can deliver bracketed paste as one packet or separate
          // packets. Ctrl+C in either form is text, not a screen shortcut.
          const wasPasting = pasting;
          for (const part of data.split("\x1b").slice(1)) {
            if (part.startsWith("[200~")) pasting = true;
            else if (part.startsWith("[201~")) pasting = false;
          }
          if (wasPasting || pasting || data.includes("\x1b[200~") || data.includes("\x1b[201~")) {
            try {
              // Paste belongs to the focused editor or native search overlay,
              // not necessarily to the root chat. Bypass viewport shortcuts only.
              child?.getFocusedComponent()?.handleInput?.(data);
              child?.requestRender();
            } catch (error) {
              finish({ error });
            }
            return { consume: true };
          }
          if (!isKeyRelease(data) && matchesKey(data, "ctrl+c")) {
            cancel();
            return { consume: true };
          }
        };

        for (const signal of new Set([owner.signal, ctx.signal])) {
          if (!signal) continue;
          signal.addEventListener("abort", cancel, { once: true });
          removers.push(() => signal.removeEventListener("abort", cancel));
        }
        const host: SettingsChatFullscreenComponent = {
          render: () => [],
          invalidate() {},
          dispose() {
            if (!finished) cancel();
          },
        };
        mount = (handle) => {
          handoff.setOverlayHandle(handle);
          // The custom factory and any active terminal callback must unwind before
          // terminal ownership changes. onHandle runs only after Pi mounts host.
          queueMicrotask(() => {
            if (closing) return;
            entry = (async () => {
              try {
                child = await handoff.enter(() => {
                  const createDefault = () =>
                    new SettingsChatTui(parent.terminal, parent.getShowHardwareCursor(), undefined, { mouse: true });
                  const created = dependencies.createTui?.(parent, createDefault) ?? createDefault();
                  child = created;
                  try {
                    if (created instanceof SettingsChatTui) created.guard = guard;
                    else removers.push(created.addInputListener(guard));
                    component = create({
                      tui: created,
                      theme,
                      keybindings,
                      signal: controller.signal,
                      complete: (value) => finish({ value }),
                    });
                    if (!closing && current()) {
                      created.setLayoutRoot(component.getFullscreenLayout?.() ?? component);
                      created.setFocus(component);
                    }
                    return created;
                  } catch (error) {
                    controller.abort();
                    // Kit cannot own a child the factory did not return. Native
                    // layout setup can schedule rendering before start().
                    try {
                      created.stop({ preserveScreen: true });
                    } catch (cleanupError) {
                      throw new AggregateError([error, cleanupError], "Fullscreen child factory cleanup failed");
                    }
                    throw error;
                  }
                });
                if (!child && !closing) cancel();
              } catch (error) {
                if (closing) errors.push(error);
                else finish({ error });
              }
            })();
          });
        };
        if (!current()) cancel();
        return host;
      },
      { overlay: true, onHandle: (handle) => mount?.(handle) },
    )
    .catch(async (error: unknown) => {
      // Pi can reject while mounting the custom overlay without disposing the
      // factory result. Release upstream listeners even when onHandle never ran.
      await releaseHost?.();
      if (completedOutcome && "error" in completedOutcome) {
        throw new AggregateError([error, completedOutcome.error], "Fullscreen mount and cleanup failed");
      }
      throw error;
    });
  // External custom disposal can resolve undefined before host.dispose finishes.
  // Terminal restoration and cleanup failures still belong to this command.
  await releaseHost?.();
  const completion = completedOutcome ?? outcome;
  if (!completion) return cancelledValue;
  if ("error" in completion) throw completion.error;
  return completion.value;
}
