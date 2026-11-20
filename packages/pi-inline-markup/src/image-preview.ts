import { extname } from "node:path";
import { convertToPng } from "@earendil-works/pi-coding-agent";
import {
  allocateImageId,
  getCapabilities,
  getImageDimensions,
  type ImageDimensions,
  renderImage,
} from "@earendil-works/pi-tui";
import { readPreviewBytes } from "./filelinks.js";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_PIXELS = 4_000_000;
const PNG_HEADER = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export function previewImageMime(path: string): ImageMime | undefined {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
  }
}

function fitsPixelBudget(dimensions: ImageDimensions | null): dimensions is ImageDimensions {
  return (
    dimensions !== null &&
    dimensions.widthPx > 0 &&
    dimensions.heightPx > 0 &&
    dimensions.widthPx * dimensions.heightPx <= MAX_PIXELS
  );
}

/** Prepares a bounded Kitty overlay; Pi owns the terminal image placement and cleanup. */
export async function prepareImagePreview(
  cwd: string,
  path: string,
  mime: ImageMime,
  signal: AbortSignal,
): Promise<((width: number, height: number, column: number) => string[]) | undefined> {
  if (getCapabilities().images !== "kitty") return undefined;
  const file = await readPreviewBytes(cwd, path, signal, MAX_IMAGE_BYTES);
  if (!file || signal.aborted) return undefined;
  if (
    mime === "image/png" &&
    (file.bytes.length < 33 || !file.bytes.subarray(0, PNG_HEADER.length).equals(PNG_HEADER))
  ) {
    return undefined;
  }
  let data = file.bytes.toString("base64");
  let dimensions = getImageDimensions(data, mime);
  if (!fitsPixelBudget(dimensions)) return undefined;
  if (mime !== "image/png") {
    const converted = await convertToPng(data, mime).catch(() => null);
    if (signal.aborted || !converted || Buffer.byteLength(converted.data, "base64") > MAX_IMAGE_BYTES) return undefined;
    data = converted.data;
    dimensions = getImageDimensions(data, "image/png");
    if (!fitsPixelBudget(dimensions)) return undefined;
  }

  const size = dimensions;
  const imageId = allocateImageId();
  return (width, height, column) => {
    if (width < 3 || height < 1 || getCapabilities().images !== "kitty") return [];
    const image = renderImage(data, size, {
      maxWidthCells: width - 2,
      maxHeightCells: height,
      imageId,
      moveCursor: false,
    });
    if (!image) return [];
    // Blank the image cells before placing it, then restore the cursor for the
    // compositor's trailing text. Pi's slicing preserves absolute column
    // moves (CSI G), not relative left and right moves (CSI D/C).
    const { columns, rows, sequence } = image;
    const start = column + 2; // 1-based terminal column plus one cell of inset.
    const firstLine = ` ${" ".repeat(columns)}\x1b[${start}G${sequence}\x1b[${start + columns}G`;
    return [firstLine, ...Array<string>(rows - 1).fill("")];
  };
}
