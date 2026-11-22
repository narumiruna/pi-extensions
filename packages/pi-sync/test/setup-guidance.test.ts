import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { readLocalConfigObject, updateLocalConfig } from "../src/settings/settings-store.js";
import { normalizeS3Endpoint } from "../src/settings/settings-validation.js";
import { syncErrorGuidance } from "../src/sync/sync-error-guidance.js";
import { showSyncManager } from "../src/ui/manager-ui.js";
import { showAddGitTarget } from "../src/ui/setup/git-ui.js";
import { showAddS3Target } from "../src/ui/setup/s3-ui.js";
import { requiredValueInput } from "../src/ui/setup/text-input.js";
import { showAddWebDavTarget } from "../src/ui/setup/webdav-ui.js";
import { v3S3Settings, withTempHome } from "./helpers.js";
import { createMockContext } from "./setup-test-context.js";

for (const kind of ["git", "webdav", "s3", "r2"]) {
  test.each([
    { mode: "tui", save: true },
    { mode: "tui", save: false },
    { mode: "rpc", save: true },
  ] as const)(`${kind} additional setup is Manual in $mode (save=$save)`, async ({ mode, save }) => {
    await withTempHome(async (dir) => {
      mkdirSync(dir, { recursive: true });
      const settings = v3S3Settings({ automatic: true });
      Object.assign(settings.syncSetups.home.sync, { automaticTransfer: true, agentMode: true, continuous: true });
      Object.assign(settings.storageConnections, {
        git: { type: "git", remote: "git@github.com:owner/private.git" },
        webdav: {
          type: "webdav",
          url: "https://cloud.example.com/dav/team/",
          credentials: { username: "user", password: "private-password" },
        },
        s3: { ...settings.storageConnections.r2, endpoint: "https://s3.example.com" },
      });
      const before = JSON.stringify(settings);
      writeFileSync(localConfigPath(), before);
      const choices = [
        ...(kind === "r2" ? ["Same bucket as “home”"] : kind === "s3" ? ["Use an existing bucket at ./"] : []),
        "Minimal settings",
        save ? "Add sync setup" : "Cancel",
      ];
      const inputs = kind === "s3" ? ["existing-bucket"] : ["", ""];
      const frames: string[] = [];
      const { ctx } = createMockContext({
        hasUI: true,
        mode,
        input: async () => inputs.shift(),
        select: async (title: string, options: string[]) => {
          frames.push(title);
          return mode === "rpc" && options.includes("Next") ? "Next" : choices.shift();
        },
      });
      if (mode === "rpc") {
        (ctx as ExtensionCommandContext).ui.custom = async () => {
          throw new Error("RPC setup must not open custom UI");
        };
      }
      if (kind === "git") await showAddGitTarget(ctx, "work", kind);
      else if (kind === "webdav") await showAddWebDavTarget(ctx, "work", kind);
      else await showAddS3Target(ctx, settings, kind, "work");
      const text = frames.join("\n");
      assert.doesNotMatch(text, /Automatic sync for this setup/u);
      assert.match(text, /Automatic sync: Off/u);
      if (!save) {
        assert.equal(readFileSync(localConfigPath(), "utf8"), before);
        return;
      }
      const config = await loadConfig("work");
      assert.equal(config.automatic, false);
      assert.equal(config.automaticTransfer, false);
      assert.equal(config.agentMode, false);
      assert.equal(config.continuous, false);
      assert.equal(config.include.includes("sessions"), false);
      const current = await readLocalConfigObject();
      assert.equal(current?.activeSyncSetup, "home");
      assert.deepEqual(current?.syncSetups.home, settings.syncSetups.home);
    });
  });
}

test("invalid endpoint values retry one field and keep examples distinct from defaults", async () => {
  const inputs = [
    "",
    "https://<account-id>.r2.cloudflarestorage.com",
    "not a URL",
    "https://s3.example.com\u0007",
    "https://s3.example.com",
  ];
  const titles: string[] = [];
  const { ctx, notifications } = createMockContext({
    input: async (title: string) => {
      titles.push(title);
      return inputs.shift();
    },
  });
  assert.equal(
    await requiredValueInput(ctx, "Endpoint", "https://example.com", undefined, normalizeS3Endpoint),
    "https://s3.example.com",
  );
  assert.equal(titles.length, 5);
  assert.equal(new Set(titles).size, 1);
  assert.equal(notifications.length, 4);
  assert.ok(notifications.every((entry) => entry.message.includes("corrected value")));
});

test("nested new connection remains saved when the surrounding setup is cancelled", async () => {
  await withTempHome(async (dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()));
    const choices = [
      "Settings",
      "Manage sync setups",
      "Add sync setup",
      "Add a new storage connection…",
      "Git",
      "Add storage connection",
      undefined,
    ];
    const inputs = ["work", "archive", "git@github.com:owner/archive.git", undefined];
    const frames: string[] = [];
    const { ctx, notifications } = createMockContext({
      hasUI: true,
      mode: "tui",
      input: async () => inputs.shift(),
      select: async (title: string) => {
        frames.push(title);
        return choices.shift();
      },
    });
    await showSyncManager(ctx, async () => undefined);
    const saved = await readLocalConfigObject();
    assert.equal(saved?.storageConnections.archive?.type, "git");
    assert.equal(saved?.syncSetups.work, undefined);
    assert.match(frames.join("\n"), /saved separately and remains/u);
    assert.ok(notifications.some((item) => /Cancelling setup will keep this connection/u.test(item.message)));
  });
});

test("additional setup rejects a connection changed during exact destination review", async () => {
  await withTempHome(async (dir) => {
    mkdirSync(dir, { recursive: true });
    const settings = v3S3Settings();
    writeFileSync(localConfigPath(), JSON.stringify(settings));
    const choices = ["Same bucket as “home”", "Minimal settings"];
    let reviewed = false;
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      select: async (title: string) => {
        if (!title.includes("Review new sync setup")) return choices.shift();
        reviewed = true;
        await updateLocalConfig((current) => ({
          ...current,
          storageConnections: {
            ...current.storageConnections,
            r2: {
              ...settings.storageConnections.r2,
              type: "s3",
              endpoint: "https://changed.example.com",
            },
          },
        }));
        return "Add sync setup";
      },
    });
    await assert.rejects(showAddS3Target(ctx, settings, "r2", "work"), /changed/u);
    assert.equal(reviewed, true);
    assert.equal((await readLocalConfigObject())?.syncSetups.work, undefined);
  });
});

test.each([
  [Object.assign(new Error("write failed"), { code: "ENOSPC" }), /Free disk space/u],
  [Object.assign(new Error("write failed"), { code: "EACCES" }), /write access/u],
  [new Error("WebDAV request failed (403)"), /\/sync → Settings → Manage storage connections/u],
  [new Error("Git authentication failed"), /credentials and remote permissions/u],
  [Object.assign(new Error("Storage unavailable"), { status: 503 }), /\/sync doctor/u],
  [new Error("S3 request timed out"), /server address and network/u],
  [new Error("settings changed while review was open"), /Reopen the item/u],
  [new Error("Invalid pi-sync settings"), /repair it before retrying/u],
  [new Error("Remote publication outcome is unknown"), /\/sync doctor or choose Diagnostics in \/sync/u],
] as const)("error guidance preserves outcome and supplies an action: %s", (error, expected) => {
  const output = syncErrorGuidance(error);
  assert.ok(output.startsWith(`${error.message}\n`));
  assert.match(output, expected);
  assert.doesNotMatch(output, /nothing changed|no remote.*changed|More →|Check setup/u);
});

test.each([
  ["Agent directory exceeds the 64 MiB scan byte bound.", /find the active ignore file/u],
  ["Agent directory exceeds the scan file bound.", /edit Agent directory scope/u],
  ["Agent directory exceeds the scan entry bound.", /Exclude whole subdirectories/u],
  ["Projected agent directory exceeds the 64 MiB scan byte bound.", /local or incoming sync content/u],
  ["Projected agent directory exceeds the scan file bound.", /local or incoming sync content/u],
  ["Projected agent directory exceeds the scan entry bound.", /Exclude whole subdirectories/u],
] as const)("scan limits give local recovery guidance: %s", (message, expected) => {
  const output = syncErrorGuidance(new Error(message));
  assert.ok(output.startsWith(`${message}\n`));
  assert.match(output, /use \/sync config|with \/sync config/iu);
  assert.match(output, expected);
  assert.doesNotMatch(output, /Check setup|Diagnostics|\/sync doctor/u);
});

test("technical error details are bounded and terminal-safe", () => {
  const output = syncErrorGuidance(new Error(`failure\u001b[2J${"x".repeat(10000)}`));
  assert.ok(output.length < 1600);
  assert.equal(output.includes("\u001b"), false);
  assert.match(output, /details truncated/u);
});
