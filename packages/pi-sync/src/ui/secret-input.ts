import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";
import { runSecretInput } from "@narumitw/pi-tui-kit";

export async function promptSecret(
  ctx: ExtensionCommandContext,
  title: string,
  options: { required?: boolean; signal?: AbortSignal } = { required: true },
) {
  if (ctx.mode !== "tui" || options.signal?.aborted) return undefined;
  const cancel = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, cancel.signal]) : cancel.signal;
  // Sync has always treated Ctrl+C as root cancellation, even during unfinished
  // paste. Keep that policy at the public custom-dialog boundary; Kit otherwise
  // owns the masked draft, native editing, focus, disposal, and pending work.
  const custom: typeof ctx.ui.custom = (factory, customOptions) =>
    ctx.ui.custom(async (...args) => {
      const component = await factory(...args);
      const handleInput = component.handleInput?.bind(component);
      component.handleInput = (data: string) => {
        if (!isKeyRelease(data) && matchesKey(data, Key.ctrl("c"))) cancel.abort();
        else handleInput?.(data);
      };
      return component;
    }, customOptions);
  try {
    const result = await runSecretInput(
      { ...ctx, ui: { ...ctx.ui, custom } },
      {
        title,
        required: options.required,
        signal,
        isCurrent: () => !signal.aborted,
      },
    );
    if (result.kind === "error") throw result.error;
    return result.kind === "submitted" ? result.value : undefined;
  } finally {
    cancel.abort();
  }
}
