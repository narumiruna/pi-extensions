import type { ImageContent } from "@earendil-works/pi-ai";
import sharp, { type Metadata, type Sharp } from "sharp";

export const DEFAULT_IMAGE_LIMITS = {
	maxImages: 8,
	maxImageBytes: 10 * 1024 * 1024,
	maxPromptBytes: 40 * 1024 * 1024,
	maxPixels: 50_000_000,
	maxDimension: 2_000,
	maxBase64Bytes: 4_500_000,
} as const;

export interface BrowserImageInput {
	name?: string;
	mimeType?: string;
	data: string;
}

export interface ProcessBrowserImageOptions {
	maxImages?: number;
	maxImageBytes?: number;
	maxPromptBytes?: number;
	maxPixels?: number;
	maxDimension?: number;
	maxBase64Bytes?: number;
	autoResize?: boolean;
	blockImages?: boolean;
	supportsImages?: boolean;
	signal?: AbortSignal;
}

type SupportedFormat = "png" | "jpeg" | "webp" | "gif";

export async function processBrowserImages(
	inputs: BrowserImageInput[],
	options: ProcessBrowserImageOptions = {},
): Promise<ImageContent[]> {
	const limits = { ...DEFAULT_IMAGE_LIMITS, ...definedLimits(options) };
	if (options.blockImages) throw new Error("Pi image sending is disabled.");
	if (options.supportsImages === false)
		throw new Error("The current model does not support images.");
	if (inputs.length > limits.maxImages)
		throw new Error(`Too many images; maximum is ${limits.maxImages}.`);
	assertNotAborted(options.signal);

	const decoded = inputs.map((input, index) => decodeInput(input, index, limits.maxImageBytes));
	const totalSourceBytes = decoded.reduce((total, item) => total + item.bytes.byteLength, 0);
	if (totalSourceBytes > limits.maxPromptBytes) {
		throw new Error("Combined image input is too large.");
	}

	const output: ImageContent[] = [];
	let totalOutputBytes = 0;
	for (const item of decoded) {
		assertNotAborted(options.signal);
		const processed = await processOne(
			item.bytes,
			item.format,
			limits,
			options.autoResize !== false,
			options.signal,
		);
		totalOutputBytes += processed.byteLength;
		if (totalOutputBytes > limits.maxPromptBytes)
			throw new Error("Combined processed images are too large.");
		const data = processed.toString("base64");
		if (data.length > limits.maxBase64Bytes)
			throw new Error("Processed image exceeds Pi's inline limit.");
		output.push({ type: "image", data, mimeType: mimeFor(item.format) });
	}
	return output;
}

function definedLimits(options: ProcessBrowserImageOptions): Partial<typeof DEFAULT_IMAGE_LIMITS> {
	const result: Record<string, number> = {};
	for (const key of [
		"maxImages",
		"maxImageBytes",
		"maxPromptBytes",
		"maxPixels",
		"maxDimension",
		"maxBase64Bytes",
	] as const) {
		const value = options[key];
		if (value === undefined) continue;
		if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid image limit: ${key}`);
		result[key] = value;
	}
	return result;
}

function decodeInput(
	input: BrowserImageInput,
	index: number,
	maxImageBytes: number,
): { bytes: Buffer; format: SupportedFormat } {
	if (!input || typeof input.data !== "string")
		throw new Error(`Image ${index + 1} has invalid data.`);
	if (!input.data) throw new Error(`Image ${index + 1} is empty.`);
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) {
		throw new Error(`Image ${index + 1} has invalid Base64 data.`);
	}
	const estimatedBytes = Math.floor((input.data.length * 3) / 4);
	if (estimatedBytes > maxImageBytes) throw new Error(`Image ${index + 1} is too large.`);
	const bytes = Buffer.from(input.data, "base64");
	if (bytes.byteLength === 0) throw new Error(`Image ${index + 1} is empty.`);
	if (bytes.byteLength > maxImageBytes) throw new Error(`Image ${index + 1} is too large.`);
	const format = detectFormat(bytes);
	if (!format) throw new Error(`Image ${index + 1} uses an unsupported format.`);
	return { bytes, format };
}

async function processOne(
	bytes: Buffer,
	format: SupportedFormat,
	limits: typeof DEFAULT_IMAGE_LIMITS,
	autoResize: boolean,
	signal?: AbortSignal,
): Promise<Buffer> {
	assertNotAborted(signal);
	const metadata = await sharp(bytes, {
		animated: format === "gif",
		limitInputPixels: limits.maxPixels,
	}).metadata();
	assertNotAborted(signal);
	validateMetadata(metadata, limits.maxPixels);
	const width = metadata.width as number;
	const height = metadata.height as number;
	const oversized = width > limits.maxDimension || height > limits.maxDimension;
	if (oversized && !autoResize) throw new Error("Image dimensions exceed Pi's limit.");

	let targetWidth = oversized ? Math.min(width, limits.maxDimension) : width;
	let targetHeight = oversized ? Math.min(height, limits.maxDimension) : height;
	const ratio = Math.min(targetWidth / width, targetHeight / height, 1);
	targetWidth = Math.max(1, Math.round(width * ratio));
	targetHeight = Math.max(1, Math.round(height * ratio));

	for (let attempt = 0; attempt < 6; attempt += 1) {
		assertNotAborted(signal);
		let pipeline = sharp(bytes, { animated: format === "gif", limitInputPixels: limits.maxPixels });
		if (targetWidth !== width || targetHeight !== height) {
			pipeline = pipeline.resize({
				width: targetWidth,
				height: targetHeight,
				fit: "inside",
				withoutEnlargement: true,
			});
		}
		pipeline = encode(pipeline, format);
		const output = await pipeline.toBuffer();
		assertNotAborted(signal);
		if (output.toString("base64").length <= limits.maxBase64Bytes) return output;
		if (!autoResize) throw new Error("Processed image exceeds Pi's inline limit.");
		targetWidth = Math.max(1, Math.floor(targetWidth * 0.75));
		targetHeight = Math.max(1, Math.floor(targetHeight * 0.75));
	}
	throw new Error("Processed image exceeds Pi's inline limit after resizing.");
}

function validateMetadata(metadata: Metadata, maxPixels: number): void {
	if (!metadata.width || !metadata.height)
		throw new Error("Image dimensions could not be decoded.");
	const pages = metadata.pages ?? 1;
	if (metadata.width * metadata.height * pages > maxPixels)
		throw new Error("Image pixel count exceeds the limit.");
}

function encode(image: Sharp, format: SupportedFormat): Sharp {
	switch (format) {
		case "png":
			return image.png();
		case "jpeg":
			return image.jpeg({ quality: 88, mozjpeg: true });
		case "webp":
			return image.webp({ quality: 88 });
		case "gif":
			return image.gif();
	}
}

function detectFormat(bytes: Uint8Array): SupportedFormat | undefined {
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	)
		return "png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
		return "jpeg";
	if (
		bytes.length >= 12 &&
		Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
		Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
	)
		return "webp";
	if (bytes.length >= 6 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "GIF8")
		return "gif";
	return undefined;
}

function mimeFor(format: SupportedFormat): string {
	return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}

function assertNotAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Image processing aborted.");
}
