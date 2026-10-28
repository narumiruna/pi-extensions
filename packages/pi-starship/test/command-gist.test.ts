import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { importSettingsGist, shareSettingsGist } from "../src/command-gist.js";
import { registerStarshipCommand, type StarshipCommandOptions } from "../src/commands.js";
import { BUILT_IN_EXAMPLE, loadStarshipConfig } from "../src/config.js";
import type { GhApi } from "../src/gist.js";

initTheme("dark", false);
const id = "0123456789abcdef0123456789abcdef";
const raw = "# shared comment\nformat = '$model'\nfuture = true\n";
const gistResponse = (content = raw) =>
  JSON.stringify({ files: { "pi-starship.toml": { content, truncated: false } } });

function fixture(api: GhApi = async () => gistResponse()) {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-gist-command-"));
  const path = join(root, "pi-starship.toml");
  let loaded = loadStarshipConfig(path);
  let revision = 0;
  let applies = 0;
  const controller = new AbortController();
  const owner = { signal: controller.signal, isCurrent: () => !controller.signal.aborted };
  const options: StarshipCommandOptions = {
    settingsPath: path,
    getLoaded: () => loaded,
    getLoadedRevision: () => revision,
    getMenuOwner: () => owner,
    gistApi: api,
    apply(next) {
      loaded = next;
      revision += 1;
      applies += 1;
    },
    renderPreview: () => ["Candidate footer"],
  };
  const tui = createTuiHarness({ width: 90, rows: 30 });
  const baseContext = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom, input: async () => id });
  const context = { ...baseContext, ctx: baseContext.ctx as ExtensionCommandContext };
  return {
    path,
    options,
    owner,
    controller,
    tui,
    context,
    get applies() {
      return applies;
    },
    change() {
      revision += 1;
    },
    cleanup() {
      controller.abort();
      tui.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function waitForText(tui: ReturnType<typeof createTuiHarness>, text: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (tui.isOpen && tui.render().join("\n").includes(text)) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`Expected screen: ${text}; actual: ${tui.isOpen ? tui.render().join("\n") : "closed"}`);
}

async function waitForNotice(f: ReturnType<typeof fixture>, pattern: RegExp) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (f.context.notifications.some((item) => pattern.test(item.message))) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`Expected notification: ${pattern}; actual: ${JSON.stringify(f.context.notifications)}`);
}

async function openGistAction(f: ReturnType<typeof fixture>, action: "share" | "import") {
  const mock = createMockPi();
  registerStarshipCommand(mock.pi, f.options);
  const running = Promise.resolve(mock.commands.get("starship")?.handler("", f.context.ctx));
  await f.tui.waitForOpen();
  for (let index = 0; index < 3; index += 1) f.tui.press("tui.select.down");
  f.tui.press("tui.select.confirm");
  await f.tui.waitForOpen();
  assert.match(f.tui.render().join("\n"), /Share settings as Gist/u);
  for (let index = 0; index < (action === "share" ? 1 : 2); index += 1) f.tui.press("tui.select.down");
  f.tui.press("tui.select.confirm");
  return { running };
}

test("Gist import reviews raw TOML, previews, confirms full replacement, and preserves imported bytes", async () => {
  const f = fixture();
  const confirmations: string[] = [];
  f.context.ctx.ui.confirm = async (_title, message) => {
    confirmations.push(message);
    return true;
  };
  try {
    const { running } = await openGistAction(f, "import");
    await waitForText(f.tui, "Review Gist settings");
    assert.match(f.tui.render().join("\n"), /shared comment|future/u);
    assert.equal(existsSync(f.path), false);
    assert.equal(f.applies, 0);
    f.tui.press("tui.select.confirm");
    await waitForText(f.tui, "Gist footer preview");
    assert.equal(existsSync(f.path), false);
    f.tui.press("tui.select.confirm");
    await running;
    assert.equal(f.applies, 1);
    assert.equal(readFileSync(f.path, "utf8"), raw);
    assert.match(confirmations[0] ?? "", /entirely.*Gist.*unknown fields.*previous document.*History/u);
  } finally {
    f.cleanup();
  }
});

test("Gist import does not write when replacement is declined", async () => {
  const f = fixture();
  f.context.ctx.ui.confirm = async () => false;
  try {
    const { running } = await openGistAction(f, "import");
    await waitForText(f.tui, "Review Gist settings");
    f.tui.press("tui.select.confirm");
    await waitForText(f.tui, "Gist footer preview");
    f.tui.press("tui.select.confirm");
    await waitForText(f.tui, "Gist footer preview");
    f.tui.press("ctrl+c");
    await running;
    assert.equal(existsSync(f.path), false);
    assert.equal(f.applies, 0);
  } finally {
    f.cleanup();
  }
});

test("Gist import blocks concurrent disk changes after review", async () => {
  const f = fixture();
  try {
    const { running } = await openGistAction(f, "import");
    await waitForText(f.tui, "Review Gist settings");
    f.tui.press("tui.select.confirm");
    await waitForText(f.tui, "Gist footer preview");
    writeFileSync(f.path, "format = 'external'\n");
    f.tui.press("tui.select.confirm");
    await waitForNotice(f, /changed/u);
    await waitForText(f.tui, "Gist footer preview");
    f.tui.press("ctrl+c");
    await running;
    assert.equal(readFileSync(f.path, "utf8"), "format = 'external'\n");
    assert.equal(f.applies, 0);
    assert.ok(
      f.context.notifications.some((item) => /Settings changed during import|changed concurrently/u.test(item.message)),
    );
  } finally {
    f.cleanup();
  }
});

test("Gist import restores the previous document when runtime application fails", async () => {
  const f = fixture();
  writeFileSync(f.path, "# previous\nformat = 'previous'\n");
  const previous = loadStarshipConfig(f.path);
  f.options.getLoaded = () => previous;
  f.options.apply = (next) => {
    if (next.rawDocument === raw) throw new Error("apply failed");
  };
  try {
    const { running } = await openGistAction(f, "import");
    await waitForText(f.tui, "Review Gist settings");
    f.tui.press("tui.select.confirm");
    await waitForText(f.tui, "Gist footer preview");
    f.tui.press("tui.select.confirm");
    await waitForNotice(f, /previous configuration was restored/u);
    await waitForText(f.tui, "Gist footer preview");
    f.tui.press("ctrl+c");
    await running;
    assert.equal(readFileSync(f.path, "utf8"), previous.rawDocument);
    assert.ok(f.context.notifications.some((item) => /previous configuration was restored/u.test(item.message)));
  } finally {
    f.cleanup();
  }
});

test("sharing defaults reviews the exact document and confirms unlisted visibility without creating local settings", async () => {
  let upload: string | undefined;
  const f = fixture(async (_args, input) => {
    upload = input;
    return JSON.stringify({ public: false, html_url: `https://gist.github.com/u/${id}` });
  });
  const confirmations: string[] = [];
  f.context.ctx.ui.confirm = async (_title, message) => {
    confirmations.push(message);
    return true;
  };
  try {
    const { running } = await openGistAction(f, "share");
    await waitForText(f.tui, "Share settings as Gist");
    assert.equal(upload, undefined);
    f.tui.press("tui.select.confirm");
    await waitForText(f.tui, "Configuration");
    assert.equal(JSON.parse(upload ?? "{}").files["pi-starship.toml"].content, BUILT_IN_EXAMPLE);
    assert.match(confirmations[0] ?? "", /Unlisted is not private/u);
    assert.ok(f.context.notifications.some((item) => item.message.includes(`https://gist.github.com/${id}`)));
    assert.equal(existsSync(f.path), false);
    assert.equal(f.applies, 0);
    f.tui.press("ctrl+c");
    await running;
  } finally {
    f.cleanup();
  }
});

for (const mode of ["rpc", "print", "json"] as const) {
  test(`Gist workflows reject ${mode} before dialogs or API work`, async () => {
    const f = fixture();
    let calls = 0;
    const context = createMockContext({
      mode,
      hasUI: mode === "rpc",
      custom: () => {
        calls += 1;
      },
      input: () => {
        calls += 1;
      },
    });
    const api: GhApi = async () => {
      calls += 1;
      return gistResponse();
    };
    try {
      await shareSettingsGist(context.ctx, f.options, f.owner, api);
      await importSettingsGist(
        context.ctx,
        f.options,
        f.owner,
        async () => {
          calls += 1;
          return "applied";
        },
        api,
      );
      assert.equal(calls, 0);
    } finally {
      f.cleanup();
    }
  });
}

for (const action of ["cancel", "dispose", "session-replacement", "session-shutdown"] as const) {
  test(`Gist import releases pending work on ${action} and never applies a late result`, async () => {
    const f = fixture();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted = false;
    let reviews = 0;
    const running = importSettingsGist(
      f.context.ctx,
      f.options,
      f.owner,
      async () => {
        reviews += 1;
        return "applied";
      },
      async (_args, _input, signal) => {
        started();
        return new Promise((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve(gistResponse());
            },
            { once: true },
          ),
        );
      },
    );
    try {
      await ready;
      await waitForText(f.tui, "Reading settings from GitHub");
      if (action === "cancel") f.tui.press("ctrl+c");
      else if (action === "dispose") f.tui.dispose();
      else f.controller.abort();
      await running;
      assert.equal(aborted, true);
      assert.equal(reviews, 0);
      assert.equal(existsSync(f.path), false);
    } finally {
      f.cleanup();
    }
  });
}

for (const action of ["cancel", "dispose", "session-shutdown"] as const) {
  test(`Gist upload releases pending work on ${action} without reporting a stale success`, async () => {
    const f = fixture();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted = false;
    const running = shareSettingsGist(f.context.ctx, f.options, f.owner, async (_args, _input, signal) => {
      started();
      return new Promise((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve(JSON.stringify({ public: false, html_url: `https://gist.github.com/u/${id}` }));
          },
          { once: true },
        ),
      );
    });
    try {
      await waitForText(f.tui, "Review the entire loaded document");
      f.tui.press("tui.select.confirm");
      await ready;
      await waitForText(f.tui, "Sharing settings with GitHub");
      if (action === "cancel") f.tui.press("ctrl+c");
      else if (action === "dispose") f.tui.dispose();
      else f.controller.abort();
      await running;
      assert.equal(aborted, true);
      assert.equal(f.context.notifications.length, 0);
      assert.equal(existsSync(f.path), false);
    } finally {
      f.cleanup();
    }
  });
}

test("configuration changes during a download discard its result without opening review", async () => {
  const f = fixture();
  let reviews = 0;
  try {
    const result = await importSettingsGist(
      f.context.ctx,
      f.options,
      f.owner,
      async () => {
        reviews += 1;
        return "applied";
      },
      async () => {
        f.change();
        return gistResponse();
      },
    );
    assert.equal(result, "cancel");
    assert.equal(reviews, 0);
    assert.equal(existsSync(f.path), false);
  } finally {
    f.cleanup();
  }
});

test("configuration changes during final confirmation prevent import publication", async () => {
  const f = fixture();
  f.context.ctx.ui.confirm = async () => {
    f.change();
    return true;
  };
  try {
    const { running } = await openGistAction(f, "import");
    await waitForText(f.tui, "Review Gist settings");
    f.tui.press("tui.select.confirm");
    await waitForText(f.tui, "Gist footer preview");
    f.tui.press("tui.select.confirm");
    await waitForText(f.tui, "Configuration");
    f.tui.press("ctrl+c");
    await running;
    assert.equal(existsSync(f.path), false);
    assert.equal(f.applies, 0);
  } finally {
    f.cleanup();
  }
});

test("import write failure preserves the previous document and active footer", async () => {
  const f = fixture();
  writeFileSync(f.path, "format = 'previous'\n");
  const previous = loadStarshipConfig(f.path);
  f.options.getLoaded = () => previous;
  f.options.save = () => {
    throw new Error("disk full");
  };
  try {
    const { running } = await openGistAction(f, "import");
    await waitForText(f.tui, "Review Gist settings");
    f.tui.press("tui.select.confirm");
    await waitForText(f.tui, "Gist footer preview");
    f.tui.press("tui.select.confirm");
    await waitForNotice(f, /disk full/u);
    await waitForText(f.tui, "Gist footer preview");
    f.tui.press("ctrl+c");
    await running;
    assert.equal(readFileSync(f.path, "utf8"), "format = 'previous'\n");
    assert.equal(f.applies, 0);
    assert.ok(f.context.notifications.some((item) => item.message.includes("disk full")));
  } finally {
    f.cleanup();
  }
});

test("sharing is cancelled before external work when confirmation is declined", async () => {
  let uploads = 0;
  const f = fixture(async () => {
    uploads += 1;
    return "{}";
  });
  f.context.ctx.ui.confirm = async () => false;
  try {
    const { running } = await openGistAction(f, "share");
    await waitForText(f.tui, "Review the entire loaded document");
    f.tui.press("tui.select.confirm");
    await waitForText(f.tui, "Configuration");
    f.tui.press("ctrl+c");
    await running;
    assert.equal(uploads, 0);
    assert.equal(existsSync(f.path), false);
  } finally {
    f.cleanup();
  }
});

test("Gist review honors a non-default confirmation binding and bounded rendering", async () => {
  const f = fixture();
  const tui = createTuiHarness({
    width: 35,
    rows: 15,
    keybindings: {
      matches: (data, action) => (action === "tui.select.confirm" ? data === "l" : data === "\u001b"),
      getKeys: (action) => (action === "tui.select.confirm" ? ["l"] : ["escape"]),
    },
  });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom, input: async () => id });
  let reviews = 0;
  const running = importSettingsGist(
    context.ctx,
    f.options,
    f.owner,
    async () => {
      reviews += 1;
      return "cancel";
    },
    async () => gistResponse(),
  );
  try {
    await waitForText(tui, "Review Gist settings");
    for (const width of [1, 12, 35]) {
      assert.ok(tui.render(width).every((line) => visibleWidth(line) <= width));
    }
    tui.resize({ width: 35, rows: 15 });
    tui.type("l");
    await running;
    assert.equal(reviews, 1);
    assert.equal(existsSync(f.path), false);
  } finally {
    tui.dispose();
    f.cleanup();
  }
});

test("invalid imported TOML and transport failures leave settings unchanged", async () => {
  for (const api of [
    async () => gistResponse("format = ["),
    async () => {
      throw new Error("SECRET_TOKEN");
    },
  ]) {
    const f = fixture();
    let reviews = 0;
    try {
      await importSettingsGist(
        f.context.ctx,
        f.options,
        f.owner,
        async () => {
          reviews += 1;
          return "applied";
        },
        api,
      );
      assert.equal(reviews, 0);
      assert.equal(existsSync(f.path), false);
      assert.ok(f.context.notifications.length > 0);
      assert.ok(f.context.notifications.every((item) => !item.message.includes("SECRET_TOKEN")));
    } finally {
      f.cleanup();
    }
  }
});
