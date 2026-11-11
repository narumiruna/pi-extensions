import assert from "node:assert/strict";
import { StringEnum, validateToolArguments } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { expectTypeOf, test } from "vitest";

const mode = Type.Unsafe<"fast" | "safe">(StringEnum(["fast", "safe"] as const));
const parameters = Type.Object(
  {
    count: Type.Integer({ minimum: 1, maximum: 4 }),
    enabled: Type.Boolean(),
    tags: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 2 }),
    mode,
    optional: Type.Optional(Type.Number()),
    nullable: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  },
  { additionalProperties: false },
);

expectTypeOf<Static<typeof parameters>["mode"]>().toEqualTypeOf<"fast" | "safe">();

const canonical = { count: 2, enabled: true, tags: ["one"], mode: "fast" };
const validCases = [
  { name: "canonical values", input: canonical, expected: canonical },
  {
    name: "numeric, boolean, and single-array coercion",
    input: { ...canonical, count: "3", enabled: "FALSE", tags: "one" },
    expected: { ...canonical, count: 3, enabled: false },
  },
  {
    name: "optional nonnullable null is omitted; nullable null is retained",
    input: { ...canonical, optional: null, nullable: null },
    expected: { ...canonical, nullable: null },
  },
  {
    name: "optional numeric strings",
    input: { ...canonical, optional: "1.5", nullable: "2.5" },
    expected: { ...canonical, optional: 1.5, nullable: 2.5 },
  },
  {
    // Integer truncation was already supported for TypeBox tools before this upgrade.
    name: "existing integer truncation",
    input: { ...canonical, count: "3.5" },
    expected: { ...canonical, count: 3 },
  },
];

const invalidCases = [
  { name: "missing required field", input: { enabled: true, tags: ["one"], mode: "fast" }, path: "count" },
  { name: "invalid number", input: { ...canonical, count: "many" }, path: "count" },
  { name: "invalid boolean", input: { ...canonical, enabled: "maybe" }, path: "enabled" },
  { name: "minimum", input: { ...canonical, count: 0 }, path: "count" },
  { name: "maximum", input: { ...canonical, count: 5 }, path: "count" },
  { name: "empty array", input: { ...canonical, tags: [] }, path: "tags" },
  { name: "array maximum", input: { ...canonical, tags: ["one", "two", "three"] }, path: "tags" },
  { name: "nested constraint", input: { ...canonical, tags: [""] }, path: "tags.0" },
  { name: "enum constraint", input: { ...canonical, mode: "other" }, path: "mode" },
  { name: "closed object", input: { ...canonical, extra: true }, path: "extra" },
];

for (const [name, schema] of [
  ["TypeBox", parameters],
  ["plain JSON Schema", JSON.parse(JSON.stringify(parameters)) as object],
] as const) {
  const tool = { name: "schema_probe", description: "Schema compatibility probe", parameters: schema };
  for (const { name: sample, input, expected } of validCases) {
    test(`${name}: ${sample}`, () => {
      const original = structuredClone(input);
      const validated = validateToolArguments(tool, {
        type: "toolCall",
        id: "schema-call",
        name: tool.name,
        arguments: input,
      });
      assert.deepEqual(validated, expected);
      assert.notEqual(validated, input);
      assert.deepEqual(input, original, "validation must preserve the transcript's raw arguments");
    });
  }
  for (const { name: sample, input, path } of invalidCases) {
    test(`${name}: rejects ${sample}`, () => {
      const original = structuredClone(input);
      assert.throws(
        () =>
          validateToolArguments(tool, {
            type: "toolCall",
            id: "schema-call",
            name: tool.name,
            arguments: input,
          }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Validation failed for tool "schema_probe"/u);
          assert.ok(error.message.includes(`- ${path}:`));
          return true;
        },
      );
      assert.deepEqual(input, original);
    });
  }
}

test("TypeBox enum annotation preserves the provider-visible JSON Schema", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(mode)), { type: "string", enum: ["fast", "safe"] });
});
