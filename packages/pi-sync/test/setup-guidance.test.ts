import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  test.each([true, false, undefined])(`${kind} additional setup explicitly chooses automatic %s`, async (automatic) => {
    await withTempHome(async (dir) => {
      mkdirSync(dir, { recursive: true });
      const settings = v3S3Settings();
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
        automatic === undefined ? "Cancel" : automatic ? "Enable automatic sync" : "Keep automatic sync off",
        "Add sync setup",
      ];
      const inputs = kind === "s3" ? ["existing-bucket"] : ["", ""];
      const frames: string[] = [];
      const { ctx } = createMockContext({
        hasUI: true,
        mode: "tui",
        input: async () => inputs.shift(),
        select: async (title: string) => {
          frames.push(title);
          return choices.shift();
        },
      });
      if (kind === "git") await showAddGitTarget(ctx, "work", kind);
      else if (kind === "webdav") await showAddWebDavTarget(ctx, "work", kind);
      else await showAddS3Target(ctx, settings, kind, "work");
      if (automatic === undefined) {
        assert.equal(readFileSync(localConfigPath(), "utf8"), before);
        return;
      }
      assert.equal((await loadConfig("work")).automatic, automatic);
      assert.equal((await loadConfig()).setupName, "home");
      assert.equal((await loadConfig("work")).include.includes("sessions"), false);
      assert.match(
        frames.join("\n"),
        automatic
          ? /Automatic sync: On \(startup check; shutdown pushes selected content if sessions included\)/u
          : /Automatic sync: Off/u,
      );
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
      "More…",
      "Sync setups…",
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
    const choices = ["Same bucket as “home”", "Minimal settings", "Keep automatic sync off"];
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
  [new Error("WebDAV request failed (403)"), /credentials and remote permissions/u],
  [new Error("Git authentication failed"), /credentials and remote permissions/u],
  [new Error("S3 request timed out"), /server address and network/u],
  [new Error("settings changed while review was open"), /Reopen the item/u],
  [new Error("Invalid pi-sync settings"), /repair it before retrying/u],
  [new Error("Remote publication outcome is unknown"), /Remote publication outcome is unknown/u],
] as const)("error guidance preserves outcome and supplies an action: %s", (error, expected) => {
  assert.match(syncErrorGuidance(error), expected);
  assert.doesNotMatch(syncErrorGuidance(error), /nothing changed|no remote.*changed/u);
});

test("technical error details are bounded and terminal-safe", () => {
  const output = syncErrorGuidance(new Error(`failure\u001b[2J${"x".repeat(10000)}`));
  assert.ok(output.length < 1600);
  assert.equal(output.includes("\u001b"), false);
  assert.match(output, /details truncated/u);
});
