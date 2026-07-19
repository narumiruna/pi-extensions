import type { ImageContent } from "@earendil-works/pi-ai";
import {
	detectImageFormat,
	type ProcessedBrowserImage,
	type ProcessImageOptions,
	processImage,
} from "./image-pipeline.js";

export type { ProcessedBrowserImage } from "./image-pipeline.js";

export { detectImageFormat } from "./image-pipeline.js";

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

interface ImageProcessorOptions {
	autoResize: boolean;
	maxPixels: number;
	maxDimension?: number;
	maxBase64Bytes?: number;
	signal?: AbortSignal;
}

type ImageProcessFunction = (
	source: Uint8Array,
	options: ProcessImageOptions,
) => Promise<ImageContent>;

interface QueuedImageProcess {
	source: Uint8Array;
	options: ProcessImageOptions;
	resolve: (result: ImageContent) => void;
	reject: (error: unknown) => void;
	removeAbortListener?: () => void;
}

export class ImageProcessor {
	private readonly queue: QueuedImageProcess[] = [];
	private active = 0;

	constructor(
		private readonly concurrency = 2,
		private readonly processor: ImageProcessFunction = processProviderImage,
	) {
		if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
			throw new Error("Image processing concurrency must be a positive integer");
		}
	}

	process(source: Uint8Array, options: ImageProcessorOptions): Promise<ImageContent> {
		const resolved: ProcessImageOptions = {
			...options,
			maxDimension: options.maxDimension ?? DEFAULT_IMAGE_LIMITS.maxDimension,
			maxBase64Bytes: options.maxBase64Bytes ?? DEFAULT_IMAGE_LIMITS.maxBase64Bytes,
		};
		assertNotAborted(resolved.signal);
		return new Promise((resolve, reject) => {
			const job: QueuedImageProcess = { source, options: resolved, resolve, reject };
			if (resolved.signal) {
				const onAbort = () => {
					const index = this.queue.indexOf(job);
					if (index === -1) return;
					this.queue.splice(index, 1);
					job.removeAbortListener?.();
					reject(abortError());
				};
				resolved.signal.addEventListener("abort", onAbort, { once: true });
				job.removeAbortListener = () => resolved.signal?.removeEventListener("abort", onAbort);
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

export async function processStagedImage(
	source: Uint8Array,
	options: ProcessBrowserImageOptions = {},
): Promise<ProcessedBrowserImage> {
	const limits = { ...DEFAULT_IMAGE_LIMITS, ...definedLimits(options) };
	if (options.blockImages) throw new Error("Pi image sending is disabled.");
	if (options.supportsImages === false)
		throw new Error("The current model does not support images.");
	assertNotAborted(options.signal);
	if (source.byteLength === 0) throw new Error("Image is empty.");
	if (source.byteLength > limits.maxImageBytes) throw new Error("Image is too large.");
	return processImage(source, {
		autoResize: options.autoResize !== false,
		maxPixels: limits.maxPixels,
		maxDimension: limits.maxDimension,
		maxBase64Bytes: limits.maxBase64Bytes,
		signal: options.signal,
	});
}

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
	const totalSourceBytes = decoded.reduce((total, item) => total + item.byteLength, 0);
	if (totalSourceBytes > limits.maxPromptBytes) {
		throw new Error("Combined image input is too large.");
	}

	const processor = new ImageProcessor(2);
	const output = await Promise.all(
		decoded.map((bytes) =>
			processor.process(bytes, {
				autoResize: options.autoResize !== false,
				maxPixels: limits.maxPixels,
				maxDimension: limits.maxDimension,
				maxBase64Bytes: limits.maxBase64Bytes,
				signal: options.signal,
			}),
		),
	);
	const totalOutputBytes = output.reduce(
		(total, item) => total + Buffer.byteLength(item.data, "base64"),
		0,
	);
	if (totalOutputBytes > limits.maxPromptBytes) {
		throw new Error("Combined processed images are too large.");
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

function decodeInput(input: BrowserImageInput, index: number, maxImageBytes: number): Buffer {
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
	if (!detectImageFormat(bytes)) throw new Error(`Image ${index + 1} uses an unsupported format.`);
	return bytes;
}

async function processProviderImage(
	source: Uint8Array,
	options: ProcessImageOptions,
): Promise<ImageContent> {
	const processed = await processImage(source, options);
	return {
		type: "image",
		data: processed.bytes.toString("base64"),
		mimeType: processed.mimeType,
	};
}

function assertNotAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

function abortError(): Error {
	const error = new Error("Image processing aborted.");
	error.name = "AbortError";
	return error;
}
