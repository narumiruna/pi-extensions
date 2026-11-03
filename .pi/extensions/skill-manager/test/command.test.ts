import { describe, expect, it } from "vitest";
import { argumentCompletions, parseCommand } from "../command.ts";

describe("skills command grammar", () => {
  it.each([
    ["", { kind: "main" }],
    ["  ", { kind: "main" }],
    ["add", { kind: "add" }],
    ["remove", { kind: "remove" }],
    ["move", { kind: "move" }],
    [" add narumiruna/skills ", { kind: "add", repository: "narumiruna/skills" }],
    ["add https://github.com/narumiruna/skills", { kind: "add", repository: "narumiruna/skills" }],
  ])("parses %s", (input, route) => {
    expect(parseCommand(input as string)).toEqual(route);
  });
  it.each([
    "list",
    "help extra",
    "remove foo",
    "move foo",
    "add a/b extra",
    "add https://evil.test/a/b",
    "add ../x",
    "add a/b/c",
  ])("rejects unsupported or ambiguous input %s", (input) => {
    expect(() => parseCommand(input)).toThrow();
  });
  it("completes only public routes", () => {
    expect(argumentCompletions("")).toEqual(["add", "remove", "move"].map((value) => ({ value, label: value })));
    expect(argumentCompletions("mo")).toEqual([{ value: "move", label: "move" }]);
    expect(argumentCompletions("add ")).toBeNull();
    expect(argumentCompletions("remove name")).toBeNull();
  });
});
