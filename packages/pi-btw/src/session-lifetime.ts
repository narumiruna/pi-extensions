import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { awaitBtwSettingsWrites } from "./settings.js";

/** ctx.signal belongs to an agent run, not to the session or an idle command. */
export class BtwSessionLifetime {
  readonly controller = new AbortController();
  private readonly tasks = new Set<Promise<unknown>>();
  private restoreParent = true;
  private shutdown: Promise<void> | undefined;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  readonly canRestoreParent = (): boolean => this.restoreParent;

  track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return task;
  }

  stop(quit: boolean): Promise<void> {
    // Quit can stop the renderer before it emits session_shutdown.
    if (quit) this.restoreParent = false;
    if (this.shutdown) return this.shutdown;
    this.controller.abort(new DOMException("Pi BTW session ended", "AbortError"));
    this.shutdown = (async () => {
      try {
        await Promise.allSettled([...this.tasks]);
        await awaitBtwSettingsWrites();
      } finally {
        // Non-quit teardown drains handlers before Pi resets UI and invalidates ctx.
        this.restoreParent = false;
      }
    })();
    return this.shutdown;
  }
}

export function registerBtwSessionLifetimes(pi: ExtensionAPI): (ctx: ExtensionContext) => BtwSessionLifetime {
  const sessions = new WeakMap<ExtensionContext["sessionManager"], BtwSessionLifetime>();
  let previous: BtwSessionLifetime | undefined;
  pi.on("session_start", async (_event, ctx) => {
    const replaced = previous;
    const lifetime = new BtwSessionLifetime();
    sessions.set(ctx.sessionManager, lifetime);
    previous = lifetime;
    await replaced?.stop(false);
  });
  pi.on("session_shutdown", async (event, ctx) => {
    await sessions.get(ctx.sessionManager)?.stop(event.reason === "quit");
  });
  return (ctx) => {
    let lifetime = sessions.get(ctx.sessionManager);
    if (!lifetime) {
      lifetime = new BtwSessionLifetime();
      sessions.set(ctx.sessionManager, lifetime);
      previous = lifetime;
    }
    return lifetime;
  };
}
