import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { transform } from "esbuild";
import { test } from "vitest";
import * as contracts from "../src/scope/contracts.js";
import * as state from "../src/scope/state.js";

type Reader = { state: typeof state; contracts: typeof contracts };
const cwd = resolve("legacy-scope-fixture");
const targets = [
  { path: join(cwd, "a.ts"), canonical: join(cwd, "a.ts") },
  { path: join(cwd, "alias\n漢字.ts"), canonical: join(cwd, "z\u00a0target.ts") },
];
const snapshot = { version: 1, cwd, targets };
const entry = (customType: string, data: unknown, id = customType): SessionEntry => ({
  type: "custom",
  customType,
  data,
  id,
  parentId: null,
  timestamp: "2026-11-01T00:00:00.000Z",
});
const user = (content: string, timestamp = 1): AgentMessage => ({ role: "user", content, timestamp });
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function withPredecessor(run: (predecessor: Reader) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-files-predecessor-reader-"));
  try {
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
    // Execute only the actual archived pure readers, never the archived extension factory.
    // Their relative imports stay together, exactly as they were before the source move.
    await Promise.all(
      ["state", "contracts", "display"].map(async (name) => {
        const source = await readFile(resolve(`deprecated/pi-edit-scope/src/${name}.ts`), "utf8");
        const result = await transform(source, { loader: "ts", format: "esm", target: "es2024" });
        await writeFile(join(root, `${name}.js`), result.code);
      }),
    );
    const legacyState = (await import(pathToFileURL(join(root, "state.js")).href)) as typeof state;
    const legacyContracts = (await import(pathToFileURL(join(root, "contracts.js")).href)) as typeof contracts;
    await run({ state: legacyState, contracts: legacyContracts });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("historical v1 scope state restores forward and backward without rewriting session bytes", async () => {
  await withPredecessor(async (predecessor) => {
    assert.deepEqual(
      [state.STATE_TYPE, contracts.NOTICE_TYPE, contracts.ANCHOR_TYPE],
      ["scope-state", "scope-contract", "scope-context-anchor"],
    );
    assert.deepEqual(
      [predecessor.state.STATE_TYPE, predecessor.contracts.NOTICE_TYPE, predecessor.contracts.ANCHOR_TYPE],
      [state.STATE_TYPE, contracts.NOTICE_TYPE, contracts.ANCHOR_TYPE],
    );
    for (const [data, expected] of [
      [snapshot, "active"],
      [{ version: 1, cwd, targets: null }, "inactive"],
      [{ version: 2, cwd, targets }, "blocked"],
      [{ version: 1, cwd, targets: [] }, "blocked"],
      [{ version: 1, cwd: join(cwd, "another-workspace"), targets }, "blocked"],
    ] as const) {
      const historical = bytes([entry("scope-state", data, "original-state-id")]);
      const branch = JSON.parse(historical.toString()) as SessionEntry[];
      const oldState = predecessor.state.restoreScope(branch, cwd);
      const newState = state.restoreScope(branch, cwd);
      assert.equal(newState.state, expected);
      assert.equal(newState.entryId, "original-state-id");
      assert.deepEqual(newState.snapshot, oldState.snapshot);
      if (expected === "blocked")
        assert.match(newState.error ?? "", /repair with Manage edit scope in \/files or exit with \/files off/);
      assert.deepEqual(bytes(branch), historical);
    }
    for (const selection of [targets, null]) {
      const oldSnapshot = predecessor.state.createSnapshot(cwd, selection);
      const newSnapshot = state.createSnapshot(cwd, selection);
      assert.deepEqual(bytes(newSnapshot), bytes(oldSnapshot));
      const forward = bytes([entry("scope-state", oldSnapshot, "predecessor-produced")]);
      const reverse = bytes([entry("scope-state", newSnapshot, "successor-produced")]);
      const forwardState = state.restoreScope(JSON.parse(forward.toString()), cwd);
      const reverseState = predecessor.state.restoreScope(JSON.parse(reverse.toString()), cwd);
      assert.equal(forwardState.entryId, "predecessor-produced");
      assert.equal(reverseState.entryId, "successor-produced");
      for (const restored of [forwardState, reverseState]) {
        assert.equal(restored.state, selection === null ? "inactive" : "active");
        assert.deepEqual(bytes(restored.snapshot), bytes(oldSnapshot));
      }
    }
  });
});

test.each(["active", "blocked", "inactive"] as const)(
  "upgrades saved v1 %s notices without rewriting history",
  async (kind) => {
    await withPredecessor(async (predecessor) => {
      const data =
        kind === "blocked" ? { invalid: true } : kind === "inactive" ? state.createSnapshot(cwd, null) : snapshot;
      const scopeEntry = entry("scope-state", data, "original-state-id");
      const current = state.restoreScope([scopeEntry], cwd);
      assert.equal(current.state, kind);
      assert.deepEqual(
        bytes(contracts.createScopeNotice(current, 10, 1)),
        bytes(predecessor.contracts.createScopeNotice(current, 10)),
      );
      const input = [user("original request")];
      const produced = predecessor.contracts.reconcileScopeContext(input, [scopeEntry], current, 10);
      assert.equal(produced.anchor?.version, 1);
      const notice = produced.messages.at(-1);
      assert.ok(notice?.role === "custom");
      const persisted = [
        scopeEntry,
        entry("scope-context-anchor", produced.anchor, "original-anchor-id"),
        {
          type: "custom_message",
          id: "original-notice-id",
          parentId: "original-anchor-id",
          timestamp: "2026-11-01T00:00:00.010Z",
          customType: notice.customType,
          content: notice.content,
          display: notice.display,
          details: notice.details,
        } as SessionEntry,
      ];
      const historical = bytes(persisted);
      const savedBranch = copy(persisted);
      const later = user("later request", 11);
      const next = user("next request", 21);
      const delayed = [...input, later, { ...notice, timestamp: 12 }];
      const upgrade = contracts.reconcileScopeContext(delayed, savedBranch, current, 20);
      const prefix = [...produced.messages, later];
      assert.deepEqual(bytes(upgrade.messages.slice(0, prefix.length)), bytes(prefix));
      if (kind === "inactive") {
        assert.equal(upgrade.anchor, undefined);
        assert.deepEqual(upgrade.messages, prefix);
      } else {
        assert.equal(upgrade.anchor?.version, 2);
        assert.equal(upgrade.messages.length, prefix.length + 1);
        assert.deepEqual(upgrade.messages.at(-1), contracts.createScopeNotice(current, 20));
      }
      assert.deepEqual(bytes(savedBranch), historical);
      const upgraded = upgrade.anchor
        ? [...savedBranch, entry("scope-context-anchor", upgrade.anchor, "new-anchor")]
        : savedBranch;
      const lateCorrection = upgrade.anchor ? [contracts.createScopeNotice(current, 22) as AgentMessage] : [];
      const resumed = contracts.reconcileScopeContext(
        [...delayed, next, ...lateCorrection],
        copy(upgraded),
        current,
        30,
      );
      assert.equal(resumed.anchor, undefined);
      assert.deepEqual(resumed.messages, [...upgrade.messages, next]);
      assert.equal(contracts.hasCurrentScopeNotice(resumed.messages, current), true);

      const summary: AgentMessage = {
        role: "compactionSummary",
        summary: "retained summary",
        tokensBefore: 50,
        timestamp: 40,
      };
      const recovered = contracts.reconcileScopeContext([summary], upgraded, current, 50);
      assert.equal(recovered.anchor?.version, kind === "inactive" ? 1 : 2);
      assert.deepEqual(recovered.messages, [summary, contracts.createScopeNotice(current, 50)]);
      const compacted = [...upgraded, entry("scope-context-anchor", recovered.anchor, "recovered-anchor-id")];
      const ordinary = contracts.reconcileScopeContext([summary, next], copy(compacted), current, 60);
      assert.equal(ordinary.anchor, undefined);
      assert.deepEqual(ordinary.messages, [...recovered.messages, next]);

      const rollback = predecessor.state.restoreScope(copy(upgraded), cwd);
      assert.equal(rollback.state, kind);
      assert.equal(rollback.entryId, current.entryId);
      assert.deepEqual(rollback.snapshot, current.snapshot);
      const oldReader = predecessor.contracts.reconcileScopeContext(resumed.messages, copy(upgraded), rollback, 70);
      assert.equal(predecessor.contracts.hasCurrentScopeNotice(oldReader.messages, rollback), true);
    });
  },
);

test("adds the command correction after a repeated v1 recovery on the active branch", async () => {
  await withPredecessor(async (predecessor) => {
    const scopeEntry = entry("scope-state", snapshot, "original-state-id");
    const active = state.restoreScope([scopeEntry], cwd);
    const blocked: state.ScopeState = { state: "blocked", entryId: active.entryId };
    const input = [user("unchanged request")];
    const branch = [scopeEntry];
    let previous = input;
    for (const [index, current] of [active, blocked, active].entries()) {
      const legacy = predecessor.contracts.reconcileScopeContext(input, branch, current, index + 1);
      assert.equal(legacy.anchor?.version, 1);
      branch.push(entry("scope-context-anchor", legacy.anchor, `transition-${index}`));
      assert.deepEqual(legacy.messages.slice(0, previous.length), previous);
      if (index === 2) assert.equal(legacy.anchor?.recovery, 1);
      previous = legacy.messages;
    }
    const corrected = contracts.reconcileScopeContext(input, copy(branch), active, 100);
    assert.equal(corrected.anchor?.version, 2);
    assert.deepEqual(corrected.messages.slice(0, -1), previous);
    branch.push(entry("scope-context-anchor", corrected.anchor, "correction"));
    const forked = copy(branch);
    const next = user("next after branch reload", 101);
    const resumed = contracts.reconcileScopeContext([...input, next], forked, active, 102);
    assert.equal(resumed.anchor, undefined);
    assert.deepEqual(resumed.messages, [...corrected.messages, next]);

    let prefix = resumed.messages;
    const branchInput = [...input, next];
    const inactive: state.ScopeState = {
      state: "inactive",
      entryId: "off-id",
      snapshot: state.createSnapshot(cwd, null),
    };
    for (const [index, current] of [blocked, active, inactive].entries()) {
      if (current === inactive) forked.push(entry("scope-state", current.snapshot, current.entryId));
      const transition = contracts.reconcileScopeContext(branchInput, forked, current, 110 + index);
      assert.equal(transition.anchor?.version, current === inactive ? 1 : 2);
      assert.deepEqual(transition.messages.slice(0, -1), prefix);
      forked.push(entry("scope-context-anchor", transition.anchor, `new-transition-${index}`));
      assert.equal(contracts.reconcileScopeContext(branchInput, forked, current).anchor, undefined);
      prefix = transition.messages;
    }
    assert.deepEqual(contracts.reconcileScopeContext(branchInput, branch, active).messages, resumed.messages);
  });
});

test("repository activation has one successor entrypoint and retains the settings basenames", async () => {
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  assert.deepEqual(
    manifest.pi.extensions.filter((path: string) => /\/pi-(?:files|file-context|edit-scope)\//u.test(path)),
    ["./packages/pi-files/src/index.ts"],
  );
  const packageManifest = JSON.parse(await readFile(resolve("packages/pi-files/package.json"), "utf8"));
  assert.deepEqual(packageManifest.pi.extensions, ["./dist/index.ts"]);
  for (const [legacyPath, successorPath, basename] of [
    ["pi-file-context/src/file-context-settings.ts", "file-context-settings.ts", "pi-file-context.json"],
    ["pi-edit-scope/src/edit-scope.ts", "scope/edit-scope.ts", "pi-scope.json"],
  ]) {
    for (const path of [resolve("deprecated", legacyPath), resolve("packages/pi-files/src", successorPath)]) {
      const source = await readFile(path, "utf8");
      assert.ok(source.includes(`"${basename}"`), `${path} must retain ${basename}`);
      assert.equal(source.includes('"pi-files.json"'), false);
    }
  }
});
