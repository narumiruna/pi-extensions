import assert from "node:assert/strict";
import { test } from "vitest";
import { createEditorStatusCollection, type EditorStatusCollectionInput } from "../src/editor-status-collection.js";

function collection(maxItems = 3, maxContentSize = 10) {
  return createEditorStatusCollection<string>({ maxItems, maxContentSize, measure: (value) => value.length });
}

function input(id: string, value = id, revision = "one"): EditorStatusCollectionInput<string> {
  return Object.freeze({ id, value, revision });
}

const invalidSizes = [
  -1,
  0.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
];
for (const size of invalidSizes) {
  for (const field of ["maxItems", "maxContentSize"] as const) {
    test(`rejects invalid ${field}: ${size}`, () => {
      assert.throws(
        () => collection(field === "maxItems" ? size : 3, field === "maxContentSize" ? size : 10),
        RangeError,
      );
    });
  }
}

test("empty snapshots and zero capacities are valid", () => {
  const empty = collection(0, 0);
  empty.replace([]);
  assert.deepEqual(empty.snapshot(), []);
  assert.equal(empty.item("absent"), undefined);
  assert.throws(() => empty.replace([input("a", "")]), RangeError);
  const zeroSize = collection(1, 0);
  zeroSize.replace([input("a", "")]);
  assert.equal(zeroSize.snapshot()[0]?.value, "");
  assert.throws(() => zeroSize.replace([input("a", "x")]), RangeError);
});

test("replacement uses exact caller order without sorting raw IDs", () => {
  const c = collection(5);
  const ids = ["2", "1", "__proto__", "constructor", "\u001b[31mraw"];
  c.replace(ids.map((id) => input(id, "v")));
  assert.deepEqual(
    c.snapshot().map((item) => item.id),
    ids,
  );
  c.item("1")?.compact();
  const reversed = [...ids].reverse();
  c.replace(reversed.map((id) => input(id, "next")));
  assert.deepEqual(
    c.snapshot().map((item) => item.id),
    reversed,
  );
  assert.equal(c.snapshot().find((item) => item.id === "1")?.mode, "compact");
});

test("presentation controls affect only one item and return whether state changed", () => {
  const c = collection();
  c.replace([input("a"), input("b")]);
  const a = c.item("a");
  assert.ok(a);
  assert.equal(a.expand(), false);
  assert.equal(a.compact(), true);
  assert.equal(a.compact(), false);
  assert.deepEqual(
    c.snapshot().map((item) => item.mode),
    ["compact", "expanded"],
  );
  assert.equal(a.expand(), true);
  assert.equal(a.expand(), false);
  assert.equal(a.remove(), true);
  assert.equal(a.remove(), false);
  assert.equal(a.compact(), false);
  assert.equal(a.expand(), false);
  assert.equal(c.item("a"), undefined);
  assert.deepEqual(c.snapshot(), [{ id: "b", value: "b", mode: "expanded" }]);
});

test("same-ID cosmetic replacements preserve modes and existing handles", () => {
  const c = collection();
  c.replace([input("a")]);
  const a = c.item("a");
  assert.ok(a);
  assert.equal(a.compact(), true);
  c.replace([input("a", "cosmetic")]);
  assert.deepEqual(c.snapshot(), [{ id: "a", value: "cosmetic", mode: "compact" }]);
  assert.equal(a.expand(), true);
  assert.equal(c.snapshot()[0]?.mode, "expanded");
});

test("meaningful revisions invalidate old handles but preserve manual mode", () => {
  const c = collection();
  c.replace([input("a")]);
  const old = c.item("a");
  assert.ok(old);
  old.compact();
  c.replace([input("a", "new", "two")]);
  assert.equal(c.snapshot()[0]?.mode, "compact");
  assert.equal(old.expand(), false);
  assert.equal(old.remove(), false);
  assert.equal(old.compact(), false);
  assert.equal(c.item("a")?.expand(), true);
  c.replace([input("a", "again", "one")]);
  assert.equal(old.compact(), false);
  assert.equal(c.snapshot()[0]?.mode, "expanded");
});

test("removed items stay hidden across refreshes and revisions until authoritative absence", () => {
  const c = collection();
  c.replace([input("a"), input("b")]);
  const old = c.item("a");
  assert.ok(old);
  old.remove();
  for (const revision of ["one", "two", "three"]) {
    c.replace([input("a", "updated", revision), input("b")]);
    assert.deepEqual(
      c.snapshot().map((item) => item.id),
      ["b"],
    );
    assert.equal(c.item("a"), undefined);
  }
  c.replace([input("b")]);
  c.replace([input("a"), input("b")]);
  assert.equal(old.compact(), false);
  assert.equal(old.expand(), false);
  assert.equal(old.remove(), false);
  assert.equal(c.item("a")?.compact(), true);
});

test("absence then ID reuse creates a new expanded incarnation even at the same revision", () => {
  const c = collection();
  c.replace([input("a")]);
  const old = c.item("a");
  assert.ok(old);
  old.compact();
  c.replace([]);
  assert.deepEqual(c.snapshot(), []);
  c.replace([input("a")]);
  assert.equal(c.snapshot()[0]?.mode, "expanded");
  assert.equal(old.compact(), false);
  assert.equal(old.expand(), false);
  assert.equal(old.remove(), false);
  assert.equal(c.item("a")?.remove(), true);
});

test("removed entries count against capacity and cannot cause silent eviction", () => {
  const c = collection(1);
  c.replace([input("a")]);
  c.item("a")?.remove();
  assert.throws(() => c.replace([input("a"), input("b")]), RangeError);
  assert.deepEqual(c.snapshot(), []);
  c.replace([input("b")]);
  assert.deepEqual(
    c.snapshot().map((item) => item.id),
    ["b"],
  );
  c.replace([input("a")]);
  assert.deepEqual(
    c.snapshot().map((item) => item.id),
    ["a"],
  );
});

test("historical removal does not accumulate across bounded authoritative replacements", () => {
  const c = collection(1);
  for (let i = 0; i < 100; i++) {
    c.replace([input(String(i))]);
    assert.equal(c.item(String(i))?.remove(), true);
  }
  c.replace([input("0")]);
  assert.deepEqual(c.snapshot(), [{ id: "0", value: "0", mode: "expanded" }]);
});

const invalidInputs: [string, readonly EditorStatusCollectionInput<string>[]][] = [
  ["capacity", [input("a"), input("b"), input("c"), input("d")]],
  ["duplicates", [input("a", "changed", "two"), input("a")]],
  ["empty ID", [input("a", "changed", "two"), input("")]],
  ["oversized content", [input("a", "changed", "two"), input("b", "x".repeat(11))]],
  [
    "nonstring ID",
    [input("a"), { id: 3, value: "b", revision: "one" } as unknown as EditorStatusCollectionInput<string>],
  ],
  [
    "nonstring revision",
    [input("a"), { id: "b", value: "b", revision: 3 } as unknown as EditorStatusCollectionInput<string>],
  ],
  ["null entry", [input("a"), null as unknown as EditorStatusCollectionInput<string>]],
  ["not an array", {} as readonly EditorStatusCollectionInput<string>[]],
];
for (const [label, items] of invalidInputs) {
  test(`invalid ${label} rejects atomically and preserves modes, tombstones, and handles`, () => {
    const c = collection();
    c.replace([input("a"), input("hidden")]);
    const a = c.item("a");
    assert.ok(a);
    a.compact();
    c.item("hidden")?.remove();
    const before = c.snapshot();
    assert.throws(() => c.replace(items), RangeError);
    assert.deepEqual(c.snapshot(), before);
    assert.equal(a.expand(), true);
    c.replace([input("a"), input("hidden")]);
    assert.deepEqual(
      c.snapshot().map((item) => item.id),
      ["a"],
    );
  });
}

for (const size of invalidSizes) {
  test(`invalid measured size ${size} rejects atomically`, () => {
    let bad = false;
    const c = createEditorStatusCollection<string>({
      maxItems: 2,
      maxContentSize: 10,
      measure: (value) => (bad && value === "bad" ? size : value.length),
    });
    c.replace([input("a")]);
    const a = c.item("a");
    bad = true;
    assert.throws(() => c.replace([input("a", "new", "two"), input("b", "bad")]), RangeError);
    assert.deepEqual(c.snapshot(), [{ id: "a", value: "a", mode: "expanded" }]);
    assert.equal(a?.compact(), true);
  });
}

test("content limit is per item, with an additional safe-integer aggregate check", () => {
  const c = collection(2, 3);
  c.replace([input("a", "123"), input("b", "456")]);
  assert.equal(c.snapshot().length, 2);
  const large = createEditorStatusCollection<number>({
    maxItems: 2,
    maxContentSize: Number.MAX_SAFE_INTEGER,
    measure: (value) => value,
  });
  large.replace([{ id: "a", value: Number.MAX_SAFE_INTEGER, revision: "one" }]);
  assert.throws(
    () =>
      large.replace([
        { id: "a", value: Number.MAX_SAFE_INTEGER, revision: "one" },
        { id: "b", value: 1, revision: "one" },
      ]),
    RangeError,
  );
  assert.equal(large.snapshot().length, 1);
});

test("a throwing measurement never publishes a partial replacement", () => {
  const c = createEditorStatusCollection<string>({
    maxItems: 2,
    maxContentSize: 10,
    measure(value) {
      if (value === "throw") throw new Error("measurement failed");
      return value.length;
    },
  });
  c.replace([input("a")]);
  assert.throws(() => c.replace([input("b"), input("c", "throw")]), /measurement failed/);
  assert.deepEqual(c.snapshot(), [{ id: "a", value: "a", mode: "expanded" }]);
});

test("snapshots copy and freeze presentation metadata while retaining immutable owner values", () => {
  const value = Object.freeze({ title: "owner data" });
  const c = createEditorStatusCollection<typeof value>({
    maxItems: 1,
    maxContentSize: 10,
    measure: () => 1,
  });
  const items = [{ id: "a", value, revision: "one" }];
  c.replace(items);
  const before = c.snapshot();
  assert.equal(before[0]?.value, value);
  assert.equal(Object.isFrozen(before), true);
  assert.equal(Object.isFrozen(before[0]), true);
  items.length = 0;
  c.item("a")?.compact();
  assert.equal(before[0]?.mode, "expanded");
  assert.equal(c.snapshot()[0]?.mode, "compact");
  c.replace([]);
  assert.equal(before[0]?.value, value);
});

test("raw IDs with equal display labels remain distinct", () => {
  const c = collection();
  const ids = ["label", "\u001b[31mlabel", " "];
  c.replace(ids.map((id) => input(id, "v")));
  c.item(ids[1] ?? "")?.remove();
  assert.deepEqual(
    c.snapshot().map((item) => item.id),
    ["label", " "],
  );
});

test("independent collections cannot control each other's same-ID items", () => {
  const a = collection();
  const b = collection();
  a.replace([input("same")]);
  b.replace([input("same")]);
  a.item("same")?.remove();
  assert.equal(b.snapshot().length, 1);
  a.dispose();
  assert.equal(b.item("same")?.compact(), true);
});

test("dispose clears snapshots, invalidates handles, and rejects replacement", () => {
  const c = collection();
  c.replace([input("a")]);
  const a = c.item("a");
  c.dispose();
  c.dispose();
  assert.deepEqual(c.snapshot(), []);
  assert.equal(c.item("a"), undefined);
  assert.equal(a?.compact(), false);
  assert.equal(a?.expand(), false);
  assert.equal(a?.remove(), false);
  assert.throws(() => c.replace([input("a")]), /disposed/);
});
