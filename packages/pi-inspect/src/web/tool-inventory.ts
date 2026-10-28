import type { ToolGroup, ToolView } from "../model.js";
import { boundedSearch } from "./search.js";

export type InventoryGrouping = "namespace" | "source" | "exposure";
export interface InventoryRow {
  id: string;
  tool: ToolView;
  group: ToolGroup;
}
export const toolColumns = [
  { id: "exposure", label: "Exposure" },
  { id: "codemode", label: "Codemode" },
  { id: "active", label: "Active" },
  { id: "source", label: "Source" },
  { id: "namespace", label: "Namespace" },
  { id: "description", label: "Description" },
] as const;
export type ToolColumn = (typeof toolColumns)[number]["id"];

export function inventoryRows(tools: ToolView[], grouping: InventoryGrouping): InventoryRow[] {
  const seen = new Map<string, number>();
  return tools.map((tool, index) => {
    const identity = tool.catalogId ?? `position-${index}`;
    const occurrence = seen.get(identity) ?? 0;
    seen.set(identity, occurrence + 1);
    const id = `${identity}:${occurrence}`;
    const source = tool.sourceGroup ?? { id: "unknown", label: "Unknown source", kind: "unknown" as const };
    return {
      id,
      tool,
      group:
        grouping === "exposure"
          ? { id: `exposure:${tool.exposure}`, label: tool.exposure, kind: "unknown" }
          : grouping === "namespace"
            ? (tool.namespaceGroup ?? source)
            : source,
    };
  });
}

export function inventoryGroups(rows: InventoryRow[]): { group: ToolGroup; count: number }[] {
  const groups = new Map<string, { group: ToolGroup; count: number }>();
  for (const { group } of rows) {
    const current = groups.get(group.id);
    if (current) current.count++;
    else groups.set(group.id, { group, count: 1 });
  }
  return [...groups.values()].sort((a, b) => a.group.label.localeCompare(b.group.label));
}

/** Compact display only: full sanitized provenance and opaque identities remain unchanged. */
export function compactGroupLabel(group: ToolGroup): string {
  const label = boundedSearch(group.label);
  const path = group.kind === "extension" || (group.kind === "package" && /^(?:[/\\\\]|[A-Za-z]:[/\\\\])/.test(label));
  if (!path) return label;
  const parts = label.split(/[/\\\\]/).filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : label;
}

export function toolCell(tool: ToolView, column: ToolColumn): string {
  switch (column) {
    case "exposure":
      return tool.exposure;
    case "codemode":
      return tool.callable ? "Eligible" : "No";
    case "active":
      return tool.active ? "Yes" : "No";
    case "source":
      return tool.sourceGroup ? compactGroupLabel(tool.sourceGroup) : "Unknown source";
    case "namespace":
      return tool.namespace ?? "Unavailable";
    case "description":
      return tool.description;
  }
}
