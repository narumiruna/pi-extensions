import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Destination, LineDestination, Notification } from "../src/provider.js";
import { createLineProvider } from "../src/providers/line.js";

const destination: LineDestination = {
  provider: "line",
  label: "Personal LINE",
  channelAccessToken: "synthetic+channel/access.token_~==",
  recipientId: `U${"0123456789abcdef".repeat(2)}`,
};
const note: Notification = {
  id: "private-notification-id",
  title: "Pi needs review",
  body: "Session: <literal> 😀\nPath: /private/project",
  bodyEmphasis: [{ style: "bold", offset: 0, length: 7 }],
  settledAt: 123,
};
// Current official reference example, not credentials:
// https://developers.line.biz/en/reference/messaging-api/#send-push-message-response
const accepted = { sentMessages: [{ id: "461230966842064897", quoteToken: "IStG5h1Tz7b..." }] };
// Legacy {} is also exercised by LINE's own pushMessage tests:
// https://github.com/line/line-bot-sdk-nodejs/blob/master/test/line-bot-client.spec.ts
const signal = () => new AbortController().signal;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("LINE validation", () => {
  it("returns only owned fields without trimming or changing credential case", () => {
    const provider = createLineProvider();
    expect(provider.id).toBe("line");
    expect(provider.label).toBe("LINE");
    expect(provider.validate({ ...destination, extra: "store-owned", notificationDisabled: true })).toEqual(
      destination,
    );
  });
  it.each([null, undefined, [], {}, 1, "line", { ...destination, provider: "telegram" }])(
    "rejects invalid object %j",
    (value) => {
      expect(createLineProvider().validate(value)).toBeUndefined();
    },
  );
  it.each([null, undefined, 1, [], "", " ", "a".repeat(129)])("rejects invalid label %j", (label) => {
    expect(createLineProvider().validate({ ...destination, label })).toBeUndefined();
  });
  it("accepts the shared label boundary", () => {
    expect(createLineProvider().validate({ ...destination, label: "a".repeat(128) })).toBeDefined();
  });
  it.each([
    undefined,
    null,
    1,
    [],
    "",
    " ",
    "=",
    "Bearer token",
    " leading",
    "trailing ",
    "inside space",
    "a=b",
    "token\n",
    "token\r",
    "token\u0000",
    "token\u001b",
    "token\u007f",
    "token\u0085",
    "token日",
    "token:secret",
    "token?secret",
    "a".repeat(8193),
  ])("rejects invalid channel token %j", (channelAccessToken) => {
    expect(createLineProvider().validate({ ...destination, channelAccessToken })).toBeUndefined();
  });
  it.each(["a", "Aa0-._~+/", "opaque==", "header.payload.signature", "a".repeat(8192)])(
    "accepts opaque Bearer token syntax without an inferred fixed/minimum length",
    (channelAccessToken) => {
      expect(createLineProvider().validate({ ...destination, channelAccessToken })).toMatchObject({
        channelAccessToken,
      });
    },
  );
  it.each(["U", "C", "R"])("accepts documented %s recipient family", (prefix) => {
    const recipientId = `${prefix}${"a".repeat(32)}`;
    expect(createLineProvider().validate({ ...destination, recipientId })).toMatchObject({ recipientId });
  });
  it.each(["C0", "Rf", "Copaque-Group_ID", "Ropaque/room+id=", `C${"a".repeat(128)}`, `R${"a".repeat(128)}`])(
    "preserves opaque group/room suffixes within local ASCII bounds: %s",
    (recipientId) => {
      expect(createLineProvider().validate({ ...destination, recipientId })).toMatchObject({ recipientId });
    },
  );
  it.each([
    undefined,
    null,
    1,
    [],
    "",
    "display name",
    "@public-line-id",
    "U",
    "C",
    "R",
    `U${"a".repeat(31)}`,
    `U${"a".repeat(33)}`,
    `C${"a".repeat(129)}`,
    `R${"a".repeat(129)}`,
    `u${"a".repeat(32)}`,
    `c${"a".repeat(32)}`,
    `r${"a".repeat(32)}`,
    `X${"a".repeat(32)}`,
    `U${"A".repeat(32)}`,
    "Copaque group",
    "Ropaque\troom",
    "Copaque\u0000group",
    "Ropaque\u001broom",
    "Copaque\u007fgroup",
    "Ropaque\u0085room",
    `R${"日".repeat(32)}`,
    ` ${destination.recipientId}`,
    `${destination.recipientId} `,
    `${destination.recipientId}\n`,
    `${destination.recipientId}\r`,
    `${destination.recipientId}\u001b`,
    `${destination.recipientId}/path`,
  ])("rejects invalid recipient %j", (recipientId) => {
    expect(createLineProvider().validate({ ...destination, recipientId })).toBeUndefined();
  });
});

describe("LINE payload", () => {
  it.each(["U", "C", "R"])("posts one normal text message to %s via the fixed HTTPS endpoint", async (prefix) => {
    const recipientId = `${prefix}${"a".repeat(32)}`;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(accepted));
    expect(await createLineProvider(fetcher).send({ ...destination, recipientId }, note, signal())).toEqual({
      state: "accepted",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://api.line.me/v2/bot/message/push");
    expect(String(url)).not.toContain(destination.channelAccessToken);
    expect(String(url)).not.toContain(recipientId);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      signal: expect.any(AbortSignal),
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${destination.channelAccessToken}`,
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      to: recipientId,
      messages: [{ type: "text", text: `${note.title}\n${note.body}` }],
    });
    expect(String(init?.body)).not.toMatch(/bodyEmphasis|settledAt|private-notification-id|notificationDisabled/);
    expect(String(init?.body)).not.toContain(destination.channelAccessToken);
  });
  it("sends mentions, links, and markup as literal text without structured interpretation", async () => {
    const text = '@everyone @all <@123> **bold** [label](https://example.test) <tag> & "quote" `code` $';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({}));
    await createLineProvider(fetcher).send(destination, { ...note, title: text, body: text }, signal());
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      to: destination.recipientId,
      messages: [{ type: "text", text: `${text}\n${text}` }],
    });
  });
  it("removes terminal and direction controls before clipping while preserving metadata lines", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({}));
    const title = "\u001b[31mPi\u001b[0m\u0007\u0000";
    const body = "Session: \u001b]8;;https://evil.test\u0007name\u001b]8;;\u0007\nPath:\t/private\u202e/dir\u009b31m";
    await createLineProvider(fetcher).send(destination, { ...note, title, body }, signal());
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).messages).toEqual([
      { type: "text", text: "Pi\nSession: name\nPath: /private/dir" },
    ]);
    expect(title).toContain("\u001b");
    expect(body).toContain("\u202e");
  });
  it.each(["a", "日", "😀", "e\u0301", "👨‍👩‍👧‍👦"])(
    "clips a combined 5,000 UTF-16 budget without splitting code points: %s",
    async (point) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({}));
      await createLineProvider(fetcher).send(
        destination,
        { ...note, title: "Title", body: point.repeat(6000) },
        signal(),
      );
      const text = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).messages[0].text as string;
      expect(text.length).toBeLessThanOrEqual(5000);
      expect(text).toMatch(/^Title\n/);
      expect(text.endsWith("…")).toBe(true);
      expect(Array.from(text).every((character) => character.length === 2 || !/[\uD800-\uDFFF]/u.test(character))).toBe(
        true,
      );
      // The ellipsis is inside the same budget, including title and newline.
      const source = `Title\n${point.repeat(6000)}`;
      let expected = "";
      for (const character of source) {
        if (expected.length + character.length > 4999) break;
        expected += character;
      }
      expect(text).toBe(`${expected}…`);
    },
  );
  it.each([4999, 5000, 5001])("handles exact combined ASCII boundary %s", async (length) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({}));
    const source = `T\n${"a".repeat(length - 2)}`;
    await createLineProvider(fetcher).send(destination, { ...note, title: "T", body: source.slice(2) }, signal());
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).messages[0].text).toBe(
      length > 5000 ? `${source.slice(0, 4999)}…` : source,
    );
  });
  it("retains an exact-limit emoji and removes it whole when the ellipsis needs space", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response({}));
    const provider = createLineProvider(fetcher);
    await provider.send(destination, { ...note, title: "T", body: `${"a".repeat(4996)}😀` }, signal());
    await provider.send(destination, { ...note, title: "T", body: `${"a".repeat(4996)}😀z` }, signal());
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).messages[0].text).toBe(`T\n${"a".repeat(4996)}😀`);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).messages[0].text).toBe(`T\n${"a".repeat(4996)}…`);
  });
});

describe("LINE results and shared transport", () => {
  it.each([
    [accepted, "accepted"],
    [{}, "accepted"],
    [{ sentMessages: [{ id: "id" }] }, "accepted"],
    [{ sentMessages: [{ id: Number("461230966842064897") }] }, "accepted"],
    [{ sentMessages: [{ id: 0, quoteToken: "" }] }, "accepted"],
    [{ sentMessages: Array.from({ length: 5 }, (_, id) => ({ id: String(id) })), future: true }, "accepted"],
    [{ message: destination.channelAccessToken }, "response"],
    [{ sentMessages: [] }, "response"],
    [{ sentMessages: Array.from({ length: 6 }, () => ({ id: "id" })) }, "response"],
    [{ sentMessages: {} }, "response"],
    [{ sentMessages: null }, "response"],
    [{ sentMessages: [null] }, "response"],
    [{ sentMessages: [[]] }, "response"],
    [{ sentMessages: [{}] }, "response"],
    [{ sentMessages: [{ id: "" }] }, "response"],
    [{ sentMessages: [{ id: null }] }, "response"],
    [{ sentMessages: [{ id: true }] }, "response"],
    [{ sentMessages: [{ id: [] }] }, "response"],
    [{ sentMessages: [{ id: {} }] }, "response"],
    [{ sentMessages: [{ id: -1 }] }, "response"],
    [{ sentMessages: [{ id: 1.5 }] }, "response"],
    [{ sentMessages: [{ id: "id", quoteToken: null }] }, "response"],
    [{ sentMessages: [{ id: "id", quoteToken: 123 }] }, "response"],
    [[], "response"],
    [null, "response"],
    [true, "response"],
    ["ok", "response"],
    [123, "response"],
  ])("maps documented acceptance variants without echoing service fields: %j", async (body, code) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(body));
    expect(await createLineProvider(fetcher).send(destination, note, signal())).toEqual(
      code === "accepted" ? { state: "accepted" } : { state: "failed", code },
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([201, 202, 204, 205, 206])("does not treat undocumented HTTP %s as acceptance", async (status) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(status === 204 || status === 205 ? null : JSON.stringify(accepted), { status }));
    expect(await createLineProvider(fetcher).send(destination, note, signal())).toEqual({
      state: "failed",
      code: "response",
    });
  });
  it.each([null, "", "not JSON", "{", '{"sentMessages":[{"id":1e999}]}'])(
    "rejects empty, malformed, or nonfinite successful response %j",
    async (body) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      expect(await createLineProvider(fetcher).send(destination, note, signal())).toEqual({
        state: "failed",
        code: "response",
      });
    },
  );
  it.each([301, 302, 307, 308, 400, 401, 403, 404, 409, 413, 500, 503])(
    "returns only safe HTTP errors for %s and cancels unread bodies",
    async (status) => {
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const stream = new ReadableStream({ cancel });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status }));
      expect(await createLineProvider(fetcher).send(destination, note, signal())).toEqual({
        state: "failed",
        code: "http",
      });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
      expect(stream.locked).toBe(false);
    },
  );
  it.each([
    [undefined, undefined],
    ["12", 12],
    ["0008", 8],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    ["0", undefined],
    ["-1", undefined],
    ["1.5", undefined],
    ["+1", undefined],
    ["1e2", undefined],
    ["99999999999999999999", undefined],
    ["Wed, 21 Oct 2026 07:28:00 GMT", undefined],
    [destination.channelAccessToken, undefined],
  ])("returns only positive safe 429 Retry-After seconds: %s", async (retry, seconds) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(`${destination.channelAccessToken} ${destination.recipientId}`, {
        status: 429,
        headers: retry === undefined ? {} : { "retry-after": retry },
      }),
    );
    expect(await createLineProvider(fetcher).send(destination, note, signal())).toEqual({
      state: "failed",
      code: "rate-limit",
      ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }),
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("revalidates direct callers and prioritizes pre-abort without fetching or starting timers", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = createLineProvider(fetcher);
    const invalid = { ...destination, channelAccessToken: "bad\nheader" };
    const controller = new AbortController();
    controller.abort();
    expect(await provider.send(invalid, note, controller.signal)).toEqual({ state: "cancelled", code: "cancelled" });
    for (const value of [
      invalid,
      { ...destination, recipientId: "display name" },
      { ...destination, label: "" },
      { ...destination, provider: "webhook" } as unknown as Destination,
    ]) {
      expect(await provider.send(value, note, signal())).toEqual({ state: "failed", code: "invalid-destination" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([65536, 65537])("bounds streamed response bytes at %s and releases the reader", async (length) => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{${" ".repeat(length - 2)}}`));
        if (length === 65536) controller.close();
      },
      cancel,
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    expect(await createLineProvider(fetcher).send(destination, note, signal())).toEqual(
      length === 65536 ? { state: "accepted" } : { state: "failed", code: "response" },
    );
    if (length > 65536) expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });
  it.each(["cancel", "timeout"])(
    "interrupts stalled injected fetch after %s and cancels late responses",
    async (kind) => {
      let respond!: (value: Response) => void;
      const controller = new AbortController();
      const fetcher = vi.fn<typeof fetch>().mockImplementation(
        () =>
          new Promise((resolve) => {
            respond = resolve;
          }),
      );
      const sending = createLineProvider(fetcher).send(destination, note, controller.signal);
      const combined = fetcher.mock.calls[0]?.[1]?.signal;
      if (kind === "cancel") controller.abort();
      else await vi.advanceTimersByTimeAsync(10000);
      expect(await sending).toEqual(
        kind === "cancel" ? { state: "cancelled", code: "cancelled" } : { state: "failed", code: "timeout" },
      );
      expect(combined?.aborted).toBe(true);
      expect(fetcher).toHaveBeenCalledOnce();
      const cancel = vi.fn();
      respond(new Response(new ReadableStream({ cancel })));
      await Promise.resolve();
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
  it.each(["cancel", "timeout"])("interrupts body reads and releases stalled cancellation after %s", async (kind) => {
    let ready!: () => void;
    const reading = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream(
      {
        pull() {
          ready();
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    const sending = createLineProvider(fetcher).send(destination, note, controller.signal);
    await reading;
    if (kind === "cancel") controller.abort();
    else await vi.advanceTimersByTimeAsync(10000);
    expect(await sending).toEqual(
      kind === "cancel" ? { state: "cancelled", code: "cancelled" } : { state: "failed", code: "timeout" },
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("uses one total deadline across fetch and body, and removes its abort listener", async () => {
    const add = vi.spyOn(AbortSignal.prototype, "addEventListener");
    const remove = vi.spyOn(AbortSignal.prototype, "removeEventListener");
    let respond!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    const sending = createLineProvider(fetcher).send(destination, note, signal());
    await vi.advanceTimersByTimeAsync(9000);
    let ready!: () => void;
    const reading = new Promise<void>((resolve) => {
      ready = resolve;
    });
    respond(
      new Response(
        new ReadableStream(
          {
            pull() {
              ready();
            },
          },
          { highWaterMark: 0 },
        ),
      ),
    );
    await reading;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await sending).toEqual({ state: "failed", code: "timeout" });
    const combined = fetcher.mock.calls[0]?.[1]?.signal;
    const index = add.mock.contexts.indexOf(combined);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(remove.mock.calls).toContainEqual(["abort", add.mock.calls[index]?.[1]]);
    expect(remove.mock.contexts).toContain(combined);
  });
  it.each(["fetch", "read"])("redacts credential-bearing %s failures", async (stage) => {
    const secret = `${destination.channelAccessToken} ${destination.recipientId}`;
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new Error(secret));
      },
    });
    const fetcher = vi.fn<typeof fetch>();
    if (stage === "fetch") fetcher.mockRejectedValue(new Error(secret));
    else fetcher.mockResolvedValue(new Response(stream));
    expect(await createLineProvider(fetcher).send(destination, note, signal())).toEqual({
      state: "failed",
      code: "network",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });
});
