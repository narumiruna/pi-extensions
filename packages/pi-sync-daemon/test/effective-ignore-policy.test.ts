import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  loadEffectiveIgnorePolicy,
  requireUnchangedIgnorePolicy,
} from "../src/engine/ignore/effective-ignore-policy.js";
import { DEFAULT_IGNORE_RULES } from "../src/engine/ignore/ignore-source.js";
import {
  compileSyncPolicyTraversal,
  configuredSnapshotPathMatcher,
  selectionForSnapshot,
} from "../src/engine/sync/sync-policy.js";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-ignore-policy-")));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const defaultInput = { sessions: false, configuredFilenames: [] };

test("portable intent survives default initialization while a review of the absent source does not", () =>
  fixture(async (root) => {
    const absent = await loadEffectiveIgnorePolicy(root, defaultInput);
    assert.deepEqual(await fs.readdir(root), []);
    await fs.writeFile(path.join(root, ".syncignore"), DEFAULT_IGNORE_RULES);
    const created = await loadEffectiveIgnorePolicy(root, defaultInput);
    assert.equal(created.fingerprint, absent.fingerprint);
    assert.notEqual(created.sourceDigest, absent.sourceDigest);
    await assert.rejects(requireUnchangedIgnorePolicy(root, absent, defaultInput), /reopen the review/u);
  }));

test("local evidence binds exact bytes, active name, session opt-in, and all reserved rule names", () =>
  fixture(async (root) => {
    const input = { filename: "Current.rules", sessions: true, configuredFilenames: ["Peer.rules"] };
    await fs.writeFile(path.join(root, input.filename), "/private/\n");
    await fs.writeFile(path.join(root, "Replacement.rules"), "/private/\n");
    const policy = await loadEffectiveIgnorePolicy(root, input);
    await requireUnchangedIgnorePolicy(root, policy, { ...input, configuredFilenames: ["PEER.rules", "Peer.rules"] });
    for (const changed of [
      { ...input, filename: "Replacement.rules" },
      { ...input, sessions: false },
      { ...input, configuredFilenames: ["new.rules"] },
    ]) {
      await assert.rejects(requireUnchangedIgnorePolicy(root, policy, changed), /reopen the review/u);
    }
    await fs.appendFile(path.join(root, input.filename), "# note\n");
    await assert.rejects(requireUnchangedIgnorePolicy(root, policy, input), /reopen the review/u);
  }));

test("the effective matcher separates file and directory rules and makes all control filenames local", () =>
  fixture(async (root) => {
    await fs.writeFile(path.join(root, "active.rules"), "/private/\n!/.syncignore\n!/Peer.Rules\n");
    const policy = await loadEffectiveIgnorePolicy(root, {
      filename: "active.rules",
      sessions: false,
      configuredFilenames: ["Peer.rules"],
    });
    const config = { scope: "agent-directory" as const, ignorePolicy: policy };
    const selected = configuredSnapshotPathMatcher(config);
    const traverse = compileSyncPolicyTraversal(config);
    assert.equal(selected("private"), true);
    assert.equal(traverse("private"), false);
    assert.equal(selected("private/content.md"), false);
    assert.equal(selected("Private/content.md"), true);
    for (const file of [".syncignore", "active.rules", "peer.rules", "auth.json", "trust.json", "sessions/p/a.jsonl"]) {
      assert.equal(selected(file), false, file);
    }
    assert.deepEqual(selectionForSnapshot([], undefined, config), {
      version: 4,
      scope: "agent-directory",
      fingerprint: policy.fingerprint,
      sessions: false,
    });
  }));
