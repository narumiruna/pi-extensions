import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHcIntegration } from "./hc-integration.js";
import type { HcEnvironment } from "./hc-observer.js";
import herdrAgentState from "./herdr-agent-state.js";

export type IntegrationBackend = { kind: "hc"; environment: HcEnvironment } | { kind: "herdr" } | { kind: "disabled" };

/** A partial inherited hc identity must never fall back to a different legacy endpoint. */
export function selectIntegrationBackend(env: NodeJS.ProcessEnv = process.env): IntegrationBackend {
  const terminal = env.HC_TERMINAL_ID;
  const endpoint = env.HC_TERMINAL_SOCKET;
  if (terminal === undefined && endpoint === undefined) return { kind: "herdr" };
  const controls = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
  if (
    !terminal?.trim() ||
    terminal !== terminal.trim() ||
    [...terminal].length > 256 ||
    controls.test(terminal) ||
    !endpoint ||
    !endpoint.trim() ||
    endpoint.length > 4096 ||
    controls.test(endpoint)
  )
    return { kind: "disabled" };
  return { kind: "hc", environment: { terminalId: terminal, socketEndpoint: endpoint } };
}

export default function herdrIntegration(pi: ExtensionAPI): void {
  const backend = selectIntegrationBackend();
  if (backend.kind === "hc") createHcIntegration({ environment: backend.environment })(pi);
  else if (backend.kind === "herdr") herdrAgentState(pi);
}
