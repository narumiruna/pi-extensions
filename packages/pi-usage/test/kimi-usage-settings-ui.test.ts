import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, type TestContext, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { KIMI_CODING_USAGE_API_KEY_ENV } from "../src/kimi-usage-credential.js";
import { createUsageSettingsRuntime } from "../src/settings.js";
import { showUsageSettings } from "../src/usage-settings-ui.js";

initTheme("dark");

afterEach(() => vi.unstubAllEnvs());

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function plain(lines: readonly string[]): string {
  return lines.map(stripVTControlCharacters).join("\n");
}

function secretDraft(frame: string): string {
  return frame.split("\n").find((line) => line.startsWith("> ")) ?? "";
}

type DisposableComponent = Component & { dispose?(): void };
interface ScreenEvidence {
  component: DisposableComponent;
  initial: string;
  frames: string[];
  disposals: number;
}

interface FixtureOptions {
  document?: Record<string, unknown>;
  environment?: string;
  remapped?: boolean;
  operations?: { rename?: typeof rename; writeFile?: typeof writeFile };
}

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  vi.stubEnv(KIMI_CODING_USAGE_API_KEY_ENV, options.environment);
  const bindings = getKeybindings();
  const previousBindings = bindings.getUserBindings();
  bindings.setUserBindings(
    options.remapped
      ? {
          "tui.select.up": "ctrl+p",
          "tui.select.down": "ctrl+n",
          "tui.select.confirm": "ctrl+y",
          "tui.select.cancel": "ctrl+x",
          "tui.input.submit": "ctrl+s",
          "tui.editor.deleteCharBackward": "ctrl+h",
        }
      : {},
  );
  const keys = {
    up: options.remapped ? "\u0010" : "\u001b[A",
    down: options.remapped ? "\u000e" : "\u001b[B",
    confirm: options.remapped ? "\u0019" : "\r",
    cancel: options.remapped ? "\u0018" : "\u001b",
    submit: options.remapped ? "\u0013" : "\r",
    backspace: options.remapped ? "\u0008" : "\u007f",
  };
  const root = await mkdtemp(join(tmpdir(), "kimi-settings-ui-"));
  const path = join(root, "pi-usage.json");
  if (options.document) await writeFile(path, JSON.stringify(options.document));
  const runtime = createUsageSettingsRuntime({ path, operations: options.operations });
  await runtime.reload();
  const update = vi.spyOn(runtime, "update");
  const owner = new AbortController();
  let current = true;
  let settled = false;
  const roles: string[] = [];
  let dimColor: number | undefined;
  const tui = createTuiHarness({
    width: 120,
    rows: 30,
    keybindings: bindings,
    theme: {
      bold: (text) => text,
      fg: (role, text) => {
        roles.push(role);
        return role === "dim" && dimColor !== undefined ? `\u001b[${dimColor}m${text}\u001b[0m` : text;
      },
    },
  });
  const screens: ScreenEvidence[] = [];
  // Capture inside custom(): assertions in a factory can otherwise be caught as menu errors.
  const custom: typeof tui.custom = (factory, customOptions) =>
    tui.custom(async (...args) => {
      const component = await factory(...args);
      const evidence: ScreenEvidence = {
        component,
        initial: plain(component.render(120)),
        frames: [],
        disposals: 0,
      };
      screens.push(evidence);
      const render = component.render.bind(component);
      const dispose = component.dispose?.bind(component);
      let disposed = false;
      component.render = (width) => {
        const frame = render(width);
        evidence.frames.push(plain(frame));
        return frame;
      };
      component.dispose = () => {
        if (disposed) return;
        disposed = true;
        evidence.disposals++;
        dispose?.();
      };
      return component;
    }, customOptions);
  const input = vi.fn(async () => undefined);
  const editor = vi.fn(async () => undefined);
  const { ctx, notifications } = createMockContext({ mode: "tui", hasUI: true, custom, input, editor });
  const applied: { id: string; closed: boolean; owned: boolean; document: Record<string, unknown> }[] = [];
  const running = showUsageSettings(
    ctx,
    runtime,
    owner.signal,
    () => current,
    (id, closed) => {
      applied.push({ id, closed, owned: current, document: JSON.parse(readFileSync(path, "utf8")) });
    },
  ).finally(() => {
    settled = true;
  });
  t.onTestFinished(async () => {
    owner.abort();
    tui.dispose();
    await running;
    await runtime.flush();
    bindings.setUserBindings(previousBindings);
    await rm(root, { recursive: true, force: true });
  });
  async function opened(count: number) {
    await vi.waitFor(() => assert.equal(tui.isOpen && tui.openCount, count));
  }
  function selectKimi() {
    for (let index = 0; index < 5; index++) tui.send(keys.down);
  }
  function actions() {
    tui.send(keys.confirm);
    return plain(tui.render());
  }
  async function secret(count = tui.openCount + 1) {
    tui.send(keys.confirm);
    await opened(count);
    tui.setFocused(true);
    tui.render();
  }
  return {
    root,
    path,
    runtime,
    update,
    owner,
    keys,
    tui,
    screens,
    roles,
    setDimColor: (color: number) => {
      dimColor = color;
    },
    input,
    editor,
    notifications,
    applied,
    running,
    opened,
    selectKimi,
    actions,
    secret,
    replace: () => {
      current = false;
    },
    settled: () => settled,
    allOutput: () =>
      JSON.stringify({
        screens: screens.map(({ initial, frames }) => ({ initial, frames })),
        notifications,
      }),
  };
}

for (const remapped of [false, true]) {
  test(`Kimi key uses a fresh masked editor and persists edited bracketed paste (remapped: ${remapped})`, async (t) => {
    const oldKey = "previous-kimi-secret";
    const savedKey = "sk-abc-tail/+=._~!";
    const flow = await fixture(t, {
      remapped,
      document: { kimiCodingUsageApiKey: oldKey, future: { retained: true } },
    });
    await flow.opened(1);
    const initial = plain(flow.tui.render());
    flow.selectKimi();
    const selected = plain(flow.tui.render());
    const actions = flow.actions();
    await flow.secret(2);
    const empty = plain(flow.tui.render());
    flow.tui.type("  sk-ac");
    flow.tui.send("\u001b[D");
    flow.tui.type("b");
    flow.tui.send("\u001b[C");
    flow.tui.type("X");
    flow.tui.send(flow.keys.backspace);
    flow.tui.send("\u001b[200~-ta");
    const duringPaste = plain(flow.tui.render());
    flow.tui.send("il/+=._~! \r\n\u001b[201~");
    const masked = plain(flow.tui.render());
    const beforeSubmit = { applied: flow.applied.length, settings: flow.runtime.get().settings.kimiCodingUsageApiKey };
    flow.tui.send(flow.keys.submit);
    await flow.opened(4);
    const reopened = plain(flow.tui.render());
    flow.tui.send(flow.keys.cancel);
    assert.equal(await flow.running, true);

    const labels = initial
      .split("\n")
      .filter((line) => /^(?:→ | {2})(?:Codex |Use Codex |Claude extra usage|Kimi proxy usage key)/u.test(line));
    assert.equal(labels.length, 6);
    assert.match(labels.at(-1) ?? "", /Kimi proxy usage key\s+Settings file/u);
    assert.match(selected, /→ Kimi proxy usage key/u);
    assert.match(actions, /Set \/ update key/u);
    assert.match(actions, /Clear saved key/u);
    assert.match(actions, /Back/u);
    assert.match(empty, /Official Kimi usage key/u);
    assert.doesNotMatch(secretDraft(empty), /•/u, "an existing key must never prefill the draft");
    assert.match(secretDraft(masked), /•+/u);
    assert.doesNotMatch(duringPaste, /-ta/u);
    assert.deepEqual(beforeSubmit, { applied: 0, settings: oldKey });
    assert.match(reopened, /→ Kimi proxy usage key\s+Settings file/u);
    assert.equal(flow.runtime.get().settings.kimiCodingUsageApiKey, savedKey);
    assert.deepEqual(JSON.parse(await readFile(flow.path, "utf8")), {
      kimiCodingUsageApiKey: savedKey,
      future: { retained: true },
    });
    assert.deepEqual(flow.applied, [
      {
        id: "kimiCodingUsageApiKey",
        closed: false,
        owned: true,
        document: { kimiCodingUsageApiKey: savedKey, future: { retained: true } },
      },
    ]);
    assert.equal(flow.input.mock.calls.length, 0);
    assert.equal(flow.editor.mock.calls.length, 0);
    for (const secret of [oldKey, savedKey, "sk-ac", "sk-abc"]) assert.equal(flow.allOutput().includes(secret), false);
    assert.equal(flow.screens[0]?.disposals, 1, "the settings list must close before secret entry");
    assert.equal(flow.screens[1]?.disposals, 1);
    assert.equal(flow.screens.length, 4);
    assert.match(flow.screens[2]?.initial ?? "", /Saving Kimi usage credential/u);
  });
}

const sources = [
  { name: "missing", environment: undefined, saved: undefined, label: "Missing" },
  { name: "blank environment", environment: " \t\n ", saved: undefined, label: "Missing" },
  { name: "file", environment: undefined, saved: "file-only-secret", label: "Settings file" },
  { name: "blank environment with file", environment: " \t ", saved: "file-secret", label: "Settings file" },
  { name: "environment only", environment: "env-only-secret", saved: undefined, label: "Environment" },
  { name: "environment over file", environment: "  env-secret  ", saved: "file-secret", label: "Environment" },
  {
    name: "invalid environment over file",
    environment: "invalid env-secret",
    saved: "file-secret",
    label: "Environment (invalid)",
  },
  { name: "non-ASCII environment", environment: "秘密", saved: undefined, label: "Environment (invalid)" },
];

for (const source of sources) {
  test(`Kimi settings show only the credential source: ${source.name}`, async (t) => {
    const document = source.saved ? { kimiCodingUsageApiKey: source.saved } : undefined;
    const flow = await fixture(t, { document, environment: source.environment });
    await flow.opened(1);
    flow.selectKimi();
    const row = plain(flow.tui.render())
      .split("\n")
      .find((line) => line.startsWith("→ Kimi proxy usage key"));
    const actions = flow.actions();
    // Back is always last, regardless of whether a JSON credential exists.
    flow.tui.send(flow.keys.down);
    if (source.saved) flow.tui.send(flow.keys.down);
    flow.tui.send(flow.keys.confirm);
    const returned = plain(flow.tui.render());
    flow.tui.send(flow.keys.cancel);
    assert.equal(await flow.running, false);

    assert.equal(row?.trimEnd().endsWith(source.label), true);
    assert.equal(actions.includes("Clear saved key"), Boolean(source.saved));
    assert.match(actions, /Set \/ update key/u);
    assert.match(actions, /Back/u);
    assert.match(returned, /→ Kimi proxy usage key/u);
    assert.equal(flow.screens.length, 1, "Back must stay in the existing SettingsList");
    assert.equal(flow.update.mock.calls.length, 0);
    assert.deepEqual(flow.applied, []);
    if (document) assert.deepEqual(JSON.parse(await readFile(flow.path, "utf8")), document);
    else assert.deepEqual(await readdir(flow.root), []);
    for (const secret of [source.saved, source.environment?.trim()]) {
      if (secret) assert.equal(flow.allOutput().includes(secret), false);
    }
  });
}

for (const environment of [undefined, "active-environment-key", "invalid environment-key"]) {
  test(`Kimi clear removes only the saved JSON key (environment: ${environment ? "present" : "absent"}, invalid: ${environment?.includes(" ") ?? false})`, async (t) => {
    const flow = await fixture(t, {
      environment,
      document: { kimiCodingUsageApiKey: "remove-this-saved-key", future: "retained" },
    });
    await flow.opened(1);
    flow.selectKimi();
    flow.actions();
    flow.tui.send(flow.keys.down);
    flow.tui.send(flow.keys.confirm);
    await flow.opened(3);
    const reopened = plain(flow.tui.render());
    const actions = flow.actions();
    flow.tui.press("ctrl+c");
    assert.equal(await flow.running, true);

    const expectedSource = environment
      ? environment.includes(" ")
        ? "Environment (invalid)"
        : "Environment"
      : "Missing";
    assert.ok(
      reopened
        .split("\n")
        .some((line) => line.startsWith("→ Kimi proxy usage key") && line.trimEnd().endsWith(expectedSource)),
    );
    assert.equal(actions.includes("Clear saved key"), false);
    assert.deepEqual(JSON.parse(await readFile(flow.path, "utf8")), { future: "retained" });
    assert.equal(flow.runtime.get().settings.kimiCodingUsageApiKey, undefined);
    assert.equal(process.env[KIMI_CODING_USAGE_API_KEY_ENV], environment);
    assert.deepEqual(flow.applied, [
      { id: "kimiCodingUsageApiKey", closed: false, owned: true, document: { future: "retained" } },
    ]);
    assert.equal(flow.screens.length, 3, "clearing opens only the save loader and restored settings");
    assert.ok(flow.screens.every(({ initial }) => !initial.includes("Official Kimi usage key")));
    assert.equal(flow.allOutput().includes("remove-this-saved-key"), false);
    if (environment) assert.equal(flow.allOutput().includes(environment), false);
  });
}

for (const remapped of [false, true]) {
  test(`Kimi secret cancel returns to the selected row without retaining a draft (remapped: ${remapped})`, async (t) => {
    const document = { kimiCodingUsageApiKey: "unchanged-file-key" };
    const flow = await fixture(t, { document, remapped });
    await flow.opened(1);
    flow.selectKimi();
    flow.actions();
    await flow.secret(2);
    flow.tui.type("discard-private-draft");
    flow.tui.send(flow.keys.cancel);
    await flow.opened(3);
    const returned = plain(flow.tui.render());
    flow.actions();
    await flow.secret(4);
    const fresh = plain(flow.tui.render());
    flow.tui.send(flow.keys.cancel);
    await flow.opened(5);
    flow.tui.press("ctrl+c");
    assert.equal(await flow.running, false);

    assert.match(returned, /→ Kimi proxy usage key\s+Settings file/u);
    assert.doesNotMatch(secretDraft(fresh), /•/u);
    assert.equal(flow.update.mock.calls.length, 0);
    assert.deepEqual(flow.applied, []);
    assert.deepEqual(JSON.parse(await readFile(flow.path, "utf8")), document);
    assert.equal(flow.allOutput().includes("discard-private-draft"), false);
    assert.ok(flow.screens.every((screen) => screen.disposals === 1));
  });
}

for (const outcome of ["hard cancel", "unfinished paste", "abort", "dispose", "replacement", "stale owner"] as const) {
  test(`Kimi ${outcome} discards the draft and never resurrects Settings`, async (t) => {
    const document = { kimiCodingUsageApiKey: "prior-private-key" };
    const flow = await fixture(t, { document, remapped: true });
    await flow.opened(1);
    flow.selectKimi();
    flow.actions();
    await flow.secret(2);
    flow.tui.type("never-save-this-draft");
    if (outcome === "unfinished paste") flow.tui.send("\u001b[200~unfinished-private-paste");
    if (outcome === "abort") flow.owner.abort();
    else if (outcome === "dispose") flow.tui.dispose();
    else if (outcome === "replacement") {
      flow.replace();
      flow.owner.abort();
    } else if (outcome === "stale owner") {
      flow.replace();
      flow.tui.send(flow.keys.submit);
    } else flow.tui.press("ctrl+c");
    assert.equal(await flow.running, false);
    // A late callback held by the outgoing host must also be inert.
    flow.screens[1]?.component.handleInput?.(flow.keys.submit);
    flow.screens[1]?.component.dispose?.();
    await flow.runtime.flush();

    assert.equal(flow.tui.isOpen, false);
    assert.equal(flow.tui.openCount, 2);
    assert.equal(flow.update.mock.calls.length, 0);
    assert.deepEqual(flow.applied, []);
    assert.deepEqual(flow.notifications, []);
    assert.deepEqual(JSON.parse(await readFile(flow.path, "utf8")), document);
    for (const secret of ["prior-private-key", "never-save-this-draft", "unfinished-private-paste"]) {
      assert.equal(flow.allOutput().includes(secret), false);
    }
  });
}

test("Kimi secret handoff drains earlier boolean saves before closing the settings list", async (t) => {
  const started = gate();
  const release = gate();
  t.onTestFinished(() => release.resolve());
  let renames = 0;
  const flow = await fixture(t, {
    operations: {
      rename: async (from, to) => {
        if (++renames === 1) {
          started.resolve();
          await release.promise;
        }
        await rename(from, to);
      },
    },
  });
  await flow.opened(1);
  flow.tui.send(flow.keys.confirm);
  await started.promise;
  flow.selectKimi();
  flow.actions();
  flow.tui.send(flow.keys.confirm);
  const pending = {
    count: flow.tui.openCount,
    open: flow.tui.isOpen,
    disposed: flow.screens[0]?.disposals,
    applied: flow.applied.length,
    value: flow.runtime.get().settings.codexFastMode,
  };
  release.resolve();
  await flow.opened(2);
  const handoff = {
    disposed: flow.screens[0]?.disposals,
    value: flow.runtime.get().settings.codexFastMode,
    applied: structuredClone(flow.applied),
  };
  flow.tui.type("after-boolean-save");
  flow.tui.send(flow.keys.submit);
  await flow.opened(4);
  flow.tui.press("ctrl+c");
  assert.equal(await flow.running, true);

  assert.deepEqual(pending, { count: 1, open: true, disposed: 0, applied: 0, value: false });
  assert.equal(handoff.disposed, 1);
  assert.equal(handoff.value, true);
  assert.deepEqual(handoff.applied, [
    { id: "codexFastMode", closed: false, owned: true, document: { codexFastMode: true } },
  ]);
  assert.deepEqual(
    flow.applied.map(({ id, closed }) => ({ id, closed })),
    [
      { id: "codexFastMode", closed: false },
      { id: "kimiCodingUsageApiKey", closed: false },
    ],
  );
  assert.deepEqual(JSON.parse(await readFile(flow.path, "utf8")), {
    codexFastMode: true,
    kimiCodingUsageApiKey: "after-boolean-save",
  });
});

for (const replacement of [false, true]) {
  test(`Kimi rename that wins owner cancellation still triggers durable cleanup (replacement: ${replacement})`, async (t) => {
    const started = gate();
    const release = gate();
    t.onTestFinished(() => release.resolve());
    const flow = await fixture(t, {
      document: { kimiCodingUsageApiKey: "old-durable-key" },
      operations: {
        rename: async (from, to) => {
          started.resolve();
          await release.promise;
          await rename(from, to);
        },
      },
    });
    await flow.opened(1);
    flow.selectKimi();
    flow.actions();
    await flow.secret(2);
    flow.tui.type("new-durable-key");
    flow.tui.send(flow.keys.submit);
    await started.promise;
    const beforeCommit = { applied: flow.applied.length, key: flow.runtime.get().settings.kimiCodingUsageApiKey };
    if (replacement) flow.replace();
    flow.owner.abort();
    await Promise.resolve();
    const cancelled = { settled: flow.settled(), open: flow.tui.isOpen };
    release.resolve();
    assert.equal(await flow.running, true);

    assert.deepEqual(beforeCommit, { applied: 0, key: "old-durable-key" });
    assert.deepEqual(cancelled, { settled: false, open: false });
    assert.deepEqual(flow.applied, [
      {
        id: "kimiCodingUsageApiKey",
        closed: true,
        owned: !replacement,
        document: { kimiCodingUsageApiKey: "new-durable-key" },
      },
    ]);
    assert.equal(flow.runtime.get().settings.kimiCodingUsageApiKey, "new-durable-key");
    assert.equal(flow.tui.openCount, 3);
    assert.deepEqual(flow.notifications, []);
  });
}

test("Kimi abort before publication cancels a submitted draft without saving or reopening", async (t) => {
  const written = gate();
  const release = gate();
  t.onTestFinished(() => release.resolve());
  let renames = 0;
  const flow = await fixture(t, {
    document: { kimiCodingUsageApiKey: "prior-key" },
    operations: {
      writeFile: async (...args) => {
        await writeFile(...args);
        written.resolve();
        await release.promise;
      },
      rename: async (...args) => {
        renames++;
        await rename(...args);
      },
    },
  });
  await flow.opened(1);
  flow.selectKimi();
  flow.actions();
  await flow.secret(2);
  flow.tui.type("cancelled-before-rename");
  flow.tui.send(flow.keys.submit);
  await written.promise;
  flow.owner.abort();
  release.resolve();
  assert.equal(await flow.running, false);

  assert.equal(renames, 0);
  assert.equal(flow.runtime.get().settings.kimiCodingUsageApiKey, "prior-key");
  assert.deepEqual(JSON.parse(await readFile(flow.path, "utf8")), { kimiCodingUsageApiKey: "prior-key" });
  assert.deepEqual(await readdir(flow.root), ["pi-usage.json"]);
  assert.deepEqual(flow.applied, []);
  assert.deepEqual(flow.notifications, []);
  assert.equal(flow.tui.openCount, 3);
});

for (const stage of ["temporary write", "rename"] as const) {
  for (const outcome of ["hard cancel", "remapped cancel", "dispose"] as const) {
    test(`Kimi save ${outcome} during ${stage} drains without reopening Settings`, async (t) => {
      const started = gate();
      const release = gate();
      t.onTestFinished(() => release.resolve());
      const document = { kimiCodingUsageApiKey: "previous-save-key" };
      const flow = await fixture(t, {
        document,
        remapped: true,
        operations: {
          writeFile: async (...args) => {
            await writeFile(...args);
            if (stage === "temporary write") {
              started.resolve();
              await release.promise;
            }
          },
          rename: async (...args) => {
            if (stage === "rename") {
              started.resolve();
              await release.promise;
            }
            await rename(...args);
          },
        },
      });
      await flow.opened(1);
      flow.selectKimi();
      flow.actions();
      await flow.secret(2);
      flow.tui.type("pending-save-private-key");
      flow.tui.send(flow.keys.submit);
      await started.promise;
      await flow.opened(3);
      const saving = plain(flow.tui.render());
      if (outcome === "dispose") flow.tui.dispose();
      else flow.tui.send(outcome === "hard cancel" ? "\u0003" : flow.keys.cancel);
      await Promise.resolve();
      const pending = { settled: flow.settled(), applied: flow.applied.length };
      release.resolve();
      const committed = stage === "rename";
      assert.equal(await flow.running, committed);

      assert.match(saving, /Saving Kimi usage credential/u);
      assert.deepEqual(pending, { settled: false, applied: 0 });
      assert.equal(flow.tui.isOpen, false);
      assert.equal(flow.tui.openCount, 3);
      assert.equal(flow.screens[2]?.disposals, 1);
      assert.deepEqual(flow.notifications, []);
      assert.deepEqual(
        JSON.parse(await readFile(flow.path, "utf8")),
        committed ? { kimiCodingUsageApiKey: "pending-save-private-key" } : document,
      );
      assert.deepEqual(
        flow.applied,
        committed
          ? [
              {
                id: "kimiCodingUsageApiKey",
                closed: true,
                owned: true,
                document: { kimiCodingUsageApiKey: "pending-save-private-key" },
              },
            ]
          : [],
      );
      assert.deepEqual(await readdir(flow.root), ["pi-usage.json"]);
      assert.equal(flow.allOutput().includes("pending-save-private-key"), false);
      assert.equal(flow.allOutput().includes("previous-save-key"), false);
    });
  }
}

test("Kimi save hints use hard cancel and refresh their muted theme styling", async (t) => {
  const started = gate();
  const release = gate();
  t.onTestFinished(() => release.resolve());
  const flow = await fixture(t, {
    document: { kimiCodingUsageApiKey: "old-key" },
    operations: {
      rename: async (from, to) => {
        started.resolve();
        await release.promise;
        await rename(from, to);
      },
    },
  });
  await flow.opened(1);
  flow.selectKimi();
  flow.actions();
  await flow.secret(2);
  flow.tui.type("new-key");
  flow.tui.send(flow.keys.submit);
  await started.promise;
  await flow.opened(3);
  const saving = flow.screens[2]?.component;
  assert.ok(saving);
  flow.setDimColor(31);
  saving.invalidate();
  const first = saving.render(120).join("\n");
  flow.setDimColor(32);
  saving.invalidate();
  const second = saving.render(120).join("\n");
  flow.tui.press("ctrl+c");
  release.resolve();
  assert.equal(await flow.running, true);
  assert.ok(first.includes("\u001b[31mCtrl+C cancel"));
  assert.ok(second.includes("\u001b[32mCtrl+C cancel"));
  assert.ok(!second.includes("\u001b[31m"));
  assert.ok(!plain([second]).includes("Esc"));
  assert.deepEqual(
    flow.applied.map(({ id, closed }) => ({ id, closed })),
    [{ id: "kimiCodingUsageApiKey", closed: true }],
  );
});

test("Kimi failed save restores the prior source, masks storage errors, and permits retry", async (t) => {
  const oldKey = "previous-secret";
  const rejected = "rejected-secret";
  let attempts = 0;
  const flow = await fixture(t, {
    document: { kimiCodingUsageApiKey: oldKey, future: 42 },
    operations: {
      rename: async (from, to) => {
        if (++attempts === 1) throw new Error(`request payload ${rejected}; previous ${oldKey}`);
        await rename(from, to);
      },
    },
  });
  await flow.opened(1);
  flow.selectKimi();
  flow.actions();
  await flow.secret(2);
  flow.tui.type(rejected);
  flow.tui.send(flow.keys.submit);
  await flow.opened(4);
  const afterFailure = {
    row: plain(flow.tui.render()),
    state: flow.runtime.get().settings.kimiCodingUsageApiKey,
    document: JSON.parse(await readFile(flow.path, "utf8")),
    applied: flow.applied.length,
  };
  flow.actions();
  await flow.secret(5);
  const fresh = plain(flow.tui.render());
  flow.tui.type("successful-retry");
  flow.tui.send(flow.keys.submit);
  await flow.opened(7);
  flow.tui.press("ctrl+c");
  assert.equal(await flow.running, true);

  assert.match(afterFailure.row, /→ Kimi proxy usage key\s+Settings file/u);
  assert.equal(afterFailure.state, oldKey);
  assert.deepEqual(afterFailure.document, { kimiCodingUsageApiKey: oldKey, future: 42 });
  assert.equal(afterFailure.applied, 0);
  assert.doesNotMatch(secretDraft(fresh), /•/u);
  assert.equal(flow.notifications.length, 1);
  assert.match(flow.notifications[0]?.message ?? "", /Could not save the Kimi usage credential/u);
  assert.equal(flow.notifications[0]?.level, "error");
  for (const secret of [oldKey, rejected, "successful-retry"]) assert.equal(flow.allOutput().includes(secret), false);
  assert.deepEqual(JSON.parse(await readFile(flow.path, "utf8")), {
    kimiCodingUsageApiKey: "successful-retry",
    future: 42,
  });
  assert.equal(flow.applied.length, 1);
  assert.equal(attempts, 2);
});

for (const [name, value] of [
  ["whitespace", "   "],
  ["embedded whitespace", "private invalid key"],
  ["non-ASCII", "private-秘密"],
]) {
  test(`Kimi rejects ${name} without saving or exposing the draft`, async (t) => {
    const flow = await fixture(t);
    await flow.opened(1);
    flow.selectKimi();
    flow.actions();
    await flow.secret(2);
    flow.tui.send(`\u001b[200~${value}\u001b[201~`);
    flow.tui.send(flow.keys.submit);
    await flow.opened(3);
    const restored = plain(flow.tui.render());
    flow.tui.press("ctrl+c");
    assert.equal(await flow.running, false);

    assert.match(restored, /→ Kimi proxy usage key\s+Missing/u);
    assert.equal(flow.update.mock.calls.length, 0);
    assert.deepEqual(await readdir(flow.root), []);
    assert.deepEqual(flow.applied, []);
    assert.equal(flow.notifications.length, 1);
    assert.match(flow.notifications[0]?.message ?? "", /nonblank printable ASCII credential without whitespace/u);
    if (value?.trim()) assert.equal(flow.allOutput().includes(value), false);
  });
}

test("Kimi required and pasted-control errors stay masked inside the same secret dialog", async (t) => {
  const flow = await fixture(t);
  await flow.opened(1);
  flow.selectKimi();
  flow.actions();
  await flow.secret(2);
  flow.tui.send(flow.keys.submit);
  flow.tui.send("\u001b[200~private-control\u0007\u001b[201~");
  flow.tui.send(flow.keys.submit);
  const stillOpen = { count: flow.tui.openCount, open: flow.tui.isOpen };
  flow.tui.press("ctrl+c");
  assert.equal(await flow.running, false);

  assert.deepEqual(stillOpen, { count: 2, open: true });
  assert.equal(flow.notifications.length, 2);
  assert.match(flow.notifications[0]?.message ?? "", /required/u);
  assert.match(flow.notifications[1]?.message ?? "", /control characters/u);
  assert.equal(flow.allOutput().includes("private-control"), false);
  assert.equal(flow.update.mock.calls.length, 0);
  assert.deepEqual(await readdir(flow.root), []);
});

test("Kimi Settings and action submenu keep bounded frames and the selected row through resize and invalidation", async (t) => {
  const flow = await fixture(t, { document: { kimiCodingUsageApiKey: "private-frame-key" } });
  await flow.opened(1);
  const renderRequests = flow.tui.requestRenderCount;
  flow.selectKimi();
  const navigationRequests = flow.tui.requestRenderCount;
  const frames: { width: number; budget: number; lines: readonly string[]; selected: string }[] = [];
  for (const submenu of [false, true]) {
    if (submenu) {
      flow.actions();
      flow.tui.send(flow.keys.down);
    }
    for (const rows of [30, 8, 7, 6, 4]) {
      for (const width of [1, 12, 120]) {
        const lines = flow.tui.resize({ width, rows });
        frames.push({
          width,
          budget: Math.max(1, rows - 3),
          lines,
          selected: submenu ? "Clear saved key" : "Kimi proxy usage key",
        });
      }
    }
    flow.tui.invalidate();
    flow.tui.resize({ width: 120, rows: 30 });
  }
  const zero = flow.screens[0]?.component.render(0);
  flow.tui.send(flow.keys.cancel);
  const restored = plain(flow.tui.render());
  flow.tui.press("ctrl+c");
  assert.equal(await flow.running, false);

  for (const { width, budget, lines, selected } of frames) {
    assert.ok(lines.length <= budget, `frame exceeds ${budget} rows`);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `frame exceeds ${width} cells`,
    );
    const text = lines.map(stripVTControlCharacters);
    if (budget >= 5) {
      assert.equal(text[0], "─".repeat(width));
      assert.equal(text.at(-1), "─".repeat(width));
    } else
      assert.equal(
        text.some((line) => /^─+$/u.test(line)),
        false,
      );
    if (width === 120) assert.ok(text.some((line) => line.startsWith("→ ") && line.includes(selected)));
  }
  assert.ok(zero?.every((line) => visibleWidth(line) === 0));
  assert.ok((zero?.length ?? 0) <= 27);
  assert.match(restored, /→ Kimi proxy usage key/u);
  assert.ok(flow.roles.includes("border"));
  assert.ok(navigationRequests > renderRequests);
  assert.equal(flow.update.mock.calls.length, 0);
  assert.equal(flow.allOutput().includes("private-frame-key"), false);
});

for (const mode of ["rpc", "print", "json"] as const) {
  test(`Kimi Settings give safe ${mode} guidance without custom UI, plaintext input, or writes`, async (t) => {
    vi.stubEnv(KIMI_CODING_USAGE_API_KEY_ENV, "private-environment-key");
    const root = await mkdtemp(join(tmpdir(), "kimi-settings-nontui-"));
    t.onTestFinished(() => rm(root, { recursive: true, force: true }));
    const runtime = createUsageSettingsRuntime(join(root, "pi-usage.json"));
    await runtime.reload();
    const update = vi.spyOn(runtime, "update");
    const custom = vi.fn(async () => undefined);
    const input = vi.fn(async () => "plaintext-must-not-be-used");
    const editor = vi.fn(async () => "plaintext-must-not-be-used");
    const applied = vi.fn();
    const { ctx, notifications } = createMockContext({ mode, hasUI: mode === "rpc", custom, input, editor });
    assert.equal(await showUsageSettings(ctx, runtime, new AbortController().signal, () => true, applied), false);

    assert.equal(custom.mock.calls.length, 0);
    assert.equal(input.mock.calls.length, 0);
    assert.equal(editor.mock.calls.length, 0);
    assert.equal(update.mock.calls.length, 0);
    assert.equal(applied.mock.calls.length, 0);
    assert.deepEqual(await readdir(root), []);
    assert.deepEqual(
      notifications,
      mode === "rpc" ? [{ message: `Edit settings manually: ${runtime.get().path}`, level: "info" }] : [],
    );
    assert.equal(JSON.stringify(notifications).includes("private-environment-key"), false);
  });
}
