import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getPngDimensions } from "@earendil-works/pi-tui";
import { type DiagramLayout, LIMITS, type RasterResult } from "./rasterizer.js";
import type { Cols } from "./settings.js";

export type IllustrateRecord = {
  type: "pi-illustrate/v1";
  layout: DiagramLayout;
  cols: Cols;
  modelImage?: { type: "image"; data: string; mimeType: "image/png" };
};

export function isIllustrateTool(name: string): boolean {
  return name === "illustrate_svg" || name === "illustrate_mermaid";
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Session files can be edited outside Pi. Validate data before restoring a preview or model image. */
export function readRecord(value: unknown): IllustrateRecord | undefined {
  if (!object(value) || value.type !== "pi-illustrate/v1" || !object(value.layout)) return undefined;
  const { layout, cols, modelImage } = value;
  if (cols !== "auto" && !(typeof cols === "number" && Number.isSafeInteger(cols) && cols > 0)) return undefined;
  if (
    (layout.kind !== "svg" && layout.kind !== "mermaid") ||
    typeof layout.svg !== "string" ||
    layout.svg.length > LIMITS.svgBytes ||
    Buffer.byteLength(layout.svg) > LIMITS.svgBytes ||
    typeof layout.width !== "number" ||
    !Number.isFinite(layout.width) ||
    layout.width <= 0 ||
    layout.width > LIMITS.dimension ||
    typeof layout.height !== "number" ||
    !Number.isFinite(layout.height) ||
    layout.height <= 0 ||
    layout.height > LIMITS.dimension
  )
    return undefined;
  if (modelImage !== undefined) {
    if (
      !object(modelImage) ||
      modelImage.type !== "image" ||
      modelImage.mimeType !== "image/png" ||
      typeof modelImage.data !== "string" ||
      modelImage.data.length > Math.ceil(LIMITS.pngBytes / 3) * 4 ||
      modelImage.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(modelImage.data)
    )
      return undefined;
    const dimensions = getPngDimensions(modelImage.data);
    if (
      !dimensions ||
      dimensions.widthPx <= 0 ||
      dimensions.heightPx <= 0 ||
      dimensions.widthPx > LIMITS.maxRasterDimension ||
      dimensions.heightPx > LIMITS.maxRasterDimension ||
      dimensions.widthPx * dimensions.heightPx > LIMITS.maxPixels
    )
      return undefined;
  }
  return value as unknown as IllustrateRecord;
}

export function createRecord(layout: DiagramLayout, cols: Cols, image?: RasterResult): IllustrateRecord {
  return {
    type: "pi-illustrate/v1",
    layout: { ...layout },
    cols,
    ...(image ? { modelImage: { type: "image" as const, data: image.png, mimeType: "image/png" as const } } : {}),
  };
}

/** Only the opted-in immutable snapshot enters model context; UI updates never change this projection. */
export function projectModelImages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (message.role !== "toolResult" || message.isError || !isIllustrateTool(message.toolName)) return message;
    if (!object(message.details) || message.details.modelImage === undefined) return message;
    const record = readRecord(message.details);
    if (!record?.modelImage || `illustrate_${record.layout.kind}` !== message.toolName) return message;
    const image = record.modelImage;
    if (
      message.content.some(
        (item) => item.type === "image" && item.data === image.data && item.mimeType === image.mimeType,
      )
    )
      return message;
    return { ...message, content: [...message.content, { ...image }] };
  });
}
