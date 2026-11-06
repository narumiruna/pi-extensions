import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { AnySyncConfig } from "../src/settings/settings-types.js";
import {
  configuredSessionDir,
  sessionDirFromContext,
  snapshotOptionsForContext,
} from "../src/snapshot/session-paths.js";
import { createSnapshot } from "../src/snapshot/snapshot.js";
import { withTempHome } from "./helpers.js";

const cases = [
  { name: "legacy context without directory methods", manager: {}, expected: undefined },
  {
    name: "legacy context with a custom directory",
    manager: { getSessionDir: () => "/custom/sessions" },
    expected: "/custom/sessions",
  },
  {
    name: "default directory does not become a custom snapshot root",
    manager: { usesDefaultSessionDir: () => true, getSessionDir: () => "/default/sessions" },
    expected: undefined,
  },
  {
    name: "custom directory preserves method receiver binding",
    manager: {
      custom: "/custom/sessions",
      usesDefaultSessionDir() {
        return !this.custom;
      },
      getSessionDir() {
        return this.custom;
      },
    },
    expected: "/custom/sessions",
  },
  {
    name: "custom context without a directory getter",
    manager: { usesDefaultSessionDir: () => false },
    expected: undefined,
  },
] as const;

for (const { name, manager, expected } of cases) {
  test(`snapshot context: ${name}`, () => {
    const { ctx } = createMockContext({ sessionManager: manager });
    const config = { include: ["settings.json", "sessions"] } as AnySyncConfig;
    assert.equal(sessionDirFromContext(ctx), expected);
    assert.deepEqual(snapshotOptionsForContext(ctx, config), {
      include: config.include,
      sessionDir: expected,
    });
    assert.equal(snapshotOptionsForContext(ctx, config).include, config.include);
  });
}

for (const bom of [false, true])
  for (const sessions of [false, true])
    test(`snapshot accepts Pi settings with BOM=${bom}, sessions=${sessions}`, async () =>
      withTempHome(async (agentDir) => {
        const sessionDir = path.join(path.dirname(agentDir), "custom-sessions");
        await fs.mkdir(agentDir, { recursive: true });
        await fs.mkdir(sessionDir);
        const settings = { theme: "dark", sessionDir, future: { keep: true } };
        const content = `${bom ? "\uFEFF" : ""}${JSON.stringify(settings)}\n`;
        await fs.writeFile(path.join(agentDir, "settings.json"), content);
        await fs.writeFile(path.join(sessionDir, "conversation.jsonl"), "{}\n");
        assert.deepEqual(SettingsManager.create(agentDir, agentDir).getGlobalSettings(), settings);
        assert.equal(await configuredSessionDir(), sessionDir);

        const result = await createSnapshot("home", {
          include: ["settings.json", ...(sessions ? ["sessions"] : [])],
        });
        assert.deepEqual(
          result.files.map((file) => file.path),
          [...(sessions ? ["sessions/conversation.jsonl"] : []), "settings.json"],
        );
        assert.equal(
          Buffer.from(
            result.files.find((file) => file.path === "settings.json")?.contentBase64 ?? "",
            "base64",
          ).toString("utf8"),
          content,
        );
        assert.equal(await fs.readFile(path.join(agentDir, "settings.json"), "utf8"), content);
      }));

test("missing Pi settings remain a side-effect-free default session root", async () =>
  withTempHome(async (agentDir) => {
    assert.equal(await configuredSessionDir(), undefined);
    await assert.rejects(fs.access(agentDir), { code: "ENOENT" });
  }));

for (const content of ['{"private":"PRIVATE-SETTINGS-CONTENT",', " \uFEFF{}"])
  test(`malformed Pi settings fail closed without exposing their contents: ${content.startsWith(" ") ? "embedded BOM" : "invalid JSON"}`, async () =>
    withTempHome(async (agentDir) => {
      await fs.mkdir(agentDir, { recursive: true });
      const settingsPath = path.join(agentDir, "settings.json");
      await fs.writeFile(settingsPath, content);
      await assert.rejects(createSnapshot("home", { include: ["settings.json"] }), (error: Error) => {
        assert.match(error.message, /Pi settings.json cannot be parsed/u);
        assert.doesNotMatch(error.message, /PRIVATE-SETTINGS-CONTENT/u);
        return true;
      });
      assert.equal(await fs.readFile(settingsPath, "utf8"), content);
    }));
