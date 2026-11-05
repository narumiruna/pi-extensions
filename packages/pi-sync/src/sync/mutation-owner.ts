import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../snapshot/session-paths.js";
import { throwIfAborted } from "./signals.js";

export function captureMutationOwner(ctx: ExtensionContext | ExtensionCommandContext, signal?: AbortSignal) {
  const manager = ctx.sessionManager;
  const file = manager.getSessionFile?.();
  const id = manager.getSessionId?.();
  const cwd = manager.getCwd?.();
  const root = agentDir();
  return () => {
    throwIfAborted(signal);
    if (
      ctx.sessionManager !== manager ||
      manager.getSessionFile?.() !== file ||
      manager.getSessionId?.() !== id ||
      manager.getCwd?.() !== cwd ||
      agentDir() !== root
    )
      throw new Error("Session changed during file mutation; evidence retained for review.");
  };
}
