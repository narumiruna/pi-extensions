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
  maxWidth: number,
  maxHeight: number,
  signal: AbortSignal,
): Promise<Thumbnail | undefined> {
  const worker = new Worker(new URL("./image-thumbnail-worker.mjs", import.meta.url), {
    workerData: {
      bytes,
      format: mime.slice("image/".length),
      maxWidth,
      maxHeight,
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
): Promise<{ width: number; render(column: number): string[] } | undefined> {
  if (width < 2 || height < 1 || getCapabilities().images !== "kitty") return undefined;
  // Pi drops ANSI sequences at the exclusive end of an overlay. Reserve one
  // column after the image to keep the Kitty upload and cursor restore intact.
  const maxWidth = width - 1;
  const bytes = await readImage(cwd, path, signal);
  if (!bytes?.length || signal.aborted) return undefined;
  const cell = getCellDimensions();
  const thumbnail = await resizeForTerminal(bytes, mime, maxWidth * cell.widthPx, height * cell.heightPx, signal).catch(
    () => undefined,
  );
  if (!thumbnail || signal.aborted || getCapabilities().images !== "kitty") return undefined;

  const currentCell = getCellDimensions();
  const columns = Math.ceil(thumbnail.widthPx / currentCell.widthPx);
  const rows = Math.ceil(thumbnail.heightPx / currentCell.heightPx);
  if (columns > maxWidth || rows > height) return undefined;
  // Register the occupied cells with Pi for redraw and cleanup. Remove the
  // Kitty sizing controls so the terminal displays the PNG at its pixel size.
  const image = renderImage(
    thumbnail.data,
    { widthPx: columns * currentCell.widthPx, heightPx: rows * currentCell.heightPx },
    { maxWidthCells: columns, maxHeightCells: rows, imageId: allocateImageId(), moveCursor: false },
  );
  if (!image) return undefined;
  const headerEnd = image.sequence.indexOf(";");
  const sequence = image.sequence.slice(0, headerEnd).replace(/,[cr]=\d+/g, "") + image.sequence.slice(headerEnd);
  return {
    width: columns + 1,
    render(column) {
      if (getCapabilities().images !== "kitty") return [];
      // Clear the covered cells, place the image, and restore the cursor for
      // the compositor's padding and trailing text. Pi preserves CSI G.
      const start = column + 1;
      const firstLine = `${" ".repeat(columns)}\x1b[${start}G${sequence}\x1b[${start + columns}G`;
      return [firstLine, ...Array<string>(rows - 1).fill("")];
    },
  };
}
