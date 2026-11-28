import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function trackOperationDialogs<Context extends ExtensionContext>(
  ctx: Context,
  onDialog?: (active: boolean) => void,
): Context {
  if (!onDialog) return ctx;
  const runDialog = async <Value>(task: () => Promise<Value>): Promise<Value> => {
    onDialog(true);
    try {
      return await task();
    } finally {
      onDialog(false);
    }
  };
  const ui: ExtensionContext["ui"] = {
    ...ctx.ui,
    select: (...args) => runDialog(() => ctx.ui.select(...args)),
    confirm: (...args) => runDialog(() => ctx.ui.confirm(...args)),
    custom: (factory, options) => runDialog(() => ctx.ui.custom(factory, options)),
  };
  // Forward live context properties: copying the context would hide session
  // replacement from mutation-owner revalidation after a dialog settles.
  return new Proxy(ctx, {
    get(target, key, receiver) {
      return key === "ui" ? ui : Reflect.get(target, key, receiver);
    },
  });
}
