import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createMockPi } from "./mock-pi.js";

let root: string;
let previous: string | undefined;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "chrome-review-copy-"));
  previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  vi.resetModules();
  await import("../src/chrome-devtools.js");
});
afterEach(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
for (const toolMode of ["codemode", "direct", "lazy"] as const)
  for (const rendering of ["tui", "rpc"] as const) {
    test(`${toolMode} availability review uses accurate mode-neutral ${rendering} copy`, async () => {
      const settings = await import("../src/settings.js");
      writeFileSync(settings.settingsFilePath(), JSON.stringify({ toolMode, browser: { autoLaunch: false } }));
      const { default: extension } = await import("../src/chrome-devtools.js");
      const { showChromeDevtoolsToolWorkflow, loadChromeDevtoolsMenuSnapshot } = await import("../src/menu.js");
      const { state } = await import("../src/runtime.js");
      const mock = createMockPi({ activeTools: ["other"] });
      initTheme("dark", false);
      const tui = createTuiHarness({ width: 120, rows: 80 });
      const pages: string[] = [];
      const { ctx } = createMockContext({
        hasUI: true,
        mode: rendering,
        custom: tui.custom,
        model: {
          api: "openai-responses",
          provider: "openai",
          id: "test",
          compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: true },
        },
        select:
          rendering === "rpc"
            ? async (title: string, options: string[]) => {
                if (!title.includes("Review tool changes")) return undefined;
                pages.push(title);
                return (
                  options.find((option) => option === "Next") ??
                  options.find((option) => option.includes("Apply tool changes"))
                );
              }
            : undefined,
      });
      extension(mock.pi);
      await mock.events.get("session_start")?.[0]?.({}, ctx);
      const before = mock.rawPi.getActiveTools();
      const snapshot = await loadChromeDevtoolsMenuSnapshot(mock.pi, ctx);
      let run: ReturnType<typeof showChromeDevtoolsToolWorkflow> | undefined;
      try {
        run = showChromeDevtoolsToolWorkflow(mock.pi, ctx, state.sessionGeneration, {
          startAtReview: true,
          initialDraft: [],
          snapshot,
        });
        if (rendering === "tui") {
          await tui.waitForOpen();
          pages.push(tui.render().join("\n"));
          for (let page = 0; page < 5; page++) {
            tui.press("tui.select.pageDown");
            pages.push(tui.render().join("\n"));
          }
          tui.press("tui.select.confirm");
        }
        await run;
      } finally {
        state.sessionController.abort("Review rendering test finished");
        tui.press("ctrl+c");
        tui.dispose();
        await run;
      }
      const text = pages.join("\n");
      assert.match(text, /Enabled capabilities follow the running tool mode/);
      assert.match(text, /Disabled capabilities cannot be discovered or called/);
      assert.doesNotMatch(text, /until chrome_devtools_load|Other models expose available tools eagerly/);
      assert.deepEqual(
        mock.rawPi.getActiveTools(),
        before.filter((name) => name === "other" || name === "chrome_devtools_load"),
      );
      await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
    });
  }
