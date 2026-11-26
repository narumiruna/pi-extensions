import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { showSyncManager } from "../src/ui/manager-ui.js";
import { v3WebDavSettings, withTempHome } from "./helpers.js";

for (const confirmed of [false, true])
  test(`legacy settings and accounting do not bypass Diagnostics confirmation: ${confirmed}`, () =>
    withTempHome(async (root) => {
      await fs.mkdir(path.join(root, "pi-sync", "continuous"), { recursive: true, mode: 0o700 });
      const accounting = path.join(root, "pi-sync", "continuous", `${"a".repeat(64)}.json`);
      await fs.writeFile(accounting, "private accounting evidence", { mode: 0o600 });
      const settings = v3WebDavSettings();
      Object.assign(settings.syncSetups.home.sync, { agentMode: true, continuous: true });
      const bytes = JSON.stringify(settings);
      await fs.writeFile(localConfigPath(), bytes, { mode: 0o600 });
      const choices = ["Diagnostics", undefined];
      const titles: string[] = [];
      const reviews: string[] = [];
      const routes: string[] = [];
      const mock = createMockContext({
        mode: "rpc",
        select: async (title: string) => {
          titles.push(title);
          return choices.shift();
        },
        confirm: async (_title: string, body: string) => {
          reviews.push(body);
          return confirmed;
        },
      });
      await showSyncManager(mock.ctx, async (route) => {
        routes.push(route);
        return { kind: "completed" };
      });
      assert.equal(reviews.length, 1);
      assert.match(reviews[0] ?? "", /WebDAV probes conditional writes/u);
      assert.doesNotMatch([...titles, ...reviews].join("\n"), /Accounting:|private accounting evidence/u);
      assert.deepEqual(routes, confirmed ? ["doctor"] : []);
      assert.equal(await fs.readFile(accounting, "utf8"), "private accounting evidence");
      assert.equal(await fs.readFile(localConfigPath(), "utf8"), bytes);
    }));
