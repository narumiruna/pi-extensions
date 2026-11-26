#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";
import { requestDaemon } from "./client-transport.js";
import { ensureDaemon, restartDaemon } from "./daemon-startup.js";
import { inspectDaemonStatus } from "./daemon-status.js";
import { privateDirectory, readIdentity, runtimePaths } from "./identity.js";
import { openLifecycleLog } from "./lifecycle-log.js";

export async function main(args: readonly string[]) {
  const [command = "help", flag, root, ...extra] = args;
  if (["help", "--help", "-h"].includes(command)) {
    console.log(
      "pi-sync-daemon <start|status|stop|restart|repair-upgrade|serve> --root <canonical-agent-directory>\nLocal synchronization owner; no OS service registration. status/stop/repair-upgrade never start a service.\nrepair-upgrade revokes all retained unattended grants after verified exit and archives the pending upgrade records.",
    );
    return;
  }
  if (
    !["start", "status", "stop", "restart", "repair-upgrade", "serve"].includes(command) ||
    flag !== "--root" ||
    !root ||
    extra.length
  )
    throw new Error("Use pi-sync-daemon --help for the supported commands.");
  if (command === "repair-upgrade") {
    const { repairUpgrade } = await import("./upgrade-repair.js");
    console.log(JSON.stringify(await repairUpgrade(root)));
    return;
  }
  if (command === "serve") {
    process.send?.({ type: "booting" });
    const { createEngineService } = await import("./engine-service.js");
    const { startServer } = await import("./server.js");
    const paths = await runtimePaths(root);
    // Credential commands have one documented working directory, never a closed Pi context.
    process.chdir(paths.root);
    await privateDirectory(paths.directory);
    let log: ReturnType<typeof openLifecycleLog> | undefined;
    const note = (phase: Parameters<ReturnType<typeof openLifecycleLog>["write"]>[0]) => {
      try {
        log?.write(phase);
      } catch {
        log?.close(); /* Never follow a replaced diagnostic path. */
      }
    };
    const service = createEngineService(paths.root, true);
    let server: Awaited<ReturnType<typeof startServer>>;
    try {
      server = await startServer(paths.root, service.execute, {
        ...service.hooks,
        stopped: () => {
          note("drained");
          log?.close();
        },
        failure: () => {
          service.hooks.failure();
          note("failed");
        },
      });
      // Only the published owner may open or modify its shared diagnostic file.
      try {
        log = openLifecycleLog(paths.directory);
      } catch (error) {
        server.recordBootOutcome("failed");
        await server.close();
        throw error;
      }
      note("starting");
      service.bind(server);
    } catch (error) {
      note("failed");
      log?.close();
      throw error;
    }
    note("ready");
    server.recordBootOutcome("ready");
    let stopping: Promise<void> | undefined;
    const stop = () => {
      stopping ??= server.close().catch(() => {
        process.exitCode = 1;
      });
      return stopping;
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    // Parent disconnect means readiness IPC ended, not service shutdown.
    process.send?.({ type: "ready", identity: server.identity });
    process.channel?.unref();
    return;
  }
  if (command === "start" || command === "restart") {
    const { identity } = await (command === "start" ? ensureDaemon(root) : restartDaemon(root));
    console.log(JSON.stringify({ running: true, root: identity.root, instance: identity.instance, pid: identity.pid }));
    return;
  }
  if (command === "status") {
    console.log(JSON.stringify(await inspectDaemonStatus(root)));
    return;
  }
  const paths = await runtimePaths(root);
  const identity = await readIdentity(paths);
  if (!identity) {
    console.log(JSON.stringify({ running: false, root: paths.root }));
    return;
  }
  await requestDaemon(paths, identity, "stop", {});
  const deadline = Date.now() + 30_000;
  while (await readIdentity(paths)) {
    if (Date.now() >= deadline) throw new Error("Daemon did not drain; state retained. Do not force a second owner.");
    await delay(25);
  }
  console.log(JSON.stringify({ stopped: true, root: paths.root }));
}
if (import.meta.main) {
  void main(process.argv.slice(2)).catch(() => {
    process.send?.({
      type: "error",
      message:
        "Daemon initialization failed; private state retained. Check endpoint ownership and compatible versions.",
    });
    console.error(
      process.argv[2] === "repair-upgrade"
        ? "Pi Sync upgrade repair failed. Check the pending PID, wait for confirmed exit, and check consent storage. Do not delete recovery files."
        : process.argv[2] === "restart"
          ? "Pi Sync restart failed; private state retained. Check status, version compatibility, and retained unattended permission. Do not force a restart."
          : "pi-sync-daemon failed; private state retained. Check root, endpoint ownership, and version compatibility.",
    );
    process.exitCode = 1;
  });
}
