import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { registerFileQuoteExtension } from "../src/file-context.js";

test("disposes and settles an active explorer on session replacement", async () => {
  await assertExplorerLifecycleCancellation("session_start");
});

test("disposes and settles an active explorer on session shutdown", async () => {
  await assertExplorerLifecycleCancellation("session_shutdown");
});

async function assertExplorerLifecycleCancellation(event: "session_start" | "session_shutdown"): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-file-context-lifecycle-test-"));
  try {
    await writeFile(join(root, "example.txt"), "needle\n");
    const mock = createMockPi();
    await registerFileQuoteExtension(mock.pi, {
      loadSettings: async () => ({ settings: { openShortcut: "ctrl+alt+f" } }),
    });
    const oldManager = { getSessionId: () => "old" };
    const newManager = { getSessionId: () => "new" };
    const tui = createTuiHarness({ width: 80, rows: 18 });
    const makeContext = (sessionManager: object, custom = tui.custom) =>
      createMockContext({
        mode: "tui",
        hasUI: true,
        cwd: root,
        sessionManager,
        ui: {
          theme: { fg: (_color: string, text: string) => text },
          notify() {},
          setWidget() {},
          setEditorComponent() {},
          getEditorComponent: () => undefined,
          custom,
          pasteToEditor() {},
        },
      });
    const oldContext = makeContext(oldManager);
    const newContext = makeContext(newManager, createTuiHarness().custom);
    await mock.events.get("session_start")?.[0]?.({}, oldContext.ctx);
    let settled = false;
    const command = Promise.resolve(mock.commands.get("file-context")?.handler("browse", oldContext.ctx)).then(() => {
      settled = true;
    });
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (tui.isOpen && tui.render().join("\n").includes("File Context")) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(tui.isOpen, true);
    assert.match(tui.render().join("\n"), /File Context/u);

    if (event === "session_start") {
      await mock.events.get(event)?.[0]?.({}, newContext.ctx);
    } else {
      await mock.events.get(event)?.[0]?.({}, oldContext.ctx);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(tui.isOpen, false);
    assert.equal(settled, true);
    await command;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
