import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { WorkspaceExec } from "../src/runtime/workspace.js";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const roots: string[] = [];
afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

async function setup() {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "starship-status-lifecycle-"));
  roots.push(root);
  writeFileSync(
    join(root, "pi-starship.toml"),
    `format = "(\\n\${extension_status.usage})($extension_status)(\\n\${extension_status.sync})"
[extension_status]
format = '$statuses'
separator = ' / '
[extension_status.icons]
fallback = ''
`,
  );
  process.env.PI_CODING_AGENT_DIR = root;
  vi.resetModules();
  const { default: piStarship } = await import("../src/pi-starship.js");
  const mock = createMockPi();
  const exec = vi.fn<WorkspaceExec>(async () => ({ stdout: "", stderr: "", code: 1, killed: false, truncated: false }));
  piStarship(mock.pi, { gitExec: exec, githubPrExec: exec });
  const emit = async (name: string, context: ReturnType<typeof createMockContext>) => {
    for (const handler of mock.events.get(name) ?? []) await handler({ type: name }, context.ctx);
  };
  return { mock, exec, emit };
}

function mount(context: ReturnType<typeof createMockContext>, statuses: ReadonlyMap<string, string>) {
  const factory = context.footer as NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;
  assert.equal(typeof factory, "function");
  const unsubscribe = vi.fn();
  const component = factory(
    { requestRender() {} } as never,
    { colors: {} } as never,
    {
      getGitBranch: () => null,
      getExtensionStatuses: () => statuses,
      onBranchChange: () => unsubscribe,
    } as never,
  );
  return { component, unsubscribe, text: () => component.render(80).map(stripVTControlCharacters).join("\n") };
}

test("individual and aggregate statuses refresh from the public map and release session resources", async () => {
  const state = await setup();
  const context = createMockContext({ mode: "tui", hasUI: true });
  await state.emit("session_start", context);
  const statuses = new Map([
    ["usage", "quota"],
    ["other", "watching"],
    ["sync", "pushing"],
  ]);
  const first = mount(context, statuses);
  try {
    assert.equal(first.text(), "\nquotawatching\npushing");
    statuses.set("usage", "updated");
    statuses.delete("other");
    assert.equal(first.text(), "\nupdated\npushing");
    statuses.clear();
    assert.equal(first.text(), "");
    statuses.set("sync", "pulling");
    assert.equal(first.text(), "\npulling");
    assert.equal(state.exec.mock.calls.length, 0);
    const timerCount = vi.getTimerCount();

    const replacement = createMockContext({ mode: "tui", hasUI: true });
    await state.emit("session_start", replacement);
    assert.equal(first.unsubscribe.mock.calls.length, 1);
    assert.equal(context.footer, undefined);
    const second = mount(replacement, new Map([["usage", "replacement"]]));
    assert.equal(second.text(), "\nreplacement");
    assert.equal(vi.getTimerCount(), timerCount);
    first.component.dispose?.();
    assert.equal(first.unsubscribe.mock.calls.length, 1);
    await state.emit("session_shutdown", replacement);
    await state.emit("session_shutdown", replacement);
    second.component.dispose?.();
    assert.equal(second.unsubscribe.mock.calls.length, 1);
    assert.equal(replacement.footer, undefined);
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    await state.emit("session_shutdown", context);
  }
});

for (const mode of ["print", "json", "rpc"] as const) {
  test(`${mode} mode keeps child-reference configuration non-interactive`, async () => {
    const state = await setup();
    const context = createMockContext({ mode, hasUI: mode === "rpc" });
    await state.emit("session_start", context);
    try {
      assert.equal(context.footer, undefined);
      assert.deepEqual(context.notifications, []);
      assert.equal(state.exec.mock.calls.length, 0);
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      await state.emit("session_shutdown", context);
    }
  });
}
