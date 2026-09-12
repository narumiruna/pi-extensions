import assert from "node:assert/strict";
import { test } from "vitest";
import { completeGoalArguments, isRemovedQueueCommand, parseCommand } from "../src/command.js";

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
  ]) {
    assert.equal(isRemovedQueueCommand(input), true);
  }
  for (const input of ["", "edit add docs", "status", "--tokens 10k add docs", "address docs"]) {
    assert.equal(isRemovedQueueCommand(input), false);
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
