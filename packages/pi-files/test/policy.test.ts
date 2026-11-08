import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { assertUsableLoadout, decideTool, isStockBuiltin } from "../src/scope/policy.js";
import type { ScopeState } from "../src/scope/state.js";

const tool = (name: string, source = "builtin", path = `builtin:${name}`): ToolInfo => ({
  name,
  description: name,
  parameters: { type: "object" } as ToolInfo["parameters"],
  exposure: "direct",
  sourceInfo: { source, path, scope: "temporary", origin: "top-level" },
});
const native = ["read", "write", "edit", "ls", "find", "grep", "bash", "powershell", "codemode"].map((name) =>
  tool(name),
);
const active: ScopeState = { state: "active", entryId: "one" };
const blocked: ScopeState = { state: "blocked", error: "Unavailable" };
const inactive: ScopeState = { state: "inactive" };
const surface = (names = ["write", "read"], tools = native, mode?: "on" | "only") =>
  ({
    getAllTools: () => tools,
    getActiveTools: () => names,
    getSettings: () => ({ codemode: { mode } }),
  }) as Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "getSettings">;

describe("scope stock-tool boundary", () => {
  it.each(["read", "ls", "find", "grep"])("keeps stock %s readable even when scope recovery is blocked", (name) => {
    expect(decideTool(name, native, active).kind).toBe("pass");
    expect(decideTool(name, native, blocked).kind).toBe("pass");
  });
  it.each(["write", "edit"])("requires target checks for %s and blocks it before initialization", (name) => {
    expect(decideTool(name, native, active).kind).toBe("target");
    expect(decideTool(name, native, blocked)).toEqual({ kind: "block", reason: "Unavailable" });
  });
  it.each(["bash", "powershell", "codemode", "tool_search", "opaque", "delegate"])("blocks bypass tool %s", (name) => {
    expect(decideTool(name, native, active).kind).toBe("block");
    expect(decideTool(name, native, inactive)).toEqual({ kind: "pass" });
  });
  it.each(["read", "write", "edit", "ls"])("does not trust a replaced %s or readOnlyHint", (name) => {
    const replacement = { ...tool(name, "sdk", `<sdk:${name}>`), annotations: { readOnlyHint: true } };
    expect(decideTool(name, [replacement], active).kind).toBe("block");
    expect(isStockBuiltin(tool(name, "builtin", "builtin:other"), name)).toBe(false);
  });
  it("rejects a router-only loadout without modifying core settings or tools", () => {
    expect(() => assertUsableLoadout(surface(["codemode", "write", "edit"], native, "only"))).toThrow(
      "codemode.mode=only",
    );
    expect(() => assertUsableLoadout(surface(["codemode", "write"], native, "on"))).not.toThrow();
    expect(() => assertUsableLoadout(surface(["write"], native, "only"))).not.toThrow();
    expect(() => assertUsableLoadout(surface(["codemode", "write"], native))).not.toThrow();
  });
  it("requires at least one declared stock writer, not just a callable replacement", () => {
    expect(() => assertUsableLoadout(surface(["read"], native))).toThrow("active, unmodified");
    expect(() => assertUsableLoadout(surface(["write"], [tool("write", "extension", "/tmp/replacement.ts")]))).toThrow(
      "custom replacements",
    );
    expect(() => assertUsableLoadout(surface(["edit"], native))).not.toThrow();
  });
});
