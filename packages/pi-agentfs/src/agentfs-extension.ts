import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installAgentfsLifecycle } from "./factory.js";

export default function agentfsExtension(pi: ExtensionAPI): void {
  pi.registerFlag("agentfs-path", {
    type: "string",
    description: "Enable AgentFS with an absolute database path (blocks ! and !! host commands)",
  });
  installAgentfsLifecycle(pi, new WeakMap(), () => pi.getFlag("agentfs-path"), false);
}
