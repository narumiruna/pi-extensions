import {
  getKeybindings,
  Input,
  KeybindingsManager,
  ScrollView,
  setKeybindings,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  VStack,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFullscreenHandoff } from "../src/fullscreen-handoff.js";
import { createFullscreenHarness, fullscreenMounted } from "../src/testing/index.js";

const cleanups: (() => void | Promise<void>)[] = [];
const releases: (() => void)[] = [];

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  releases.push(resolve);
  return { promise, resolve };
}

function fixture(
  mode: "regular" | "fullscreen" = "regular",
  options: { isCurrent?(): boolean; canRestoreParent?(): boolean } = {},
) {
  const harness = createFullscreenHarness(mode);
  const handoff = createFullscreenHandoff<TuiAltScreen>(harness.parent, options);
  const children: TuiAltScreen[] = [];
  const create = vi.fn(() => {
    const child = new TuiAltScreen(harness.terminal);
    children.push(child);
    return child;
  });
  cleanups.push(async () => {
    await handoff.restore().catch(() => undefined);
    for (const child of children) child.stop({ preserveScreen: true });
    harness.dispose();
  });
  return { ...harness, handoff, create };
}

function eventNames(f: ReturnType<typeof fixture>) {
  return f.terminal.events.map((event) => event.name);
}

function expectOutsideInput(f: ReturnType<typeof fixture>) {
  expect(f.terminal.events.filter((event) => event.name === "start" || event.name === "stop")).toEqual(
    expect.arrayContaining([{ name: "start", depth: 0 }]),
  );
  expect(
    f.terminal.events
      .filter((event) => event.name === "start" || event.name === "stop")
      .every((event) => event.depth === 0),
  ).toBe(true);
}

function errorList(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(errorList) : [error];
}

describe("createFullscreenHandoff native terminal ownership", () => {
  it.each(["regular", "fullscreen"] as const)("awaits entry and exit drains with a %s parent", async (mode) => {
    const f = fixture(mode);
    const entry = gate();
    f.terminal.drain = () => entry.promise;
    const entering = f.handoff.enter(f.create);
    await fullscreenMounted();
    expect(eventNames(f)).toEqual(["start", "drain"]);
    expect(f.create).not.toHaveBeenCalled();
    entry.resolve();
    const child = await entering;
    expect(child).toBeInstanceOf(TuiAltScreen);
    expect(eventNames(f)).toEqual(["start", "drain", "stop", "start"]);

    const exit = gate();
    f.terminal.drain = () => exit.promise;
    const restoring = f.handoff.restore();
    await fullscreenMounted();
    expect(eventNames(f)).toEqual(["start", "drain", "stop", "start", "drain"]);
    exit.resolve();
    await restoring;
    expect(eventNames(f)).toEqual(["start", "drain", "stop", "start", "drain", "stop", "start"]);
    expectOutsideInput(f);
  });

  it("defers entry and restore from the active native input callback", async () => {
    const f = fixture();
    let entering: Promise<TuiAltScreen | undefined> | undefined;
    let restoring: Promise<void> | undefined;
    f.parent.addInputListener((data) => {
      if (data !== "open") return;
      entering = f.handoff.enter(f.create);
      expect(eventNames(f)).toEqual(["start"]);
      return { consume: true };
    });
    f.terminal.input("open");
    const child = await entering;
    expect(child).toBeDefined();
    child?.addInputListener((data) => {
      if (data !== "close") return;
      restoring = f.handoff.restore();
      expect(eventNames(f)).toEqual(["start", "drain", "stop", "start"]);
      return { consume: true };
    });
    f.terminal.input("close");
    await restoring;
    expectOutsideInput(f);
  });

  it("defers safely when the terminal has no native drain method", async () => {
    const f = fixture();
    Object.defineProperty(f.terminal, "drainInput", { value: undefined });
    let entering: Promise<TuiAltScreen | undefined> | undefined;
    f.parent.addInputListener(() => {
      entering = f.handoff.enter(f.create);
      return { consume: true };
    });
    f.terminal.input("open");
    const child = await entering;
    let restoring: Promise<void> | undefined;
    child?.addInputListener(() => {
      restoring = f.handoff.restore();
      return { consume: true };
    });
    f.terminal.input("close");
    await restoring;
    expect(eventNames(f)).toEqual(["start", "stop", "start", "stop", "start"]);
    expectOutsideInput(f);
  });

  it("restore before enter permanently cancels the handoff without transferring ownership", async () => {
    const f = fixture();
    await f.handoff.restore();
    await expect(f.handoff.enter(f.create)).resolves.toBeUndefined();
    await f.handoff.restore();
    expect(f.create).not.toHaveBeenCalled();
    expect(eventNames(f)).toEqual(["start"]);
  });

  it("cancels entry synchronously before deferred work starts", async () => {
    const f = fixture();
    const entering = f.handoff.enter(f.create);
    const restoring = f.handoff.restore();
    await expect(entering).resolves.toBeUndefined();
    await restoring;
    expect(f.create).not.toHaveBeenCalled();
    expect(eventNames(f)).toEqual(["start"]);
  });

  it.each(["cancel", "stale"] as const)(
    "joins entry drain after %s and resets parent protocols without creating a child",
    async (reason) => {
      let current = true;
      const f = fixture("regular", { isCurrent: () => current });
      const drain = gate();
      f.terminal.drain = async () => {
        f.terminal.kittyProtocolActive = false;
        await drain.promise;
      };
      const parentStart = f.parent.start.bind(f.parent);
      vi.spyOn(f.parent, "start").mockImplementation(() => {
        f.terminal.kittyProtocolActive = true;
        parentStart();
      });
      const entering = f.handoff.enter(f.create);
      await fullscreenMounted();
      current = reason !== "stale";
      let restored = false;
      const restoring =
        reason === "cancel"
          ? f.handoff.restore().then(() => {
              restored = true;
            })
          : undefined;
      await fullscreenMounted();
      expect(restored).toBe(false);
      expect(eventNames(f)).toEqual(["start", "drain"]);
      drain.resolve();
      await expect(entering).resolves.toBeUndefined();
      await restoring;
      await f.handoff.restore();
      expect(f.create).not.toHaveBeenCalled();
      expect(eventNames(f)).toEqual(["start", "drain", "stop", "start"]);
      expect(f.terminal.kittyProtocolActive).toBe(true);
    },
  );

  it("does not drain or create when ownership is stale before entry", async () => {
    const f = fixture("regular", { isCurrent: () => false });
    await expect(f.handoff.enter(f.create)).resolves.toBeUndefined();
    await f.handoff.restore();
    expect(eventNames(f)).toEqual(["start"]);
    expect(f.create).not.toHaveBeenCalled();
  });

  it("does not restart a parent that loses terminal ownership during exit drain", async () => {
    let allowed = true;
    const f = fixture("regular", { canRestoreParent: () => allowed });
    await f.handoff.enter(f.create);
    const drain = gate();
    f.terminal.drain = () => drain.promise;
    const restoring = f.handoff.restore();
    await fullscreenMounted();
    allowed = false;
    drain.resolve();
    await restoring;
    expect(eventNames(f)).toEqual(["start", "drain", "stop", "start", "drain", "stop"]);
    expect(f.terminal.onInput).toBeUndefined();
  });

  it("does not restart the parent after pending entry loses terminal ownership", async () => {
    let allowed = true;
    const f = fixture("regular", { canRestoreParent: () => allowed });
    const drain = gate();
    f.terminal.drain = () => drain.promise;
    const entering = f.handoff.enter(f.create);
    await fullscreenMounted();
    const restoring = f.handoff.restore();
    allowed = false;
    drain.resolve();
    await expect(entering).resolves.toBeUndefined();
    await restoring;
    expect(eventNames(f)).toEqual(["start", "drain", "stop"]);
    expect(f.terminal.onInput).toBeUndefined();
  });

  it.each(["parent-stop", "factory", "child-start"] as const)(
    "rechecks cancellation after reentrant %s",
    async (stage) => {
      const f = fixture();
      let restoring: Promise<void> | undefined;
      if (stage === "parent-stop") {
        const stop = f.parent.stop.bind(f.parent);
        vi.spyOn(f.parent, "stop").mockImplementation((options) => {
          stop(options);
          restoring = f.handoff.restore();
        });
      }
      const create = vi.fn(() => {
        const child = f.create();
        if (stage === "factory") restoring = f.handoff.restore();
        if (stage === "child-start") {
          const start = child.start.bind(child);
          vi.spyOn(child, "start").mockImplementation(() => {
            start();
            restoring = f.handoff.restore();
          });
        }
        return child;
      });
      await expect(f.handoff.enter(create)).resolves.toBeUndefined();
      await restoring;
      if (stage === "parent-stop") expect(create).not.toHaveBeenCalled();
      expect(f.terminal.onInput).toBeDefined();
      expectOutsideInput(f);
    },
  );

  it("restores a live parent when the session becomes stale inside the factory", async () => {
    let current = true;
    const f = fixture("regular", { isCurrent: () => current, canRestoreParent: () => true });
    const create = () => {
      const child = f.create();
      current = false;
      return child;
    };
    await expect(f.handoff.enter(create)).resolves.toBeUndefined();
    await f.handoff.restore();
    expect(eventNames(f).at(-1)).toBe("start");
    expect(f.terminal.onInput).toBeDefined();
  });

  it.each(["before", "after"] as const)("restores after a parent stop failure %s the native stop", async (when) => {
    const f = fixture();
    const failure = new Error("parent stop failed");
    const stop = f.parent.stop.bind(f.parent);
    vi.spyOn(f.parent, "stop").mockImplementation((options) => {
      if (when === "after") stop(options);
      throw failure;
    });
    await expect(f.handoff.enter(f.create)).rejects.toBe(failure);
    expect(f.create).not.toHaveBeenCalled();
    expect(eventNames(f).at(-1)).toBe("start");
    expect(f.terminal.onInput).toBeDefined();
    const events = [...f.terminal.events];
    await f.handoff.restore().catch(() => undefined);
    expect(f.terminal.events).toEqual(events);
  });

  it("joins a canceled entry drain before its native finally restores the saved input callback", async () => {
    const f = fixture();
    const drain = gate();
    f.terminal.drain = async () => {
      const savedInput = f.terminal.onInput;
      try {
        await drain.promise;
      } finally {
        f.terminal.onInput = savedInput;
      }
    };
    const entering = f.handoff.enter(f.create);
    await fullscreenMounted();
    const restoring = f.handoff.restore();
    drain.resolve();
    await expect(entering).resolves.toBeUndefined();
    await restoring;
    const input = new Input();
    f.parent.addChild(input);
    f.parent.setFocus(input);
    f.terminal.input("first");
    expect(input.getValue()).toBe("first");
    expect(f.create).not.toHaveBeenCalled();
    expect(eventNames(f)).toEqual(["start", "drain", "stop", "start"]);
  });

  it("preserves an entry drain rejection and restores keyboard protocols", async () => {
    const f = fixture();
    const failure = new Error("entry drain failed");
    f.terminal.drain = async () => {
      throw failure;
    };
    await expect(f.handoff.enter(f.create)).rejects.toBe(failure);
    expect(f.create).not.toHaveBeenCalled();
    expect(eventNames(f)).toEqual(["start", "drain", "stop", "start"]);
    await f.handoff.restore().catch(() => undefined);
    expect(eventNames(f)).toEqual(["start", "drain", "stop", "start"]);
  });

  it.each(["factory", "start-before", "start-after"] as const)(
    "auto-restores after partial %s failure",
    async (stage) => {
      const f = fixture();
      const failure = new Error(stage);
      let stop: ReturnType<typeof vi.spyOn> | undefined;
      const create = () => {
        if (stage === "factory") throw failure;
        const child = f.create();
        stop = vi.spyOn(child, "stop");
        const start = child.start.bind(child);
        vi.spyOn(child, "start").mockImplementation(() => {
          if (stage === "start-after") start();
          throw failure;
        });
        return child;
      };
      await expect(f.handoff.enter(create)).rejects.toBe(failure);
      if (stop) expect(stop).toHaveBeenCalledTimes(1);
      expect(f.terminal.onInput).toBeDefined();
      expect(eventNames(f).at(-1)).toBe("start");
      const events = [...f.terminal.events];
      await f.handoff.restore().catch(() => undefined);
      expect(f.terminal.events).toEqual(events);
    },
  );

  it("continues cleanup after child drain and stop failures and aggregates both errors", async () => {
    const f = fixture();
    const child = await f.handoff.enter(f.create);
    if (!child) throw new Error("Expected child");
    const drainFailure = new Error("exit drain failed");
    const stopFailure = new Error("child stop failed");
    f.terminal.drain = async () => {
      throw drainFailure;
    };
    const stop = child.stop.bind(child);
    const stopSpy = vi.spyOn(child, "stop").mockImplementation((options) => {
      stop(options);
      throw stopFailure;
    });
    const error = await f.handoff.restore().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect(errorList(error)).toEqual(expect.arrayContaining([drainFailure, stopFailure]));
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(f.terminal.onInput).toBeDefined();
    const events = [...f.terminal.events];
    await f.handoff.restore().catch(() => undefined);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(f.terminal.events).toEqual(events);
  });

  it.each(["child-drain", "child-stop", "parent-start", "parent-render"] as const)(
    "preserves a single %s cleanup failure and does not repeat cleanup",
    async (stage) => {
      const f = fixture();
      const child = await f.handoff.enter(f.create);
      if (!child) throw new Error("Expected child");
      const failure = new Error(stage);
      const originalStop = child.stop.bind(child);
      const stop = vi.spyOn(child, "stop");
      if (stage === "child-drain")
        f.terminal.drain = async () => {
          throw failure;
        };
      if (stage === "child-stop") {
        stop.mockImplementation((options) => {
          originalStop(options);
          throw failure;
        });
      }
      if (stage === "parent-start")
        vi.spyOn(f.parent, "start").mockImplementation(() => {
          throw failure;
        });
      if (stage === "parent-render")
        vi.spyOn(f.parent, "renderNow").mockImplementation(() => {
          throw failure;
        });
      await expect(f.handoff.restore()).rejects.toBe(failure);
      expect(stop).toHaveBeenCalledTimes(1);
      const events = [...f.terminal.events];
      await f.handoff.restore().catch(() => undefined);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(f.terminal.events).toEqual(events);
    },
  );

  it.each(["child-stop", "overlay-hide"] as const)(
    "rechecks parent ownership after reentrant %s cleanup",
    async (stage) => {
      let allowed = true;
      const f = fixture("regular", { canRestoreParent: () => allowed });
      const owned = f.parent.showOverlay({ render: () => ["owned"], invalidate() {} });
      f.handoff.setOverlayHandle(owned);
      const child = await f.handoff.enter(f.create);
      if (!child) throw new Error("Expected child");
      if (stage === "child-stop") {
        const stop = child.stop.bind(child);
        vi.spyOn(child, "stop").mockImplementation((options) => {
          stop(options);
          allowed = false;
        });
      } else {
        const hide = owned.setHidden.bind(owned);
        vi.spyOn(owned, "setHidden").mockImplementation((hidden) => {
          hide(hidden);
          allowed = false;
        });
      }
      await f.handoff.restore();
      expect(owned.isHidden()).toBe(true);
      expect(eventNames(f)).toEqual(["start", "drain", "stop", "start", "drain", "stop"]);
      expect(f.terminal.onInput).toBeUndefined();
      owned.hide();
    },
  );

  it("preserves the original entry failure together with parent restoration failure", async () => {
    const f = fixture();
    const entryFailure = new Error("factory failed");
    const restoreFailure = new Error("parent restart failed");
    vi.spyOn(f.parent, "start").mockImplementation(() => {
      throw restoreFailure;
    });
    const error = await f.handoff
      .enter(() => {
        throw entryFailure;
      })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect(errorList(error)).toEqual(expect.arrayContaining([entryFailure, restoreFailure]));
  });

  it("hides only the owned overlay, continues after its failure, and leaves unrelated overlays active", async () => {
    const f = fixture("fullscreen");
    const unrelatedInput = vi.fn();
    const unrelated = f.parent.showOverlay({
      render: () => ["unrelated"],
      invalidate() {},
      handleInput: unrelatedInput,
    });
    const owned = f.parent.showOverlay({ render: () => ["owned"], invalidate() {} });
    f.handoff.setOverlayHandle(owned);
    const unrelatedHide = vi.spyOn(unrelated, "setHidden");
    const ownedHide = vi.spyOn(owned, "hide");
    const setHidden = owned.setHidden.bind(owned);
    const failure = new Error("overlay hide failed");
    const ownedHidden = vi.spyOn(owned, "setHidden").mockImplementation((hidden) => {
      setHidden(hidden);
      throw failure;
    });
    await f.handoff.enter(f.create);
    await expect(f.handoff.restore()).rejects.toBe(failure);
    expect(ownedHidden).toHaveBeenCalledWith(true);
    expect(ownedHide).not.toHaveBeenCalled();
    expect(unrelatedHide).not.toHaveBeenCalled();
    expect(unrelated.isHidden()).toBe(false);
    f.terminal.input("z");
    expect(unrelatedInput).toHaveBeenCalledWith("z");
    unrelated.hide();
    owned.hide();
  });

  it("hides an owned handle supplied after restore without removing an unrelated overlay", async () => {
    const f = fixture();
    await f.handoff.restore();
    const unrelated = f.parent.showOverlay({ render: () => ["other"], invalidate() {} });
    const owned = f.parent.showOverlay({ render: () => ["late"], invalidate() {} });
    const hide = vi.spyOn(owned, "hide");
    f.handoff.setOverlayHandle(owned);
    expect(owned.isHidden()).toBe(true);
    expect(hide).not.toHaveBeenCalled();
    expect(unrelated.isHidden()).toBe(false);
    owned.hide();
    unrelated.hide();
  });

  it("reuses one entry, restores once, and never reenters a restored handoff", async () => {
    const f = fixture();
    const [first, second] = await Promise.all([f.handoff.enter(f.create), f.handoff.enter(f.create)]);
    expect(first).toBe(second);
    expect(f.create).toHaveBeenCalledTimes(1);
    await expect(f.handoff.enter(f.create)).resolves.toBe(first);
    await Promise.all([f.handoff.restore(), f.handoff.restore()]);
    const events = [...f.terminal.events];
    await f.handoff.restore();
    await expect(f.handoff.enter(f.create)).resolves.toBeUndefined();
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.terminal.events).toEqual(events);
  });

  it.each([false, true])(
    "routes the first separate restored keyboard and viewport packets through native dispatch (remapped=%s)",
    async (remapped) => {
      const previousKeys = getKeybindings();
      const keys = new KeybindingsManager(TUI_KEYBINDINGS, remapped ? { "tui.altScreen.pageUp": ["ctrl+u"] } : {});
      setKeybindings(keys);
      cleanups.push(() => setKeybindings(previousKeys));
      const f = fixture("fullscreen");
      const parent = f.parent as TuiAltScreen;
      const input = new Input();
      input.setValue("draft");
      const scroll = new ScrollView(
        { render: () => Array(100).fill("history"), invalidate() {} },
        { primary: true, follow: "end" },
      );
      parent.setLayoutRoot(new VStack([{ component: scroll, basis: 0, grow: 1, minSize: 1 }, input]));
      parent.setFocus(input);
      parent.renderNow();
      const child = await f.handoff.enter(f.create);
      const childInput = vi.fn();
      child?.addInputListener(childInput);
      await f.handoff.restore();
      f.terminal.input("z");
      expect(input.getValue()).toBe("zdraft");
      parent.renderNow();
      const before = scroll.scrollTop;
      expect(before).toBeGreaterThan(0);
      f.terminal.input(remapped ? "\u0015" : "\u001b[5~");
      expect(scroll.scrollTop).toBeLessThan(before);
      expect(childInput).not.toHaveBeenCalled();
    },
  );
});
