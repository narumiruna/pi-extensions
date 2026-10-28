import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Collector } from "../src/collector.js";
import { SessionFeed } from "../src/feed.js";
import { projectToolCatalog } from "../src/tool-catalog.js";
import { fixture, tools } from "./fixtures.js";

const source: ToolInfo["sourceInfo"] = {
  source: "local",
  path: "/missing/extension.ts",
  scope: "temporary",
  origin: "top-level",
};
function tool(overrides: Partial<ToolInfo> = {}): ToolInfo {
  const first = tools[0];
  if (!first) throw Error("Missing tool fixture");
  return { ...first, name: "search", sourceInfo: { ...source }, ...overrides };
}
const absentSource = undefined as unknown as ToolInfo["sourceInfo"];
afterEach(() => vi.useRealTimers());

describe("public tool catalog", () => {
  // Installed AgentSession._getCallableTools: every exposure crossed with both active states.
  it.each([
    ["direct", false, false],
    ["direct", true, true],
    ["codemode", false, true],
    ["codemode", true, true],
    ["deferred", false, true],
    ["deferred", true, true],
    ["model-only", false, false],
    ["model-only", true, false],
    ["hidden", false, false],
    ["hidden", true, false],
  ] as const)("%s exposure, active=%s: nested-call eligibility=%s", (exposure, active, callable) => {
    const result = projectToolCatalog([tool({ exposure })], active ? ["search"] : []);
    expect(result[0]).toMatchObject({ exposure, active, callable });
  });

  it("keeps extension groups separate across public source scopes and origins", () => {
    const catalog = projectToolCatalog(
      [
        tool({ name: "user", sourceInfo: { ...source, scope: "user" } }),
        tool({ name: "project", sourceInfo: { ...source, scope: "project" } }),
        tool({ name: "auto", sourceInfo: { ...source, source: "auto" } }),
        tool({ name: "base", sourceInfo: { ...source, baseDir: "/other" } }),
      ],
      [],
    );
    expect(new Set(catalog.map((entry) => entry.sourceGroup?.id)).size).toBe(4);
    expect(catalog.every((entry) => entry.sourceGroup?.label === source.path)).toBe(true);
  });

  it.each(["codemode", "tool_search", "mcp__docs__search", "tools.docs.search"])(
    "does not infer namespace, source, or eligibility from the name %s",
    (name) => {
      const result = projectToolCatalog([tool({ name, sourceInfo: absentSource })], [])[0];
      expect(result).toMatchObject({ name, callable: false, sourceGroup: { kind: "unknown" } });
      expect(result?.namespace).toBeUndefined();
      expect(result?.namespaceGroup).toBeUndefined();
    },
  );

  it.each([
    { label: "absent", metadata: absentSource, kind: "unknown", display: "Unknown source" },
    {
      label: "builtin",
      metadata: { ...source, source: "builtin", path: "builtin:read" },
      kind: "builtin",
      display: "Built-in",
    },
    {
      label: "builtin before package",
      metadata: { ...source, source: "builtin", origin: "package" as const },
      kind: "builtin",
      display: "Built-in",
    },
    {
      label: "package",
      metadata: { ...source, source: "npm:example", origin: "package" as const },
      kind: "package",
      display: "npm:example",
    },
    {
      label: "package without identity",
      metadata: { ...source, source: "", origin: "package" as const },
      kind: "extension",
      display: source.path,
    },
    { label: "extension", metadata: source, kind: "extension", display: source.path },
    {
      label: "SDK synthetic path",
      metadata: { ...source, source: "sdk", path: "<sdk:example>" },
      kind: "extension",
      display: "<sdk:example>",
    },
    {
      label: "inline synthetic path",
      metadata: { ...source, source: "inline", path: "<inline:example>" },
      kind: "extension",
      display: "<inline:example>",
    },
  ])("groups $label using only public provenance", ({ metadata, kind, display }) => {
    const result = projectToolCatalog([tool({ sourceInfo: metadata })], [])[0];
    expect(result?.sourceGroup).toMatchObject({ kind, label: display });
    expect(result?.source?.value).toEqual(metadata);
    expect(result?.sourceGroup?.id).toMatch(/^[a-f0-9]{64}$/);
  });

  it("groups all builtin tools together, independent of synthetic entrypoint", () => {
    const result = projectToolCatalog(
      ["read", "edit", "mcp"].map((name) =>
        tool({ name, sourceInfo: { ...source, source: "builtin", path: `builtin:${name}` } }),
      ),
      [],
    );
    expect(new Set(result.map((entry) => entry.sourceGroup?.id)).size).toBe(1);
    expect(new Set(result.map((entry) => entry.catalogId)).size).toBe(3);
  });

  it("groups package entries by identity, scope and baseDir, not entrypoint", () => {
    const metadata = { ...source, source: "npm:example", origin: "package" as const, baseDir: "/missing/package" };
    const result = projectToolCatalog(
      [
        tool({ sourceInfo: { ...metadata, path: "/missing/package/first.ts" } }),
        tool({ sourceInfo: { ...metadata, path: "/missing/package/second.ts" } }),
        tool({ sourceInfo: { ...metadata, scope: "project" } }),
        tool({ sourceInfo: { ...metadata, baseDir: "/other/package" } }),
        tool({ sourceInfo: { ...metadata, source: "npm:another" } }),
      ],
      [],
    );
    expect(result[0]?.sourceGroup).toEqual(result[1]?.sourceGroup);
    expect(new Set(result.map((entry) => entry.sourceGroup?.id)).size).toBe(4);
    expect(new Set(result.map((entry) => entry.catalogId)).size).toBe(5);
    expect(result[0]?.source?.value).toMatchObject({ baseDir: metadata.baseDir });
  });

  it.each(["", "auto", "local"])(
    "uses fallback extension paths when package source '%s' has no identity or baseDir",
    (identity) => {
      const result = projectToolCatalog(
        ["/first.ts", "/second.ts"].map((path) =>
          tool({ sourceInfo: { ...source, source: identity, origin: "package", path } }),
        ),
        [],
      );
      expect(result.map((entry) => entry.sourceGroup?.kind)).toEqual(["extension", "extension"]);
      expect(result[0]?.sourceGroup?.id).not.toBe(result[1]?.sourceGroup?.id);
    },
  );

  it.each(["", "auto", "local"])("uses baseDir as package identity for source '%s'", (identity) => {
    const result = projectToolCatalog(
      ["/first.ts", "/second.ts"].map((path) =>
        tool({ sourceInfo: { ...source, source: identity, origin: "package", baseDir: "/package", path } }),
      ),
      [],
    );
    expect(result[0]?.sourceGroup).toMatchObject({ kind: "package", label: "/package" });
    expect(result[0]?.sourceGroup).toEqual(result[1]?.sourceGroup);
    const other = projectToolCatalog(
      [tool({ sourceInfo: { ...source, source: identity, origin: "package", baseDir: "/other-package" } })],
      [],
    );
    expect(result[0]?.sourceGroup?.id).not.toBe(other[0]?.sourceGroup?.id);
  });

  it("omits absent baseDir instead of publishing a null capture field", () => {
    const result = projectToolCatalog([tool(), tool({ sourceInfo: { ...source, baseDir: undefined } })], []);
    for (const entry of result) {
      expect(entry.source?.value).toEqual(source);
      expect(entry.source?.value).not.toHaveProperty("baseDir");
    }
  });

  it.each([
    ["Bearer private-first", "Bearer private-second"],
    [`${"x".repeat(512)}first`, `${"x".repeat(512)}second`],
    ["\u001b[31msame", "\u001b[32msame"],
  ])("keeps raw identities distinct when their display labels collide", (first, second) => {
    const result = projectToolCatalog(
      [first, second].map((raw) => tool({ name: raw, namespace: { name: raw }, sourceInfo: { ...source, path: raw } })),
      [],
    );
    expect(result[0]?.name).toBe(result[1]?.name);
    expect(result[0]?.namespaceGroup?.label).toBe(result[1]?.namespaceGroup?.label);
    expect(result[0]?.sourceGroup?.label).toBe(result[1]?.sourceGroup?.label);
    expect(result[0]?.catalogId).not.toBe(result[1]?.catalogId);
    expect(result[0]?.namespaceGroup?.id).not.toBe(result[1]?.namespaceGroup?.id);
    expect(result[0]?.sourceGroup?.id).not.toBe(result[1]?.sourceGroup?.id);
    const ids = result.flatMap((entry) => [entry.catalogId, entry.sourceGroup?.id, entry.namespaceGroup?.id]);
    expect(ids.every((id) => /^[a-f0-9]{64}$/.test(id ?? ""))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private-first|private-second/);
    expect(JSON.stringify(result)).not.toContain("\\u001b");
  });

  it.each(
    (["name", "path", "package", "namespace", "baseDir"] as const).flatMap((field) =>
      [
        ["Bearer private-first", "Bearer private-second"],
        [`${"x".repeat(3000)}first`, `${"x".repeat(3000)}second`],
      ].map(([first = "", second = ""]) => ({ field, first, second })),
    ),
  )("hashes complete $field identity even when its display is equal", ({ field, first, second }) => {
    const result = projectToolCatalog(
      [first, second].map((raw) =>
        tool({
          ...(field === "name" ? { name: raw } : {}),
          ...(field === "namespace" ? { namespace: { name: raw } } : {}),
          sourceInfo: {
            ...source,
            ...(field === "path" ? { path: raw } : {}),
            ...(field === "package" ? { origin: "package", source: raw } : {}),
            ...(field === "baseDir" ? { origin: "package", baseDir: raw } : {}),
          },
        }),
      ),
      [],
    );
    expect(result[0]?.catalogId).not.toBe(result[1]?.catalogId);
    expect(result[0]?.name).toBe(result[1]?.name);
    expect(result[0]?.namespace).toBe(result[1]?.namespace);
    expect(result[0]?.sourceGroup?.label).toBe(result[1]?.sourceGroup?.label);
    if (field === "path" || field === "package" || field === "baseDir")
      expect(result[0]?.sourceGroup?.id).not.toBe(result[1]?.sourceGroup?.id);
    if (field === "namespace") expect(result[0]?.namespaceGroup?.id).not.toBe(result[1]?.namespaceGroup?.id);
    expect(JSON.stringify(result)).not.toMatch(/private-first|private-second/);
  });

  it.each(["extension", "package", "namespace"] as const)("bounds and flags %s group labels", (kind) => {
    const raw = `\u001b[31m${"x".repeat(513)} Bearer private-credential`;
    const result = projectToolCatalog(
      [
        tool({
          namespace: { name: raw },
          sourceInfo: { ...source, path: raw, ...(kind === "package" ? { origin: "package", source: raw } : {}) },
        }),
      ],
      [],
    )[0];
    const group = kind === "namespace" ? result?.namespaceGroup : result?.sourceGroup;
    expect(group).toMatchObject({ kind, label: "x".repeat(512), truncated: true });
    expect(result?.namespace).toHaveLength(512);
    expect(result?.metadataTruncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-credential");
    expect(JSON.stringify(result)).not.toContain("\\u001b");
  });

  it("assigns duplicate occurrence IDs without depending on ordinary catalog order", () => {
    const first = tool();
    const second = tool({ name: "second" });
    const third = tool({ sourceInfo: { ...source, path: "/other.ts" } });
    const initial = projectToolCatalog([first, second, first, third], []);
    const reordered = projectToolCatalog([third, first, first, second], []);
    expect(new Set(initial.map((entry) => entry.catalogId)).size).toBe(4);
    expect(reordered.map((entry) => entry.catalogId)).toEqual([
      initial[3]?.catalogId,
      initial[0]?.catalogId,
      initial[2]?.catalogId,
      initial[1]?.catalogId,
    ]);
    const changedDisplay = projectToolCatalog([{ ...first, description: "new", exposure: "hidden" }], []);
    expect(changedDisplay[0]?.catalogId).toBe(initial[0]?.catalogId);
  });

  it.each(["source", "path", "scope", "origin", "baseDir"] as const)(
    "includes complete public source %s in catalog identity",
    (field) => {
      const initial = projectToolCatalog([tool()], [])[0];
      const changed = projectToolCatalog(
        [
          tool({
            sourceInfo: {
              ...source,
              [field]: field === "scope" ? "project" : field === "origin" ? "package" : "changed",
            },
          }),
        ],
        [],
      )[0];
      expect(changed?.catalogId).not.toBe(initial?.catalogId);
    },
  );

  it("keeps the existing bounded inventory and capture fields", () => {
    const result = projectToolCatalog(
      Array.from({ length: 257 }, () => tool()),
      [],
    );
    expect(result).toHaveLength(256);
    expect(result[0]).toMatchObject({
      name: "search",
      description: "Read",
      exposure: "direct",
      active: false,
      callable: false,
      schema: { value: tools[0]?.parameters, truncated: false },
      source: { value: source, truncated: false },
    });
    expect(new Set(result.map((entry) => entry.catalogId)).size).toBe(256);
  });
});

describe("tool identity feed refresh", () => {
  it.each(["baseDir", "namespace", "path", "source"] as const)(
    "refreshes %s-only changes beyond display capture limits",
    (field) => {
      vi.useFakeTimers();
      const f = fixture();
      const controller = new AbortController();
      const invalidate = vi.fn();
      const prefix = "x".repeat(3000);
      let inventory = [
        tool({
          namespace: { name: `${prefix}first` },
          sourceInfo: {
            ...source,
            source: `${prefix}first`,
            origin: "package",
            path: `${prefix}first`,
            baseDir: `${prefix}first`,
          },
        }),
      ];
      const feed = new SessionFeed({
        pi: { getAllTools: () => inventory, getActiveTools: () => [] } as unknown as ExtensionAPI,
        context: () => ({ sessionManager: f.manager, getSystemPrompt: () => "" }) as unknown as ExtensionContext,
        collector: new Collector(),
        skills: [],
        generation: "g",
        signal: controller.signal,
        invalidate,
      });
      try {
        feed.start();
        const initial = feed.snapshot().tools[0];
        inventory = inventory.map((entry) =>
          field === "namespace"
            ? { ...entry, namespace: { name: `${prefix}second` } }
            : { ...entry, sourceInfo: { ...entry.sourceInfo, [field]: `${prefix}second` } },
        );
        vi.advanceTimersByTime(1250);
        expect(invalidate).toHaveBeenCalledTimes(1);
        const changed = feed.snapshot().tools[0];
        expect(changed?.catalogId).not.toBe(initial?.catalogId);
        expect(changed?.source).toEqual(initial?.source);
        expect(changed?.namespace).toBe(initial?.namespace);
        expect(changed?.sourceGroup?.label).toBe(initial?.sourceGroup?.label);
        if (field === "namespace") expect(changed?.namespaceGroup?.id).not.toBe(initial?.namespaceGroup?.id);
        if (field === "baseDir" || field === "source")
          expect(changed?.sourceGroup?.id).not.toBe(initial?.sourceGroup?.id);
      } finally {
        controller.abort();
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
