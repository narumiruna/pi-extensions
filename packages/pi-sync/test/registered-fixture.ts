import { readFileSync } from "node:fs";
import path from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { validateSettingsDocument } from "@narumitw/pi-sync-daemon/engine/settings/settings-validation";
import { createMockPi as baseMockPi } from "../../../test/support.js";
import { installPiDaemonHost } from "../src/daemon/pi-client.js";
import { adoptFixtureRoot } from "./daemon-test-helpers.js";
import { installEngineFixtureHost } from "./engine-host.js";
import { registerFixtureCleanup } from "./helpers.js";

/** Model the SDK's start-before-command contract in legacy command-unit fixtures. */
export function createRegisteredMockPi(options: Parameters<typeof baseMockPi>[0] = {}) {
  const mock = baseMockPi(options);
  const started = new WeakSet<object>();
  const track = async (ctx: ExtensionContext) => {
    if (started.has(ctx.sessionManager)) return;
    started.add(ctx.sessionManager);
    registerFixtureCleanup(async () => {
      installPiDaemonHost();
      try {
        for (const handler of mock.events.get("session_shutdown") ?? [])
          await handler({ type: "session_shutdown", reason: "reload" }, ctx);
      } finally {
        installEngineFixtureHost();
      }
    });
    let configured = false;
    try {
      configured = Boolean(
        validateSettingsDocument(JSON.parse(readFileSync(path.join(getAgentDir(), "pi-sync.json"), "utf8")))
          .activeSyncSetup,
      );
    } catch {
      /* Invalid fixture input must reach the production barrier unchanged. */
    }
    if (configured && ctx.hasUI && ["tui", "rpc"].includes(ctx.mode)) await adoptFixtureRoot(getAgentDir());
  };
  const pi = new Proxy<ExtensionAPI>(mock.pi, {
    get(target, key) {
      const on = target.on as (event: string, handler: (data: unknown, ctx: ExtensionContext) => unknown) => void;
      if (key === "on")
        return ((event: string, handler: (data: unknown, ctx: ExtensionContext) => unknown) => {
          if (event === "session_start")
            return on(event, async (data, ctx) => {
              await track(ctx);
              return handler(data, ctx);
            });
          if (event === "session_shutdown")
            return on(event, async (data, ctx) => {
              try {
                return await handler(data, ctx);
              } finally {
                started.delete(ctx.sessionManager);
              }
            });
          return on(event, handler);
        }) as typeof target.on;
      if (key === "registerCommand")
        return ((name, definition) =>
          target.registerCommand(name, {
            ...definition,
            handler: async (args, ctx) => {
              if (!ctx.hasUI) return definition.handler(args, ctx);
              installPiDaemonHost();
              try {
                if (!started.has(ctx.sessionManager)) {
                  for (const handler of mock.events.get("session_start") ?? [])
                    await handler({ type: "session_start", reason: "startup" }, ctx);
                }
                return await definition.handler(args, ctx);
              } finally {
                installEngineFixtureHost();
              }
            },
          })) as typeof target.registerCommand;
      return Reflect.get(target, key, target);
    },
  });
  return { ...mock, pi };
}
