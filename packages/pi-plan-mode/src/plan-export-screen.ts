import type { PlanExportDestination } from "./plan-export.js";

export type PlanExportDestinationProvider = () => PlanExportDestination;

export function planExportInputScreen(getDestination: PlanExportDestinationProvider) {
  const destination = getDestination();
  return {
    kind: "input" as const,
    title: "Export plan",
    lines: [
      "Existing paths are never overwritten.",
      `Default: ${destination.configuredPath}`,
      `Resolves to: ${destination.resolvedPath}`,
    ],
    placeholder: destination.configuredPath,
    action: "export" as const,
    hint: "back" as const,
  };
}
