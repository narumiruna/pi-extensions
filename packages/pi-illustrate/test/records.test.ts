import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { createRecord, projectModelImages, readRecord } from "../src/records.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const layout = {
  kind: "svg" as const,
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
  width: 1,
  height: 1,
};
const result = (details: Extract<AgentMessage, { role: "toolResult" }>["details"]): AgentMessage => ({
  role: "toolResult",
  toolName: "illustrate_svg",
  toolCallId: "one",
  timestamp: 1,
  content: [{ type: "text", text: "Rendered SVG" }],
  isError: false,
  details,
});

describe("immutable session records and model projection", () => {
  it("keeps default content text-only and adds exactly one explicitly requested image", () => {
    const ordinary = result(createRecord(layout, "auto"));
    expect(projectModelImages([ordinary])[0]).toBe(ordinary);
    const opted = result(createRecord(layout, 80, { png, width: 1, height: 1 }));
    const original = JSON.stringify(opted);
    const projected = projectModelImages([opted]);
    expect(projected[0]).not.toBe(opted);
    expect(
      projected[0].role === "toolResult" && projected[0].content.filter((part) => part.type === "image"),
    ).toHaveLength(1);
    expect(projectModelImages(projected)).toEqual(projected);
    expect(JSON.stringify(opted)).toBe(original);
  });

  it("preserves the entire earlier model-visible prefix on ordinary later requests", () => {
    const first = [result(createRecord(layout, "auto", { png, width: 1, height: 1 }))];
    const baseline = JSON.stringify(projectModelImages(first));
    const later: AgentMessage[] = [...first, { role: "user", content: "Next diagram", timestamp: 2 }];
    const projected = projectModelImages(later);
    expect(JSON.stringify(projected.slice(0, first.length))).toBe(baseline);
    expect(projected[1]).toBe(later[1]);
  });

  it("does not project another tool, a mismatched kind, an error, or unknown record version", () => {
    const details = createRecord(layout, "auto", { png, width: 1, height: 1 });
    const message = result(details);
    if (message.role !== "toolResult") throw new Error();
    for (const variant of [
      { ...message, toolName: "read" },
      { ...message, toolName: "illustrate_mermaid" },
      { ...message, isError: true },
      { ...message, details: { ...details, type: "pi-illustrate/v99" } },
    ])
      expect(projectModelImages([variant])[0]).toBe(variant);
  });

  it.each([
    null,
    [],
    {},
    { type: "pi-illustrate/v1", layout, cols: 0 },
    { type: "pi-illustrate/v1", layout: { ...layout, width: Infinity }, cols: "auto" },
    { type: "pi-illustrate/v1", layout: { ...layout, height: -1 }, cols: "auto" },
    {
      type: "pi-illustrate/v1",
      layout,
      cols: "auto",
      modelImage: { type: "image", data: "invalid", mimeType: "image/png" },
    },
  ])("rejects invalid persisted data %#", (value) => {
    expect(readRecord(value)).toBeUndefined();
  });

  it("copies layout and snapshot data independently of later source-object changes", () => {
    const original = { ...layout };
    const image = { png, width: 1, height: 1 };
    const record = createRecord(original, "auto", image);
    original.svg = "changed";
    image.png = "changed";
    expect(record.layout.svg).toBe(layout.svg);
    expect(record.modelImage?.data).toBe(png);
    expect(readRecord(record)).toBe(record);
  });
});
