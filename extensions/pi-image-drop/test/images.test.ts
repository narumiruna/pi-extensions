import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
	detectImageFormat,
	ImageProcessor,
	MAX_BASE64_BYTES,
	processImage,
	UnsupportedImageError,
} from "../src/images.js";

const FIXTURE_DIR = path.join(process.cwd(), "extensions/pi-image-drop/test/fixtures");

async function solid(format: "png" | "jpeg" | "webp" | "tiff" | "avif") {
	let pipeline = sharp({
		create: { width: 12, height: 8, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } },
	});
	if (format === "png") pipeline = pipeline.png();
	if (format === "jpeg") pipeline = pipeline.jpeg();
	if (format === "webp") pipeline = pipeline.webp();
	if (format === "tiff") pipeline = pipeline.tiff();
	if (format === "avif") pipeline = pipeline.avif();
	return pipeline.toBuffer();
}

function tinyBmp(): Buffer {
	const width = 2;
	const height = 1;
	const rowBytes = 8;
	const buffer = Buffer.alloc(54 + rowBytes);
	buffer.write("BM", 0, "ascii");
	buffer.writeUInt32LE(buffer.length, 2);
	buffer.writeUInt32LE(54, 10);
	buffer.writeUInt32LE(40, 14);
	buffer.writeInt32LE(width, 18);
	buffer.writeInt32LE(height, 22);
	buffer.writeUInt16LE(1, 26);
	buffer.writeUInt16LE(24, 28);
	buffer.writeUInt32LE(rowBytes, 34);
	buffer.set([0, 0, 255, 0, 255, 0, 0, 0], 54);
	return buffer;
}

async function animatedGif(): Promise<Buffer> {
	const pixels = Buffer.from([255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255]);
	return sharp(pixels, {
		raw: { width: 2, height: 2, channels: 4, pageHeight: 1 },
	})
		.gif({ delay: [100, 200], loop: 0 })
		.toBuffer();
}

test("magic-byte detection accepts only the agreed raster formats", async () => {
	assert.equal(detectImageFormat(await solid("png")), "png");
	assert.equal(detectImageFormat(await solid("jpeg")), "jpeg");
	assert.equal(detectImageFormat(await solid("webp")), "webp");
	assert.equal(detectImageFormat(await animatedGif()), "gif");
	assert.equal(detectImageFormat(tinyBmp()), "bmp");
	assert.equal(detectImageFormat(await solid("tiff")), "tiff");
	assert.equal(detectImageFormat(await solid("avif")), "avif");
	assert.equal(
		detectImageFormat(await readFile(path.join(FIXTURE_DIR, "colors-no-alpha.heic"))),
		"heic",
	);
	assert.equal(detectImageFormat(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
	assert.equal(detectImageFormat(Buffer.from("<!doctype html><html></html>")), null);
});

test("processing sanitizes metadata, applies orientation, and preserves an ICC profile", async () => {
	const source = await sharp({
		create: { width: 3, height: 2, channels: 3, background: "#c08040" },
	})
		.jpeg()
		.withIccProfile("srgb")
		.withMetadata({ orientation: 6 })
		.withExifMerge({
			IFD0: { ImageDescription: "private note" },
			IFD3: { GPSLatitude: "1/1 2/1 3/1" },
		})
		.toBuffer();
	const result = await processImage(source, { autoResize: true, maxImagePixels: 1_000_000 });
	const repeated = await processImage(source, { autoResize: true, maxImagePixels: 1_000_000 });
	const metadata = await sharp(result.bytes).metadata();
	assert.equal(result.sourceFormat, "jpeg");
	assert.equal(result.outputFormat, "jpeg");
	assert.equal(result.originalWidth, 2);
	assert.equal(result.originalHeight, 3);
	assert.equal(metadata.width, 2);
	assert.equal(metadata.height, 3);
	assert.equal(metadata.orientation, undefined);
	assert.equal(metadata.exif, undefined);
	assert.equal(metadata.xmp, undefined);
	assert.ok(metadata.icc && metadata.icc.byteLength > 0);
	assert.equal(result.hash, repeated.hash);
	assert.deepEqual(result.bytes, repeated.bytes);
});

test("advanced formats normalize to provider-ready PNG", async () => {
	const sources: Array<[string, Buffer]> = [
		["bmp", tinyBmp()],
		["tiff", await solid("tiff")],
		["avif", await solid("avif")],
		["heic", await readFile(path.join(FIXTURE_DIR, "colors-no-alpha.heic"))],
	];
	for (const [format, source] of sources) {
		const result = await processImage(source, { autoResize: true, maxImagePixels: 1_000_000 });
		assert.equal(result.sourceFormat, format);
		assert.equal(result.outputFormat, "png");
		assert.equal(result.mimeType, "image/png");
		assert.equal((await sharp(result.bytes).metadata()).format, "png");
	}
});

test("animated GIF remains animated after sanitization", async () => {
	const result = await processImage(await animatedGif(), {
		autoResize: true,
		maxImagePixels: 1_000_000,
	});
	const metadata = await sharp(result.bytes, { animated: true }).metadata();
	assert.equal(result.outputFormat, "gif");
	assert.equal(metadata.pages, 2);
	assert.deepEqual(metadata.delay, [100, 200]);
});

test("auto-resize enforces dimensions and Base64 payload while no-resize rejects unsafe output", async () => {
	const noise = Buffer.alloc(2100 * 4 * 3);
	for (let index = 0; index < noise.length; index += 1) noise[index] = index % 251;
	const wide = await sharp(noise, { raw: { width: 2100, height: 4, channels: 3 } })
		.png()
		.toBuffer();
	const resized = await processImage(wide, { autoResize: true, maxImagePixels: 1_000_000 });
	assert.equal(resized.width, 2000);
	assert.ok(Buffer.byteLength(resized.bytes.toString("base64")) < MAX_BASE64_BYTES);
	assert.equal(resized.resized, true);

	await assert.rejects(
		processImage(wide, { autoResize: false, maxImagePixels: 1_000_000 }),
		/inline image limits/i,
	);
});

test("ImageProcessor bounds concurrent native work and preserves result order", async () => {
	let active = 0;
	let peak = 0;
	const releases: Array<() => void> = [];
	const processor = new ImageProcessor(2, async (source) => {
		active += 1;
		peak = Math.max(peak, active);
		await new Promise<void>((resolve) => releases.push(resolve));
		active -= 1;
		return { ...({} as Awaited<ReturnType<typeof processImage>>), sourceFormat: source.toString() };
	});
	const pending = ["one", "two", "three"].map((value) =>
		processor.process(Buffer.from(value), { autoResize: true, maxImagePixels: 100 }),
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(releases.length, 2);
	releases.shift()?.();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(releases.length, 2);
	while (releases.length > 0) releases.shift()?.();
	assert.deepEqual(
		(await Promise.all(pending)).map((result) => result.sourceFormat),
		["one", "two", "three"],
	);
	assert.equal(peak, 2);
});

test("processing rejects unsupported, corrupt, over-pixel, and aborted inputs", async () => {
	await assert.rejects(
		processImage(Buffer.from("not an image"), { autoResize: true, maxImagePixels: 100 }),
		UnsupportedImageError,
	);
	const png = await solid("png");
	await assert.rejects(
		processImage(png.subarray(0, 12), { autoResize: true, maxImagePixels: 100 }),
		/decode|corrupt|invalid/i,
	);
	await assert.rejects(processImage(png, { autoResize: true, maxImagePixels: 10 }), /pixel/i);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		processImage(png, { autoResize: true, maxImagePixels: 100, signal: controller.signal }),
		/aborted/i,
	);
});
