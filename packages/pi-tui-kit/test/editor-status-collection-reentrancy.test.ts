import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createEditorStatusCollection,
  type EditorStatusCollection,
  type EditorStatusCollectionInput,
} from "../src/editor-status-collection.js";

const input = (id: string) => ({ id, value: id, revision: id });

test("disposal from measurement cannot resurrect a disposed collection", () => {
  let collection: EditorStatusCollection<string>;
  collection = createEditorStatusCollection({
    maxItems: 2,
    maxContentSize: 10,
    measure(value: string) {
      if (value === "dispose") collection.dispose();
      return value.length;
    },
  });
  collection.replace([input("old")]);
  assert.throws(() => collection.replace([input("dispose")]), /disposed/u);
  assert.deepEqual(collection.snapshot(), []);
  assert.throws(() => collection.replace([input("later")]), /disposed/u);
});

test("measurement cannot extend the validated array capacity or change captured input fields", () => {
  const items: EditorStatusCollectionInput<string>[] = [input("first")];
  const collection = createEditorStatusCollection({
    maxItems: 1,
    maxContentSize: 10,
    measure(value: string) {
      items.push(input("second"));
      items[0] = input("replacement");
      return value.length;
    },
  });
  collection.replace(items);
  assert.deepEqual(collection.snapshot(), [{ id: "first", value: "first", mode: "expanded" }]);
});

test("custom array iteration cannot bypass the indexed capacity", () => {
  const items = [input("one")];
  items[Symbol.iterator] = () => [input("one"), input("two")].values();
  const collection = createEditorStatusCollection({
    maxItems: 1,
    maxContentSize: 10,
    measure: (value: string) => value.length,
  });
  collection.replace(items);
  assert.deepEqual(
    collection.snapshot().map(({ id }) => id),
    ["one"],
  );
});

test("measurement cannot partially mutate old items or start a nested replacement", () => {
  let reenter = false;
  let collection: EditorStatusCollection<string>;
  let handle: ReturnType<EditorStatusCollection<string>["item"]>;
  collection = createEditorStatusCollection({
    maxItems: 2,
    maxContentSize: 10,
    measure(value: string) {
      if (reenter) {
        assert.equal(handle?.remove(), false);
        assert.equal(handle?.compact(), false);
        assert.throws(() => collection.replace([input("nested")]), /already active/u);
        throw new Error("measurement failed");
      }
      return value.length;
    },
  });
  collection.replace([input("old")]);
  handle = collection.item("old");
  reenter = true;
  assert.throws(() => collection.replace([input("next")]), /measurement failed/u);
  assert.deepEqual(collection.snapshot(), [{ id: "old", value: "old", mode: "expanded" }]);
  assert.equal(handle?.compact(), true, "failure releases the reentrancy guard");
  reenter = false;
  collection.replace([input("next")]);
  assert.deepEqual(
    collection.snapshot().map(({ id }) => id),
    ["next"],
  );
});
