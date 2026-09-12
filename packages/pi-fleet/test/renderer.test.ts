import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { FLEET_MESSAGE_TYPE, renderFleetMessage } from "../src/renderer.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as never;

test("message renderer strips terminal controls and remains bounded at narrow CJK widths", () => {
  const raw = "保留\u001b[31m紅色\u001b[0m\r改寫\n第二行";
  const component = renderFleetMessage(
    {
      role: "custom",
      customType: FLEET_MESSAGE_TYPE,
      content: raw,
      display: true,
      details: {
        message: {
          id: "msg_1234567890",
          fromSessionId: "sender",
          fromName: "名稱\u001b]0;bad\u0007",
          fromCwd: "/tmp/專案",
          toSessionId: "receiver",
          mode: "notify",
          text: raw,
          issuedAt: Date.now(),
          expiresAt: Date.now() + 120_000,
        },
      },
      timestamp: Date.now(),
    },
    { expanded: true, outputPad: 0 },
    theme,
  );
  assert.ok(component);
  const lines = component.render(12);
  assert.equal(
    lines.some((line) => line.includes("\u001b") || line.includes("\r")),
    false,
  );
  assert.equal(
    lines.some((line) => line.includes("保留")),
    true,
  );
  assert.equal(
    lines.every((line) => visibleWidth(line) <= 12),
    true,
  );
  component.invalidate();
  assert.equal(
    component.render(12).every((line) => visibleWidth(line) <= 12),
    true,
  );
});
