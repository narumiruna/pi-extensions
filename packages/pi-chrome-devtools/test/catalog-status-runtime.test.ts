import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { test } from "vitest";
import { CORE_CHROME_DEVTOOLS_TOOL_NAMES as names } from "../src/tool-names.js";
import { withChromeRuntime } from "./runtime-session.js";

for (const toolMode of ["codemode", "lazy", "direct"] as const)
  for (const policy of ["empty", "partial"] as const)
    for (const document of ["missing", "mode-only", "invalid"] as const)
      test(`${toolMode} ${policy} status describes ${document} catalog reload behavior`, async () => {
        const tools = policy === "empty" ? [] : [names[0]];
        await withChromeRuntime({ native: true, toolMode, tools }, async ({ session, file, notifications }) => {
          if (document === "missing") await rm(file);
          else
            await writeFile(
              file,
              document === "invalid" ? "{" : JSON.stringify({ toolMode, browser: { autoLaunch: false } }),
            );
          await session.prompt("/chrome-devtools status");
          const status = notifications.at(-1)?.message ?? "";
          assert.match(
            status,
            new RegExp(
              `tools available: ${policy === "empty" ? "disabled" : "partial"} \\(${tools.length}/5 available\\)`,
            ),
          );
          if (document === "invalid") {
            assert.match(
              status,
              /Persisted tool catalog: none; current active-tool policy preserved \(invalid settings ignored:/,
            );
            assert.doesNotMatch(status, /default catalog restored/);
          } else {
            assert.match(
              status,
              /Persisted tool catalog: none; default catalog restored on \/reload or session replacement/,
            );
            assert.doesNotMatch(status, /current active-tool policy preserved/);
          }
          await session.reload();
          const exposed = names.filter((name) => session.getToolDefinition(name)?.exposure !== "hidden");
          assert.deepEqual(exposed, document === "invalid" ? tools : [...names]);
        });
      });
