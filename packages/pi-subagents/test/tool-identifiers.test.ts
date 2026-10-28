import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createChildCommunicationExtension } from "../src/child-communication-tools.js";
import { MessageBroker } from "../src/message-broker.js";
import { registerSubagentTools } from "../src/tools.js";

interface RegisteredTool {
  name: string;
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: unknown,
  ): Promise<unknown>;
}

const surfaces = [
  { name: "main cancel", side: "main", tool: "subagent_cancel", field: "jobId", operation: "cancel" },
  { name: "main wait", side: "main", tool: "subagent_wait", field: "jobId", operation: "wait" },
  { name: "main request", side: "main", tool: "subagent_send", field: "recipient", operation: "main request" },
  { name: "main response", side: "main", tool: "subagent_send", field: "requestId", operation: "main response" },
  { name: "child response", side: "child", tool: "subagent_send", field: "requestId", operation: "child send" },
  { name: "child wait", side: "child", tool: "subagent_wait", field: "requestId", operation: "child wait" },
] as const;

type Surface = (typeof surfaces)[number];
interface IdentifierCase {
  name: string;
  value: unknown;
  error?: "required" | "invalid";
}

const cases: IdentifierCase[] = [
  { name: "literal non-UUID", value: "literal-id" },
  { name: "padded ID", value: " \n\tliteral-id\u2003" },
  { name: "128 code units", value: "a".repeat(128) },
  { name: "padded 128 code units", value: ` ${"a".repeat(128)} ` },
  { name: "128 astral code units", value: "😀".repeat(64) },
  { name: "punctuation", value: "id/with:punctuation" },
  { name: "non-C0/C1 control", value: "id\u202e" },
  { name: "empty", value: "", error: "required" },
  { name: "whitespace", value: " \n\t", error: "required" },
  { name: "null", value: null, error: "required" },
  { name: "number", value: 1, error: "required" },
  { name: "boolean", value: false, error: "required" },
  { name: "array", value: [], error: "required" },
  { name: "object", value: {}, error: "required" },
  { name: "129 code units", value: "a".repeat(129), error: "invalid" },
  { name: "130 astral code units", value: "😀".repeat(65), error: "invalid" },
  ...[...Array.from({ length: 32 }, (_, code) => code), ...Array.from({ length: 33 }, (_, code) => code + 0x7f)].map(
    (code): IdentifierCase => ({
      name: `embedded control U+${code.toString(16).padStart(4, "0")}`,
      value: `id${String.fromCodePoint(code)}end`,
      error: "invalid",
    }),
  ),
];

afterEach(() => vi.restoreAllMocks());

test.each(surfaces.flatMap((surface) => cases.map((candidate) => ({ surface, candidate }))))(
  "$surface.name preserves $candidate.name identifier handling",
  async ({ surface, candidate }) => {
    const f = fixture();
    const args = {
      ...(surface.tool === "subagent_send" ? { message: "Message" } : {}),
      [surface.field]: candidate.value,
    };
    if (candidate.error) {
      await assert.rejects(() => f.invoke(surface, args), {
        name: "Error",
        message: `Subagent ${surface.field} is ${candidate.error}.`,
      });
      assert.deepEqual(f.calls, [], "invalid IDs must not reach the runtime or transport");
    } else {
      await f.invoke(surface, args);
      assert.deepEqual(f.calls, [{ operation: surface.operation, identifier: String(candidate.value).trim() }]);
    }
  },
);

test.each(surfaces)("$name preserves missing identifier behavior", async (surface) => {
  const f = fixture();
  const args = surface.tool === "subagent_send" ? { message: "Message" } : {};
  if (surface.side === "child" && surface.tool === "subagent_send") {
    await f.invoke(surface, args);
    assert.deepEqual(f.calls, [{ operation: "child send", identifier: undefined }]);
  } else {
    await assert.rejects(() => f.invoke(surface, args), {
      name: "Error",
      message:
        surface.tool === "subagent_send"
          ? "Main-agent subagent_send requires exactly one of recipient or requestId."
          : `Subagent ${surface.field} is required.`,
    });
    assert.deepEqual(f.calls, []);
  }
});

test.each(["recipient", "requestId"] as const)("main send permits an undefined optional %s", async (field) => {
  const f = fixture();
  const surface = surfaces[field === "recipient" ? 3 : 2];
  await f.invoke(surface, { message: "Message", [surface.field]: "literal-id", [field]: undefined });
  assert.deepEqual(f.calls, [{ operation: surface.operation, identifier: "literal-id" }]);
});

test.each(surfaces.filter(({ tool }) => tool === "subagent_send"))(
  "$name preserves message-before-identifier validation",
  async (surface) => {
    const f = fixture();
    await assert.rejects(() => f.invoke(surface, { message: " ", [surface.field]: " " }), {
      name: "Error",
      message: "Subagent message is required.",
    });
    assert.deepEqual(f.calls, []);
  },
);

test("main and child waits retain their different timeout-validation order", async () => {
  const f = fixture();
  await assert.rejects(() => f.invoke(surfaces[1], { jobId: " ", timeout: 0 }), {
    name: "Error",
    message: "Invalid timeout: must be a finite number of seconds",
  });
  await assert.rejects(() => f.invoke(surfaces[5], { requestId: " ", timeout: 0 }), {
    name: "Error",
    message: "Subagent requestId is required.",
  });
  assert.deepEqual(f.calls, []);
});

function fixture() {
  const main = createMockPi();
  const child = createMockPi();
  const context = createMockContext();
  const calls: { operation: string; identifier: string | undefined }[] = [];
  const acknowledgement = { requestId: "request", accepted: true, duplicate: false };
  // No session is started: every downstream operation is mocked, so no resources are owned.
  const broker = new MessageBroker({ onMessage() {} });
  const { runtime } = registerSubagentTools(main.pi, { createBroker: () => broker });
  vi.spyOn(runtime, "cancel").mockImplementation(async (identifier) => {
    calls.push({ operation: "cancel", identifier });
    return { jobId: identifier, state: "cancelled" };
  });
  vi.spyOn(runtime, "wait").mockImplementation(async (identifier) => {
    calls.push({ operation: "wait", identifier });
    return { jobId: identifier, state: "running", timedOut: true };
  });
  vi.spyOn(runtime, "sendToJob").mockImplementation(async (identifier) => {
    calls.push({ operation: "main request", identifier });
    return acknowledgement;
  });
  vi.spyOn(broker, "replyFromMain").mockImplementation((identifier) => {
    calls.push({ operation: "main response", identifier });
    return acknowledgement;
  });
  createChildCommunicationExtension({
    async send(params) {
      calls.push({ operation: "child send", identifier: "requestId" in params ? params.requestId : undefined });
      return acknowledgement;
    },
    async wait(identifier) {
      calls.push({ operation: "child wait", identifier });
      return "Response";
    },
  })(child.pi);
  return {
    calls,
    invoke(surface: Surface, args: Record<string, unknown>) {
      const tools = (surface.side === "main" ? main.tools : child.tools) as unknown as RegisteredTool[];
      const tool = tools.find(({ name }) => name === surface.tool);
      assert.ok(tool);
      return tool.execute("test", args, undefined, undefined, context.ctx);
    },
  };
}
