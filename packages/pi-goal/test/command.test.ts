import assert from "node:assert/strict";
import { test } from "vitest";
import { completeGoalArguments, isRemovedQueueCommand, parseCommand } from "../src/command.js";

const structuredObjective = [
  `Don't  remove the "foo" value.`,
  "",
  "1. Check the list.",
  String.raw`  {"suffix": "Acceptance for \"algo cracked\""}`,
  "\t- Keep this indentation and --tokens 5k as text.",
].join("\r\n");

test.each([
  { prefix: "", kind: "start", tokenBudget: undefined },
  { prefix: "--tokens\t1.5k\n", kind: "start", tokenBudget: 1500 },
  { prefix: "edit\n", kind: "edit", tokenBudget: undefined },
  { prefix: "edit\t--tokens\n2m\n", kind: "edit", tokenBudget: 2_000_000 },
])("$kind preserves objective text after '$prefix'", ({ prefix, kind, tokenBudget }) => {
  assert.deepEqual(parseCommand(`  ${prefix} ${structuredObjective} \n`), {
    kind,
    objective: structuredObjective,
    tokenBudget,
  });
});

test.each(['"pause"', "'edit' the file", '"--tokens"', "edit: revise the scope", "--tokens-later 1k"])(
  "treats %s as literal objective text",
  (objective) => {
    assert.deepEqual(parseCommand(objective), { kind: "start", objective, tokenBudget: undefined });
  },
);

test.each([
  { args: "  \n", kind: "show" },
  { args: "\tstatus \n", kind: "show" },
  { args: " pause\n", kind: "pause" },
  { args: "resume", kind: "resume" },
  { args: "clear", kind: "clear" },
  { args: "stop", kind: "clear" },
])("keeps the management route '$args'", ({ args, kind }) => {
  assert.deepEqual(parseCommand(args), { kind });
});

test.each([
  ["status extra", "Usage: /goal status"],
  ["pause extra", "Usage: /goal pause"],
  ['pause ""', "Usage: /goal pause"],
  ["resume extra", "Usage: /goal resume"],
  ["clear extra", "Usage: /goal clear"],
  ["stop extra", "Usage: /goal clear"],
  ["edit", "Usage: /goal edit <goal_to_complete>"],
  ["--tokens", "Usage: /goal --tokens 100k <goal_to_complete>"],
  ["edit --tokens", "Usage: /goal edit --tokens 100k <goal_to_complete>"],
  ["--tokens 1k", "Usage: /goal <goal_to_complete>"],
  ["edit --tokens 1k", "Usage: /goal edit <goal_to_complete>"],
  ["--tokens 0 test", "Invalid token budget: 0"],
  ['--tokens "1k" test', 'Invalid token budget: "1k"'],
  ["edit --tokens nope test", "Invalid token budget: nope"],
])("rejects malformed command '%s'", (args, expected) => {
  assert.equal(parseCommand(args), expected);
});

test("command parsing keeps removed queue words inside ordinary objectives", () => {
  for (const objective of [
    "add docs",
    "prioritize outage",
    "drop-last",
    "skip",
    "push docs",
    "unshift outage",
    "pop",
    "shift",
  ]) {
    assert.deepEqual(parseCommand(objective), {
      kind: "start",
      objective,
      tokenBudget: undefined,
    });
  }

  const completions = completeGoalArguments("") ?? [];
  for (const label of ["add", "prioritize", "drop-last", "skip", "push", "unshift", "pop", "shift"]) {
    assert.equal(
      completions.some((completion) => completion.label === label),
      false,
    );
  }
});

test("removed queue command detector recognizes legacy command words", () => {
  for (const input of [
    "add docs",
    "prioritize outage",
    "drop-last",
    "skip",
    "push docs",
    "unshift outage",
    "pop",
    "shift",
    ' \t skip\n"this step" ',
  ]) {
    assert.equal(isRemovedQueueCommand(input), true, input);
  }
  for (const input of [
    "",
    "edit add docs",
    "status",
    "--tokens 10k add docs",
    "address docs",
    '"skip" this step',
    "'skip' this step",
    's"k"ip this step',
    '"" skip this step',
    "skip: this step",
  ]) {
    assert.equal(isRemovedQueueCommand(input), false, input);
  }
});

test("edit autocomplete exposes token budget for updated objective", () => {
  assert.deepEqual(completeGoalArguments("edit "), [
    {
      value: "edit --tokens ",
      label: "--tokens",
      description: "Set a token budget before the updated goal",
    },
  ]);
});
