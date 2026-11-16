import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, test } from "vitest";

interface PackageManifest {
  name: string;
  pi?: { extensions?: string[] };
}

interface PackedPackage {
  name: string;
  files: Array<{ path: string; size: number }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inspectPackedPackages(
  result: Pick<SpawnSyncReturns<string>, "error" | "status" | "stdout" | "stderr">,
  expectedNames: readonly string[],
): Map<string, PackedPackage> {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `npm pack must exit with status 0:\n${result.stdout}\n${result.stderr}`);
  const output: unknown = JSON.parse(result.stdout);
  assert.ok(Array.isArray(output), "npm pack JSON must be an array");
  const expected = new Set(expectedNames);
  assert.equal(expected.size, expectedNames.length, "Expected package names must be unique");
  const packages = new Map<string, PackedPackage>();
  const records: unknown[] = output;
  for (const record of records) {
    assert.ok(isRecord(record), "Packed package must be an object");
    assert.ok(
      typeof record.name === "string" && record.name.length > 0,
      "Packed package name must be a non-empty string",
    );
    const name = record.name;
    assert.ok(expected.has(name), `Unexpected packed package: ${name}`);
    assert.ok(!packages.has(name), `Duplicate packed package: ${name}`);
    assert.ok(Array.isArray(record.files), `${name} files must be an array`);
    const files: unknown[] = record.files;
    const packed: PackedPackage = { name, files: [] };
    for (const file of files) {
      assert.ok(isRecord(file), `${name} file must be an object`);
      assert.ok(typeof file.path === "string" && file.path.length > 0, `${name} file path must be a non-empty string`);
      assert.ok(
        typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0,
        `${name} file size must be a non-negative safe integer`,
      );
      packed.files.push({ path: file.path, size: file.size });
    }
    packages.set(name, packed);
  }
  assert.equal(
    packages.size,
    expected.size,
    `Missing packed packages: ${expectedNames.filter((name) => !packages.has(name)).join(", ")}`,
  );
  return packages;
}

function assertPackageChangelog(packed: PackedPackage, expectedSize: number): void {
  const changelog = packed.files.find((file) => file.path === "CHANGELOG.md");
  assert.ok(changelog, `${packed.name} must publish CHANGELOG.md`);
  assert.equal(
    packed.files.filter((file) => file.path === "CHANGELOG.md").length,
    1,
    `${packed.name} must publish exactly one root CHANGELOG.md`,
  );
  assert.equal(changelog.size, expectedSize);
}

const activeExtensions = readdirSync("packages", { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    const directory = join("packages", entry.name);
    const manifestPath = join(directory, "package.json");
    if (!existsSync(manifestPath)) return [];
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
    return manifest.pi?.extensions === undefined ? [] : [{ directory, name: manifest.name }];
  });

let packedPackages = new Map<string, PackedPackage>();
beforeAll(() => {
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const args = [
    "pack",
    ...activeExtensions.flatMap(({ name }) => ["--workspace", name]),
    "--dry-run",
    "--ignore-scripts",
    "--json",
  ];
  // Inspect completed builds without prepack rebuilding shared dependencies during consumer tests.
  const result = spawnSync(command, npmCli ? [npmCli, ...args] : args, {
    encoding: "utf8",
    shell: !npmCli && process.platform === "win32",
  });
  packedPackages = inspectPackedPackages(
    result,
    activeExtensions.map(({ name }) => name),
  );
});

for (const { directory, name } of activeExtensions) {
  test(`${name} publishes its package-root changelog`, () => {
    const packed = packedPackages.get(name);
    assert.ok(packed);
    assert.equal(packed.name, name);
    assertPackageChangelog(packed, statSync(join(directory, "CHANGELOG.md")).size);
  });
}

const fixtureFile = { path: "CHANGELOG.md", size: 12 };
const fixturePackage = { name: "@test/pi-one", files: [fixtureFile] };
const otherPackage = { name: "@test/pi-two", files: [fixtureFile] };
const fixturePackages = [fixturePackage, otherPackage];
const fixtureNames = fixturePackages.map(({ name }) => name);
const successfulResult = { status: 0, stdout: JSON.stringify(fixturePackages), stderr: "" };
const utf8Text = "更新 🚀\n";
const utf8Size = Buffer.byteLength(utf8Text, "utf8");

test.each([
  {
    label: "spawn error",
    result: { ...successfulResult, error: new Error("npm unavailable") },
    message: /npm unavailable/u,
  },
  { label: "nonzero status", result: { ...successfulResult, status: 1, stderr: "npm failed" }, message: /npm failed/u },
  { label: "null status", result: { ...successfulResult, status: null }, message: /must exit with status 0/u },
])("batch pack rejects $label", ({ result, message }) => {
  assert.throws(() => inspectPackedPackages(result, fixtureNames), message);
});

test.each([
  { label: "empty", stdout: "" },
  { label: "malformed", stdout: "[{" },
])("batch pack rejects $label JSON", ({ stdout }) => {
  assert.throws(() => inspectPackedPackages({ ...successfulResult, stdout }, fixtureNames), SyntaxError);
});

test.each([
  { label: "null", output: null },
  { label: "object", output: fixturePackage },
  { label: "primitive", output: "packages" },
])("batch pack rejects non-array $label output", ({ output }) => {
  assert.throws(
    () => inspectPackedPackages({ ...successfulResult, stdout: JSON.stringify(output) }, fixtureNames),
    /npm pack JSON must be an array/u,
  );
});

test.each([
  { label: "null", record: null, message: /Packed package must be an object/u },
  { label: "array", record: [], message: /Packed package must be an object/u },
  { label: "primitive", record: "package", message: /Packed package must be an object/u },
  { label: "missing name", record: { files: [fixtureFile] }, message: /name must be a non-empty string/u },
  { label: "empty name", record: { ...fixturePackage, name: "" }, message: /name must be a non-empty string/u },
  { label: "non-string name", record: { ...fixturePackage, name: 1 }, message: /name must be a non-empty string/u },
])("batch pack rejects $label package records", ({ record, message }) => {
  assert.throws(
    () => inspectPackedPackages({ ...successfulResult, stdout: JSON.stringify([record, otherPackage]) }, fixtureNames),
    message,
  );
});

test.each([
  { label: "missing", files: undefined },
  { label: "null", files: null },
  { label: "object", files: fixtureFile },
])("batch pack rejects $label file arrays", ({ files }) => {
  const output = [{ ...fixturePackage, files }, otherPackage];
  assert.throws(
    () => inspectPackedPackages({ ...successfulResult, stdout: JSON.stringify(output) }, fixtureNames),
    /files must be an array/u,
  );
});

test.each([
  { label: "null", file: null, message: /file must be an object/u },
  { label: "array", file: [], message: /file must be an object/u },
  { label: "primitive", file: "CHANGELOG.md", message: /file must be an object/u },
  { label: "missing path", file: { size: 12 }, message: /file path must be a non-empty string/u },
  { label: "empty path", file: { ...fixtureFile, path: "" }, message: /file path must be a non-empty string/u },
  { label: "non-string path", file: { ...fixtureFile, path: 1 }, message: /file path must be a non-empty string/u },
])("batch pack rejects $label file entries", ({ file, message }) => {
  const output = [{ ...fixturePackage, files: [file] }, otherPackage];
  assert.throws(
    () => inspectPackedPackages({ ...successfulResult, stdout: JSON.stringify(output) }, fixtureNames),
    message,
  );
});

test.each([
  { label: "missing", size: undefined },
  { label: "null", size: null },
  { label: "string", size: "12" },
  { label: "negative", size: -1 },
  { label: "fractional", size: 1.5 },
  { label: "unsafe integer", size: Number.MAX_SAFE_INTEGER + 1 },
])("batch pack rejects $label file sizes", ({ size }) => {
  const output = [{ ...fixturePackage, files: [fixtureFile, { path: "README.md", size }] }, otherPackage];
  assert.throws(
    () => inspectPackedPackages({ ...successfulResult, stdout: JSON.stringify(output) }, fixtureNames),
    /file size must be a non-negative safe integer/u,
  );
});

test.each([
  { label: "empty", output: [], message: /Missing packed packages/u },
  { label: "missing", output: [fixturePackage], message: /Missing packed packages: @test\/pi-two/u },
  {
    label: "extra",
    output: [...fixturePackages, { ...fixturePackage, name: "@test/pi-extra" }],
    message: /Unexpected packed package: @test\/pi-extra/u,
  },
  {
    label: "unexpected replacement",
    output: [fixturePackage, { ...otherPackage, name: "@test/pi-unexpected" }],
    message: /Unexpected packed package: @test\/pi-unexpected/u,
  },
  { label: "duplicate", output: [fixturePackage, fixturePackage], message: /Duplicate packed package: @test\/pi-one/u },
])("batch pack rejects $label inventory", ({ output, message }) => {
  assert.throws(
    () => inspectPackedPackages({ ...successfulResult, stdout: JSON.stringify(output) }, fixtureNames),
    message,
  );
});

test("batch pack rejects duplicate expected package names", () => {
  assert.throws(
    () => inspectPackedPackages(successfulResult, [fixturePackage.name, fixturePackage.name]),
    /Expected package names must be unique/u,
  );
});

test.each([
  { label: "missing", files: [], message: /must publish CHANGELOG.md/u },
  { label: "nested", files: [{ ...fixtureFile, path: "docs/CHANGELOG.md" }], message: /must publish CHANGELOG.md/u },
  { label: "relative", files: [{ ...fixtureFile, path: "./CHANGELOG.md" }], message: /must publish CHANGELOG.md/u },
  { label: "wrong case", files: [{ ...fixtureFile, path: "changelog.md" }], message: /must publish CHANGELOG.md/u },
  { label: "duplicate", files: [fixtureFile, { ...fixtureFile, size: 13 }], message: /exactly one root CHANGELOG.md/u },
])("batch pack rejects $label root changelogs", ({ files, message }) => {
  const output = [{ ...fixturePackage, files }, otherPackage];
  const packages = inspectPackedPackages({ ...successfulResult, stdout: JSON.stringify(output) }, fixtureNames);
  const packed = packages.get(fixturePackage.name);
  assert.ok(packed);
  assert.throws(() => assertPackageChangelog(packed, fixtureFile.size), message);
});

test.each([
  { label: "too small", size: fixtureFile.size - 1, expectedSize: fixtureFile.size },
  { label: "too large", size: fixtureFile.size + 1, expectedSize: fixtureFile.size },
  { label: "UTF-8 character count instead of byte count", size: utf8Text.length, expectedSize: utf8Size },
])("batch pack rejects $label changelog sizes", ({ size, expectedSize }) => {
  const output = [{ ...fixturePackage, files: [{ ...fixtureFile, size }] }, otherPackage];
  const packages = inspectPackedPackages({ ...successfulResult, stdout: JSON.stringify(output) }, fixtureNames);
  const packed = packages.get(fixturePackage.name);
  assert.ok(packed);
  assert.throws(() => assertPackageChangelog(packed, expectedSize), assert.AssertionError);
});

test.each([
  { label: "unordered output", output: [otherPackage, fixturePackage], expectedSize: fixtureFile.size },
  {
    label: "extra npm metadata",
    output: fixturePackages.map((packed) => ({
      ...packed,
      version: "1.0.0",
      size: 100,
      files: packed.files.map((file) => ({ ...file, mode: 420 })),
    })),
    expectedSize: fixtureFile.size,
  },
  {
    label: "zero-byte changelogs",
    output: fixturePackages.map((packed) => ({ ...packed, files: [{ ...fixtureFile, size: 0 }] })),
    expectedSize: 0,
  },
  {
    label: "UTF-8 byte sizes",
    output: fixturePackages.map((packed) => ({ ...packed, files: [{ ...fixtureFile, size: utf8Size }] })),
    expectedSize: utf8Size,
  },
])("batch pack accepts $label", ({ output, expectedSize }) => {
  const packages = inspectPackedPackages({ ...successfulResult, stdout: JSON.stringify(output) }, fixtureNames);
  assert.equal(packages.size, fixtureNames.length);
  for (const name of fixtureNames) {
    const packed = packages.get(name);
    assert.ok(packed);
    assert.equal(packed.name, name);
    assertPackageChangelog(packed, expectedSize);
  }
});
