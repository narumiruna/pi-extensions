import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { ExtensionInputComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { showSetupWizard } from "../src/ui/setup/setup-wizard.js";
import { requiredInput, requiredValueInput } from "../src/ui/setup/text-input.js";
import { withTempHome } from "./helpers.js";
import { createMockContext } from "./setup-test-context.js";

initTheme("dark", false);

const fixtures = [
  {
    preset: "Git",
    inputs: ["", "git@github.com:owner/private-pi-sync.git", "", ""],
    choices: ["Recommended Pi settings", "Keep automatic sync off", "Save setup"],
    path: "./",
    hints: [
      "git@github.com:owner/private-pi-sync.git (SSH)",
      "https://github.com/owner/private-pi-sync.git (HTTPS)",
      "entire branch",
      "Default: main",
      "Default: ./",
      "repository root",
    ],
  },
  {
    preset: "WebDAV",
    inputs: ["", "https://cloud.example.com/dav", "user", ""],
    choices: ["Minimal settings", "Keep automatic sync off", "Keep sessions off (recommended)", "Save setup"],
    path: "./",
    hints: [
      "Example: https://cloud.example.com/remote.php/dav/files/user",
      "collection URL",
      "Default: ./",
      "collection root",
    ],
  },
  ...["Cloudflare R2", "Other S3-compatible storage"].map((preset) => ({
    preset,
    inputs: [
      "",
      preset === "Cloudflare R2" ? "https://account.r2.cloudflarestorage.com" : "https://s3.example.com",
      ...(preset === "Cloudflare R2" ? [] : [""]),
      "existing-bucket",
      "",
      "access-key",
    ],
    choices: [
      "Customize remote location",
      "Store credentials privately",
      "Minimal settings",
      "Keep automatic sync off",
      "Keep sessions off (recommended)",
      "Save sync setup",
    ],
    path: "./",
    hints: [
      "Example: https://",
      "Example: pi-sync",
      "bucket must already exist",
      "Path inside the bucket",
      "Default: ./",
      "bucket root",
      ...(preset === "Cloudflare R2" ? [] : ["Default: us-east-1"]),
    ],
  })),
];

for (const fixture of fixtures) {
  test.each([true, false, undefined])(`${fixture.preset} explicitly chooses automatic sync %s`, async (automatic) => {
    await withTempHome(async () => {
      const choices = [fixture.preset, ...fixture.choices];
      const inputs = [...fixture.inputs];
      const frames: string[] = [];
      const { ctx } = createMockContext({
        hasUI: true,
        mode: "tui",
        custom: secretInput,
        input: async () => inputs.shift(),
        select: async (title: string) => {
          frames.push(title);
          const choice = choices.shift();
          return choice === "Keep automatic sync off"
            ? automatic === undefined
              ? "Cancel"
              : automatic
                ? "Enable automatic sync"
                : choice
            : choice;
        },
      });
      assert.equal(await showSetupWizard(ctx), automatic !== undefined);
      if (automatic === undefined) {
        assert.equal(existsSync(localConfigPath()), false);
        return;
      }
      const config = await loadConfig();
      assert.equal(config.automatic, automatic);
      assert.equal(config.include.includes("sessions"), false);
      assert.match(
        frames.join("\n"),
        automatic
          ? /Automatic sync: On \(startup check; shutdown pushes selected content if sessions included\)/u
          : /Automatic sync: Off/u,
      );
      const expected =
        fixture.preset === "Git"
          ? [
              "settings.json",
              "keybindings.json",
              "models.json",
              "AGENTS.md",
              "APPEND_SYSTEM.md",
              "skills",
              "prompts",
              "themes",
              "extensions",
            ]
          : ["settings.json", "AGENTS.md"];
      assert.deepEqual(config.include, expected);
      for (const path of expected) assert.ok(frames.join("\n").includes(path));
    });
  });
  test(`${fixture.preset} setup renders examples and accepts defaults with one name`, async () => {
    await withTempHome(async () => {
      const choices = [fixture.preset, ...fixture.choices];
      const inputs = [...fixture.inputs];
      const titles: string[] = [];
      const frames: string[] = [];
      let bounded = true;
      const { ctx } = createMockContext({
        hasUI: true,
        mode: "tui",
        select: async () => choices.shift(),
        input: async (title: string, placeholder?: string) => {
          titles.push(title);
          let answer: string | undefined;
          const input = new ExtensionInputComponent(
            title,
            placeholder,
            (value) => {
              answer = value;
            },
            () => {},
          );
          try {
            for (const width of [32, 80]) {
              const lines = input.render(width);
              bounded &&= lines.every((line) => visibleWidth(line) <= width);
              frames.push(lines.join(" "));
            }
            input.handleInput(inputs.shift() ?? "");
            input.handleInput("\r");
            return answer;
          } finally {
            input.dispose();
          }
        },
        custom: secretInput,
      });
      assert.equal(await showSetupWizard(ctx), true);
      assert.equal(bounded, true);
      assert.equal(
        titles.filter((title) => /name/iu.test(title.split("\n")[0]) && !title.startsWith("WebDAV username")).length,
        1,
      );
      const text = stripVTControlCharacters(frames.join(" ")).replace(/\s+/gu, " ");
      for (const hint of fixture.hints) assert.ok(text.includes(hint), hint);
      const config = await loadConfig();
      assert.equal(config.setupName, "default");
      assert.equal(config.connectionName, "default");
      assert.equal(config.storagePath, fixture.path);
      assert.equal(config.snapshotIdentity, "root");
      if (config.backend.type === "git") assert.equal(config.backend.destination.branch, "main");
      if (config.backend.type === "s3")
        assert.equal(config.backend.profile.region, fixture.preset === "Cloudflare R2" ? "auto" : "us-east-1");
    });
  });

  test.each(fixture.inputs.map((_, index) => index))(
    `${fixture.preset} cancellation at input %s never saves defaults`,
    async (cancelAt) => {
      await withTempHome(async () => {
        const choices = [fixture.preset, ...fixture.choices];
        let index = 0;
        const { ctx } = createMockContext({
          hasUI: true,
          mode: "tui",
          select: async () => choices.shift(),
          input: async () => (index === cancelAt ? undefined : fixture.inputs[index++]),
          custom: secretInput,
        });
        assert.equal(await showSetupWizard(ctx), false);
        assert.equal(existsSync(localConfigPath()), false);
      });
    },
  );

  test(`${fixture.preset} blank remote or endpoint is not replaced with an example`, async () => {
    await withTempHome(async () => {
      const inputs = ["default", "   "];
      const { ctx } = createMockContext({
        hasUI: true,
        mode: "tui",
        select: async () => fixture.preset,
        input: async () => inputs.shift(),
      });
      assert.equal(await showSetupWizard(ctx), false);
      assert.equal(existsSync(localConfigPath()), false);
    });
  });

  test(`${fixture.preset} cancelling final review does not save`, async () => {
    await withTempHome(async () => {
      const choices = [fixture.preset, ...fixture.choices.slice(0, -1), "Cancel"];
      const inputs = [...fixture.inputs];
      const { ctx } = createMockContext({
        hasUI: true,
        mode: "tui",
        select: async () => choices.shift(),
        input: async () => inputs.shift(),
        custom: secretInput,
      });
      assert.equal(await showSetupWizard(ctx), false);
      assert.equal(existsSync(localConfigPath()), false);
    });
  });
}

test.each(fixtures.filter((fixture) => fixture.preset !== "Git"))(
  "$preset reviews the sessions path only after explicit privacy acknowledgement",
  async (fixture) => {
    await withTempHome(async () => {
      const choices = [fixture.preset, ...fixture.choices];
      const inputs = [...fixture.inputs];
      const frames: string[] = [];
      let acknowledged = false;
      const { ctx } = createMockContext({
        hasUI: true,
        mode: "tui",
        custom: secretInput,
        input: async () => inputs.shift(),
        confirm: async (title: string) => {
          acknowledged = title === "Include session conversations?";
          return true;
        },
        select: async (title: string) => {
          frames.push(title);
          const choice = choices.shift();
          return choice === "Keep sessions off (recommended)" ? "Include session conversations" : choice;
        },
      });
      assert.equal(await showSetupWizard(ctx), true);
      assert.equal(acknowledged, true);
      assert.deepEqual((await loadConfig()).include, ["settings.json", "AGENTS.md", "sessions"]);
      const review = frames.find((frame) => frame.includes("privacy warning acknowledged")) ?? "";
      assert.match(review, /Included content: 3 paths/u);
      assert.match(review, /\n\s+sessions\s*\n/u);
    });
  },
);

test.each(fixtures.filter((fixture) => fixture.preset.includes("R2") || fixture.preset.includes("S3")))(
  "$preset ignores a storage-location answer after session replacement",
  async (fixture) => {
    await withTempHome(async () => {
      const controller = new AbortController();
      let inputCount = 0;
      const { ctx } = createMockContext({
        hasUI: true,
        mode: "tui",
        input: async () => fixture.inputs[inputCount++],
        select: async (title: string) => {
          if (!title.startsWith("Choose storage location")) return fixture.preset;
          controller.abort(new DOMException("Session replaced", "AbortError"));
          return "Customize remote location";
        },
      });
      assert.equal(await showSetupWizard(ctx, controller.signal), false);
      assert.equal(inputCount, fixture.inputs.indexOf("existing-bucket"));
      assert.equal(existsSync(localConfigPath()), false);
    });
  },
);

test.each(["", "   "])("example-only inputs reject blank %j instead of saving an example", async (value) => {
  const inputs = [value, undefined];
  const { ctx, notifications } = createMockContext({
    hasUI: true,
    mode: "tui",
    input: async () => inputs.shift(),
  });
  assert.equal(await requiredValueInput(ctx, "Endpoint", "https://example.com", undefined), undefined);
  assert.match(notifications[0].message, /required/u);
});

test.each([requiredInput, requiredValueInput])("input ignores answers after session cancellation", async (prompt) => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  const { ctx } = createMockContext({
    hasUI: true,
    mode: "tui",
    input: async (_title: string, _placeholder?: string, options?: { signal?: AbortSignal }) => {
      received = options?.signal;
      controller.abort(new DOMException("Session replaced", "AbortError"));
      return "late";
    },
  });
  await assert.rejects(prompt(ctx, "Path", "example", controller.signal), { name: "AbortError" });
  assert.equal(received, controller.signal);
});

async function secretInput(factory: unknown) {
  const tui = createTuiHarness({ width: 48 });
  const running = tui.custom(factory as Parameters<typeof tui.custom>[0]);
  await tui.waitForOpen();
  tui.type("private-password");
  tui.press("tui.input.submit");
  return running;
}
