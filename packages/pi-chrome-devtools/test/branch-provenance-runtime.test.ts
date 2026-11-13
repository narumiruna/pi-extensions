import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { CORE_CHROME_DEVTOOLS_TOOL_NAMES as names } from "../src/tool-names.js";
import { withChromeRuntime } from "./runtime-session.js";

test("recordless tree branch does not inherit abandoned extension ownership on reload", async () => {
  await withChromeRuntime(
    {
      native: true,
      toolMode: "direct",
      extensionPath: fileURLToPath(new URL("./fixtures/recordless-capability.ts", import.meta.url)),
      activeCapabilities: [names[0]],
    },
    async ({ session, faux, fauxModule, file, setExtensionPath }) => {
      faux.setResponses([fauxModule.fauxAssistantMessage("recordless"), fauxModule.fauxAssistantMessage("owned")]);
      await session.prompt("persist recordless host selection");
      const leaf = session.sessionManager.getLeafId();
      assert.ok(leaf);
      assert.ok(
        !session.sessionManager
          .getBranch()
          .some((entry) => entry.type === "custom" && entry.customType === "chrome-devtools.activation-provenance"),
      );
      session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== names[0]));
      setExtensionPath(fileURLToPath(new URL("../dist/index.ts", import.meta.url)));
      await session.reload();
      await session.prompt("persist extension-owned direct selection");
      const record = session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === "chrome-devtools.activation-provenance")
        .at(-1);
      assert.ok(record && record.type === "custom");
      assert.ok((record.data as { owned: string[] }).owned.includes(names[0]));
      await session.navigateTree(leaf, { summarize: false });
      assert.ok(session.getActiveToolNames().includes(names[0]));
      assert.ok(
        !session.sessionManager
          .getBranch()
          .some((entry) => entry.type === "custom" && entry.customType === "chrome-devtools.activation-provenance"),
      );
      await writeFile(file, JSON.stringify({ toolMode: "codemode", browser: { autoLaunch: false } }));
      await session.reload();
      assert.deepEqual(
        session.getActiveToolNames().filter((name) => names.includes(name as never)),
        [names[0]],
      );
    },
  );
});
