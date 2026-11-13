import assert from "node:assert/strict";
import { test } from "vitest";
import { CORE_CHROME_DEVTOOLS_TOOL_NAMES as names } from "../src/tool-names.js";
import { withChromeRuntime } from "./runtime-session.js";

for (const scenario of ["missing", "old", "legacy", "explicit"] as const)
  for (const hostCodemode of [false, true]) {
    test(`${scenario} codemode warns only when host codemode is inactive (${hostCodemode})`, async () => {
      await withChromeRuntime(
        {
          native: true,
          toolMode: "codemode",
          hostCodemode,
          legacySettings: scenario === "legacy",
          settingsText:
            scenario === "missing"
              ? null
              : scenario === "explicit"
                ? undefined
                : JSON.stringify({ browser: { autoLaunch: false } }),
        },
        async ({ session, notifications }) => {
          assert.equal(session.getActiveToolNames().includes("codemode"), hostCodemode);
          assert.ok(session.getActiveToolNames().includes("read"));
          const warnings = notifications.filter((item) => item.message.includes("codemode tool, but it is not active"));
          assert.equal(warnings.length, hostCodemode ? 0 : 1);
          if (!hostCodemode) {
            assert.equal(warnings[0].level, "warning");
            assert.match(warnings[0].message, /defaultTools.*reload.*direct\/lazy/);
          }
        },
      );
    });
  }
for (const toolMode of ["direct", "lazy"] as const)
  test(`${toolMode} does not warn about inactive codemode`, async () => {
    await withChromeRuntime({ native: true, toolMode, hostCodemode: false }, async ({ notifications }) =>
      assert.ok(!notifications.some((item) => item.message.includes("codemode tool, but it is not active"))),
    );
  });
for (const selection of ["empty", "fully-explicit"] as const)
  test(`codemode ${selection} does not warn about unreachable capabilities`, async () => {
    await withChromeRuntime(
      {
        native: true,
        toolMode: "codemode",
        hostCodemode: false,
        ...(selection === "empty" ? { tools: [] } : { activeCapabilities: names }),
      },
      async ({ notifications }) =>
        assert.ok(!notifications.some((item) => item.message.includes("codemode tool, but it is not active"))),
    );
  });
