import { extname } from "node:path";
import { Worker } from "node:worker_threads";
import {
  allocateImageId,
  getCapabilities,
  getCellDimensions,
  type ImageDimensions,
  renderImage,
} from "@earendil-works/pi-tui";
import { openPreviewFile } from "./filelinks.js";

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

async function readImage(cwd: string, path: string, signal: AbortSignal): Promise<Buffer | undefined> {
  const source = await openPreviewFile(cwd, path, signal);
  if (!source) return undefined;
  try {
    if (signal.aborted) return undefined;
    const bytes = await source.file.readFile({ signal });
    if (!signal.aborted && bytes.length === source.size) return bytes;
  } catch {
    // An unreadable or cancelled preview is not shown.
  } finally {
    await source.file.close().catch(() => undefined);
  }
}

interface Thumbnail extends ImageDimensions {
  data: string;
}

async function resizeForTerminal(
  bytes: Buffer,
  mime: ImageMime,
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<Thumbnail | undefined> {
  const cell = getCellDimensions();
  const worker = new Worker(new URL("./image-thumbnail-worker.mjs", import.meta.url), {
    workerData: {
      bytes,
      format: mime.slice("image/".length),
      maxWidth: Math.max(1, Math.floor((width - 2) * cell.widthPx)),
      maxHeight: Math.max(1, Math.floor(height * cell.heightPx)),
    },
    // Transfer a whole buffer. Do not detach a shared allocation for a slice.
    transferList:
      bytes.buffer instanceof ArrayBuffer && bytes.byteLength === bytes.buffer.byteLength ? [bytes.buffer] : [],
  });
  const result = Promise.withResolvers<Thumbnail | undefined>();
  const abort = () => result.resolve(undefined);
  signal.addEventListener("abort", abort, { once: true });
  worker.once("message", result.resolve);
  worker.on("error", abort);
  worker.once("exit", abort);
  try {
    return await result.promise;
  } finally {
    signal.removeEventListener("abort", abort);
    void worker.terminate().catch(() => undefined);
  }
}

/** Prepares a viewport-sized PNG; Pi owns the terminal image placement and cleanup. */
export async function prepareImagePreview(
  cwd: string,
  path: string,
  mime: ImageMime,
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<((column: number) => string[]) | undefined> {
  if (width < 3 || height < 1 || getCapabilities().images !== "kitty") return undefined;
  const bytes = await readImage(cwd, path, signal);
  if (!bytes?.length || signal.aborted) return undefined;
  const thumbnail = await resizeForTerminal(bytes, mime, width, height, signal).catch(() => undefined);
  if (!thumbnail || signal.aborted) return undefined;

  const imageId = allocateImageId();
  return (column) => {
    if (getCapabilities().images !== "kitty") return [];
    const image = renderImage(thumbnail.data, thumbnail, {
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
