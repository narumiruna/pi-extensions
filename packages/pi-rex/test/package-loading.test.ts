import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import {
  DefaultResourceLoader,
  type ExtensionContext,
  SettingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";

test("package directory loads through Pi Jiti and runs provider-free TUI lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rex-jiti-"));
  const settings = SettingsManager.inMemory({});
  let extension: ReturnType<DefaultResourceLoader["getExtensions"]>["extensions"][number] | undefined;
  let ctx: ExtensionContext | undefined;
  try {
    vi.stubEnv("PI_CODING_AGENT_DIR", root);
    vi.stubEnv("PATH", `${root}${delimiter}${process.env.PATH ?? ""}`);
    // Only the read-only empty-list request is allowed; no real Rex server is contacted.
    await writeFile(
      join(root, "rex"),
      `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (JSON.stringify(args) !== JSON.stringify(["--autostart=false", "--timeout", "3s", "--color", "never", "ls", "--json"])) process.exit(2);\nprocess.stdout.write('{"sessions":[]}');\n`,
      { mode: 0o755 },
    );
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [resolve("packages/pi-rex")],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    extension = loaded.extensions[0];
    assert.ok(extension);
    assert.deepEqual([...extension.commands.keys()], ["rex"]);
    let mounted: Component | undefined;
    const writes: string[] = [];
    const theme = { fg: (_role: string, value: string) => value } as Theme;
    const tui = { terminal: { rows: 36 }, requestRender() {} } as unknown as TUI;
    ctx = {
      mode: "tui",
      hasUI: true,
      cwd: root,
      sessionManager: {},
      ui: {
        theme,
        notify() {},
        setWidget(key: string, value: Parameters<ExtensionContext["ui"]["setWidget"]>[1]) {
          writes.push(key);
          mounted = typeof value === "function" ? value(tui, theme) : undefined;
        },
      },
    } as unknown as ExtensionContext;
    for (const handler of extension.handlers.get("session_start") ?? [])
      await handler({ reason: "startup" } as never, ctx);
    await extension.commands.get("rex")?.handler("", ctx as never);
    assert.match(mounted?.render(80).join("\n") ?? "", /Rex · 0 Pi sessions.*\nNo Pi sessions found/u);
    assert.ok(writes.every((key) => key === "rex"));
  } finally {
    try {
      if (extension && ctx)
        for (const handler of extension.handlers.get("session_shutdown") ?? [])
          await handler({ reason: "quit" } as never, ctx);
    } finally {
      await settings.flush();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  }
});
