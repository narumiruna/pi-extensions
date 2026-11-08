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
const successor: Reader = { state, contracts };
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
      assert.deepEqual(newState, oldState);
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

test("historical notices and anchored prefixes remain byte-identical in both migration directions", async () => {
  await withPredecessor(async (predecessor) => {
    for (const [producer, reader] of [
      [predecessor, successor],
      [successor, predecessor],
    ]) {
      const branch = [entry("scope-state", snapshot, "original-state-id")];
      const active = producer.state.restoreScope(branch, cwd);
      const blocked: state.ScopeState = { state: "blocked", entryId: active.entryId };
      const inactive: state.ScopeState = {
        state: "inactive",
        entryId: "off-id",
        snapshot: producer.state.createSnapshot(cwd, null),
      };
      for (const current of [active, blocked, inactive]) {
        const oldNotice = predecessor.contracts.createScopeNotice(current, 10);
        const newNotice = contracts.createScopeNotice(current, 10);
        assert.deepEqual(bytes(newNotice), bytes(oldNotice));
        assert.ok(newNotice && typeof newNotice.content === "string");
        assert.equal(newNotice.content.includes("/files"), false);
        const states = [entry("scope-state", current.snapshot ?? { invalid: true }, current.entryId)];
        const input = [user("original request")];
        const produced = producer.contracts.reconcileScopeContext(input, states, current, 10);
        assert.ok(produced.anchor);
        assert.equal(produced.anchor.version, 1);
        assert.equal(produced.anchor.stateId, current.entryId);
        const notice = produced.messages.at(-1);
        assert.ok(notice && notice.role === "custom");
        const persisted = [
          ...states,
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
        const savedBranch = JSON.parse(historical.toString()) as SessionEntry[];
        // Pi can publish the native notice after newer output. The saved anchor must
        // still place it at its original model-visible boundary, not at a moving tail.
        const later = user("later request", 11);
        const resumed = reader.contracts.reconcileScopeContext([...input, later, notice], savedBranch, current, 20);
        assert.equal(resumed.anchor, undefined);
        assert.deepEqual(bytes(resumed.messages.slice(0, produced.messages.length)), bytes(produced.messages));
        assert.deepEqual(resumed.messages.at(-1), later);
        assert.equal(reader.contracts.hasCurrentScopeNotice(resumed.messages, current), true);
        assert.deepEqual(
          bytes(reader.contracts.reconcileScopeContext(resumed.messages, savedBranch, current, 30).messages),
          bytes(resumed.messages),
        );
        assert.deepEqual(bytes(savedBranch), historical);

        const summary: AgentMessage = {
          role: "compactionSummary",
          summary: "retained summary",
          tokensBefore: 50,
          timestamp: 40,
        };
        const recovered = reader.contracts.reconcileScopeContext([summary], savedBranch, current, 50);
        assert.ok(recovered.anchor);
        savedBranch.push(entry("scope-context-anchor", recovered.anchor, "recovered-anchor-id"));
        const reverseRead = producer.contracts.reconcileScopeContext([summary, later], savedBranch, current, 60);
        assert.equal(reverseRead.anchor, undefined);
        assert.deepEqual(bytes(reverseRead.messages.slice(0, recovered.messages.length)), bytes(recovered.messages));
      }

      // The optional v1 recovery counter is also predecessor-readable after a
      // blocked state is repaired without replacing the original state entry ID.
      const input = [user("unchanged request")];
      let previous = input;
      for (const [index, current] of [active, blocked, active].entries()) {
        const produced = producer.contracts.reconcileScopeContext(input, branch, current, index + 1);
        assert.ok(produced.anchor);
        branch.push(entry("scope-context-anchor", produced.anchor, `transition-${index}`));
        const resumed = reader.contracts.reconcileScopeContext(input, copy(branch), current, 100);
        assert.equal(resumed.anchor, undefined);
        assert.deepEqual(bytes(resumed.messages), bytes(produced.messages));
        assert.deepEqual(bytes(resumed.messages.slice(0, previous.length)), bytes(previous));
        if (index === 2) assert.equal(produced.anchor.recovery, 1);
        previous = produced.messages;
      }
    }
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
