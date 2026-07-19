import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { DEFAULT_IMAGE_LIMITS, processBrowserImages } from "../src/images.js";

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

test("image defaults stay bounded", () => {
	assert.deepEqual(DEFAULT_IMAGE_LIMITS, {
		maxImages: 8,
		maxImageBytes: 10 * 1024 * 1024,
		maxPromptBytes: 40 * 1024 * 1024,
		maxPixels: 50_000_000,
		maxDimension: 2_000,
		maxBase64Bytes: 4_500_000,
	});
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
