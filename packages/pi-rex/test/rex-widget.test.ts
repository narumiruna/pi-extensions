import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { type RexDisplay, renderRexWidget, rexSummary } from "../src/rex-widget.js";
import { pane } from "./fixtures.js";

const theme = { fg: (_role: string, text: string) => text } as Theme;
const normal: RexDisplay = { entries: [pane], warnings: [] };

test("renders states, sanitized paths, terminal location, and a current-pane label", () => {
  const lines = renderRexWidget(normal, theme, 140, 36, pane);
  assert.match(lines[1] ?? "", /● Working\s+~\/src\/project\s+Project \/ Code \/ Pi \(this pane\)/u);
  const fallback = renderRexWidget(
    { ...normal, entries: [{ ...pane, state: "idle", reported: false }] },
    theme,
    100,
    36,
  );
  assert.match(fallback.join("\n"), /Idle\*/u);
});

test.each([0, 1, 2, 5, 12, 20, 40, 80, 120])(
  "fits every line within %i cells with Unicode and untrusted input",
  (width) => {
    const display: RexDisplay = {
      entries: Array.from({ length: 20 }, () => ({
        ...pane,
        session: "\x1b]52;c;malicious\x07Project\u202e",
        tab: "界😀Code\nTab",
        pane: "\x1b[31mPi\x1b[0m",
        cwd: "/home/user/\u202e界😀/src/project\nname",
      })),
      warnings: ["\x1b[31mwarning\x1b[0m\nmore"],
    };
    for (const rows of [0, 1, 4, 8, 12, 24, 36, 100]) {
      const lines = renderRexWidget(display, theme, width, rows);
      assert.ok(lines.length <= Math.max(1, Math.min(8, Math.floor(rows / 4))));
      for (const line of lines) {
        assert.ok(visibleWidth(line) <= width, JSON.stringify({ width, line }));
        const plain = line.replaceAll("\x1b[0m", "");
        assert.ok(["\x1b", "\n", "\r", "\u202e"].every((control) => !plain.includes(control)));
      }
    }
  },
);

test("uses borderMuted for its full-width leading separator", () => {
  const roles: string[] = [];
  const tracked = {
    fg: (role: string, text: string) => {
      roles.push(role);
      return text;
    },
  } as Theme;
  const lines = renderRexWidget(normal, tracked, 45, 36);
  assert.equal(lines[0], "─".repeat(45));
  assert.ok(roles.includes("borderMuted"));
  assert.equal(renderRexWidget(normal, tracked, 0, 36)[0], "");
});

test("bounds list height and reports the actual omitted count", () => {
  const display = { entries: Array.from({ length: 20 }, () => pane), warnings: [] };
  const lines = renderRexWidget(display, theme, 80, 36);
  assert.equal(lines.length, 8);
  assert.equal(lines.at(-1), "+14 more Pi sessions");
  assert.match(rexSummary(display), /^20 Pi sessions$/u);
});

test("only abbreviates HOME on a path-component boundary after sanitization", () => {
  const abbreviated = renderRexWidget(normal, theme, 150, 36).join("\n");
  assert.match(abbreviated, /~\/src\/project/u);
  const unrelated = renderRexWidget(
    { ...normal, entries: [{ ...pane, cwd: "/home/username/src" }] },
    theme,
    150,
    36,
  ).join("\n");
  assert.match(unrelated, /\/home\/username\/src/u);
  assert.doesNotMatch(unrelated, /~name/u);
  const path = `/home/user/${"界".repeat(40)}/project`;
  assert.match(
    renderRexWidget({ ...normal, entries: [{ ...pane, cwd: path }] }, theme, 70, 36).join("\n"),
    /….*\/project/u,
  );
});

test("shows connecting, empty, partial, and stale states without interpreting text", () => {
  const states: [RexDisplay, RegExp, string][] = [
    [{ entries: [], warnings: [], loading: true }, /Connecting to Rex/u, "Connecting"],
    [{ entries: [], warnings: [] }, /No Pi sessions found/u, "0 Pi sessions"],
    [
      { ...normal, warnings: ["Unavailable"] },
      /Partial snapshot \(1 warning\): Unavailable/u,
      "Partial · 1 Pi session",
    ],
    [
      { ...normal, error: "Server\n\x1b[31moffline\x1b[0m" },
      /Rex unavailable: Server offline/u,
      "Disconnected · 1 Pi session (stale)",
    ],
  ];
  for (const [display, expected, summary] of states) {
    assert.match(renderRexWidget(display, theme, 120, 36).join("\n"), expected);
    assert.equal(rexSummary(display), summary);
  }
});

test("reads themes on each render and has no cached styled domain state", () => {
  const colored = (code: number) => ({ fg: (_role: string, value: string) => `\x1b[${code}m${value}\x1b[0m` }) as Theme;
  const first = renderRexWidget(normal, colored(31), 80, 36);
  const next = renderRexWidget(normal, colored(32), 80, 36);
  assert.ok(first.join().includes("\x1b[31m"));
  assert.ok(!next.join().includes("\x1b[31m"));
  assert.deepEqual(first.map(stripTerminalSequences), next.map(stripTerminalSequences));
});
