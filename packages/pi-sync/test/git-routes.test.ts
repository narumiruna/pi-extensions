import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { ResolvedGitBackend } from "../src/backends/backend-types.js";
import { GitSyncBackend } from "../src/backends/git/git-backend.js";
import type { CommandOptions } from "../src/commands/command-types.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { diff, doctor, history, pull, push, rollback, status, syncBoth } from "../src/sync/sync-operations.js";
import syncExtension from "../src/sync.js";
import { createBareRemote } from "./git-test-helpers.js";
import { withEnv, withTempHome } from "./helpers.js";

function options(args: string[] = []): CommandOptions {
  return {
    yes: true,
    force: false,
    stale: false,
    silent: false,
    reload: false,
    auto: false,
    args,
  };
}

test("all backend-neutral sync routes operate against a Git target", async () => {
  const fixture = createBareRemote();
  try {
    await withEnv(
      {
        PI_SYNC_ACCESS_KEY_ID: "ignored-access",
        PI_SYNC_SECRET_ACCESS_KEY: "ignored-secret",
        PI_SYNC_SESSIONS: "true",
      },
      () =>
        withTempHome(async (agentDir) => {
          mkdirSync(agentDir, { recursive: true });
          writeFileSync(path.join(agentDir, "settings.json"), '{"theme":"dark"}\n');
          writeFileSync(
            localConfigPath(),
            JSON.stringify({
              version: 3,
              activeSyncSetup: "home",
              onSwitch: "ask-before-pull",
              storageConnections: {
                github: { type: "git", remote: "ssh://git@example.com/private/pi-sync.git" },
              },
              syncSetups: {
                home: {
                  storage: {
                    connection: "github",
                    branch: "pi-sync/home",
                    path: "pi-sync/home",
                  },
                  sync: { include: ["settings.json"], automatic: true },
                },
              },
            }),
          );
          const backendConfig: ResolvedGitBackend = {
            type: "git",
            profile: { kind: "git", remote: fixture.remote },
            destination: { branch: "pi-sync/home", directory: "pi-sync/home", namespace: "home" },
          };
          const backend = new GitSyncBackend(backendConfig, {
            cacheRoot: path.join(fixture.root, "cache"),
            allowLocalRemotes: true,
          });
          const factory = () => backend;
          const { ctx, notifications } = createMockContext({ hasUI: true });

          await doctor(ctx, options(), factory);
          await status(ctx, options(), factory);
          await diff(ctx, options(), factory);
          await push(ctx, options(), undefined, factory);
          const first = await backend.readHead();
          assert.ok(first);
          await history(ctx, options(), factory);
          writeFileSync(path.join(agentDir, "settings.json"), '{"theme":"light"}\n');
          await pull(ctx, options(), factory);
          assert.equal(readFileSync(path.join(agentDir, "settings.json"), "utf8"), '{"theme":"dark"}\n');
          await syncBoth(ctx, options(), factory);
          await rollback(ctx, options([first.snapshotId]), factory);
          assert.notEqual((await backend.readHead())?.snapshotRef, first.snapshotRef);

          const mock = createMockPi();
          syncExtension(mock.pi);
          await mock.commands.get("sync")?.handler("config", ctx);
          const configOutput = notifications.at(-1)?.message ?? "";
          assert.match(configOutput, /kind: git/);
          assert.match(configOutput, /branch: pi-sync\/home/);
          assert.doesNotMatch(configOutput, /password|accessKeyId|secretAccessKey/i);
          const output = notifications.map((item) => item.message).join("\n");
          assert.match(output, /lease-protected \(exact expected-ref update\)/);
          assert.match(output, /git remote: reachable/i);
          assert.doesNotMatch(output, /PI_SYNC_|ignored-access|ignored-secret/);
        }),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
