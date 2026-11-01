import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createStartupTimings } from "../src/sync/startup-timings.js";
import {
  registerStartupTimings,
  STARTUP_TIMING_ENTRY,
  type StartupTimingEntry,
} from "../src/ui/startup-timings-entry.js";

const report = "pi-sync debug: local initialization (completed)\nsettings read: 1.0 ms\ntotal: 2.0 ms";

for (const mode of ["tui", "rpc", "print", "json"] as const) {
  test(`startup report publication in ${mode} uses only its supported channel`, () => {
    const mock = createMockPi();
    const context = createMockContext({ mode });
    const timings = createStartupTimings(registerStartupTimings(mock.pi));
    timings.publish(context.ctx, true, new AbortController().signal, "local initialization");
    assert.equal(mock.entries.length, mode === "tui" ? 1 : 0);
    assert.equal(context.notifications.length, mode === "rpc" ? 1 : 0);
    assert.deepEqual(mock.sentMessages, []);
    assert.deepEqual(mock.sentUserMessages, []);
  });
}

test("TUI reports survive info notifications and renderer reload without changing model context", () => {
  const manager = SessionManager.inMemory();
  const before = manager.buildSessionContext();
  const mock = createMockPi();
  mock.rawPi.appendEntry = (customType, data) => {
    manager.appendCustomEntry(customType, data);
  };
  const context = createMockContext({ mode: "tui", sessionManager: manager });
  const publish = registerStartupTimings(mock.pi);
  publish(context.ctx, report);
  (context.ctx as ExtensionContext).ui.notify(
    "Reloaded keybindings, extensions, skills, prompts, themes, and context files",
    "info",
  );
  const entries = manager.getEntries().filter((entry) => entry.type === "custom");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.customType, STARTUP_TIMING_ENTRY);
  assert.deepEqual(entries[0]?.data, { version: 1, report });
  assert.deepEqual(manager.buildSessionContext(), before);
  assert.ok(manager.buildContextEntries().some((entry) => entry.id === entries[0]?.id));

  const replacement = createMockPi();
  registerStartupTimings(replacement.pi);
  const renderer = replacement.entryRenderers.get(STARTUP_TIMING_ENTRY);
  assert.ok(renderer);
  const component = renderer(
    entries[0],
    { expanded: false },
    { fg: (_role: string, text: string) => text },
  ) as Component;
  assert.match(component.render(80).join("\n"), /pi-sync debug: local initialization/u);
  assert.match(component.render(80).join("\n"), /settings read: 1\.0 ms/u);
});

test("timing entries sanitize controls before rendering and fit zero, narrow, and resized widths", () => {
  const mock = createMockPi();
  registerStartupTimings(mock.pi);
  const renderer = mock.entryRenderers.get(STARTUP_TIMING_ENTRY);
  assert.ok(renderer);
  const roles: string[] = [];
  const entry = {
    data: { version: 1, report: `${report}\n\u001b[2J\r\t\u009b\u202e診斷` } satisfies StartupTimingEntry,
  };
  for (const expanded of [false, true]) {
    const component = renderer(
      entry,
      { expanded },
      {
        fg: (role: string, text: string) => {
          roles.push(role);
          return text;
        },
      },
    ) as Component;
    for (const width of [0, 1, 8, 80, 12]) {
      const lines = component.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Verify sanitized terminal text.
      assert.ok(lines.every((line) => !/[\u0000-\u001f\u007f-\u009f\u202e]/u.test(stripVTControlCharacters(line))));
      component.invalidate();
      assert.deepEqual(component.render(width), lines);
    }
    assert.deepEqual(component.render(0), []);
    assert.match(component.render(80).join("\n"), /\?\[2J\?\?\?\?診斷/u);
  }
  assert.equal(roles[0], "accent");
  assert.ok(roles.slice(1).includes("muted"));
});

for (const data of [undefined, null, {}, { version: 2, report }, { version: 1, report: 1 }]) {
  test(`invalid persisted timing entry ${JSON.stringify(data)} is not rendered`, () => {
    const mock = createMockPi();
    registerStartupTimings(mock.pi);
    const renderer = mock.entryRenderers.get(STARTUP_TIMING_ENTRY);
    assert.ok(renderer);
    assert.equal(renderer({ data }, { expanded: false }, {}), undefined);
  });
}

test("disabled and stale reports create no entries; append failure does not fail startup", () => {
  const mock = createMockPi();
  const context = createMockContext({ mode: "tui" });
  const timings = createStartupTimings(registerStartupTimings(mock.pi));
  const cancelled = new AbortController();
  cancelled.abort();
  timings.publish(context.ctx, false, new AbortController().signal, "local initialization");
  timings.publish(context.ctx, true, cancelled.signal, "local initialization");
  assert.deepEqual(mock.entries, []);
  mock.rawPi.appendEntry = () => {
    throw new Error("session disposed");
  };
  assert.doesNotThrow(() => timings.publish(context.ctx, true, new AbortController().signal, "local initialization"));
});
