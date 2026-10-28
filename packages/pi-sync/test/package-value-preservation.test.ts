import assert from "node:assert/strict";
import { test } from "vitest";
import type { JsonValue } from "../src/sync/json-document.js";
import { mergePackageVersions } from "../src/sync/package-merge.js";
import { mergeAcceptedSettingsPackages, mergeSettingsJson } from "../src/sync/settings-merge.js";

for (const [base, local, remote, expected] of [
  ["1.0.0", "1.0.0", "1.0.0+remote", "1.0.0+remote"],
  ["1.0.0", "1.0.0+local", "1.0.0", "1.0.0+local"],
  ["1.0.0", "1.0.0+local", "1.0.0+remote", undefined],
  ["1.0.0", "1.0.0+same", "1.0.0+same", "1.0.0+same"],
  ["1.0.0", "1.0.0", "v1.0.0", "v1.0.0"],
  ["1.0.0", "v1.0.0", "1.0.0", "v1.0.0"],
  ["1.0.0", "v1.0.0", "1.0.0+remote", undefined],
  ["1.0.0", "1.0.0", " 1.0.0", " 1.0.0"],
  ["1.0.0-rc.1", "1.0.0-rc.1", "1.0.0-rc.1+remote", "1.0.0-rc.1+remote"],
] as const) {
  test(`equal SemVer precedence retains source edits: ${local}/${remote}`, () => {
    for (const filtered of [false, true]) {
      const entry = (version: string): JsonValue =>
        filtered ? { source: `npm:x@${version}`, extensions: ["index.ts"] } : `npm:x@${version}`;
      const versions: [JsonValue[], JsonValue[], JsonValue[]] = [[entry(base)], [entry(local)], [entry(remote)]];
      assert.deepEqual(mergePackageVersions(...versions), expected ? [entry(expected)] : undefined);
      const merged = mergeSettingsJson(
        ...(versions.map((packages) => Buffer.from(JSON.stringify({ packages }))) as [Buffer, Buffer, Buffer]),
        undefined,
        true,
      );
      if (expected) {
        assert.equal(merged.kind, "merged");
        if (merged.kind === "merged")
          assert.deepEqual(JSON.parse(merged.content.toString()), { packages: [entry(expected)] });
      } else {
        assert.deepEqual(merged, { kind: "review", reason: "field-conflict", fields: ["packages"] });
      }
    }
  });
}

for (const array of [
  '[\r\n    "npm:x@1.0.0"\r\n  ]',
  '["\\u006epm:x@1.0.0"]',
  '[{ "future": 1.00e0, "source" : "npm:x@1.0.0", "extensions": [] }]',
]) {
  test(`unchanged package bytes survive another field edit: ${array}`, () => {
    const local = Buffer.from(`\uFEFF{\r\n  "packages" : ${array},\r\n  "theme": "base"\r\n}\r\n`);
    for (const changed of [false, true]) {
      const remote = Buffer.from(
        local.toString().replace('"theme": "base"', changed ? '"theme": "remote"' : '"theme": "base"'),
      );
      const merged = mergeSettingsJson(local, local, remote, undefined, true);
      assert.equal(merged.kind, "merged");
      if (merged.kind === "merged") assert.deepEqual(merged.content, remote);
    }
  });
}

for (const winner of ["local", "remote"] as const) {
  test(`reuse the ${winner} package node when it matches the result`, () => {
    const base = Buffer.from('{"packages":["npm:x@1.0.0"]}');
    const selected = '[\n    "npm:x@2.0.0"\n  ]';
    const low = Buffer.from('{"packages":["npm:x@1.1.0"]}');
    const high = Buffer.from(`{"packages":${selected}}`);
    const merged = mergeSettingsJson(
      base,
      winner === "local" ? high : low,
      winner === "remote" ? high : low,
      undefined,
      true,
    );
    assert.equal(merged.kind, "merged");
    if (merged.kind === "merged") assert.equal(merged.content.toString(), high.toString());
  });
}

for (const accepted of [
  '{"number":1.00e0,"packages" : [ "npm:x@2.0.0" ]}',
  '\uFEFF{\r\n "packages": ["npm:x@2.0.0"],\r\n "number": 1.00e0\r\n}\r\n',
  '{"number":1.00e0}',
  '{"packages":["npm:x@latest"]}',
  '{"packages":["git:github.com/example/repo@remote"]}',
  '{"packages":null}',
  '{"packages":42}',
  '{"number":9007199254740993}',
  '{"number":1,"number":2}',
  "{",
]) {
  test(`accepted files do not need a package rewrite: ${accepted.slice(0, 55)}`, () => {
    const base = Buffer.from('{"packages":["npm:x@2.0.0"],"number":1}');
    const bytes = Buffer.from(accepted);
    assert.equal(mergeAcceptedSettingsPackages(base, base, bytes, bytes), undefined);
    assert.equal(mergeAcceptedSettingsPackages(base, bytes, base, bytes), undefined);
  });
}

test("accepted package override preserves BOM and all other document bytes", () => {
  const base = Buffer.from('{"packages":["npm:x@2.0.0"],"number":1}');
  const accepted = '\uFEFF{\r\n  "number" : 1.00e0,\r\n  "packages" : ["npm:x@1.0.0"]\r\n}\r\n';
  const patched = mergeAcceptedSettingsPackages(base, base, Buffer.from(accepted), Buffer.from(accepted));
  assert.equal(patched?.toString(), accepted.replace('"npm:x@1.0.0"', '"npm:x@2.0.0"'));
});

test("synthesize a package node only for a combined value", () => {
  const bytes = (packages: string[]) => Buffer.from(JSON.stringify({ packages }));
  const merged = mergeSettingsJson(
    bytes(["npm:x@1.0.0", "npm:y@1.0.0"]),
    bytes(["npm:x@2.0.0", "npm:y@1.0.0"]),
    bytes(["npm:x@1.0.0", "npm:y@2.0.0"]),
    undefined,
    true,
  );
  assert.equal(merged.kind, "merged");
  if (merged.kind === "merged")
    assert.deepEqual(JSON.parse(merged.content.toString()), { packages: ["npm:x@2.0.0", "npm:y@2.0.0"] });
});
