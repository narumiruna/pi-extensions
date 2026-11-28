import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { showSyncManager } from "../src/ui/manager-ui.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

initTheme("dark", false);

for (const [width, rows] of [
  [100, 32],
  [48, 16],
] as const) {
  test(`manager navigation, Settings search, Debug mode save and Back at ${width}×${rows}`, async () =>
    withTempHome(async (root) => {
      mkdirSync(root, { recursive: true });
      writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
      const tui = createTuiHarness({ width, rows });
      const context = createMockContext({ mode: "tui", custom: tui.custom });
      const routes: string[] = [];
      const owner = new AbortController();
      const running = showSyncManager(
        context.ctx,
        async (route) => {
          routes.push(route);
        },
        owner.signal,
      );
      const frame = () => {
        const lines = tui.render().map(stripTerminalSequences);
        assert.ok(lines.length <= rows - 3);
        assert.ok(
          lines.every((line) => visibleWidth(line) <= width),
          lines.join("\n"),
        );
        return lines.join("\n");
      };
      try {
        await tui.waitForOpen();
        tui.press("end");
        tui.press("tui.select.up");
        assert.match(frame(), /^→ Settings$/mu);
        assert.doesNotMatch(frame(), /Search:/u);
        tui.press("tui.select.confirm");
        await tui.waitForOpen();
        assert.match(frame(), /^Pi Sync Settings$/mu);

        tui.type("Debug modex");
        assert.match(frame(), /No matching settings; edit search/u);
        tui.press("tui.select.confirm");
        await tui.waitForPending();
        assert.deepEqual(context.notifications, []);
        tui.send("\u007f");
        assert.match(frame(), /^→ Debug mode\s+Off$/mu);
        assert.match(frame(), /recheck\s+remote\s+storage\s+without\s+asking/u);
        tui.press("tui.select.confirm");
        await tui.waitForPending();
        await tui.waitForOpen();
        assert.match(frame(), /^→ Debug mode\s+On$/mu);
        assert.match(frame(), /^Back does not undo saved changes\.$/mu);
        assert.deepEqual(context.notifications, [
          { message: "Saving Pi Sync setting…", level: "info" },
          { message: "Saved. Debug mode: On. Pi applies it at the next session start.", level: "info" },
        ]);

        tui.press("tui.select.cancel");
        await tui.waitForPending();
        await tui.waitForOpen();
        assert.doesNotMatch(frame(), /Search:/u);
        assert.match(frame(), /^→ Settings$/mu);
        assert.equal((await loadConfig()).debug, true);
        assert.deepEqual(routes, []);
      } finally {
        owner.abort();
        tui.dispose();
        await running;
      }
    }));
}
