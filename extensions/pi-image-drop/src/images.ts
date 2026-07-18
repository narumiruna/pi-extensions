import { createHash } from "node:crypto";
import { decode as decodeBmp } from "bmp-js";
import decodeHeic from "heic-decode";
import sharp, { type OutputInfo, type Sharp, type SharpOptions } from "sharp";
import type { ProcessedImage } from "./batch.js";

export type SupportedImageFormat =
	| "png"
	| "jpeg"
	| "webp"
	| "gif"
	| "bmp"
	| "tiff"
	| "heic"
	| "avif";

const MIB = 1024 * 1024;
export const MAX_BASE64_BYTES = 4.5 * MIB;
const MAX_DIMENSION = 2000;

export interface ProcessImageOptions {
	autoResize: boolean;
	maxImagePixels: number;
	signal?: AbortSignal;
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

type ImageProcessFunction = (
	source: Uint8Array,
	options: ProcessImageOptions,
) => Promise<ProcessedImage>;

interface QueuedImageProcess {
	source: Uint8Array;
	options: ProcessImageOptions;
	resolve: (result: ProcessedImage) => void;
	reject: (error: unknown) => void;
	removeAbortListener?: () => void;
}

export class ImageProcessor {
	private readonly queue: QueuedImageProcess[] = [];
	private active = 0;

	constructor(
		private readonly concurrency = 2,
		private readonly processor: ImageProcessFunction = processImage,
	) {
		if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
			throw new Error("Image processing concurrency must be a positive integer");
		}
	}

	process(source: Uint8Array, options: ProcessImageOptions): Promise<ProcessedImage> {
		throwIfAborted(options.signal);
		return new Promise((resolve, reject) => {
			const job: QueuedImageProcess = { source, options, resolve, reject };
			if (options.signal) {
				const onAbort = () => {
					const index = this.queue.indexOf(job);
					if (index === -1) return;
					this.queue.splice(index, 1);
					job.removeAbortListener?.();
					reject(abortError());
				};
				options.signal.addEventListener("abort", onAbort, { once: true });
				job.removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
			}
			this.queue.push(job);
			this.pump();
		});
	}

	private pump(): void {
		while (this.active < this.concurrency && this.queue.length > 0) {
			const job = this.queue.shift();
			if (!job) return;
			job.removeAbortListener?.();
			if (job.options.signal?.aborted) {
				job.reject(abortError());
				continue;
			}
			this.active += 1;
			void this.processor(job.source, job.options)
				.then(job.resolve, job.reject)
				.finally(() => {
					this.active -= 1;
					this.pump();
				});
		}
	}
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
): Promise<ProcessedImage> {
	throwIfAborted(options.signal);
	const bytes = Buffer.from(source);
	const format = detectImageFormat(bytes);
	if (!format) throw new UnsupportedImageError("Unsupported image format");
	const descriptor = await describeInput(bytes, format, options.maxImagePixels, options.signal);
	const original = await dimensions(descriptor, options.maxImagePixels);
	throwIfAborted(options.signal);

	if (!options.autoResize && (original.width > MAX_DIMENSION || original.height > MAX_DIMENSION)) {
		throw new ImageLimitError("Image exceeds inline image limits while auto-resize is disabled");
	}

	let target = options.autoResize ? fitWithin(original, MAX_DIMENSION) : original;
	let quality = 95;
	while (true) {
		throwIfAborted(options.signal);
		const encoded = await encode(descriptor, target, quality);
		throwIfAborted(options.signal);
		const base64Bytes = Buffer.byteLength(encoded.data.toString("base64"));
		if (base64Bytes < MAX_BASE64_BYTES) {
			const width = encoded.info.width;
			const height = encoded.info.pageHeight ?? encoded.info.height;
			const resized = width !== original.width || height !== original.height;
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
				resized,
				hash: createHash("sha256").update(encoded.data).digest("hex"),
				notes: buildNotes(format, outputFormat, original, { width, height }, resized),
			};
		}
		if (!options.autoResize) {
			throw new ImageLimitError("Image exceeds inline image limits while auto-resize is disabled");
		}
		if ((format === "jpeg" || format === "webp") && quality > 40) {
			quality = nextQuality(quality);
			continue;
		}
		quality = 95;
		if (target.width === 1 && target.height === 1) {
			throw new ImageLimitError("Image could not be reduced below inline image limits");
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
	maxImagePixels: number,
	signal?: AbortSignal,
): Promise<InputDescriptor> {
	if (format === "bmp") {
		return describeBmp(bytes, maxImagePixels);
	}
	if (format !== "heic") {
		return {
			input: bytes,
			options: {
				animated: format === "gif",
				failOn: "warning",
				limitInputPixels: maxImagePixels,
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
		assertPixelLimit(first.width, first.height, maxImagePixels);
		const decoded = await first.decode();
		throwIfAborted(signal);
		return {
			// Copy pixels out of libheif's WASM heap before deferred.dispose() releases it.
			input: Buffer.from(decoded.data),
			options: {
				raw: { width: decoded.width, height: decoded.height, channels: 4 },
				limitInputPixels: maxImagePixels,
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

function describeBmp(bytes: Buffer, maxImagePixels: number): InputDescriptor {
	if (bytes.byteLength < 54 || bytes.readUInt32LE(14) < 40) {
		throw new UnsupportedImageError("BMP header is unsupported");
	}
	const width = bytes.readInt32LE(18);
	const signedHeight = bytes.readInt32LE(22);
	const height = Math.abs(signedHeight);
	assertPixelLimit(width, height, maxImagePixels);
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
			limitInputPixels: maxImagePixels,
		},
		format: "bmp",
		animated: false,
	};
}

async function dimensions(
	descriptor: InputDescriptor,
	maxImagePixels: number,
): Promise<Dimensions> {
	try {
		const metadata = await sharp(descriptor.input, descriptor.options).metadata();
		const width = metadata.autoOrient.width ?? metadata.width;
		const totalHeight = metadata.autoOrient.height ?? metadata.height;
		if (!width || !totalHeight) throw new Error("Image dimensions are missing");
		const pages = metadata.pages ?? 1;
		const height = metadata.pageHeight ?? Math.floor(totalHeight / pages);
		assertPixelLimit(width, height, maxImagePixels);
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
	if (target.width > 0 && target.height > 0) {
		pipeline = pipeline.resize(target.width, target.height, {
			fit: "inside",
			withoutEnlargement: true,
			kernel: sharp.kernel.lanczos3,
		});
	}
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

function buildNotes(
	source: string,
	output: string,
	original: Pick<Dimensions, "width" | "height">,
	result: { width: number; height: number },
	resized: boolean,
): string[] {
	const notes: string[] = ["Sensitive image metadata removed"];
	if (source !== output) notes.push(`${source.toUpperCase()} converted to ${output.toUpperCase()}`);
	if (resized) {
		notes.push(`${original.width}×${original.height} resized to ${result.width}×${result.height}`);
	}
	return notes;
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
	if (width > Math.floor(max / height)) {
		throw new ImageLimitError(`Image exceeds the ${max}-pixel limit`);
	}
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
