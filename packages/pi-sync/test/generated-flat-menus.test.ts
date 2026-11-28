import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DefaultResourceLoader,
  type ExtensionCommandContext,
  initTheme,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { findDaemon, stopDaemon } from "@narumitw/pi-sync-daemon";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { beforeEach, describe, test } from "vitest";
import { bindMockToolLoadout, createMockContext } from "../../../test/support.js";
import { WebDavSyncBackend } from "../src/backends/webdav/webdav-backend.js";
import { loadConfig } from "../src/settings/config.js";
import { writeStateForConfig } from "../src/state/sync-state-store.js";
import { readClientDebug } from "./client-debug-records.js";
import { snapshot, v3WebDavSettings } from "./helpers.js";
import { MockWebDavServer } from "./mock-webdav-server.js";

initTheme("dark", false);

const cases = [
  { name: "TUI Settings", mode: "tui", action: "settings" },
  { name: "TUI cancelled Pull", mode: "tui", action: "cancel", direction: "pull" },
  { name: "TUI cancelled Push", mode: "tui", action: "cancel", direction: "push" },
  { name: "TUI applied Push", mode: "tui", action: "apply", direction: "push" },
  { name: "TUI size-limited Push", mode: "tui", action: "block", direction: "push" },
  { name: "RPC applied Pull", mode: "rpc", action: "apply", direction: "pull" },
  { name: "TUI declined Force push offer", mode: "tui", action: "decline-force", direction: "push" },
  { name: "TUI confirmed Force push", mode: "tui", action: "force", direction: "push" },
  { name: "RPC declined Force pull preview", mode: "rpc", action: "decline-preview", direction: "pull" },
  { name: "RPC confirmed Force pull", mode: "rpc", action: "force", direction: "pull" },
  { name: "RPC reviewed a changed Force pull again", mode: "rpc", action: "refresh-force", direction: "pull" },
  { name: "TUI cancelled direct /sync push review", mode: "tui", action: "review-push" },
  { name: "RPC History", mode: "rpc", action: "history" },
] as const;

const localText = "local fixture version\n";
const remoteText = "remote fixture version\n";

describe.each(cases)("package-directory Jiti $name", (scenario) => {
  let run: () => Promise<void>;

  beforeEach(async ({ onTestFinished }) => {
    const { action, mode } = scenario;
    const direction = "direction" in scenario ? scenario.direction : undefined;
    const root = await mkdtemp(join(tmpdir(), "pi-sync-flat-smoke-"));
    const agentDir = join(root, "agent");
    const previous = process.env.PI_CODING_AGENT_DIR;
    const readingHead = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    let holdHead = false;
    let reachedHead = false;
    const server = new MockWebDavServer({
      async beforeRequest(request, signal) {
        if (!holdHead || request.method !== "GET" || !request.path.endsWith("/latest.json")) return;
        reachedHead = true;
        readingHead.resolve();
        const closed = Promise.withResolvers<void>();
        const onClose = () => closed.resolve();
        signal.addEventListener("abort", onClose, { once: true });
        try {
          if (!signal.aborted) await Promise.race([releaseRead.promise, closed.promise]);
        } finally {
          signal.removeEventListener("abort", onClose);
        }
      },
    });
    let serverStarted = false;
    let loaded: ReturnType<DefaultResourceLoader["getExtensions"]> | undefined;
    let activeContext: ExtensionCommandContext | undefined;
    let commandTask: Promise<void> | undefined;
    const hosts = new Set<ReturnType<typeof createTuiHarness>>();
    onTestFinished(async () => {
      try {
        for (const host of hosts) host.press("ctrl+c");
        readingHead.resolve();
        releaseRead.resolve();
        try {
          if (activeContext)
            for (const handler of loaded?.extensions[0]?.handlers.get("session_shutdown") ?? [])
              await handler({ type: "session_shutdown", reason: "quit" }, activeContext);
        } finally {
          await commandTask?.catch(() => {});
        }
      } finally {
        try {
          await stopDaemon(agentDir);
          assert.equal(await findDaemon(agentDir), undefined);
        } finally {
          for (const host of hosts) host.dispose();
          loaded?.runtime.invalidate("flat menu package-directory smoke complete");
          if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
          else process.env.PI_CODING_AGENT_DIR = previous;
          try {
            if (serverStarted) await server.close();
          } finally {
            await rm(root, { recursive: true, force: true });
          }
        }
      }
    });
    await server.start();
    serverStarted = true;
    await mkdir(agentDir);
    const settings = {
      ...v3WebDavSettings({ include: action === "review-push" ? ["managed"] : ["AGENTS.md"] }),
      skipSecretScan: action === "review-push",
      debug: direction !== undefined,
    };
    if (action === "review-push") {
      const thumbnails = join(agentDir, "managed", "docs", "screenshots", "thumbs");
      await mkdir(thumbnails, { recursive: true });
      await Promise.all(
        Array.from({ length: 829 }, (_, index) =>
          writeFile(join(thumbnails, `example-${String(index).padStart(3, "0")}.webp`), "fixture"),
        ),
      );
    }
    const localPath = join(agentDir, "AGENTS.md");
    if (action === "block") {
      settings.version = 9;
      Object.assign(settings.syncSetups.home.sync, { maxFileSizeMiB: 1 });
    }
    if (direction) await writeFile(localPath, action === "block" ? Buffer.alloc(1_048_577, 0x78) : localText);
    settings.storageConnections.dav.url = server.url;
    const bytes = JSON.stringify(settings);
    const settingsPath = join(agentDir, "pi-sync.json");
    await writeFile(settingsPath, bytes, { mode: 0o600 });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const config = await loadConfig();
    assert.equal(config.backend.type, "webdav");
    const backend = new WebDavSyncBackend(config.backend);
    const remote = {
      ...snapshot([{ path: "AGENTS.md", content: Buffer.from(remoteText) }]),
      profile: config.snapshotIdentity,
      selection: { version: 1 as const, include: ["AGENTS.md"] },
    };
    const conflict =
      action === "force" || action === "decline-force" || action === "decline-preview" || action === "refresh-force";
    if (direction) {
      const baseText = (direction === "push") !== conflict ? remoteText : localText;
      const base =
        baseText === remoteText
          ? remote
          : {
              ...remote,
              id: "baseline",
              files: snapshot([{ path: "AGENTS.md", content: Buffer.from(baseText) }]).files,
            };
      const { head } = await backend.publishSnapshot(base, { kind: "missing" });
      await writeStateForConfig(config, {
        version: 1,
        profile: config.snapshotIdentity,
        include: ["AGENTS.md"],
        lastAppliedSnapshot: head.snapshotId,
        lastRemoteRevision: head.revision,
        lastFileHashes: Object.fromEntries(base.files.map(({ path, sha256 }) => [path, sha256])),
      });
      if (base !== remote) await backend.publishSnapshot(remote, { kind: "revision", revision: head.revision });
    }
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [resolve("packages/pi-sync")],
    });
    await loader.reload();
    loaded = loader.getExtensions();
    bindMockToolLoadout(loaded.runtime);
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions[0];
    assert.ok(extension);
    const command = extension.commands.get("sync");
    assert.ok(command);
    const selectedAction =
      direction === "push"
        ? "Push to remote"
        : direction === "pull"
          ? "Pull from remote"
          : action === "settings"
            ? "Settings"
            : "History";
    const progress = direction === "push" ? "Pushing to remote…" : "Pulling from remote…";
    const frames: string[] = [];
    const menus: string[] = [];
    const confirmations: string[] = [];
    const choicesSeen: string[][] = [];
    const lateLocalText = "edit made during the first review\n";
    let firstApproval = false;
    let refreshedReview = false;
    let allowHandover = false;
    let selected = false;
    let menuCountAtActivation = 0;
    const activate = () => {
      selected = true;
      menuCountAtActivation = menus.length;
    };
    const context = createMockContext({
      mode,
      confirm: async (title: string) => {
        confirmations.push(title);
        return allowHandover && title === "Adopt pi-sync-daemon as the synchronization owner?";
      },
      select: async (title: string, options: string[]) => {
        menus.push(title);
        choicesSeen.push(options);
        const review = `Review Force ${direction}…`;
        if (options.includes(review)) return action === "decline-force" ? "Back" : review;
        if (options.includes("No, cancel")) {
          if (action === "refresh-force" && firstApproval) {
            refreshedReview = true;
            return "No, cancel";
          }
          if (action === "decline-preview") return "No, cancel";
          const approval = options.find((option) => option.startsWith("Yes, "));
          if (approval && action === "refresh-force") {
            firstApproval = true;
            await writeFile(localPath, lateLocalText);
          }
          return approval ?? "View details";
        }
        if (title.startsWith("Sync change details")) return "Back";
        if (selected || !options.includes(selectedAction)) return undefined;
        activate();
        return selectedAction;
      },
    });
    activeContext = context.ctx as ExtensionCommandContext;
    activeContext.ui.custom = (async (factory) => {
      // Separate hosts support nested manager/edit flows without probing a factory twice.
      const tui = createTuiHarness({ width: 100, rows: 28 });
      hosts.add(tui);
      try {
        const result = tui.custom(factory);
        await tui.waitForOpen();
        const frame = tui.render().join("\n");
        frames.push(frame);
        if (frame.split("\n").includes("Manage sync · home")) {
          if (selected) tui.press("ctrl+c");
          else {
            for (let index = 0; index < 20; index++) {
              if (tui.render().some((line) => line === `→ ${selectedAction}`)) {
                activate();
                tui.press("tui.select.confirm");
                break;
              }
              tui.press("tui.select.down");
            }
            if (!selected) tui.press("ctrl+c");
          }
        } else if (direction && frame.includes(`${direction === "push" ? "Push" : "Pull"} stopped`)) {
          if (action !== "decline-force") tui.press("tui.select.down");
          tui.press("tui.select.confirm");
        } else if (direction && frame.includes(`Force ${direction}?`)) {
          if (action === "force") tui.press("tui.select.down");
          tui.press("tui.select.confirm");
        } else if (direction && frame.includes(`Preparing Force ${direction} preview…`)) {
          // Leave the loading interaction running while the daemon requests the preview.
        } else if (frame.split("\n").includes("Pi Sync Settings")) {
          tui.send("\u001b[200~Show sync status\u001b[201~");
          frames.push(tui.render().join("\n"));
          tui.press("ctrl+c");
        } else if (action === "review-push" && frame.includes("Push pi settings?")) {
          tui.press("tui.select.down");
          frames.push(tui.render().join("\n"));
          tui.press("tui.select.down");
          tui.press("tui.select.confirm");
        } else if (action === "review-push" && frame.includes("Sync change details")) {
          tui.press("end");
          frames.push(tui.render().join("\n"));
          tui.press("ctrl+c");
        } else if (direction && frame.includes(progress)) {
          if (action === "cancel") {
            // Cancel a dispatched operation while the disposable server holds the first head read.
            await Promise.race([readingHead.promise, result]);
            tui.press("ctrl+c");
          }
        } else {
          tui.press("ctrl+c");
        }
        return await result;
      } finally {
        tui.dispose();
        hosts.delete(tui);
      }
    }) as ExtensionCommandContext["ui"]["custom"];
    // Cold Jiti loading, daemon startup, and initial owner adoption belong to fixture setup.
    for (const handler of extension.handlers.get("session_start") ?? [])
      await handler({ type: "session_start", reason: "startup" }, activeContext);
    if (direction || action === "review-push") {
      allowHandover = true;
      await command.handler("daemon handover", activeContext);
      allowHandover = false;
      assert.deepEqual(confirmations.splice(0), ["Adopt pi-sync-daemon as the synchronization owner?"]);
    }
    const operationContext = activeContext;
    const before = new Map(server.resources);
    const requestStart = server.requests.length;
    const noticeStart = context.notifications.length;
    run = async () => {
      holdHead = action === "cancel";
      commandTask = command.handler(action === "review-push" ? "push" : "", operationContext);
      await commandTask;
      holdHead = false;
      releaseRead.resolve();
      assert.equal(selected, action !== "review-push", frames.join("\n\n"));
      assert.deepEqual(confirmations, []);
      if (direction) {
        if (!conflict) assert.deepEqual(menus.slice(menuCountAtActivation), []);
        const outcome = action === "apply" ? "completed" : action === "cancel" ? "cancelled" : "failed";
        const jobs = (await readClientDebug(agentDir))
          .filter((entry) => entry.event === "job")
          .filter((entry) => entry.operation === `${direction}.foreground`);
        const id = jobs[0]?.operationId;
        assert.ok(id);
        if (conflict) {
          const expected = ["started", "blocked"];
          if (action !== "decline-force") expected.push("started", action === "force" ? "completed" : "cancelled");
          assert.deepEqual(
            jobs.map((entry) => entry.outcome),
            expected,
          );
        } else {
          assert.deepEqual(
            jobs.map((entry) => [entry.operationId, entry.outcome]),
            [
              [id, "started"],
              [id, outcome],
            ],
          );
        }
        assert.doesNotMatch(JSON.stringify(jobs), /AGENTS\.md|\/latest\.json|backup|fixture version/iu);
      }
      const notices = context.notifications.slice(noticeStart);
      const requests = server.requests.slice(requestStart);
      if (action !== "block") assert.ok(!notices.some(({ level }) => level === "error"), JSON.stringify(notices));
      if (action === "settings") {
        const settingsFrames = frames.filter((frame) => frame.split("\n").includes("Pi Sync Settings"));
        assert.equal(settingsFrames.length, 2);
        assert.match(settingsFrames[0] ?? "", /Included paths/u);
        assert.match(settingsFrames[0] ?? "", /Max file size.*Off/u);
        assert.match(settingsFrames[0] ?? "", /Max directory size.*Off/u);
        assert.match(settingsFrames[0] ?? "", /Type to search/u);
        for (const frame of settingsFrames)
          assert.doesNotMatch(
            frame,
            /Sync content|Sync behavior|Storage & setups|Advanced|All settings|Pi Sync Settings ·/u,
          );
        assert.ok(frames.some((frame) => frame.includes("Show sync status") && !frame.includes("Included paths")));
      } else if (action === "cancel") {
        assert.equal(reachedHead, true);
        assert.equal(frames.length, 3, frames.join("\n\n"));
        assert.ok(frames[1]?.includes(progress), frames.join("\n\n"));
        assert.equal(notices.filter(({ message }) => /cancellation requested/u.test(message)).length, 1);
        assert.equal(await readFile(localPath, "utf8"), localText);
      } else if (action === "block") {
        assert.ok(
          notices.some(
            ({ level, message }) => level === "error" && /Remote file "AGENTS\.md": 1048577 bytes/u.test(message),
          ),
          JSON.stringify(notices),
        );
        assert.equal((await backend.readHead())?.snapshotId, remote.id);
        assert.equal((await readFile(localPath)).length, 1_048_577);
      } else if (action === "apply" || conflict) {
        if (conflict && mode === "tui") {
          const offer = frames.find((frame) => frame.includes("Push stopped"));
          assert.match(offer ?? "", /→ Back/u);
          assert.match(offer ?? "", /Review Force push…/u);
          if (action === "force")
            assert.match(frames.find((frame) => frame.includes("Force push?")) ?? "", /→ No, cancel/u);
        } else if (conflict) {
          assert.deepEqual(
            choicesSeen.find((items) => items.includes("Review Force pull…")),
            ["Back", "Review Force pull…", "Done"],
          );
          if (action === "refresh-force") {
            assert.equal(firstApproval, true);
            assert.equal(refreshedReview, true);
          }
          assert.ok(choicesSeen.some((items) => items[0] === "No, cancel"));
        } else if (mode === "tui") {
          assert.equal(frames.length, 2, frames.join("\n\n"));
          assert.ok(frames[1]?.includes(progress), frames.join("\n\n"));
        } else {
          assert.equal(menus.length, 1, menus.join("\n\n"));
          assert.match(menus[0] ?? "", /^Manage sync\n/u);
          assert.deepEqual(frames, []);
        }
        const applied = action === "apply" || action === "force";
        const successes = notices.filter(({ message }) => /^(Pushed|Pulled)\b/u.test(message));
        assert.equal(successes.length, Number(applied), JSON.stringify(notices));
        if (applied) assert.match(successes[0]?.message ?? "", direction === "push" ? /history/iu : /backup/iu);
        assert.equal(
          await readFile(localPath, "utf8"),
          action === "refresh-force" ? lateLocalText : applied && direction === "pull" ? remoteText : localText,
        );
        const backups = await readdir(join(agentDir, "pi-sync", "backups")).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        assert.equal(backups.length, Number(applied && direction === "pull"));
        const head = await backend.readHead();
        assert.ok(head);
        assert.equal(
          requests.filter(({ method, path }) => method === "PUT" && path.endsWith("/latest.json")).length,
          applied && direction === "push" ? 1 : 0,
        );
        if (applied && direction === "push") {
          assert.notEqual(head.snapshotId, remote.id);
          const pushed = await backend.readSnapshot(head.snapshotId);
          assert.equal(Buffer.from(pushed.files[0]?.contentBase64 ?? "", "base64").toString(), localText);
          assert.ok((await backend.listHistory()).some(({ snapshotId }) => snapshotId === remote.id));
        } else assert.equal(head.snapshotId, remote.id);
      } else if (action === "review-push") {
        const [initial, moved] = frames.filter((frame) => frame.includes("Push pi settings?"));
        assert.match(initial ?? "", /→ No, cancel/u);
        assert.match(initial ?? "", /829 add · 0 update · 0 remove/u);
        assert.match(initial ?? "", /possible-secret scanning is disabled/u);
        assert.doesNotMatch(initial ?? "", /Add remotely:|page before Yes/u);
        assert.match(moved ?? "", /→ Yes, apply reviewed transfer/u);
        const details = frames.filter((frame) => frame.includes("Sync change details"));
        assert.ok(details.some((frame) => frame.includes("example-000.webp")));
        assert.ok(details.some((frame) => frame.includes("example-828.webp")));
      } else {
        assert.ok(
          notices.some(({ message }) => message.includes("No remote pi-sync history")),
          JSON.stringify(notices),
        );
        assert.ok(requests.length > 0);
      }
      assert.equal(await readFile(settingsPath, "utf8"), bytes);
      if ((action !== "apply" && action !== "force") || direction === "pull") {
        assert.deepEqual(server.resources, before);
        assert.ok(
          requests.every(({ method }) => method === "GET" || method === "PROPFIND"),
          JSON.stringify(requests),
        );
      }
    };
  });

  test("preserves flat navigation and reviews Force only after a conflict", async () => {
    await run();
  });
});
