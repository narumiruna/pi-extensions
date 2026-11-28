import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { showSyncManager } from "../src/ui/manager-ui.js";
import { v3WebDavSettings, withTempHome } from "./helpers.js";

test("legacy settings and accounting do not restore retired check actions", () =>
  withTempHome(async (root) => {
    await fs.mkdir(path.join(root, "pi-sync", "continuous"), { recursive: true, mode: 0o700 });
    const accounting = path.join(root, "pi-sync", "continuous", `${"a".repeat(64)}.json`);
    await fs.writeFile(accounting, "private accounting evidence", { mode: 0o600 });
    const settings = v3WebDavSettings();
    Object.assign(settings.syncSetups.home.sync, { agentMode: true, continuous: true });
    const bytes = JSON.stringify(settings);
    await fs.writeFile(localConfigPath(), bytes, { mode: 0o600 });
    const menus: string[][] = [];
    const titles: string[] = [];
    let reviewRequests = 0;
    const routes: string[] = [];
    const mock = createMockContext({
      mode: "rpc",
      select: async (title: string, choices: string[]) => {
        titles.push(title);
        menus.push(choices);
        return undefined;
      },
      confirm: async () => {
        reviewRequests++;
        return false;
      },
    });
    await showSyncManager(mock.ctx, async (route) => {
      routes.push(route);
      return { kind: "completed" };
    });
    assert.equal(reviewRequests, 0);
    assert.ok(menus[0]?.includes("View differences"));
    assert.doesNotMatch(menus.flat().join("\n"), /Check remote status|Diagnostics/u);
    assert.doesNotMatch(titles.join("\n"), /Accounting:|private accounting evidence/u);
    assert.deepEqual(routes, []);
    assert.equal(await fs.readFile(accounting, "utf8"), "private accounting evidence");
    assert.equal(await fs.readFile(localConfigPath(), "utf8"), bytes);
  }));
