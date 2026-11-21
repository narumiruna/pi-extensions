import { initTheme } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { showSyncManager } from "../src/ui/manager-ui.js";
import { installEngineFixtureHost } from "./engine-host.js";

const { describe, prompt } = vi.hoisted(() => ({ describe: vi.fn(), prompt: vi.fn() }));
vi.mock("../src/ui/manager-state.js", async (original) => ({
  ...(await original<typeof import("../src/ui/manager-state.js")>()),
  describeManagerState: describe,
}));
vi.mock("../src/ui/ignore-migration-prompt.js", () => ({ showIgnoreMigrationPrompt: prompt }));

initTheme("dark", false);
const ready = {
  title: "Manage sync\nHome",
  actions: ["Help"],
  configReview: { setupName: "home", fingerprint: "reviewed" },
  operation: { kind: "free" },
};

test("the migration prompt runs before the visible manager, then refreshes once", async () => {
  installEngineFixtureHost();
  const events: string[] = [];
  describe.mockReset().mockImplementation(async () => {
    events.push("state");
    return ready;
  });
  prompt.mockReset().mockImplementation(async () => {
    events.push("offer");
    return true;
  });
  const { ctx } = createMockContext({
    mode: "tui",
    select: async () => {
      events.push("manager");
      return undefined;
    },
  });
  await showSyncManager(ctx, async () => undefined);
  expect(events).toEqual(["state", "offer", "state", "manager"]);
  expect(prompt.mock.calls[0]?.[1]).toBe("home");
});

test.each([
  { ...ready, operation: { kind: "busy" } },
  { ...ready, configReview: undefined },
])("recovery-needed or unconfigured managers do not request a migration offer", async (state) => {
  installEngineFixtureHost();
  describe.mockReset().mockResolvedValue(state);
  prompt.mockReset();
  const { ctx } = createMockContext({ mode: "tui", select: async () => undefined });
  await showSyncManager(ctx, async () => undefined);
  expect(prompt).not.toHaveBeenCalled();
});
