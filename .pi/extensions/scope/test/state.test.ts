import { resolve } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  createSnapshot,
  MAX_STATE_BYTES,
  MAX_TARGETS,
  parseSnapshot,
  restoreScope,
  STATE_TYPE,
  sameScope,
} from "../state.ts";

const cwd = resolve("scope-state-fixture");
const target = { path: resolve(cwd, "a.ts"), canonical: resolve(cwd, "a.ts") };
const entry = (data: unknown, id = "state"): SessionEntry => ({
  type: "custom",
  id,
  parentId: null,
  timestamp: "2026-11-01T00:00:00.000Z",
  customType: STATE_TYPE,
  data,
});

describe("scope snapshots", () => {
  it("copies, sorts, and deduplicates canonical targets without altering raw paths", () => {
    const original = [{ path: resolve(cwd, "alias"), canonical: target.canonical }, target];
    const snapshot = createSnapshot(cwd, original);
    original[0].path = resolve(cwd, "changed");
    expect(snapshot.targets).toEqual([{ path: resolve(cwd, "alias"), canonical: target.canonical }]);
    expect(parseSnapshot(snapshot)).toEqual(snapshot);
    expect(sameScope(snapshot, createSnapshot(cwd, [target]))).toBe(false);
    expect(sameScope(snapshot, createSnapshot(cwd, snapshot.targets))).toBe(true);
  });
  it.each([
    null,
    false,
    [],
    {},
    { version: 2 },
    { version: 1, cwd, targets: [] },
    { version: 1, cwd: ".", targets: null },
    { version: 1, cwd, targets: [null] },
    { version: 1, cwd, targets: [{ path: "a", canonical: target.canonical }] },
  ])("rejects malformed snapshots %#", (data) => {
    expect(() => parseSnapshot(data)).toThrow();
    const restored = restoreScope([entry(data)], cwd);
    expect(restored.state).toBe("blocked");
    expect(restored.error).toMatch(/edits remain blocked/i);
  });
  it("bounds selection and serialized bytes", () => {
    const targets = Array.from({ length: MAX_TARGETS }, (_, index) => ({
      path: resolve(cwd, `${index}`),
      canonical: resolve(cwd, `${index}`),
    }));
    expect(createSnapshot(cwd, targets).targets).toHaveLength(MAX_TARGETS);
    expect(() => createSnapshot(cwd, [...targets, target])).toThrow("Select between");
    const long = resolve(cwd, "x".repeat(MAX_STATE_BYTES));
    expect(() => createSnapshot(cwd, [{ path: long, canonical: long }])).toThrow("byte notice limit");
  });
  it("restores only the last active-branch snapshot and fails closed across workspaces", () => {
    const active = entry(createSnapshot(cwd, [target]));
    const inactive = entry(createSnapshot(cwd, null), "off");
    expect(restoreScope([], cwd)).toEqual({ state: "inactive" });
    expect(restoreScope([active], cwd).state).toBe("active");
    expect(restoreScope([active, inactive], cwd).state).toBe("inactive");
    expect(restoreScope([inactive, active], cwd).state).toBe("active");
    expect(restoreScope([active, entry({ version: 9 }, "bad")], cwd).state).toBe("blocked");
    expect(restoreScope([active], resolve(cwd, "other")).state).toBe("blocked");
  });
  it("does not treat bootstrap inactivity, selected targets, and explicit off as equivalent", () => {
    const on = createSnapshot(cwd, [target]);
    const off = createSnapshot(cwd, null);
    expect(sameScope(undefined, off)).toBe(false);
    expect(sameScope(on, off)).toBe(false);
    expect(sameScope(off, on)).toBe(false);
    expect(sameScope(off, off)).toBe(true);
    expect(sameScope(on, createSnapshot(resolve(cwd, "other"), [target]))).toBe(false);
  });
});
