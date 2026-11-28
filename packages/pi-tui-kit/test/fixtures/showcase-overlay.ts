import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle } from "@earendil-works/pi-tui";
import { type createRendererHost, deferred } from "./renderer-host.js";

type DisposableComponent = Component & { dispose?(): void };

export function createShowcaseOverlay(
  renderer: ReturnType<typeof createRendererHost>,
  theme: Theme,
  inlineCustom = (renderer.ctx as ExtensionContext).ui.custom,
) {
  const opened = deferred<{ component: DisposableComponent; handle: OverlayHandle }>();
  let mounts = 0;
  let completions = 0;
  let remove = () => {};
  let finish = () => {};

  const custom: ExtensionContext["ui"]["custom"] = (factory, options) => {
    if (!options?.overlay) return inlineCustom(factory, options);
    return new Promise((resolve, reject) => {
      let closed = false;
      let component: DisposableComponent | undefined;
      let handle: OverlayHandle | undefined;
      remove = () => {
        if (closed) return;
        closed = true;
        handle?.hide();
        component?.dispose?.();
      };
      const done = (value: unknown) => {
        if (closed) return;
        completions++;
        remove();
        resolve(value as never);
      };
      finish = () => done(undefined);
      void Promise.resolve(factory(renderer.host, theme, renderer.keys as KeybindingsManager, done))
        .then((created) => {
          if (closed) return;
          component = created;
          const layout =
            typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
          handle = renderer.host.showOverlay(component, layout);
          mounts++;
          options.onHandle?.(handle);
          if (closed) return;
          renderer.host.flush();
          opened.resolve({ component, handle });
        })
        .catch(reject);
    });
  };
  return {
    custom,
    opened: opened.promise,
    get mounts() {
      return mounts;
    },
    get completions() {
      return completions;
    },
    disposeFromHost: () => remove(),
    stop: () => finish(),
  };
}
