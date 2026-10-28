import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { type ConfigurationCommandOptions, reloadConfiguration } from "../src/command-configuration.js";
import { loadStarshipConfig } from "../src/config.js";
import { archiveConfigDocument } from "../src/profile-store.js";

initTheme("dark", false);

function fixture(previous: string | Buffer = "# loaded\r\nformat = 'old'\r\nfuture = true\r\n") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "starship-reload-recovery-")));
  const path = join(root, "pi-starship.toml");
  writeFileSync(path, previous);
  let loaded = loadStarshipConfig(path);
  let revision = 0;
  const options: ConfigurationCommandOptions = {
    settingsPath: path,
    getLoaded: () => loaded,
    getLoadedRevision: () => revision,
    apply(value) {
      loaded = value;
      revision += 1;
    },
  };
  const external = "# external\nformat = 'external'\n";
  writeFileSync(path, external);
  const controller = new AbortController();
  const owner = { signal: controller.signal, isCurrent: () => !controller.signal.aborted };
  const tui = createTuiHarness({ width: 60, rows: 20 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom, confirm: async () => true });
  async function reload() {
    const running = reloadConfiguration(context.ctx, options, owner);
    await tui.waitForOpen();
    tui.press("tui.select.confirm");
    return running;
  }
  const history = () =>
    readdirSync(join(root, "pi-starship", "history")).map((file) => join(root, "pi-starship", "history", file));
  return {
    root,
    path,
    options,
    external,
    controller,
    owner,
    context,
    reload,
    history,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("explicit reload archives exact previous loaded bytes before runtime apply and never rewrites external bytes", async () => {
  const f = fixture();
  try {
    const previous = f.options.getLoaded().rawBytes;
    const apply = f.options.apply;
    f.options.apply = (loaded, ctx) => {
      assert.deepEqual(readFileSync(f.history()[0] ?? ""), previous);
      assert.equal(readFileSync(f.path, "utf8"), f.external);
      apply(loaded, ctx);
    };
    assert.equal(await f.reload(), "applied");
    assert.equal(readFileSync(f.path, "utf8"), f.external);
    assert.equal(f.options.getLoaded().rawDocument, f.external);
  } finally {
    f.cleanup();
  }
});

test("explicit reload can recover an invalid previous loaded document without losing raw bytes", async () => {
  const invalid = Buffer.from([0xff, 0xfe, 0, 10]);
  const f = fixture(invalid);
  try {
    assert.equal(await f.reload(), "applied");
    assert.deepEqual(readFileSync(f.history()[0] ?? ""), invalid);
    assert.equal(readFileSync(f.path, "utf8"), f.external);
  } finally {
    f.cleanup();
  }
});

test("reload backup failure blocks runtime apply and leaves external disk bytes intact", async () => {
  const f = fixture();
  try {
    const previous = f.options.getLoaded();
    f.options.archive = () => {
      throw new Error("reload backup failed");
    };
    f.options.apply = () => {
      throw new Error("apply must not run");
    };
    assert.equal(await f.reload(), "stay");
    assert.equal(f.options.getLoaded(), previous);
    assert.equal(readFileSync(f.path, "utf8"), f.external);
    assert.match(f.context.notifications.at(-1)?.message ?? "", /reload backup failed/u);
  } finally {
    f.cleanup();
  }
});

test("reload failure retains recovery and restores runtime only, never old disk bytes", async () => {
  const f = fixture();
  try {
    const previous = f.options.getLoaded();
    const apply = f.options.apply;
    f.options.apply = (loaded, ctx) => {
      if (loaded.rawDocument === f.external) throw new Error("reload runtime failed");
      apply(loaded, ctx);
    };
    assert.equal(await f.reload(), "stay");
    assert.equal(f.options.getLoaded(), previous);
    assert.equal(readFileSync(f.path, "utf8"), f.external);
    assert.equal(f.history().length, 1);
    assert.match(
      f.context.notifications.at(-1)?.message ?? "",
      /reload runtime failed.*previous configuration was restored.*Recovery copy retained/u,
    );
  } finally {
    f.cleanup();
  }
});

test("reload rejects external changes made during recovery publication", async () => {
  const f = fixture();
  try {
    const previous = f.options.getLoaded();
    f.options.archive = (path, raw) => {
      const archived = archiveConfigDocument(path, raw);
      writeFileSync(path, "format = 'newer external'\n");
      return archived;
    };
    assert.equal(await f.reload(), "stay");
    assert.equal(f.options.getLoaded(), previous);
    assert.equal(readFileSync(f.path, "utf8"), "format = 'newer external'\n");
    assert.equal(f.history().length, 1);
  } finally {
    f.cleanup();
  }
});
