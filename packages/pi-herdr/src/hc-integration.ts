import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHcWidgetObserver, type HcEnvironment } from "./hc-observer.js";
import { terminalAddress } from "./hc-peer.mjs";
import { registerHcPeerTool } from "./hc-peer-tool.js";
import type { HerdrWidgetObserver } from "./herdr-observer.js";
import { claimHerdrRuntime } from "./herdr-runtime-claim.js";
import { createHerdrSettingsController, type HerdrSettingsOptions } from "./herdr-settings-controller.js";

export interface HcIntegrationOptions extends HerdrSettingsOptions {
  environment: HcEnvironment;
  observer?: HerdrWidgetObserver;
}

/** Pi owns OSC 7501 reports. This backend observes status and offers hc peer operations. */
export function createHcIntegration(options: HcIntegrationOptions): (pi: ExtensionAPI) => void {
  const observer = options.observer ?? createHcWidgetObserver(options);
  return (pi) => {
    let release = claimHerdrRuntime(pi);
    if (!release) return;
    const widget = createHerdrSettingsController(pi, observer, { ...options, backend: "hc" });
    // The source module is in src/ and the bundled eager module is in dist/index.ts.
    const { terminalId, socketEndpoint } = options.environment;
    const local =
      terminalAddress(terminalId) &&
      (process.platform === "win32" ? /^\\\\\.\\pipe\\[^\\]/u.test(socketEndpoint) : isAbsolute(socketEndpoint));
    const peers = local
      ? registerHcPeerTool(pi, options.environment, fileURLToPath(new URL("../", import.meta.url)))
      : undefined;
    let owner: ExtensionContext["sessionManager"] | undefined;
    let closing: { session: ExtensionContext["sessionManager"]; task: Promise<void> } | undefined;

    pi.on("session_start", async (_event, ctx) => {
      release ??= claimHerdrRuntime(pi);
      if (!release) return;
      owner = ctx.sessionManager;
      peers?.start(ctx);
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
      peers?.stop();
      release?.();
      release = undefined;
      const task = widget.shutdown(ctx);
      closing = { session, task };
      await task;
    });
  };
}
