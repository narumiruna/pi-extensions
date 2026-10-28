import { createHash } from "node:crypto";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { ToolGroup, ToolView } from "./model.js";
import { capture, displayText } from "./privacy.js";

function opaqueId(kind: string, identity: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify([kind, identity]))
    .digest("hex");
}

function group(kind: ToolGroup["kind"], identity: unknown, rawLabel: string): ToolGroup {
  const id = opaqueId(kind, identity);
  const label = displayText(rawLabel);
  return {
    id,
    kind,
    label: label.slice(0, 512),
    truncated: label.length > 512 ? true : undefined,
  };
}

function sourceGroup(source: ToolInfo["sourceInfo"] | undefined): ToolGroup {
  if (!source) return group("unknown", null, "Unknown source");
  if (source.source === "builtin") return group("builtin", null, "Built-in");
  const packageIdentity = source.source && source.source !== "auto" && source.source !== "local";
  if (source.origin === "package" && (packageIdentity || source.baseDir)) {
    return group(
      "package",
      [source.source, source.scope, source.baseDir],
      packageIdentity ? source.source : (source.baseDir ?? ""),
    );
  }
  return group("extension", [source.source, source.path, source.scope, source.origin, source.baseDir], source.path);
}

/** Display-only inventory; identity hashes always use complete public metadata before sanitation. */
export function projectToolCatalog(tools: readonly ToolInfo[], active: readonly string[]): ToolView[] {
  const activeNames = new Set(active);
  const occurrences = new Map<string, number>();
  return tools.slice(0, 256).map((tool) => {
    const source = tool.sourceInfo;
    const namespace = tool.namespace?.name;
    const identity = opaqueId("tool", [
      tool.name,
      source ? [source.source, source.path, source.scope, source.origin, source.baseDir] : null,
      namespace,
    ]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    const isActive = activeNames.has(tool.name);
    return {
      catalogId: opaqueId("catalog", [identity, occurrence]),
      name: displayText(tool.name).slice(0, 512),
      description: displayText(tool.description).slice(0, 512),
      metadataTruncated: [tool.name, tool.description, namespace ?? ""].some((text) => displayText(text).length > 512),
      sourceGroup: sourceGroup(source),
      namespaceGroup: namespace !== undefined ? group("namespace", namespace, namespace) : undefined,
      source: source
        ? capture(
            {
              source: source.source,
              path: source.path,
              scope: source.scope,
              origin: source.origin,
              ...(source.baseDir !== undefined ? { baseDir: source.baseDir } : {}),
            },
            2048,
          )
        : undefined,
      exposure: tool.exposure,
      active: isActive,
      // Pi's generic nested-call predicate, not a claim about a particular runner's availability.
      callable:
        tool.exposure === "codemode" || tool.exposure === "deferred" || (tool.exposure === "direct" && isActive),
      namespace: namespace !== undefined ? displayText(namespace).slice(0, 512) : undefined,
      schema: capture(tool.parameters, 2048),
    };
  });
}
