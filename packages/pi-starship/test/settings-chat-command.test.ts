import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { showSettingsAgentChat } from "../src/command-settings-chat.js";
import { handleStarshipCommand, registerStarshipCommand, type StarshipCommandOptions } from "../src/commands.js";
import { type LoadedStarshipConfig, loadStarshipConfig } from "../src/config.js";
import { createProfile, listHistory, listProfiles, readProfile } from "../src/profile-store.js";
import { response, settingsChatCustom, testModel } from "./settings-chat-support.js";

function fixture(
  original: string | null = "# retained\nformat = '$model'\n",
  overrides: Partial<StarshipCommandOptions> = {},
  route: "chat" | "command" = "chat",
) {
  const root = mkdtempSync(join(tmpdir(), "starship-chat-command-"));
  const settingsPath = join(root, "pi-starship.toml");
  if (original !== null) writeFileSync(settingsPath, original);
  let loaded = loadStarshipConfig(settingsPath);
  let revision = 1;
  let applied = 0;
  let cleanup: (() => Promise<void>) | undefined;
  const previews: Array<LoadedStarshipConfig | undefined> = [];
  const tui = createTuiHarness({ rows: 40 });
  const listeners = new Set<(data: string) => unknown>();
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: settingsChatCustom(tui.custom),
    model: { ...testModel, input: ["text"] },
    onTerminalInput(listener: Parameters<ExtensionCommandContext["ui"]["onTerminalInput"]>[0]) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  const ctx = context.ctx as ExtensionCommandContext;
  ctx.ui.input = async () => "chat-draft";
  const controller = new AbortController();
  let draftPath: string | undefined;
  let request = 0;
  ctx.modelRegistry.streamSimple = (_model, input) => {
    request += 1;
    const system = input.messages[0];
    assert.ok(system?.role === "system");
    const text = typeof system.content === "string" ? system.content : "";
    draftPath = /Draft path: ([^\n]+)/u.exec(text)?.[1];
    assert.ok(draftPath);
    if (request % 2 === 1)
      return response(
        [
          {
            type: "toolCall",
            id: `write-${request}`,
            name: "write",
            arguments: { path: draftPath, content: "# retained\nformat = '$directory'\n" },
          },
        ],
        "toolUse",
      );
    return response([{ type: "text", text: "The draft is ready for preview." }]);
  };
  const options: StarshipCommandOptions = {
    settingsPath,
    getLoaded: () => loaded,
    getLoadedRevision: () => revision,
    apply(next) {
      loaded = next;
      revision += 1;
      applied += 1;
    },
    preview: (next) => previews.push(next),
    renderPreview: () => ["LIVE FOOTER PREVIEW"],
    registerChatCleanup(fn) {
      cleanup = fn;
      return () => {
        cleanup = undefined;
      };
    },
    ...overrides,
  };
  const owner = { signal: controller.signal, isCurrent: () => !controller.signal.aborted };
  const running =
    route === "command"
      ? handleStarshipCommand("", ctx, { ...options, getMenuOwner: () => owner })
      : showSettingsAgentChat(ctx, options, owner);
  return {
    root,
    settingsPath,
    tui,
    ctx,
    context,
    controller,
    options,
    previews,
    running,
    get loaded() {
      return loaded;
    },
    get applied() {
      return applied;
    },
    get draftPath() {
      return draftPath;
    },
    get cleanup() {
      return cleanup;
    },
    sendRaw(data: string) {
      for (const listener of [...listeners]) listener(data);
      tui.send(data);
    },
    get inputListeners() {
      return listeners.size;
    },
    async submit() {
      await tui.waitForOpen();
      if (route === "command") {
        tui.press("tui.select.confirm");
        await tui.waitForOpen();
      }
      tui.type("Show the directory");
      tui.send("\r");
      await tui.waitForPending();
    },
    async chooseSave(continueReview = true) {
      const previous = tui.openCount;
      tui.send("\x13");
      await vi.waitFor(() => assert.ok(tui.openCount > previous));
      await tui.waitForOpen();
      assert.match(tui.render().join("\n"), /Review draft before saving/u);
      if (continueReview) tui.press("tui.select.confirm");
    },
    async dispose() {
      controller.abort();
      tui.dispose();
      await running.catch(() => {});
      rmSync(root, { force: true, recursive: true });
    },
  };
}

test("chat captures active module inspection once without confusing loaded, disk, and draft settings", async () => {
  let inspections = 0;
  const f = fixture("format = '$model'\n", {
    getInspection() {
      inspections += 1;
      return { modules: [], showing: [] };
    },
  });
  writeFileSync(f.settingsPath, "format = '$directory'\n");
  let request = 0;
  let snapshotResult = "";
  f.ctx.modelRegistry.streamSimple = (_model, input) => {
    request += 1;
    if (request === 1) {
      const prompt = input.messages[0];
      const text = prompt?.role === "system" && typeof prompt.content === "string" ? prompt.content : "";
      const directory = /Tool working directory: ([^\n]+)/u.exec(text)?.[1];
      return response(
        ["active-document.toml", "active-effective.toml", "active-modules.json"].map((name) => ({
          type: "toolCall" as const,
          id: name,
          name: "read",
          arguments: { path: join(directory ?? "", name) },
        })),
        "toolUse",
      );
    }
    snapshotResult = input.messages
      .filter((message) => message.role === "toolResult")
      .flatMap((message) => message.content.map((part) => (part.type === "text" ? part.text : "")))
      .join("\n");
    return response([{ type: "text", text: "Read-only snapshot inspected." }]);
  };
  try {
    await f.submit();
    assert.equal(inspections, 1);
    assert.match(snapshotResult, /"available": true/u);
    assert.match(snapshotResult, /format = '\$model'/u);
    assert.doesNotMatch(snapshotResult, /format = '\$directory'/u);
    assert.equal(f.applied, 0);
    assert.equal(f.previews.filter(Boolean).length, 0);
    assert.equal(readFileSync(f.settingsPath, "utf8"), "format = '$directory'\n");
    f.sendRaw("\x03");
    await f.running;
  } finally {
    await f.dispose();
  }
});

test("agent edits preview immediately; reviewed save creates a named profile before applying with History", async () => {
  const f = fixture();
  try {
    await f.submit();
    assert.equal(readFileSync(f.settingsPath, "utf8"), "# retained\nformat = '$model'\n");
    assert.equal(f.applied, 0);
    assert.match(f.previews.at(-1)?.rawDocument ?? "", /\$directory/u);
    await f.chooseSave();
    assert.equal(await f.running, "applied");
    assert.equal(f.applied, 1);
    assert.equal(readFileSync(f.settingsPath, "utf8"), "# retained\nformat = '$directory'\n");
    assert.equal(f.loaded.rawDocument, readFileSync(f.settingsPath, "utf8"));
    assert.equal(listHistory(f.settingsPath).length, 1);
    assert.equal(readProfile(f.settingsPath, "chat-draft").rawDocument, f.loaded.rawDocument);
    assert.equal(f.previews.at(-1), undefined);
    assert.equal(f.cleanup, undefined);
    assert.equal(existsSync(f.draftPath ?? ""), false);
  } finally {
    await f.dispose();
  }
});

test("Ctrl+S enters exact review and named profile save directly without applying automatically", async () => {
  const f = fixture(undefined, {}, "command");
  f.ctx.ui.input = async () => "direct-save";
  f.ctx.ui.confirm = async () => {
    assert.equal(readProfile(f.settingsPath, "direct-save").rawDocument, "# retained\nformat = '$directory'\n");
    return false;
  };
  try {
    await f.submit();
    assert.match(f.tui.render().join("\n"), /ctrl\+s to save profile/u);
    await f.chooseSave();
    await f.running;
    assert.equal(listProfiles(f.settingsPath).length, 1);
    assert.equal(f.applied, 0);
    assert.equal(f.previews.at(-1), undefined);
    assert.equal(readFileSync(f.settingsPath, "utf8"), "# retained\nformat = '$model'\n");
  } finally {
    await f.dispose();
  }
});

for (const replaced of [false, true]) {
  test(`Ctrl+C through the command ${replaced ? "does not redraw a replaced session" : "restores the active footer"}`, async () => {
    const f = fixture(undefined, {}, "command");
    try {
      await f.submit();
      assert.match(f.previews.at(-1)?.rawDocument ?? "", /\$directory/u);
      f.sendRaw("\x03");
      if (replaced) f.controller.abort();
      await f.running;
      if (replaced) assert.ok(f.previews.at(-1));
      else assert.equal(f.previews.at(-1), undefined);
      assert.equal(f.applied, 0);
      assert.equal(readFileSync(f.settingsPath, "utf8"), "# retained\nformat = '$model'\n");
      assert.equal(f.inputListeners, 0);
      assert.equal(existsSync(f.draftPath ?? ""), false);
    } finally {
      await f.dispose();
    }
  });
}

for (const reason of ["discard", "session replacement", "component disposal"] as const) {
  test(`${reason} releases draft and child without writing active settings`, async () => {
    const f = fixture();
    try {
      await f.submit();
      if (reason === "discard") f.tui.send("\x03");
      else if (reason === "session replacement") {
        f.controller.abort();
        await f.cleanup?.();
      } else f.tui.dispose();
      assert.equal(await f.running, "close");
      assert.equal(f.applied, 0);
      assert.equal(readFileSync(f.settingsPath, "utf8"), "# retained\nformat = '$model'\n");
      assert.equal(listHistory(f.settingsPath).length, 0);
      assert.equal(existsSync(f.draftPath ?? ""), false);
    } finally {
      await f.dispose();
    }
  });
}

for (const failure of [
  "archive",
  "write",
  "apply",
  "disk conflict",
  "runtime conflict",
  "cancel confirmation",
] as const) {
  test(`save handles ${failure} without stale publication`, async () => {
    let failApply = true;
    const f = fixture(undefined, {
      ...(failure === "archive"
        ? {
            archive() {
              throw new Error("archive blocked");
            },
          }
        : {}),
      ...(failure === "write"
        ? {
            save() {
              throw new Error("write blocked");
            },
          }
        : {}),
    });
    const originalApply = f.options.apply;
    if (failure === "apply")
      f.options.apply = (loaded, ctx) => {
        if (failApply) {
          failApply = false;
          throw new Error("apply blocked");
        }
        originalApply(loaded, ctx);
      };
    f.ctx.ui.confirm = async () => {
      if (failure === "disk conflict") writeFileSync(f.settingsPath, "format = '$model$directory'\n");
      if (failure === "runtime conflict") originalApply({ ...f.loaded, rawDocument: "other runtime" }, f.ctx);
      if (failure === "cancel confirmation") f.controller.abort();
      return true;
    };
    try {
      await f.submit();
      await f.chooseSave();
      if (failure === "runtime conflict" || failure === "cancel confirmation" || failure === "apply") {
        assert.equal(await f.running, "close");
        if (failure === "apply") assert.ok(f.context.notifications.some((item) => /not applied/u.test(item.message)));
      } else {
        await f.tui.waitForOpen();
        assert.ok(f.context.notifications.some((item) => /not applied/u.test(item.message)));
        f.tui.send("\x03");
        await f.running;
      }
      const expected =
        failure === "disk conflict" ? "format = '$model$directory'\n" : "# retained\nformat = '$model'\n";
      assert.equal(readFileSync(f.settingsPath, "utf8"), expected);
      assert.equal(readProfile(f.settingsPath, "chat-draft").rawDocument, "# retained\nformat = '$directory'\n");
      assert.equal(existsSync(f.draftPath ?? ""), false);
    } finally {
      await f.dispose();
    }
  });
}

test("explicit repair retains malformed bytes in History", async () => {
  const f = fixture("format = [");
  let confirmation = "";
  f.ctx.ui.confirm = async (_title, message) => {
    confirmation = message;
    return true;
  };
  try {
    await f.submit();
    await f.chooseSave();
    assert.equal(await f.running, "applied");
    assert.match(confirmation, /invalid.*repair/su);
    const history = listHistory(f.settingsPath);
    assert.equal(history.length, 1);
  } finally {
    await f.dispose();
  }
});

test("a missing active file is created only by the explicit save action", async () => {
  const f = fixture(null);
  try {
    await f.submit();
    assert.equal(existsSync(f.settingsPath), false);
    await f.chooseSave();
    assert.equal(await f.running, "applied");
    assert.equal(f.applied, 1);
    assert.equal(listHistory(f.settingsPath).length, 0);
    assert.equal(readFileSync(f.settingsPath, "utf8"), "# retained\nformat = '$directory'\n");
  } finally {
    await f.dispose();
  }
});

test("declining application keeps the saved profile and leaves active settings unchanged", async () => {
  const f = fixture();
  f.ctx.ui.confirm = async (title) => {
    assert.equal(title, "Apply saved profile?");
    assert.equal(readProfile(f.settingsPath, "chat-draft").rawDocument, "# retained\nformat = '$directory'\n");
    assert.equal(readFileSync(f.settingsPath, "utf8"), "# retained\nformat = '$model'\n");
    return false;
  };
  try {
    await f.submit();
    await f.chooseSave();
    assert.equal(await f.running, "close");
    assert.equal(f.applied, 0);
    assert.equal(listProfiles(f.settingsPath).length, 1);
    assert.equal(listHistory(f.settingsPath).length, 0);
    assert.equal(readFileSync(f.settingsPath, "utf8"), "# retained\nformat = '$model'\n");
    assert.equal(f.previews.at(-1), undefined);
    assert.equal(existsSync(f.draftPath ?? ""), false);
  } finally {
    await f.dispose();
  }
});

test("invalid and duplicate names retry without overwriting profiles or applying early", async () => {
  const f = fixture();
  const names = ["../unsafe", "taken", "新介面"];
  let attempts = 0;
  let confirmations = 0;
  createProfile(f.settingsPath, "taken", "format = '$model'\n");
  f.ctx.ui.input = async () => {
    assert.equal(f.applied, 0);
    assert.equal(confirmations, 0);
    return names[attempts++];
  };
  f.ctx.ui.confirm = async () => {
    confirmations += 1;
    assert.equal(readProfile(f.settingsPath, "新介面").rawDocument, "# retained\nformat = '$directory'\n");
    return false;
  };
  try {
    await f.submit();
    await f.chooseSave();
    assert.equal(await f.running, "close");
    assert.equal(attempts, 3);
    assert.equal(confirmations, 1);
    assert.equal(readProfile(f.settingsPath, "taken").rawDocument, "format = '$model'\n");
    assert.equal(listProfiles(f.settingsPath).length, 2);
    assert.ok(f.context.notifications.some((item) => /Invalid profile name/u.test(item.message)));
    assert.ok(f.context.notifications.some((item) => /already exists/u.test(item.message)));
  } finally {
    await f.dispose();
  }
});

for (const cancellation of ["cancel", "owner abort", "hard cancel", "runtime change"] as const) {
  test(`naming ${cancellation} cannot save a profile or apply settings`, async () => {
    const f = fixture();
    let terminalInput: ((data: string) => unknown) | undefined;
    let released = false;
    let confirmed = false;
    f.ctx.ui.onTerminalInput = (listener) => {
      terminalInput = listener;
      return () => {
        released = true;
      };
    };
    f.ctx.ui.input = async () => {
      if (cancellation === "owner abort") f.controller.abort();
      if (cancellation === "hard cancel") terminalInput?.("\x03");
      if (cancellation === "runtime change") f.options.apply({ ...f.loaded, rawDocument: "other runtime" }, f.ctx);
      return cancellation === "cancel" ? undefined : "must-not-save";
    };
    f.ctx.ui.confirm = async () => {
      confirmed = true;
      return true;
    };
    try {
      await f.submit();
      await f.chooseSave();
      if (cancellation === "cancel") {
        await f.tui.waitForOpen();
        f.tui.send("\x03");
      }
      assert.equal(await f.running, "close");
      assert.equal(confirmed, false);
      assert.equal(released, true);
      assert.equal(listProfiles(f.settingsPath).length, 0);
      assert.equal(listHistory(f.settingsPath).length, 0);
      assert.equal(readFileSync(f.settingsPath, "utf8"), "# retained\nformat = '$model'\n");
      assert.equal(existsSync(f.draftPath ?? ""), false);
    } finally {
      await f.dispose();
    }
  });
}

test("profile storage failure never opens the apply confirmation", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "pi-starship"), "not a directory");
  let attempts = 0;
  let confirmed = false;
  f.ctx.ui.input = async () => (++attempts === 1 ? "blocked" : undefined);
  f.ctx.ui.confirm = async () => {
    confirmed = true;
    return true;
  };
  try {
    await f.submit();
    await f.chooseSave();
    await f.tui.waitForOpen();
    f.tui.send("\x03");
    assert.equal(await f.running, "close");
    assert.equal(attempts, 2);
    assert.equal(confirmed, false);
    assert.equal(f.applied, 0);
    assert.equal(readFileSync(f.settingsPath, "utf8"), "# retained\nformat = '$model'\n");
    assert.ok(f.context.notifications.some((item) => /Not a safe directory/u.test(item.message)));
  } finally {
    await f.dispose();
  }
});

for (const mutation of ["edit", "remove", "replace"] as const) {
  test(`saved profile ${mutation} during apply confirmation blocks stale application`, async () => {
    const f = fixture();
    f.ctx.ui.confirm = async () => {
      const saved = readProfile(f.settingsPath, "chat-draft");
      if (mutation === "remove") unlinkSync(saved.path);
      else if (mutation === "edit") writeFileSync(saved.path, "format = '$model'\n");
      else {
        renameSync(saved.path, `${saved.path}.old`);
        writeFileSync(saved.path, saved.rawBytes);
      }
      return true;
    };
    try {
      await f.submit();
      await f.chooseSave();
      await f.tui.waitForOpen();
      assert.equal(f.applied, 0);
      assert.equal(listHistory(f.settingsPath).length, 0);
      assert.equal(readFileSync(f.settingsPath, "utf8"), "# retained\nformat = '$model'\n");
      assert.ok(f.context.notifications.some((item) => /Settings were not applied/u.test(item.message)));
      f.tui.send("\x03");
      assert.equal(await f.running, "close");
    } finally {
      await f.dispose();
    }
  });
}

for (const route of ["chat", "command"] as const) {
  test(`idle Escape preserves the ${route} editor and preview without opening actions`, async () => {
    const f = fixture(undefined, {}, route);
    let settled = false;
    void f.running.then(() => {
      settled = true;
    });
    try {
      await f.submit();
      f.tui.type("Keep this unsent request");
      const frame = f.tui.render();
      assert.match(frame.join("\n"), /Keep this unsent request/u);
      f.tui.send("\x1b");
      await Promise.resolve();
      assert.equal(settled, false);
      assert.deepEqual(f.tui.render(), frame);
      assert.match(f.previews.at(-1)?.rawDocument ?? "", /\$directory/u);
      assert.equal(f.applied, 0);
      assert.equal(listProfiles(f.settingsPath).length, 0);
      assert.equal(listHistory(f.settingsPath).length, 0);
      assert.equal(readFileSync(f.settingsPath, "utf8"), "# retained\nformat = '$model'\n");
      assert.equal(existsSync(f.draftPath ?? ""), true);
      await f.chooseSave();
      await f.running;
      assert.equal(f.applied, 1);
    } finally {
      await f.dispose();
    }
  });
}

test("disposing the save review cannot reopen chat or publish settings", async () => {
  const f = fixture();
  let confirmed = false;
  f.ctx.ui.confirm = async () => {
    confirmed = true;
    return true;
  };
  try {
    await f.submit();
    await f.chooseSave(false);
    f.tui.dispose();
    assert.equal(await f.running, "close");
    assert.equal(confirmed, false);
    assert.equal(f.applied, 0);
    assert.equal(existsSync(f.draftPath ?? ""), false);
  } finally {
    await f.dispose();
  }
});

test("child initialization failure releases the draft lease and preview", async () => {
  const f = fixture();
  f.ctx.model = undefined;
  try {
    await assert.rejects(f.running, /Select a model/u);
    assert.equal(f.cleanup, undefined);
    assert.equal(f.previews.at(-1), undefined);
    assert.equal(readFileSync(f.settingsPath, "utf8"), "# retained\nformat = '$model'\n");
  } finally {
    await f.dispose();
  }
});

test("menu action is reachable without changing existing routes and non-TUI commands never start a child", async () => {
  for (const mode of ["rpc", "json", "print"] as const) {
    const mock = createMockPi();
    let customCalls = 0;
    const context = createMockContext({
      mode,
      custom: async () => {
        customCalls += 1;
        throw new Error("unexpected UI");
      },
    });
    registerStarshipCommand(mock.pi, {
      settingsPath: "/unused/pi-starship.toml",
      getLoaded: () => loadStarshipConfig("/unused/pi-starship.toml"),
      apply() {
        assert.fail();
      },
    });
    await mock.commands.get("starship")?.handler("", context.ctx);
    await mock.commands.get("starship")?.handler("settings", context.ctx);
    assert.equal(customCalls, 0);
  }
});
