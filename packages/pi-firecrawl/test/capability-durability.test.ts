import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { FirecrawlToolName } from "../src/tool-names.js";
import { createMockPi } from "./mock-pi.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
for (const boundary of ["reload", "switch", "shutdown"] as const) {
  for (const path of ["command", "helper", "failed-helper"] as const) {
    test(`accepted ${path} capability persistence survives ${boundary} without stale actions`, async () => {
      const root = mkdtempSync(join(tmpdir(), "pi-firecrawl-cap-durability-"));
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = root;
      vi.resetModules();
      try {
        const file = join(root, "pi-firecrawl.json");
        const initial = ["firecrawl_scrape", "firecrawl_search"];
        writeFileSync(file, JSON.stringify({ toolMode: "codemode", tools: initial, updatedAt: 1, future: "retained" }));
        const settings = await import("../src/settings.js");
        const modeSave = settings.saveToolMode;
        const started = deferred();
        const release = deferred();
        vi.spyOn(settings, "saveToolMode").mockImplementation((mode, fallback) =>
          modeSave(mode, fallback, {
            write: async (file, data) => {
              writeFileSync(file, data);
              started.resolve();
              await release.promise;
            },
          }),
        );
        if (path === "failed-helper") {
          const save = settings.saveSettings;
          vi.spyOn(settings, "saveSettings").mockImplementation((value) =>
            save(value, {
              rename: async () => {
                throw new Error("atomic failure");
              },
            }),
          );
        }
        const { default: extension } = await import("../src/firecrawl.js");
        const { setFirecrawlToolMode, setSelectedFirecrawlTools } = await import("../src/tool-selector.js");
        const mock = createMockPi({ activeTools: ["codemode", "other"] });
        const old = createMockContext({ mode: "rpc", hasUI: true });
        const replacement = createMockContext();
        extension(mock.pi);
        await mock.events.get("session_start")?.[0]?.({}, old.ctx);
        const blocker = setFirecrawlToolMode(mock.pi, old.ctx, "direct");
        await started.promise;
        const selection: FirecrawlToolName[] = ["firecrawl_crawl"];
        const edit =
          path === "command"
            ? mock.commands.get("firecrawl")?.handler("disable", old.ctx)
            : setSelectedFirecrawlTools(mock.pi, old.ctx, selection);
        selection.push("firecrawl_map"); // Acceptance must copy caller-owned payloads.
        const hook = boundary === "shutdown" ? "session_shutdown" : "session_start";
        const restart = mock.events.get(hook)?.[0]?.(
          { reason: boundary },
          boundary === "shutdown" ? old.ctx : replacement.ctx,
        );
        release.resolve();
        await Promise.all([blocker, edit, restart]);
        const document = JSON.parse(readFileSync(file, "utf8"));
        const expected = path === "command" ? [] : path === "failed-helper" ? initial : ["firecrawl_crawl"];
        assert.equal(document.toolMode, "direct");
        assert.deepEqual(document.tools, expected);
        assert.equal(document.future, "retained");
        assert.deepEqual(old.notifications, []);
        assert.deepEqual(replacement.notifications, []);
        if (boundary === "shutdown") await mock.events.get("session_start")?.[0]?.({}, replacement.ctx);
        assert.deepEqual(mock.rawPi.getActiveTools(), ["codemode", "other", ...expected]);
      } finally {
        vi.restoreAllMocks();
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
