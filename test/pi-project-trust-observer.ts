import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const trustObservationPrefix = "pi-project-trust:";

export interface TrustObservation {
  phase: "start" | "shutdown" | "observe";
  reason?: string;
  trusted: boolean;
  cwd: string;
  sessionId: string;
}

/** Explicit CLI extension outside the project; it observes trust but never decides it. */
export default function projectTrustObserver(pi: ExtensionAPI): void {
  const report = (ctx: ExtensionContext, phase: TrustObservation["phase"], reason?: string) => {
    if (ctx.mode !== "rpc") throw new Error("The project trust fixture requires RPC mode");
    const observation: TrustObservation = {
      phase,
      reason,
      trusted: ctx.isProjectTrusted(),
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
    };
    ctx.ui.notify(`${trustObservationPrefix}${JSON.stringify(observation)}`, "info");
  };
  pi.on("session_start", (event, ctx) => report(ctx, "start", event.reason));
  pi.on("session_shutdown", (event, ctx) => report(ctx, "shutdown", event.reason));
  pi.registerCommand("trust-runtime-observe", {
    description: "Report the real session project trust without starting a model run",
    handler: async (args, ctx) => {
      if (args.trim()) throw new Error("trust-runtime-observe does not accept arguments");
      report(ctx, "observe");
    },
  });
  pi.registerCommand("trust-runtime-reload", {
    description: "Reload the real session and report trust through session_start",
    handler: async (args, ctx) => {
      if (args.trim()) throw new Error("trust-runtime-reload does not accept arguments");
      await ctx.reload();
      return;
    },
  });
}
