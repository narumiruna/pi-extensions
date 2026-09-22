import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { showNotesManager } from "../src/menu.js";
import { createNotesExtension } from "../src/notes-extension.js";
import { NotesStorage } from "../src/storage.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-notes-command-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const storage = new NotesStorage(agentDir);
  await storage.initialize();
  return { root, agentDir, storage };
}

test("manager rescans templates while navigating, copies one exactly, and opens the new note", async () => {
  const { storage } = await fixture();
  const choices = ["Create a note…", "added.md"];
  let selectCount = 0;
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    select: async () => {
      selectCount += 1;
      if (selectCount === 1) {
        await writeFile(join(storage.paths.templates, "added.md"), "# Added\n\nLiteral {{value}}\n", "utf8");
      }
      return choices.shift();
    },
    input: async () => "folder/new.md",
  });
  const controller = new AbortController();
  const result = await showNotesManager(context.ctx, storage, {
    signal: controller.signal,
    isCurrent: () => true,
  });

  assert.deepEqual(result, { kind: "open", notePath: "folder/new.md" });
  assert.equal(await readFile(join(storage.paths.notes, "folder", "new.md"), "utf8"), "# Added\n\nLiteral {{value}}\n");
  assert.equal(choices.length, 0);
});

test("manager opens an existing note in one selection", async () => {
  const { storage } = await fixture();
  await writeFile(join(storage.paths.notes, "open.md"), "# Open", "utf8");
  let selections = 0;
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    select: async () => {
      selections += 1;
      return "open.md";
    },
  });

  assert.deepEqual(
    await showNotesManager(context.ctx, storage, {
      signal: new AbortController().signal,
      isCurrent: () => true,
    }),
    { kind: "open", notePath: "open.md" },
  );
  assert.equal(selections, 1);
});

test("manager shows an empty template manager and returns without selecting a template", async () => {
  const { storage } = await fixture();
  const choices: Array<string | undefined> = ["Manage templates…", undefined, undefined];
  const renders: string[] = [];
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    select: async (title: string) => {
      renders.push(title);
      return choices.shift();
    },
  });

  assert.deepEqual(
    await showNotesManager(context.ctx, storage, {
      signal: new AbortController().signal,
      isCurrent: () => true,
    }),
    { kind: "closed" },
  );
  assert.ok(renders.some((render) => render.includes("Manage templates") && render.includes("No templates found.")));
});

test("manager cancellation leaves notes unchanged and Blank needs no seeded template", async () => {
  const { storage } = await fixture();
  const cancelled = createMockContext({ mode: "tui", hasUI: true, select: async () => undefined });
  assert.deepEqual(
    await showNotesManager(cancelled.ctx, storage, {
      signal: new AbortController().signal,
      isCurrent: () => true,
    }),
    { kind: "closed" },
  );
  assert.deepEqual((await storage.discoverNotes()).entries, []);

  const choices = ["Create a note…", "Blank"];
  const blank = createMockContext({
    mode: "tui",
    hasUI: true,
    select: async () => choices.shift(),
    input: async () => "blank.md",
  });
  assert.deepEqual(
    await showNotesManager(blank.ctx, storage, {
      signal: new AbortController().signal,
      isCurrent: () => true,
    }),
    { kind: "open", notePath: "blank.md" },
  );
  assert.equal(await readFile(join(storage.paths.notes, "blank.md"), "utf8"), "");
});

test("/notes pastes a selected note's canonical path without replacing the parent draft", async () => {
  const { agentDir, storage } = await fixture();
  const notePath = join(storage.paths.notes, "open.md");
  await writeFile(notePath, "# Open\n", "utf8");
  const mock = createMockPi({ thinkingLevel: "high" });
  let thinkingReads = 0;
  mock.rawPi.getThinkingLevel = () => {
    thinkingReads += 1;
    return "high";
  };
  let workspaceCalls = 0;
  createNotesExtension({
    getAgentDir: () => agentDir,
    createStorage: () => storage,
    showManager: showNotesManager,
    openWorkspace: async () => {
      workspaceCalls += 1;
    },
  })(mock.pi);
  const choices = ["Paste a note path…", "open.md"];
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    editorText: "parent draft: ",
    select: async () => choices.shift(),
  });

  await mock.commands.get("notes")?.handler("", context.ctx);

  const canonicalPath = await realpath(notePath);
  assert.deepEqual(context.pastedEditorTexts, [canonicalPath]);
  assert.equal(context.editorText, `parent draft: ${canonicalPath}`);
  assert.equal(thinkingReads, 0);
  assert.equal(workspaceCalls, 0);
});

test("path-paste cancellation is inert", async () => {
  const { agentDir, storage } = await fixture();
  await writeFile(join(storage.paths.notes, "open.md"), "# Open\n", "utf8");
  const mock = createMockPi();
  let workspaceCalls = 0;
  createNotesExtension({
    getAgentDir: () => agentDir,
    createStorage: () => storage,
    showManager: showNotesManager,
    openWorkspace: async () => {
      workspaceCalls += 1;
    },
  })(mock.pi);
  const choices: Array<string | undefined> = ["Paste a note path…", undefined, undefined];
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    editorText: "parent draft",
    select: async () => choices.shift(),
  });

  await mock.commands.get("notes")?.handler("", context.ctx);

  assert.deepEqual(context.pastedEditorTexts, []);
  assert.equal(context.editorText, "parent draft");
  assert.equal(workspaceCalls, 0);
});

test("stale unsafe note and template selections report safely and reopen the manager", async () => {
  for (const selectionKind of ["pastePath", "editTemplate"] as const) {
    const { agentDir, storage } = await fixture();
    const unsafePath = "unsafe\u001b]52;c;QQ==\u0007\u001b[31m\u202e.md";
    const selectedPath = join(
      selectionKind === "pastePath" ? storage.paths.notes : storage.paths.templates,
      unsafePath,
    );
    await writeFile(selectedPath, "# Removed\n", "utf8");
    const mock = createMockPi();
    let managerCalls = 0;
    let editorCalls = 0;
    let thinkingReads = 0;
    let workspaceCalls = 0;
    mock.rawPi.getThinkingLevel = () => {
      thinkingReads += 1;
      return "off";
    };
    createNotesExtension({
      getAgentDir: () => agentDir,
      createStorage: () => storage,
      showManager: async () => {
        managerCalls += 1;
        if (managerCalls > 1) return { kind: "closed" };
        await rm(selectedPath);
        return selectionKind === "pastePath"
          ? { kind: "pastePath", notePath: unsafePath }
          : { kind: "editTemplate", templatePath: unsafePath };
      },
      editTemplate: async () => {
        editorCalls += 1;
        return undefined;
      },
      openWorkspace: async () => {
        workspaceCalls += 1;
      },
    })(mock.pi);
    const context = createMockContext({ mode: "tui", hasUI: true, editorText: "parent draft" });

    await mock.commands.get("notes")?.handler("", context.ctx);

    assert.equal(managerCalls, 2);
    assert.equal(editorCalls, 0);
    assert.equal(thinkingReads, 0);
    assert.equal(workspaceCalls, 0);
    assert.deepEqual(context.pastedEditorTexts, []);
    assert.equal(context.editorText, "parent draft");
    assert.equal(context.notifications.length, 1);
    assert.equal(context.notifications[0]?.level, "error");
    assert.match(context.notifications[0]?.message ?? "", /failed to (resolve|read)/iu);
    for (const control of ["\u001b", "\u0007", "\u202e"]) {
      assert.equal((context.notifications[0]?.message ?? "").includes(control), false);
    }
  }
});

test("path paste rejects terminal-control paths without changing the parent draft", async () => {
  const { agentDir, storage } = await fixture();
  const unsafePath = "unsafe\t\u001b[201~\u202e.md";
  await writeFile(join(storage.paths.notes, unsafePath), "# Unsafe\n", "utf8");
  const mock = createMockPi();
  let managerCalls = 0;
  let thinkingReads = 0;
  let workspaceCalls = 0;
  mock.rawPi.getThinkingLevel = () => {
    thinkingReads += 1;
    return "off";
  };
  createNotesExtension({
    getAgentDir: () => agentDir,
    createStorage: () => storage,
    showManager: async () => {
      managerCalls += 1;
      return managerCalls === 1 ? { kind: "pastePath", notePath: unsafePath } : { kind: "closed" };
    },
    openWorkspace: async () => {
      workspaceCalls += 1;
    },
  })(mock.pi);
  const context = createMockContext({ mode: "tui", hasUI: true, editorText: "parent draft" });

  await mock.commands.get("notes")?.handler("", context.ctx);

  assert.equal(managerCalls, 2);
  assert.deepEqual(context.pastedEditorTexts, []);
  assert.equal(context.editorText, "parent draft");
  assert.equal(thinkingReads, 0);
  assert.equal(workspaceCalls, 0);
  assert.equal(context.notifications.length, 1);
  assert.match(context.notifications[0]?.message ?? "", /cannot paste.*control/iu);
});

test("/notes initializes lazily, opens the selected note, and does not touch parent conversation state", async () => {
  const { agentDir, storage } = await fixture();
  await writeFile(join(storage.paths.notes, "open.md"), "# Open\n", "utf8");
  const mock = createMockPi({ thinkingLevel: "medium", activeTools: ["read", "bash"] });
  const parentState = {
    messages: ["parent message"],
    tools: mock.rawPi.getActiveTools(),
    entries: [...mock.entries],
  };
  let thinkingReads = 0;
  const originalGetThinkingLevel = mock.rawPi.getThinkingLevel;
  mock.rawPi.getThinkingLevel = () => {
    thinkingReads += 1;
    return originalGetThinkingLevel();
  };
  const opened: Array<{ notePath: string; thinkingLevel: string }> = [];
  createNotesExtension({
    getAgentDir: () => agentDir,
    createStorage: () => storage,
    showManager: async () => ({ kind: "open", notePath: "open.md" }),
    openWorkspace: async ({ notePath, thinkingLevel }) => {
      opened.push({ notePath, thinkingLevel });
    },
  })(mock.pi);

  assert.equal(thinkingReads, 0, "factory load must not call Pi action methods");
  const context = createMockContext({ mode: "tui", hasUI: true });
  await mock.commands.get("notes")?.handler("", context.ctx);

  assert.deepEqual(opened, [{ notePath: "open.md", thinkingLevel: "medium" }]);
  assert.equal(thinkingReads, 1);
  assert.deepEqual(
    { messages: parentState.messages, tools: mock.rawPi.getActiveTools(), entries: mock.entries },
    parentState,
  );
});

test("template management preserves raw identity, sanitizes labels, saves, and rescans refreshed state", async () => {
  const { agentDir, storage } = await fixture();
  const rawTemplatePath = "unsafe\u001b]52;c;QQ==\u0007.md";
  const templatePath = join(storage.paths.templates, rawTemplatePath);
  await writeFile(templatePath, "old", "utf8");
  const displayPath = (await storage.discoverTemplates()).entries[0]?.displayPath;
  assert.ok(displayPath);
  const updated = "updated template\n";
  const choices: Array<string | undefined> = [
    "Manage templates…",
    displayPath,
    "Manage templates…",
    undefined,
    undefined,
  ];
  const managerRenders: string[] = [];
  let editorCalls = 0;
  let workspaceCalls = 0;
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    select: async (title: string) => {
      managerRenders.push(title);
      return choices.shift();
    },
  });
  const mock = createMockPi();
  createNotesExtension({
    getAgentDir: () => agentDir,
    createStorage: () => storage,
    showManager: showNotesManager,
    editTemplate: async (_ctx, template) => {
      editorCalls += 1;
      assert.equal(template.relativePath, rawTemplatePath);
      assert.equal(template.content, "old");
      return updated;
    },
    openWorkspace: async () => {
      workspaceCalls += 1;
    },
  })(mock.pi);

  await mock.commands.get("notes")?.handler("", context.ctx);

  assert.equal(editorCalls, 1);
  assert.equal((await storage.readTemplate(rawTemplatePath)).content, updated);
  assert.equal(workspaceCalls, 0);
  assert.equal(managerRenders.join("\n").includes("\u001b"), false);
  assert.equal(managerRenders.join("\n").includes("\u0007"), false);
  const templateManagerRenders = managerRenders.filter(
    (render) => render.includes("Manage templates") && !render.includes("Pi Notes ·"),
  );
  assert.equal(templateManagerRenders.length, 2);
  assert.match(templateManagerRenders[1] ?? "", new RegExp(`${Buffer.byteLength(updated, "utf8")} bytes`, "u"));
  assert.equal(context.notifications.length, 1);
  assert.match(context.notifications[0]?.message ?? "", /Saved template/iu);
  assert.equal((context.notifications[0]?.message ?? "").includes("\u001b"), false);
});

test("template editor cancellation and unchanged content reopen the manager without publishing", async () => {
  for (const editorResult of [undefined, "original"] as const) {
    const { agentDir, storage } = await fixture();
    await writeFile(join(storage.paths.templates, "draft.md"), "original", "utf8");
    let managerCalls = 0;
    let replaceCalls = 0;
    let workspaceCalls = 0;
    const replaceTemplate = storage.replaceTemplate.bind(storage);
    storage.replaceTemplate = async (...args: Parameters<NotesStorage["replaceTemplate"]>) => {
      replaceCalls += 1;
      return replaceTemplate(...args);
    };
    const mock = createMockPi();
    createNotesExtension({
      getAgentDir: () => agentDir,
      createStorage: () => storage,
      showManager: async () => {
        managerCalls += 1;
        return managerCalls === 1 ? { kind: "editTemplate", templatePath: "draft.md" } : { kind: "closed" };
      },
      editTemplate: async () => editorResult,
      openWorkspace: async () => {
        workspaceCalls += 1;
      },
    })(mock.pi);
    const context = createMockContext({ mode: "tui", hasUI: true });

    await mock.commands.get("notes")?.handler("", context.ctx);

    assert.equal((await storage.readTemplate("draft.md")).content, "original");
    assert.equal(replaceCalls, 0);
    assert.equal(managerCalls, 2);
    assert.equal(context.notifications.length, 0);
    assert.equal(workspaceCalls, 0);
  }
});

test("a stale template save preserves external content, reports the conflict, and refreshes the manager", async () => {
  const { agentDir, storage } = await fixture();
  const templatePath = join(storage.paths.templates, "draft.md");
  await writeFile(templatePath, "original", "utf8");
  let managerCalls = 0;
  let workspaceCalls = 0;
  const mock = createMockPi();
  createNotesExtension({
    getAgentDir: () => agentDir,
    createStorage: () => storage,
    showManager: async () => {
      managerCalls += 1;
      return managerCalls === 1 ? { kind: "editTemplate", templatePath: "draft.md" } : { kind: "closed" };
    },
    editTemplate: async () => {
      await writeFile(templatePath, "external", "utf8");
      return "editor update";
    },
    openWorkspace: async () => {
      workspaceCalls += 1;
    },
  })(mock.pi);
  const context = createMockContext({ mode: "tui", hasUI: true });

  await mock.commands.get("notes")?.handler("", context.ctx);

  assert.equal((await storage.readTemplate("draft.md")).content, "external");
  assert.equal(managerCalls, 2);
  assert.equal(workspaceCalls, 0);
  assert.equal(context.notifications.length, 1);
  assert.equal(context.notifications[0]?.level, "error");
  assert.match(context.notifications[0]?.message ?? "", /stale/iu);
});

test("/notes rejects arguments and print, JSON, and RPC modes before storage work", async () => {
  const mock = createMockPi();
  let storageCreates = 0;
  createNotesExtension({
    getAgentDir: () => "/unused",
    createStorage: (agentDir) => {
      storageCreates += 1;
      return new NotesStorage(agentDir);
    },
  })(mock.pi);
  const command = mock.commands.get("notes");
  assert.ok(command);

  const tui = createMockContext({ mode: "tui", hasUI: true });
  await command.handler("unexpected", tui.ctx);
  assert.match(tui.notifications[0]?.message ?? "", /Usage: \/notes/u);

  const headlessArguments = createMockContext({ mode: "print", hasUI: false });
  await assert.rejects(Promise.resolve(command.handler("unexpected", headlessArguments.ctx)), /Usage: \/notes/u);
  for (const mode of ["print", "json", "rpc"] as const) {
    await assert.rejects(
      Promise.resolve(command.handler("", createMockContext({ mode, hasUI: mode === "rpc" }).ctx)),
      /requires Pi TUI mode/iu,
    );
  }
  assert.equal(storageCreates, 0);
});

test("initialization failure is observable and prevents manager startup", async () => {
  const { root } = await fixture();
  const blockedAgent = join(root, "blocked-agent");
  await mkdir(blockedAgent, { recursive: true });
  await writeFile(join(blockedAgent, "pi-notes"), "blocking file", "utf8");
  const mock = createMockPi();
  let managerCalls = 0;
  createNotesExtension({
    getAgentDir: () => blockedAgent,
    showManager: async () => {
      managerCalls += 1;
      return { kind: "closed" };
    },
  })(mock.pi);
  const context = createMockContext({ mode: "tui", hasUI: true });
  await assert.rejects(
    Promise.resolve(mock.commands.get("notes")?.handler("", context.ctx)),
    /pi-notes|directory|EEXIST/iu,
  );
  assert.equal(managerCalls, 0);
});

test("a replaced session cannot paste a path resolved by a stale command", async () => {
  const { agentDir, storage } = await fixture();
  const notePath = join(storage.paths.notes, "open.md");
  await writeFile(notePath, "# Open", "utf8");
  const canonicalPath = await realpath(notePath);
  let signalResolveStarted!: () => void;
  let releaseResolve!: () => void;
  const resolveStarted = new Promise<void>((resolve) => {
    signalResolveStarted = resolve;
  });
  const resolveRelease = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  storage.resolveCanonicalNotePath = async () => {
    signalResolveStarted();
    await resolveRelease;
    return canonicalPath;
  };
  const mock = createMockPi();
  let thinkingReads = 0;
  mock.rawPi.getThinkingLevel = () => {
    thinkingReads += 1;
    return "off";
  };
  let workspaceCalls = 0;
  createNotesExtension({
    getAgentDir: () => agentDir,
    createStorage: () => storage,
    showManager: async () => ({ kind: "pastePath", notePath: "open.md" }),
    openWorkspace: async () => {
      workspaceCalls += 1;
    },
  })(mock.pi);
  const first = createMockContext({
    mode: "tui",
    hasUI: true,
    editorText: "parent draft",
    sessionManager: { id: "first" },
  });
  const second = createMockContext({ mode: "tui", hasUI: true, sessionManager: { id: "second" } });
  const start = mock.events.get("session_start")?.[0];
  assert.ok(start);
  await start({}, first.ctx);
  const command = Promise.resolve(mock.commands.get("notes")?.handler("", first.ctx));
  await resolveStarted;

  const replacement = Promise.resolve(start({}, second.ctx));
  releaseResolve();
  await replacement;
  await command;

  assert.deepEqual(first.pastedEditorTexts, []);
  assert.equal(first.editorText, "parent draft");
  assert.equal(thinkingReads, 0);
  assert.equal(workspaceCalls, 0);
});

test("session replacement and shutdown release template editing and prevent every stale continuation", async () => {
  for (const boundary of ["replacement", "shutdown"] as const) {
    const { agentDir, storage } = await fixture();
    await writeFile(join(storage.paths.templates, "draft.md"), "original", "utf8");
    const tui = createTuiHarness({ width: 72, rows: 20 });
    let managerCalls = 0;
    let replaceCalls = 0;
    let workspaceCalls = 0;
    const replaceTemplate = storage.replaceTemplate.bind(storage);
    storage.replaceTemplate = async (...args: Parameters<NotesStorage["replaceTemplate"]>) => {
      replaceCalls += 1;
      return replaceTemplate(...args);
    };
    const mock = createMockPi();
    let thinkingReads = 0;
    mock.rawPi.getThinkingLevel = () => {
      thinkingReads += 1;
      return "off";
    };
    createNotesExtension({
      getAgentDir: () => agentDir,
      createStorage: () => storage,
      showManager: async () => {
        managerCalls += 1;
        return managerCalls === 1 ? { kind: "editTemplate", templatePath: "draft.md" } : { kind: "closed" };
      },
      openWorkspace: async () => {
        workspaceCalls += 1;
      },
    })(mock.pi);
    const first = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: tui.custom,
      sessionManager: { id: `${boundary}-first` },
    });
    const second = createMockContext({
      mode: "tui",
      hasUI: true,
      sessionManager: { id: `${boundary}-second` },
    });
    const start = mock.events.get("session_start")?.[0];
    const shutdown = mock.events.get("session_shutdown")?.[0];
    assert.ok(start);
    assert.ok(shutdown);
    await start({}, first.ctx);
    const command = Promise.resolve(mock.commands.get("notes")?.handler("", first.ctx));
    await tui.waitForOpen();

    if (boundary === "replacement") await start({}, second.ctx);
    else await shutdown({}, first.ctx);
    await command;

    assert.equal(tui.isOpen, false);
    assert.equal((await storage.readTemplate("draft.md")).content, "original");
    assert.equal(replaceCalls, 0);
    assert.equal(managerCalls, 1);
    assert.equal(first.notifications.length, 0);
    assert.equal(workspaceCalls, 0);
    assert.equal(thinkingReads, 0);
  }
});

test("session replacement and shutdown abort and await active command ownership", async () => {
  const { agentDir, storage } = await fixture();
  const mock = createMockPi();
  let managerAborts = 0;
  let workspaceAborts = 0;
  let managerMode: "wait" | "open" = "wait";
  let signalManagerReady!: () => void;
  let signalWorkspaceReady!: () => void;
  const managerReady = new Promise<void>((resolve) => {
    signalManagerReady = resolve;
  });
  const workspaceReady = new Promise<void>((resolve) => {
    signalWorkspaceReady = resolve;
  });
  createNotesExtension({
    getAgentDir: () => agentDir,
    createStorage: () => storage,
    showManager: async (_ctx, _storage, ownership) => {
      if (managerMode === "open") return { kind: "open", notePath: "open.md" };
      signalManagerReady();
      await new Promise<void>((resolve) => {
        ownership.signal.addEventListener(
          "abort",
          () => {
            managerAborts += 1;
            resolve();
          },
          { once: true },
        );
      });
      return { kind: "closed" };
    },
    openWorkspace: async ({ signal }) => {
      signalWorkspaceReady();
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            workspaceAborts += 1;
            resolve();
          },
          { once: true },
        );
      });
    },
  })(mock.pi);
  await writeFile(join(storage.paths.notes, "open.md"), "# Open", "utf8");
  const first = createMockContext({ mode: "tui", hasUI: true, sessionManager: { id: "first" } });
  const second = createMockContext({ mode: "tui", hasUI: true, sessionManager: { id: "second" } });
  const start = mock.events.get("session_start")?.[0];
  const shutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(start);
  assert.ok(shutdown);

  await start({}, first.ctx);
  const selecting = Promise.resolve(mock.commands.get("notes")?.handler("", first.ctx));
  await managerReady;
  await start({}, second.ctx);
  await selecting;
  assert.equal(managerAborts, 1);

  managerMode = "open";
  const workspace = Promise.resolve(mock.commands.get("notes")?.handler("", second.ctx));
  await workspaceReady;
  await shutdown({}, second.ctx);
  await workspace;
  assert.equal(workspaceAborts, 1);
});

test("a repeated session start treats reload as an ownership boundary", async () => {
  const { agentDir, storage } = await fixture();
  await writeFile(join(storage.paths.notes, "open.md"), "# Open", "utf8");
  const mock = createMockPi();
  let signalWorkspaceReady!: () => void;
  const workspaceReady = new Promise<void>((resolve) => {
    signalWorkspaceReady = resolve;
  });
  let aborts = 0;
  createNotesExtension({
    getAgentDir: () => agentDir,
    createStorage: () => storage,
    showManager: async () => ({ kind: "open", notePath: "open.md" }),
    openWorkspace: async ({ signal }) => {
      signalWorkspaceReady();
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborts += 1;
            resolve();
          },
          { once: true },
        );
      });
    },
  })(mock.pi);
  const context = createMockContext({ mode: "tui", hasUI: true, sessionManager: { id: "same" } });
  const start = mock.events.get("session_start")?.[0];
  assert.ok(start);
  await start({}, context.ctx);
  const command = Promise.resolve(mock.commands.get("notes")?.handler("", context.ctx));
  await workspaceReady;
  await start({}, context.ctx);
  await command;
  assert.equal(aborts, 1);
});
