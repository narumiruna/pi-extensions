import { setKittyProtocolActive } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { plain, setup } from "./picker-fixture.js";

const hidden = { path: "/outside/hidden", canonical: "/outside/hidden" };
const files = ["/cwd/match/a", "/cwd/match/b", "/cwd/match/c"];
const movements = [
  { key: "Shift+Tab", data: "\x1b[Z", index: 0, next: 0 },
  { key: "Shift+Tab", data: "\x1b[Z", index: 1, next: 0 },
  { key: "Shift+Tab", data: "\x1b[Z", index: 2, next: 1 },
  { key: "Tab", data: "\t", index: 0, next: 1 },
  { key: "Tab", data: "\t", index: 1, next: 2 },
  { key: "Tab", data: "\t", index: 2, next: 2 },
];

test.each(movements.flatMap((movement) => [false, true].map((checked) => ({ ...movement, checked }))))(
  "$key bounds filtered marking at index $index (checked=$checked)",
  async ({ data, index, next, checked }) => {
    const targets = [hidden, ...(checked ? files.map((path) => ({ path, canonical: path })) : [])];
    const originalTargets = targets.map((target) => ({ ...target }));
    const { tui, running, validate, options } = setup({ targets, discover: async () => files });
    try {
      await tui.waitForOpen();
      await tui.waitForPending();
      tui.type("match");
      for (let step = 0; step < index; step++) tui.press("tui.select.down");
      tui.send(data);
      const selected = checked ? files.filter((_, candidate) => candidate !== index) : [files[index]];
      const text = plain(tui.render());
      expect(text).toContain(`→ [${selected.includes(files[next]) ? "x" : " "}] ${files[next].slice(5)}`);
      expect(text).toContain(`[${checked ? " " : "x"}] ${files[index].slice(5)}`);
      expect(text).toContain(`${selected.length + 1} selected`);
      expect(text).toContain("> match");
      expect(text).not.toContain("(outside)");
      expect(validate).not.toHaveBeenCalled();
      expect(options.targets).toEqual(originalTargets);
      tui.press("tui.select.confirm");
      await running;
      expect(validate).toHaveBeenCalledExactlyOnceWith([hidden.path, ...selected], expect.any(AbortSignal), []);
    } finally {
      tui.send("\x03");
      await running;
    }
  },
);

test.each(
  [1, 3].flatMap((size) => [
    { size, key: "Shift+Tab", data: "\x1b[Z", index: 0 },
    { size, key: "Tab", data: "\t", index: size - 1 },
  ]),
)("repeated $key toggles only the boundary file ($size results)", async ({ size, data, index }) => {
  const inventory = files.slice(0, size);
  const { tui, running, validate } = setup({ targets: [hidden], discover: async () => inventory });
  try {
    await tui.waitForOpen();
    await tui.waitForPending();
    tui.type("match");
    for (let step = 0; step < index; step++) tui.press("tui.select.down");
    for (const checked of [true, false, true]) {
      tui.send(data);
      const text = plain(tui.render());
      expect(text).toContain(`→ [${checked ? "x" : " "}] ${inventory[index].slice(5)}`);
      expect(text).toContain(`${checked ? 2 : 1} selected`);
      expect(text).toContain("> match");
    }
    tui.press("tui.select.confirm");
    await running;
    expect(validate).toHaveBeenCalledExactlyOnceWith([hidden.path, inventory[index]], expect.any(AbortSignal), []);
  } finally {
    tui.send("\x03");
    await running;
  }
});

test.each([{ inventory: [] }, { inventory: files }])(
  "marking with no matching result preserves hidden checks ($inventory)",
  async ({ inventory }) => {
    const { tui, running, validate } = setup({ targets: [hidden], discover: async () => inventory });
    try {
      await tui.waitForOpen();
      await tui.waitForPending();
      tui.type("no-matches");
      tui.send("\x1b[Z");
      tui.send("\t");
      const text = plain(tui.render());
      expect(text).toContain("No matching files");
      expect(text).toContain("1 selected");
      expect(text).not.toMatch(/→ \[[x ]\]/u);
      expect(validate).not.toHaveBeenCalled();
      tui.press("tui.select.confirm");
      await running;
      expect(validate).toHaveBeenCalledExactlyOnceWith([hidden.path], expect.any(AbortSignal), []);
    } finally {
      tui.send("\x03");
      await running;
    }
  },
);

const reverseInputs = [false, true].flatMap((kitty) => [
  { protocol: "legacy", data: "\x1b[Z", kitty },
  { protocol: "Kitty", data: "\x1b[9;2u", kitty },
  { protocol: "modifyOtherKeys", data: "\x1b[27;2;9~", kitty },
]);

test.each(reverseInputs)(
  "$protocol reverse marking keeps boundaries with remapped actions (Kitty=$kitty)",
  async ({ data, kitty }) => {
    setKittyProtocolActive(kitty);
    const { tui, running, validate } = setup(
      { targets: [hidden], discover: async () => files },
      { "tui.input.tab": "f2", "tui.select.confirm": "f3", "tui.select.cancel": "q" },
    );
    try {
      await tui.waitForOpen();
      await tui.waitForPending();
      tui.type("match");
      tui.send(data);
      expect(plain(tui.render())).toContain("→ [x] match/a");
      tui.send("\x1bOQ"); // Remapped forward marking unchecks a and moves to b.
      expect(plain(tui.render())).toContain("→ [ ] match/b");
      tui.send(data);
      const text = plain(tui.render());
      expect(text).toContain("→ [ ] match/a");
      expect(text).toContain("[x] match/b");
      expect(text).toContain("2 selected");
      expect(text).toContain("> match");
      expect(validate).not.toHaveBeenCalled();
      tui.send("\x1bOR");
      await running;
      expect(validate).toHaveBeenCalledExactlyOnceWith([hidden.path, files[1]], expect.any(AbortSignal), []);
    } finally {
      tui.send("\x03");
      await running;
    }
  },
);

test.each(reverseInputs)(
  "$protocol native editing still takes priority over reverse marking (Kitty=$kitty)",
  async ({ data, kitty }) => {
    setKittyProtocolActive(kitty);
    const { tui, running, validate } = setup(
      { targets: [hidden], discover: async () => files },
      { "tui.editor.cursorLeft": "shift+tab" },
    );
    try {
      await tui.waitForOpen();
      await tui.waitForPending();
      tui.type("match");
      tui.send(data);
      tui.type("X");
      const text = plain(tui.render());
      expect(text).toContain("> matcXh");
      expect(text).toContain("1 selected");
      expect(text).not.toContain("shift+tab select");
      tui.press("tui.select.confirm");
      await running;
      expect(validate).toHaveBeenCalledExactlyOnceWith([hidden.path], expect.any(AbortSignal), []);
    } finally {
      tui.send("\x03");
      await running;
    }
  },
);

test("arrow wrapping, page boundaries, and zero-movement mouse marking remain separate", async () => {
  const { tui, running, validate } = setup({ discover: async () => files });
  try {
    await tui.waitForOpen();
    await tui.waitForPending();
    tui.press("tui.select.up");
    expect(plain(tui.render())).toContain("→ [ ] match/c");
    tui.press("tui.select.down");
    expect(plain(tui.render())).toContain("→ [ ] match/a");
    tui.press("tui.select.pageDown");
    expect(plain(tui.render())).toContain("→ [ ] match/c");
    tui.press("tui.select.pageUp");
    expect(plain(tui.render())).toContain("→ [ ] match/a");
    expect(plain(tui.render())).toContain("0 selected");
    const row = tui.render().findIndex((line) => line.includes("[ ] match/b"));
    tui.mouse({ type: "press", x: 5, y: row });
    tui.mouse({ type: "click", x: 5, y: row });
    expect(plain(tui.render())).toContain("→ [x] match/b");
    expect(plain(tui.render())).toContain("1 selected");
    expect(validate).not.toHaveBeenCalled();
    tui.press("tui.select.confirm");
    await running;
    expect(validate).toHaveBeenCalledExactlyOnceWith([files[1]], expect.any(AbortSignal), []);
  } finally {
    tui.send("\x03");
    await running;
  }
});
