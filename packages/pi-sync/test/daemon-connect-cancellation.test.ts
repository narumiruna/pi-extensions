import assert from "node:assert/strict";
import { test } from "vitest";
import { withTempHome } from "./helpers.js";

for (const action of ["pause", "dispose"] as const)
  test(`${action} uses the partial connection instead of waiting for queued admission`, () =>
    withTempHome(async () => {
      const { bindPiDaemonClient } = await import("../src/daemon/pi-client.js");
      const client = bindPiDaemonClient(
        { sessionManager: {}, isIdle: () => true } as never,
        new AbortController().signal,
      );
      const connecting = Promise.withResolvers<never>();
      void connecting.promise.catch(() => {});
      const calls: string[] = [];
      // Own adapter boundary: a transport can be published before its attach promise settles.
      Object.assign(client, {
        connecting: connecting.promise,
        partialConnection: {
          pause: async () => {
            calls.push("pause");
          },
          dispose: async () => {
            calls.push("dispose");
            connecting.reject(new DOMException("Disposed pending attach", "AbortError"));
          },
        },
      });
      try {
        if (action === "pause") await client.pauseForSessionChange();
        else await client.dispose();
        assert.equal(calls[0], action);
      } finally {
        await client.dispose();
      }
    }));
