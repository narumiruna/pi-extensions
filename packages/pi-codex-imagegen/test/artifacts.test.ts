import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { createWriteTool, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeImage, MAX_IMAGE_BYTES, preflightOutput, publishImage } from "../src/artifacts.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
const realFs = await vi.importActual<typeof fs>("node:fs/promises");

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, body, checksum]);
}

// Two RGBA pixels: fully transparent red and half-transparent green.
const PIXELS = Buffer.from([0, 255, 0, 0, 0, 0, 255, 0, 128]);
function png(width = 2, height = 1, raster = PIXELS): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raster)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// A real one-component, 1x1 baseline JPEG: DC zero, EOB, and one-bit codes.
function jpeg(): Buffer {
  const segment = (marker: number, data: number[]) => {
    const size = Buffer.alloc(2);
    size.writeUInt16BE(data.length + 2);
    return Buffer.concat([Buffer.from([255, marker]), size, Buffer.from(data)]);
  };
  const counts = [1, ...Array<number>(15).fill(0)];
  return Buffer.concat([
    Buffer.from([255, 216]),
    segment(0xdb, [0, ...Array<number>(64).fill(1)]),
    segment(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
    segment(0xc4, [0, ...counts, 0, 0x10, ...counts, 0]),
    segment(0xda, [1, 1, 0, 0, 63, 0]),
    Buffer.from([0x3f, 255, 217]),
  ]);
}
const WEBP = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
// Generated from a half-transparent red pixel; no codec is needed at test time.
const WEBP_LOSSLESS = Buffer.from("UklGRhwAAABXRUJQVlA4TBAAAAAvAAAAEM1VICIC0f9oYAIA", "base64");
function extendedWebp(bytes: Buffer, flags = 0): Buffer {
  const header = Buffer.alloc(18);
  header.write("VP8X");
  header.writeUInt32LE(10, 4);
  header[8] = flags;
  const riff = Buffer.from(bytes.subarray(0, 12));
  const body = Buffer.concat([header, bytes.subarray(12)]);
  riff.writeUInt32LE(4 + body.length, 4);
  return Buffer.concat([riff, body]);
}
const PNG = png();
const decode = (bytes: Buffer) => decodeImage(bytes.toString("base64"));

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "pi-image-artifacts-"));
  vi.clearAllMocks();
  vi.mocked(fs.writeFile).mockImplementation(realFs.writeFile);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});
const options = (path = "output/image") => ({ cwd: directory, path });

function deferred() {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function nativeDestination(cwd: string, path: string): Promise<string> {
  let destination = "";
  await createWriteTool(cwd, {
    operations: {
      mkdir: async () => {},
      writeFile: async (absolutePath) => {
        destination = absolutePath;
      },
    },
  }).execute("native-path-reference", { path, content: "" });
  return destination;
}

async function nativeWrite(path: string): Promise<void> {
  await createWriteTool(directory).execute("native-write-reference", { path, content: "native text" });
}

describe("image decoding", () => {
  it.each([
    ["PNG", PNG, "image/png", "png", 2],
    ["JPEG", jpeg(), "image/jpeg", "jpg", 1],
    ["WebP", WEBP, "image/webp", "webp", 1],
    ["lossless WebP", WEBP_LOSSLESS, "image/webp", "webp", 1],
    ["extended WebP", extendedWebp(WEBP), "image/webp", "webp", 1],
    ["extended lossless WebP", extendedWebp(WEBP_LOSSLESS, 16), "image/webp", "webp", 1],
  ] as const)("identifies %s bytes, dimensions, and suffix", (_name, bytes, mimeType, extension, width) => {
    expect(decode(bytes)).toEqual({ bytes, mimeType, extension, width, height: 1 });
  });

  it("preserves the exact RGBA source bytes, including transparent pixels", () => {
    expect(decode(PNG).bytes.equals(PNG)).toBe(true);
    expect(PIXELS).toEqual(Buffer.from([0, 255, 0, 0, 0, 0, 255, 0, 128]));
  });

  it.each([
    "",
    " ",
    "a",
    "aaa",
    "a===",
    "====",
    "AA=A",
    "AA==AA==",
    "AB==",
    "AAB=",
    "AA-_",
    "AA==\n",
    "data:image/png;base64,AA==",
  ])("rejects malformed/noncanonical base64 %j", (base64) => {
    expect(() => decodeImage(base64)).toThrow();
  });

  it("bounds encoded and decoded sizes before image parsing", () => {
    expect(MAX_IMAGE_BYTES).toBe(32 * 1024 * 1024);
    expect(() => decodeImage("A".repeat(4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 4))).toThrow(/32 MiB/);
    // At the encoded length limit, a lack of padding would exceed the decoded cap.
    expect(() => decodeImage("A".repeat(4 * Math.ceil(MAX_IMAGE_BYTES / 3)))).toThrow(/32 MiB/);
  });

  it.each([Buffer.from("not an image"), Buffer.from("GIF89a1234567890"), Buffer.from("<svg width='1'/>")])(
    "rejects unsupported media",
    (bytes) => {
      expect(() => decode(bytes)).toThrow(/image/);
    },
  );

  it.each([PNG, jpeg(), WEBP, WEBP_LOSSLESS, extendedWebp(WEBP)])(
    "rejects truncation at every container boundary",
    (bytes) => {
      for (let size = 1; size < bytes.length; size++) expect(() => decode(bytes.subarray(0, size))).toThrow();
      expect(() => decode(Buffer.concat([bytes, Buffer.from([0])]))).toThrow();
    },
  );

  it.each([
    [0, 1],
    [1, 0],
    [16_385, 1],
    [1, 16_385],
    [4097, 4096],
  ])("rejects dimensions %s x %s", (width, height) => {
    expect(() => decode(png(width, height))).toThrow(/dimensions/);
  });

  it("accepts the side limit when the pixel budget permits", () => {
    expect(decode(png(16_384, 1, Buffer.alloc(1 + 16_384 * 4)))).toMatchObject({ width: 16_384 });
  });

  it("rejects PNG CRC damage, bad filters, short/long rasters, and invalid zlib", () => {
    const damaged = Buffer.from(PNG);
    damaged[29] = damaged.readUInt8(29) ^ 1;
    const invalidFilter = Buffer.from(PIXELS);
    invalidFilter[0] = 5;
    for (const bytes of [
      damaged,
      png(2, 1, invalidFilter),
      png(2, 1, PIXELS.subarray(1)),
      png(2, 1, Buffer.concat([PIXELS, Buffer.from([0])])),
    ]) {
      expect(() => decode(bytes)).toThrow();
    }
    const idat = PNG.indexOf("IDAT");
    const invalidZlib = Buffer.concat([
      PNG.subarray(0, idat - 4),
      chunk("IDAT", Buffer.from("invalid")),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    expect(() => decode(invalidZlib)).toThrow();
  });

  it("rejects PNG animation and unknown critical chunks", () => {
    for (const type of ["acTL", "fcTL", "fdAT", "ABCD"]) {
      expect(() =>
        decode(Buffer.concat([PNG.subarray(0, 33), chunk(type, Buffer.alloc(8)), PNG.subarray(33)])),
      ).toThrow();
    }
  });

  it("rejects JPEG dimension-only headers and invalid segment lengths", () => {
    const bytes = jpeg();
    const startScan = bytes.indexOf(Buffer.from([255, 218]));
    expect(() => decode(Buffer.concat([bytes.subarray(0, startScan), Buffer.from([255, 217])]))).toThrow();
    bytes.writeUInt16BE(1, 4);
    expect(() => decode(bytes)).toThrow();
  });

  it("rejects animated WebP, invalid lossless versions, and mismatched extended canvas sizes", () => {
    expect(() => decode(extendedWebp(WEBP, 2))).toThrow();
    const lossless = Buffer.from(WEBP_LOSSLESS);
    lossless[24] = lossless.readUInt8(24) | 0xe0;
    expect(() => decode(lossless)).toThrow();
    const mismatch = extendedWebp(WEBP);
    mismatch[24] = 1;
    expect(() => decode(mismatch)).toThrow();
  });

  it("rejects WebP bad frame signatures, RIFF sizes, and partition sizes", () => {
    for (const index of [4, 23, 22]) {
      const bytes = Buffer.from(WEBP);
      bytes[index] = bytes.readUInt8(index) ^ 0xff;
      expect(() => decode(bytes)).toThrow();
    }
  });
});

describe("native WRITE path equivalence", () => {
  // Decision classes from installed WRITE -> resolveToCwd -> normalizePath/resolvePath.
  // Capture operations for home paths so these cases never write outside the temp tree.
  const cases = [
    ["relative", "nested/image", "nested/image"],
    ["absolute", "/absolute/image", "/absolute/image"],
    ["dot segments", "./nested/../image", "image"],
    ["trailing separator", "image/", "image"],
    ["tilde alone", "~", () => homedir()],
    ["tilde slash", "~/image", () => join(homedir(), "image")],
    ["other user is literal", "~other/image", "~other/image"],
    ["at prefix", "@nested/image", "nested/image"],
    ["one at prefix only", "@@image", "@image"],
    ["at before tilde", "@~/image", () => join(homedir(), "image")],
    ["interior at", "nested/@image", "nested/@image"],
    ["space before at stays literal", "\u00a0@image", " @image"],
    ["interior tilde", "nested/~/image", "nested/~/image"],
    ["spaces are not trimmed", " image ", " image "],
    ["tabs and controls are not sanitized", "a\t\n\u001b\u202eb", "a\t\n\u001b\u202eb"],
    ["shell variables are literal", `$HOME/\${USER}/image`, `$HOME/\${USER}/image`],
    ["shell substitution is literal", "$(touch nope)/`pwd`", "$(touch nope)/`pwd`"],
    ["quotes and globs are literal", "'image'\"*?[]", "'image'\"*?[]"],
    ["Unicode normalization is not applied", "e\u0301.png", "e\u0301.png"],
    ["file without URL slashes is literal", "file:image", "file:image"],
    ...[0xa0, ...Array.from({ length: 11 }, (_, index) => 0x2000 + index), 0x202f, 0x205f, 0x3000].map(
      (code) => [`Unicode space ${code.toString(16)}`, `a${String.fromCharCode(code)}b`, "a b"] as const,
    ),
    ["non-normalized Unicode whitespace", "a\u1680\u200bb", "a\u1680\u200bb"],
  ] as const;

  it.each(cases)("matches %s", async (_name, path, expected) => {
    const target = typeof expected === "function" ? expected() : resolve(directory, expected);
    expect(await nativeDestination(directory, path)).toBe(target);
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    vi.spyOn(fs, "stat").mockResolvedValue(await realFs.stat(import.meta.filename));
    const access = vi.spyOn(fs, "access").mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    await preflightOutput(options(path));
    expect(access).toHaveBeenCalledWith(target, constants.W_OK);
    expect(await publishImage(decode(PNG), options(path))).toEqual({ path: target });
    expect(fs.writeFile).toHaveBeenCalledWith(target, PNG, { signal: undefined });
  });

  it.each(["file URL", "localhost file URL", "at file URL", "encoded Unicode space", "URL query and hash"])(
    "matches %s",
    async (kind) => {
      const url = pathToFileURL(join(directory, "URL image 日本語")).href;
      const path =
        kind === "localhost file URL"
          ? url.replace("file:///", "file://localhost/")
          : kind === "at file URL"
            ? `@${url}`
            : kind === "encoded Unicode space"
              ? pathToFileURL(join(directory, "a\u00a0b")).href
              : kind === "URL query and hash"
                ? `${url}?ignored#ignored`
                : url;
      const expected = join(directory, kind === "encoded Unicode space" ? "a\u00a0b" : "URL image 日本語");
      expect(await nativeDestination(directory, path)).toBe(expected);
      await preflightOutput(options(path));
      expect(await publishImage(decode(PNG), options(path))).toEqual({ path: expected });
      expect(await fs.readFile(expected)).toEqual(PNG);
    },
  );

  it.each(["file://remote/image", "file:///bad%2Fname", "file:///%zz"])(
    "preserves invalid URL failure %s",
    async (path) => {
      const failure = await nativeDestination(directory, path).catch((error: Error) => error);
      await expect(preflightOutput(options(path))).rejects.toMatchObject({
        name: (failure as Error).name,
        message: (failure as Error).message,
      });
      await expect(publishImage(decode(PNG), options(path))).rejects.toThrow();
      expect(await fs.readdir(directory)).toEqual([]);
    },
  );

  it.each(["bad\0path", "a".repeat(256)])("preserves native invalid filesystem path errors: %j", async (path) => {
    const failure = await nativeDestination(directory, path).catch((error: NodeJS.ErrnoException) => error);
    expect(failure).toBeInstanceOf(Error);
    const expected = { code: (failure as NodeJS.ErrnoException).code, name: (failure as Error).name };
    await expect(preflightOutput(options(path))).rejects.toMatchObject(expected);
    await expect(publishImage(decode(PNG), options(path))).rejects.toMatchObject(expected);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.each(["tilde", "file URL", "Unicode space"])("uses native %s cwd normalization", async (kind) => {
    const cwd =
      kind === "tilde" ? "~/cwd" : kind === "file URL" ? pathToFileURL(directory).href : `${directory}/a\u00a0b`;
    const expected = await nativeDestination(cwd, "image");
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    expect(await publishImage(decode(PNG), { cwd, path: "image" })).toEqual({ path: expected });
    expect(expected).toBe(
      kind === "tilde"
        ? join(homedir(), "cwd/image")
        : kind === "file URL"
          ? join(directory, "image")
          : `${directory}/a\u00a0b/image`,
    );
  });

  it.each([undefined, null, 42, ""])("requires an explicit nonempty path: %s", async (path) => {
    const invalid = { cwd: directory, path: path as string };
    await expect(preflightOutput(invalid)).rejects.toThrow(/required/);
    await expect(publishImage(decode(PNG), invalid)).rejects.toThrow(/required/);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.each([".", "..", "~", "@", "@~"])("treats %s as its native directory destination", async (path) => {
    await expect(preflightOutput(options(path))).rejects.toMatchObject({ code: "EISDIR" });
    await expect(publishImage(decode(PNG), options(path))).rejects.toMatchObject({ code: "EISDIR" });
  });
});

describe("native binary publication", () => {
  it.each([
    "suffixless",
    "image.jpg",
    "image.gif",
    "image.PNG",
    ".image",
    "日本語 🖼️",
    "image.",
    " image ",
    "a\n\u001bb",
  ])("writes the exact path without suffix checks: %j", async (path) => {
    const result = await publishImage(decode(PNG), options(`nested/${path}`));
    expect(result.path).toBe(join(directory, "nested", path));
    expect(await fs.readFile(result.path)).toEqual(PNG);
    expect(await fs.readdir(join(directory, "nested"))).toEqual([path]);
  });

  it.each([PNG, jpeg(), WEBP])("writes unchanged validated media bytes", async (bytes) => {
    const result = await publishImage(decode(bytes), options("exact.bin"));
    expect(await fs.readFile(result.path)).toEqual(bytes);
  });

  it("uses native creation modes and overwrites in place with the existing inode and mode", async () => {
    await nativeWrite("native-parent/native");
    const result = await publishImage(decode(PNG), options("binary-parent/binary"));
    expect((await fs.stat(join(directory, "binary-parent"))).mode & 0o777).toBe(
      (await fs.stat(join(directory, "native-parent"))).mode & 0o777,
    );
    expect((await fs.stat(result.path)).mode & 0o777).toBe(
      (await fs.stat(join(directory, "native-parent/native"))).mode & 0o777,
    );
    await fs.chmod(result.path, 0o640);
    const before = await fs.stat(result.path);
    await realFs.writeFile(result.path, Buffer.alloc(PNG.length * 3));
    await publishImage(decode(PNG), options("binary-parent/binary"));
    const after = await fs.stat(result.path);
    expect(after.ino).toBe(before.ino);
    expect(after.mode).toBe(before.mode);
    expect(after.size).toBe(PNG.length);
    expect(await fs.readFile(result.path)).toEqual(PNG);
  });

  it.each(["file", "directory", "dangling", "chain"])("follows %s symlinks without replacing them", async (kind) => {
    const target = join(directory, "target");
    const link = join(directory, "link");
    let path = "link";
    let actualTarget = target;
    if (kind === "directory") {
      await fs.mkdir(target);
      await fs.symlink("target", link, "dir");
      path = "link/nested/image";
      actualTarget = join(target, "nested/image");
    } else {
      if (kind === "file") await realFs.writeFile(target, "original bytes");
      if (kind === "chain") {
        await fs.symlink("target", join(directory, "second"));
        await fs.symlink("second", link);
      } else await fs.symlink("target", link);
    }
    await preflightOutput(options(path));
    expect(await fs.lstat(link)).toMatchObject({ size: (await fs.readlink(link)).length });
    await nativeWrite(path);
    const before = await fs.stat(actualTarget);
    const result = await publishImage(decode(PNG), options(path));
    expect(result.path).toBe(join(directory, path));
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect((await fs.stat(actualTarget)).ino).toBe(before.ino);
    expect(await fs.readFile(actualTarget)).toEqual(PNG);
  });

  it("does not normalize .. inside a dangling symlink target", async () => {
    await fs.mkdir(join(directory, "actual/deep"), { recursive: true });
    await fs.symlink("actual/deep", join(directory, "alias"), "dir");
    await fs.symlink("alias/../image", join(directory, "link"));
    const access = vi.spyOn(fs, "access");
    await preflightOutput(options("link"));
    expect(access).toHaveBeenCalledWith(`${directory}/alias/..`, constants.W_OK | constants.X_OK);
    expect(await publishImage(decode(PNG), options("link"))).toEqual({ path: join(directory, "link") });
    expect(await fs.readFile(join(directory, "actual/image"))).toEqual(PNG);
    await expect(fs.stat(join(directory, "image"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "directory target",
    "missing symlink parent",
    "directory symlink loop",
    "final symlink loop",
    "non-directory ancestor",
  ])("rejects native failure: %s", async (kind) => {
    let path = "link";
    if (kind === "directory target") {
      await fs.mkdir(join(directory, "target"));
      await fs.symlink("target", join(directory, "link"));
    } else if (kind === "missing symlink parent") {
      await fs.symlink("missing/target", join(directory, "link"));
    } else if (kind === "non-directory ancestor") {
      await realFs.writeFile(join(directory, "link"), "original");
      path = "link/image";
    } else {
      await fs.symlink("link", join(directory, "link"));
      if (kind === "directory symlink loop") path = "link/image";
    }
    const failure = await nativeWrite(path).catch((error: NodeJS.ErrnoException) => error);
    const code = (failure as NodeJS.ErrnoException).code;
    expect(code).toBeDefined();
    await expect(preflightOutput(options(path))).rejects.toMatchObject({ code });
    await expect(publishImage(decode(PNG), options(path))).rejects.toMatchObject({ code });
  });

  it.each([false, true].flatMap((chained) => (["relative", "absolute"] as const).map((kind) => ({ kind, chained }))))(
    "rejects missing directory symlinks: $kind, chained=$chained",
    async ({ kind, chained }) => {
      const target = kind === "absolute" ? `${join(directory, "missing")}/` : "missing/";
      const leaf = chained ? "next" : "link";
      await fs.symlink(target, join(directory, leaf));
      if (chained) await fs.symlink("next", join(directory, "link"));
      const failure = await nativeWrite("link").catch((error: NodeJS.ErrnoException) => error);
      expect(failure).toBeInstanceOf(Error);
      const code = (failure as NodeJS.ErrnoException).code;
      expect(code).toBeDefined();

      const writes = vi.mocked(fs.writeFile).mock.calls.length;
      const open = vi.spyOn(fs, "open");
      // Non-writing preflight classifies this target as directory-shaped. Native
      // write errors can differ by platform, so compare only publication with WRITE.
      await expect(preflightOutput(options("link"))).rejects.toMatchObject({ code: "EISDIR" });
      expect(fs.writeFile).toHaveBeenCalledTimes(writes);
      expect(open).not.toHaveBeenCalled();
      expect(await fs.readlink(join(directory, leaf))).toBe(target);
      await expect(fs.stat(join(directory, "missing"))).rejects.toMatchObject({ code: "ENOENT" });

      await expect(publishImage(decode(PNG), options("link"))).rejects.toMatchObject({ code });
      expect(await fs.readlink(join(directory, leaf))).toBe(target);
      if (chained) expect(await fs.readlink(join(directory, "link"))).toBe("next");
      await expect(fs.stat(join(directory, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["bad dimensions", "bad size", "bad metadata", "bad bytes"])(
    "validates %s before any destination I/O",
    async (kind) => {
      const image = decode(PNG);
      if (kind === "bad dimensions") image.width = 0;
      if (kind === "bad size") image.bytes = Buffer.alloc(0);
      if (kind === "bad metadata") image.mimeType = "image/jpeg";
      if (kind === "bad bytes") image.bytes = Buffer.from("invalid");
      const mkdir = vi.spyOn(fs, "mkdir");
      await expect(publishImage(image, options())).rejects.toThrow();
      expect(mkdir).not.toHaveBeenCalled();
      expect(fs.writeFile).not.toHaveBeenCalled();
      expect(await fs.readdir(directory)).toEqual([]);
    },
  );
});

describe("non-destructive preflight", () => {
  it.each(["new", "existing"])("creates parents without opening or truncating a %s target", async (kind) => {
    const path = "nested/output/image";
    if (kind === "existing") await nativeWrite(path);
    const open = vi.spyOn(fs, "open");
    await preflightOutput(options(path));
    expect(open).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(await fs.readdir(join(directory, "nested/output"))).toEqual(kind === "existing" ? ["image"] : []);
    if (kind === "existing") expect(await fs.readFile(join(directory, path), "utf8")).toBe("native text");
  });

  it("preserves an existing destination inode, mode, and bytes", async () => {
    await nativeWrite("image");
    const target = join(directory, "image");
    const before = await fs.stat(target);
    await preflightOutput(options("image"));
    const after = await fs.stat(target);
    expect(after.ino).toBe(before.ino);
    expect(after.mode).toBe(before.mode);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await fs.readFile(target, "utf8")).toBe("native text");
  });

  it.each(["stat", "lstat", "readlink", "access", "mkdir"])("preserves original %s I/O errors", async (operation) => {
    if (operation === "readlink") await fs.symlink("missing", join(directory, "image"));
    const failure = Object.assign(new Error("injected I/O failure"), { code: "EIO" });
    vi.spyOn(fs, operation as "access").mockRejectedValueOnce(failure);
    await expect(preflightOutput(options("image"))).rejects.toBe(failure);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("POSIX permission equivalence", () => {
  it.each([
    ["existing writable file, readonly parent", true, 0o600, 0o500, true],
    ["existing readonly file, writable parent", true, 0o400, 0o700, false],
    ["missing target, writable parent", false, 0o600, 0o700, true],
    ["missing target, readonly parent", false, 0o600, 0o500, false],
    ["existing file, unsearchable parent", true, 0o600, 0o600, false],
  ] as const)("matches %s", async (_name, exists, mode, parentMode, allowed) => {
    const parent = join(directory, "parent");
    const target = join(parent, "image");
    await fs.mkdir(parent);
    if (exists) {
      await realFs.writeFile(target, "original");
      await fs.chmod(target, mode);
    }
    await fs.chmod(parent, parentMode);
    try {
      if (allowed) {
        await preflightOutput(options("parent/image"));
        await nativeWrite("parent/image");
        await publishImage(decode(PNG), options("parent/image"));
        expect(await fs.readFile(target)).toEqual(PNG);
      } else {
        await expect(preflightOutput(options("parent/image"))).rejects.toMatchObject({ code: "EACCES" });
        await expect(nativeWrite("parent/image")).rejects.toMatchObject({ code: "EACCES" });
        await expect(publishImage(decode(PNG), options("parent/image"))).rejects.toMatchObject({ code: "EACCES" });
      }
    } finally {
      await fs.chmod(parent, 0o700);
    }
    if (!allowed && exists) expect(await fs.readFile(target, "utf8")).toBe("original");
  });

  it.each([
    "existing writable target",
    "existing readonly target",
    "dangling writable parent",
    "dangling readonly parent",
    "dangling missing parent",
  ])("checks the symlink target rather than its own parent: %s", async (kind) => {
    const parent = join(directory, "target-parent");
    const linkParent = join(directory, "link-parent");
    await fs.mkdir(parent);
    await fs.mkdir(linkParent);
    const target = join(parent, kind === "dangling missing parent" ? "missing/image" : "image");
    const existing = kind.startsWith("existing");
    if (existing) {
      await realFs.writeFile(target, "original");
      await fs.chmod(target, kind === "existing readonly target" ? 0o400 : 0o600);
    }
    await fs.symlink(target, join(linkParent, "link"));
    // A readonly link parent must not prevent writing through an existing symlink.
    await fs.chmod(linkParent, 0o500);
    if (kind === "dangling readonly parent") await fs.chmod(parent, 0o500);
    const path = "link-parent/link";
    try {
      if (kind === "existing writable target" || kind === "dangling writable parent") {
        await preflightOutput(options(path));
        await nativeWrite(path);
        await publishImage(decode(PNG), options(path));
        expect(await fs.readFile(target)).toEqual(PNG);
      } else {
        const code = kind === "dangling missing parent" ? "ENOENT" : "EACCES";
        await expect(preflightOutput(options(path))).rejects.toMatchObject({ code });
        await expect(nativeWrite(path)).rejects.toMatchObject({ code });
        await expect(publishImage(decode(PNG), options(path))).rejects.toMatchObject({ code });
      }
    } finally {
      await fs.chmod(linkParent, 0o700);
      await fs.chmod(parent, 0o700);
    }
  });
});

describe("queue, cancellation, and partial writes", () => {
  it("serializes concurrent same-path writes and keeps the queue usable after failure", async () => {
    const entered = deferred();
    const release = deferred();
    vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      await realFs.writeFile(...args);
      throw new Error("write failed");
    });
    const first = publishImage(decode(PNG), options());
    const failure = expect(first).rejects.toThrow("write failed");
    await entered.promise;
    const waiting = Array.from({ length: 8 }, () => publishImage(decode(PNG), options()));
    // Register behind these writes to prove their registration has reached Pi's queue.
    const barrier = withFileMutationQueue(join(directory, "different"), async () => {});
    await barrier;
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    release.resolve();
    await failure;
    await Promise.all(waiting);
    expect(fs.writeFile).toHaveBeenCalledTimes(9);
    expect(await fs.readFile(join(directory, "output/image"))).toEqual(PNG);
  });

  it.each(["preflight", "publish", "existing symlink"])("shares native WRITE's queue for %s", async (kind) => {
    const entered = deferred();
    const release = deferred();
    await nativeWrite("image");
    if (kind === "existing symlink") await fs.symlink("image", join(directory, "link"));
    const blocking = withFileMutationQueue(join(directory, "image"), async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let current = true;
    const target = { ...options(kind === "existing symlink" ? "link" : "image"), isCurrent: () => current };
    const mkdir = vi.spyOn(fs, "mkdir");
    const pending = kind === "preflight" ? preflightOutput(target) : publishImage(decode(PNG), target);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await withFileMutationQueue(join(directory, "different"), async () => {});
    expect(mkdir).not.toHaveBeenCalled();
    current = false;
    release.resolve();
    await blocking;
    await rejected;
    expect(await fs.readFile(join(directory, "image"), "utf8")).toBe("native text");
  });

  it.each(["cancel", "stale"])("rejects %s before any filesystem side effect", async (kind) => {
    const controller = new AbortController();
    if (kind === "cancel") controller.abort();
    const target = { ...options(), signal: controller.signal, isCurrent: () => kind !== "stale" };
    await expect(preflightOutput(target)).rejects.toMatchObject({ name: "AbortError" });
    await expect(publishImage(decode(PNG), target)).rejects.toMatchObject({ name: "AbortError" });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.each(
    ["mkdir", "stat", "lstat", "readlink", "access"].flatMap((phase) =>
      ["cancel", "stale"].map((kind) => [phase, kind] as const),
    ),
  )("rechecks ownership after preflight %s (%s)", async (phase, kind) => {
    const controller = new AbortController();
    let current = true;
    const target = options("link");
    if (phase === "readlink") await fs.symlink("missing", join(directory, "link"));
    const original = realFs[phase as "access"];
    vi.spyOn(fs, phase as "access").mockImplementationOnce(async (...args) => {
      try {
        return await original(...args);
      } finally {
        if (kind === "cancel") controller.abort();
        else current = false;
      }
    });
    await expect(
      preflightOutput({ ...target, signal: controller.signal, isCurrent: () => current }),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it.each(["cancel", "stale"])("rechecks %s after publication mkdir without opening target", async (kind) => {
    const controller = new AbortController();
    let current = true;
    vi.spyOn(fs, "mkdir").mockImplementationOnce(async (path, config) => {
      const result = await realFs.mkdir(path, config);
      if (kind === "cancel") controller.abort();
      else current = false;
      return result;
    });
    await expect(
      publishImage(decode(PNG), { ...options(), signal: controller.signal, isCurrent: () => current }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it.each(["new", "existing", "symlink"])(
    "retains partial %s output after I/O failure without rollback",
    async (kind) => {
      const path = join(directory, "image");
      const actual = kind === "symlink" ? join(directory, "target") : path;
      if (kind !== "new") await realFs.writeFile(actual, "old contents that cannot be restored");
      if (kind === "symlink") await fs.symlink("target", path);
      const unlink = vi.spyOn(fs, "unlink");
      const rename = vi.spyOn(fs, "rename");
      const failure = Object.assign(new Error("disk failure"), { code: "ENOSPC" });
      vi.mocked(fs.writeFile).mockImplementationOnce(async (destination) => {
        await realFs.writeFile(destination, PNG.subarray(0, 16));
        throw failure;
      });
      await expect(publishImage(decode(PNG), options("image"))).rejects.toBe(failure);
      expect(await fs.readFile(actual)).toEqual(PNG.subarray(0, 16));
      expect(unlink).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      if (kind === "symlink") expect((await fs.lstat(path)).isSymbolicLink()).toBe(true);
    },
  );

  it.each(["cancel", "stale"])("drains an in-flight write after %s before releasing the queue", async (kind) => {
    const entered = deferred();
    const release = deferred();
    const controller = new AbortController();
    let current = true;
    let settled = false;
    vi.mocked(fs.writeFile).mockImplementationOnce(async (destination, _bytes, config) => {
      expect(config).toEqual({ signal: controller.signal });
      await realFs.writeFile(destination, PNG.subarray(0, 16));
      entered.resolve();
      await release.promise;
    });
    const pending = publishImage(decode(PNG), {
      ...options("image"),
      signal: controller.signal,
      isCurrent: () => current,
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await entered.promise;
    if (kind === "cancel") controller.abort();
    else current = false;
    const waiting = preflightOutput(options("image"));
    await withFileMutationQueue(join(directory, "different"), async () => {});
    expect(settled).toBe(false);
    expect(await fs.readFile(join(directory, "image"))).toEqual(PNG.subarray(0, 16));
    release.resolve();
    await rejected;
    await waiting;
    expect(await fs.readFile(join(directory, "image"))).toEqual(PNG.subarray(0, 16));
    await publishImage(decode(PNG), options("image"));
    expect(await fs.readFile(join(directory, "image"))).toEqual(PNG);
  });

  it("rejects late cancellation but does not remove completed bytes", async () => {
    const controller = new AbortController();
    vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => {
      await realFs.writeFile(...args);
      controller.abort();
    });
    await expect(publishImage(decode(PNG), { ...options("image"), signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(await fs.readFile(join(directory, "image"))).toEqual(PNG);
  });
});
