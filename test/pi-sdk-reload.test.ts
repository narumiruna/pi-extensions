import assert from "node:assert/strict";
import { fauxProvider } from "@earendil-works/pi-ai";
import { test } from "vitest";
import { withCoreCompatibilityFixture } from "./pi-core-compatibility-fixture.js";

test("offline SDK reload restarts extensions bound with empty options exactly once", async () => {
  await withCoreCompatibilityFixture(async ({ createSession }) => {
    const faux = fauxProvider({ provider: "sdk-reload-offline", tokensPerSecond: Infinity });
    const events: string[] = [];
    const session = await createSession(
      {
        provider: faux.provider,
        extensionFactories: [
          (pi) => {
            pi.on("session_start", ({ reason }) => {
              events.push(`start:${reason}`);
            });
            pi.on("session_shutdown", ({ reason }) => {
              events.push(`shutdown:${reason}`);
            });
          },
        ],
      },
      {},
    );
    assert.deepEqual(events, ["start:startup"]);
    await session.reload();
    assert.deepEqual(events, ["start:startup", "shutdown:reload", "start:reload"]);
    assert.equal(faux.state.callCount, 0);
  });
});
