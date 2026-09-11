import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCompletionRenderer } from "./completion-renderer.js";
import { registerSubagentTools, type SubagentToolsDependencies } from "./tools.js";
import { createSubagentWidgetController } from "./widget.js";

export type SubagentsDependencies = SubagentToolsDependencies;

export default function subagents(pi: ExtensionAPI, dependencies: SubagentsDependencies = {}): void {
  registerCompletionRenderer(pi);
  const tools = registerSubagentTools(pi, dependencies);
  const widget = createSubagentWidgetController(tools.runtime);
  let activeSession: ExtensionContext["sessionManager"] | undefined;
  let sessionGeneration = 0;

  pi.on("session_start", async (_event, ctx) => {
    activeSession = ctx.sessionManager;
    const generation = ++sessionGeneration;
    await tools.startSession();
    if (generation !== sessionGeneration) return;
    widget.start(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.sessionManager !== activeSession) return;
    sessionGeneration++;
    activeSession = undefined;
    widget.shutdown(ctx);
    await tools.shutdown();
  });
}
