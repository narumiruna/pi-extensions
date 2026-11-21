import { expect, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { showIgnoreMigrationPrompt } from "../src/ui/ignore-migration-prompt.js";

const { run, validate, migrate, available } = vi.hoisted(() => ({
  run: vi.fn(),
  validate: vi.fn(),
  migrate: vi.fn(),
  available: vi.fn(),
}));
vi.mock("../src/daemon/pi-client.js", () => ({ piDaemonClient: () => ({ run, validate }) }));
vi.mock("../src/ui/ignore-file-ui.js", () => ({
  ignoreFileSettingsAvailable: available,
  showIgnoreFileAction: migrate,
}));

const token = "a".repeat(64);

function fixture(mode: string = "tui", choice?: string) {
  const select = vi.fn(async () => choice);
  const { ctx, notifications } = createMockContext({ mode, select });
  const lifetime = new AbortController();
  let current = true;
  available.mockReset().mockResolvedValue(true);
  run.mockReset().mockResolvedValue({ token });
  validate.mockReset();
  migrate.mockReset().mockResolvedValue(undefined);
  return {
    select,
    ctx,
    notifications,
    lifetime,
    replaceSession: () => {
      current = false;
    },
    prompt: (setup = "work") => showIgnoreMigrationPrompt(ctx, setup, lifetime.signal, () => current),
  };
}

test.each(["rpc", "print", "json"])("does not check capability or prompt in %s mode", async (mode) => {
  const { prompt, select } = fixture(mode);
  expect(await prompt()).toBe(false);
  expect(available).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
});

test("does not ask for an offer when the ignore-file capability is absent", async () => {
  const { prompt, select } = fixture();
  available.mockResolvedValue(false);
  expect(await prompt()).toBe(false);
  expect(run).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
});

test("does not show a prompt for a deferred or ineligible setup", async () => {
  const { prompt, select } = fixture();
  run.mockResolvedValue(null);
  expect(await prompt()).toBe(false);
  expect(select).not.toHaveBeenCalled();
});

test("Review migration now opens the existing review with a setup-bound offer token", async () => {
  const { ctx, lifetime, prompt, select } = fixture("tui", "Review migration now");
  expect(await prompt()).toBe(true);
  expect(select).toHaveBeenCalledWith(
    expect.stringContaining("does not start a transfer"),
    ["Review migration now", "Not now"],
    { signal: lifetime.signal },
  );
  expect(migrate).toHaveBeenCalledExactlyOnceWith(ctx, "work", "migrate", ".syncignore", lifetime.signal, token);
  expect(run.mock.calls.map(([operation]) => operation)).toEqual(["ignore.migration-offer"]);
});

test("Not now is the only choice that records deferral; the next open gets no offer", async () => {
  const { prompt, select, ctx, lifetime } = fixture("tui", "Not now");
  run.mockResolvedValueOnce({ token }).mockResolvedValueOnce(true).mockResolvedValueOnce(null);
  expect(await prompt()).toBe(true);
  expect(await prompt()).toBe(false);
  expect(select).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenNthCalledWith(2, "ignore.migration-defer", { setup: "work", token }, lifetime.signal, ctx);
  expect(migrate).not.toHaveBeenCalled();
});

test.each([undefined, "unexpected choice"])(
  "dismissal (%s) leaves the offer eligible and does not migrate",
  async (choice) => {
    const { prompt, select } = fixture("tui", choice);
    expect(await prompt()).toBe(true);
    expect(await prompt()).toBe(true);
    expect(select).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.map(([operation]) => operation)).toEqual([
      "ignore.migration-offer",
      "ignore.migration-offer",
    ]);
    expect(migrate).not.toHaveBeenCalled();
  },
);

test.each(["Not now", "Review migration now"])("a replaced session ignores the old answer %s", async (choice) => {
  const { prompt, select, replaceSession } = fixture("tui");
  select.mockImplementation(async () => {
    replaceSession();
    return choice;
  });
  expect(await prompt()).toBe(true);
  expect(run.mock.calls.map(([operation]) => operation)).toEqual(["ignore.migration-offer"]);
  expect(migrate).not.toHaveBeenCalled();
});

test("cancellation while waiting for capability prevents the offer RPC", async () => {
  const { prompt, select, lifetime } = fixture();
  available.mockImplementation(async () => {
    lifetime.abort();
    return true;
  });
  expect(await prompt()).toBe(false);
  expect(run).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
});

test("malformed offers warn without exposing the payload", async () => {
  const { prompt, select, notifications } = fixture();
  run.mockResolvedValue({ token: "malformed" });
  expect(await prompt()).toBe(false);
  expect(select).not.toHaveBeenCalled();
  expect(notifications.map(({ message }) => message)).toEqual([
    "Pi Sync migration prompt: Invalid migration offer from the daemon.",
  ]);
});
