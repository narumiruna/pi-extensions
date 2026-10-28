import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionUIContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { setKittyProtocolActive, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { type ProfileApplyCandidate, saveAsProfile, showHistory, showProfiles } from "../src/command-profiles.js";
import type { StarshipCommandOptions } from "../src/commands.js";
import { BUILT_IN_EXAMPLE, loadStarshipConfig } from "../src/config.js";
import { archiveConfigDocument, createProfile, listHistory, listProfiles, readProfile } from "../src/profile-store.js";

type Harness = ReturnType<typeof createTuiHarness>;

function fixture(
  overrides: Partial<ExtensionUIContext> = {},
  keybindings?: Pick<KeybindingsManager, "matches" | "getKeys">,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "starship-profile-command-")));
  const path = join(root, "pi-starship.toml");
  const tui = createTuiHarness({ width: 100, rows: 35, keybindings });
  const zeroFrames: Array<readonly string[]> = [];
  const custom: ExtensionUIContext["custom"] = (factory, customOptions) =>
    tui.custom(async (...args) => {
      const component = await factory(...args);
      zeroFrames.push(component.render(0));
      return component;
    }, customOptions);
  const context = createMockContext({ mode: "tui", hasUI: true, custom, ...overrides });
  const controller = new AbortController();
  const previews: Array<string | undefined> = [];
  let revision = 0;
  const options: StarshipCommandOptions = {
    settingsPath: path,
    getLoaded: () => loadStarshipConfig(path),
    getLoadedRevision: () => revision,
    apply() {
      assert.fail("Only the delegated apply callback may commit settings");
    },
    preview: (loaded) => {
      previews.push(loaded?.rawDocument);
    },
  };
  const owner = { signal: controller.signal, isCurrent: () => true };
  const inertApply: ProfileApplyCandidate = async () => {
    assert.fail("No active-file apply was expected");
  };
  return {
    root,
    path,
    tui,
    zeroFrames,
    ctx: context.ctx,
    notifications: context.notifications,
    controller,
    previews,
    options,
    owner,
    inertApply,
    changeRevision() {
      revision += 1;
    },
    cleanup() {
      tui.dispose();
      controller.abort();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function openProfile(tui: Harness, index = 0) {
  await tui.waitForOpen();
  tui.press("home");
  for (let i = 0; i <= index; i += 1) tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
}

async function action(tui: Harness, index: number) {
  tui.press("home");
  for (let i = 0; i < index; i += 1) tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("profile selection previews exact candidates without active writes or recovery copies and retains selection", async () => {
  const f = fixture();
  const first = createProfile(f.path, "Alpha", "format = 'alpha'\n");
  const second = createProfile(f.path, "Beta", "format = 'beta'\n");
  try {
    const running = showProfiles(f.ctx, f.options, f.owner, f.inertApply);
    await f.tui.waitForOpen();
    assert.match(f.tui.render().join("\n"), /Active: Built-in defaults/u);
    f.tui.press("tui.select.down");
    assert.equal(f.previews.at(-1), first.rawDocument);
    f.tui.press("tui.select.down");
    assert.equal(f.previews.at(-1), second.rawDocument);
    assert.match(f.tui.render().join("\n"), /unavailable module data can be empty/u);
    f.tui.press("tui.select.confirm");
    await f.tui.waitForOpen();
    f.tui.press("tui.select.cancel");
    await f.tui.waitForOpen();
    assert.match(f.tui.render().join("\n"), /→ Beta/u);
    assert.equal(f.previews.at(-1), second.rawDocument);
    f.tui.press("ctrl+c");
    assert.equal(await running, "close");
    assert.equal(f.previews.at(-1), undefined);
    assert.equal(existsSync(f.path), false);
    assert.deepEqual(listHistory(f.path), []);
    assert.equal(readProfile(f.path, "Alpha").rawDocument, first.rawDocument);
  } finally {
    f.cleanup();
  }
});

test("profile actions prioritize apply, then review, edit, duplicate, rename, and delete", async () => {
  const f = fixture();
  createProfile(f.path, "Alpha", "format = 'alpha'\n");
  try {
    const running = showProfiles(f.ctx, f.options, f.owner, f.inertApply);
    await openProfile(f.tui);
    const frame = f.tui.render().join("\n");
    assert.match(frame, /→ Apply…/u);
    const labels = ["Apply…", "Review TOML", "Edit TOML…", "Duplicate…", "Rename…", "Delete…"];
    const positions = labels.map((label) => frame.indexOf(label));
    assert.ok(
      positions.every((position, index) => position >= 0 && (index === 0 || position > (positions[index - 1] ?? -1))),
    );
    await action(f.tui, 1);
    assert.match(f.tui.render().join("\n"), /read-only/u);
    f.tui.press("ctrl+c");
    await running;
    assert.equal(existsSync(f.path), false);
  } finally {
    f.cleanup();
  }
});

test("profile application remains disabled while active settings require explicit recovery", async () => {
  const f = fixture();
  writeFileSync(f.path, "format = [\n");
  createProfile(f.path, "Alpha", "format = 'valid'\n");
  try {
    const running = showProfiles(f.ctx, f.options, f.owner, f.inertApply);
    await openProfile(f.tui);
    const frame = f.tui.render().join("\n");
    assert.match(frame, /Apply…/u);
    assert.match(f.tui.render().join("\n"), /Repair active settings or use explicit recovery first/u);
    f.tui.press("tui.select.confirm");
    f.tui.press("ctrl+c");
    await running;
    assert.equal(readFileSync(f.path, "utf8"), "format = [\n");
    assert.deepEqual(listHistory(f.path), []);
  } finally {
    f.cleanup();
  }
});

test("save current uses the built-in example without creating the active file and preserves exact custom bytes", async () => {
  for (const raw of [undefined, "# exact\r\nformat = 'custom'\r\nfuture = true\r\n"]) {
    const f = fixture({ input: async () => "Saved" });
    if (raw) writeFileSync(f.path, raw);
    try {
      const running = showProfiles(f.ctx, f.options, f.owner, f.inertApply);
      await f.tui.waitForOpen();
      f.tui.press("tui.select.confirm");
      await f.tui.waitForOpen();
      assert.equal(readProfile(f.path, "Saved").rawDocument, raw ?? BUILT_IN_EXAMPLE);
      assert.equal(existsSync(f.path), raw !== undefined);
      if (raw) assert.equal(readFileSync(f.path, "utf8"), raw);
      f.tui.press("ctrl+c");
      await running;
    } finally {
      f.cleanup();
    }
  }
});

test("save current rejects malformed active settings instead of saving fallback defaults", async () => {
  let inputs = 0;
  const f = fixture({
    input: async () => {
      inputs += 1;
      return "Invalid";
    },
  });
  writeFileSync(f.path, "format = [");
  try {
    const running = showProfiles(f.ctx, f.options, f.owner, f.inertApply);
    await f.tui.waitForOpen();
    f.tui.press("tui.select.confirm");
    await f.tui.waitForOpen();
    assert.equal(inputs, 0);
    assert.deepEqual(listProfiles(f.path), []);
    assert.match(f.notifications.at(-1)?.message ?? "", /malformed active settings/u);
    f.tui.press("ctrl+c");
    await running;
  } finally {
    f.cleanup();
  }
});

test("matching profiles are copies, allow save-only editing, and retain exact draft bytes", async () => {
  const raw = "# original\nformat = 'original'\n";
  const draft = "# exact draft\r\nformat = 'draft'\r\nfuture = true\r\n";
  const drafts: string[] = [];
  const f = fixture({
    editor: async (_title, initial) => {
      drafts.push(initial ?? "");
      return draft;
    },
  });
  writeFileSync(f.path, raw);
  createProfile(f.path, "Alpha", raw);
  createProfile(f.path, "Also", raw);
  try {
    const running = showProfiles(f.ctx, f.options, f.owner, f.inertApply);
    await f.tui.waitForOpen();
    assert.equal(
      (
        f.tui
          .render()
          .join("\n")
          .match(/Matches active settings/gu) ?? []
      ).length,
      2,
    );
    await openProfile(f.tui);
    await action(f.tui, 2);
    assert.deepEqual(drafts, [raw]);
    assert.equal(f.previews.at(-1), draft);
    await action(f.tui, 1);
    assert.equal(readProfile(f.path, "Alpha").rawDocument, draft);
    assert.equal(readFileSync(f.path, "utf8"), raw);
    assert.deepEqual(listHistory(f.path), []);
    assert.match(f.tui.render().join("\n"), /→ Alpha/u);
    f.tui.press("ctrl+c");
    await running;
  } finally {
    f.cleanup();
  }
});

test("save-and-apply retains a saved profile when delegated application fails", async () => {
  const f = fixture({ editor: async () => "format = 'edited'\n" });
  createProfile(f.path, "Alpha", "format = 'before'\n");
  writeFileSync(f.path, "format = 'active'\n");
  let called = 0;
  try {
    const running = showProfiles(f.ctx, f.options, f.owner, async (loaded, owner) => {
      called += 1;
      assert.equal(loaded.rawDocument, "format = 'edited'\n");
      assert.equal(owner.isCurrent(), true);
      return "stay";
    });
    await openProfile(f.tui);
    await action(f.tui, 2);
    await action(f.tui, 2);
    assert.equal(called, 1);
    assert.equal(readProfile(f.path, "Alpha").rawDocument, "format = 'edited'\n");
    assert.equal(readFileSync(f.path, "utf8"), "format = 'active'\n");
    assert.match(f.notifications.at(-1)?.message ?? "", /profile was saved.*Application did not complete/u);
    f.tui.press("ctrl+c");
    await running;
  } finally {
    f.cleanup();
  }
});

test("malformed profiles stay visible, never preview fallback, and can continue editing the exact invalid draft", async () => {
  const drafts: string[] = [];
  const invalid = "# retain\nformat = [\n";
  const edited = "# still invalid\nformat = {\n";
  const f = fixture({
    editor: async (_title, draft) => {
      drafts.push(draft ?? "");
      return drafts.length === 1 ? edited : undefined;
    },
  });
  createProfile(f.path, "Broken", invalid);
  try {
    const running = showProfiles(f.ctx, f.options, f.owner, f.inertApply);
    await openProfile(f.tui);
    assert.ok(f.previews.every((raw) => raw === undefined));
    assert.match(f.tui.render().join("\n"), /Invalid TOML cannot be applied/u);
    await action(f.tui, 2);
    assert.match(f.tui.render().join("\n"), /Profile draft needs attention/u);
    await action(f.tui, 3);
    assert.deepEqual(drafts, [invalid, edited]);
    assert.equal(readProfile(f.path, "Broken").rawDocument, invalid);
    assert.match(f.tui.render().join("\n"), /→ Broken/u);
    f.tui.press("ctrl+c");
    await running;
  } finally {
    f.cleanup();
  }
});

test("rename and duplicate preserve bytes; delete names the exact saved path and leaves active settings unchanged", async () => {
  const names = ["Renamed", "Copy"];
  let confirmation = "";
  const f = fixture({
    input: async () => names.shift(),
    confirm: async (_title, body, opts) => {
      confirmation = body;
      assert.ok(opts?.signal);
      return true;
    },
  });
  const raw = "# profile\nformat = 'a'\n";
  createProfile(f.path, "Alpha", raw);
  writeFileSync(f.path, raw);
  try {
    const running = showProfiles(f.ctx, f.options, f.owner, f.inertApply);
    await openProfile(f.tui);
    await action(f.tui, 4);
    assert.match(f.tui.render().join("\n"), /→ Renamed/u);
    assert.equal(readProfile(f.path, "Renamed").rawDocument, raw);
    f.tui.press("tui.select.confirm");
    await f.tui.waitForOpen();
    await action(f.tui, 3);
    assert.equal(readProfile(f.path, "Copy").rawDocument, raw);
    assert.match(f.tui.render().join("\n"), /→ Renamed/u);
    await openProfile(f.tui);
    await action(f.tui, 5);
    assert.match(confirmation, /Copy\.toml/u);
    assert.match(confirmation, /active settings copy remains unchanged/u);
    assert.deepEqual(
      listProfiles(f.path).map((item) => item.name),
      ["Renamed"],
    );
    assert.equal(readFileSync(f.path, "utf8"), raw);
    f.tui.press("ctrl+c");
    await running;
  } finally {
    f.cleanup();
  }
});

test("changed profile snapshots block pending rename, duplicate, delete, and draft publication", async () => {
  for (const operation of ["rename", "duplicate", "delete", "edit"] as const) {
    const input = deferred<string | undefined>();
    const confirmation = deferred<boolean>();
    const editor = deferred<string | undefined>();
    const entered = deferred<void>();
    const f = fixture({
      input: async () => {
        entered.resolve();
        return input.promise;
      },
      confirm: async () => {
        entered.resolve();
        return confirmation.promise;
      },
      editor: async () => {
        entered.resolve();
        return editor.promise;
      },
    });
    const original = createProfile(f.path, "Alpha", "format = 'before'\n");
    try {
      const running = showProfiles(f.ctx, f.options, f.owner, f.inertApply);
      await openProfile(f.tui);
      f.tui.press("home");
      const index = { rename: 4, duplicate: 3, delete: 5, edit: 2 }[operation];
      for (let i = 0; i < index; i += 1) f.tui.press("tui.select.down");
      f.tui.press("tui.select.confirm");
      await entered.promise;
      writeFileSync(original.path, "format = 'external'\n");
      input.resolve("New");
      confirmation.resolve(true);
      editor.resolve("format = 'draft'\n");
      await f.tui.waitForOpen();
      assert.match(f.notifications.at(-1)?.message ?? "", /selected document changed/u, operation);
      assert.equal(readProfile(f.path, "Alpha").rawDocument, "format = 'external'\n", operation);
      assert.deepEqual(
        listProfiles(f.path).map((item) => item.name),
        ["Alpha"],
        operation,
      );
      f.tui.press("ctrl+c");
      await running;
    } finally {
      f.cleanup();
    }
  }
});

test("owner abort and revision changes reject delayed editor drafts and clear previews", async () => {
  for (const exit of ["abort", "revision"] as const) {
    const editor = deferred<string | undefined>();
    const entered = deferred<void>();
    const f = fixture({
      editor: async () => {
        entered.resolve();
        return editor.promise;
      },
    });
    const original = createProfile(f.path, "Alpha", "format = 'before'\n");
    try {
      const running = showProfiles(f.ctx, f.options, f.owner, f.inertApply);
      await openProfile(f.tui);
      f.tui.press("tui.select.down");
      f.tui.press("tui.select.down");
      f.tui.press("tui.select.confirm");
      await entered.promise;
      if (exit === "abort") {
        f.controller.abort();
        assert.equal(f.previews.at(-1), undefined);
      } else f.changeRevision();
      editor.resolve("format = 'draft'\n");
      assert.equal(await running, "close");
      assert.equal(f.previews.at(-1), undefined);
      assert.equal(readProfile(f.path, "Alpha").rawDocument, original.rawDocument);
    } finally {
      f.cleanup();
    }
  }
});

test("apply delegates guarded ownership, adopts its own successful revision, and cancellation keeps that commit", async () => {
  const f = fixture();
  const profile = createProfile(f.path, "Alpha", "format = 'candidate'\n");
  try {
    const running = showProfiles(f.ctx, f.options, f.owner, async (loaded, owner, checkCandidate, name) => {
      assert.equal(name, "Alpha");
      assert.equal(owner.isCurrent(), true);
      checkCandidate();
      writeFileSync(f.path, loaded.rawDocument ?? "");
      f.changeRevision();
      // Production reviewAndApply checks owner after options.apply increments
      // its revision. This must not turn a completed commit into cancellation.
      assert.equal(owner.isCurrent(), true);
      return "applied";
    });
    await openProfile(f.tui);
    await action(f.tui, 0);
    assert.match(f.tui.render().join("\n"), /Matches active settings/u);
    f.tui.press("tui.select.cancel");
    assert.equal(await running, "back");
    assert.equal(readFileSync(f.path, "utf8"), profile.rawDocument);
    assert.equal(f.previews.at(-1), undefined);
  } finally {
    f.cleanup();
  }
});

test("history supports preview, exact read-only review, restore delegation, save-as, and confirmed deletion", async () => {
  const f = fixture({ input: async () => "Recovered", confirm: async () => true });
  const raw = "# recovery\nformat = 'history'\n";
  const archive = archiveConfigDocument(f.path, raw);
  let applied = "";
  try {
    const running = showHistory(f.ctx, f.options, f.owner, async (loaded, owner) => {
      assert.equal(owner.isCurrent(), true);
      applied = loaded.rawDocument ?? "";
      return "stay";
    });
    await f.tui.waitForOpen();
    assert.equal(f.previews.at(-1), raw);
    f.tui.press("tui.select.confirm");
    await f.tui.waitForOpen();
    assert.match(f.tui.render().join("\n"), /not proof that an application succeeded/u);
    await action(f.tui, 0);
    assert.match(f.tui.render().join("\n"), /# recovery/u);
    f.tui.press("tui.select.cancel");
    await f.tui.waitForOpen();
    await action(f.tui, 1);
    assert.equal(applied, raw);
    assert.equal(readFileSync(archive.path, "utf8"), raw);
    f.tui.press("tui.select.confirm");
    await f.tui.waitForOpen();
    await action(f.tui, 2);
    assert.equal(readProfile(f.path, "Recovered").rawDocument, raw);
    f.tui.press("tui.select.confirm");
    await f.tui.waitForOpen();
    await action(f.tui, 3);
    assert.equal(existsSync(archive.path), false);
    assert.equal(existsSync(f.path), false);
    f.tui.press("ctrl+c");
    await running;
  } finally {
    f.cleanup();
  }
});

test("legacy history is read-only and invalid UTF-8 history never previews a decoded fallback", async () => {
  for (const legacy of [true, false]) {
    const f = fixture();
    let archivePath: string;
    if (legacy) {
      archivePath = join(dirname(f.path), "pi-starship", "pi-starship-202610201200.toml");
      mkdirSync(dirname(archivePath), { recursive: true });
      writeFileSync(archivePath, "format = 'legacy'\n");
    } else archivePath = archiveConfigDocument(f.path, Buffer.from([0xff, 0xfe])).path;
    try {
      const running = showHistory(f.ctx, f.options, f.owner, f.inertApply);
      await f.tui.waitForOpen();
      if (!legacy) {
        assert.ok(f.previews.every((raw) => raw === undefined));
        assert.doesNotMatch(f.tui.render().join("\n"), /Matches active settings/u);
      }
      f.tui.press("tui.select.confirm");
      await f.tui.waitForOpen();
      if (legacy) {
        f.tui.press("end");
        assert.match(f.tui.render().join("\n"), /Legacy backups are read-only/u);
        f.tui.press("tui.select.confirm");
        assert.equal(existsSync(archivePath), true);
      } else assert.match(f.tui.render().join("\n"), /not valid UTF-8/u);
      f.tui.press("ctrl+c");
      await running;
      assert.equal(existsSync(archivePath), true);
    } finally {
      f.cleanup();
    }
  }
});

test("Kit owns bounded controls, search, non-default keys, disposal, and hard close", async () => {
  const mapping: Record<string, string> = {
    "tui.select.up": "k",
    "tui.select.down": "j",
    "tui.select.confirm": "y",
    "tui.select.cancel": "q",
  };
  const keybindings: Pick<KeybindingsManager, "matches" | "getKeys"> = {
    matches: (data, binding) => data === mapping[binding],
    getKeys: (binding) => (mapping[binding] ? [mapping[binding] as never] : []),
  };
  for (const exit of ["close", "dispose"]) {
    const f = fixture({}, keybindings);
    createProfile(f.path, "Alpha", "format = 'a'\n");
    createProfile(f.path, "Beta", "format = 'b'\n");
    try {
      const running = showProfiles(f.ctx, f.options, f.owner, f.inertApply);
      await f.tui.waitForOpen();
      f.tui.send("j");
      assert.equal(f.previews.at(-1), "format = 'a'\n");
      f.tui.send("y");
      await f.tui.waitForOpen();
      for (const size of [
        { width: 1, rows: 4 },
        { width: 1, rows: 5 },
        { width: 20, rows: 8 },
        { width: 80, rows: 30 },
      ]) {
        const rows = f.tui.resize(size);
        assert.ok(rows.length <= Math.max(1, size.rows - 3));
        assert.ok(rows.every((row) => visibleWidth(row) <= size.width));
      }
      assert.ok(f.zeroFrames.length >= 2);
      assert.ok(f.zeroFrames.every((frame) => frame.every((line) => visibleWidth(line) === 0)));
      f.tui.send("q");
      await f.tui.waitForOpen();
      assert.match(f.tui.render().join("\n"), /→ Alpha/u);
      f.tui.type("Beta");
      assert.equal(f.previews.at(-1), "format = 'b'\n");
      if (exit === "close") f.tui.press("ctrl+c");
      else f.tui.dispose();
      assert.equal(await running, "close");
      assert.equal(f.previews.at(-1), undefined);
      assert.equal(existsSync(f.path), false);
    } finally {
      f.cleanup();
    }
  }
});

test("preview failures restore committed footer and do not mutate stored documents", async () => {
  const f = fixture();
  createProfile(f.path, "Alpha", "format = 'a'\n");
  f.options.preview = (loaded) => {
    f.previews.push(loaded?.rawDocument);
    if (loaded) throw new Error("preview failed");
  };
  try {
    const running = showProfiles(f.ctx, f.options, f.owner, f.inertApply);
    await f.tui.waitForOpen();
    f.tui.press("tui.select.down");
    assert.equal(await running, "close");
    assert.equal(f.previews.at(-1), undefined);
    assert.match(f.notifications.at(-1)?.message ?? "", /preview failed/u);
    assert.equal(existsSync(f.path), false);
    assert.deepEqual(listHistory(f.path), []);
  } finally {
    f.cleanup();
  }
});

test("native hard-cancel observation follows Pi matcher classes without consuming input", async () => {
  const cases = [
    { data: "\x03", cancel: true },
    { data: "\x1b[99;5u", cancel: true },
    { data: "\x1b[27;5;99~", cancel: true },
    { data: "\x1b[99;69u", cancel: true },
    { data: "\x1b[99;5:2u", cancel: true },
    { data: "\x1b[1089::99;5u", cancel: true },
    { data: "\x1b[99;5:3u", cancel: false },
    { data: "\x1b[67;5u", cancel: false },
    { data: "\x1b[99;6u", cancel: false },
    { data: "\x1b[99;7u", cancel: false },
  ];
  for (const kitty of [false, true]) {
    setKittyProtocolActive(kitty);
    try {
      for (const item of cases) {
        let listener: Parameters<ExtensionUIContext["onTerminalInput"]>[0] | undefined;
        let released = 0;
        let listenerResult: unknown;
        let aborted: boolean | undefined;
        const f = fixture({
          onTerminalInput: (handler) => {
            listener = handler;
            return () => {
              released += 1;
              listener = undefined;
            };
          },
          input: async (_title, _placeholder, opts) => {
            listenerResult = listener?.(item.data);
            // Native input dispatch completes before the hard-cancel abort runs.
            await Promise.resolve();
            aborted = opts?.signal?.aborted;
            return "Saved";
          },
        });
        try {
          const result = await saveAsProfile(f.ctx, f.options, f.owner, "format = 'x'\n");
          assert.equal(listenerResult, undefined);
          assert.equal(aborted, item.cancel, JSON.stringify(item));
          if (item.cancel) {
            assert.equal(result, "close");
            assert.deepEqual(listProfiles(f.path), []);
          } else {
            assert.ok(result && result !== "close");
            assert.equal(result.name, "Saved");
          }
          assert.equal(released, 1);
        } finally {
          f.cleanup();
        }
      }
    } finally {
      setKittyProtocolActive(false);
    }
  }
});

test("Profiles and History reject non-TUI modes without dialogs or filesystem writes", async () => {
  const f = fixture();
  try {
    for (const mode of ["rpc", "print", "json"] as const) {
      const context = createMockContext({
        mode,
        hasUI: mode === "rpc",
        custom: async () => {
          assert.fail("No custom UI outside TUI");
        },
      });
      assert.equal(await showProfiles(context.ctx, f.options, f.owner, f.inertApply), "close");
      assert.equal(await showHistory(context.ctx, f.options, f.owner, f.inertApply), "close");
      assert.equal(await saveAsProfile(context.ctx, f.options, f.owner, "format = 'x'\n"), undefined);
      if (mode === "rpc") assert.match(context.notifications[0]?.message ?? "", /require TUI/u);
      else assert.deepEqual(context.notifications, []);
    }
    assert.equal(existsSync(join(f.root, "pi-starship")), false);
  } finally {
    f.cleanup();
  }
});

test("apply source guard reports changed candidates without classifying the session as stale", async () => {
  const f = fixture();
  const profile = createProfile(f.path, "Alpha", "format = 'reviewed'\n");
  try {
    const running = showProfiles(f.ctx, f.options, f.owner, async (_loaded, owner, checkCandidate) => {
      writeFileSync(profile.path, "format = 'external'\n");
      assert.equal(owner.isCurrent(), true);
      assert.throws(checkCandidate, /selected document changed/u);
      return "stay";
    });
    await openProfile(f.tui);
    await action(f.tui, 0);
    assert.match(f.notifications.at(-1)?.message ?? "", /selected document changed/u);
    assert.equal(existsSync(f.path), false);
    f.tui.press("ctrl+c");
    await running;
  } finally {
    f.cleanup();
  }
});

test("owner abort immediately releases the native editor observer while draining its unabortable promise", async () => {
  const entered = deferred<void>();
  const editor = deferred<string | undefined>();
  let released = 0;
  const f = fixture({
    onTerminalInput: () => () => {
      released += 1;
    },
    editor: async () => {
      entered.resolve();
      return editor.promise;
    },
  });
  createProfile(f.path, "Alpha", "format = 'reviewed'\n");
  try {
    const running = showProfiles(f.ctx, f.options, f.owner, f.inertApply);
    await openProfile(f.tui);
    f.tui.press("tui.select.down");
    f.tui.press("tui.select.down");
    f.tui.press("tui.select.confirm");
    await entered.promise;
    f.controller.abort();
    assert.equal(released, 1);
    assert.equal(f.previews.at(-1), undefined);
    editor.resolve("format = 'must-not-save'\n");
    assert.equal(await running, "close");
    assert.equal(released, 1);
    assert.equal(readProfile(f.path, "Alpha").rawDocument, "format = 'reviewed'\n");
  } finally {
    f.cleanup();
  }
});

test("malformed profile duplication copies raw TOML and retains its original cursor", async () => {
  const f = fixture({ input: async () => "Broken copy" });
  const raw = "# invalid but recoverable\nformat = [\n";
  createProfile(f.path, "Broken", raw);
  try {
    const running = showProfiles(f.ctx, f.options, f.owner, f.inertApply);
    await openProfile(f.tui);
    await action(f.tui, 3);
    assert.equal(readProfile(f.path, "Broken copy").rawDocument, raw);
    assert.match(f.tui.render().join("\n"), /→ Broken\s/u);
    assert.ok(f.previews.every((item) => item === undefined));
    f.tui.press("ctrl+c");
    await running;
  } finally {
    f.cleanup();
  }
});

test("draft Escape continues editing; discard and disposal never publish a draft", async () => {
  for (const exit of ["discard", "dispose", "back"] as const) {
    const drafts: string[] = [];
    const f = fixture({
      editor: async (_title, draft) => {
        drafts.push(draft ?? "");
        return drafts.length === 1 ? "# draft\nformat = 'draft'\n" : undefined;
      },
    });
    const original = createProfile(f.path, "Alpha", "format = 'before'\n");
    try {
      const running = showProfiles(f.ctx, f.options, f.owner, f.inertApply);
      await openProfile(f.tui);
      await action(f.tui, 2);
      if (exit === "dispose") {
        f.tui.dispose();
        assert.equal(await running, "close");
      } else {
        if (exit === "back") {
          f.tui.press("tui.select.cancel");
          await f.tui.waitForOpen();
          assert.equal(drafts[1], "# draft\nformat = 'draft'\n");
        } else await action(f.tui, 3);
        f.tui.press("ctrl+c");
        await running;
      }
      assert.equal(readProfile(f.path, "Alpha").rawDocument, original.rawDocument);
      assert.equal(f.previews.at(-1), undefined);
      assert.equal(existsSync(f.path), false);
    } finally {
      f.cleanup();
    }
  }
});

test("invalid UTF-8 history deletion confirms the exact path and preserves raw bytes on cancellation", async () => {
  let allowed = false;
  let confirmation = "";
  const f = fixture({
    confirm: async (_title, body) => {
      confirmation = body;
      return allowed;
    },
  });
  const bytes = Buffer.from([0xff, 0xfe, 0x00]);
  const archive = archiveConfigDocument(f.path, bytes);
  try {
    const running = showHistory(f.ctx, f.options, f.owner, f.inertApply);
    await f.tui.waitForOpen();
    f.tui.press("tui.select.confirm");
    await f.tui.waitForOpen();
    await action(f.tui, 3);
    assert.ok(confirmation.includes(archive.name));
    assert.deepEqual(readFileSync(archive.path), bytes);
    allowed = true;
    f.tui.press("tui.select.confirm");
    await f.tui.waitForOpen();
    await action(f.tui, 3);
    assert.equal(existsSync(archive.path), false);
    f.tui.press("ctrl+c");
    await running;
    assert.equal(existsSync(f.path), false);
  } finally {
    f.cleanup();
  }
});

test("native dialog observer does not consume pasted control bytes or change native input text", async () => {
  let listener: Parameters<ExtensionUIContext["onTerminalInput"]>[0] | undefined;
  const f = fixture({
    onTerminalInput: (handler) => {
      listener = handler;
      return () => {
        listener = undefined;
      };
    },
    input: async (_title, _placeholder, opts) => {
      assert.equal(listener?.("\x1b[200~pasted\x03text\x1b[201~"), undefined);
      assert.equal(opts?.signal?.aborted, false);
      return "Pasted name";
    },
  });
  try {
    const saved = await saveAsProfile(f.ctx, f.options, f.owner, "# untouched\r\nformat = 'pasted'\r\n");
    assert.ok(saved && saved !== "close");
    assert.equal(saved.rawDocument, "# untouched\r\nformat = 'pasted'\r\n");
    assert.equal(listener, undefined);
    assert.equal(existsSync(f.path), false);
  } finally {
    f.cleanup();
  }
});

test("invalid UTF-8 profiles remain visible beside valid profiles and duplicate/delete preserve exact bytes", async () => {
  const f = fixture({ input: async () => "Raw copy", confirm: async () => true });
  const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x03]);
  const broken = createProfile(f.path, "Broken", "format = 'placeholder'\n");
  writeFileSync(broken.path, bytes);
  createProfile(f.path, "Good", "format = 'good'\n");
  try {
    const running = showProfiles(f.ctx, f.options, f.owner, f.inertApply);
    await f.tui.waitForOpen();
    assert.match(f.tui.render().join("\n"), /Broken/u);
    assert.match(f.tui.render().join("\n"), /Good/u);
    await openProfile(f.tui);
    assert.match(f.tui.render().join("\n"), /not valid UTF-8/u);
    assert.ok(f.previews.every((raw) => raw === undefined));
    await action(f.tui, 3);
    const copy = readProfile(f.path, "Raw copy");
    assert.equal(copy.rawDocument, undefined);
    assert.deepEqual(readFileSync(copy.path), bytes);
    assert.match(f.tui.render().join("\n"), /→ Broken/u);
    f.tui.press("tui.select.confirm");
    await f.tui.waitForOpen();
    await action(f.tui, 5);
    assert.equal(existsSync(broken.path), false);
    assert.deepEqual(readFileSync(copy.path), bytes);
    assert.equal(existsSync(f.path), false);
    f.tui.press("ctrl+c");
    await running;
  } finally {
    f.cleanup();
  }
});

test("invalid UTF-8 profile repair requires consent and opens an explicit empty validated draft", async () => {
  for (const consent of [false, true]) {
    let confirmation = "";
    const drafts: Array<string | undefined> = [];
    const repaired = "# repaired deliberately\nformat = 'repair'\n";
    const f = fixture({
      confirm: async (_title, body) => {
        confirmation = body;
        return consent;
      },
      editor: async (_title, draft) => {
        drafts.push(draft);
        return repaired;
      },
    });
    const original = createProfile(f.path, "Broken", "format = 'placeholder'\n");
    const bytes = Buffer.from([0xff, 0xfe]);
    writeFileSync(original.path, bytes);
    try {
      const running = showProfiles(f.ctx, f.options, f.owner, f.inertApply);
      await openProfile(f.tui);
      await action(f.tui, 2);
      assert.match(confirmation, /empty repair draft/u);
      assert.match(confirmation, /Saving replaces these invalid bytes/u);
      if (consent) {
        assert.deepEqual(drafts, [""]);
        assert.equal(f.previews.at(-1), repaired);
        await action(f.tui, 1);
        assert.equal(readProfile(f.path, "Broken").rawDocument, repaired);
      } else {
        assert.deepEqual(drafts, []);
        assert.deepEqual(readFileSync(original.path), bytes);
      }
      assert.equal(existsSync(f.path), false);
      f.tui.press("ctrl+c");
      await running;
    } finally {
      f.cleanup();
    }
  }
});
