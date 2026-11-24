import assert from "node:assert/strict";
import { test } from "vitest";
import type { Snapshot, SnapshotFile } from "../src/engine/snapshot/snapshot-types.js";
import { continuousFailure } from "../src/engine/sync/continuous-errors.js";
import {
  requireTransferSize,
  selectedPullImage,
  transferSizeDetails,
} from "../src/engine/sync/transfer-size-limits.js";
import { remoteError } from "../src/protocol.js";

const mib = 1024 ** 2;
const limits = { maxFileSizeMiB: 1, maxDirectorySizeMiB: 1 };

function file(path: string, size: number): SnapshotFile {
  return { path, sha256: "", contentBase64: Buffer.alloc(size, 0x61).toString("base64") };
}

function snapshot(files: SnapshotFile[]): Snapshot {
  return { version: 1, id: "test", createdAt: "", machine: "", profile: "", files };
}

test("size checks use exact decoded bytes and recursively count directories but not the root", () => {
  const files = [file("root-one", mib), file("root-two", mib), file("sessions/workspace/one.jsonl", mib - 1)];
  assert.doesNotThrow(() => requireTransferSize(limits, { side: "Local", files }));
  files.push(file("sessions/workspace/two.jsonl", 2), file("sessions/other.jsonl", 3), file("root-three", mib + 1));
  const details = transferSizeDetails(limits, [{ side: "Local", files }]);
  assert.ok(details);
  assert.match(details, /file "root-three": 1048577 bytes \(limit 1048576 bytes\)/u);
  assert.match(details, /directory "sessions\/workspace": 1048577 bytes/u);
  assert.match(details, /directory "sessions": 1048580 bytes/u);
  assert.doesNotMatch(details, /directory "(?:\/|\.|)"/u);
  assert.doesNotMatch(details, /root-one|root-two/u);
});

test("selected sides are independent; Pull counts only the protected session version it keeps", () => {
  const protectedPath = "sessions/live.jsonl";
  const incoming = snapshot([file(protectedPath, mib + 1), file("docs/keep", mib)]);
  const local = snapshot([file(protectedPath, mib), file("docs/old", mib + 1)]);
  assert.doesNotThrow(() =>
    requireTransferSize(limits, selectedPullImage(incoming, local, new Set([protectedPath])), {
      side: "Remote",
      files: [file("docs/keep", mib)],
    }),
  );
  assert.throws(
    () => requireTransferSize(limits, selectedPullImage(incoming, local, new Set())),
    (error) => {
      assert.deepEqual(continuousFailure(error), { kind: "unsafe", retry: false, delay: undefined });
      assert.match(String(error), /Local file "sessions\/live.jsonl": 1048577 bytes/u);
      return true;
    },
  );
});

test("rule metadata counts by UTF-8 size only when present, independently from directory limits", () => {
  const ignoreRules = { filename: ".syncignore", text: "é".repeat(mib / 2) };
  assert.doesNotThrow(() => requireTransferSize(limits, { side: "Remote", files: [], ignoreRules }));
  ignoreRules.text += "界";
  assert.throws(() => requireTransferSize(limits, { side: "Remote", files: [], ignoreRules }), /1048579 bytes/u);
  assert.doesNotThrow(() => requireTransferSize(limits, { side: "Remote", files: [], ignoreRules: null }));
  assert.doesNotThrow(() =>
    requireTransferSize({ maxDirectorySizeMiB: 1 }, { side: "Remote", files: [], ignoreRules }),
  );
});

test("diagnostics are deterministic, safe, and bounded", () => {
  const sample = file("", mib + 1);
  const files = Array.from({ length: 30 }, (_, index) => ({
    ...sample,
    path: `entry-${String(index).padStart(2, "0")}`,
  }));
  files.push({ ...sample, path: `a\n\u001b\u202esafe-${"q".repeat(1000)}` });
  const config = { maxFileSizeMiB: 1, pathPolicy: "ignore-file" as const };
  const details = transferSizeDetails(config, [{ side: "Local", files }]);
  assert.ok(details);
  assert.equal(details, transferSizeDetails(config, [{ side: "Local", files: [...files].reverse() }]));
  assert.ok(details.length < 900);
  assert.ok(!details.includes("\n") && !details.includes("\u001b") && !details.includes("\u202e"));
  assert.match(details, /23 additional findings omitted/u);
  assert.match(details, /\/sync diff.*\.syncignore.*Push or Pull/u);
  const hostile = files.map((file, index) => ({ ...file, path: `${index}-"${"\u202e".repeat(250)}` }));
  assert.throws(
    () => requireTransferSize(config, { side: "Local", files: hostile }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(remoteError(error).message, error.message);
      assert.match(error.message, /omitted.*\/sync diff/u);
      return true;
    },
  );
});
