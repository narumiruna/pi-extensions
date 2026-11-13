import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { CORE_CHROME_DEVTOOLS_TOOL_NAMES as names } from "../src/tool-names.js";
import { withChromeRuntime } from "./runtime-session.js";

function provenanceEntries(manager: SessionManager) {
  return manager
    .getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === "chrome-devtools.activation-provenance");
}
for (const mode of ["direct", "lazy"] as const)
  for (const transition of ["resume", "fork"] as const)
    for (const restoreTranscript of [false, true]) {
      test(`${mode} ${transition} with ${restoreTranscript ? "transcript" : "SDK defaults"} applies pending codemode`, async () => {
        await withChromeRuntime(
          { native: true, toolMode: mode, persist: true },
          async ({ session, faux, fauxModule, file: settingsFile }) => {
            if (mode === "lazy") {
              faux.setResponses([
                fauxModule.fauxAssistantMessage(
                  fauxModule.fauxToolCall("chrome_devtools_load", { query: "list pages tabs", limit: 1 }),
                ),
                fauxModule.fauxAssistantMessage("loaded"),
              ]);
              await session.prompt("load pages");
            }
            assert.ok(session.getActiveToolNames().includes(names[0]));
            const records = provenanceEntries(session.sessionManager).length;
            faux.setResponses([
              fauxModule.fauxAssistantMessage("persist"),
              fauxModule.fauxAssistantMessage("still stable"),
            ]);
            await session.prompt("persist tool loadout");
            await session.prompt("ordinary continuation");
            assert.equal(provenanceEntries(session.sessionManager).length, records);
            assert.ok(JSON.stringify(provenanceEntries(session.sessionManager).at(-1)).includes(names[0]));
            const before = session.getActiveToolNames();
            await writeFile(settingsFile, JSON.stringify({ toolMode: "codemode", browser: { autoLaunch: false } }));
            assert.deepEqual(session.getActiveToolNames(), before);
            const file = session.sessionManager.getSessionFile();
            assert.ok(file);
            const manager =
              transition === "resume"
                ? SessionManager.open(file)
                : SessionManager.forkFrom(file, session.sessionManager.getCwd());
            assert.notEqual(manager, session.sessionManager);
            await withChromeRuntime(
              { native: true, toolMode: "codemode", sessionManager: manager, restoreTranscript },
              async ({ session: next }) => {
                assert.deepEqual(
                  next.getActiveToolNames().filter((name) => name.startsWith("chrome_devtools_")),
                  [],
                );
                assert.ok(names.every((name) => next.getCallableToolNames().includes(name)));
                assert.ok(!next.getCallableToolNames().includes("chrome_devtools_load"));
              },
            );
          },
        );
      });
    }
for (const transition of ["resume", "fork"] as const) {
  test(`${transition} preserves recorded explicit activation without retaining direct-owned peers`, async () => {
    await withChromeRuntime(
      { native: true, toolMode: "direct", persist: true, activeCapabilities: [names[0]] },
      async ({ session, faux, fauxModule }) => {
        faux.setResponses([fauxModule.fauxAssistantMessage("persist")]);
        await session.prompt("persist explicit and owned loadout");
        const file = session.sessionManager.getSessionFile();
        assert.ok(file);
        const manager =
          transition === "resume"
            ? SessionManager.open(file)
            : SessionManager.forkFrom(file, session.sessionManager.getCwd());
        await withChromeRuntime(
          { native: true, toolMode: "codemode", sessionManager: manager, restoreTranscript: true },
          async ({ session: next }) => {
            assert.deepEqual(
              next.getActiveToolNames().filter((name) => names.includes(name as never)),
              [names[0]],
            );
            assert.ok(names.every((name) => next.getCallableToolNames().includes(name)));
          },
        );
      },
    );
  });
}
