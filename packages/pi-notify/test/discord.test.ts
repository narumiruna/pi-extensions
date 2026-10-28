import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscordDestination, Notification } from "../src/provider.js";
import { createDiscordProvider, validateDiscordWebhookUrl } from "../src/providers/discord.js";

const base = "https://discord.com/api/webhooks";
const destination: DiscordDestination = {
  provider: "discord",
  label: "Personal Discord",
  webhookUrl: `${base}/123456789012345678/private_token-ABC123`,
};
const note: Notification = {
  id: "private-id",
  title: "Pi needs review",
  body: "Session: <literal> 😀",
  bodyEmphasis: [{ style: "bold", offset: 0, length: 7 }],
  settledAt: 123,
};
// Minimal acceptance fields from execute_webhook's HTTP 200 MessageResponse:
// https://github.com/discord/discord-api-spec/blob/ed014089afa986f2b532ae081c456a85de074d0c/specs/openapi.json
const accepted = { id: "123456789012345678", channel_id: "234567890123456789", type: 0 };
const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());

describe("Discord validation", () => {
  it.each([
    `${base}/1/a`,
    `${base}/18446744073709551615/_-aA09`,
    "https://discord.com/api/v10/webhooks/123456789012345678/token",
    `${base}/1/${"a".repeat(2048 - `${base}/1/`.length)}`,
  ])("accepts canonical official endpoint %s without normalization", (webhookUrl) => {
    expect(validateDiscordWebhookUrl(webhookUrl)).toBe(true);
    const provider = createDiscordProvider();
    expect(provider.id).toBe("discord");
    expect(provider.validate({ ...destination, webhookUrl, extra: "store-owned" })).toEqual({
      ...destination,
      webhookUrl,
    });
  });
  it.each([
    undefined,
    null,
    1,
    {},
    "",
    "/api/webhooks/1/token",
    "//discord.com/api/webhooks/1/token",
    "http://discord.com/api/webhooks/1/token",
    "HTTPS://discord.com/api/webhooks/1/token",
    "https://DISCORD.com/api/webhooks/1/token",
    "https://discord.com./api/webhooks/1/token",
    "https://discord.com:443/api/webhooks/1/token",
    "https://discord.com:8443/api/webhooks/1/token",
    "https://discordapp.com/api/webhooks/1/token",
    "https://canary.discord.com/api/webhooks/1/token",
    "https://ptb.discord.com/api/webhooks/1/token",
    "https://discord.com.evil.test/api/webhooks/1/token",
    "https://user:secret@discord.com/api/webhooks/1/token",
    "https://@discord.com/api/webhooks/1/token",
    "https://discord.com@evil.test/api/webhooks/1/token",
    "https://discord%2ecom/api/webhooks/1/token",
    "https:discord.com/api/webhooks/1/token",
    "https:/discord.com/api/webhooks/1/token",
    "https:///discord.com/api/webhooks/1/token",
    "https:////discord.com/api/webhooks/1/token",
    "https://discord.com//api/webhooks/1/token",
    "https://discord.com/api/v9/webhooks/1/token",
    "https://discord.com/api/v11/webhooks/1/token",
    "https://discord.com/api/v010/webhooks/1/token",
    "https://discord.com/api/./webhooks/1/token",
    "https://discord.com/other/../api/webhooks/1/token",
    "https://discord.com/api/%77ebhooks/1/token",
    "https://discord.com/api/webhooks/%31/token",
    "https://discord.com/api/webhooks/1/%74oken",
    "https://discord.com/api/webhooks/1/token/",
    `${base}/0/token`,
    `${base}/01/token`,
    `${base}/+1/token`,
    `${base}/-1/token`,
    `${base}/1.0/token`,
    `${base}/18446744073709551616/token`,
    `${base}/999999999999999999999/token`,
    `${base}/１２/token`,
    `${base}/1/`,
    `${base}/1/has.dot`,
    `${base}/1/token=`,
    `${base}/1/has+plus`,
    `${base}/1/日`,
    `${base}/1/token/other`,
    `${base}/1/token?`,
    `${base}/1/token?wait=true`,
    `${base}/1/token#`,
    `${base}/1/token#fragment`,
    `${base}/1/token%00`,
    `${base}/1/token%0a`,
    `${base}/1/token%5c`,
    ` ${base}/1/token`,
    `${base}/1/token `,
    `${base}/1/token\n`,
    `${base}/1/token\r`,
    `${base}/1/token\u001b`,
    `${base}/1/token\u007f`,
    `${base}/1/token\u0085`,
    `${base}/1/token\u2028`,
    "https://dis\ncord.com/api/webhooks/1/token",
    "https://discord.com\\api/webhooks/1/token",
    `${base}/1/to\\ken`,
    `${base}/1/${"a".repeat(2049 - `${base}/1/`.length)}`,
  ])("rejects aliases, unsafe URLs, and invalid fields %j", (webhookUrl) => {
    expect(validateDiscordWebhookUrl(webhookUrl)).toBe(false);
    expect(createDiscordProvider().validate({ ...destination, webhookUrl })).toBeUndefined();
  });
  it.each([null, undefined, [], {}, { ...destination, provider: "slack" }])(
    "rejects invalid destination %j",
    (value) => {
      expect(createDiscordProvider().validate(value)).toBeUndefined();
    },
  );
  it.each([undefined, null, 1, "", " ", "a".repeat(129)])("rejects invalid label %j", (label) => {
    expect(createDiscordProvider().validate({ ...destination, label })).toBeUndefined();
  });
  it("accepts the shared label boundary", () => {
    expect(createDiscordProvider().validate({ ...destination, label: "a".repeat(128) })).toBeDefined();
  });
});

describe("Discord delivery", () => {
  it.each([destination.webhookUrl, "https://discord.com/api/v10/webhooks/1/token"])(
    "requests server confirmation for %s",
    async (webhookUrl) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(accepted)));
      expect(await createDiscordProvider(fetcher).send({ ...destination, webhookUrl }, note, signal())).toEqual({
        state: "accepted",
      });
      expect(fetcher).toHaveBeenCalledOnce();
      const [url, init] = fetcher.mock.calls[0] ?? [];
      expect(url).toBe(`${webhookUrl}?wait=true`);
      expect(init).toMatchObject({
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "User-Agent": "DiscordBot (https://github.com/narumiruna/pi-extensions, 1.0)",
        },
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        content: `${note.title}\n${note.body}`,
        allowed_mentions: { parse: [] },
        flags: 4,
      });
      expect(String(init?.body)).not.toMatch(/bodyEmphasis|settledAt|private-id|private_token/);
    },
  );
  it("suppresses all mention parsing and embeds for hostile direct-call metadata without suppressing notifications", async () => {
    const title = "@everyone @here <@123456789012345678> <@!123456789012345678>";
    const body = "<@&234567890123456789> https://example.com <#345678901234567890> **literal** &lt;@everyone&gt;";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(accepted)));
    await createDiscordProvider(fetcher).send(destination, { ...note, title, body }, signal());
    const payload = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(payload).toEqual({ content: `${title}\n${body}`, allowed_mentions: { parse: [] }, flags: 4 });
    expect(payload.flags & 4096).toBe(0);
    expect(payload.allowed_mentions).not.toHaveProperty("users");
    expect(payload.allowed_mentions).not.toHaveProperty("roles");
    expect(payload.allowed_mentions).not.toHaveProperty("replied_user");
  });
  it("sanitizes terminal and direction controls linewise at the transport boundary without changing the note", async () => {
    const hostile = {
      ...note,
      title: "\u001b[31mTitle\u001b[0m\u0000\u202e",
      body: "first\u001b]8;;https://secret\u0007link\u001b]8;;\u0007\nsecond\u009b31m red\u009b0m\nlast\u2066text\u2069",
    };
    const original = { ...hostile };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(accepted)));
    await createDiscordProvider(fetcher).send(destination, hostile, signal());
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).content).toBe("Title\nfirstlink\nsecond red\nlasttext");
    expect(hostile).toEqual(original);
  });
  it.each(["😀", "日", "a"])("clips combined content within 2000 UTF-16 units without splitting %s", async (point) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(accepted)));
    await createDiscordProvider(fetcher).send(destination, { ...note, title: "", body: point.repeat(3000) }, signal());
    const content = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).content;
    expect(content).toBe(`\n${point.repeat(Math.floor(1998 / point.length))}…`);
    expect(content.length).toBeLessThanOrEqual(2000);
  });
  it("preserves exact-limit content and falls back for empty sanitized metadata", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(accepted)));
    const provider = createDiscordProvider(fetcher);
    await provider.send(destination, { ...note, title: "a", body: "😀".repeat(999) }, signal());
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).content).toBe(`a\n${"😀".repeat(999)}`);
    await provider.send(destination, { ...note, title: "\u001b[31m", body: "\u0000" }, signal());
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).content).toBe("Pi notification");
  });
  it.each<[unknown, number, string]>([
    [accepted, 200, "accepted"],
    [{ ...accepted, type: 19 }, 200, "accepted"],
    [{ ...accepted, id: "18446744073709551615", channel_id: "1" }, 200, "accepted"],
    [{}, 200, "response"],
    [[], 200, "response"],
    [null, 200, "response"],
    [{ message: "private error", code: 10015 }, 200, "response"],
    ...[undefined, null, 1, "", "0", "01", "-1", "1.0", "18446744073709551616", "1\n"].flatMap<
      [unknown, number, string]
    >((value) => [
      [{ ...accepted, id: value }, 200, "response"],
      [{ ...accepted, channel_id: value }, 200, "response"],
    ]),
    ...[undefined, null, "0", 1.5, true].map<[unknown, number, string]>((type) => [
      { ...accepted, type },
      200,
      "response",
    ]),
    [accepted, 201, "response"],
    [accepted, 202, "response"],
    [null, 204, "response"],
    [accepted, 400, "http"],
    ["private error", 401, "http"],
    ["private error", 403, "http"],
    ["private error", 500, "http"],
    ["private error", 429, "rate-limit"],
  ])("requires HTTP 200 and Message acceptance fields: %j / %s", async (body, status, code) => {
    const httpStatus = Number(status);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(httpStatus === 204 ? null : JSON.stringify(body), { status: httpStatus }));
    expect(await createDiscordProvider(fetcher).send(destination, note, signal())).toEqual(
      code === "accepted" ? { state: "accepted" } : { state: "failed", code },
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([null, "", "not JSON"])("rejects absent or malformed JSON %j", async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    expect(await createDiscordProvider(fetcher).send(destination, note, signal())).toEqual({
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
    expect(await createDiscordProvider(fetcher).send(destination, note, signal())).toEqual({
      state: "failed",
      code: "rate-limit",
      ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }),
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("revalidates direct callers and honors pre-cancellation before fetch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = createDiscordProvider(fetcher);
    const controller = new AbortController();
    controller.abort();
    expect(await provider.send(destination, note, controller.signal)).toEqual({
      state: "cancelled",
      code: "cancelled",
    });
    expect(
      await provider.send({ ...destination, webhookUrl: `${destination.webhookUrl}?wait=true` }, note, signal()),
    ).toEqual({ state: "failed", code: "invalid-destination" });
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
    expect(await createDiscordProvider(fetcher).send(destination, note, signal())).toEqual({
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
    const sending = createDiscordProvider(fetcher).send(destination, note, controller.signal);
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
    const sending = createDiscordProvider(fetcher).send(destination, note, controller.signal);
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
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(destination.webhookUrl));
    expect(await createDiscordProvider(fetcher).send(destination, note, signal())).toEqual({
      state: "failed",
      code: "network",
    });
  });
});
