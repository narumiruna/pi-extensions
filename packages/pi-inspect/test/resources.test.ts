import type { ExtensionAPI, ExtensionContext, RegisteredMcpServer } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Collector } from "../src/collector.js";
import { SessionFeed } from "../src/feed.js";
import { snapshot } from "../src/projection.js";
import { mcpRegistrations } from "../src/resources.js";
import { fixture, skills, tools } from "./fixtures.js";

afterEach(() => vi.useRealTimers());
const registration = (name: string): RegisteredMcpServer => ({
  name,
  config: {
    url: "https://secret.example",
    headers: { Authorization: "private-credential" },
    oauth: { clientSecret: "private-client-secret" },
  },
  extensionPath: "/private/extension.ts",
});

describe("resource capabilities and disclosure boundaries", () => {
  it("projects names only, never server configuration or extension-private details", () => {
    const server = registration("docs");
    Object.defineProperty(server, "config", {
      get: () => {
        throw Error("must not read config");
      },
    });
    const result = mcpRegistrations({ getMcpServers: () => [server] });
    expect(result).toEqual({ servers: [{ name: "docs", truncated: false }], truncated: false });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it.each(["missing", "throwing"])("marks a %s API unavailable without leaking error text", (mode) => {
    const pi =
      mode === "missing"
        ? {}
        : {
            getMcpServers: () => {
              throw Error("Bearer private-credential");
            },
          };
    expect(mcpRegistrations(pi as unknown as ExtensionAPI)).toEqual({
      servers: [],
      truncated: false,
      unavailable: true,
    });
  });

  it("bounds the registration catalog and sanitizes names without claiming health", () => {
    const result = mcpRegistrations({
      getMcpServers: () => Array.from({ length: 257 }, () => registration(`\u001b[31m${"x".repeat(700)}`)),
    });
    expect(result.servers).toHaveLength(256);
    expect(result.truncated).toBe(true);
    expect(result.servers[0]).toEqual({ name: "x".repeat(512), truncated: true });
    expect(JSON.stringify(result)).not.toMatch(/config|connected|headers|credential|oauth/);
  });

  it("bounds tool/skill metadata, retains public tool source and never reads skill files", () => {
    const f = fixture();
    const firstTool = tools[0];
    if (!firstTool) throw Error("Missing tool fixture");
    const inventory = [
      { ...firstTool, description: "d".repeat(600), name: "n".repeat(600), namespace: { name: "not-a-server" } },
    ];
    const catalog = [
      { name: "same", description: "s".repeat(600), path: "/missing/SKILL.md" },
      { name: "same", description: "another", path: "/also-missing/SKILL.md" },
    ];
    const result = snapshot(f.manager, new Collector(), "g", 0, "", inventory, [], catalog);
    expect(result.tools[0]?.name).toHaveLength(512);
    expect(result.tools[0]?.metadataTruncated).toBe(true);
    expect(result.tools[0]?.source?.value).toEqual(tools[0]?.sourceInfo);
    expect(result.tools[0]?.namespace).toBe("not-a-server");
    expect(result.skills.map((skill) => skill.path)).toEqual(catalog.map((skill) => skill.path));
    expect(result.skills[0]?.metadataTruncated).toBe(true);
    expect(result.skills[0]?.pathTruncated).toBe(false);
    const longPath = snapshot(
      f.manager,
      new Collector(),
      "g",
      0,
      "",
      [],
      [],
      [{ name: "long-path", path: "p".repeat(3000), description: "short" }],
    );
    expect(longPath.skills[0]?.path).toHaveLength(2048);
    expect(longPath.skills[0]?.pathTruncated).toBe(true);
    expect(result.mcp).toBeUndefined(); // Namespaces do not create server records.
    expect(result.skills.every((skill) => !("content" in skill))).toBe(true);
  });

  it("reconciles registrations and public sources without tool events and cancels owned work", () => {
    vi.useFakeTimers();
    const f = fixture();
    const controller = new AbortController();
    const invalidate = vi.fn();
    let servers = [registration("zero-tools")];
    let inventory = tools;
    const pi = {
      getAllTools: () => inventory,
      getActiveTools: () => ["read"],
      getMcpServers: () => servers,
    } as ExtensionAPI;
    const feed = new SessionFeed({
      pi,
      context: () => ({ sessionManager: f.manager, getSystemPrompt: () => "prompt" }) as unknown as ExtensionContext,
      collector: new Collector(),
      skills,
      generation: "g",
      signal: controller.signal,
      invalidate,
    });
    feed.start();
    const initial = feed.snapshot();
    expect(initial.mcp?.servers[0]?.name).toBe("zero-tools");
    expect(initial.mcp?.servers[0]).not.toHaveProperty("status");
    servers = [registration("connecting-or-failed")];
    inventory = tools.map((tool) => ({ ...tool, sourceInfo: { ...tool.sourceInfo, source: "changed-source" } }));
    vi.advanceTimersByTime(1250);
    expect(invalidate).toHaveBeenCalledTimes(1);
    const next = feed.snapshot();
    expect(next.mcp?.servers[0]?.name).toBe("connecting-or-failed");
    expect(next.tools[0]?.source?.value).toMatchObject({ source: "changed-source" });
    expect(next.skills).toEqual(initial.skills);
    expect(pi.getActiveTools()).toEqual(["read"]);
    expect(JSON.stringify(next.mcp)).not.toMatch(/private|https|config/);
    servers = [];
    vi.advanceTimersByTime(1250);
    expect(feed.snapshot().mcp?.servers).toEqual([]);
    controller.abort();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => feed.snapshot()).toThrow("Inspector stopped");
  });
});
