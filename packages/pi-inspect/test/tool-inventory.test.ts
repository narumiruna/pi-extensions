import { describe, expect, it } from "vitest";
import { projectToolCatalog } from "../src/tool-catalog.js";
import { compactGroupLabel, inventoryGroups, inventoryRows, toolCell, toolColumns } from "../src/web/tool-inventory.js";
import { tools } from "./fixtures.js";

describe("tool explorer table projection", () => {
  const catalog = () => projectToolCatalog(tools, ["read"]);

  it("prefers namespace groups without deriving ownership from names", () => {
    const rows = inventoryRows(catalog(), "namespace");
    expect(rows[1]?.group).toMatchObject({ kind: "namespace", label: "mcp__docs" });
    expect(rows[0]?.group).toMatchObject({ kind: "extension", label: "/fixture" });
    expect(
      inventoryGroups(rows)
        .map(({ count }) => count)
        .sort(),
    ).toEqual([1, 2]);
    expect(inventoryGroups(inventoryRows(catalog(), "source"))).toHaveLength(1);
  });

  it("groups exposure independently of public source metadata", () => {
    const groups = inventoryGroups(inventoryRows(catalog(), "exposure"));
    expect(groups.map(({ group }) => group.label)).toEqual(["codemode", "direct", "hidden"]);
    expect(groups.every(({ count }) => count === 1)).toBe(true);
  });

  it("keeps rows stable across reordering and exposure grouping changes", () => {
    const before = inventoryRows(catalog(), "namespace");
    const after = inventoryRows(catalog().reverse(), "exposure");
    expect(before[0]?.id).toBe(after[2]?.id);
    expect(before[1]?.id).toBe(after[1]?.id);
  });

  it("retains distinct group identities when display labels collide", () => {
    const base = catalog()[0];
    if (!base) throw Error("Missing tool fixture");
    const rows = inventoryRows(
      [
        { ...base, sourceGroup: { id: "a", kind: "extension", label: "same" } },
        { ...base, sourceGroup: { id: "b", kind: "extension", label: "same" } },
      ],
      "source",
    );
    expect(new Set(rows.map(({ id }) => id)).size).toBe(2);
    expect(inventoryGroups(rows)).toHaveLength(2);
  });

  it("supports old snapshots with unknown provenance without inferring from a tool name", () => {
    const base = catalog()[1];
    if (!base) throw Error("Missing tool fixture");
    const legacy = { ...base, catalogId: undefined, namespaceGroup: undefined, sourceGroup: undefined };
    const rows = inventoryRows([legacy, legacy], "namespace");
    expect(rows.map(({ id }) => id)).toEqual(["position-0:0", "position-1:0"]);
    expect(rows[0]?.group).toMatchObject({ kind: "unknown", label: "Unknown source" });
  });

  it.each([
    ["extension", "/home/user/project/packages/pi-subagents/src/index.ts", "…/pi-subagents/src/index.ts"],
    ["extension", "C:\\Users\\user\\packages\\pi-tools\\src\\index.ts", "…/pi-tools/src/index.ts"],
    ["extension", "<sdk:example>", "<sdk:example>"],
    ["package", "npm:@example/pi-tools", "npm:@example/pi-tools"],
    ["package", "/home/user/packages/pi-tools", "…/user/packages/pi-tools"],
    ["namespace", "mcp__docs/search", "mcp__docs/search"],
    ["extension", "\u001b[31m/home/user/packages/pi-tools/src/index.ts", "…/pi-tools/src/index.ts"],
  ] as const)("compacts %s labels without changing provenance: %s", (kind, label, expected) => {
    const group = { id: "original", kind, label };
    expect(compactGroupLabel(group)).toBe(expected);
    expect(group).toEqual({ id: "original", kind, label });
  });

  it("renders every selectable column from bounded captured metadata", () => {
    const tool = catalog()[0];
    if (!tool) throw Error("Missing tool fixture");
    expect(toolColumns.map(({ id }) => toolCell(tool, id))).toEqual([
      "direct",
      "Eligible",
      "Yes",
      "/fixture",
      "Unavailable",
      "Read",
    ]);
    expect(toolCell({ ...tool, active: false, callable: false }, "codemode")).toBe("No");
    expect(toolCell({ ...tool, active: false }, "active")).toBe("No");
    expect(toolCell({ ...tool, sourceGroup: undefined }, "source")).toBe("Unknown source");
  });
});
