import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  CURSOR_MARKER,
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { showIgnoreFileAction } from "../src/ui/ignore-file-ui.js";
import { installEngineFixtureHost } from "./engine-host.js";

const { run, validate } = vi.hoisted(() => ({ run: vi.fn(), validate: vi.fn() }));
vi.mock("../src/daemon/pi-client.js", () => ({ piDaemonClient: () => ({ run, validate }) }));

const path = "/agent/.work.syncignore";
const source = {
  filename: ".work.syncignore",
  path,
  text: "   # preserve surrounding whitespace\n\n",
  sourceDigest: "source-digest",
  identity: "inode-identity",
  sharingSetups: ["other\u001b[2J"],
};
const paste = (text: string) => `\u001b[200~${text}\u001b[201~`;
const keys = new KeybindingsManager(TUI_KEYBINDINGS, {
  "tui.input.submit": "ctrl+s",
  "tui.select.cancel": "ctrl+x",
});

initTheme("dark", false);
beforeEach(() => {
  installEngineFixtureHost();
  run.mockReset();
  validate.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

function fixture(action: "edit" | "switch" | "migrate" = "edit", overrides: Record<string, unknown> = {}) {
  const tui = createTuiHarness({ width: 100, rows: 40, keybindings: keys });
  const session = new AbortController();
  let sessionId = "initial";
  const read = Promise.withResolvers<unknown>();
  run.mockImplementation((op) => (op === "ignore.read" ? read.promise : Promise.resolve("saved")));
  let component: Component | undefined;
  const custom: ExtensionCommandContext["ui"]["custom"] = (factory, options) =>
    tui.custom(async (...args) => {
      component = await factory(...args);
      return component;
    }, options);
  const context = createMockContext({
    mode: "tui",
    sessionManager: { getSessionId: () => sessionId },
    custom,
    editor: vi.fn(),
    ...overrides,
  });
  const previousKeys = getKeybindings();
  setKeybindings(keys);
  const finished = showIgnoreFileAction(context.ctx, "work", action, source.filename, session.signal);
  const waitForOpen = () =>
    Promise.race([
      tui.waitForOpen(),
      finished.then(() => {
        throw new Error(`Ignore flow closed before opening UI: ${JSON.stringify(context.notifications)}`);
      }),
    ]);
  return {
    ...context,
    tui,
    session,
    finished,
    renderDirect: (width: number) => component?.render(width),
    replaceSession: () => {
      sessionId = "replacement";
    },
    waitForOpen,
    async resolveRead(value?: unknown) {
      await waitForOpen();
      const closed = tui.resultPromise;
      read.resolve(value);
      await closed;
    },
    async openEditor() {
      await this.resolveRead(source);
      await waitForOpen();
      tui.setFocused(true);
      return tui.render();
    },
    async openConfirmation() {
      tui.send("\u0013");
      await waitForOpen();
      return tui.render();
    },
    async cleanup() {
      session.abort();
      read.resolve(undefined);
      tui.dispose();
      try {
        await finished;
      } finally {
        setKeybindings(previousKeys);
      }
    },
  };
}

const operations = () => run.mock.calls.map((args) => args[0]);

for (const decision of ["confirm", "cancel", "stale-save"] as const) {
  test(`ignore draft uses native editing and requires separate approval: ${decision}`, async () => {
    const flow = fixture();
    try {
      const frame = (await flow.openEditor()).join("\n");
      expect(frame).toContain(path);
      expect(frame).toContain("Also used by: “other?[2J”");
      expect(frame).not.toContain("\u001b[2J");
      const draftPaste = `${Array.from({ length: 12 }, (_, i) => `file-${i}`).join("\n")}\n  \n`;
      flow.tui.type("x");
      flow.tui.send("\x7f");
      flow.tui.send("\x1b\r");
      flow.tui.send(paste(draftPaste));
      expect(flow.tui.render().join("\n")).toContain("[paste #1");
      flow.tui.send("\r");
      expect(flow.tui.openCount).toBe(2);
      const confirmation = (await flow.openConfirmation()).join("\n");
      expect(confirmation).toContain("Save ignore rules?");
      expect(confirmation).toContain("Also used by: “other?[2J”");
      expect(operations()).toEqual(["ignore.read"]);
      if (decision === "stale-save") run.mockRejectedValueOnce(new Error(`Ignore file changed: ${path}`));
      if (decision !== "cancel") flow.tui.press("tui.select.down");
      flow.tui.press("tui.select.confirm");
      await flow.finished;
      expect(operations()).toEqual(decision === "cancel" ? ["ignore.read"] : ["ignore.read", "ignore.save"]);
      if (decision !== "cancel") {
        expect(run.mock.calls[1]?.[1]).toEqual({
          setup: "work",
          text: `${source.text}\n${draftPaste}`,
          sourceDigest: source.sourceDigest,
          identity: source.identity,
        });
        expect(flow.notifications.at(-1)?.message).toContain(
          decision === "stale-save" ? "Ignore file changed" : "Ignore rules saved",
        );
      }
    } finally {
      await flow.cleanup();
    }
  });
}

test("ignore editor focus, resize, zero or narrow width and cursor retention", async () => {
  const flow = fixture();
  try {
    const frame = await flow.openEditor();
    expect(flow.tui.isFocusable).toBe(true);
    expect(flow.tui.focused).toBe(true);
    expect(visibleWidth(frame[0] ?? "")).toBe(100);
    expect(frame[0]).toBe(frame.at(-1));
    expect(frame.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
    flow.tui.setFocused(false);
    expect(flow.tui.render().join("\n")).not.toContain(CURSOR_MARKER);
    flow.tui.setFocused(true);
    expect(flow.renderDirect(0)).toEqual([]);
    for (const width of [1, 10, 32, 65]) {
      const lines = flow.tui.resize({ width, rows: 4 });
      expect(lines).toHaveLength(1);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines[0]).toContain(CURSOR_MARKER);
    }
    flow.tui.invalidate();
    expect(flow.tui.resize({ width: 100, rows: 40 }).join("\n")).toContain(path);
    flow.tui.send("\u0018");
    await flow.finished;
    expect(operations()).toEqual(["ignore.read"]);
  } finally {
    await flow.cleanup();
  }
});

for (const reason of ["hard-cancel", "dispose", "abort", "replaced", "unchanged"] as const) {
  test(`ignore editor never saves after ${reason}`, async () => {
    const flow = fixture();
    try {
      await flow.openEditor();
      if (reason !== "unchanged") flow.tui.type("x");
      if (reason === "hard-cancel") flow.tui.press("ctrl+c");
      else if (reason === "dispose") flow.tui.dispose();
      else if (reason === "abort") flow.session.abort();
      else {
        if (reason === "replaced") flow.replaceSession();
        flow.tui.send("\u0013");
      }
      await flow.finished;
      expect(operations()).toEqual(["ignore.read"]);
      expect(flow.tui.openCount).toBe(2);
    } finally {
      await flow.cleanup();
    }
  });
}

for (const file of [
  { filename: source.filename, path, sharingSetups: [] },
  { ...source, text: "# tab\t\n" },
  { ...source, text: "# CRLF\r\n" },
  { ...source, text: "# escape\u001b[2J\n" },
]) {
  test("missing or unsafe-to-edit existing files never open an editor", async () => {
    const flow = fixture();
    try {
      await flow.resolveRead(file);
      await flow.finished;
      expect(flow.tui.openCount).toBe(1);
      expect(operations()).toEqual(["ignore.read"]);
      expect(flow.notifications.at(-1)?.message).toContain(path);
    } finally {
      await flow.cleanup();
    }
  });
}

for (const decision of ["saved", "cancelled"]) {
  test(`switch delegates review with the exact filename and expected current value: ${decision}`, async () => {
    const flow = fixture("switch", { input: async () => ".syncignore" });
    run.mockResolvedValueOnce(decision);
    try {
      await flow.finished;
      expect(operations()).toEqual(["ignore.switch"]);
      expect(run.mock.calls[0]?.[1]).toEqual({
        setup: "work",
        filename: ".syncignore",
        expectedFilename: source.filename,
      });
      expect(flow.notifications.some(({ message }) => message.startsWith("Ignore file selected"))).toBe(
        decision === "saved",
      );
    } finally {
      await flow.cleanup();
    }
  });
}

test("migration delegates the review and save to one cancellable daemon job", async () => {
  const flow = fixture("migrate");
  try {
    await flow.finished;
    expect(operations()).toEqual(["ignore.migrate"]);
    expect(run.mock.calls[0]?.[1]).toEqual({ setup: "work" });
    expect(run.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
    expect(flow.notifications.at(-1)?.message).toContain("No transfer started");
  } finally {
    await flow.cleanup();
  }
});

for (const mode of ["rpc", "print", "json"] as const) {
  test(`ignore file in ${mode} does not read rules or open an editor`, async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/agent");
    const custom = vi.fn();
    const flow = fixture("edit", { mode, hasUI: mode === "rpc", custom });
    try {
      await flow.finished;
      expect(operations()).toEqual([]);
      expect(custom).not.toHaveBeenCalled();
      if (mode === "rpc") expect(flow.notifications.at(-1)?.message).toContain(path);
      else expect(flow.notifications).toEqual([]);
    } finally {
      await flow.cleanup();
    }
  });
}
