import {
  type Component,
  getKeybindings,
  isKittyProtocolActive,
  KeybindingsManager,
  ScrollView,
  setKeybindings,
  setKittyProtocolActive,
  TUI_KEYBINDINGS,
  TuiAltScreen,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowOwner } from "../src/command-configuration.js";
import {
  runSettingsChatFullscreen,
  type SettingsChatFullscreenComponent,
  type SettingsChatFullscreenDependencies,
  type SettingsChatFullscreenOptions,
} from "../src/settings-chat-fullscreen.js";
import { createFullscreenHarness, fullscreenMounted } from "./settings-chat-fullscreen-support.js";

const originalKeys = getKeybindings();
const harnesses: ReturnType<typeof createFullscreenHarness>[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) harness.dispose();
  await fullscreenMounted();
  setKeybindings(originalKeys);
  vi.restoreAllMocks();
});

function fixture(mode: "regular" | "fullscreen" = "regular") {
  const harness = createFullscreenHarness(mode);
  harnesses.push(harness);
  const controller = new AbortController();
  const contextController = new AbortController();
  harness.ctx.signal = contextController.signal;
  let session = true;
  const owner: WorkflowOwner = {
    signal: controller.signal,
    isCurrent: () => session && !controller.signal.aborted,
    isSessionCurrent: () => session,
  };
  const history = { render: () => Array.from({ length: 100 }, (_, i) => `history ${i}`), invalidate() {} };
  const scroll = new ScrollView(history, { primary: true, follow: "end" });
  const input = vi.fn();
  const dispose = vi.fn();
  const waitForPending = vi.fn(() => Promise.resolve());
  let options!: SettingsChatFullscreenOptions<string>;
  const create = vi.fn((value: SettingsChatFullscreenOptions<string>): SettingsChatFullscreenComponent => {
    options = value;
    return {
      render: () => [],
      invalidate() {},
      handleInput: input,
      dispose,
      waitForPending,
      getFullscreenLayout: () => scroll,
    };
  });
  const run = (dependencies?: SettingsChatFullscreenDependencies) =>
    runSettingsChatFullscreen(harness.ctx, owner, create, "cancelled", dependencies);
  return {
    ...harness,
    harness,
    controller,
    contextController,
    owner,
    create,
    scroll,
    input,
    dispose,
    waitForPending,
    run,
    get options() {
      return options;
    },
    replaceSession() {
      session = false;
    },
  };
}

function component(): Component {
  return { render: () => ["other"], invalidate() {} };
}

describe("settings chat native fullscreen host", () => {
  it.each(["regular", "fullscreen"] as const)("waits for the %s parent entry drain before transfer", async (mode) => {
    const f = fixture(mode);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const drain = vi.fn(() => gate);
    f.terminal.drain = drain;
    const task = f.run();
    try {
      await fullscreenMounted();
      expect(drain).toHaveBeenCalledOnce();
      expect(f.create).not.toHaveBeenCalled();
      expect(f.terminal.events.map((event) => event.name)).toEqual(["start", "drain"]);
      f.terminal.input("pending parent input");
      expect(f.input).not.toHaveBeenCalled();
      release();
      await fullscreenMounted();
      expect(f.create).toHaveBeenCalledOnce();
      f.terminal.input("child input");
      expect(f.input).toHaveBeenCalledExactlyOnceWith("child input");
      expect(f.terminal.events.every((event) => event.depth === 0)).toBe(true);
    } finally {
      f.terminal.drain = () => Promise.resolve();
      release();
      f.controller.abort();
      await task;
    }
  });

  it.each(["owner", "context", "dispose", "stale", "shutdown"] as const)(
    "joins entry drain on %s cancellation without creating a child",
    async (reason) => {
      const f = fixture();
      const input = vi.fn();
      const editor = { ...component(), handleInput: input };
      f.parent.addChild(editor);
      f.parent.setFocus(editor);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.terminal.drain = () => gate;
      let settled = false;
      const task = f.run().finally(() => {
        settled = true;
      });
      try {
        await fullscreenMounted();
        expect(f.create).not.toHaveBeenCalled();
        if (reason === "owner") f.controller.abort();
        else if (reason === "context") f.contextController.abort();
        else if (reason === "dispose") f.harness.disposeCustom();
        else {
          f.replaceSession();
          if (reason === "stale") f.owner.canRestoreTerminal = () => true;
        }
        await fullscreenMounted();
        expect(settled).toBe(false);
        expect(f.create).not.toHaveBeenCalled();
        expect(f.terminal.events.map((event) => event.name)).toEqual(["start", "drain"]);
        release();
        await expect(task).resolves.toBe("cancelled");
        expect(f.create).not.toHaveBeenCalled();
        if (reason === "shutdown") expect(f.terminal.onInput).toBeUndefined();
        else {
          f.terminal.input("restored parent input");
          expect(input).toHaveBeenCalledExactlyOnceWith("restored parent input");
          // A native drain changes keyboard protocols. Restart even when no child
          // was created, so cancellation does not leave the parent in drain mode.
          expect(f.terminal.events.map((event) => event.name)).toEqual(["start", "drain", "stop", "start"]);
        }
      } finally {
        release();
        f.controller.abort();
        await task;
      }
    },
  );

  it("reports entry drain failure and restores parent input without creating a child", async () => {
    const f = fixture();
    const input = vi.fn();
    const editor = { ...component(), handleInput: input };
    f.parent.addChild(editor);
    f.parent.setFocus(editor);
    f.terminal.drain = () => Promise.reject(new Error("entry drain failed"));
    await expect(f.run()).rejects.toThrow("entry drain failed");
    expect(f.create).not.toHaveBeenCalled();
    expect(f.terminal.events.map((event) => event.name)).toEqual(["start", "drain", "stop", "start"]);
    f.terminal.input("parent input after failure");
    expect(input).toHaveBeenCalledExactlyOnceWith("parent input after failure");
  });

  it("uses callback-unwind handoff when no native drain is available", async () => {
    const f = fixture();
    Object.defineProperty(f.terminal, "drainInput", { value: undefined });
    const task = f.run();
    await fullscreenMounted();
    expect(f.create).toHaveBeenCalledOnce();
    f.options.complete("saved");
    await expect(task).resolves.toBe("saved");
    expect(f.terminal.events.some((event) => event.name === "drain")).toBe(false);
    expect(f.terminal.events.every((event) => event.depth === 0)).toBe(true);
  });

  it.each([false, true])("restores input before joining cancelled root work; failure=%s", async (fail) => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.waitForPending.mockImplementation(async () => {
      await gate;
      if (fail) throw new Error("root settlement failed");
    });
    const parentInput = vi.fn();
    const editor = { ...component(), handleInput: parentInput };
    f.parent.addChild(editor);
    f.parent.setFocus(editor);
    let settled = false;
    const task = f.run().finally(() => {
      settled = true;
    });
    await fullscreenMounted();
    f.terminal.input("\x03");
    await fullscreenMounted();
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.waitForPending).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    f.terminal.input("restored");
    expect(parentInput).toHaveBeenCalledWith("restored");
    release();
    if (fail) await expect(task).rejects.toThrow("root settlement failed");
    else await expect(task).resolves.toBe("cancelled");
  });
  it.each(["regular", "fullscreen"] as const)(
    "restores %s parent before resolving save and preserves its draft",
    async (mode) => {
      const f = fixture(mode);
      const parentInput = vi.fn();
      const editor = { ...component(), handleInput: parentInput };
      f.parent.addChild(editor);
      f.parent.setFocus(editor);
      const task = f.run();
      await fullscreenMounted();
      expect(f.create).toHaveBeenCalledOnce();
      expect(f.options.theme).toBeDefined();
      expect(f.options.keybindings).toBe(originalKeys);
      f.options.complete("saved");
      expect(f.options.signal.aborted).toBe(true);
      await expect(task).resolves.toBe("saved");
      expect(f.harness.closes).toBe(1);
      expect(f.ctx.ui.getEditorText()).toBe("parent draft");
      f.terminal.input("x");
      expect(parentInput).toHaveBeenCalledWith("x");
      expect(f.input).not.toHaveBeenCalled();
      f.harness.host?.dispose?.();
      f.options.complete("late");
      expect(f.dispose).toHaveBeenCalledOnce();
      expect(f.terminal.events.every((event) => event.depth === 0)).toBe(true);
    },
  );

  it.each([
    [{}, "\x1b[5~", "\x1b[6~"],
    [{ "tui.altScreen.pageUp": "ctrl+u", "tui.altScreen.pageDown": "ctrl+j" }, "\x15", "\x0a"],
  ] as const)(
    "uses native viewport wheel and configured paging without a focused root overlay (%j)",
    async (bindings, up, down) => {
      setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, bindings));
      const f = fixture();
      const task = f.run();
      await fullscreenMounted();
      const child = f.options.tui as TuiAltScreen;
      child.renderNow();
      const bottom = f.scroll.scrollTop;
      expect(bottom).toBeGreaterThan(0);
      f.terminal.input(up);
      expect(f.scroll.scrollTop).toBeLessThan(bottom);
      const top = f.scroll.scrollTop;
      f.terminal.input(down);
      expect(f.scroll.scrollTop).toBeGreaterThan(top);
      f.terminal.input("\x1b[<64;2;2M");
      expect(f.scroll.scrollTop).toBeLessThan(bottom);
      expect(f.input).not.toHaveBeenCalled();
      f.options.complete("saved");
      await task;
    },
  );

  it.each([false, true])(
    "hard-cancels synchronously with nested overlay=%s before native Ctrl+C handling",
    async (nested) => {
      const f = fixture();
      const task = f.run();
      await fullscreenMounted();
      const child = f.options.tui as TuiAltScreen;
      child.renderNow();
      const nestedInput = vi.fn();
      if (nested) child.showOverlay({ ...component(), handleInput: nestedInput });
      let release!: () => void;
      f.terminal.drain = () =>
        new Promise<void>((resolve) => {
          release = resolve;
        });
      const before = f.terminal.events.length;
      f.terminal.input("\x03");
      expect(f.options.signal.aborted).toBe(true);
      expect(f.input).not.toHaveBeenCalled();
      expect(nestedInput).not.toHaveBeenCalled();
      await fullscreenMounted();
      expect(f.terminal.events.slice(before).map((event) => event.name)).toEqual(["drain"]);
      f.terminal.input("ignored during drain");
      expect(nestedInput).not.toHaveBeenCalled();
      release();
      await expect(task).resolves.toBe("cancelled");
      expect(f.terminal.events.every((event) => event.depth === 0)).toBe(true);
    },
  );

  it.each([
    ["page alias", "PAGEDOWN", "\x1b[6~", false, true],
    ["modifier order", "alt+ctrl+u", "\x1b[117;7u", true, true],
    ["reverse modifier order", "ctrl+alt+u", "\x1b[117;7u", true, true],
    ["usable alternative", ["not-a-key", "ctrl+alt+u"], "\x1b[117;7u", true, true],
    ["invalid binding", "not-a-key", "\x1b[117;7u", true, false],
    ["legacy Ctrl+I", "ctrl+i", "\t", false, true],
    ["legacy Alt+n", "alt+n", "\x1bn", false, true],
    ["Kitty rejects legacy Alt+n", "alt+n", "\x1bn", true, false],
  ] as const)("routes native viewport bindings: %s", async (_name, key, packet, kitty, moves) => {
    const previous = isKittyProtocolActive();
    setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.altScreen.pageUp": key as never }));
    const f = fixture();
    const task = f.run();
    try {
      await fullscreenMounted();
      (f.options.tui as TuiAltScreen).renderNow();
      setKittyProtocolActive(kitty);
      const before = f.scroll.scrollTop;
      f.terminal.input(packet);
      expect(f.scroll.scrollTop < before).toBe(moves);
      expect(f.input.mock.calls.length > 0).toBe(!moves);
    } finally {
      f.options.complete("saved");
      await task;
      setKittyProtocolActive(previous);
    }
  });

  it("hard-cancels before a native viewport action configured on Ctrl+C", async () => {
    setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.altScreen.search": "ctrl+c" }));
    const f = fixture();
    const task = f.run();
    await fullscreenMounted();
    f.terminal.input("\x03");
    expect(f.options.signal.aborted).toBe(true);
    await expect(task).resolves.toBe("cancelled");
  });

  it("uses a component directly as its fullscreen layout when no adapter is exposed", async () => {
    const f = fixture();
    let child!: TuiAltScreen;
    const task = runSettingsChatFullscreen(
      f.ctx,
      f.owner,
      (options) => {
        child = options.tui as TuiAltScreen;
        return f.scroll;
      },
      "cancelled",
    );
    await fullscreenMounted();
    child.renderNow();
    const bottom = f.scroll.scrollTop;
    f.terminal.input("\x1b[5~");
    expect(f.scroll.scrollTop).toBeLessThan(bottom);
    f.controller.abort();
    await expect(task).resolves.toBe("cancelled");
  });

  it("does not treat complete or fragmented bracketed paste as cancellation", async () => {
    const f = fixture();
    const task = f.run();
    await fullscreenMounted();
    for (const packet of ["\x1b[200~\x03\x1b[201~", "\x1b[200~", "\x03", "\x1b[201~", "typed"])
      f.terminal.input(packet);
    expect(f.options.signal.aborted).toBe(false);
    expect(f.input).toHaveBeenCalledTimes(5);
    f.terminal.input("\x03");
    await expect(task).resolves.toBe("cancelled");
  });

  it.each(["owner", "context", "dispose"])("releases the child after %s cancellation", async (source) => {
    const f = fixture();
    const task = f.run();
    await fullscreenMounted();
    if (source === "owner") f.controller.abort();
    else if (source === "context") f.contextController.abort();
    else f.harness.host?.dispose?.();
    expect(f.options.signal.aborted).toBe(true);
    await expect(task).resolves.toBe("cancelled");
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.harness.closes).toBe(1);
  });

  it("restores the shared live TUI after session ownership changes without stale UI calls", async () => {
    const f = fixture();
    f.owner.canRestoreTerminal = () => true;
    const input = vi.fn();
    const editor = { ...component(), handleInput: input };
    f.parent.addChild(editor);
    f.parent.setFocus(editor);
    const task = f.run();
    await fullscreenMounted();
    f.replaceSession();
    f.controller.abort();
    await expect(task).resolves.toBe("cancelled");
    f.terminal.input("new session");
    expect(input).toHaveBeenCalledWith("new session");
    expect(f.ctx.ui.getEditorText()).toBe("parent draft");
  });

  it("does not restore a replaced session after a pending drain", async () => {
    const f = fixture();
    const task = f.run();
    await fullscreenMounted();
    let release!: () => void;
    f.terminal.drain = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    f.options.complete("saved");
    await fullscreenMounted();
    f.replaceSession();
    release();
    await task;
    expect(f.terminal.events.filter((event) => event.name === "start")).toHaveLength(2);
    expect(f.terminal.onInput).toBeUndefined();
  });

  it("leaves unrelated parent overlays mounted and routes restored input normally", async () => {
    const f = fixture("fullscreen");
    const input = vi.fn();
    const unrelated = f.parent.showOverlay({ ...component(), handleInput: input });
    const task = f.run();
    await fullscreenMounted();
    f.options.complete("saved");
    await task;
    expect(unrelated.isHidden()).toBe(false);
    f.terminal.input("z");
    expect(input).toHaveBeenCalledWith("z");
    unrelated.hide();
  });

  it("routes the first restored viewport input through the parent native listener", async () => {
    const f = fixture("fullscreen");
    const parent = f.parent as TuiAltScreen;
    const scroll = new ScrollView(
      { render: () => Array(100).fill("parent line"), invalidate() {} },
      { primary: true, follow: "end" },
    );
    parent.setLayoutRoot(scroll);
    parent.renderNow();
    const task = f.run();
    await fullscreenMounted();
    f.options.complete("saved");
    await task;
    const before = scroll.scrollTop;
    f.terminal.input("\x1b[5~");
    expect(scroll.scrollTop).toBeLessThan(before);
  });

  it.each(["print", "json", "rpc"] as const)("does not mount a host in %s mode", async (mode) => {
    const f = fixture();
    Object.assign(f.ctx, { mode });
    await expect(f.run()).resolves.toBe("cancelled");
    expect(f.create).not.toHaveBeenCalled();
  });

  it("does not initialize after cancellation before overlay mount", async () => {
    const f = fixture();
    const task = f.run();
    f.controller.abort();
    await expect(task).resolves.toBe("cancelled");
    expect(f.create).not.toHaveBeenCalled();
    expect(f.terminal.events.filter((event) => event.name === "stop")).toHaveLength(0);
  });

  it.each(["constructor", "create", "layout", "start", "dispose", "stop", "drain", "restore"])(
    "surfaces %s failure and still completes owned cleanup",
    async (stage) => {
      const f = fixture();
      const error = new Error(`${stage} failed`);
      if (stage === "create")
        f.create.mockImplementation(() => {
          throw error;
        });
      if (stage === "dispose")
        f.dispose.mockImplementation(() => {
          throw error;
        });
      const task = f.run({
        createTui: (_parent, createDefault) => {
          if (stage === "constructor") throw error;
          const child = createDefault();
          if (stage === "layout")
            vi.spyOn(child, "setLayoutRoot").mockImplementation(() => {
              throw error;
            });
          if (stage === "start")
            vi.spyOn(child, "start").mockImplementation(() => {
              throw error;
            });
          if (stage === "stop") {
            const stop = child.stop.bind(child);
            vi.spyOn(child, "stop").mockImplementation((options) => {
              stop(options);
              throw error;
            });
          }
          return child;
        },
      });
      const observed = expect(task).rejects.toThrow(error);
      await fullscreenMounted();
      if (["dispose", "stop", "drain", "restore"].includes(stage)) {
        if (stage === "drain") f.terminal.drain = () => Promise.reject(error);
        if (stage === "restore")
          vi.spyOn(f.parent, "start").mockImplementation(() => {
            throw error;
          });
        f.options.complete("saved");
      }
      await observed;
      expect(f.harness.closes).toBe(1);
      expect(f.terminal.events.every((event) => event.depth === 0)).toBe(true);
    },
  );

  it.each(["listener", "create", "get-layout", "layout", "focus"])(
    "stops an unreturned child and cancels pending rendering after %s failure",
    async (stage) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const f = fixture();
      const error = new Error(`${stage} setup failed`);
      const stopped = vi.fn();
      const render = vi.spyOn(f.scroll, "render");
      const create = f.create.getMockImplementation();
      if (!create) throw new Error("Missing component factory");
      f.create.mockImplementation((options) => {
        const result = create(options);
        options.tui.requestRender();
        if (stage === "create") throw error;
        if (stage === "get-layout")
          result.getFullscreenLayout = () => {
            throw error;
          };
        return result;
      });
      try {
        const task = f.run({
          createTui: (_parent, createDefault) => {
            const child = stage === "listener" ? new TuiAltScreen(f.parent.terminal) : createDefault();
            const stop = child.stop.bind(child);
            vi.spyOn(child, "stop").mockImplementation((options) => {
              stopped();
              stop(options);
            });
            if (stage === "listener")
              vi.spyOn(child, "addInputListener").mockImplementation(() => {
                throw error;
              });
            if (stage === "layout") {
              const layout = child.setLayoutRoot.bind(child);
              vi.spyOn(child, "setLayoutRoot").mockImplementation((root) => {
                layout(root);
                throw error;
              });
            }
            if (stage === "focus")
              vi.spyOn(child, "setFocus").mockImplementation(() => {
                throw error;
              });
            return child;
          },
        });
        await expect(task).rejects.toThrow(error);
        await fullscreenMounted();
        await vi.runOnlyPendingTimersAsync();
        expect(stopped).toHaveBeenCalledOnce();
        expect(render).not.toHaveBeenCalled();
        expect(f.terminal.onInput).toBeDefined();
        expect(f.terminal.events.every((event) => event.depth === 0)).toBe(true);
      } finally {
        f.harness.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("preserves failed child setup and its local stop error", async () => {
    const f = fixture();
    const setupError = new Error("component setup failed");
    const stopError = new Error("unreturned child stop failed");
    f.create.mockImplementation(() => {
      throw setupError;
    });
    const task = f.run({
      createTui: (_parent, createDefault) => {
        const child = createDefault();
        const stop = child.stop.bind(child);
        vi.spyOn(child, "stop").mockImplementation((options) => {
          stop(options);
          throw stopError;
        });
        return child;
      },
    });
    await expect(task).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([setupError, stopError]);
      return true;
    });
    expect(f.terminal.onInput).toBeDefined();
  });

  it("aborts root work during factory creation and removes upstream listeners", async () => {
    const f = fixture();
    const removeOwner = vi.spyOn(f.controller.signal, "removeEventListener");
    const removeContext = vi.spyOn(f.contextController.signal, "removeEventListener");
    const abortRoot = vi.fn();
    f.create.mockImplementation((options) => {
      options.signal.addEventListener("abort", abortRoot, { once: true });
      f.controller.abort();
      return {
        ...component(),
        handleInput: f.input,
        dispose: f.dispose,
        waitForPending: f.waitForPending,
        getFullscreenLayout: () => f.scroll,
      };
    });
    await expect(f.run()).resolves.toBe("cancelled");
    expect(abortRoot).toHaveBeenCalledOnce();
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(removeOwner).toHaveBeenCalledOnce();
    expect(removeContext).toHaveBeenCalledOnce();
  });

  it("forwards pasted viewport shortcuts to the root without scrolling", async () => {
    setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.altScreen.pageUp": "ctrl+x" }));
    const f = fixture();
    const task = f.run();
    await fullscreenMounted();
    f.options.tui.renderNow();
    const before = f.scroll.scrollTop;
    for (const data of ["\x1b[200~", "\x18", "\x1b[201~"]) f.terminal.input(data);
    expect(f.scroll.scrollTop).toBe(before);
    expect(f.input).toHaveBeenCalledWith("\x18");
    f.options.complete("saved");
    await task;
  });

  it("keeps pasted queries in the focused native search overlay", async () => {
    const f = fixture();
    const task = f.run();
    await fullscreenMounted();
    const child = f.options.tui as TuiAltScreen;
    child.renderNow();
    f.terminal.input("\x1b[102;6u");
    const search = child.getFocusedComponent();
    expect(search).not.toBeNull();
    for (const packet of ["\x1b[200~", "history", "\x1b[201~"]) f.terminal.input(packet);
    expect(f.input).not.toHaveBeenCalled();
    expect(search?.render(80).join("\n")).toContain("history");
    f.terminal.input("\x03");
    await expect(task).resolves.toBe("cancelled");
  });

  it("preserves the parent's hardware cursor setting", async () => {
    const f = fixture();
    f.parent.setShowHardwareCursor(false);
    const task = f.run();
    await fullscreenMounted();
    expect(f.options.tui.getShowHardwareCursor()).toBe(false);
    f.options.complete("saved");
    await task;
  });

  it("restores ownership after parent stop partially fails", async () => {
    const f = fixture();
    const stop = f.parent.stop.bind(f.parent);
    vi.spyOn(f.parent, "stop").mockImplementationOnce((options) => {
      stop(options);
      throw new Error("parent stop failed");
    });
    await expect(f.run()).rejects.toThrow("parent stop failed");
    expect(f.terminal.onInput).toBeDefined();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.harness.closes).toBe(1);
  });

  it("cancels a stale owner before initialization and after the drain boundary", async () => {
    const f = fixture();
    const task = f.run();
    await fullscreenMounted();
    let release!: () => void;
    f.terminal.drain = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    f.options.complete("saved");
    await fullscreenMounted();
    f.replaceSession();
    release();
    await expect(task).resolves.toBe("cancelled");
    await expect(f.run()).resolves.toBe("cancelled");
    expect(f.create).toHaveBeenCalledOnce();
  });

  it.each([false, true])("awaits externally disposed custom cleanup and surfaces failure=%s", async (failure) => {
    const f = fixture();
    let settled = false;
    const task = f.run();
    void task.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await fullscreenMounted();
    let release!: () => void;
    f.terminal.drain = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    if (failure)
      f.dispose.mockImplementation(() => {
        throw new Error("external cleanup failed");
      });
    f.harness.disposeCustom();
    expect(f.options.signal.aborted).toBe(true);
    await fullscreenMounted();
    expect(settled).toBe(false);
    release();
    if (failure) await expect(task).rejects.toThrow("external cleanup failed");
    else await expect(task).resolves.toBe("cancelled");
    expect(f.terminal.onInput).toBeDefined();
    expect(f.dispose).toHaveBeenCalledOnce();
  });

  it("releases listeners when Pi cannot mount the parent overlay", async () => {
    const f = fixture();
    const removeOwner = vi.spyOn(f.controller.signal, "removeEventListener");
    vi.spyOn(f.parent, "showOverlay").mockImplementationOnce(() => {
      throw new Error("mount failed");
    });
    await expect(f.run()).rejects.toThrow("mount failed");
    expect(removeOwner).toHaveBeenCalledOnce();
    expect(f.create).not.toHaveBeenCalled();
  });

  it("disposes a component that completes synchronously during creation", async () => {
    const f = fixture();
    f.create.mockImplementation((options) => {
      options.complete("saved");
      return {
        ...component(),
        handleInput: f.input,
        dispose: f.dispose,
        waitForPending: f.waitForPending,
        getFullscreenLayout: () => f.scroll,
      };
    });
    await expect(f.run()).resolves.toBe("saved");
    expect(f.dispose).toHaveBeenCalledOnce();
  });
});
