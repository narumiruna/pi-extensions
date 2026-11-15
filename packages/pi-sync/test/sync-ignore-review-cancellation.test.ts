import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfig, syncConfigReviewFingerprint } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import type { PiSyncSettingsV3 } from "../src/settings/settings-types.js";
import { readSyncIgnoreFile, withSyncIgnorePublicationHookForTest } from "../src/settings/sync-ignore-file.js";
import { remoteSelectionMismatch } from "../src/sync/sync-policy.js";
import { showRemoteSelectionReview } from "../src/ui/remote-selection-ui.js";
import { snapshot, v3S3Settings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";

initTheme("dark", false);

for (const cancellation of ["ctrl+c", "remapped-back", "disposal", "session-replacement", "shutdown"] as const)
  test(`adoption drains a committed shared-policy save after ${cancellation}`, async () =>
    withTempHome(async (root) => {
      await fs.mkdir(root, { recursive: true });
      const settings = v3S3Settings() as unknown as PiSyncSettingsV3;
      settings.version = 6;
      delete settings.syncSetups.home?.sync.include;
      await fs.writeFile(localConfigPath(), JSON.stringify(settings));
      const localRules = "/sessions/\n";
      const remoteRules = "/sessions/\n*.log\n";
      await fs.writeFile(path.join(root, ".syncignore"), localRules);
      const config = await loadConfig();
      const backend = new MemorySyncBackend();
      const remote = {
        ...snapshot([{ path: ".syncignore", content: Buffer.from(remoteRules) }]),
        version: 4,
        selection: { version: 2 as const, ignore: remoteRules },
      };
      await backend.publishSnapshot(remote, { kind: "missing" });
      const decision = remoteSelectionMismatch(config, remote.selection, syncConfigReviewFingerprint(config)).decision;
      const owner = new AbortController();
      const tui = createTuiHarness({
        width: 110,
        rows: 40,
        ...(cancellation === "remapped-back"
          ? {
              keybindings: {
                matches(data: string, action: string) {
                  return action === "tui.select.cancel"
                    ? data === "\u0011"
                    : action === "tui.select.confirm"
                      ? data === "\r"
                      : action === "tui.select.down"
                        ? data === "\u001b[B"
                        : false;
                },
                getKeys(action: string) {
                  return action === "tui.select.cancel"
                    ? ["ctrl+q" as const]
                    : action === "tui.select.confirm"
                      ? ["enter" as const]
                      : action === "tui.select.down"
                        ? ["down" as const]
                        : [];
                },
              },
            }
          : {}),
      });
      const { ctx, notifications } = createMockContext({ mode: "tui", custom: tui.custom });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let settled = false;
      await withSyncIgnorePublicationHookForTest(
        async () => {
          entered.resolve();
          await release.promise;
        },
        async () => {
          const running = showRemoteSelectionReview(ctx, "home", owner.signal, () => backend, { decision });
          void running.then(() => {
            settled = true;
          });
          try {
            await tui.waitForOpen();
            tui.press("tui.select.down");
            tui.press("tui.select.confirm");
            await tui.waitForOpen();
            for (let step = 0; step < 100 && !tui.render().join("\n").includes("→ Yes,"); step++)
              tui.press("tui.select.down");
            tui.press("tui.select.confirm");
            await entered.promise;
            if (cancellation === "ctrl+c") tui.press("ctrl+c");
            else if (cancellation === "remapped-back") tui.send("\u0011");
            else if (cancellation === "disposal") tui.dispose();
            else owner.abort(new DOMException(cancellation, "AbortError"));
            await Promise.resolve();
            assert.equal(settled, false, "The flow must drain its owned durability task.");
            release.resolve();
            if (cancellation === "ctrl+c" || cancellation === "remapped-back") {
              await tui.waitForPending();
              await tui.waitForOpen();
              for (
                let attempt = 0;
                attempt < 10 && tui.render().join("\n").includes("Checking and saving");
                attempt++
              ) {
                await tui.waitForPending();
                await tui.waitForOpen();
              }
              assert.match(tui.render().join("\n"), /Remote .syncignore saved/);
              tui.press("tui.select.confirm");
            }
            await running;
            assert.equal(await readSyncIgnoreFile(), remoteRules);
            assert.equal(
              notifications.some((entry) => /adoption cancelled/i.test(entry.message)),
              false,
            );
          } finally {
            release.resolve();
            owner.abort();
            tui.dispose();
            await running;
          }
        },
      );
    }));
