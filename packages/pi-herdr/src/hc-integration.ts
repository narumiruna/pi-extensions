import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHcWidgetObserver, type HcEnvironment } from "./hc-observer.js";
import type { HerdrWidgetObserver } from "./herdr-observer.js";
import { claimHerdrRuntime } from "./herdr-runtime-claim.js";
import { createHerdrSettingsController, type HerdrSettingsOptions } from "./herdr-settings-controller.js";

export interface HcIntegrationOptions extends HerdrSettingsOptions {
  environment: HcEnvironment;
  observer?: HerdrWidgetObserver;
}

/** Pi already owns OSC 7501 reports. This backend owns only the passive widget/settings. */
export function createHcIntegration(options: HcIntegrationOptions): (pi: ExtensionAPI) => void {
  const observer = options.observer ?? createHcWidgetObserver(options);
  return (pi) => {
    let release = claimHerdrRuntime(pi);
    if (!release) return;
    const widget = createHerdrSettingsController(pi, observer, { ...options, backend: "hc" });
    let owner: ExtensionContext["sessionManager"] | undefined;
    let closing: { session: ExtensionContext["sessionManager"]; task: Promise<void> } | undefined;

    pi.on("session_start", async (_event, ctx) => {
      release ??= claimHerdrRuntime(pi);
      if (!release) return;
      owner = ctx.sessionManager;
      await widget.start(ctx);
      // No continuation may publish native lifecycle state or use a replaced context.
    });
    pi.on("session_shutdown", async (_event, ctx) => {
      const session = ctx.sessionManager;
      if (closing?.session === session) {
        await closing.task;
        return;
      }
      if (session !== owner) return;
      owner = undefined;
      release?.();
      release = undefined;
      const task = widget.shutdown(ctx);
      closing = { session, task };
      await task;
    });
  };
}
