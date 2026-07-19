import { decode as decodeBmp } from "bmp-js";
import decodeHeic from "heic-decode";
import sharp, { type OutputInfo, type Sharp, type SharpOptions } from "sharp";

export type SupportedImageFormat =
	| "png"
	| "jpeg"
	| "webp"
	| "gif"
	| "bmp"
	| "tiff"
	| "heic"
	| "avif";

export interface ProcessImageOptions {
	autoResize: boolean;
	maxPixels: number;
	maxDimension: number;
	maxBase64Bytes: number;
	signal?: AbortSignal;
}

export interface ProcessedBrowserImage {
	bytes: Buffer;
	mimeType: string;
	width: number;
	height: number;
	originalWidth: number;
	originalHeight: number;
	sourceFormat: SupportedImageFormat;
	outputFormat: "png" | "jpeg" | "webp" | "gif";
	resized: boolean;
}

export class UnsupportedImageError extends Error {}
export class ImageLimitError extends Error {}

interface InputDescriptor {
	input: Buffer;
	options: SharpOptions;
	format: SupportedImageFormat;
	animated: boolean;
}

interface Dimensions {
	width: number;
	height: number;
	pages: number;
}

export function detectImageFormat(bytes: Uint8Array): SupportedImageFormat | null {
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
	if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "gif";
	if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "webp";
	if (ascii(bytes, 0, 2) === "BM") return "bmp";
	if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
		return "tiff";
	}
	if (ascii(bytes, 4, 8) === "ftyp") {
		const brands = ascii(bytes, 8, Math.min(bytes.length, 64));
		if (brands.includes("avif") || brands.includes("avis")) return "avif";
		if (
			brands.includes("heic") ||
			brands.includes("heix") ||
			brands.includes("hevc") ||
			brands.includes("hevx") ||
			brands.startsWith("mif1") ||
			brands.startsWith("msf1")
		) {
			return "heic";
		}
	}
	return null;
}

export async function processImage(
	source: Uint8Array,
	options: ProcessImageOptions,
): Promise<ProcessedBrowserImage> {
	throwIfAborted(options.signal);
	const bytes = Buffer.from(source);
	const format = detectImageFormat(bytes);
	if (!format) throw new UnsupportedImageError("Unsupported image format");
	const descriptor = await describeInput(bytes, format, options.maxPixels, options.signal);
	const original = await dimensions(descriptor, options.maxPixels);
	throwIfAborted(options.signal);

	if (
		!options.autoResize &&
		(original.width > options.maxDimension || original.height > options.maxDimension)
	) {
		throw new ImageLimitError("Image dimensions exceed Pi's limit while auto-resize is disabled");
	}

	let target = options.autoResize ? fitWithin(original, options.maxDimension) : original;
	let quality = 95;
	while (true) {
		throwIfAborted(options.signal);
		const encoded = await encode(descriptor, target, quality);
		throwIfAborted(options.signal);
		const base64Bytes = Buffer.byteLength(encoded.data.toString("base64"));
		if (base64Bytes <= options.maxBase64Bytes) {
			const width = encoded.info.width;
			const height = encoded.info.pageHeight ?? encoded.info.height;
			const outputFormat = normalizeOutputFormat(encoded.info.format);
			return {
				bytes: encoded.data,
				mimeType: mimeType(outputFormat),
				width,
				height,
				originalWidth: original.width,
				originalHeight: original.height,
				sourceFormat: format,
				outputFormat,
				resized: width !== original.width || height !== original.height,
			};
		}
		if (!options.autoResize) {
			throw new ImageLimitError("Processed image exceeds Pi's inline limit");
		}
		if ((format === "jpeg" || format === "webp") && quality > 40) {
			quality = nextQuality(quality);
			continue;
		}
		quality = 95;
		if (target.width === 1 && target.height === 1) {
			throw new ImageLimitError("Image could not be reduced below Pi's inline limit");
		}
		target = {
			...target,
			width: target.width === 1 ? 1 : Math.max(1, Math.floor(target.width * 0.8)),
			height: target.height === 1 ? 1 : Math.max(1, Math.floor(target.height * 0.8)),
		};
	}
}

async function describeInput(
	bytes: Buffer,
	format: SupportedImageFormat,
	maxPixels: number,
	signal?: AbortSignal,
): Promise<InputDescriptor> {
	if (format === "bmp") return describeBmp(bytes, maxPixels);
	if (format !== "heic") {
		return {
			input: bytes,
			options: {
				animated: format === "gif",
				failOn: "warning",
				limitInputPixels: maxPixels,
				sequentialRead: true,
			},
			format,
			animated: format === "gif",
		};
	}

	throwIfAborted(signal);
	let deferred: Awaited<ReturnType<typeof decodeHeic.all>> | undefined;
	try {
		deferred = await decodeHeic.all({ buffer: bytes });
		const first = deferred[0];
		if (!first) throw new UnsupportedImageError("HEIC image has no frames");
		assertPixelLimit(first.width, first.height, maxPixels);
		const decoded = await first.decode();
		throwIfAborted(signal);
		return {
			input: Buffer.from(decoded.data),
			options: {
				raw: { width: decoded.width, height: decoded.height, channels: 4 },
				limitInputPixels: maxPixels,
			},
			format,
			animated: false,
		};
	} catch (error) {
		if (error instanceof ImageLimitError || isAbortError(error)) throw error;
		throw new UnsupportedImageError(`HEIC decode failed: ${formatError(error)}`);
	} finally {
		deferred?.dispose();
	}
}

function describeBmp(bytes: Buffer, maxPixels: number): InputDescriptor {
	if (bytes.byteLength < 54 || bytes.readUInt32LE(14) < 40) {
		throw new UnsupportedImageError("BMP header is unsupported");
	}
	const width = bytes.readInt32LE(18);
	const height = Math.abs(bytes.readInt32LE(22));
	assertPixelLimit(width, height, maxPixels);
	let decoded: ReturnType<typeof decodeBmp>;
	try {
		decoded = decodeBmp(bytes, true);
	} catch (error) {
		throw new UnsupportedImageError(`BMP decode failed: ${formatError(error)}`);
	}
	const rgba = Buffer.allocUnsafe(decoded.width * decoded.height * 4);
	const bitDepth = bytes.readUInt16LE(28);
	for (let offset = 0; offset < rgba.length; offset += 4) {
		rgba[offset] = decoded.data[offset + 3] ?? 0;
		rgba[offset + 1] = decoded.data[offset + 2] ?? 0;
		rgba[offset + 2] = decoded.data[offset + 1] ?? 0;
		rgba[offset + 3] = bitDepth === 32 ? (decoded.data[offset] ?? 255) : 255;
	}
	return {
		input: rgba,
		options: {
			raw: { width: decoded.width, height: decoded.height, channels: 4 },
			limitInputPixels: maxPixels,
		},
		format: "bmp",
		animated: false,
	};
}

async function dimensions(descriptor: InputDescriptor, maxPixels: number): Promise<Dimensions> {
	try {
		const metadata = await sharp(descriptor.input, descriptor.options).metadata();
		const width = metadata.autoOrient.width ?? metadata.width;
		const totalHeight = metadata.autoOrient.height ?? metadata.height;
		if (!width || !totalHeight) throw new Error("Image dimensions are missing");
		const pages = metadata.pages ?? 1;
		const height = metadata.pageHeight ?? Math.floor(totalHeight / pages);
		assertPixelLimit(width, height * pages, maxPixels);
		return { width, height, pages };
	} catch (error) {
		if (error instanceof ImageLimitError) throw error;
		throw new Error(`Image decode failed: ${formatError(error)}`);
	}
}

async function encode(
	descriptor: InputDescriptor,
	target: Dimensions,
	quality: number,
): Promise<{ data: Buffer; info: OutputInfo }> {
	let pipeline: Sharp = sharp(descriptor.input, descriptor.options).autoOrient().keepIccProfile();
	pipeline = pipeline.resize(target.width, target.height, {
		fit: "inside",
		withoutEnlargement: true,
		kernel: sharp.kernel.lanczos3,
	});
	switch (descriptor.format) {
		case "jpeg":
			pipeline = pipeline.jpeg({ quality, chromaSubsampling: "4:4:4", mozjpeg: true });
			break;
		case "webp":
			pipeline = pipeline.webp(
				quality === 95 ? { lossless: true, effort: 5 } : { quality, alphaQuality: 100, effort: 5 },
			);
			break;
		case "gif":
			pipeline = pipeline.gif({ reuse: true, effort: 7 });
			break;
		case "png":
			pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
			break;
		default:
			pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
	}
	return pipeline.toBuffer({ resolveWithObject: true });
}

function fitWithin(dimensions: Dimensions, max: number): Dimensions {
	const ratio = Math.min(1, max / dimensions.width, max / dimensions.height);
	return {
		...dimensions,
		width: Math.max(1, Math.round(dimensions.width * ratio)),
		height: Math.max(1, Math.round(dimensions.height * ratio)),
	};
}

function nextQuality(quality: number): number {
	if (quality > 85) return 85;
	if (quality > 70) return 70;
	if (quality > 55) return 55;
	return 40;
}

function normalizeOutputFormat(format: string): "png" | "jpeg" | "webp" | "gif" {
	if (format === "jpg") return "jpeg";
	if (format === "png" || format === "jpeg" || format === "webp" || format === "gif") {
		return format;
	}
	throw new UnsupportedImageError(`Unsupported output format: ${format}`);
}

function mimeType(format: "png" | "jpeg" | "webp" | "gif"): string {
	return `image/${format}`;
}

function assertPixelLimit(width: number, height: number, max: number): void {
	if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
		throw new ImageLimitError("Image dimensions are invalid");
	}
	if (width > Math.floor(max / height))
		throw new ImageLimitError("Image pixel count exceeds the limit");
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

function abortError(): Error {
	const error = new Error("Image processing aborted");
	error.name = "AbortError";
	return error;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
	return signature.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
	return Buffer.from(bytes.subarray(start, end)).toString("latin1");
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
