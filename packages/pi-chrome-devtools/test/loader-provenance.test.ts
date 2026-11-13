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
  root = mkdtempSync(join(tmpdir(), "chrome-loader-provenance-"));
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
async function setup() {
  const settings = await import("../src/settings.js");
  const { default: extension } = await import("../src/chrome-devtools.js");
  const { createChromeDevtoolsLoadTool } = await import("../src/lazy-tools.js");
  writeFileSync(settings.settingsFilePath(), JSON.stringify({ toolMode: "lazy" }));
  const mock = createMockPi({ activeTools: ["other"] });
  const { ctx } = createMockContext({
    sessionManager: { getBranch: () => mock.entries.map((entry) => ({ type: "custom", ...entry })) },
    model: {
      api: "openai-responses",
      provider: "openai",
      id: "test",
      compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: true },
    },
  });
  extension(mock.pi);
  await mock.events.get("session_start")?.[0]?.({}, ctx);
  const loader = createChromeDevtoolsLoadTool(mock.pi);
  const execute = (signal?: AbortSignal, query = "list pages tabs") =>
    loader.execute("load", { query, limit: 1 }, signal, undefined, ctx);
  return { settings, mock, ctx, execute };
}

for (const boundary of ["before", "after"] as const)
  for (const failure of ["transient", "persistent"] as const)
    test(`${boundary} ${failure} metadata failure never reverses native activation and retries without adding`, async () => {
      const { settings, mock, ctx, execute } = await setup();
      const before = mock.rawPi.getActiveTools();
      const append = mock.rawPi.appendEntry.bind(mock.rawPi);
      let attempts = 0;
      const spy = vi.spyOn(mock.rawPi, "appendEntry").mockImplementation((type, data) => {
        attempts += 1;
        if (attempts === 1 || failure === "persistent") {
          if (boundary === "after") append(type, data);
          throw new Error("disk \u001b[31mfailure\u001b[0m");
        }
        append(type, data);
      });
      const publication = vi.spyOn(mock.rawPi, "setActiveTools");
      try {
        const loaded = await execute();
        const loadedText = loaded.content[0];
        assert.ok(loadedText?.type === "text");
        assert.match(loadedText.text, /Loaded Chrome DevTools tools: chrome_devtools_list_pages/);
        assert.match(loadedText.text, /Warning:.*ownership could not be saved/);
        assert.ok(!loadedText.text.includes("\u001b"));
        assert.deepEqual(mock.rawPi.getActiveTools(), [...before, "chrome_devtools_list_pages"]);
        const retried = await execute();
        assert.match(JSON.stringify(retried.content), /already loaded/);
        assert.equal(
          Boolean((retried.details as { provenanceWarning?: string }).provenanceWarning),
          failure === "persistent",
        );
        assert.equal(attempts, 2);
        assert.equal(publication.mock.calls.length, 1);
        assert.deepEqual(mock.rawPi.getActiveTools(), [...before, "chrome_devtools_list_pages"]);
      } finally {
        spy.mockRestore();
      }
      const recovered = await execute();
      assert.doesNotMatch(JSON.stringify(recovered.content), /Warning:/);
      assert.deepEqual((recovered.details as { added: string[] }).added, []);
      const record = mock.entries.at(-1);
      assert.ok(record);
      assert.deepEqual((record.data as { owned: string[] }).owned, ["chrome_devtools_list_pages"]);
      const count = mock.entries.length;
      await execute();
      assert.equal(mock.entries.length, count);
      writeFileSync(settings.settingsFilePath(), JSON.stringify({ toolMode: "codemode" }));
      await mock.events.get("session_start")?.[0]?.({}, ctx);
      assert.ok(!mock.rawPi.getActiveTools().includes("chrome_devtools_list_pages"));
    });

test("pending metadata retry reconciles later host selections and withdrawals without reactivation", async () => {
  const { mock, execute } = await setup();
  const setActive = mock.rawPi.setActiveTools.bind(mock.rawPi);
  const append = mock.rawPi.appendEntry.bind(mock.rawPi);
  let attempts = 0;
  vi.spyOn(mock.rawPi, "appendEntry").mockImplementation((type, data) => {
    append(type, data);
    if (++attempts <= 2) throw new Error("disk failure");
  });
  const publication = vi.spyOn(mock.rawPi, "setActiveTools");
  await execute();
  const active = mock.rawPi.getActiveTools();
  setActive([...active, "chrome_devtools_select_page"]);
  await execute();
  const selected = mock.entries.at(-1);
  assert.ok(selected);
  assert.deepEqual((selected.data as { explicit: string[] }).explicit, ["chrome_devtools_select_page"]);
  setActive(active);
  const recovered = await execute();
  assert.doesNotMatch(JSON.stringify(recovered.content), /Warning:/);
  const withdrawn = mock.entries.at(-1);
  assert.ok(withdrawn);
  assert.deepEqual((withdrawn.data as { explicit: string[] }).explicit, []);
  assert.deepEqual((withdrawn.data as { owned: string[] }).owned, ["chrome_devtools_list_pages"]);
  assert.equal(publication.mock.calls.length, 1);
  assert.deepEqual(mock.rawPi.getActiveTools(), active);
});

test("no-match pending metadata retry preserves an observed host withdrawal", async () => {
  const { mock, execute } = await setup();
  const before = mock.rawPi.getActiveTools();
  const append = mock.rawPi.appendEntry.bind(mock.rawPi);
  const spy = vi.spyOn(mock.rawPi, "appendEntry").mockImplementation((type, data) => {
    append(type, data);
    throw new Error("disk failure");
  });
  try {
    await execute();
    mock.rawPi.setActiveTools(before);
    const result = await execute(undefined, "zzzz");
    assert.match(JSON.stringify(result.content), /No available Chrome DevTools tools matched/);
    assert.match(JSON.stringify(result.content), /Warning:/);
    assert.deepEqual((result.details as { added: string[] }).added, []);
    assert.deepEqual(mock.rawPi.getActiveTools(), before);
  } finally {
    spy.mockRestore();
  }
  await execute(undefined, "zzzz");
  const record = mock.entries.at(-1);
  assert.ok(record);
  assert.deepEqual((record.data as { published: string[] }).published, []);
  assert.deepEqual(mock.rawPi.getActiveTools(), before);
});

test("aborted loader does not activate or append metadata", async () => {
  const { mock, execute } = await setup();
  const active = mock.rawPi.getActiveTools();
  const count = mock.entries.length;
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(execute(controller.signal), /cancelled/);
  assert.deepEqual(mock.rawPi.getActiveTools(), active);
  assert.equal(mock.entries.length, count);
});

test("genuine pre-activation failure is not converted to a metadata warning", async () => {
  const { mock, execute } = await setup();
  const active = mock.rawPi.getActiveTools();
  const count = mock.entries.length;
  vi.spyOn(mock.rawPi, "setActiveTools").mockImplementation(() => {
    throw new Error("activation failed");
  });
  await assert.rejects(execute(), /activation failed/);
  assert.deepEqual(mock.rawPi.getActiveTools(), active);
  assert.equal(mock.entries.length, count);
});
