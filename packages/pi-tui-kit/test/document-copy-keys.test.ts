import assert from "node:assert/strict";
import { isKittyProtocolActive, type KeybindingsConfig, setKittyProtocolActive } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { plainTuiText } from "../../../test/tui-text.js";
import type { MenuScreenComponent } from "../src/components/contracts.js";
import { runDocumentReview } from "../src/document-review.js";
import { defineMenu } from "../src/model.js";
import { runMenu } from "../src/runtime.js";
import type { DocumentCopyContext } from "../src/types.js";
import { documentComponent, documentKeys } from "./fixtures/document-copy.js";
import { createRendererHost, deferred } from "./fixtures/renderer-host.js";
import { rendererTheme } from "./fixtures/renderer-theme.js";

for (const scenario of [
  { name: "modifier order and case", copy: ["AlT+CtRl+X"], input: "\u001b[120;7u", hint: "ctrl+alt+x", calls: 1 },
  {
    name: "all modifiers",
    copy: ["super+alt+ctrl+shift+x"],
    input: "\u001b[120;16u",
    hint: "shift+ctrl+alt+super+x",
    calls: 1,
  },
  { name: "literal plus", copy: ["ctrl++"], input: "\u001b[43;5u", hint: "ctrl++", calls: 1 },
  { name: "special alias confirm", copy: ["RETURN", "ctrl+x"], input: "\r", hint: "ctrl+x", calls: 0 },
  { name: "special alias cancel", copy: ["EsC", "ctrl+x"], input: "\u001b", hint: "ctrl+x", calls: 0 },
  { name: "Home priority", copy: ["HOME", "ctrl+x"], input: "\u001b[H", hint: "ctrl+x", calls: 0 },
  { name: "End priority", copy: ["end", "ctrl+x"], input: "\u001b[F", hint: "ctrl+x", calls: 0 },
  { name: "Space search priority", copy: ["space", "ctrl+x"], input: " ", hint: "ctrl+x", calls: 0 },
  { name: "hard cancel priority", copy: ["ctrl+c", "ctrl+x"], input: "\u0003", hint: "ctrl+x", calls: 0 },
  { name: "navigation priority", copy: ["down", "ctrl+x"], input: "\u001b[B", hint: "ctrl+x", calls: 0 },
  { name: "legacy LF collision", copy: ["ctrl+j", "ctrl+x"], input: "\n", hint: "ctrl+x", calls: 0 },
  { name: "enhanced LF distinction", copy: ["ctrl+j"], input: "\u001b[106;5u", hint: "ctrl+j", calls: 1, kitty: true },
  { name: "legacy Escape collision", copy: ["ctrl+[", "ctrl+x"], input: "\u001b", hint: "ctrl+x", calls: 0 },
  {
    name: "enhanced Escape distinction",
    copy: ["ctrl+["],
    input: "\u001b[91;5u",
    hint: "ctrl+[",
    calls: 1,
    kitty: true,
  },
  { name: "legacy Tab collision", copy: ["ctrl+i", "ctrl+x"], input: "\t", hint: "ctrl+x", calls: 0, cancel: ["tab"] },
  {
    name: "enhanced Tab distinction",
    copy: ["ctrl+i"],
    input: "\u001b[105;5u",
    hint: "ctrl+i",
    calls: 1,
    cancel: ["tab"],
    kitty: true,
  },
  {
    name: "legacy Alt arrow collision",
    copy: ["alt+p", "ctrl+x"],
    input: "\u001bp",
    hint: "ctrl+x",
    calls: 0,
    up: ["alt+up"],
  },
  {
    name: "Kitty logical symbol collision",
    copy: ["shift+1", "ctrl+x"],
    input: "\u001b[49:33;2u",
    hint: "ctrl+x",
    calls: 0,
    up: ["!"],
    kitty: true,
  },
  {
    name: "modifyOtherKeys logical collision",
    copy: ["shift+!", "ctrl+x"],
    input: "\u001b[27;2;33~",
    hint: "ctrl+x",
    calls: 0,
    up: ["!"],
    kitty: true,
  },
  {
    name: "invalid duplicate modifier fallback",
    copy: ["ctrl+ctrl+x", "ctrl+y"],
    input: "\u0019",
    hint: "ctrl+y",
    calls: 1,
  },
  {
    name: "invalid unreachable function fallback",
    copy: ["alt+f1", "f12"],
    input: "\u001b[24~",
    hint: "f12",
    calls: 1,
  },
  { name: "invalid escape fallback", copy: ["shift+escape", "ctrl+x"], input: "\u0018", hint: "ctrl+x", calls: 1 },
  { name: "empty disables Copy", copy: [], input: "\u0018", hint: undefined, calls: 0 },
  {
    name: "all conflicted disables Copy",
    copy: ["down", "ctrl+c", "return"],
    input: "\u0018",
    hint: undefined,
    calls: 0,
  },
]) {
  test(`copy key plan: ${scenario.name}`, async () => {
    const previous = isKittyProtocolActive();
    setKittyProtocolActive(scenario.kitty ?? false);
    let calls = 0;
    const harness = documentComponent(
      {
        kind: "review",
        title: "Review",
        content: "body",
        enableSearch: true,
        confirm: { id: "apply", label: "Apply", action: "apply" },
        copy: {
          label: "Copy source",
          onCopy: () => {
            calls++;
          },
        },
      },
      {
        keys: documentKeys(scenario.copy, {
          ...(scenario.cancel ? { "tui.select.cancel": scenario.cancel } : {}),
          ...(scenario.up ? { "tui.select.up": scenario.up } : {}),
        }),
      },
    );
    try {
      const text = harness.text();
      if (scenario.hint) assert.ok(text.includes(`${scenario.hint} Copy source`), text);
      else assert.ok(!text.includes("Copy source"), text);
      harness.component.handleInput(scenario.input);
      await harness.component.waitForPending();
      assert.equal(calls, scenario.calls);
    } finally {
      harness.component.dispose?.();
      setKittyProtocolActive(previous);
    }
  });
}

for (const mode of ["regular", "fullscreen"] as const) {
  for (const scenario of [
    { host: "ctrl+x", copy: "ctrl+x", input: "\u001b[120;5u" },
    { host: "!", copy: "shift+1", input: "\u001b[49:33;2u" },
    { host: "shift+!", copy: "!", input: "\u001b[27;2;33~", modify: true },
    { host: "ctrl+i", copy: "ctrl+i", input: "\u001b[105;5u" },
  ]) {
    test(`native ${mode} host owns ${scenario.host} before Copy ${scenario.copy}`, async (t) => {
      const fixture = createRendererHost(mode, rendererTheme(), {
        kitty: !scenario.modify,
        bindings: {
          "tui.altScreen.lineUp": scenario.host,
          "app.message.copy": [scenario.copy, "ctrl+y"],
        } as KeybindingsConfig,
      });
      if (scenario.modify) Object.defineProperty(fixture.host.terminal, "modifyOtherKeysActive", { value: true });
      t.onTestFinished(() => fixture.stop());
      let calls = 0;
      const running = runDocumentReview(fixture.ctx, {
        title: "Review",
        content: "body",
        copy: {
          label: "Copy source",
          onCopy: () => {
            calls++;
          },
        },
      });
      await fixture.waitForOpen();
      const frame = plainTuiText(fixture.frame().join("\n"));
      if (mode === "fullscreen") assert.match(frame, /ctrl\+y Copy source/u);
      const inputs: string[] = [];
      const handleInput = fixture.component.handleInput?.bind(fixture.component);
      fixture.component.handleInput = (data) => {
        inputs.push(data);
        handleInput?.(data);
      };
      fixture.send(scenario.input);
      await (fixture.component as MenuScreenComponent).waitForPending();
      assert.equal(calls, mode === "regular" ? 1 : 0);
      assert.equal(inputs.length, mode === "regular" ? 1 : 0);
      fixture.send("\u001b[121;5u");
      await (fixture.component as MenuScreenComponent).waitForPending();
      assert.equal(calls, mode === "regular" ? 2 : 1);
      fixture.send("\u0003");
      assert.deepEqual(await running, { kind: "cancelled", reason: "close" });
      assert.ok(!fixture.writes.join("").includes("\u001b]52;"));
    });
  }

  test(`native ${mode} input preserves search, paste, key release, single-flight, and remapped hard cancellation`, async (t) => {
    const gate = deferred<void>();
    const fixture = createRendererHost(mode, rendererTheme(), {
      kitty: true,
      bindings: { "tui.select.cancel": "q", "app.message.copy": "ctrl+x" } as KeybindingsConfig,
    });
    t.onTestFinished(() => fixture.stop());
    let calls = 0;
    let signal: AbortSignal | undefined;
    const running = runDocumentReview(fixture.ctx, {
      title: "Review",
      content: "body\nmore",
      enableSearch: true,
      copy: {
        label: "Copy",
        onCopy: (context) => {
          calls++;
          signal = context.signal;
          return gate.promise;
        },
      },
    });
    await fixture.waitForOpen();
    fixture.send("\u001b[120;5:3u");
    fixture.send("\u001b[200~\u0018\u001b[201~");
    fixture.send(" ");
    fixture.send("\u001b[200~body \u0018\u001b[201~");
    fixture.send("\u0018");
    assert.equal(calls, 0);
    assert.match(plainTuiText(fixture.frame().join("\n")), /Find:/u);
    fixture.send("\u001b");
    fixture.send("\u0018");
    fixture.send("\u001b[120;5:2u");
    assert.equal(calls, 1);
    fixture.send("\u0003");
    assert.equal(signal?.aborted, true);
    gate.reject(new Error("private source"));
    assert.deepEqual(await running, { kind: "cancelled", reason: "close" });
    assert.deepEqual(fixture.notifications, []);
  });
}

for (const mode of ["regular", "fullscreen"] as const) {
  test(`native ${mode} browse keeps list/search/paste ownership and copies exact detail with raw ID`, async (t) => {
    const fixture = createRendererHost(mode, rendererTheme(), {
      bindings: {
        "tui.select.confirm": "l",
        "tui.select.cancel": "q",
        "app.message.copy": ["down", "ctrl+x"],
      } as KeybindingsConfig,
    });
    t.onTestFinished(() => fixture.stop());
    const captures: DocumentCopyContext[] = [];
    const source = "  exact\t source  \r\n\u001b]52;c;hidden\u0007\n";
    const running = runMenu(
      fixture.ctx,
      defineMenu({
        start: "browse",
        actions: {},
        screens: {
          browse: () => ({
            kind: "browse",
            title: "Tools",
            enableDetailSearch: true,
            items: [
              { id: "other", label: "Other", details: ["legacy"] },
              {
                id: "raw\u001b[31m-id",
                label: "Schema",
                detailDocument: {
                  content: source,
                  copy: {
                    label: "Copy source",
                    onCopy: (context) => {
                      captures.push(context);
                    },
                  },
                },
              },
            ],
          }),
        },
      }),
      { getState: () => undefined },
    );
    await fixture.waitForOpen();
    fixture.send("Schema");
    fixture.send("l");
    assert.match(plainTuiText(fixture.frame(240).join("\n")), /ctrl\+x Copy source/u);
    fixture.send("\u001b[200~\u0018\u001b[201~");
    fixture.send(" ");
    fixture.send("exact");
    fixture.send("\u0018");
    assert.equal(captures.length, 0);
    fixture.send("\u001b");
    fixture.send("\u001b[B");
    assert.equal(captures.length, 0, "configured standard Down wins over Copy");
    fixture.send("\u0018");
    await (fixture.component as MenuScreenComponent).waitForPending();
    assert.equal(captures.length, 1);
    assert.equal(captures[0]?.content, source);
    assert.equal(captures[0]?.itemId, "raw\u001b[31m-id");
    fixture.send("q");
    assert.match(plainTuiText(fixture.frame().join("\n")), /Search: > Schema/u);
    fixture.send("\u0003");
    assert.deepEqual(await running, { kind: "closed", reason: "close" });
    assert.ok(!fixture.writes.join("").includes("\u001b]52;"));
  });
}

test("native debug ownership filters its Copy key and retains the first usable fallback", async (t) => {
  const fixture = createRendererHost("regular", rendererTheme(), {
    kitty: true,
    bindings: { "app.message.copy": ["shift+ctrl+d", "ctrl+x"] } as KeybindingsConfig,
  });
  t.onTestFinished(() => fixture.stop());
  let debug = 0;
  let copies = 0;
  fixture.host.onDebug = () => {
    debug++;
  };
  const running = runDocumentReview(fixture.ctx, {
    title: "Review",
    content: "body",
    copy: {
      label: "Copy",
      onCopy: () => {
        copies++;
      },
    },
  });
  await fixture.waitForOpen();
  assert.match(plainTuiText(fixture.frame().join("\n")), /ctrl\+x Copy/u);
  fixture.send("\u001b[100;6u");
  assert.equal(debug, 1);
  assert.equal(copies, 0);
  fixture.send("\u0018");
  await (fixture.component as MenuScreenComponent).waitForPending();
  assert.equal(copies, 1);
  fixture.send("\u0003");
  await running;
});
