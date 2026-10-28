import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, sep } from "node:path";
import { inflateSync } from "node:zlib";
import { createWriteTool } from "@earendil-works/pi-coding-agent";
import { getImageDimensions } from "@earendil-works/pi-tui";

export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
// Bound terminal previews: at most 16,384 pixels per side and 16 megapixels.
// PNG's largest supported raster (16-bit RGBA) is therefore at most 128 MiB.
const MAX_DIMENSION = 16_384;
const MAX_PIXELS = 16_777_216;
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);

export interface DecodedImage {
  bytes: Buffer;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  extension: "png" | "jpg" | "webp";
  width: number;
  height: number;
}

function invalidImage(): never {
  throw new Error("Unsupported, truncated, or malformed image.");
}

function checkDimensions(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  ) {
    throw new Error("Image dimensions exceed the supported limits.");
  }
}

// CRC checks also detect damaged ancillary chunks without changing original bytes.
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (CRC_TABLE[(value ^ byte) & 255] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function validatePng(bytes: Buffer, width: number, height: number): void {
  if (!bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) invalidImage();
  let offset = 8;
  let depth = 0;
  let color = -1;
  let interlace = 0;
  let palette = false;
  let endedData = false;
  const data: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) invalidImage();
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || (bytes.readUInt8(offset + 6) & 32) !== 0) invalidImage();
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalidImage();
    const chunk = bytes.subarray(offset + 8, end - 4);
    if (offset === 8 && type !== "IHDR") invalidImage();
    if (type === "IHDR") {
      if (offset !== 8 || length !== 13) invalidImage();
      depth = chunk.readUInt8(8);
      color = chunk.readUInt8(9);
      interlace = chunk.readUInt8(12);
      const depths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (!depths[color]?.includes(depth) || chunk[10] !== 0 || chunk[11] !== 0 || interlace > 1) invalidImage();
    } else if (type === "PLTE") {
      if (palette || data.length || color === 0 || color === 4 || !length || length % 3 || length > 768) invalidImage();
      if (color === 3 && length / 3 > 2 ** depth) invalidImage();
      palette = true;
    } else if (type === "IDAT") {
      if (endedData || (color === 3 && !palette)) invalidImage();
      data.push(chunk);
    } else if (type === "IEND") {
      if (length || end !== bytes.length || !data.length) invalidImage();
      const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color] ?? invalidImage();
      const passes: [number, number, number, number][] = interlace
        ? [
            [0, 0, 8, 8],
            [4, 0, 8, 8],
            [0, 4, 4, 8],
            [2, 0, 4, 4],
            [0, 2, 2, 4],
            [1, 0, 2, 2],
            [0, 1, 1, 2],
          ]
        : [[0, 0, 1, 1]];
      const rows = passes.map(([x, y, dx, dy]) => {
        const columns = Math.max(0, Math.ceil((width - x) / dx));
        const count = columns ? Math.max(0, Math.ceil((height - y) / dy)) : 0;
        return { count, stride: 1 + Math.ceil((columns * channels * depth) / 8) };
      });
      const expected = rows.reduce((size, row) => size + row.count * row.stride, 0);
      const compressed = Buffer.concat(data);
      try {
        const inflated = inflateSync(compressed, { maxOutputLength: expected });
        if (inflated.length !== expected) invalidImage();
        let position = 0;
        for (const row of rows) {
          for (let index = 0; index < row.count; index++, position += row.stride) {
            if (inflated.readUInt8(position) > 4) invalidImage();
          }
        }
      } catch {
        invalidImage();
      }
      return;
    } else {
      // Animation can multiply the preview budget; unknown critical chunks are unsupported.
      if (!(bytes.readUInt8(offset + 4) & 32) || ["acTL", "fcTL", "fdAT"].includes(type)) invalidImage();
    }
    if (data.length && type !== "IDAT") endedData = true;
    offset = end;
  }
  invalidImage();
}

// Validate complete JPEG framing, not only the SOF dimensions. Entropy decoding is
// left to the image renderer; this is not a general-purpose JPEG codec validator.
function validateJpeg(bytes: Buffer): void {
  let offset = 2;
  let frame = false;
  let scan = false;
  let quantization = false;
  let huffman = false;
  const components = new Set<number>();
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalidImage();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!frame || !scan || offset !== bytes.length) invalidImage();
      return;
    }
    if (offset + 2 > bytes.length) invalidImage();
    const length = bytes.readUInt16BE(offset);
    const end = offset + length;
    if (length < 2 || end > bytes.length) invalidImage();
    const chunk = bytes.subarray(offset + 2, end);
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const count = chunk[5];
      if (frame || chunk.length < 6 || chunk[0] !== 8 || !count || count > 4 || chunk.length !== 6 + 3 * count)
        invalidImage();
      for (let index = 0; index < count; index++) {
        const id = chunk.readUInt8(6 + 3 * index);
        const sampling = chunk.readUInt8(7 + 3 * index);
        if (
          components.has(id) ||
          !(sampling >> 4) ||
          sampling >> 4 > 4 ||
          !(sampling & 15) ||
          (sampling & 15) > 4 ||
          chunk.readUInt8(8 + 3 * index) > 3
        )
          invalidImage();
        components.add(id);
      }
      frame = true;
    } else if (marker === 0xdb) {
      let position = 0;
      while (position < chunk.length) {
        const table = chunk.readUInt8(position++);
        if (table >> 4 > 1 || (table & 15) > 3) invalidImage();
        const size = table >> 4 ? 128 : 64;
        if (position + size > chunk.length) invalidImage();
        position += size;
      }
      if (!position) invalidImage();
      quantization = true;
    } else if (marker === 0xc4) {
      let position = 0;
      while (position < chunk.length) {
        const table = chunk.readUInt8(position++);
        if (table >> 4 > 1 || (table & 15) > 3 || position + 16 > chunk.length) invalidImage();
        let count = 0;
        let slots = 1;
        for (let index = 0; index < 16; index++) {
          const codes = chunk.readUInt8(position++);
          slots = slots * 2 - codes;
          if (slots < 0) invalidImage();
          count += codes;
        }
        if (!count || count > 256 || position + count > chunk.length) invalidImage();
        position += count;
      }
      if (!position) invalidImage();
      huffman = true;
    } else if (marker === 0xda) {
      const count = chunk[0];
      if (!frame || !quantization || !huffman || !count || chunk.length !== 4 + 2 * count) invalidImage();
      const selected = new Set<number>();
      for (let index = 0; index < count; index++) {
        const id = chunk.readUInt8(1 + 2 * index);
        const tables = chunk.readUInt8(2 + 2 * index);
        if (!components.has(id) || selected.has(id) || tables >> 4 > 3 || (tables & 15) > 3) invalidImage();
        selected.add(id);
      }
      if (
        chunk.readUInt8(chunk.length - 3) > 63 ||
        chunk.readUInt8(chunk.length - 2) > 63 ||
        chunk.readUInt8(chunk.length - 1) >> 4 > 13 ||
        (chunk.readUInt8(chunk.length - 1) & 15) > 13
      )
        invalidImage();
      offset = end;
      const start = offset;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset++;
          continue;
        }
        let next = offset + 1;
        while (bytes[next] === 0xff) next++;
        if (
          bytes[next] === 0 ||
          (next < bytes.length && bytes.readUInt8(next) >= 0xd0 && bytes.readUInt8(next) <= 0xd7)
        ) {
          offset = next + 1;
          continue;
        }
        break;
      }
      if (offset === start) invalidImage();
      scan = true;
      continue;
    } else if (marker === 0xdd) {
      if (chunk.length !== 2) invalidImage();
    } else if (!(marker !== undefined && ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe))) {
      invalidImage();
    }
    offset = end;
  }
  invalidImage();
}

// RIFF and bitstream headers are validated; VP8/VP8L entropy decoding is not done here.
function validateWebp(bytes: Buffer, width: number, height: number): void {
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) invalidImage();
  let offset = 12;
  let extended = false;
  let image = false;
  let alpha = false;
  let alphaFlag = false;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("latin1", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (end + (length & 1) > bytes.length || (length & 1 && bytes[end] !== 0)) invalidImage();
    const chunk = bytes.subarray(offset + 8, end);
    if (type === "VP8X") {
      if (offset !== 12 || length !== 10 || chunk.readUInt8(0) & 0xc3 || chunk[1] || chunk[2] || chunk[3])
        invalidImage();
      alphaFlag = !!(chunk.readUInt8(0) & 16);
      extended = true;
    } else if (type === "VP8 " || type === "VP8L") {
      if (image) invalidImage();
      let actualWidth: number;
      let actualHeight: number;
      if (type === "VP8 ") {
        if (
          length < 11 ||
          chunk.readUInt8(0) & 1 ||
          ((chunk.readUInt8(0) >> 1) & 7) > 3 ||
          !(chunk.readUInt8(0) & 16) ||
          !chunk.subarray(3, 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))
        )
          invalidImage();
        const partition = chunk.readUIntLE(0, 3) >>> 5;
        if (!partition || partition + 10 >= length) invalidImage();
        actualWidth = chunk.readUInt16LE(6) & 0x3fff;
        actualHeight = chunk.readUInt16LE(8) & 0x3fff;
      } else {
        if (alpha || length < 6 || chunk[0] !== 0x2f || chunk.readUInt8(4) & 0xe0) invalidImage();
        const bits = chunk.readUInt32LE(1);
        actualWidth = (bits & 0x3fff) + 1;
        actualHeight = ((bits >>> 14) & 0x3fff) + 1;
      }
      if (actualWidth !== width || actualHeight !== height) invalidImage();
      image = true;
    } else if (type === "ALPH") {
      if (
        !extended ||
        !alphaFlag ||
        alpha ||
        image ||
        length < 2 ||
        chunk.readUInt8(0) & 0xc0 ||
        (chunk.readUInt8(0) & 3) > 1 ||
        ((chunk.readUInt8(0) >> 4) & 3) > 1
      )
        invalidImage();
      if (!(chunk.readUInt8(0) & 3) && length !== 1 + width * height) invalidImage();
      alpha = true;
    } else if (!extended || ["ANIM", "ANMF"].includes(type)) {
      invalidImage();
    }
    offset = end + (length & 1);
  }
  if (offset !== bytes.length || !image) invalidImage();
}

export function decodeImage(base64: string): DecodedImage {
  if (typeof base64 !== "string" || !base64.length || base64.length > MAX_BASE64_LENGTH) {
    throw new Error("Image data is empty or exceeds the 32 MiB limit.");
  }
  // Buffer.from() alone accepts invalid characters, missing padding, and aliases.
  if (base64.length % 4 || /[^A-Za-z0-9+/=]/.test(base64)) throw new Error("Malformed base64 image data.");
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const size = (base64.length / 4) * 3 - padding;
  if (size > MAX_IMAGE_BYTES) throw new Error("Image data exceeds the 32 MiB limit.");
  const bytes = Buffer.from(base64, "base64");
  if (!size || bytes.length !== size || bytes.toString("base64") !== base64)
    throw new Error("Malformed base64 image data.");
  let mimeType: DecodedImage["mimeType"];
  let extension: DecodedImage["extension"];
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    mimeType = "image/png";
    extension = "png";
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    mimeType = "image/jpeg";
    extension = "jpg";
  } else if (
    bytes.length >= 30 &&
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  ) {
    mimeType = "image/webp";
    extension = "webp";
  } else {
    invalidImage();
  }
  const dimensions = getImageDimensions(base64, mimeType);
  if (!dimensions) invalidImage();
  const { widthPx: width, heightPx: height } = dimensions;
  checkDimensions(width, height);
  if (mimeType === "image/png") validatePng(bytes, width, height);
  else if (mimeType === "image/jpeg") validateJpeg(bytes);
  else validateWebp(bytes, width, height);
  return { bytes, mimeType, extension, width, height };
}

type OutputOptions = {
  cwd: string;
  path: string;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
};

function checkCurrent(options: OutputOptions): void {
  if (options.signal?.aborted || options.isCurrent?.() === false) {
    throw new DOMException("Image publication was cancelled or is no longer current.", "AbortError");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function atOutput(options: OutputOptions, action: (destination: string) => Promise<void>): Promise<string> {
  checkCurrent(options);
  if (typeof options.path !== "string" || !options.path.length) throw new Error("Output path is required.");
  let destination: string | undefined;
  const tool = createWriteTool(options.cwd, {
    operations: {
      mkdir: async (directory) => {
        checkCurrent(options);
        await fs.mkdir(directory, { recursive: true });
        checkCurrent(options);
      },
      writeFile: async (absolutePath) => {
        checkCurrent(options);
        destination = absolutePath;
        await action(absolutePath);
        checkCurrent(options);
      },
    },
  });
  // The public factory owns normalization and its mutation queue. Our guards also
  // cover queued ownership changes; await operations to drain all in-flight I/O.
  await tool.execute("codex-imagegen-output", { path: options.path, content: "" });
  checkCurrent(options);
  if (destination === undefined) throw new Error("Output destination was not resolved.");
  return destination;
}

async function checkWritable(destination: string, options: OutputOptions): Promise<void> {
  let target = destination;
  for (let links = 0; links <= 40; links++) {
    checkCurrent(options);
    try {
      const stat = await fs.stat(target);
      checkCurrent(options);
      if (stat.isDirectory()) {
        throw Object.assign(new Error("Image destination is a directory."), { code: "EISDIR", path: target });
      }
      // Overwriting an existing file needs its write permission, not parent write permission.
      await fs.access(target, constants.W_OK);
      checkCurrent(options);
      return;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    checkCurrent(options);
    let entry: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      entry = await fs.lstat(target);
      checkCurrent(options);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      checkCurrent(options);
      // A symlink target ending in a separator requires an existing directory;
      // it cannot become a new file even when its containing directory is writable.
      if (target.endsWith("/") || (sep === "\\" && target.endsWith("\\"))) {
        throw Object.assign(new Error("Image destination is a directory."), { code: "EISDIR", path: target });
      }
      // A missing target requires write and search access in its actual parent.
      // X_OK is ignored by Node on Windows. This check does not reserve the path.
      await fs.access(dirname(target), constants.W_OK | constants.X_OK);
      checkCurrent(options);
      return;
    }
    if (!entry.isSymbolicLink()) {
      await fs.access(target, constants.W_OK);
      checkCurrent(options);
      return;
    }
    const link = await fs.readlink(target);
    checkCurrent(options);
    // Do not lexically resolve link targets: a preceding directory symlink can
    // change the meaning of `..`. Let the filesystem resolve those components.
    target = isAbsolute(link) ? link : `${dirname(target)}${sep}${link}`;
  }
  throw Object.assign(new Error("Too many symbolic links."), { code: "ELOOP", path: destination });
}

/** Best-effort checks before HTTP; create parents, but never open or truncate the target. */
export async function preflightOutput(options: OutputOptions): Promise<void> {
  await atOutput(options, (destination) => checkWritable(destination, options));
  checkCurrent(options);
}

export async function publishImage(image: DecodedImage, options: OutputOptions): Promise<{ path: string }> {
  checkCurrent(options);
  checkDimensions(image.width, image.height);
  if (!Buffer.isBuffer(image.bytes) || !image.bytes.length || image.bytes.length > MAX_IMAGE_BYTES)
    throw new Error("Invalid image byte size.");
  const validated = decodeImage(image.bytes.toString("base64"));
  if (
    validated.mimeType !== image.mimeType ||
    validated.extension !== image.extension ||
    validated.width !== image.width ||
    validated.height !== image.height
  )
    invalidImage();
  const path = await atOutput(options, async (destination) => {
    // Native WRITE can leave truncated/partial output on failure or cancellation.
    // Never unlink, roll back, or rename over the target or its symlinks.
    // Unlike native text WRITE, binary writes also pass the signal to Node.
    await fs.writeFile(destination, image.bytes, { signal: options.signal });
    checkCurrent(options);
  });
  checkCurrent(options);
  return { path };
}
