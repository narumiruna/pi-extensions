import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { reloadConfiguration, settingsDocumentScreen } from "../src/command-configuration.js";
import { registerStarshipCommand } from "../src/commands.js";
import { type LoadedStarshipConfig, loadStarshipConfig } from "../src/config.js";

const currentOwner = {
  signal: new AbortController().signal,
  isCurrent: () => true,
};

test("Configuration exposes four focused screens under seven top-level goals", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-configuration-menu-"));
  const path = join(root, "pi-starship.toml");
  const raw = "# retained comment\nformat = '$model'\nfuture = true\n";
  writeFileSync(path, raw);
  try {
    const mock = createMockPi();
    const loaded = loadStarshipConfig(path);
    let inspectionCalls = 0;
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      getInspection() {
        inspectionCalls += 1;
        return undefined;
      },
      apply() {},
      settingsPath: path,
    });
    const tui = createTuiHarness({ width: 64, rows: 18 });
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const running = mock.commands.get("starship")?.handler("", context.ctx);
    await tui.waitForOpen();
    const main = tui.render().join("\n");
    assert.equal(
      ["Customize footer", "Presets", "Explain footer", "Modules", "Configuration", "Help", "Restore built-in…"].filter(
        (label) => main.includes(label),
      ).length,
      7,
    );

    await openConfiguration(tui);
    const configuration = tui.render().join("\n");
    assert.match(configuration, /Overview/u);
    assert.match(configuration, /Effective configuration/u);
    assert.match(configuration, /Settings document/u);
    assert.match(configuration, /Reload from disk…/u);

    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    const effective = tui.render().join("\n");
    assert.match(effective, /Normalized public TOML/u);
    assert.match(effective, /\[brand\]/u);
    assert.doesNotMatch(effective, /future|retained comment|formatAst/u);
    tui.press("tui.select.cancel");
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /→ Effective configuration/u);

    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    const document = tui.render().join("\n");
    assert.match(document, /retained comment/u);
    assert.match(document, /future = true/u);
    assert.equal(readFileSync(path, "utf8"), raw);
    assert.equal(inspectionCalls, 0);
    tui.press("ctrl+c");
    await running;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Settings document preserves raw payload while its review renders safely and within width", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-document-safe-"));
  const path = join(root, "pi-starship.toml");
  try {
    const base = loadStarshipConfig(path);
    const raw = `# before\u001b[31mred\u001b[0m\u202eevil\n# tab\tcolumn and 中文 ${"x".repeat(80)}\nformat = '$model'\n`;
    const loaded: LoadedStarshipConfig = {
      ...base,
      source: "user",
      rawDocument: raw,
    };
    const screen = settingsDocumentScreen(loaded, `${path}\u001b]8;;bad\u0007label`);
    assert.equal(screen.kind, "review");
    if (screen.kind === "review") assert.equal(screen.content, raw);

    const mock = createMockPi();
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply() {},
      settingsPath: path,
    });
    const tui = createTuiHarness({ width: 24, rows: 12 });
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const running = mock.commands.get("starship")?.handler("", context.ctx);
    await tui.waitForOpen();
    await openConfiguration(tui);
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    for (const dimensions of [
      { width: 24, rows: 12 },
      { width: 18, rows: 9 },
      { width: 40, rows: 16 },
    ]) {
      const frame = tui.resize(dimensions);
      assert.ok(frame.every((line) => visibleWidth(line) <= dimensions.width));
      const text = stripVTControlCharacters(frame.join("\n"));
      assert.match(text, /beforeredevil/u);
      assert.equal(text.includes("\u202e"), false);
      assert.doesNotMatch(text, /\]8;;|\[31m/u);
    }
    assert.equal(loaded.rawDocument, raw);
    assert.equal(existsSync(path), false);
    tui.press("ctrl+c");
    await running;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("healthy missing Settings document creates no file or parent directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-document-missing-"));
  const parent = join(root, "missing");
  const path = join(parent, "pi-starship.toml");
  try {
    const loaded = loadStarshipConfig(path);
    const mock = createMockPi();
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply() {},
      settingsPath: path,
    });
    const tui = createTuiHarness({ width: 44, rows: 14 });
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const running = mock.commands.get("starship")?.handler("", context.ctx);
    await tui.waitForOpen();
    await openConfiguration(tui);
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    const frame = tui.render().join("\n");
    assert.match(frame, /No settings document exists/u);
    assert.match(frame, /Built-in defaults are active/u);
    assert.equal(existsSync(parent), false);
    let applied = 0;
    const reloadContext = createMockContext({ mode: "tui", hasUI: true });
    assert.equal(
      await reloadConfiguration(
        reloadContext.ctx,
        {
          getLoaded: () => loaded,
          apply() {
            applied += 1;
          },
          settingsPath: path,
        },
        currentOwner,
      ),
      "stay",
    );
    assert.equal(applied, 0);
    assert.equal(existsSync(parent), false);
    tui.press("ctrl+c");
    await running;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Configuration reload action returns to the updated section and restores focus", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-reload-menu-"));
  const path = join(root, "pi-starship.toml");
  writeFileSync(path, "format = '$model'\n");
  try {
    let loaded = loadStarshipConfig(path);
    writeFileSync(path, "format = '$provider'\n");
    const mock = createMockPi();
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply(next) {
        loaded = next;
      },
      settingsPath: path,
      renderPreview: (candidate) => [`Preview: ${candidate.config.format}`],
    });
    const tui = createTuiHarness({ width: 64, rows: 20 });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: tui.custom,
      confirm: async () => true,
    });
    const running = mock.commands.get("starship")?.handler("", context.ctx);
    await tui.waitForOpen();
    await openConfiguration(tui);
    for (let index = 0; index < 3; index += 1) tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Reload preview/u);
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /→ Reload from disk…/u);
    assert.equal(loaded.config.format, "$provider");
    tui.press("ctrl+c");
    await running;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Reload applies a validated external edit without changing disk bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-reload-valid-"));
  const path = join(root, "pi-starship.toml");
  writeFileSync(path, "format = '$model'\n");
  try {
    let loaded = loadStarshipConfig(path);
    let revision = 1;
    const external = "format = '$provider$directory'\nfuture = true\n";
    writeFileSync(path, external);
    let applied = 0;
    const tui = createTuiHarness({ width: 80, rows: 30 });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: tui.custom,
      confirm: async () => true,
    });
    const running = reloadConfiguration(
      context.ctx,
      {
        getLoaded: () => loaded,
        getLoadedRevision: () => revision,
        apply(next) {
          loaded = next;
          revision += 1;
          applied += 1;
        },
        settingsPath: path,
        renderPreview: (candidate) => [`Preview: ${candidate.config.format}`],
      },
      currentOwner,
    );
    await tui.waitForOpen();
    const preview = tui.render().join("\n");
    assert.match(preview, /Reload preview/u);
    assert.match(preview, /Custom configuration/u);
    assert.match(preview, /Preview:.*provider.*directory/u);
    tui.press("tui.select.confirm");
    assert.equal(await running, "applied");
    assert.equal(applied, 1);
    assert.equal(loaded.config.format, "$provider$directory");
    assert.equal(readFileSync(path, "utf8"), external);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Reload previews file removal and applies built-in defaults without creating a file", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-reload-missing-"));
  const path = join(root, "pi-starship.toml");
  writeFileSync(path, "format = '$provider'\n");
  try {
    let loaded = loadStarshipConfig(path);
    unlinkSync(path);
    const tui = createTuiHarness({ width: 50, rows: 16 });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: tui.custom,
      confirm: async () => true,
    });
    const running = reloadConfiguration(
      context.ctx,
      {
        getLoaded: () => loaded,
        apply(next) {
          loaded = next;
        },
        settingsPath: path,
        renderPreview: (candidate) => [`Preview: ${candidate.config.format}`],
      },
      currentOwner,
    );
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Built-in defaults/u);
    tui.press("tui.select.confirm");
    assert.equal(await running, "applied");
    assert.equal(loaded.source, "built-in");
    assert.equal(loaded.rawDocument, undefined);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Reload clears a recovered read-error fallback when the document is now missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-reload-recovered-missing-"));
  const path = join(root, "pi-starship.toml");
  try {
    const healthy = loadStarshipConfig(path);
    let loaded: LoadedStarshipConfig = {
      ...healthy,
      diagnostics: [{ severity: "error", path: "", message: "Unable to read settings" }],
    };
    const tui = createTuiHarness({ width: 50, rows: 16 });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: tui.custom,
      confirm: async () => true,
    });
    const running = reloadConfiguration(
      context.ctx,
      {
        getLoaded: () => loaded,
        apply(next) {
          loaded = next;
        },
        settingsPath: path,
      },
      currentOwner,
    );
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Built-in defaults/u);
    tui.press("tui.select.confirm");
    assert.equal(await running, "applied");
    assert.deepEqual(loaded.diagnostics, []);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Reload blocks unchanged, malformed, and read-error candidates without opening preview", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-reload-blocked-"));
  const path = join(root, "pi-starship.toml");
  writeFileSync(path, "format = '$model'\n");
  try {
    const loaded = loadStarshipConfig(path);
    let applied = 0;
    let confirmations = 0;
    const unchanged = createMockContext({
      mode: "tui",
      hasUI: true,
      confirm: async () => {
        confirmations += 1;
        return true;
      },
    });
    assert.equal(
      await reloadConfiguration(
        unchanged.ctx,
        {
          getLoaded: () => loaded,
          apply() {
            applied += 1;
          },
          settingsPath: path,
        },
        currentOwner,
      ),
      "stay",
    );
    assert.equal(confirmations, 0);
    assert.match(unchanged.notifications.at(-1)?.message ?? "", /already loaded/u);

    writeFileSync(path, "format = [\n");
    const malformed = createMockContext({ mode: "tui", hasUI: true });
    await reloadConfiguration(malformed.ctx, { getLoaded: () => loaded, apply() {}, settingsPath: path }, currentOwner);
    assert.match(malformed.notifications.at(-1)?.message ?? "", /parse TOML/u);

    const readError = createMockContext({ mode: "tui", hasUI: true });
    await reloadConfiguration(
      readError.ctx,
      {
        getLoaded: () => loaded,
        apply() {},
        settingsPath: path,
        read: () => {
          throw new Error("permission denied");
        },
      },
      currentOwner,
    );
    assert.match(readError.notifications.at(-1)?.message ?? "", /permission denied/u);
    assert.equal(applied, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Reload cancellation and external preview disposal preserve state and disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-reload-cancel-"));
  const path = join(root, "pi-starship.toml");
  writeFileSync(path, "format = '$model'\n");
  try {
    const loaded = loadStarshipConfig(path);
    const external = "format = '$provider'\n";
    writeFileSync(path, external);
    let applied = 0;
    const options = {
      getLoaded: () => loaded,
      apply() {
        applied += 1;
      },
      settingsPath: path,
    };

    const cancelledTui = createTuiHarness({ width: 44, rows: 14 });
    const cancelled = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: cancelledTui.custom,
    });
    const cancelledRun = reloadConfiguration(cancelled.ctx, options, currentOwner);
    await cancelledTui.waitForOpen();
    cancelledTui.press("tui.select.down");
    cancelledTui.press("tui.select.confirm");
    assert.equal(await cancelledRun, "stay");

    const disposedTui = createTuiHarness({ width: 44, rows: 14 });
    const disposed = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: disposedTui.custom,
    });
    const disposedRun = reloadConfiguration(disposed.ctx, options, currentOwner);
    await disposedTui.waitForOpen();
    disposedTui.dispose();
    assert.equal(await disposedRun, "stay");
    assert.equal(disposedTui.isOpen, false);
    assert.equal(applied, 0);
    assert.equal(readFileSync(path, "utf8"), external);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Reload rejects disk and active-state changes after preview", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-reload-stale-"));
  const path = join(root, "pi-starship.toml");
  writeFileSync(path, "format = '$model'\n");
  try {
    const loaded = loadStarshipConfig(path);
    writeFileSync(path, "format = '$provider'\n");
    let applied = 0;
    const tui = createTuiHarness({ width: 44, rows: 14 });
    const staleDisk = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: tui.custom,
      confirm: async () => {
        writeFileSync(path, "format = '$directory'\n");
        return true;
      },
    });
    const running = reloadConfiguration(
      staleDisk.ctx,
      {
        getLoaded: () => loaded,
        apply() {
          applied += 1;
        },
        settingsPath: path,
      },
      currentOwner,
    );
    await tui.waitForOpen();
    tui.press("tui.select.confirm");
    assert.equal(await running, "stay");
    assert.equal(applied, 0);
    assert.match(staleDisk.notifications.at(-1)?.message ?? "", /changed after preview/u);

    writeFileSync(path, "format = '$provider'\n");
    let revision = 1;
    const activeTui = createTuiHarness({ width: 44, rows: 14 });
    const staleActive = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: activeTui.custom,
      confirm: async () => {
        revision += 1;
        return true;
      },
    });
    const activeRunning = reloadConfiguration(
      staleActive.ctx,
      {
        getLoaded: () => loaded,
        getLoadedRevision: () => revision,
        apply() {
          applied += 1;
        },
        settingsPath: path,
      },
      currentOwner,
    );
    await activeTui.waitForOpen();
    activeTui.press("tui.select.confirm");
    assert.equal(await activeRunning, "stay");
    assert.equal(applied, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Reload restores runtime state after apply failure and reports rollback failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-reload-rollback-"));
  const path = join(root, "pi-starship.toml");
  writeFileSync(path, "format = '$model'\n");
  try {
    const previous = loadStarshipConfig(path);
    writeFileSync(path, "format = '$provider'\n");
    let active = previous;
    let calls = 0;
    const tui = createTuiHarness({ width: 44, rows: 14 });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: tui.custom,
      confirm: async () => true,
    });
    const running = reloadConfiguration(
      context.ctx,
      {
        getLoaded: () => active,
        apply(next) {
          calls += 1;
          active = next;
          if (calls === 1) throw new Error("apply failed");
        },
        settingsPath: path,
      },
      currentOwner,
    );
    await tui.waitForOpen();
    tui.press("tui.select.confirm");
    assert.equal(await running, "stay");
    assert.equal(calls, 2);
    assert.equal(active.rawDocument, previous.rawDocument);
    assert.match(context.notifications.at(-1)?.message ?? "", /previous configuration was restored/u);

    active = previous;
    const failedTui = createTuiHarness({ width: 44, rows: 14 });
    const failed = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: failedTui.custom,
      confirm: async () => true,
    });
    const failedRunning = reloadConfiguration(
      failed.ctx,
      {
        getLoaded: () => active,
        apply(next) {
          active = next;
          throw new Error(next === previous ? "rollback failed" : "apply failed");
        },
        settingsPath: path,
      },
      currentOwner,
    );
    await failedTui.waitForOpen();
    failedTui.press("tui.select.confirm");
    assert.equal(await failedRunning, "stay");
    assert.match(failed.notifications.at(-1)?.message ?? "", /rollback failed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function openConfiguration(tui: ReturnType<typeof createTuiHarness>) {
  for (let index = 0; index < 4; index += 1) tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
}
