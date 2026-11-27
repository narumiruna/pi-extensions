import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { BtwFloatingFrame, type FloatingPage } from "./floating-frame.js";
import type { BtwKeybindingOverrides } from "./keybindings.js";

type PageFactory<T> = (
  tui: TUI,
  theme: Theme,
  keys: KeybindingsManager,
  done: (value: T) => void,
) => FloatingPage | Promise<FloatingPage>;
type Outcome = { kind: "closed" } | { kind: "failed"; error: unknown };

export type RunBtwFloating = (
  ctx: ExtensionCommandContext,
  run: (ctx: ExtensionCommandContext) => Promise<unknown>,
  overrides?: BtwKeybindingOverrides,
) => Promise<void>;

export const runBtwFloating: RunBtwFloating = async (ctx, run, overrides) => {
  if (ctx.mode !== "tui" || ctx.signal?.aborted) return;
  const controller = new AbortController();
  const signal = controller.signal;
  const ended = Promise.withResolvers<Outcome>();
  const abortError = new DOMException("Pi BTW window closed", "AbortError");
  let frame: BtwFloatingFrame | undefined;
  let start: (() => void) | undefined;
  let cancelPage: (() => void) | undefined;
  let closeHost: ((outcome: Outcome) => void) | undefined;
  let finished = false;

  function finish(outcome: Outcome, disposed = false): void {
    if (finished) return;
    finished = true;
    controller.abort(abortError);
    cancelPage?.();
    try {
      if (!disposed) closeHost?.(outcome);
    } finally {
      ended.resolve(outcome);
    }
  }

  const onAbort = () => finish({ kind: "closed" });
  ctx.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const interaction = ctx.ui.custom<Outcome>(
      (parent, theme, keys, done) => {
        if (signal.aborted) {
          done({ kind: "closed" });
          return { render: () => [], invalidate() {} };
        }
        closeHost = done;
        frame = new BtwFloatingFrame(parent, theme, keys, onAbort, overrides);
        const window = frame;
        const showPage = <T>(factory: PageFactory<T>): Promise<T> => {
          if (signal.aborted) return Promise.reject(abortError);
          if (cancelPage) return Promise.reject(new Error("pi-btw attempted to open overlapping floating pages."));
          const result = Promise.withResolvers<T>();
          let page: FloatingPage | undefined;
          let closed = false;
          function settle(complete: () => void) {
            if (closed) return;
            closed = true;
            cancelPage = undefined;
            try {
              window.setPage(undefined);
              page?.dispose?.();
              complete();
            } catch (error) {
              result.reject(error);
            }
          }
          cancelPage = () => settle(() => result.reject(abortError));
          try {
            const created = factory(window.tui, theme, keys, (value) => settle(() => result.resolve(value)));
            void Promise.resolve(created)
              .then((component) => {
                if (closed) {
                  component.dispose?.();
                  return;
                }
                page = component;
                window.setPage(page);
              })
              .catch((error: unknown) => settle(() => result.reject(error)));
          } catch (error) {
            settle(() => result.reject(error));
          }
          return result.promise;
        };
        const ui = new Proxy(ctx.ui, {
          get(target, property) {
            if (property === "custom") return showPage;
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function"
              ? (...args: unknown[]) => {
                  signal.throwIfAborted();
                  return Reflect.apply(value, target, args);
                }
              : value;
          },
        });
        const workspaceCtx = Object.create(ctx, {
          ui: { value: ui },
          signal: { value: signal },
        }) as ExtensionCommandContext;
        start = () => {
          void Promise.resolve()
            .then(() => (signal.aborted ? undefined : run(workspaceCtx)))
            .then(
              () => finish({ kind: "closed" }),
              (error: unknown) => finish({ kind: "failed", error }),
            );
        };
        return Object.assign(frame, { dispose: () => finish({ kind: "closed" }, true) });
      },
      {
        overlay: true,
        overlayOptions: () => frame?.overlayOptions ?? {},
        onHandle: () => start?.(),
      },
    );
    const outcome = await Promise.race([interaction, ended.promise]);
    if (outcome?.kind === "failed") throw outcome.error;
  } finally {
    ctx.signal?.removeEventListener("abort", onAbort);
    finish({ kind: "closed" }, true);
  }
};
