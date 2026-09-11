import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createTerminalLaunchError,
  isTerminalLaunchError,
  normalizeTerminal,
  resolveTerminalPreference,
  terminalPreferenceLabel,
} from "../src/terminal.js";
import { ZellijLaunchError } from "../src/zellij.js";

test("terminal helpers normalize, label, and classify terminal values", () => {
  assert.equal(normalizeTerminal("zellij"), "zellij");
  assert.equal(terminalPreferenceLabel("auto"), "Automatic");
  assert.equal(terminalPreferenceLabel("ghostty"), "Ghostty");
  assert.equal(isTerminalLaunchError(new ZellijLaunchError("partial", true, "terminal_7")), true);
  assert.ok(createTerminalLaunchError("zellij", "failed", true, "terminal_8") instanceof ZellijLaunchError);
});

test("automatic terminal resolution uses complete environment signatures in stable order", () => {
  assert.equal(
    resolveTerminalPreference("auto", {
      TMUX: "/tmp/tmux/default,1234,0",
      TMUX_PANE: "%7",
      ZELLIJ: "0",
      ZELLIJ_PANE_ID: "8",
      TERM_PROGRAM: "ghostty",
    }),
    "tmux",
  );
  assert.equal(
    resolveTerminalPreference("auto", {
      TMUX: "/tmp/tmux/default,1234,0",
      TMUX_PANE: "7",
      ZELLIJ: "0",
      ZELLIJ_PANE_ID: "8",
      TERM_PROGRAM: "ghostty",
    }),
    "zellij",
  );
  assert.equal(
    resolveTerminalPreference("auto", {
      ZELLIJ: "0",
      ZELLIJ_PANE_ID: "terminal_8",
      TERM_PROGRAM: "ghostty",
    }),
    "ghostty",
  );
});

test("terminal resolution keeps pinned preferences strict and rejects incomplete auto context", () => {
  assert.equal(resolveTerminalPreference("tmux", {}), "tmux");
  assert.equal(resolveTerminalPreference("ghostty", { TMUX: "stale" }), "ghostty");
  for (const environment of [
    {},
    { TMUX: "/tmp/tmux/default,1234,0" },
    { TMUX: "/tmp/tmux/default,1234,0", TMUX_PANE: "7" },
    { ZELLIJ: "0" },
    { ZELLIJ: "0", ZELLIJ_PANE_ID: "terminal_8" },
    { TERM_PROGRAM: "Ghostty" },
  ]) {
    assert.throws(() => resolveTerminalPreference("auto", environment), /could not detect a supported terminal/u);
  }
});
