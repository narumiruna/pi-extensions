import { afterEach, describe, expect, it, vi } from "vitest";
import type { Notification, PushoverDestination } from "../src/provider.js";
import { createPushoverProvider } from "../src/providers/pushover.js";

const destination: PushoverDestination = {
  provider: "pushover",
  label: "Personal Pushover",
  appToken: "azGDORePK8gMaC0QOYAMyEEuzJnyUi",
  userKey: "uQiRzpo4DXghDmr9QzzfQu27cmVRsG",
};
const note: Notification = {
  id: "private-id",
  title: "Pi needs review",
  body: "Session: <literal> 😀",
  bodyEmphasis: [{ style: "bold", offset: 0, length: 7 }],
  settledAt: 123,
};
// Official response fixture: https://pushover.net/api#response
const accepted = { status: 1, request: "647d2300-702c-4b38-8b2f-d56326ae460b" };
const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());

describe("Pushover validation", () => {
  it("returns only owned fields without changing case or trimming credentials", () => {
    const provider = createPushoverProvider();
    expect(provider.id).toBe("pushover");
    expect(provider.validate({ ...destination, extra: "store-owned", priority: 2, retry: 30 })).toEqual(destination);
    expect(provider.validate(destination)).toEqual(destination);
  });
  it.each([null, undefined, [], {}, { ...destination, provider: "telegram" }])("rejects invalid object %j", (value) => {
    expect(createPushoverProvider().validate(value)).toBeUndefined();
  });
  it.each([null, undefined, 1, "", " ", "a".repeat(129)])("rejects invalid label %j", (label) => {
    expect(createPushoverProvider().validate({ ...destination, label })).toBeUndefined();
  });
  it("accepts the shared label boundary", () => {
    expect(createPushoverProvider().validate({ ...destination, label: "a".repeat(128) })).toBeDefined();
  });
  for (const field of ["appToken", "userKey"] as const) {
    it.each([
      undefined,
      null,
      1,
      [],
      "",
      "a".repeat(29),
      "a".repeat(31),
      `${"a".repeat(30)}\n`,
      `${"a".repeat(29)} `,
      `${"a".repeat(29)}_`,
      `${"a".repeat(29)}-`,
      `${"a".repeat(29)}é`,
      `${"a".repeat(29)}\r`,
      `${"a".repeat(29)}\u001b`,
    ])(`rejects invalid ${field} %j`, (value) => {
      expect(createPushoverProvider().validate({ ...destination, [field]: value })).toBeUndefined();
    });
    it.each(["a".repeat(30), "Z".repeat(30), "0".repeat(30)])(`accepts ASCII alphanumeric ${field}`, (value) => {
      expect(createPushoverProvider().validate({ ...destination, [field]: value })).toMatchObject({ [field]: value });
    });
  }
});

describe("Pushover delivery", () => {
  it("posts only normal-priority metadata and exact credentials to the fixed HTTPS endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(accepted)));
    expect(await createPushoverProvider(fetcher).send(destination, note, signal())).toEqual({ state: "accepted" });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://api.pushover.net/1/messages.json");
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { "content-type": "application/json" } });
    expect(JSON.parse(String(init?.body))).toEqual({
      token: destination.appToken,
      user: destination.userKey,
      title: note.title,
      message: note.body,
      priority: 0,
    });
    expect(String(init?.body)).not.toMatch(/bodyEmphasis|settledAt|private-id|retry|expire|emergency/);
  });
  it.each(["😀", "日", "a"])("clips conservative UTF-16 budgets without splitting %s", async (point) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(accepted)));
    await createPushoverProvider(fetcher).send(
      destination,
      { ...note, title: point.repeat(2000), body: point.repeat(2000) },
      signal(),
    );
    const payload = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(payload.title).toBe(`${point.repeat(Math.floor(249 / point.length))}…`);
    expect(payload.message).toBe(`${point.repeat(Math.floor(1023 / point.length))}…`);
    expect(payload.title.length).toBeLessThanOrEqual(250);
    expect(payload.message.length).toBeLessThanOrEqual(1024);
  });
  it("preserves exact-limit text without adding ellipses", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(accepted)));
    const title = "😀".repeat(125);
    const message = "😀".repeat(512);
    await createPushoverProvider(fetcher).send(destination, { ...note, title, body: message }, signal());
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ title, message });
  });
  it.each([
    [accepted, 200, "accepted"],
    [{ status: 1 }, 200, "accepted"],
    [{ status: 0, errors: ["private credential"], request: "private" }, 200, "api"],
    [{ status: 2 }, 200, "api"],
    [{ status: "1" }, 200, "response"],
    [{ status: true }, 200, "response"],
    [{ status: null }, 200, "response"],
    [{}, 200, "response"],
    [[], 200, "response"],
    [null, 200, "response"],
    [accepted, 201, "response"],
    [accepted, 202, "response"],
    [null, 204, "response"],
    [{ status: 1 }, 400, "http"],
    [{ status: 0, errors: ["private credential"] }, 401, "http"],
    ["private credential", 403, "http"],
    ["private credential", 500, "http"],
    ["private credential", 429, "rate-limit"],
  ])("requires documented HTTP 200 and numeric status 1: %j / %s", async (body, status, code) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(status === 204 ? null : JSON.stringify(body), { status }));
    expect(await createPushoverProvider(fetcher).send(destination, note, signal())).toEqual(
      code === "accepted" ? { state: "accepted" } : { state: "failed", code },
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([null, "", "not JSON"])("rejects missing or malformed response %j", async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    expect(await createPushoverProvider(fetcher).send(destination, note, signal())).toEqual({
      state: "failed",
      code: "response",
    });
  });
  it.each([
    ["12", 12],
    ["1.5", undefined],
    ["secret", undefined],
  ])("exposes only safe rate-limit seconds %s", async (retry, seconds) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("private", { status: 429, headers: { "retry-after": String(retry) } }));
    expect(await createPushoverProvider(fetcher).send(destination, note, signal())).toEqual({
      state: "failed",
      code: "rate-limit",
      ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }),
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("revalidates direct callers and honors pre-cancellation before fetch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = createPushoverProvider(fetcher);
    const controller = new AbortController();
    controller.abort();
    expect(await provider.send(destination, note, controller.signal)).toEqual({
      state: "cancelled",
      code: "cancelled",
    });
    expect(await provider.send({ ...destination, appToken: "invalid" }, note, signal())).toEqual({
      state: "failed",
      code: "invalid-destination",
    });
    expect(await provider.send({ ...destination, userKey: "invalid" }, note, signal())).toEqual({
      state: "failed",
      code: "invalid-destination",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("propagates bounded-response failure and releases the oversized stream", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(65537));
      },
      cancel,
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    expect(await createPushoverProvider(fetcher).send(destination, note, signal())).toEqual({
      state: "failed",
      code: "response",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
  it.each(["cancel", "timeout"])("propagates %s while injected fetch ignores abort", async (kind) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const sending = createPushoverProvider(fetcher).send(destination, note, controller.signal);
    if (kind === "cancel") controller.abort();
    else await vi.advanceTimersByTimeAsync(10000);
    expect(await sending).toEqual(
      kind === "cancel" ? { state: "cancelled", code: "cancelled" } : { state: "failed", code: "timeout" },
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["cancel", "timeout"])("releases stalled response streams after %s", async (kind) => {
    vi.useFakeTimers();
    let ready!: () => void;
    const reading = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream(
      {
        pull() {
          ready();
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const sending = createPushoverProvider(fetcher).send(destination, note, controller.signal);
    await reading;
    if (kind === "cancel") controller.abort();
    else await vi.advanceTimersByTimeAsync(10000);
    expect(await sending).toEqual(
      kind === "cancel" ? { state: "cancelled", code: "cancelled" } : { state: "failed", code: "timeout" },
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("returns only safe codes for thrown credential-bearing errors", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`${destination.appToken} ${destination.userKey}`));
    expect(await createPushoverProvider(fetcher).send(destination, note, signal())).toEqual({
      state: "failed",
      code: "network",
    });
  });
});
