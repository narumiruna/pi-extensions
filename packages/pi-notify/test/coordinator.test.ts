import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Coordinator } from "../src/coordinator.js";
import type { Notification, NotificationProvider, TelegramDestination } from "../src/provider.js";
import { defaults, type Settings } from "../src/settings.js";

const destination: TelegramDestination = {
  provider: "telegram",
  label: "one",
  botToken: `123:${"s".repeat(30)}`,
  chatId: "123",
};
const info = { sessionId: "session", sessionName: "name", cwd: "/workspace" };
const coordinators: Coordinator[] = [];
function setup(mode: Settings["mode"] = "immediate", tui = true) {
  const settings: Settings = {
    ...defaults(),
    enabled: true,
    mode,
    targetIds: ["one", "two"],
    destinations: { one: destination, two: { ...destination, chatId: "456" } },
  };
  const send = vi.fn<NotificationProvider["send"]>().mockResolvedValue({ state: "accepted" });
  const provider: NotificationProvider = { id: "telegram", label: "fake", validate: () => destination, send };
  const metadata = vi.fn().mockImplementation(
    async (data) =>
      ({
        id: data.id,
        title: data.error ? "error" : "ready",
        body: String(data.startedAt),
        settledAt: data.settledAt,
      }) satisfies Notification,
  );
  const coordinator = new Coordinator(settings, new Map([["telegram", provider]]), tui, metadata);
  coordinators.push(coordinator);
  return { coordinator, send, metadata, settings };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
});
afterEach(async () => {
  await Promise.all(coordinators.splice(0).map((value) => value.close()));
  vi.useRealTimers();
});

it("ignores historical settlement and sends once after repeated starts/recovery", async () => {
  const { coordinator, send, metadata } = setup();
  coordinator.settle(false, info);
  coordinator.begin(true);
  await vi.advanceTimersByTimeAsync(5000);
  coordinator.assistant(true);
  coordinator.begin(); // Low-level retry is not a new user work period.
  coordinator.assistant(false);
  coordinator.settle(false, info);
  coordinator.settle(false, info);
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(2);
  expect(metadata.mock.calls[0]?.[0]).toMatchObject({ startedAt: 100000, settledAt: 105000, error: false });
});
it.each([false, true])("does not notify until settlement; abort=%s", async (aborted) => {
  const { coordinator, send } = setup();
  coordinator.begin(true);
  coordinator.assistant(true);
  await vi.advanceTimersByTimeAsync(60000);
  expect(send).not.toHaveBeenCalled();
  coordinator.settle(aborted, info);
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(aborted ? 0 : 2);
});
it("waits only the remaining inactivity interval and preserves settlement time", async () => {
  const { coordinator, send } = setup("after-inactivity");
  coordinator.input("x");
  coordinator.begin(true);
  await vi.advanceTimersByTimeAsync(10000);
  coordinator.settle(false, info);
  await vi.advanceTimersByTimeAsync(19999);
  expect(send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0]?.[1].settledAt).toBe(110000);
});
it("sends at settlement after sufficient inactivity, with no cooldown", async () => {
  const { coordinator, send } = setup("after-inactivity");
  coordinator.begin(true);
  await vi.advanceTimersByTimeAsync(31000);
  coordinator.settle(false, info);
  await vi.advanceTimersByTimeAsync(0);
  coordinator.begin(true);
  coordinator.settle(false, info);
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(4);
});
it.each(["typing", "focus", "new-work", "settings", "close"])("cancels a pending reminder on %s", async (cause) => {
  const { coordinator, send, settings } = setup("after-inactivity");
  coordinator.begin(true);
  coordinator.settle(false, info);
  await vi.advanceTimersByTimeAsync(1000);
  if (cause === "typing") coordinator.input("a");
  if (cause === "focus") coordinator.input("\x1b[I");
  if (cause === "new-work") coordinator.begin(true);
  if (cause === "settings") coordinator.apply({ ...settings, inactivitySeconds: 60 });
  if (cause === "close") await coordinator.close();
  await vi.advanceTimersByTimeAsync(120000);
  expect(send).not.toHaveBeenCalled();
  expect(coordinator.pendingAt).toBeUndefined();
});
it.each([false, true])("initial baseline and non-TUI fallback, TUI=%s", async (tui) => {
  const { coordinator, send } = setup("after-inactivity", tui);
  coordinator.begin();
  coordinator.settle(false, info);
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(tui ? 0 : 2);
});
it("ignores focus loss, capability replies and motion while waiting", async () => {
  const { coordinator, send } = setup("after-inactivity");
  coordinator.begin();
  coordinator.settle(false, info);
  coordinator.input("\x1b[O");
  coordinator.input("\x1b[<35;3;2M");
  coordinator.input("\x1b[6;10;20t");
  await vi.advanceTimersByTimeAsync(30000);
  expect(send).toHaveBeenCalledTimes(2);
});
it("does not cancel started delivery for new work and isolates old completion status", async () => {
  const { coordinator, send } = setup();
  let finish: ((value: { state: "accepted" }) => void) | undefined;
  send.mockImplementationOnce(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  coordinator.begin();
  coordinator.settle(false, info);
  await vi.advanceTimersByTimeAsync(0);
  const oldSignal = send.mock.calls[0]?.[2];
  coordinator.begin(true);
  coordinator.settle(false, info);
  await vi.advanceTimersByTimeAsync(0);
  expect(oldSignal?.aborted).toBe(false);
  const sequence = coordinator.statuses.get("one")?.sequence;
  finish?.({ state: "accepted" });
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.statuses.get("one")?.sequence).toBe(sequence);
});
it("isolates fan-out failures and aborts requests during idempotent shutdown", async () => {
  const { coordinator, send } = setup();
  send.mockRejectedValueOnce(new Error("secret"));
  coordinator.begin();
  coordinator.settle(false, info);
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.statuses.get("one")?.result).toEqual({ state: "failed", code: "network" });
  expect(coordinator.statuses.get("two")?.result).toEqual({ state: "accepted" });
  send.mockImplementation(
    async (_destination, _note, signal) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve({ state: "cancelled", code: "cancelled" }), { once: true }),
      ),
  );
  coordinator.begin(true);
  coordinator.settle(false, info);
  await vi.advanceTimersByTimeAsync(0);
  await coordinator.close();
  await coordinator.close();
  expect(send.mock.calls.at(-1)?.[2].aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it("initializes inactivity when observation attaches, not before slow settings load", async () => {
  const { coordinator, send } = setup("after-inactivity");
  await vi.advanceTimersByTimeAsync(60000);
  coordinator.observeActivity();
  coordinator.begin();
  coordinator.settle(false, info);
  await vi.advanceTimersByTimeAsync(29999);
  expect(send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(send).toHaveBeenCalledTimes(2);
});
it("applies policy changes only to subsequent work periods", async () => {
  const { coordinator, send, settings } = setup();
  coordinator.begin();
  coordinator.apply({ ...settings });
  coordinator.begin(); // Recovery does not change the work-period policy revision.
  coordinator.settle(false, info);
  await vi.advanceTimersByTimeAsync(0);
  expect(send).not.toHaveBeenCalled();
  coordinator.begin(true);
  coordinator.settle(false, info);
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(2);
});
it("guards metadata continuations when user returns or new work starts", async () => {
  const { coordinator, send, metadata } = setup();
  let finish: ((value: Notification) => void) | undefined;
  metadata.mockImplementationOnce(
    async (_data, signal: AbortSignal) =>
      new Promise((resolve) => {
        finish = resolve;
        signal.addEventListener("abort", () => resolve({ id: "1", title: "ready", body: "", settledAt: 0 }));
      }),
  );
  coordinator.begin();
  coordinator.settle(false, info);
  coordinator.begin(true);
  finish?.({ id: "1", title: "ready", body: "", settledAt: 0 });
  await vi.advanceTimersByTimeAsync(0);
  expect(send).not.toHaveBeenCalled();
});
