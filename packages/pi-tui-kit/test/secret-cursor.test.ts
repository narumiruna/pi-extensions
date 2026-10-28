import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, renderFakeCursor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { runSecretInput } from "../src/secret-input.js";
import { createRendererHost } from "./fixtures/renderer-host.js";
import { rendererTheme } from "./fixtures/renderer-theme.js";

const inputLine = (frame: readonly string[]) => frame.find((line) => line.startsWith("> ")) ?? "";

// Inspect actual renderer writes: stripVTControlCharacters alone leaves Pi APC markers intact.
for (const mode of ["regular", "fullscreen"] as const) {
  for (const hardware of [false, true]) {
    for (const focused of [false, true]) {
      test(`${mode} secret cursor: hardware=${hardware}, focused=${focused}`, async (t) => {
        const fixture = createRendererHost(mode, rendererTheme(), { rows: 200 });
        t.onTestFinished(() => fixture.stop());
        fixture.host.setShowHardwareCursor(hardware);
        const running = runSecretInput(fixture.ctx, { title: "Credential", required: false });
        await fixture.waitForOpen();
        for (const payload of ["", "RAW_私🙂é_password-0123456789"]) {
          fixture.host.setFocus(fixture.component);
          if (payload) fixture.send(`\x1b[200~${payload}\x1b[201~`);
          for (const position of ["start", "middle", "end"] as const) {
            fixture.host.setFocus(fixture.component);
            fixture.send(position === "end" ? "\x05" : "\x01");
            if (position === "middle") fixture.send("\x1b[C");
            fixture.host.setFocus(focused ? fixture.component : null);
            for (const width of [1, 2, 3, 4, 8, 24]) {
              fixture.resize(width, 200);
              const frame = fixture.frame();
              assert.ok(frame.every((line) => visibleWidth(line) <= width));
              const cursorLine = inputLine(frame);
              assert.equal(cursorLine.includes(CURSOR_MARKER), focused && width > 2);
              if (width > 2) {
                const cell = payload && position !== "end" && width > 3 ? "•" : " ";
                assert.ok(cursorLine.includes(`${focused ? CURSOR_MARKER : ""}${renderFakeCursor(cell)}`));
              }
              fixture.writes.length = 0;
              fixture.host.renderNow(true);
              const output = fixture.writes.join("");
              assert.equal(output.includes("\x1b_pi:"), false);
              assert.equal(output.includes("\x1b[7m"), width > 2 && !(hardware && focused));
              assert.doesNotMatch(frame.join("\n") + output, /RAW_|私|🙂|é|password|0123456789/u);
              if (focused && width > 2) {
                const column = visibleWidth(cursorLine.slice(0, cursorLine.indexOf(CURSOR_MARKER)));
                assert.ok(column < width);
                assert.ok(output.includes(mode === "regular" ? `\x1b[${column + 1}G` : `;${column + 1}H`));
              }
            }
          }
        }
        for (const width of [0, -1, 0.5, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
          assert.deepEqual(fixture.frame(width), []);
        }
        assert.ok(fixture.frame(3.9).every((line) => visibleWidth(line) <= 3));
        // Isolate the regular-mode zero-width secret from native Text's one-column minimum.
        // Fullscreen itself clamps zero terminal columns to one before layout.
        if (mode === "regular") {
          fixture.host.clear();
          fixture.host.addChild(fixture.component);
        }
        fixture.resize(0, 200);
        assert.deepEqual(fixture.frame(), []);
        fixture.writes.length = 0;
        fixture.host.renderNow(true);
        assert.equal(fixture.writes.join("").includes("\x1b[7m"), false);
        assert.equal(fixture.writes.join("").includes("\x1b_pi:"), false);
        fixture.resize(24, 30);
        fixture.host.setFocus(fixture.component);
        fixture.send("\x03");
        assert.deepEqual(await running, { kind: "closed", reason: "close" });
      });
    }
  }

  test(`${mode} masked editing and split paste retain non-default native bindings`, async (t) => {
    const fixture = createRendererHost(mode, rendererTheme(), {
      bindings: {
        "tui.input.submit": "ctrl+s",
        "tui.select.cancel": "ctrl+q",
        "tui.editor.cursorLeft": "alt+h",
        "tui.editor.cursorRight": "alt+l",
        "tui.editor.cursorLineStart": "alt+a",
        "tui.editor.cursorLineEnd": "alt+e",
        "tui.editor.deleteCharBackward": "alt+x",
        "tui.editor.deleteCharForward": "alt+d",
        "tui.editor.deleteToLineStart": "alt+u",
        "tui.editor.deleteToLineEnd": "alt+k",
      },
    });
    t.onTestFinished(() => fixture.stop());
    const running = runSecretInput(fixture.ctx, { title: "Credential" });
    await fixture.waitForOpen();
    fixture.send("\x13");
    assert.match(fixture.notifications.at(-1)?.message ?? "", /required/u);
    fixture.send("\x1b[200~ab");
    fixture.send("\r\n\tcd");
    fixture.send("\x1b[201~");
    for (const key of ["\x1ba", "\x1bd", "\x1be", "\x1bh", "\x1bx"]) fixture.send(key);
    const edited = inputLine(fixture.frame());
    assert.equal(edited.match(/•/gu)?.length, 6); // b + four spaces + d
    fixture.send("\x1bl");
    fixture.send("\x1bu");
    assert.equal(inputLine(fixture.frame()).includes("•"), false);
    fixture.send("\x1b[200~private-value\x1b[201~");
    fixture.send("\x1ba");
    fixture.send("\x1bk");
    assert.equal(inputLine(fixture.frame()).includes("•"), false);
    fixture.send("\x1b[200~final\r\n\tvalue\x1b[201~");
    fixture.send("\x13");
    assert.deepEqual(await running, { kind: "submitted", value: "final    value" });
    assert.equal(fixture.editor.getValue(), "main draft");
    assert.equal(fixture.host.getFocusedComponent(), fixture.editor);
  });

  for (const outcome of ["back", "hard-cancel", "abort", "dispose"] as const) {
    test(`${mode} ${outcome} clears secret, paste, undo and kill state on repeated disposal`, async (t) => {
      const fixture = createRendererHost(mode, rendererTheme(), { bindings: { "tui.select.cancel": "ctrl+q" } });
      t.onTestFinished(() => fixture.stop());
      const owner = new AbortController();
      const running = runSecretInput(fixture.ctx, { title: "Credential", signal: owner.signal });
      await fixture.waitForOpen();
      const component = fixture.component;
      assert.equal(fixture.keys.matches("\x19", "tui.editor.yank"), true);
      assert.equal(fixture.keys.matches("\x1f", "tui.editor.undo"), true);
      fixture.send("private-value");
      fixture.send("\x15"); // Retain a secret in the Kit kill ring and undo stack before cleanup.
      fixture.send("\x1b[200~unfinished paste");
      if (outcome === "back" || outcome === "hard-cancel") {
        fixture.send("\x1b[201~");
        fixture.send(outcome === "back" ? "\x11" : "\x03");
      } else if (outcome === "abort") owner.abort();
      else fixture.close();
      assert.deepEqual(
        await running,
        outcome === "abort" || outcome === "dispose"
          ? { kind: "stale" }
          : { kind: "closed", reason: outcome === "back" ? "back" : "close" },
      );
      component.dispose?.();
      component.dispose?.();
      component.handleInput?.("\x19"); // Yank must not recover the cleared secret.
      component.handleInput?.("\x1f"); // Undo must not recover the cleared secret.
      const cleared = component.render(80);
      assert.doesNotMatch(inputLine(cleared), /•/u);
      assert.doesNotMatch(cleared.join("\n"), /private-value|unfinished paste/u);
      assert.equal(fixture.host.getFocusedComponent(), fixture.editor);
      assert.equal(fixture.editor.getValue(), "main draft");
    });
  }

  test(`${mode} secret cursor survives edge clipping and theme invalidation without plaintext`, async (t) => {
    let activeTheme = rendererTheme("dark");
    const theme = rendererTheme("dark");
    theme.fg = (role, text) => activeTheme.fg(role, text);
    const fixture = createRendererHost(mode, theme);
    t.onTestFinished(() => fixture.stop());
    const running = runSecretInput(fixture.ctx, { title: "Credential" });
    await fixture.waitForOpen();
    fixture.send("private-value");
    const dark = fixture.frame().join("\n");
    activeTheme = rendererTheme("light");
    fixture.host.invalidate();
    const light = fixture.frame().join("\n");
    assert.notEqual(light, dark);
    assert.equal(stripVTControlCharacters(light), stripVTControlCharacters(dark));
    assert.ok(light.includes(activeTheme.fg("accent", activeTheme.bold("Credential"))));
    fixture.writes.length = 0;
    fixture.host.renderNow(true);
    assert.ok(fixture.writes.join("").includes(activeTheme.fg("accent", activeTheme.bold("Credential"))));
    assert.doesNotMatch(fixture.writes.join(""), /private-value/u);
    assert.equal(fixture.writes.join("").includes("\x1b_pi:"), false);
    activeTheme = rendererTheme("light", true);
    fixture.host.invalidate();
    assert.equal(fixture.frame().join("\n").includes("\x1b[38;2;"), false);
    fixture.writes.length = 0;
    fixture.host.renderNow(true);
    assert.equal(fixture.writes.join("").includes("\x1b[38;2;"), false);

    const originalRender = fixture.component.render.bind(fixture.component);
    // Clip exactly after the cursor cell, removing FAKE_CURSOR_END, as a parent layout can do.
    for (const clip of [2, 3]) {
      fixture.component.render = (width) => originalRender(width).map((line) => truncateToWidth(line, clip, ""));
      fixture.send("\x01");
      for (const hardware of [false, true]) {
        fixture.host.setShowHardwareCursor(hardware);
        fixture.writes.length = 0;
        fixture.host.renderNow(true);
        const output = fixture.writes.join("");
        assert.doesNotMatch(output, /private-value/u);
        assert.equal(output.includes("\x1b_pi:"), false);
        assert.equal(output.includes("\x1b[7m"), clip === 3 && !hardware);
        if (clip === 3) assert.ok(output.includes(hardware ? "> •" : "> \x1b[7m•"));
      }
    }
    fixture.component.render = originalRender;
    fixture.send("\x03");
    assert.deepEqual(await running, { kind: "closed", reason: "close" });
  });
}
