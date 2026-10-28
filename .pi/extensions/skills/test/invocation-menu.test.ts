import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  isKittyProtocolActive,
  KeybindingsManager,
  type KeyId,
  matchesKey,
  setKittyProtocolActive,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { runMenu } from "@narumitw/pi-tui-kit";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createSkillsMenu, showSkillsMenu } from "../menu.ts";
import type { Guard, Inventory } from "../types.ts";
import {
  deferred,
  env,
  fixture,
  label,
  local,
  openInvocation,
  openManage,
  project,
  select,
  skill,
  stateFixture,
  waitFrame,
} from "./invocation-test-helpers.ts";

beforeAll(() => initTheme("dark"));

describe("loaded model invocation catalog", () => {
  it("reads native skills lazily, clones them, and combines them with scanned inventory", async () => {
    const native = skill("Manual package", "/package/manual.md", true);
    const before = structuredClone(native);
    const f = fixture([native]);
    const tui = createTuiHarness();
    const ctx = f.context({ custom: tui.custom }, "tui");
    const work = showSkillsMenu(ctx, { kind: "main" }, env, f.guard, f.services);
    try {
      await waitFrame(tui, "Skills");
      expect(ctx.getSystemPromptOptions).not.toHaveBeenCalled();
      expect(f.services.readInvocation).not.toHaveBeenCalled();
      tui.press("tui.select.confirm");
      await waitFrame(tui, "→ Manual package");
      const catalog = tui.render().join("\n");
      expect(catalog).toContain("Manual only · User");
      expect(catalog).toContain("Skill: Manual package");
      expect(catalog).toContain("File: /package/manual.md");
      expect(catalog).toContain("Source: User · npm:loaded-skills");
      expect(catalog).toContain("Active: Manual only");
      expect(catalog).not.toContain("Saved:");
      expect(ctx.getSystemPromptOptions).toHaveBeenCalledTimes(1);
      expect(catalog).toContain("Scanned only");
      expect(catalog).toContain("Not loaded · Project (Pi)");
      expect(f.services.readInvocation).not.toHaveBeenCalled();
      tui.press("tui.select.confirm");
      await waitFrame(tui, /→.*Model invocation/);
      expect(f.services.readInvocation).not.toHaveBeenCalled();
      tui.press("tui.select.confirm");
      await waitFrame(tui, "Writes target: /real-target/Manual package/SKILL.md");
      const [cloned, readGuard] = f.services.readInvocation.mock.calls[0];
      expect(cloned).toEqual(native);
      expect(cloned).not.toBe(native);
      expect(cloned.sourceInfo).not.toBe(native.sourceInfo);
      expect(readGuard.signal).toBeInstanceOf(AbortSignal);
      expect(tui.render().join("\n")).toContain("Review invocation target");
      expect(f.services.updateInvocation).not.toHaveBeenCalled();
      tui.press("tui.select.confirm");
      await waitFrame(tui, /→.*Model invocation.*manual only/);
      expect(f.services.updateInvocation).not.toHaveBeenCalled();
      tui.press("tui.select.confirm");
      await tui.waitForPending();
      await waitFrame(tui, /→.*Model invocation.*automatic/);
      expect(native).toEqual(before);
    } finally {
      tui.dispose();
      await work;
    }
  });

  it("keeps scanned skills manageable but disables invocation when the native list is empty", async () => {
    const f = fixture([]);
    const blocked = "Model invocation settings require a currently loaded Pi skill";
    const rpc = createRpcHarness([
      select("Manage skills"),
      {
        kind: "select",
        options: [`Scanned only · Not loaded · Project (Pi) · ${local.path}/SKILL.md`, "Back"],
        response: `Scanned only · Not loaded · Project (Pi) · ${local.path}/SKILL.md`,
      },
      {
        kind: "select",
        options: [
          "Move…",
          "Remove…",
          "[-] Copy directory path (unavailable: Clipboard copy requires Pi TUI)",
          `[-] Model invocation (unavailable: ${blocked})`,
          "Back",
        ],
        response: `[-] Model invocation (unavailable: ${blocked})`,
      },
      select("Back"),
      select("Back"),
      select("Close"),
    ]);
    const ctx = f.context(rpc.ui, "rpc");
    expect(await showSkillsMenu(ctx, { kind: "main" }, env, f.guard, f.services)).toBe(false);
    rpc.assertConsumed();
    expect(rpc.dialogs[1].title).toContain("Loaded and detected skills are listed.");
    expect(f.services.readInvocation).not.toHaveBeenCalled();
    expect(f.services.updateInvocation).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("preserves distinct raw paths for same-name skills in RPC, including hidden terminal controls", async () => {
    const first = skill("Same", "/package/same.md");
    const second = skill("Same", "/package/\u001b[31msame.md");
    const f = fixture([first, second]);
    const rpc = createRpcHarness([
      select("Manage skills"),
      {
        kind: "select",
        options: [
          label(first),
          `${label(first)} [2]`,
          `Scanned only · Not loaded · Project (Pi) · ${local.path}/SKILL.md`,
          "Back",
        ],
        response: `${label(first)} [2]`,
      },
      select("Model invocation"),
      select("Open invocation setting"),
      select("Model invocation (automatic)"),
      select("Back"),
      select("Back"),
      select("Back"),
      select("Back"),
      select("Reload now"),
    ]);
    const ctx = f.context(rpc.ui, "rpc");
    expect(await showSkillsMenu(ctx, { kind: "main" }, env, f.guard, f.services)).toBe(true);
    rpc.assertConsumed();
    expect(f.services.readInvocation.mock.calls[0][0].filePath).toBe(second.filePath);
    expect(f.services.updateInvocation.mock.calls[0][0].filePath).toBe(second.filePath);
    expect(rpc.dialogs.map((dialog) => dialog.title).join("\n")).not.toContain("\u001b");
    expect(ctx.reload).not.toHaveBeenCalled();
    expect(first.disableModelInvocation).toBe(false);
    expect(second.disableModelInvocation).toBe(false);
  });

  it("filters sanitized names and paths without changing the selected raw skill", async () => {
    const untrusted = skill("Ze\u001b[31mbra\u202e", "/package/\u001b]0;title\u0007unique\npath/SKILL.md");
    const f = fixture([skill(), untrusted]);
    const tui = createTuiHarness({ width: 150 });
    const work = showSkillsMenu(f.context({ custom: tui.custom }, "tui"), { kind: "main" }, env, f.guard, f.services);
    try {
      await openManage(tui);
      tui.type("Zebra");
      expect(tui.render().join("\n")).not.toContain("Alpha");
      for (const _character of "Zebra") tui.send("\x7f");
      tui.type("unique path");
      const filtered = tui.render().join("\n");
      expect(filtered).toContain("→ Zebra");
      expect(filtered).toContain("Automatic · User");
      expect(filtered).toContain("File: /package/unique path/SKILL.md");
      expect(filtered).not.toContain("Alpha");
      expect(filtered).not.toContain("title");
      // Native Input emits its own cursor markers; reject the untrusted controls, not host markup.
      for (const control of ["\u001b[31m", "\u001b]0;", "\u202e"]) expect(filtered).not.toContain(control);
      tui.press("tui.select.confirm");
      await waitFrame(tui, /→.*Model invocation/);
      tui.press("tui.select.confirm");
      await waitFrame(tui, "Source file: /package/unique path/SKILL.md");
      expect(f.services.readInvocation.mock.calls[0][0]).toEqual(untrusted);
      expect(f.services.readInvocation.mock.calls[0][0].filePath).toBe(untrusted.filePath);
    } finally {
      tui.dispose();
      await work;
    }
  });

  it("reports a failed target read and permits another selection without saving", async () => {
    const f = fixture();
    f.services.readInvocation.mockRejectedValueOnce(new Error("Target unavailable\u001b[31m"));
    const rpc = createRpcHarness([
      select("Manage skills"),
      select(label(f.loaded[0])),
      select("Model invocation"),
      select("Model invocation"),
      select("Back"),
      select("Back"),
      select("Back"),
      select("Close"),
    ]);
    const ctx = f.context(rpc.ui, "rpc");
    await showSkillsMenu(ctx, { kind: "main" }, env, f.guard, f.services);
    rpc.assertConsumed();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Target unavailable", "error");
    expect(f.services.readInvocation).toHaveBeenCalledTimes(2);
    expect(f.services.updateInvocation).not.toHaveBeenCalled();
  });
});

describe("immediate invocation settings", () => {
  it.each([true, false])("shows the actual target before saving and inverts enabled=%s in RPC", async (enabled) => {
    const f = fixture([skill("Alpha", "/link/alpha/SKILL.md", !enabled)]);
    const initial = enabled ? "automatic" : "manual only";
    const next = enabled ? "manual only" : "automatic";
    const rpc = createRpcHarness([
      select("Manage skills"),
      select(label(f.loaded[0])),
      select("Model invocation"),
      select("Open invocation setting"),
      { kind: "select", options: [`Model invocation (${initial})`, "Back"], response: `Model invocation (${initial})` },
      { kind: "select", options: [`Model invocation (${next})`, "Back"], response: "Back" },
      select("Back"),
      select("Back"),
      select("Back"),
      select("Close without reload"),
    ]);
    let beforeSave: readonly { title: string }[] = [];
    f.services.updateInvocation.mockImplementationOnce(async (snapshot, value) => {
      beforeSave = rpc.dialogs;
      return { snapshot: { ...snapshot, enabled: value }, changed: true };
    });
    const ctx = f.context(rpc.ui, "rpc");
    expect(await showSkillsMenu(ctx, { kind: "main" }, env, f.guard, f.services)).toBe(false);
    rpc.assertConsumed();
    const readSnapshot = await f.services.readInvocation.mock.results[0].value;
    expect(f.services.updateInvocation).toHaveBeenCalledWith(readSnapshot, !enabled, expect.any(Object));
    expect(f.services.updateInvocation.mock.calls[0][0]).toBe(readSnapshot);
    expect(beforeSave.at(-1)?.title).toContain("Source file: /link/alpha/SKILL.md");
    expect(beforeSave.at(-1)?.title).toContain("Writes target: /real-target/Alpha/SKILL.md");
    expect(f.services.scanInventory).toHaveBeenCalledTimes(2);
    expect(rpc.dialogs.at(-1)?.options).toContain("Reload now");
    expect(rpc.dialogs.at(-1)?.options).toContain("Close without reload");
    expect(rpc.dialogs.at(-1)?.title).toContain(
      "Model invocation settings saved on disk. Reload to refresh Pi's skill catalog.",
    );
    expect(rpc.dialogs.at(-2)?.options).toContain(
      `Alpha · ${enabled ? "Manual only" : "Automatic"} (reload pending) · User · /link/alpha/SKILL.md`,
    );
    expect(f.loaded[0].disableModelInvocation).toBe(!enabled);
    expect(ctx.reload).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("does not offer reload or rescan after a no-op save", async () => {
    const f = fixture();
    f.services.updateInvocation.mockImplementation(async (snapshot) => ({ snapshot, changed: false }));
    const rpc = createRpcHarness([
      select("Manage skills"),
      select(label(f.loaded[0])),
      select("Model invocation"),
      select("Open invocation setting"),
      select("Model invocation (automatic)"),
      select("Back"),
      select("Back"),
      select("Back"),
      select("Back"),
      select("Close"),
    ]);
    const ctx = f.context(rpc.ui, "rpc");
    expect(await showSkillsMenu(ctx, { kind: "main" }, env, f.guard, f.services)).toBe(false);
    rpc.assertConsumed();
    expect(rpc.dialogs.at(-1)?.options).not.toContain("Reload now");
    expect(rpc.dialogs.at(-1)?.options).not.toContain("Close without reload");
    expect(f.services.scanInventory).toHaveBeenCalledTimes(1);
    expect(ctx.reload).not.toHaveBeenCalled();
  });

  it("retains the settings row after failure, retries, and saves both directions with non-default bindings", async () => {
    const f = fixture([skill(), skill("Beta", "/package/beta.md", true)]);
    f.services.updateInvocation.mockRejectedValueOnce(new Error("Save failed\u001b[31m"));
    const keys = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.confirm": "ctrl+y",
      "tui.select.cancel": "ctrl+g",
      "tui.select.down": "ctrl+n",
      "tui.select.up": "ctrl+p",
    });
    const tui = createTuiHarness({ keybindings: keys, width: 120 });
    const ctx = f.context({ custom: tui.custom }, "tui");
    const work = showSkillsMenu(ctx, { kind: "main" }, env, f.guard, f.services);
    try {
      await openManage(tui, "\x19");
      tui.send("\x0e");
      tui.send("\x19");
      await waitFrame(tui, /→.*Model invocation/);
      tui.send("\x19");
      await waitFrame(tui, "Review invocation target");
      expect(tui.render().join("\n")).toContain("Writes target: /real-target/Beta/SKILL.md");
      expect(f.services.updateInvocation).not.toHaveBeenCalled();
      tui.send("\x19");
      await waitFrame(tui, /→.*Model invocation.*manual only/);
      tui.send("\x19");
      await vi.waitFor(() => expect(ctx.ui.notify).toHaveBeenCalledWith("Save failed", "error"));
      await waitFrame(tui, /→.*Model invocation.*manual only/);
      tui.send("\x19");
      await tui.waitForPending();
      await waitFrame(tui, /→.*Model invocation.*automatic/);
      tui.send(" ");
      await tui.waitForPending();
      await waitFrame(tui, /→.*Model invocation.*manual only/);
      expect(f.services.updateInvocation.mock.calls.map((call) => call[1])).toEqual([true, true, false]);
      expect(f.services.scanInventory).toHaveBeenCalledTimes(3);
      tui.send("\x07");
      await waitFrame(tui, "Review invocation target");
      tui.send("\x07");
      await waitFrame(tui, /→.*Model invocation/);
      tui.send("\x07");
      await waitFrame(tui, /→.*Beta/);
      tui.send("\x07");
      await waitFrame(tui, "Close without reload");
      expect(tui.render().join("\n")).toContain("Reload now");
      expect(ctx.reload).not.toHaveBeenCalled();
      expect(f.loaded[1].disableModelInvocation).toBe(true);
    } finally {
      tui.dispose();
      await work;
    }
  });

  it.each(["success", "failure"] as const)(
    "invalidates prepared batches and handles inventory refresh %s without rollback",
    async (refresh) => {
      const f = fixture();
      const state = stateFixture(f);
      const refreshed: Inventory = { skills: [{ ...local, fingerprint: "after-save" }], warnings: [] };
      if (refresh === "success") f.services.scanInventory.mockResolvedValue(refreshed);
      else f.services.scanInventory.mockRejectedValue(new Error("Scan unavailable\u001b[31m"));
      const rpc = createRpcHarness([select("Model invocation (automatic)"), select("Back")]);
      const ctx = f.context(rpc.ui, "rpc");
      await runMenu(ctx, createSkillsMenu(state, "invocation-setting", env, f.guard, f.services, "rpc"), {
        getState: () => state,
        signal: f.guard.signal,
      });
      rpc.assertConsumed();
      expect(state.invocation?.enabled).toBe(false);
      expect(state.invocationChanged).toBe(true);
      expect(state.invocationValues.get(f.loaded[0].filePath)).toBe(false);
      expect(state.loadedSkills[0].disableModelInvocation).toBe(false);
      expect(state.batch).toBeUndefined();
      expect(f.saved.get(f.loaded[0].filePath)?.enabled).toBe(false);
      expect(f.services.updateInvocation).toHaveBeenCalledTimes(1);
      expect(f.services.scanInventory).toHaveBeenCalledWith([project], expect.any(Object));
      expect(rpc.dialogs[1].options).toContain("Model invocation (manual only)");
      if (refresh === "success") {
        expect(state.inventory).toBe(refreshed);
        expect(ctx.ui.notify).not.toHaveBeenCalled();
      } else {
        expect(state.inventory.skills).toEqual([]);
        expect(state.inventory.warnings.join("\n")).toContain("Inventory refresh did not finish");
        expect(ctx.ui.notify).toHaveBeenCalledWith(
          "Setting saved, but inventory refresh failed: Scan unavailable",
          "warning",
        );
      }
    },
  );

  it("keeps Move and Remove restrictions after invocation saves", async () => {
    const f = fixture([skill(local.name, `${local.path}/SKILL.md`)]);
    const reason = "Linked skill is read-only";
    f.services.scanInventory.mockResolvedValue({ skills: [{ ...local, readOnlyReason: reason }], warnings: [] });
    const rpc = createRpcHarness([
      select("Manage skills"),
      select(`${local.name} · Automatic · ${project.label} · ${local.path}/SKILL.md`),
      select("Model invocation"),
      select("Open invocation setting"),
      select("Model invocation (automatic)"),
      select("Back"),
      select("Back"),
      select(`[-] Move… (unavailable: ${reason})`),
      select(`[-] Remove… (unavailable: ${reason})`),
      select("Back"),
      select("Back"),
      select("Close without reload"),
    ]);
    const ctx = f.context(rpc.ui, "rpc");
    await showSkillsMenu(ctx, { kind: "main" }, env, f.guard, f.services);
    rpc.assertConsumed();
    expect(f.services.prepareOperation).not.toHaveBeenCalled();
    expect(f.services.copyToClipboard).not.toHaveBeenCalled();
    expect(f.services.updateInvocation).toHaveBeenCalledTimes(1);
    expect(ctx.reload).not.toHaveBeenCalled();
  });
});

describe("invocation target review", () => {
  const rawTarget = `/canonical/\u001b[31m${"long-segment/".repeat(24)}last\nsegment\u202e/SKILL.md`;
  const cleanTarget = `/canonical/${"long-segment/".repeat(24)}last segment/SKILL.md`;

  it.each([
    { width: 80, rows: 8 },
    { width: 24, rows: 12 },
  ])("makes the complete target accessible before settings at $width×$rows", async (size) => {
    const f = fixture();
    f.services.readInvocation.mockResolvedValue({
      filePath: f.loaded[0].filePath,
      canonicalPath: rawTarget,
      enabled: true,
    });
    const state = stateFixture(f);
    const menu = createSkillsMenu(state, "manage", env, f.guard, f.services);
    const tui = createTuiHarness(size);
    const ctx = f.context({ custom: tui.custom }, "tui");
    const work = runMenu(ctx, menu, { getState: () => state, signal: f.guard.signal });
    try {
      await waitFrame(tui, /→.*Alpha/);
      tui.press("tui.select.confirm");
      await waitFrame(tui, /→.*Model invocation/);
      expect(state.invocation).toBeUndefined();
      expect(state.invocationReviewed).toBe(false);
      tui.press("tui.select.confirm");
      await waitFrame(tui, "Review invocation target");
      expect(state.invocationReviewed).toBe(false);
      const review = menu.screens["invocation-review"]({ state });
      expect(review.kind).toBe("review");
      if (review.kind !== "review") throw new Error("Expected review document");
      expect(review.content).toContain(`Source file: ${f.loaded[0].filePath}`);
      expect(review.content).toContain(`Writes target: ${cleanTarget}`);
      expect(review.content).toContain("User/shared edits can affect other projects");
      expect(review.content).toContain("Package updates can overwrite changes");
      for (const control of ["\u001b", "\u202e"]) expect(review.content).not.toContain(control);
      expect(review.confirm?.label).toBe("Open invocation setting");
      const settings = menu.screens["invocation-setting"]({ state });
      if (settings.kind !== "settings") throw new Error("Expected settings");
      expect(settings.items[0].disabled).toBe(true);
      const frames: string[] = [];
      let previous = "";
      for (let row = 0; row < review.content.length; row++) {
        const frame = tui.render();
        expect(frame.length).toBeLessThanOrEqual(size.rows - 3);
        expect(frame.every((line) => visibleWidth(line) <= size.width)).toBe(true);
        const text = frame.join("\n");
        frames.push(text);
        if (text === previous) break;
        previous = text;
        tui.press("tui.select.down");
      }
      expect(frames.join("\n")).toContain("Writes target:");
      expect(frames.join("\n").replace(/\s/g, "")).toContain("lastsegment/SKILL.md");
      expect(f.services.updateInvocation).not.toHaveBeenCalled();
      // Back from review returns to this skill's actions; reopening requires review again.
      tui.press("tui.select.cancel");
      await waitFrame(tui, /→.*Model invocation/);
      tui.press("tui.select.confirm");
      await waitFrame(tui, "Review invocation target");
      expect(state.invocationReviewed).toBe(false);
      tui.press("tui.select.confirm");
      await waitFrame(tui, /→.*Model invocation/);
      expect(state.invocationReviewed).toBe(true);
      expect(f.services.updateInvocation).not.toHaveBeenCalled();
      tui.press("tui.select.cancel");
      await waitFrame(tui, "Review invocation target");
      tui.press("ctrl+c");
      await work;
      expect(tui.isOpen).toBe(false);
      expect(f.services.updateInvocation).not.toHaveBeenCalled();
      expect(ctx.ui.notify).not.toHaveBeenCalled();
    } finally {
      tui.dispose();
      await work;
    }
  });

  it("paginates the sanitized target in RPC before opening settings without saving", async () => {
    const f = fixture();
    f.services.readInvocation.mockResolvedValue({
      filePath: f.loaded[0].filePath,
      canonicalPath: rawTarget,
      enabled: true,
    });
    const state = stateFixture(f);
    const menu = createSkillsMenu(state, "manage", env, f.guard, f.services, "rpc");
    const reviewTitles: string[] = [];
    const reviewed: boolean[] = [];
    let phase = "select";
    const choose = vi.fn(async (title: string, options: string[]) => {
      reviewed.push(Boolean(state.invocationReviewed));
      if (phase === "select") {
        phase = "actions";
        return label(f.loaded[0]);
      }
      if (phase === "actions") {
        phase = "review";
        return "Model invocation";
      }
      if (phase === "review") {
        reviewTitles.push(title);
        if (options.includes("Next")) return "Next";
        phase = "settings";
        return "Open invocation setting";
      }
      if (phase === "settings") phase = "back-review";
      else if (phase === "back-review") phase = "back-actions";
      else if (phase === "back-actions") phase = "back-list";
      return "Back";
    });
    const ctx = f.context({ select: choose }, "rpc");
    await runMenu(ctx, menu, { getState: () => state, signal: f.guard.signal });
    expect(phase).toBe("back-list");
    expect(reviewTitles.length).toBeGreaterThan(1);
    const document = reviewTitles.join("\n");
    expect(document.replace(/\s/g, "")).toContain(`Writestarget:${cleanTarget.replace(/\s/g, "")}`);
    expect(document).toContain("User/shared edits can affect other projects");
    for (const control of ["\u001b", "\u202e"]) expect(document).not.toContain(control);
    expect(reviewed.slice(2, 2 + reviewTitles.length)).toEqual(reviewTitles.map(() => false));
    expect(choose.mock.calls[2 + reviewTitles.length][0]).toMatch(/^Model invocation/);
    expect(choose.mock.calls[3 + reviewTitles.length][0]).toMatch(/^Review invocation target/);
    expect(f.services.updateInvocation).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it.each([undefined, false])(
    "blocks direct settings activation and handler writes when reviewed=%s",
    async (reviewed) => {
      const f = fixture();
      const state = stateFixture(f);
      state.invocationReviewed = reviewed;
      const menu = createSkillsMenu(state, "invocation-setting", env, f.guard, f.services);
      const settings = menu.screens["invocation-setting"]({ state });
      if (settings.kind !== "settings") throw new Error("Expected settings");
      expect(settings.items[0].disabled).toBe(true);
      const tui = createTuiHarness();
      const ctx = f.context({ custom: tui.custom }, "tui");
      const work = runMenu(ctx, menu, { getState: () => state, signal: f.guard.signal });
      try {
        await waitFrame(tui, "Model invocation");
        tui.press("tui.select.confirm");
        tui.send(" ");
        await tui.waitForPending();
        for (const value of ["automatic", "manual only"]) {
          await expect(
            menu.actions["save-invocation"]({ ctx, state, signal: f.guard.signal, itemId: "model-invocation", value }),
          ).rejects.toThrow("Review the invocation target before changing its setting");
        }
        expect(f.services.updateInvocation).not.toHaveBeenCalled();
        expect(f.services.scanInventory).not.toHaveBeenCalled();
        expect(f.saved.size).toBe(0);
        expect(state.invocationChanged).toBe(false);
        expect(ctx.ui.notify).not.toHaveBeenCalled();
      } finally {
        tui.dispose();
        await work;
      }
    },
  );
});

describe("invocation cancellation key equivalence", () => {
  it.each([
    ["Escape alias", ["esc"], "\x1b", false, "esc"],
    ["Return alias", ["return"], "\r", false, "return"],
    ["Ctrl+Alt order", ["ctrl+alt+g"], "\x1b\x07", false, "ctrl+alt+g"],
    ["Alt+Ctrl order", ["alt+ctrl+g"], "\x1b\x07", false, "alt+ctrl+g"],
    ["legacy Tab collision", ["ctrl+i"], "\t", false, "ctrl+i"],
    ["Kitty Ctrl+Alt", ["alt+ctrl+g"], "\x1b[103;7u", true, "alt+ctrl+g"],
    ["legacy Alt+Enter", ["alt+enter", "shift+enter"], "\x1b\r", false, "alt+enter"],
    ["Kitty Shift+Enter collision", ["alt+enter", "shift+enter"], "\x1b\r", true, "shift+enter"],
    ["invalid first binding", ["ctrl+ctrl+g", "ctrl+g"], "\x07", false, "ctrl+g"],
    ["hard cancel with remapped Back", ["ctrl+g"], "\x03", true, undefined],
  ] as const)("cancels queued saves through %s", async (_name, bindings, data, kitty, first) => {
    const previous = isKittyProtocolActive();
    setKittyProtocolActive(kitty);
    const keys = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.confirm": "ctrl+y",
      "tui.select.down": "ctrl+n",
      // Intentionally includes malformed strings from runtime JSON settings.
      "tui.select.cancel": [...bindings] as KeyId[],
    });
    // Assert the installed matcher's actual first usable branch, not a guessed alias.
    expect(keys.getKeys("tui.select.cancel").find((key) => matchesKey(data, key))).toBe(first);
    const f = fixture();
    const tui = createTuiHarness({ keybindings: keys });
    const ctx = f.context({ custom: tui.custom }, "tui");
    const work = showSkillsMenu(ctx, { kind: "main" }, env, f.guard, f.services);
    try {
      await openInvocation(tui, "\x19");
      tui.send("\x19");
      await waitFrame(tui, "Review invocation target");
      tui.send("\x19");
      await waitFrame(tui, /→.*Model invocation/);
      tui.send(" ");
      tui.send(data);
      if (first !== undefined) {
        await waitFrame(tui, "Review invocation target");
        tui.press("ctrl+c");
      }
      expect(await work).toBe(false);
      expect(f.services.updateInvocation).not.toHaveBeenCalled();
      expect(f.saved.size).toBe(0);
      expect(ctx.ui.notify).not.toHaveBeenCalled();
    } finally {
      tui.dispose();
      await work;
      setKittyProtocolActive(previous);
    }
  });
});

describe("invocation task ownership", () => {
  it.each(
    [
      { toggle: "\r", toggleName: "Enter" },
      { toggle: " ", toggleName: "Space" },
    ].flatMap((toggle) =>
      [1, 3].flatMap((count) =>
        [
          { cancel: "\x03", cancelName: "Ctrl+C" },
          { cancel: "\x07", cancelName: "Ctrl+G" },
        ].map((cancel) => ({ ...toggle, ...cancel, count })),
      ),
    ),
  )(
    "cancels $count synchronous $toggleName toggles with $cancelName before the first callback starts",
    async ({ toggle, count, cancel }) => {
      const f = fixture();
      const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": "ctrl+g" });
      const tui = createTuiHarness({ keybindings: keys });
      const ctx = f.context({ custom: tui.custom }, "tui");
      const work = showSkillsMenu(ctx, { kind: "main" }, env, f.guard, f.services);
      try {
        await openInvocation(tui);
        tui.press("tui.select.confirm");
        await waitFrame(tui, "Review invocation target");
        tui.press("tui.select.confirm");
        await waitFrame(tui, /→.*Model invocation/);
        const openings = tui.openCount;
        // No await: all toggles and cancellation precede the first queued callback microtask.
        for (let index = 0; index < count; index++) tui.send(toggle);
        expect(f.services.updateInvocation).not.toHaveBeenCalled();
        tui.send(cancel);
        if (cancel === "\x03") {
          expect(await work).toBe(false);
          expect(tui.isOpen).toBe(false);
          expect(tui.openCount).toBe(openings);
        } else {
          await waitFrame(tui, "Review invocation target");
          expect(tui.openCount).toBe(openings + 1);
          tui.send("\x07");
          await waitFrame(tui, /→.*Model invocation/);
          expect(tui.openCount).toBe(openings + 2);
          tui.send("\x07");
          await waitFrame(tui, "Select a skill to manage it.");
          expect(tui.openCount).toBe(openings + 3);
          tui.press("ctrl+c");
          expect(await work).toBe(false);
        }
        expect(f.services.updateInvocation).not.toHaveBeenCalled();
        expect(f.services.scanInventory).toHaveBeenCalledTimes(1);
        expect(f.saved.size).toBe(0);
        expect(ctx.ui.notify).not.toHaveBeenCalled();
        expect(ctx.reload).not.toHaveBeenCalled();
      } finally {
        tui.dispose();
        await work;
      }
    },
  );
  it.each([
    ["cancel", false],
    ["dispose", false],
    ["owner-abort", false],
    ["cancel", true],
    ["dispose", true],
    ["owner-abort", true],
  ] as const)("drains save on %s (committed=%s) and suppresses stale UI", async (action, committed) => {
    const f = fixture();
    const started = deferred<Guard>();
    const finish = deferred<void>();
    const aborted = deferred<void>();
    f.services.updateInvocation.mockImplementation(async (snapshot, enabled, guard) => {
      guard.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      started.resolve(guard);
      await finish.promise;
      if (!committed) guard.check();
      const next = { ...snapshot, enabled };
      f.saved.set(next.filePath, next);
      return { snapshot: next, changed: true };
    });
    const tui = createTuiHarness();
    const ctx = f.context({ custom: tui.custom }, "tui");
    let settled = false;
    const work = showSkillsMenu(ctx, { kind: "main" }, env, f.guard, f.services).then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    try {
      await openInvocation(tui);
      tui.press("tui.select.confirm");
      await waitFrame(tui, "Review invocation target");
      tui.press("tui.select.confirm");
      await waitFrame(tui, /→.*Model invocation/);
      tui.press("tui.select.confirm");
      const pendingGuard = await started.promise;
      if (action === "cancel") tui.press("ctrl+c");
      else if (action === "dispose") tui.dispose();
      else f.controller.abort();
      await vi.waitFor(() => expect(pendingGuard.signal.aborted).toBe(true));
      await aborted.promise;
      expect(settled).toBe(false);
      const openings = tui.openCount;
      finish.resolve();
      const result = await work;
      if (action === "owner-abort") expect(result).toEqual({ error: expect.objectContaining({ name: "AbortError" }) });
      else expect(result).toEqual({ value: false });
      expect(tui.openCount).toBe(openings);
      expect(tui.isOpen).toBe(false);
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      expect(ctx.reload).not.toHaveBeenCalled();
      expect(f.services.scanInventory).toHaveBeenCalledTimes(1);
      expect(f.services.updateInvocation).toHaveBeenCalledTimes(1);
      expect(f.loaded[0].disableModelInvocation).toBe(false);
      expect(f.saved.has(f.loaded[0].filePath)).toBe(committed);
      if (committed) expect(f.saved.get(f.loaded[0].filePath)?.enabled).toBe(false);
    } finally {
      finish.resolve();
      tui.dispose();
      await work;
    }
  });

  it.each([false, true])(
    "cancels queued saves with remapped Back (committed=%s) and reopens the saved value",
    async (committed) => {
      const f = fixture();
      const started = deferred<Guard>();
      const finish = deferred<void>();
      f.services.updateInvocation.mockImplementation(async (snapshot, enabled, guard) => {
        started.resolve(guard);
        await finish.promise;
        if (!committed) guard.check();
        const next = { ...snapshot, enabled };
        f.saved.set(next.filePath, next);
        return { snapshot: next, changed: true };
      });
      const keys = new KeybindingsManager(TUI_KEYBINDINGS, {
        "tui.select.confirm": "ctrl+y",
        "tui.select.cancel": "ctrl+g",
        "tui.select.down": "ctrl+n",
      });
      const tui = createTuiHarness({ keybindings: keys });
      const ctx = f.context({ custom: tui.custom }, "tui");
      const work = showSkillsMenu(ctx, { kind: "main" }, env, f.guard, f.services);
      try {
        await openInvocation(tui, "\x19");
        tui.send("\x19");
        await waitFrame(tui, "Review invocation target");
        tui.send("\x19");
        await waitFrame(tui, /→.*Model invocation/);
        tui.send("\x19");
        const pendingGuard = await started.promise;
        // Queue two further toggles before Back. Neither may start after cancellation.
        tui.send("\x19");
        tui.send("\x19");
        tui.send("\x07");
        expect(pendingGuard.signal.aborted).toBe(true);
        const openings = tui.openCount;
        expect(f.services.updateInvocation).toHaveBeenCalledTimes(1);
        expect(tui.isOpen).toBe(true);
        finish.resolve();
        await waitFrame(tui, "Review invocation target");
        expect(tui.openCount).toBe(openings + 1);
        expect(f.services.updateInvocation).toHaveBeenCalledTimes(1);
        expect(f.services.scanInventory).toHaveBeenCalledTimes(1);
        expect(ctx.ui.notify).not.toHaveBeenCalled();
        expect(f.saved.has(f.loaded[0].filePath)).toBe(committed);
        tui.send("\x07");
        await waitFrame(tui, /→.*Model invocation/);
        tui.send("\x19");
        await waitFrame(tui, "Review invocation target");
        expect(f.services.updateInvocation).toHaveBeenCalledTimes(1);
        tui.send("\x19");
        await waitFrame(tui, /→.*Model invocation/);
        expect(tui.render().join("\n")).toMatch(
          committed ? /→.*Model invocation.*manual only/ : /→.*Model invocation.*automatic/,
        );
        expect(f.services.readInvocation).toHaveBeenCalledTimes(2);
        expect(f.loaded[0].disableModelInvocation).toBe(false);
        tui.send("\x07");
        await waitFrame(tui, "Review invocation target");
        tui.send("\x07");
        await waitFrame(tui, /→.*Model invocation/);
        tui.send("\x07");
        await waitFrame(tui, "Select a skill to manage it.");
        tui.send("\x07");
        await waitFrame(tui, committed ? "Close without reload" : "Workspace:");
        expect(tui.render().join("\n").includes("Reload now")).toBe(committed);
        tui.press("ctrl+c");
        expect(await work).toBe(false);
        expect(ctx.reload).not.toHaveBeenCalled();
      } finally {
        finish.resolve();
        tui.dispose();
        await work;
      }
    },
  );

  it("records a late committed save in plain state even after component disposal", async () => {
    const f = fixture();
    const state = stateFixture(f);
    const started = deferred<Guard>();
    const finish = deferred<void>();
    f.services.updateInvocation.mockImplementation(async (snapshot, enabled, guard) => {
      started.resolve(guard);
      await finish.promise;
      return { snapshot: { ...snapshot, enabled }, changed: true };
    });
    const tui = createTuiHarness();
    const ctx = f.context({ custom: tui.custom }, "tui");
    const work = runMenu(ctx, createSkillsMenu(state, "invocation-setting", env, f.guard, f.services), {
      getState: () => state,
      signal: f.guard.signal,
    });
    try {
      await waitFrame(tui, "Writes target:");
      tui.press("tui.select.confirm");
      const pendingGuard = await started.promise;
      tui.dispose();
      expect(pendingGuard.signal.aborted).toBe(true);
      finish.resolve();
      await work;
      expect(state.invocation?.enabled).toBe(false);
      expect(state.invocationChanged).toBe(true);
      expect(state.invocationValues.get(f.loaded[0].filePath)).toBe(false);
      expect(state.loadedSkills[0].disableModelInvocation).toBe(false);
      expect(state.batch).toBeUndefined();
      expect(state.inventory.skills).toEqual([]);
      expect(f.services.scanInventory).not.toHaveBeenCalled();
      expect(ctx.ui.notify).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      tui.dispose();
      await work;
    }
  });
});

describe("invocation screen framing", () => {
  it("bounds choice and settings frames on narrow resize, retains focused rows, and uses the border role", async () => {
    const f = fixture([skill(), skill("Beta", "/package/beta.md")]);
    const borderCalls: string[] = [];
    const tui = createTuiHarness({
      width: 120,
      rows: 24,
      theme: {
        fg(role, text) {
          if (role === "border") borderCalls.push(text);
          return text;
        },
        bold: (text) => text,
      },
    });
    const ctx = f.context({ custom: tui.custom }, "tui");
    const work = showSkillsMenu(ctx, { kind: "main" }, env, f.guard, f.services);
    function checkFrames(focused: RegExp) {
      for (const width of [1, 12, 80, 120]) {
        for (const rows of [1, 4, 8, 24]) {
          const frame = tui.resize({ width, rows });
          expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
          expect(frame.length).toBeLessThanOrEqual(Math.max(1, rows - 3));
          if (width >= 80) expect(frame.join("\n")).toMatch(focused);
          const rules = frame.filter((line) => /^─+$/.test(line));
          if (rows >= 8) {
            expect(rules).toHaveLength(2);
            expect(frame[0]).toBe("─".repeat(width));
            expect(frame.at(-1)).toBe("─".repeat(width));
          } else expect(rules).toHaveLength(0);
        }
      }
      tui.invalidate();
      expect(tui.render().join("\n")).toMatch(focused);
    }
    try {
      await openManage(tui);
      tui.press("tui.select.down");
      checkFrames(/→.*Beta/);
      tui.press("tui.select.confirm");
      await waitFrame(tui, /→.*Model invocation/);
      checkFrames(/→.*Model invocation/);
      tui.press("tui.select.confirm");
      await waitFrame(tui, "Writes target:");
      expect(tui.render().join("\n")).toContain("Writes target: /real-target/Beta/SKILL.md");
      expect(f.services.updateInvocation).not.toHaveBeenCalled();
      tui.press("tui.select.confirm");
      await waitFrame(tui, /→.*Model invocation/);
      checkFrames(/→.*Model invocation/);
      expect(borderCalls).toContain("─".repeat(120));
      tui.press("tui.select.confirm");
      await tui.waitForPending();
      await waitFrame(tui, /→.*Model invocation.*manual only/);
      checkFrames(/→.*Model invocation/);
      expect(tui.requestRenderCount).toBeGreaterThan(0);
    } finally {
      tui.dispose();
      await work;
    }
  });
});
