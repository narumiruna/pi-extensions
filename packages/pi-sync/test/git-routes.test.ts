import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  diff,
  doctor,
  history,
  pull,
  push,
  rollback,
  status,
  syncBoth,
} from "@narumitw/pi-sync-daemon/engine/sync/sync-operations";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { ResolvedGitBackend } from "../src/backends/backend-types.js";
import { GitSyncBackend } from "../src/backends/git/git-backend.js";
import type { CommandOptions } from "../src/commands/command-types.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { showSyncManager } from "../src/ui/manager-ui.js";
import { createBareRemote } from "./git-test-helpers.js";
import { withEnv, withTempHome } from "./helpers.js";

function options(args: string[] = []): CommandOptions {
  return { yes: true, force: false, stale: false, silent: false, reload: false, auto: false, args };
}

interface GitRouteFixture {
  ctx: ReturnType<typeof createMockContext>["ctx"];
  notifications: ReturnType<typeof createMockContext>["notifications"];
  backend: GitSyncBackend;
  factory: () => GitSyncBackend;
  settingsPath: string;
}

async function withGitRoutes(run: (fixture: GitRouteFixture) => Promise<void>) {
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
          const settingsPath = path.join(agentDir, "settings.json");
          writeFileSync(settingsPath, '{"theme":"dark"}\n');
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
                  storage: { connection: "github", branch: "pi-sync/home", path: "pi-sync/home" },
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
          const { ctx, notifications } = createMockContext({ hasUI: true, mode: "rpc" });
          await run({ ctx, notifications, backend, factory: () => backend, settingsPath });
        }),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test("Git target supports diagnostic and inspection routes without exposing credentials", () =>
  withGitRoutes(async ({ ctx, notifications, factory }) => {
    await doctor(ctx, options(), factory);
    await status(ctx, options(), factory);
    await diff(ctx, options(), factory);
    const output = notifications.map(({ message }) => message).join("\n");
    assert.match(output, /lease-protected \(exact expected-ref update\)/);
    assert.match(output, /git remote: reachable/i);
    assert.doesNotMatch(output, /PI_SYNC_|ignored-access|ignored-secret/);
  }));

test("Git target supports push, history, and pulling the published files", () =>
  withGitRoutes(async ({ ctx, backend, factory, settingsPath }) => {
    await push(ctx, options(), undefined, factory);
    assert.ok(await backend.readHead());
    await history(ctx, options(), factory);
    writeFileSync(settingsPath, '{"theme":"light"}\n');
    await pull(ctx, options(), factory);
    assert.equal(readFileSync(settingsPath, "utf8"), '{"theme":"dark"}\n');
  }));

test("Git target supports bidirectional sync and historical rollback", () =>
  withGitRoutes(async ({ ctx, backend, factory }) => {
    await push(ctx, options(), undefined, factory);
    const first = await backend.readHead();
    assert.ok(first);
    await syncBoth(ctx, options(), factory);
    await rollback(ctx, options([first.snapshotId]), factory);
    assert.notEqual((await backend.readHead())?.snapshotRef, first.snapshotRef);
  }));

test("Git setup review shows the branch without deprecated environment credentials", () =>
  withGitRoutes(async () => {
    const frames: string[] = [];
    const choices = ["Settings", "Manage sync setups", "home (current)"];
    const { ctx, notifications } = createMockContext({
      mode: "rpc",
      select: async (title: string) => {
        frames.push(title);
        return choices.shift();
      },
    });
    await showSyncManager(ctx, async () => assert.fail("Settings review must not dispatch a command"));
    const output = [...frames, ...notifications.map(({ message }) => message)].join("\n");
    assert.match(output, /Storage location: Git · pi-sync\/home:pi-sync\/home/u);
    assert.doesNotMatch(output, /password|accessKeyId|secretAccessKey|PI_SYNC_|ignored-access|ignored-secret/iu);
  }));
