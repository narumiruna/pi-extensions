import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { setModelInvocation } from "../frontmatter.ts";

const KEY = "disable-model-invocation";
const keys = [KEY, `"${KEY}"`, `'${KEY}'`];
const booleans = ["true", "True", "TRUE", "false", "False", "FALSE"];
const fields = keys.flatMap((key) => booleans.map((value) => ({ key, value })));
const document = (metadata: string) => `---\n${metadata}\n---\n# Instructions\n`;

// These synchronous tests use the project config's default 5,000 ms timeout and no disk fixtures.
describe("setModelInvocation", () => {
  it.each(fields)("disables $key: $value with native boolean semantics", ({ key, value }) => {
    const prefix = `${key}\t :\t`;
    const suffix = " \t # Keep this comment: false\t ";
    const original = document(`description: Demo\n${prefix}${value}${suffix}\nunknown: keep`);
    const expectedValue = value.toLowerCase() === "true" ? value : "true";
    const expected = document(`description: Demo\n${prefix}${expectedValue}${suffix}\nunknown: keep`);

    expect(typeof parseFrontmatter(original).frontmatter[KEY]).toBe("boolean");
    const result = setModelInvocation(original, false);
    expect(result).toBe(expected);
    expect(parseFrontmatter(result).frontmatter[KEY]).toBe(true);
    expect(setModelInvocation(result, false)).toBe(result);
  });

  it.each(fields)("enables $key: $value by removing only its line", ({ key, value }) => {
    const original = document(`description: Demo\n# Before\n${key}: ${value} # Owned\n# After\nunknown: keep`);
    const result = setModelInvocation(original, true);
    expect(result).toBe(document("description: Demo\n# Before\n# After\nunknown: keep"));
    expect(parseFrontmatter(result).frontmatter[KEY]).toBeUndefined();
    expect(setModelInvocation(result, true)).toBe(result);
  });

  it.each(["", " ", "\t", " # comment", "\t# comment", "  #", " # false # true"])(
    "preserves boolean suffix %j when updating false",
    (suffix) => {
      expect(setModelInvocation(document(`${KEY}: false${suffix}`), false)).toBe(document(`${KEY}: true${suffix}`));
    },
  );

  it.each(["", "description: Demo\n", "# Keep\n\n"])(
    "handles an empty or absent owned field in metadata %j",
    (metadata) => {
      const original = `---\n${metadata}---`;
      expect(setModelInvocation(original, true)).toBe(original);
      expect(setModelInvocation(original, false)).toBe(`---\n${metadata}${KEY}: true\n---`);
    },
  );

  it.each(["\n", "\r\n", "\r"].flatMap((newline) => ["", "\ufeff"].map((bom) => ({ newline, bom }))))(
    "preserves BOM=$bom and newline=$newline through insert, update, remove, and no-op",
    ({ newline, bom }) => {
      const prefix = `${bom}---${newline}description: Demo${newline}`;
      // Delimiter-like text, owned-looking keys, and mixed body newlines must not be edited.
      const tail = `---${newline}# Body\r\n${KEY}: false\r---\n\ufeffEnd`;
      const original = `${prefix}${tail}`;
      const disabled = `${prefix}${KEY}: true${newline}${tail}`;
      expect(setModelInvocation(original, false)).toBe(disabled);
      expect(setModelInvocation(original, true)).toBe(original);
      expect(setModelInvocation(disabled, false)).toBe(disabled);
      expect(setModelInvocation(disabled, true)).toBe(original);
      expect(setModelInvocation(`${prefix}'${KEY}': false # Keep${newline}${tail}`, false)).toBe(
        `${prefix}'${KEY}': true # Keep${newline}${tail}`,
      );
    },
  );

  it("uses the opening newline for insertion without changing mixed metadata newlines", () => {
    const prefix = "\ufeff---\r\ndescription: Demo\nunknown: keep\r";
    const tail = "---\nBody\r\n";
    expect(setModelInvocation(`${prefix}${tail}`, false)).toBe(`${prefix}${KEY}: true\r\n${tail}`);
  });

  it("keeps the existing field's newline when its newline differs from the opening delimiter", () => {
    const original = `\ufeff---\r\ndescription: Demo\r${KEY}: false # Keep\nunknown: keep\r---\nBody`;
    expect(setModelInvocation(original, false)).toBe(
      `\ufeff---\r\ndescription: Demo\r${KEY}: true # Keep\nunknown: keep\r---\nBody`,
    );
    expect(setModelInvocation(original, true)).toBe("\ufeff---\r\ndescription: Demo\runknown: keep\r---\nBody");
  });

  it.each([true, false])("preserves nested fields, scalar text, and unrelated scalar keys (enabled=%s)", (enabled) => {
    const metadata = [
      "description: Demo",
      "metadata:",
      `  ${KEY}: false`,
      `  '${KEY}': true`,
      "  list:",
      `    - ${KEY}: false`,
      "notes: |",
      `  ${KEY}: false # Scalar text`,
      `# ${KEY}: false`,
      `\t# ${KEY}: true`,
      "string: value",
      '"false": value',
      "42: value",
      "null: value",
      "yes: value",
      `${KEY}-other: keep`,
      `Disable-model-invocation: keep`,
    ].join("\n");
    const original = document(metadata);
    expect(setModelInvocation(original, enabled)).toBe(enabled ? original : document(`${metadata}\n${KEY}: true`));
    expect(setModelInvocation(document(`${KEY}: false\n${metadata}`), enabled)).toBe(
      document(enabled ? metadata : `${KEY}: true\n${metadata}`),
    );
  });

  it.each(keys.flatMap((first) => keys.map((second) => ({ first, second }))))(
    "rejects duplicate owned key forms $first / $second in both directions",
    ({ first, second }) => {
      const original = document(`${first}: true\nmetadata:\n  note: Keep\n${second}: false`);
      for (const enabled of [true, false]) {
        expect(() => setModelInvocation(original, enabled)).toThrow("duplicate");
      }
    },
  );

  it("rejects duplicate owned keys before considering an invalid value", () => {
    const original = document(`${KEY}: yes\n'${KEY}': false`);
    for (const enabled of [true, false]) {
      expect(() => setModelInvocation(original, enabled)).toThrow("duplicate");
    }
  });

  it.each(
    keys.flatMap((key) =>
      [
        "",
        "# Comment only",
        '"true"',
        "'false'",
        "yes",
        "Yes",
        "YES",
        "no",
        "on",
        "off",
        "null",
        "Null",
        "NULL",
        "~",
        "0",
        "1",
        "-1",
        "1.0",
        "tRuE",
        "fAlSe",
        "true#not-a-comment",
        "false#not-a-comment",
        "true false",
        "[true]",
        "{value: false}",
        "&flag true",
        "*flag",
        "!!bool true",
        "!custom false",
        "|\n  true",
        ">-\n  false",
        "\n  - true",
        "\n  nested: false",
        "'true\n  false'",
      ].map((value) => ({ key, value })),
    ),
  )("rejects non-simple boolean $key: $value in both directions", ({ key, value }) => {
    const original = document(`${key}: ${value}`);
    for (const enabled of [true, false]) {
      expect(() => setModelInvocation(original, enabled)).toThrow("simple boolean");
    }
  });

  it.each([
    ["", "empty"],
    ["\ufeff", "must begin"],
    ["description: No delimiters", "must begin"],
    ["\n---\ndescription: Leading blank\n---", "must begin"],
    [" ---\ndescription: Indented opening\n---", "must begin"],
    ["--- \ndescription: Trailing space\n---", "must begin"],
    ["--- # Comment\ndescription: Commented opening\n---", "must begin"],
    ["---yaml\ndescription: Unsupported opening\n---", "must begin"],
    ["...\ndescription: Unsupported opening\n---", "must begin"],
    ["---", "no closing"],
    ["---\n", "no closing"],
    ["---\ndescription: Missing closing", "no closing"],
    ["---\ndescription: Unsupported closing\n...", "no closing"],
    ["---\ndescription: Indented closing\n ---", "no closing"],
    ["---\ndescription: Trailing space\n--- ", "no closing"],
    ["---\ndescription: Commented closing\n--- # Comment", "no closing"],
    ["---\ndescription: Unsupported closing\n----", "no closing"],
  ])("rejects missing or unsupported delimiters in %j", (original, error) => {
    for (const enabled of [true, false]) {
      expect(() => setModelInvocation(original, enabled)).toThrow(error);
    }
  });
});
