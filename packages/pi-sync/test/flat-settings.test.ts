import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createCustomSelectorHarness, createMockContext } from "../../../test/support.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { showSyncManager } from "../src/ui/manager-ui.js";
import { boundedSettingsUI } from "../src/ui/settings-frame.js";
import { showSyncSettings } from "../src/ui/settings-ui.js";
import { startupTransferSummary } from "../src/ui/sync-behavior.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

initTheme("dark", false);

for (const asynchronous of [false, true]) {
  test(`settings frame guards zero width, compact mouse mapping and ${asynchronous ? "async" : "sync"} factories`, async () => {
    const tui = createTuiHarness({ width: 48, rows: 4 });
    const context = createMockContext({ mode: "tui", custom: tui.custom });
    const mouseRows: number[] = [];
    let matches = true;
    const component = {
      render: (_width: number) => [
        "rule",
        "title",
        "> search",
        matches ? "→ Active setting" : "No matching settings",
        "rule",
      ],
      invalidate() {},
      handleMouse(event: import("@earendil-works/pi-tui").TuiMouseEvent) {
        mouseRows.push(event.y);
        return { handled: true };
      },
    };
    const running = boundedSettingsUI(context.ctx).custom((_tui, _theme, _keys, done) => {
      const screen = { ...component, handleInput: () => done(undefined) };
      // Retain the public component reference after the boundary guard is installed.
      Object.assign(component, screen);
      return asynchronous ? Promise.resolve(component) : component;
    });
    try {
      await tui.waitForOpen();
      assert.deepEqual(component.render(0), []);
      assert.deepEqual(tui.render(), ["→ Active setting"]);
      tui.mouse({ type: "click", x: 1, y: 0 });
      assert.deepEqual(mouseRows, [3]);
      matches = false;
      assert.deepEqual(tui.render(), ["> search"]);
      matches = true;
      tui.resize({ width: 48, rows: 24 });
      tui.mouse({ type: "click", x: 1, y: 3 });
      assert.deepEqual(mouseRows, [3, 3]);
      tui.press("ctrl+c");
      await running;
    } finally {
      tui.dispose();
    }
  });
}

for (const [before, expected] of [
  [
    [false, false],
    [true, false],
  ],
  [
    [true, false],
    [true, true],
  ],
  [
    [true, true],
    [false, true],
  ],
  [
    [false, true],
    [false, false],
  ],
] as const) {
  test(`content/partial choice ${before.join("/")} saves ${expected.join("/")} after explicit review`, async () =>
    withTempHome(async (root) => {
      mkdirSync(root, { recursive: true });
      const settings = { ...v3S3Settings(), version: 5 };
      Object.assign(settings.syncSetups.home.sync, { mergeContent: before[0], partialSync: before[1] });
      writeFileSync(localConfigPath(), JSON.stringify(settings));
      const choices = ["Content merge / partial progress", undefined];
      const reviews: Array<{ title: string; body: string }> = [];
      const context = createMockContext({
        mode: "tui",
        select: async () => choices.shift(),
        confirm: async (title: string, body: string) => {
          reviews.push({ title, body });
          return true;
        },
      });
      await showSyncSettings(context.ctx, async () => undefined);
      const config = await loadConfig();
      assert.deepEqual([config.mergeContent, config.partialSync], expected);
      assert.ok(context.notifications.some((entry) => entry.message.startsWith("Saved reviewed policy")));
      assert.equal(reviews.length, 1);
      assert.equal(reviews[0]?.title, "Save content policy?");
      const review = reviews[0]?.body ?? "";
      assert.match(review, /upgrades settings to version 5/);
      assert.match(review, /partial snapshots use version 3 and older clients must refuse them/);
      assert.match(review, /Partial sync preserves withheld versions and old baselines/);
      assert.match(review, /Disabling does not clear unresolved groups or recovery evidence/);
      assert.match(review, /Review a directional migration first/);
      assert.doesNotMatch(`${reviews[0]?.title}\n${review}`, /experimental/i);
    }));
}

const settingLabels = [
  "Included paths",
  "Compare included paths",
  "Machine-local fields",
  "Storage location",
  "Manage sync setups",
  "Manage storage connections",
  "Automatic sync",
  "Startup transfer",
  "Autonomous sync",
  "Continuous sync",
  "On setup switch",
  "Merge settings fields",
  "Content merge / partial progress",
  "Skip secret scan",
  "Show sync status",
  "Debug startup timings",
];

test("content-policy cancellation retains the schema and saved policy", async () =>
  withTempHome(async (root) => {
    mkdirSync(root, { recursive: true });
    const before = JSON.stringify(v3S3Settings());
    writeFileSync(localConfigPath(), before);
    const choices = ["Content merge / partial progress", undefined];
    const reviews: string[] = [];
    const context = createMockContext({
      mode: "tui",
      select: async () => choices.shift(),
      confirm: async (title: string, body: string) => {
        reviews.push(`${title}\n${body}`);
        return false;
      },
    });
    await showSyncSettings(context.ctx, async () => {
      throw new Error("Settings must not start a transfer");
    });
    assert.equal(readFileSync(localConfigPath(), "utf8"), before);
    assert.equal(reviews.length, 1);
    assert.match(reviews[0] ?? "", /^Save content policy\?/);
    assert.doesNotMatch(reviews[0] ?? "", /experimental/i);
    assert.deepEqual(context.notifications, []);
  }));

test("all four opt-in Settings descriptions omit maturity markers and retain policy warnings", async () =>
  withTempHome(async (root) => {
    mkdirSync(root, { recursive: true });
    const settings = v3S3Settings();
    Object.assign(settings.syncSetups.home.sync, { continuous: true });
    const before = JSON.stringify(settings);
    writeFileSync(localConfigPath(), before);
    const descriptions = new Map<string, string>();
    const narrow: Array<{ width: number; lines: string[] }> = [];
    const context = createMockContext({
      mode: "tui",
      custom: async (factory: unknown) => {
        const harness = createCustomSelectorHarness(factory, 100, undefined, 80);
        try {
          for (const label of [
            "Autonomous sync",
            "Continuous sync",
            "Merge settings fields",
            "Content merge / partial progress",
          ]) {
            harness.handleInput("\u0015");
            harness.handleInput(`\u001b[200~${label}\u001b[201~`);
            descriptions.set(label, harness.render().join("\n").replace(/\s+/gu, " "));
            if (label === "Autonomous sync")
              for (const width of [0, 1, 12, 24, 40, 48, 100]) narrow.push({ width, lines: harness.render(width) });
          }
          harness.handleInput("\u0003");
          return await harness.resultPromise;
        } finally {
          harness.dispose();
        }
      },
    });
    await showSyncSettings(context.ctx, async () => {
      throw new Error("Settings must not start a transfer");
    });
    assert.equal(descriptions.size, 4);
    for (const [label, description] of descriptions) {
      assert.ok(description.includes(label), description);
      assert.doesNotMatch(description, /experimental|agent[ -]mode/i);
    }
    const autonomous = descriptions.get("Autonomous sync") ?? "";
    assert.match(autonomous, /Autonomous sync\s+Off/);
    assert.match(autonomous, /startup and on Sync now without transfer confirmation.*selected Pi model/);
    assert.match(autonomous, /sent to its provider and incur costs/);
    assert.match(autonomous, /replaced or deleted/);
    assert.match(autonomous, /Unresolved conflicts pause unless partial sync permits independent progress/);
    assert.match(autonomous, /Continuous sync is a separate opt-in\. No automatic reload/);
    const continuous = descriptions.get("Continuous sync") ?? "";
    assert.match(continuous, /Continuous sync\s+On/);
    assert.match(continuous, /Requires Autonomous sync/);
    assert.match(continuous, /Saved On, but paused until Autonomous sync is enabled/);
    const mergeSettings = descriptions.get("Merge settings fields") ?? "";
    assert.match(mergeSettings, /opt-in: merge independent global settings\.json root fields/);
    assert.match(mergeSettings, /Arrays and nested objects remain atomic/);
    const contentPolicy = descriptions.get("Content merge / partial progress") ?? "";
    assert.match(contentPolicy, /opt-in: review the version-5 upgrade before saving/);
    assert.match(contentPolicy, /partial progress keeps withheld versions and baselines/);
    assert.match(contentPolicy, /disabling does not clear recovery evidence/);
    assert.equal(narrow.length, 7);
    assert.deepEqual(narrow[0]?.lines, []);
    for (const { width, lines } of narrow)
      assert.ok(
        lines.every((line) => visibleWidth(line) <= width),
        `${width}: ${lines.join("\n")}`,
      );
    assert.ok(narrow.find((frame) => frame.width === 48)?.lines.some((line) => line.includes("Autonomous sync")));
    assert.equal(readFileSync(localConfigPath(), "utf8"), before);
    assert.deepEqual(context.notifications, []);
  }));

test("Settings opens all original rows in order and one Back returns directly to the manager", async () =>
  withTempHome(async (root) => {
    mkdirSync(root, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()));
    const before = readFileSync(localConfigPath());
    const frames: string[] = [];
    const rows: string[][] = [];
    const choices = ["Settings", undefined, undefined];
    const context = createMockContext({
      mode: "tui",
      select: async (frame: string, options: string[]) => {
        frames.push(frame);
        if (frame.split("\n").includes("Pi Sync Settings")) rows.push(options);
        return choices.shift();
      },
    });
    await showSyncManager(context.ctx, async () => undefined);
    assert.equal(choices.length, 0);
    assert.equal(frames.length, 3);
    assert.ok(frames[0]?.split("\n").includes("Manage sync"));
    assert.ok(frames[1]?.split("\n").includes("Pi Sync Settings"));
    assert.ok(frames[2]?.split("\n").includes("Manage sync"));
    assert.deepEqual(rows, [settingLabels]);
    assert.doesNotMatch(`${rows.flat().join("\n")}\n${frames[1] ?? ""}`, /experimental|agent[ -]mode/i);
    assert.doesNotMatch(
      frames[1] ?? "",
      /Sync content|Sync behavior|Storage & setups|Advanced|All settings|Pi Sync Settings ·/u,
    );
    assert.deepEqual(readFileSync(localConfigPath()), before);
    assert.deepEqual(context.notifications, []);
  }));

test("flat Settings uses the callback theme and retains the active row through resize", async () =>
  withTempHome(async (root) => {
    mkdirSync(root, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()));
    const before = readFileSync(localConfigPath());
    const roles = new Set<string>();
    const tui = createTuiHarness({
      width: 100,
      rows: 40,
      theme: {
        fg: (role, value) => {
          roles.add(role);
          return value;
        },
        bold: (value) => value,
      },
    });
    const context = createMockContext({ mode: "tui", custom: tui.custom });
    const running = showSyncSettings(context.ctx, async () => undefined);
    try {
      await tui.waitForOpen();
      const initial = tui.render();
      assert.ok(initial.includes("Pi Sync Settings"));
      assert.match(initial.join("\n"), /Type to search/u);
      assert.doesNotMatch(initial.join("\n"), /Sync content|Sync behavior|Storage & setups|Advanced|All settings/u);
      assert.match(initial[0] ?? "", /^─+$/u);
      assert.match(initial.at(-1) ?? "", /^─+$/u);
      assert.ok(roles.has("border"));
      assert.ok(roles.has("dim"));
      for (const rows of [4, 8, 16, 24]) {
        for (const width of [1, 12, 48, 100]) {
          tui.resize({ width, rows });
          tui.invalidate();
          const frame = tui.render();
          assert.ok(frame.length <= Math.max(1, rows - 3), `${width}x${rows}`);
          assert.ok(
            frame.every((line) => visibleWidth(line) <= width),
            `${width}x${rows}: ${frame.join("\n")}`,
          );
          if (width >= 48)
            assert.ok(
              frame.some((line) => line.includes("→ Included paths")),
              frame.join("\n"),
            );
        }
      }
      tui.press("ctrl+c");
      await running;
      assert.deepEqual(readFileSync(localConfigPath()), before);
      assert.deepEqual(context.notifications, []);
    } finally {
      tui.dispose();
    }
  }));

test("Settings search handles paste and Backspace, retains saved scope and mouse coordinates", async () =>
  withTempHome(async (root) => {
    mkdirSync(root, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()));
    const tui = createTuiHarness({ width: 48, rows: 16 });
    const context = createMockContext({ mode: "tui", custom: tui.custom });
    const routes: string[] = [];
    const running = showSyncSettings(context.ctx, async (route) => {
      routes.push(route);
    });
    try {
      await tui.waitForOpen();
      tui.send("\u001b[200~Show sync statusx\u001b[201~");
      assert.match(tui.render().join("\n"), /No matching/);
      tui.send("\u007f");
      assert.match(tui.render().join("\n"), /Show sync status.*On/);
      tui.press("tui.select.confirm");
      await tui.waitForPending();
      await tui.waitForOpen();
      assert.equal((await loadConfig()).showStatus, false);
      assert.match(tui.render().join("\n"), /Show sync status.*Off/);
      assert.ok(context.notifications.some((entry) => entry.message.startsWith("Saving")));
      assert.ok(context.notifications.some((entry) => entry.message.startsWith("Saved")));
      // Clear the searched text through the native Input editing path.
      tui.send("\u0015");
      tui.send("\u001b[200~Included paths\u001b[201~");
      const frame = tui.render();
      const y = frame.findIndex((line) => line.includes("→ Included paths"));
      assert.ok(y >= 0, frame.join("\n"));
      tui.mouse({ type: "click", x: 3, y });
      await tui.waitForPending();
      await tui.waitForOpen();
      assert.deepEqual(routes, ["files"]);
      tui.press("ctrl+c");
      await running;
    } finally {
      tui.dispose();
    }
  }));

test("startup preference reports capability requirements without claiming current eligibility", async () =>
  withTempHome(async (root) => {
    mkdirSync(root, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()));
    const config = await loadConfig();
    assert.equal(startupTransferSummary(config), "Off");
    assert.match(
      startupTransferSummary({ ...config, automaticTransfer: true }),
      /conditional-write verification required/,
    );
  }));
