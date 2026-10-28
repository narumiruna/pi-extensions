import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Snapshot } from "./model.js";
import { displayText } from "./privacy.js";

/** Registrations are not connections. Never copy server configs or infer ownership from tool names. */
export function mcpRegistrations(pi: Pick<ExtensionAPI, "getMcpServers">): NonNullable<Snapshot["mcp"]> {
  try {
    if (typeof pi.getMcpServers !== "function") return { servers: [], truncated: false, unavailable: true };
    const registered = pi.getMcpServers();
    return {
      servers: registered.slice(0, 256).map(({ name }) => {
        const clean = displayText(name);
        return { name: clean.slice(0, 512), truncated: clean.length > 512 };
      }),
      truncated: registered.length > 256,
    };
  } catch {
    // API errors can contain credentials; publish only a fixed availability marker.
    return { servers: [], truncated: false, unavailable: true };
  }
}
