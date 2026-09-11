import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { addSyncSetup } from "../src/settings/settings-management.js";
import { readLocalConfigObject } from "../src/settings/settings-store.js";
import { validateSettingsDocument } from "../src/settings/settings-validation.js";
import { showSyncManager } from "../src/ui/manager-ui.js";
import { promptAvailableSetupStorage } from "../src/ui/setup/setup-location-ui.js";
import { v3S3Settings, v3WebDavSettings, withTempHome } from "./helpers.js";
import { createMockContext } from "./setup-test-context.js";

initTheme("dark", false);

function seed(value: string) {
  mkdirSync(path.dirname(localConfigPath()), { recursive: true });
  writeFileSync(localConfigPath(), value, { mode: 0o600 });
}
const kinds = ["R2", "S3", "WebDAV", "Git"] as const;

// A separate branch/bucket/path must keep the root default when it is not occupied.
test.each(kinds)("%s free coordinates do not prompt or mutate settings", async (kind) => {
  await withTempHome(async () => {
    const { settings, connection } = fixture(kind, false);
    const storage = { ...settings.syncSetups.home.storage, connection, path: "./" };
    if (kind === "Git") storage.branch = "other";
    else if (kind === "WebDAV") settings.syncSetups.home.storage.path = "archives/home";
    else storage.bucket = "other-bucket";
    const before = JSON.stringify(settings);
    seed(before);
    let prompts = 0;
    const { ctx, notifications } = createMockContext({
      hasUI: true,
      mode: "tui",
      input: async () => {
        prompts++;
        return undefined;
      },
    });
    assert.deepEqual(await promptAvailableSetupStorage(ctx, storage), storage);
    assert.equal(prompts, 0);
    assert.deepEqual(notifications, []);
    assert.equal(readFileSync(localConfigPath(), "utf8"), before);
  });
});

test.each(kinds)("%s correction rechecks invalid, occupied, and concurrently occupied coordinates", async (kind) => {
  await withTempHome(async () => {
    const { settings, connection } = fixture(kind, false);
    seed(JSON.stringify(settings));
    const git = kind === "Git";
    const answers = [
      git ? "main" : ".",
      git ? "bad..branch" : "../unsafe",
      git ? "claimed" : "backups/claimed",
      git ? "free" : "backups/free",
    ];
    let prompts = 0;
    const { ctx, notifications } = createMockContext({
      hasUI: true,
      mode: "tui",
      input: async () => {
        if (prompts === 2) {
          const competitor = structuredClone(settings.syncSetups.home);
          if (typeof competitor.storage.branch === "string") competitor.storage.branch = "claimed";
          else competitor.storage.path = "backups/claimed";
          await addSyncSetup("competitor", competitor);
        }
        return answers[prompts++];
      },
    });
    const storage = await promptAvailableSetupStorage(ctx, {
      ...settings.syncSetups.home.storage,
      connection,
      path: "./",
    });
    assert.equal(prompts, 4);
    assert.equal(git ? storage?.branch : storage?.path, git ? "free" : "backups/free");
    assert.ok(notifications.some((n) => /competitor/u.test(n.message)));
    assert.ok(notifications.some((n) => /Invalid/u.test(n.message)));
    assert.deepEqual((await readLocalConfigObject())?.syncSetups.home, settings.syncSetups.home);
  });
});

test("location preflight leaves malformed settings untouched", async () => {
  await withTempHome(async () => {
    seed("{invalid");
    const { ctx } = createMockContext({ hasUI: true, mode: "tui" });
    await assert.rejects(promptAvailableSetupStorage(ctx, { connection: "dav", path: "./" }));
    assert.equal(readFileSync(localConfigPath(), "utf8"), "{invalid");
  });
});

function fixture(kind: (typeof kinds)[number], alias: boolean) {
  const settings = validateSettingsDocument(
    kind === "WebDAV" ? v3WebDavSettings() : v3S3Settings({ path: "./", bucket: "pi-sync" }),
  );
  const source = kind === "WebDAV" ? "dav" : "r2";
  if (kind === "Git") {
    settings.storageConnections[source] = {
      type: "git",
      remote: "git@example.com:private/pi-sync.git",
    };
    settings.syncSetups.home.storage = { connection: source, path: "./", branch: "main" };
  } else if (kind === "S3") {
    const connection = settings.storageConnections[source];
    if (connection.type === "s3") connection.endpoint = "https://s3.example.com";
  }
  settings.syncSetups.home.storage.path = ".";
  if (alias) {
    settings.storageConnections.alias = structuredClone(settings.storageConnections[source]);
    const connection = settings.storageConnections.alias;
    if (connection.type === "git") connection.remote = "ssh://git@EXAMPLE.com:22/private/pi-sync.git/";
    else if (connection.type === "webdav") connection.url += "/";
    else connection.endpoint += "/";
  }
  return { settings, connection: alias ? "alias" : source };
}

for (const kind of kinds) {
  test.each(
    [false, true].flatMap((alias) =>
      (kind === "Git" ? ["./", "archives/work"] : ["./"]).map((storagePath) => ({
        alias,
        storagePath,
      })),
    ),
  )(
    `${kind} occupied location requires correction before review (alias=$alias, path=$storagePath)`,
    async ({ alias, storagePath }) => {
      await withTempHome(async () => {
        const { settings, connection } = fixture(kind, alias);
        seed(JSON.stringify(settings));
        const inputs = [
          "work",
          ...(kind === "Git"
            ? ["", storagePath === "./" ? "" : storagePath]
            : kind === "WebDAV"
              ? [""]
              : alias && (kind === "S3" || kind === "R2")
                ? ["pi-sync"]
                : []),
          kind === "Git" ? "work-branch" : "backups/work",
        ];
        const choices = [
          "More…",
          "Sync setups…",
          "Add sync setup",
          connection,
          ...(kind === "S3" || kind === "R2" ? [alias ? "Use an existing bucket at ./" : "Same bucket as “home”"] : []),
          "Minimal settings",
          "Keep automatic sync off",
          "Add sync setup",
          undefined,
        ];
        const titles: string[] = [];
        const { ctx, notifications } = createMockContext({
          hasUI: true,
          mode: "tui",
          input: async (title: string) => {
            titles.push(title);
            return inputs.shift();
          },
          select: async (title: string) => {
            titles.push(title);
            return choices.shift();
          },
        });
        await showSyncManager(ctx, async () => undefined);
        const config = await loadConfig("work");
        assert.equal(config.storagePath, kind === "Git" ? storagePath : "backups/work");
        if (config.backend.type === "git") assert.equal(config.backend.destination.branch, "work-branch");
        assert.deepEqual((await readLocalConfigObject())?.syncSetups.home, settings.syncSetups.home);
        const warning = notifications.find((n) => /already used/u.test(n.message));
        assert.ok(warning, JSON.stringify(notifications));
        assert.match(warning.message, /home/u);
        const correction = titles.findIndex((t) => /already used by “/u.test(t));
        const content = titles.findIndex((t) => /Choose (included content|an initial sync preset)/u.test(t));
        assert.ok(correction >= 0 && correction < content, titles.join("\n"));
      });
    },
  );

  test.each(["cancel", "abort"])(`${kind} occupied-root correction %s leaves settings untouched`, async (action) => {
    await withTempHome(async () => {
      const { settings, connection } = fixture(kind, false);
      const before = JSON.stringify(settings);
      seed(before);
      const controller = new AbortController();
      const inputs = ["work", ...(kind === "Git" ? ["", ""] : kind === "WebDAV" ? [""] : [])];
      const choices = [
        "More…",
        "Sync setups…",
        "Add sync setup",
        connection,
        ...(kind === "S3" || kind === "R2" ? ["Same bucket as “home”"] : []),
        undefined,
      ];
      let correction = false;
      let reviewed = false;
      const { ctx } = createMockContext({
        hasUI: true,
        mode: "tui",
        input: async (title: string) => {
          if (!/already used by “/u.test(title)) return inputs.shift();
          correction = true;
          if (action === "abort") {
            controller.abort(new DOMException("Session replaced", "AbortError"));
            return "late";
          }
          return undefined;
        },
        select: async (title: string) => {
          if (/Review .*sync setup/u.test(title)) reviewed = true;
          return choices.shift();
        },
      });
      await showSyncManager(ctx, async () => undefined, controller.signal);
      assert.equal(correction, true);
      assert.equal(reviewed, false);
      assert.equal(readFileSync(localConfigPath(), "utf8"), before);
    });
  });
}
