import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ancestry } from "../src/ancestry.js";
import { Collector } from "../src/collector.js";
import { EntryIndex } from "../src/entry-index.js";
import { SessionFeed } from "../src/feed.js";
import { branch, detail, snapshot } from "../src/projection.js";
import { fixture } from "./fixtures.js";

describe("R19/R20: runtime semantic and unique identity evidence", () => {
  it.each([undefined, null, 42, {}, [], true, ""])(
    "diagnoses malformed type/role %j without publishing kind objects",
    (value) => {
      const f = fixture();
      const root = f.manager.getEntries()[0];
      if (!root) throw new Error("No root");
      for (const bad of [
        { ...root, type: value },
        { ...root, type: "message", message: { role: value } },
      ]) {
        const index = new EntryIndex([bad as SessionEntry]);
        const result = snapshot(f.manager, new Collector(), "g", 0, "", [], [], [], index);
        expect(result.nodes).toEqual([]);
        expect(result.invalidEntryCount).toBe(1);
        expect(result.invalidEntries?.[0]?.reason).toMatch(/type|role/);
      }
    },
  );
  it("omits all duplicated occurrences, including collisions beyond the navigation budget, and rejects ambiguous detail/ancestry", () => {
    const f = fixture();
    const entries = f.manager.getEntries();
    const source = f.manager.getEntry(f.assistant);
    if (!source) throw new Error("No assistant");
    const duplicate = { ...source, message: { role: "user", content: "different", timestamp: 1 } } as SessionEntry;
    const index = new EntryIndex([
      ...entries,
      ...Array.from({ length: 10000 }, (_, i) => ({ ...source, id: `unrelated-${i}`, parentId: null })),
      duplicate,
    ]);
    const result = snapshot(f.manager, new Collector(), "g", 0, "", [], [], [], index);
    expect(result.nodes.some((node) => node.id === source.id)).toBe(false);
    expect(result.invalidEntries?.some((item) => item.reason === "duplicate entry id")).toBe(true);
    expect(branch(f.manager, source.id, 0, [], index).ancestryIssue).toBe("duplicate entry id");
    expect(detail.bind(null, f.manager, source.id, source.id, new Collector(), index)).toThrow("Ambiguous");
    expect(detail(f.manager, f.result, f.result, new Collector(), index).ancestryIssue).toBe("duplicate ancestor id");
    expect(source.type === "message" && source.message.role).toBe("assistant");
  });
});
describe("R21: structural index reuse and branch-local projection", () => {
  it("performs no full-history reads during 50 inline details and releases/rebuilds the index at owned boundaries", () => {
    const f = fixture();
    const entries = f.manager.getEntries();
    const off = Array.from(
      { length: 100000 },
      (_, i) =>
        ({
          id: `off-${i}`,
          parentId: null,
          type: "custom",
          customType: "off",
          data: {},
          timestamp: new Date(0).toISOString(),
        }) as SessionEntry,
    );
    const reads = vi.fn(() => [...entries, ...off]);
    const manager = new Proxy(f.manager, {
      get(target, name) {
        if (name === "getEntries") return reads;
        return Reflect.get(target, name, target);
      },
    });
    const controller = new AbortController();
    const feed = new SessionFeed({
      pi: { getAllTools: () => [], getActiveTools: () => [] } as unknown as ExtensionAPI,
      context: () => ({ sessionManager: manager, getSystemPrompt: () => "" }) as unknown as ExtensionContext,
      collector: new Collector(),
      skills: [],
      generation: "g",
      signal: controller.signal,
      invalidate: () => {},
    });
    const index = feed.index();
    expect(reads).toHaveBeenCalledTimes(1);
    reads.mockClear();
    for (let i = 0; i < 50; i++) detail(manager, f.assistant, f.compact, new Collector(), feed.index());
    expect(reads).not.toHaveBeenCalled();
    expect(JSON.stringify(branch(manager, f.compact, 0, [], index).projection.value)).not.toContain("off-");
    const native = buildSessionProjection(entries, f.compact);
    const local = buildSessionProjection(f.manager.getBranch(f.compact), f.compact);
    expect(local).toEqual(native);
    feed.changed(true);
    expect(feed.index()).not.toBe(index);
    feed.close();
    expect(() => feed.index()).toThrow("Inspector stopped");
    controller.abort();
  });
});
it("matches full native projection for each valid forked, edited and compacted fixture leaf", () => {
  const f = fixture();
  const entries = f.manager.getEntries();
  const index = new EntryIndex(entries);
  for (const entry of entries)
    expect(buildSessionProjection(ancestry(f.manager, entry.id, index).path, entry.id)).toEqual(
      buildSessionProjection(entries, entry.id),
    );
});

describe("R22: emitted legal notices", () => {
  it("keeps the emitted React/license notices in the served JavaScript rather than linking unavailable assets", () => {
    const bundle = readFileSync(new URL("../browser-dist/app.js", import.meta.url), "utf8");
    expect(bundle).toContain("@license React");
    expect(bundle).toContain("MIT license");
    expect(bundle).not.toContain("app.js.LEGAL.txt");
  });
});
