declare module "bmp-js" {
	interface DecodedBmp {
		data: Buffer;
		width: number;
		height: number;
	}
	export function decode(buffer: Buffer, withAlpha?: boolean): DecodedBmp;
}

declare module "heic-decode" {
	interface DecodedImage {
		width: number;
		height: number;
		data: Uint8ClampedArray;
	}
	interface DeferredImage {
		width: number;
		height: number;
		decode(): Promise<DecodedImage>;
	}
	interface DeferredImages extends Array<DeferredImage> {
		dispose(): void;
	}
	interface Decode {
		(options: { buffer: Uint8Array }): Promise<DecodedImage>;
		all(options: { buffer: Uint8Array }): Promise<DeferredImages>;
	}
	const decode: Decode;
	export default decode;
}
