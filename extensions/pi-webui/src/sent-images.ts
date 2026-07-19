import { createHmac, randomBytes } from "node:crypto";

export interface SentImageSettings {
	enabled: boolean;
	maxImages: number;
	maxBytes: number;
}

export interface RetainedImageInput {
	name?: string;
	mimeType?: string;
	data: string;
}

export interface RetainedImageClone {
	retainedId: string;
	name: string;
	bytes: Buffer;
	mimeType: string;
}

export interface PublicSentImage {
	id: string;
	name: string;
	mimeType: string;
	size: number;
}

export interface PublicSentImageState {
	revision: number;
	enabled: boolean;
	items: PublicSentImage[];
	totalBytes: number;
	maxImages: number;
	maxBytes: number;
}

interface SentImageItem {
	id: string;
	name: string;
	mimeType: string;
	bytes: Buffer;
	associations: Set<string>;
}

export class SentImageError extends Error {
	constructor(
		message: string,
		readonly status = 409,
	) {
		super(message);
		this.name = "SentImageError";
	}
}

export class SentImageStore {
	private readonly key = randomBytes(32);
	private readonly items: SentImageItem[] = [];
	private revision = 0;
	private closed = false;

	constructor(private readonly settings: SentImageSettings) {
		for (const value of [settings.maxImages, settings.maxBytes]) {
			if (!Number.isSafeInteger(value) || value <= 0) {
				throw new Error("Sent-image limits must be positive integers.");
			}
		}
	}

	publicState(): PublicSentImageState {
		return {
			revision: this.revision,
			enabled: this.settings.enabled,
			items: this.items.map((item) => ({
				id: item.id,
				name: item.name,
				mimeType: item.mimeType,
				size: item.bytes.byteLength,
			})),
			totalBytes: this.residentBytes(),
			maxImages: this.settings.maxImages,
			maxBytes: this.settings.maxBytes,
		};
	}

	residentBytes(): number {
		return this.items.reduce((total, item) => total + item.bytes.byteLength, 0);
	}

	referencesFor(messageId: string, images: readonly RetainedImageInput[]): string[] {
		this.assertOpen();
		if (!this.settings.enabled) return [];
		normalizeMessageId(messageId);
		return images.map((image, index) => {
			const normalized = normalizeImage(image, index);
			return this.idFor(normalized.bytes);
		});
	}

	commit(
		messageId: string,
		images: readonly RetainedImageInput[],
		expectedReferences: readonly string[],
	): PublicSentImageState {
		this.assertOpen();
		if (!this.settings.enabled) {
			if (expectedReferences.length !== 0) {
				throw new SentImageError("Sent-image retention is disabled.");
			}
			return this.publicState();
		}
		normalizeMessageId(messageId);
		const normalized = images.map(normalizeImage);
		const references = normalized.map((image) => this.idFor(image.bytes));
		if (!sameIds(references, expectedReferences)) {
			throw new SentImageError("Sent-image references are stale.");
		}
		let changed = false;
		for (const [index, image] of normalized.entries()) {
			const id = references[index];
			if (!id) throw new SentImageError("Sent-image reference is missing.");
			const existing = this.items.find((item) => item.id === id);
			if (existing) {
				existing.associations.add(messageId);
				continue;
			}
			this.items.push({
				id,
				name: image.name,
				mimeType: image.mimeType,
				bytes: Buffer.from(image.bytes),
				associations: new Set([messageId]),
			});
			changed = true;
		}
		if (this.evict()) changed = true;
		if (changed) this.revision += 1;
		return this.publicState();
	}

	preview(id: string): { bytes: Buffer; mimeType: string } {
		const item = this.item(id);
		return { bytes: Buffer.from(item.bytes), mimeType: item.mimeType };
	}

	clone(ids: readonly string[]): RetainedImageClone[] {
		this.assertOpen();
		if (!Array.isArray(ids) || ids.length === 0) {
			throw new SentImageError("No retained images were selected.", 400);
		}
		if (new Set(ids).size !== ids.length) {
			throw new SentImageError("Retained image selection contains a duplicate.", 400);
		}
		return ids.map((id) => {
			const item = this.item(id);
			return {
				retainedId: item.id,
				name: item.name,
				bytes: Buffer.from(item.bytes),
				mimeType: item.mimeType,
			};
		});
	}

	reconcile(externalBytes: number, totalBudget = this.settings.maxBytes): PublicSentImageState {
		this.assertOpen();
		if (
			!Number.isSafeInteger(externalBytes) ||
			externalBytes < 0 ||
			!Number.isSafeInteger(totalBudget) ||
			totalBudget <= 0
		) {
			throw new SentImageError("Image resident-byte accounting is invalid.", 500);
		}
		if (!this.evict(externalBytes, totalBudget)) return this.publicState();
		this.revision += 1;
		return this.publicState();
	}

	remove(id: string, expectedRevision: number): PublicSentImageState {
		this.assertRevision(expectedRevision);
		const index = this.items.findIndex((item) => item.id === id);
		if (index === -1) throw new SentImageError("Retained image was not found.", 404);
		this.items.splice(index, 1);
		this.revision += 1;
		return this.publicState();
	}

	clear(expectedRevision: number): PublicSentImageState {
		this.assertRevision(expectedRevision);
		if (this.items.length === 0) return this.publicState();
		this.items.length = 0;
		this.revision += 1;
		return this.publicState();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.items.length = 0;
		this.revision += 1;
	}

	private item(id: string): SentImageItem {
		this.assertOpen();
		if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
			throw new SentImageError("Retained image id is invalid.", 400);
		}
		const item = this.items.find((candidate) => candidate.id === id);
		if (!item) throw new SentImageError("Retained image has expired.", 404);
		return item;
	}

	private idFor(bytes: Buffer): string {
		return `sent_${createHmac("sha256", this.key).update(bytes).digest("base64url").slice(0, 32)}`;
	}

	private evict(externalBytes = 0, totalBudget = this.settings.maxBytes): boolean {
		let changed = false;
		while (
			this.items.length > 0 &&
			(this.items.length > this.settings.maxImages ||
				this.residentBytes() > this.settings.maxBytes ||
				this.residentBytes() + externalBytes > totalBudget)
		) {
			this.items.shift();
			changed = true;
		}
		return changed;
	}

	private assertRevision(expectedRevision: number): void {
		this.assertOpen();
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.revision) {
			throw new SentImageError(
				`Sent-image revision mismatch; current revision is ${this.revision}.`,
			);
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new SentImageError("Sent-image store is closed.", 410);
	}
}

function normalizeImage(
	input: RetainedImageInput,
	index = 0,
): {
	name: string;
	mimeType: string;
	bytes: Buffer;
} {
	if (!input || typeof input.data !== "string" || !validBase64(input.data)) {
		throw new SentImageError(`Sent image ${index + 1} has invalid data.`, 400);
	}
	const bytes = Buffer.from(input.data, "base64");
	if (bytes.length === 0) throw new SentImageError(`Sent image ${index + 1} is empty.`, 400);
	const mimeType = input.mimeType;
	if (typeof mimeType !== "string" || !/^image\/[a-z0-9.+-]{1,64}$/i.test(mimeType)) {
		throw new SentImageError(`Sent image ${index + 1} has an invalid MIME type.`, 400);
	}
	const name = typeof input.name === "string" && input.name ? input.name.slice(0, 255) : "Image";
	return { name, mimeType, bytes };
}

function normalizeMessageId(value: string): void {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) {
		throw new SentImageError("Message association is invalid.", 400);
	}
}

function validBase64(value: string): boolean {
	return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((id, index) => id === right[index]);
}
