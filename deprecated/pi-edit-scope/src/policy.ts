import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { ScopeState } from "./state.js";

const READERS = new Set(["read", "ls", "find", "grep"]);
const WRITERS = new Set(["write", "edit"]);

/** Provenance is a stock-CLI compatibility check, not an implementation attestation. */
export function isStockBuiltin(tool: ToolInfo | undefined, name: string): boolean {
  return tool?.sourceInfo.source === "builtin" && tool.sourceInfo.path === `builtin:${name}`;
}

export function assertUsableLoadout(pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "getSettings">): void {
  const tools = pi.getAllTools();
  const active = new Set(pi.getActiveTools());
  const codemode = tools.find((tool) => tool.name === "codemode");
  if (active.has("codemode") && isStockBuiltin(codemode, "codemode") && pi.getSettings().codemode?.mode === "only") {
    throw new Error(
      "Scope cannot start with active codemode.mode=only: codemode can bypass tool guards and hides the direct editing tools. Set Pi's codemode.mode to on and reload first; Scope does not change that setting.",
    );
  }
  if (
    ![...WRITERS].some(
      (name) =>
        active.has(name) &&
        isStockBuiltin(
          tools.find((tool) => tool.name === name),
          name,
        ),
    )
  ) {
    throw new Error(
      "Scope requires an active, unmodified built-in write or edit tool; custom replacements are unsupported",
    );
  }
}

export type ToolDecision = { kind: "pass" } | { kind: "target" } | { kind: "block"; reason: string };

export function decideTool(name: string, tools: readonly ToolInfo[], scope: ScopeState): ToolDecision {
  if (scope.state === "inactive") return { kind: "pass" };
  const tool = tools.find((candidate) => candidate.name === name);
  if (READERS.has(name) && isStockBuiltin(tool, name)) return { kind: "pass" };
  if (scope.state === "blocked") {
    return {
      kind: "block",
      reason:
        scope.error ?? "Scope is not initialized; edits remain blocked. Use /scope to repair or /scope off to exit.",
    };
  }
  if (WRITERS.has(name) && isStockBuiltin(tool, name)) return { kind: "target" };
  return {
    kind: "block",
    reason: `${JSON.stringify(name)} is blocked while Scope is active. Only stock readers and target-checked write/edit calls are supported. Shell, codemode, delegation, and opaque tools require /scope off.`,
  };
}
