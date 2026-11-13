import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createCustomSelectorHarness, createMockContext } from "../../../test/support.js";
import { createMockPi } from "./mock-pi.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
for (const edits of ["mode", "mixed"] as const) {
  for (const boundary of ["reload", "switch", "shutdown"] as const) {
    for (const timing of ["queued", "in-flight"] as const) {
      test(`accepted ${edits} edits drain across ${boundary} while ${timing}`, async () => {
        const root = mkdtempSync(join(tmpdir(), "pi-firecrawl-mode-durability-"));
        const previous = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = root;
        vi.resetModules();
        initTheme("dark", false);
        try {
          const tools = ["firecrawl_scrape", "firecrawl_search"];
          const expectedTools = edits === "mixed" ? ["firecrawl_crawl", "firecrawl_search"] : tools;
          const file = join(root, "pi-firecrawl.json");
          writeFileSync(
            file,
            JSON.stringify({ toolMode: "codemode", tools, updatedAt: 1, future: { retained: true } }),
          );
          const settings = await import("../src/settings.js");
          const save = settings.saveToolMode;
          const started = deferred();
          const release = deferred();
          const saved: string[] = [];
          vi.spyOn(settings, "saveToolMode").mockImplementation((mode, fallback) =>
            save(mode, fallback, {
              write: async (path, data) => {
                saved.push(mode);
                writeFileSync(path, data);
                if (saved.length === 1) {
                  started.resolve();
                  await release.promise;
                }
              },
            }),
          );
          const { default: extension } = await import("../src/firecrawl.js");
          const mock = createMockPi({ activeTools: ["codemode", "other"] });
          const replacement = createMockContext({ mode: "json", hasUI: false });
          let replacementPromise: Promise<unknown> | undefined;
          let replaced = false;
          let settled = false;
          let blockedAtDurability = false;
          let staleRenders = 0;
          const runtimeCatalogs: string[][] = [];
          const setActive = mock.rawPi.setActiveTools.bind(mock.rawPi);
          mock.rawPi.setActiveTools = (names) => {
            if (replaced) runtimeCatalogs.push(JSON.parse(readFileSync(file, "utf8")).tools);
            setActive(names);
          };
          const { ctx, notifications } = createMockContext({
            mode: "tui",
            hasUI: true,
            custom: async (factory: unknown) => {
              const wrapped = (tui: unknown, ...args: unknown[]) =>
                (factory as (...args: unknown[]) => unknown)(
                  {
                    ...(tui as Record<string, unknown>),
                    requestRender() {
                      if (replaced) staleRenders++;
                    },
                  },
                  ...args,
                );
              const harness = createCustomSelectorHarness(wrapped);
              harness.handleInput("\r"); // lazy
              harness.handleInput("\r"); // direct: must remain FIFO even after invalidation
              if (edits === "mixed") {
                harness.handleInput("\x1b[B");
                harness.handleInput("\r"); // disable scrape
                harness.handleInput("\x1b[B");
                harness.handleInput("\r"); // enable crawl; do not overwrite search or the first delta
              }
              if (timing === "in-flight") await started.promise;
              replaced = true;
              const hook = boundary === "shutdown" ? "session_shutdown" : "session_start";
              replacementPromise = Promise.resolve(mock.events.get(hook)?.[0]?.({ reason: boundary }, replacement.ctx));
              void replacementPromise?.then(() => {
                settled = true;
              });
              await started.promise;
              blockedAtDurability = !settled;
              release.resolve();
              return harness.resultPromise;
            },
          });
          extension(mock.pi);
          await mock.events.get("session_start")?.[0]?.({}, ctx);
          await mock.commands.get("firecrawl")?.handler("settings", ctx);
          await replacementPromise;
          assert.equal(blockedAtDurability, true);
          assert.deepEqual(saved, ["lazy", "direct"]);
          const document = JSON.parse(readFileSync(file, "utf8"));
          assert.equal(document.toolMode, "direct");
          assert.deepEqual(document.tools, expectedTools);
          assert.deepEqual(document.future, { retained: true });
          assert.deepEqual(notifications, []);
          assert.deepEqual(replacement.notifications, []);
          assert.equal(staleRenders, 0);
          if (boundary === "shutdown") await mock.events.get("session_start")?.[0]?.({}, replacement.ctx);
          assert.deepEqual(mock.rawPi.getActiveTools(), ["codemode", "other", ...expectedTools]);
          assert.ok(runtimeCatalogs.every((catalog) => JSON.stringify(catalog) === JSON.stringify(expectedTools)));
        } finally {
          vi.restoreAllMocks();
          if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
          else process.env.PI_CODING_AGENT_DIR = previous;
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
}
