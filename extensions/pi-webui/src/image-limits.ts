const MIB = 1024 * 1024;

export interface ImageLimits {
	maxImages: number;
	maxImageBytes: number;
	maxBatchBytes: number;
	maxImagePixels: number;
}

export const DEFAULT_IMAGE_LIMITS: Readonly<ImageLimits> = Object.freeze({
	maxImages: 8,
	maxImageBytes: 10 * MIB,
	maxBatchBytes: 40 * MIB,
	maxImagePixels: 50_000_000,
});

export const IMAGE_HARD_LIMITS: Readonly<ImageLimits> = Object.freeze({
	maxImages: 32,
	maxImageBytes: 50 * MIB,
	maxBatchBytes: 200 * MIB,
	maxImagePixels: 100_000_000,
});

export const PROVIDER_IMAGE_LIMITS = Object.freeze({
	maxDimension: 2_000,
	maxBase64Bytes: 4_500_000,
});

export function imageLimits(value: Partial<ImageLimits> = {}): Readonly<ImageLimits> {
	return Object.freeze({
		maxImages: value.maxImages ?? DEFAULT_IMAGE_LIMITS.maxImages,
		maxImageBytes: value.maxImageBytes ?? DEFAULT_IMAGE_LIMITS.maxImageBytes,
		maxBatchBytes: value.maxBatchBytes ?? DEFAULT_IMAGE_LIMITS.maxBatchBytes,
		maxImagePixels: value.maxImagePixels ?? DEFAULT_IMAGE_LIMITS.maxImagePixels,
	});
}
