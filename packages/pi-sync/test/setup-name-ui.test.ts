import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { ExtensionInputComponent, getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { readLocalConfigObject } from "../src/settings/settings-store.js";
import { promptInitialSetupName } from "../src/ui/setup/setup-name-ui.js";
import { showSetupWizard } from "../src/ui/setup/setup-wizard.js";
import { withTempHome } from "./helpers.js";
import { createMockContext } from "./setup-test-context.js";

initTheme("dark", false);

test.each([
  { width: 32, themeName: "dark" },
  { width: 80, themeName: "dark" },
  { width: 32, themeName: "light" },
  { width: 80, themeName: "light" },
])("Pi core name input renders themed guidance at $width columns ($themeName)", async ({ width, themeName }) => {
  initTheme(themeName, false);
  let lines: string[] = [];
  let submitted = false;
  const roles: string[] = [];
  const colors = getSelectListTheme();
  const { ctx } = createMockContext({
    hasUI: true,
    mode: "tui",
    theme: {
      fg: (role: string, text: string) => {
        roles.push(role);
        return colors.description(text);
      },
    },
    input: async (title: string, placeholder?: string) => {
      let answer: string | undefined;
      const input = new ExtensionInputComponent(
        title,
        placeholder,
        (value) => {
          submitted = true;
          answer = value;
        },
        () => {},
      );
      try {
        input.focused = true;
        lines = input.render(width);
        input.handleInput("\r");
        return answer;
      } finally {
        input.dispose();
      }
    },
  });
  assert.equal(await promptInitialSetupName(ctx), "default");
  assert.equal(submitted, true);
  assert.ok(lines.every((line) => visibleWidth(line) <= width));
  const text = stripVTControlCharacters(lines.join(" ")).replace(/\s+/gu, " ");
  assert.match(text, /Sync setup name/u);
  assert.match(text, /For example: home or work\. Leave blank for default\./u);
  assert.doesNotMatch(text, /Git branches|automatic sync/u);
  const heading = lines.find((line) => line.includes("Sync setup name"));
  const guidance = lines.find((line) => line.includes("For example:"));
  const accent = colors.selectedText("sample").split("sample")[0];
  const muted = colors.description("sample").split("sample")[0];
  assert.deepEqual(roles, ["muted"]);
  assert.ok(heading?.includes(`${accent}Sync setup name`));
  assert.ok(guidance?.includes(`${muted}For example:`));
  assert.notEqual(accent, muted);
});

test("RPC name input keeps guidance free of terminal styling", async () => {
  let renderedTitle = "";
  const { ctx } = createMockContext({
    hasUI: true,
    mode: "rpc",
    theme: {
      fg: () => {
        throw new Error("RPC must not style input titles");
      },
    },
    input: async (title: string) => {
      renderedTitle = title;
      return "";
    },
  });
  assert.equal(await promptInitialSetupName(ctx), "default");
  assert.equal(renderedTitle, "Sync setup name\nFor example: home or work. Leave blank for default.");
});

test("Pi core name input cancellation does not accept the default", async () => {
  let cancelled = false;
  const { ctx } = createMockContext({
    hasUI: true,
    mode: "tui",
    input: async (title: string, placeholder?: string) => {
      const input = new ExtensionInputComponent(
        title,
        placeholder,
        () => {},
        () => {
          cancelled = true;
        },
      );
      try {
        input.handleInput("\u001b");
        return undefined;
      } finally {
        input.dispose();
      }
    },
  });
  assert.equal(await promptInitialSetupName(ctx), undefined);
  assert.equal(cancelled, true);
});

const presets = ["Cloudflare R2", "Other S3-compatible storage", "WebDAV", "Git"];
const invalidCommonNames = [
  "__proto__",
  "prototype",
  "constructor",
  "a".repeat(101),
  "work\u001b[31m",
  "work\u0085profile",
];
const independentNames = [
  ".",
  "..",
  "team/../work",
  "team/./work",
  "team//work",
  "/work",
  "team\\work",
  "work profile",
  "work..profile",
  "work@{profile}",
  "work~profile",
  "work^profile",
  "work:profile",
  "work?profile",
  "work*profile",
  "work[profile",
  "work]profile",
  ".hidden",
  "team/.hidden",
  "work.lock",
  "team.lock/work",
  "work.",
  "work/",
  "work///",
  "team/work/",
  "work /",
  "/",
  " work/ ",
  "work%2F",
  ".git",
];

const invalidCases = presets.flatMap((preset) => invalidCommonNames.map((name) => ({ preset, name })));

test.each(invalidCases)(
  "$preset rejects name $name before backend prompts and allows correction",
  async ({ preset, name }) => {
    await withTempHome(async (agentDir) => {
      const answers = [name, "default", undefined];
      const titles: string[] = [];
      let selectCalls = 0;
      const { ctx, notifications } = createMockContext({
        hasUI: true,
        mode: "tui",
        select: async () => (selectCalls++ === 0 ? preset : undefined),
        input: async (title: string) => {
          titles.push(title);
          return answers.shift();
        },
      });
      assert.equal(await showSetupWizard(ctx), false);
      assert.equal(titles.length, 3);
      assert.match(titles[0], /^Sync setup name/u);
      assert.equal(titles[1], titles[0]);
      assert.doesNotMatch(titles[2], /^Sync setup name/u);
      assert.equal(selectCalls, 1);
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].level, "warning");
      assert.match(notifications[0].message, /Enter another name/u);
      assert.equal(notifications[0].message.includes("\u001b"), false);
      assert.equal(notifications[0].message.includes("\u0085"), false);
      assert.equal(await readLocalConfigObject(), undefined);
      assert.equal(existsSync(path.join(agentDir, "pi-sync")), false);
    });
  },
);

const validCases = [
  ...presets.flatMap((preset) => independentNames.map((name) => ({ preset, name }))),
  ...presets.flatMap((preset) =>
    ["default", "team/work", "-work", "refs/work", "@", "工作", "a".repeat(100)].map((name) => ({
      preset,
      name,
    })),
  ),
];

test.each(validCases)("$preset accepts name $name independently of its path", async ({ preset, name }) => {
  await withTempHome(async () => {
    const titles: string[] = [];
    const { ctx, notifications } = createMockContext({
      hasUI: true,
      mode: "tui",
      select: async () => preset,
      input: async (title: string) => {
        titles.push(title);
        return titles.length === 1 ? name : undefined;
      },
    });
    assert.equal(await showSetupWizard(ctx), false);
    assert.equal(titles.length, 2);
    assert.doesNotMatch(titles[1], /^Sync setup name/u);
    assert.deepEqual(notifications, []);
  });
});

test.each(presets.flatMap((preset) => [false, true].map((abort) => ({ preset, abort }))))(
  "$preset name correction cancellation (abort=$abort) never advances setup",
  async ({ preset, abort }) => {
    await withTempHome(async () => {
      const controller = new AbortController();
      const titles: string[] = [];
      const signals: (AbortSignal | undefined)[] = [];
      const { ctx, notifications } = createMockContext({
        hasUI: true,
        mode: "tui",
        select: async () => preset,
        input: async (title: string, _placeholder?: string, options?: { signal?: AbortSignal }) => {
          titles.push(title);
          signals.push(options?.signal);
          if (titles.length === 1) return "__proto__";
          if (abort) {
            controller.abort(new DOMException("Session shut down", "AbortError"));
            return "default";
          }
          return undefined;
        },
      });
      const setup = showSetupWizard(ctx, controller.signal);
      if (abort) await assert.rejects(setup, { name: "AbortError" });
      else assert.equal(await setup, false);
      assert.equal(titles.length, 2);
      assert.equal(titles[1], titles[0]);
      assert.deepEqual(signals, [controller.signal, controller.signal]);
      assert.equal(notifications.length, 1);
      assert.equal(await readLocalConfigObject(), undefined);
    });
  },
);
