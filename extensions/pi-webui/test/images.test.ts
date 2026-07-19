import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
	DEFAULT_IMAGE_LIMITS,
	detectImageFormat,
	ImageProcessor,
	PROVIDER_IMAGE_LIMITS,
	processBrowserImages,
} from "../src/images.js";

const FIXTURE_DIR = path.join(process.cwd(), "extensions/pi-webui/test/fixtures");

async function png(width = 2, height = 2, withMetadata = false): Promise<Buffer> {
	let image = sharp({
		create: { width, height, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
	}).png();
	if (withMetadata) image = image.withMetadata({ exif: { IFD0: { Artist: "secret" } } });
	return image.toBuffer();
}

function input(bytes: Buffer, mimeType = "image/png") {
	return { name: "pasted.png", mimeType, data: bytes.toString("base64") };
}

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

async function animatedGif(width: number, pageHeight: number, pages: number): Promise<Buffer> {
	const framePixels = width * pageHeight;
	const pixels = Buffer.alloc(framePixels * pages * 4);
	for (let page = 0; page < pages; page += 1) {
		for (let index = 0; index < framePixels; index += 1) {
			pixels.set([page * 20, 255 - page * 20, 0, 255], (page * framePixels + index) * 4);
		}
	}
	return sharp(pixels, {
		raw: { width, height: pageHeight * pages, channels: 4, pageHeight },
	})
		.gif({ delay: Array.from({ length: pages }, () => 20) })
		.toBuffer();
}

test("image defaults stay bounded", () => {
	assert.deepEqual(DEFAULT_IMAGE_LIMITS, {
		maxImages: 8,
		maxImageBytes: 10 * 1024 * 1024,
		maxBatchBytes: 40 * 1024 * 1024,
		maxImagePixels: 50_000_000,
	});
	assert.deepEqual(PROVIDER_IMAGE_LIMITS, {
		maxDimension: 2_000,
		maxBase64Bytes: 4_500_000,
	});
});

test("magic-byte detection accepts every supported WebUI raster format", async () => {
	assert.equal(detectImageFormat(await solid("png")), "png");
	assert.equal(detectImageFormat(await solid("jpeg")), "jpeg");
	assert.equal(detectImageFormat(await solid("webp")), "webp");
	assert.equal(detectImageFormat(await animatedGif(2, 1, 2)), "gif");
	assert.equal(detectImageFormat(tinyBmp()), "bmp");
	assert.equal(detectImageFormat(await solid("tiff")), "tiff");
	assert.equal(detectImageFormat(await solid("avif")), "avif");
	assert.equal(
		detectImageFormat(await readFile(path.join(FIXTURE_DIR, "colors-no-alpha.heic"))),
		"heic",
	);
	assert.equal(detectImageFormat(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>>")), null);
});

test("advanced formats normalize to provider-ready PNG", async () => {
	const sources: Array<[string, Buffer]> = [
		["bmp", tinyBmp()],
		["tiff", await solid("tiff")],
		["avif", await solid("avif")],
		["heic", await readFile(path.join(FIXTURE_DIR, "colors-no-alpha.heic"))],
	];
	for (const [format, source] of sources) {
		const [result] = await processBrowserImages([input(source)]);
		assert.equal(result?.mimeType, "image/png", format);
		assert.equal((await sharp(Buffer.from(result?.data ?? "", "base64")).metadata()).format, "png");
	}
});

test("image processing preserves ICC profiles while stripping private metadata", async () => {
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
	const [result] = await processBrowserImages([input(source)]);
	const metadata = await sharp(Buffer.from(result?.data ?? "", "base64")).metadata();
	assert.equal(metadata.width, 2);
	assert.equal(metadata.height, 3);
	assert.equal(metadata.exif, undefined);
	assert.equal(metadata.xmp, undefined);
	assert.ok(metadata.icc && metadata.icc.byteLength > 0);
});

test("ImageProcessor bounds concurrent image work while preserving result order", async () => {
	let active = 0;
	let peak = 0;
	const releases: Array<() => void> = [];
	const processor = new ImageProcessor(2, async (source) => {
		active += 1;
		peak = Math.max(peak, active);
		await new Promise<void>((resolve) => releases.push(resolve));
		active -= 1;
		return { type: "image" as const, mimeType: "image/png", data: source.toString() };
	});
	const pending = ["one", "two", "three"].map((value) =>
		processor.process(Buffer.from(value), { autoResize: true, maxPixels: 100 }),
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(releases.length, 2);
	releases.shift()?.();
	await new Promise((resolve) => setImmediate(resolve));
	while (releases.length > 0) releases.shift()?.();
	assert.deepEqual(
		(await Promise.all(pending)).map((result) => result.data),
		["one", "two", "three"],
	);
	assert.equal(peak, 2);
});

test("PNG input is signature checked, sanitized, and converted to Pi content", async () => {
	const source = await png(2, 2, true);
	const [result] = await processBrowserImages([input(source, "image/jpeg")]);
	assert.equal(result?.type, "image");
	assert.equal(result?.mimeType, "image/png");
	assert.ok(result?.data.length);
	const metadata = await sharp(Buffer.from(result?.data ?? "", "base64")).metadata();
	assert.equal(metadata.exif, undefined);
	assert.equal(metadata.width, 2);
});

test("JPEG orientation is applied before private metadata is stripped", async () => {
	const source = await sharp({
		create: { width: 3, height: 2, channels: 3, background: { r: 10, g: 20, b: 30 } },
	})
		.jpeg()
		.withMetadata({ orientation: 6, exif: { IFD0: { Artist: "secret" } } })
		.toBuffer();
	const [result] = await processBrowserImages([input(source, "image/jpeg")]);
	const metadata = await sharp(Buffer.from(result?.data ?? "", "base64")).metadata();
	assert.equal(metadata.width, 2);
	assert.equal(metadata.height, 3);
	assert.equal(metadata.orientation, undefined);
	assert.equal(metadata.exif, undefined);
});

test("animated GIF limits and resizing use per-frame geometry", async () => {
	const source = await animatedGif(100, 100, 10);
	const [result] = await processBrowserImages([input(source, "image/gif")], {
		maxPixels: 150_000,
		maxDimension: 100,
	});
	const metadata = await sharp(Buffer.from(result?.data ?? "", "base64"), {
		animated: true,
	}).metadata();
	assert.equal(metadata.width, 100);
	assert.equal(metadata.pageHeight, 100);
	assert.equal(metadata.height, 1_000);
	assert.equal(metadata.pages, 10);
});

test("JPEG, WebP, and GIF signatures produce matching provider MIME types", async () => {
	const base = sharp({
		create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } },
	});
	for (const [format, bytes, mimeType] of [
		["jpeg", await base.clone().jpeg().toBuffer(), "image/jpeg"],
		["webp", await base.clone().webp().toBuffer(), "image/webp"],
		["gif", await base.clone().gif().toBuffer(), "image/gif"],
	] as const) {
		const [result] = await processBrowserImages([input(bytes)]);
		assert.equal(result?.mimeType, mimeType, format);
	}
});

test("image processing rejects malformed, unsupported, excessive, and blocked input", async () => {
	await assert.rejects(
		() => processBrowserImages([{ ...input(Buffer.from("not-image")) }]),
		/format/i,
	);
	await assert.rejects(
		() => processBrowserImages([{ ...input(Buffer.from([0x3c, 0x73, 0x76, 0x67])) }]),
		/format/i,
	);
	await assert.rejects(
		() => processBrowserImages([input(Buffer.from("large"))], { maxImageBytes: 2 }),
		/too large/i,
	);
	await assert.rejects(() => processBrowserImages([input(Buffer.alloc(0))]), /empty/i);
	await assert.rejects(
		async () => processBrowserImages([input(await png(3, 3))], { maxPixels: 4 }),
		/pixel|limit/i,
	);
	await assert.rejects(
		() => processBrowserImages([input(Buffer.from("bad"))], { blockImages: true }),
		/disabled/i,
	);
	await assert.rejects(
		() => processBrowserImages([input(Buffer.from("bad"))], { supportsImages: false }),
		/does not support/i,
	);
});

test("large dimensions resize when enabled and fail when disabled", async () => {
	const source = await png(20, 10);
	const [resized] = await processBrowserImages([input(source)], { maxDimension: 8 });
	const metadata = await sharp(Buffer.from(resized?.data ?? "", "base64")).metadata();
	assert.equal(metadata.width, 8);
	assert.equal(metadata.height, 4);
	await assert.rejects(
		() => processBrowserImages([input(source)], { maxDimension: 8, autoResize: false }),
		/exceed/i,
	);
});

test("aggregate count and bytes plus cancellation are enforced", async () => {
	const source = await png();
	await assert.rejects(
		() => processBrowserImages([input(source), input(source)], { maxImages: 1 }),
		/too many/i,
	);
	await assert.rejects(
		() => processBrowserImages([input(source), input(source)], { maxPromptBytes: source.length }),
		/combined/i,
	);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		() => processBrowserImages([input(source)], { signal: controller.signal }),
		/aborted/i,
	);
});
