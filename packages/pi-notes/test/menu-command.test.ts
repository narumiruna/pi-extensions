import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
