import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notificationMetadata } from "../src/metadata.js";
import { type Destination, deliver, type Notification } from "../src/provider.js";
import { createTelegramProvider } from "../src/providers/telegram.js";
import { clipText } from "../src/text.js";

export const destination: Destination = {
  provider: "telegram",
  label: "Personal",
  botToken: `123:${"s".repeat(30)}`,
  chatId: "-100123",
};
const note: Notification = { id: "1", title: "Test", body: "hello <b>world</b>", settledAt: 0 };
afterEach(() => vi.useRealTimers());

interface TelegramMessage {
  text: string;
  entities: { type: "bold" | "code"; offset: number; length: number }[];
}
async function sentMessage(notification: Notification): Promise<TelegramMessage> {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"ok":true,"result":{}}'));
  expect(await createTelegramProvider(fetcher).send(destination, notification, new AbortController().signal)).toEqual({
    state: "accepted",
  });
  return JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
}
function selectedEntities(message: TelegramMessage) {
  return message.entities.map(({ type, offset, length }) => {
    expect(Number.isSafeInteger(offset)).toBe(true);
    expect(Number.isSafeInteger(length)).toBe(true);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(length).toBeGreaterThan(0);
    expect(offset + length).toBeLessThanOrEqual(message.text.length);
    const text = message.text.slice(offset, offset + length);
    expect(Buffer.from(text).toString()).toBe(text);
    return { type, text };
  });
}

describe("Telegram provider", () => {
  it.each([
    [{ ok: true, result: { message_id: 1 } }, 200, "accepted", undefined],
    [{ ok: false, description: "secret" }, 200, "failed", "api"],
    [{ ok: false }, 403, "failed", "http"],
    [{ ok: false, error_code: 429, parameters: { retry_after: 8 } }, 200, "failed", "rate-limit"],
    [{ ok: false }, 429, "failed", "rate-limit"],
    [[], 200, "failed", "response"],
  ])("normalizes %j / %s", async (body, status, state, code) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(body), { status: Number(status) }));
    const provider = createTelegramProvider(fetcher);
    const result = await deliver(new Map([[provider.id, provider]]), destination, note, new AbortController().signal);
    expect(result.state).toBe(state);
    if (result.state === "failed") expect(result.code).toBe(code);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("uses fixed HTTPS, no redirects, literal text and optional forum topics", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"ok":true,"result":{}}'));
    await createTelegramProvider(fetcher).send(
      { ...destination, messageThreadId: 42 },
      { ...note, body: "😀".repeat(4000) },
      new AbortController().signal,
    );
    const call = fetcher.mock.calls[0];
    assert.ok(call);
    const [url, init] = call;
    expect(url).toBe(`https://api.telegram.org/bot${destination.botToken}/sendMessage`);
    expect(init?.redirect).toBe("error");
    const body = JSON.parse(String(init?.body));
    expect(body.text.length).toBeLessThanOrEqual(4096);
    expect(body.text).not.toMatch(/[\ud800-\udbff]…$/);
    expect(body.message_thread_id).toBe(42);
    expect(body.link_preview_options).toEqual({ is_disabled: true });
    expect(body).not.toHaveProperty("parse_mode");
    expect(body).not.toHaveProperty("allow_paid_broadcast");
  });
  it("keeps HTML and Markdown punctuation literal while emphasizing the final title", async () => {
    const body = "😀 中文 e\u0301 <b> _branch_* [path](url) `value` &";
    const text = "_branch_* [path](url) `value`";
    const offset = body.indexOf(text);
    const payload = await sentMessage({
      ...note,
      title: "Pi notification test",
      body,
      bodyEmphasis: [{ style: "monospace", offset, length: text.length }],
    });
    expect(payload.text).toBe(`Pi notification test\n${body}`);
    expect(payload.entities).toEqual([
      { type: "bold", offset: 0, length: "Pi notification test".length },
      { type: "code", offset: "Pi notification test\n".length + offset, length: text.length },
    ]);
    expect(selectedEntities(payload)).toEqual([
      { type: "bold", text: "Pi notification test" },
      { type: "code", text },
    ]);
    expect(payload).not.toHaveProperty("parse_mode");
  });
  it.each(["😀中文e\u0301", "<b>world</b>", "＠name", "literal…"])(
    "preserves Unicode and literal punctuation inside emphasis: %s",
    async (body) => {
      const payload = await sentMessage({
        ...note,
        body,
        bodyEmphasis: [{ style: "bold", offset: 0, length: body.length }],
      });
      expect(payload.text).toBe(`Test\n${body}`);
      expect(selectedEntities(payload)).toEqual([
        { type: "bold", text: "Test" },
        { type: "bold", text: body },
      ]);
    },
  );
  it.each([" ", "\t", "\n", "\r\n", "\v\f", "\u00a0", "\u2003", "\u2028\u2029", "\u3000"])(
    "excludes trailing whitespace %j from all styles without moving later offsets",
    async (whitespace) => {
      const value = "  😀e\u0301 inner space";
      const title = `Test${whitespace}`;
      const body = `${value}${whitespace}${whitespace}next${whitespace}tail`;
      const next = value.length + whitespace.length * 2;
      const tail = next + "next".length + whitespace.length;
      const payload = await sentMessage({
        ...note,
        title,
        body,
        bodyEmphasis: [
          { style: "monospace", offset: 0, length: value.length + whitespace.length },
          { style: "bold", offset: value.length + whitespace.length, length: whitespace.length },
          { style: "bold", offset: next, length: "next".length + whitespace.length },
          { style: "monospace", offset: tail, length: "tail".length },
        ],
      });
      expect(payload.text).toBe(`${title}\n${body}`);
      expect(payload.entities).toEqual([
        { type: "bold", offset: 0, length: "Test".length },
        { type: "code", offset: title.length + 1, length: value.length },
        { type: "bold", offset: title.length + 1 + next, length: "next".length },
        { type: "code", offset: title.length + 1 + tail, length: "tail".length },
      ]);
      expect(selectedEntities(payload)).toEqual([
        { type: "bold", text: "Test" },
        { type: "code", text: value },
        { type: "bold", text: "next" },
        { type: "code", text: "tail" },
      ]);
    },
  );
  it.each(["bold", "monospace"] as const)("omits whitespace-only %s entities", async (style) => {
    const payload = await sentMessage({
      ...note,
      title: " \t\n",
      body: " \t\n",
      bodyEmphasis: [{ style, offset: 0, length: 3 }],
    });
    expect(payload.text).toBe(" \t\n\n \t\n");
    expect(payload.entities).toEqual([]);
  });
  it.each(["bold", "monospace"] as const)("trims %s whitespace exposed by body clipping", async (style) => {
    const body = `${"x".repeat(4087)}😀 \nrest`;
    const payload = await sentMessage({
      ...note,
      body,
      bodyEmphasis: [{ style, offset: 4087, length: body.length - 4087 }],
    });
    expect(payload.text).toBe(`Test\n${"x".repeat(4087)}😀 …`);
    expect(selectedEntities(payload)).toEqual([
      { type: "bold", text: "Test" },
      { type: style === "bold" ? "bold" : "code", text: "😀" },
    ]);
  });
  it.each(["bold", "monospace"] as const)("omits a %s range clipped to whitespace only", async (style) => {
    const body = `${"x".repeat(4088)}  rest`;
    const payload = await sentMessage({
      ...note,
      body,
      bodyEmphasis: [{ style, offset: 4088, length: 6 }],
    });
    expect(payload.text).toBe(`Test\n${"x".repeat(4088)}  …`);
    expect(selectedEntities(payload)).toEqual([{ type: "bold", text: "Test" }]);
  });
  it("preserves a real workspace path with a trailing space in the message text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-notify-entities-"));
    try {
      const cwd = join(directory, "workspace ");
      await mkdir(cwd);
      const notification = await notificationMetadata(
        { id: "test", sessionId: "session ", cwd, startedAt: 0, settledAt: 1000, error: false },
        new AbortController().signal,
      );
      const payload = await sentMessage(notification);
      expect(payload.text).toBe(`${notification.title}\n${notification.body}`);
      expect(payload.text).toContain(`Workspace: ${cwd}\nElapsed:`);
      expect(selectedEntities(payload)).toEqual([
        { type: "bold", text: notification.title },
        { type: "code", text: "session" },
        { type: "code", text: cwd.trimEnd() },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("trims whitespace exposed by title clipping", async () => {
    const title = `${"x".repeat(4092)}😀 \nrest`;
    const payload = await sentMessage({ ...note, title });
    expect(payload.text).toBe(`${"x".repeat(4092)}😀 …`);
    expect(payload.entities).toEqual([{ type: "bold", offset: 0, length: 4094 }]);
  });
  it("accepts notifications without body emphasis", async () => {
    const payload = await sentMessage(note);
    expect(payload.text).toBe("Test\nhello <b>world</b>");
    expect(selectedEntities(payload)).toEqual([{ type: "bold", text: "Test" }]);
  });
  it.each([
    [4089, "ab", "ab", false], // Exactly 4096 units including title and newline.
    [4089, "abc", "a", true], // The ellipsis occupies the final unit.
    [4088, "😀xyz", "😀", true],
    [4089, "😀xyz", "", true], // No room for the surrogate pair.
    [4092, "removed", "", true],
  ])("clips emphasis after %s prefix units", async (prefixLength, value, retained, clipped) => {
    const prefix = "x".repeat(Number(prefixLength));
    const body = prefix + value;
    const payload = await sentMessage({
      ...note,
      body,
      bodyEmphasis: [{ style: "monospace", offset: prefix.length, length: String(value).length }],
    });
    expect(payload.text).toBe(clipText(`Test\n${body}`, 4096));
    expect(payload.text.length).toBeLessThanOrEqual(4096);
    expect(selectedEntities(payload)).toEqual([
      { type: "bold", text: "Test" },
      ...(retained ? [{ type: "code", text: retained }] : []),
    ]);
    if (clipped) {
      expect(payload.text.endsWith("…")).toBe(true);
      for (const entity of payload.entities) expect(entity.offset + entity.length).toBeLessThan(payload.text.length);
    }
  });
  it.each(["x".repeat(4096), `${"x".repeat(4093)}😀abc`])("clips an oversized title safely", async (title) => {
    const payload = await sentMessage({
      ...note,
      title,
      bodyEmphasis: [{ style: "bold", offset: 0, length: 5 }],
    });
    expect(payload.text).toBe(clipText(`${title}\n${note.body}`, 4096));
    expect(payload.entities).toEqual([{ type: "bold", offset: 0, length: payload.text.length - 1 }]);
    expect(Buffer.from(payload.text).toString()).toBe(payload.text);
  });
  it("omits empty titles and invalid or surrogate-splitting body ranges", async () => {
    const payload = await sentMessage({
      ...note,
      title: "",
      body: "😀ok",
      bodyEmphasis: [
        { style: "bold", offset: -1, length: 1 },
        { style: "bold", offset: 0, length: 0 },
        { style: "bold", offset: 0.5, length: 1 },
        { style: "bold", offset: 0, length: Number.NaN },
        { style: "bold", offset: 0, length: 10 },
        { style: "bold", offset: 0, length: 1 },
        { style: "monospace", offset: 1, length: 1 },
        { style: "monospace", offset: 2, length: 2 },
      ],
    });
    expect(payload.text).toBe("\n😀ok");
    expect(payload.entities).toEqual([{ type: "code", offset: 3, length: 2 }]);
  });
  it.each([
    null,
    [],
    {},
    { ...destination, provider: "slack" },
    { ...destination, botToken: "https://evil" },
    { ...destination, chatId: 123 },
    { ...destination, messageThreadId: -1 },
    { ...destination, messageThreadId: 1.5 },
  ])("rejects invalid destinations %j", (value) => {
    expect(createTelegramProvider().validate(value)).toBeUndefined();
  });
  it("accepts private, group and supergroup IDs and topic IDs", () => {
    const provider = createTelegramProvider();
    for (const chatId of ["123", "-123", "-100123456789"])
      expect(provider.validate({ ...destination, chatId, messageThreadId: 1 })).toBeDefined();
  });
  it.each(["not JSON", "x".repeat(65537)])("bounds and rejects malformed response bodies", async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    expect(await createTelegramProvider(fetcher).send(destination, note, new AbortController().signal)).toEqual({
      state: "failed",
      code: "response",
    });
  });
  it("cancels hanging requests and clears timeout resources", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async (_url, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new Error(destination.botToken)), { once: true }),
          ),
      );
    const controller = new AbortController();
    const sending = createTelegramProvider(fetcher).send(destination, note, controller.signal);
    controller.abort();
    expect(await sending).toEqual({ state: "cancelled", code: "cancelled" });
    expect(vi.getTimerCount()).toBe(0);
    const timed = createTelegramProvider(fetcher).send(destination, note, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await timed).toEqual({ state: "failed", code: "timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("redacts transport failures including redirect errors", async () => {
    const provider = createTelegramProvider(
      vi.fn<typeof fetch>().mockRejectedValue(new Error(`redirect to https://evil/${destination.botToken}`)),
    );
    expect(await provider.send(destination, note, new AbortController().signal)).toEqual({
      state: "failed",
      code: "network",
    });
  });
  it("dispatches through a fake provider and propagates cancellation", async () => {
    const signal = new AbortController().signal;
    const send = vi.fn().mockResolvedValue({ state: "accepted" });
    const fake = { id: "telegram", label: "Fake", validate: () => destination, send };
    expect(await deliver(new Map([["telegram", fake]]), destination, note, signal)).toEqual({ state: "accepted" });
    expect(send).toHaveBeenCalledWith(destination, note, signal);
    expect(await deliver(new Map(), destination, note, signal)).toEqual({
      state: "failed",
      code: "unsupported-provider",
    });
    expect(
      await deliver(new Map([["telegram", { ...fake, validate: () => undefined }]]), destination, note, signal),
    ).toEqual({ state: "failed", code: "invalid-destination" });
    send.mockRejectedValue(new Error(destination.botToken));
    expect(await deliver(new Map([["telegram", fake]]), destination, note, signal)).toEqual({
      state: "failed",
      code: "network",
    });
  });
  it("clips Unicode without splitting code points", () => {
    expect(clipText("😀😀😀", 4)).toBe("😀…");
  });
});
