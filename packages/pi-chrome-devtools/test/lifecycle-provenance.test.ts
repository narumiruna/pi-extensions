import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createMockPi } from "./mock-pi.js";

let root: string;
let previousDir: string | undefined;
beforeAll(async () => {
  await import("@earendil-works/pi-coding-agent");
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chrome-lifecycle-provenance-"));
  previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousDir;
  rmSync(root, { recursive: true, force: true });
});
async function setup(toolMode: "codemode" | "lazy" | "direct", native: boolean, partial: boolean) {
  const settings = await import("../src/settings.js");
  const { CORE_CHROME_DEVTOOLS_TOOL_NAMES: names } = await import("../src/tool-names.js");
  const { default: extension } = await import("../src/chrome-devtools.js");
  const selected = partial ? [names[0]] : [...names];
  writeFileSync(
    settings.settingsFilePath(),
    JSON.stringify({ toolMode, ...(partial ? { tools: selected, updatedAt: 1 } : {}) }),
  );
  const mock = createMockPi({ activeTools: ["other"] });
  const context = createMockContext({
    sessionManager: { getBranch: () => mock.entries.map((entry) => ({ type: "custom", ...entry })) },
    model: {
      api: "openai-responses",
      provider: "openai",
      id: "test",
      compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: native },
    },
  });
  extension(mock.pi);
  const start = () => mock.events.get("session_start")?.[0]?.({}, context.ctx);
  const switchModel = () =>
    mock.events.get("model_select")?.[0]?.({ model: { api: "faux", provider: "faux", id: "eager" } }, context.ctx);
  return { mock, ...context, start, switchModel, selected };
}
function failAppend(mock: ReturnType<typeof createMockPi>, boundary: "before" | "after") {
  const append = mock.rawPi.appendEntry.bind(mock.rawPi);
  return vi.spyOn(mock.rawPi, "appendEntry").mockImplementation((type, data) => {
    if (boundary === "after") append(type, data);
    throw new Error("ownership disk \u001b[31mfailure\u001b[0m");
  });
}

for (const toolMode of ["codemode", "lazy", "direct"] as const)
  for (const native of [false, true])
    for (const partial of [false, true])
      for (const boundary of ["before", "after"] as const)
        test(`${toolMode} native ${native} partial ${partial} startup continues after ${boundary} metadata failure and retries`, async () => {
          const { mock, notifications, start, selected } = await setup(toolMode, native, partial);
          const spy = failAppend(mock, boundary);
          try {
            await start();
          } finally {
            spy.mockRestore();
          }
          assert.deepEqual(mock.rawPi.getActiveTools(), [
            "other",
            ...(toolMode === "lazy" ? ["chrome_devtools_load"] : []),
            ...(toolMode === "codemode" || (toolMode === "lazy" && native) ? [] : selected),
          ]);
          assert.ok(notifications.some(({ message }) => /ownership could not be saved/.test(message)));
          assert.ok(notifications.every(({ message }) => !message.includes("\u001b")));
          assert.equal(
            notifications.some(({ message }) => /require Pi's codemode tool/.test(message)),
            toolMode === "codemode",
          );
          const retry = vi.spyOn(mock.rawPi, "appendEntry");
          const count = notifications.length;
          await start();
          assert.equal(retry.mock.calls.length, 1);
          assert.ok(notifications.slice(count).every(({ message }) => !/ownership could not be saved/.test(message)));
          const record = mock.entries.at(-1);
          assert.ok(record);
          assert.equal((record.data as { mode: string }).mode, toolMode);
          assert.deepEqual((record.data as { available: string[] }).available, selected);
        });

for (const partial of [false, true])
  for (const boundary of ["before", "after"] as const)
    test(`lazy eager switch partial ${partial} ${boundary} metadata failure warns, retains exposure and retries`, async () => {
      const { mock, notifications, start, switchModel, selected } = await setup("lazy", true, partial);
      await start();
      const before = mock.rawPi.getActiveTools();
      const spy = failAppend(mock, boundary);
      try {
        await switchModel();
      } finally {
        spy.mockRestore();
      }
      assert.deepEqual(mock.rawPi.getActiveTools(), [...before, ...selected]);
      assert.match(notifications.at(-1)?.message ?? "", /ownership could not be saved/);
      const retry = vi.spyOn(mock.rawPi, "appendEntry");
      await switchModel();
      assert.equal(retry.mock.calls.length, 1);
      const record = mock.entries.at(-1);
      assert.ok(record);
      assert.deepEqual((record.data as { owned: string[] }).owned, selected);
      await switchModel();
      assert.equal(retry.mock.calls.length, 1);
    });

for (const toolMode of ["codemode", "direct"] as const)
  test(`${toolMode} model selection does not publish lazy metadata`, async () => {
    const { mock, start, switchModel, notifications } = await setup(toolMode, true, false);
    await start();
    const before = mock.rawPi.getActiveTools();
    const count = notifications.length;
    const spy = failAppend(mock, "before");
    try {
      await switchModel();
    } finally {
      spy.mockRestore();
    }
    assert.equal(spy.mock.calls.length, 0);
    assert.equal(notifications.length, count);
    assert.deepEqual(mock.rawPi.getActiveTools(), before);
  });

for (const event of ["startup", "model"] as const)
  test(`${event} replacement during append suppresses retired-context warnings`, async () => {
    const { mock, ctx, start, switchModel, notifications } = await setup(
      event === "model" ? "lazy" : "codemode",
      true,
      false,
    );
    if (event === "model") await start();
    const prior = [...notifications];
    const { default: extension } = await import("../src/chrome-devtools.js");
    const nextContext = createMockContext({
      sessionManager: (ctx as { sessionManager: object }).sessionManager,
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "next",
        compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: true },
      },
    });
    const append = mock.rawPi.appendEntry.bind(mock.rawPi);
    let replacing: unknown;
    const spy = vi.spyOn(mock.rawPi, "appendEntry").mockImplementation((type, data) => {
      append(type, data);
      const next = createMockPi({ activeTools: mock.rawPi.getActiveTools() });
      extension(next.pi);
      replacing = next.events.get("session_start")?.[0]?.({}, nextContext.ctx);
      throw new Error("ownership persistence failed during replacement");
    });
    try {
      if (event === "startup") await start();
      else await switchModel();
    } finally {
      spy.mockRestore();
    }
    assert.ok(replacing);
    await replacing;
    assert.deepEqual(notifications, prior);
  });

for (const event of ["startup", "model"] as const)
  test(`${event} genuine activation failure is not reported as recoverable metadata`, async () => {
    const { mock, start, switchModel, notifications } = await setup("lazy", true, false);
    if (event === "model") await start();
    vi.spyOn(mock.rawPi, "setActiveTools").mockImplementation(() => {
      throw new Error("activation failed");
    });
    if (event === "startup") await assert.rejects(start() as Promise<void>, /activation failed/);
    else assert.throws(switchModel, /activation failed/);
    assert.ok(notifications.every(({ message }) => !/ownership could not be saved/.test(message)));
  });
