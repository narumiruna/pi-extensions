import { createHash } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ImageDropSettings } from "./settings.js";

export type ItemStatus = "uploading" | "processing" | "ready" | "error";
export type BatchPhase = "empty" | "editing" | "ready" | "blocked" | "reserved" | "closed";

export interface ItemReservation {
	id: string;
	name: string;
	size: number;
}

export interface ProcessedImage {
	bytes: Buffer;
	mimeType: string;
	width: number;
	height: number;
	originalWidth: number;
	originalHeight: number;
	sourceFormat: string;
	outputFormat: string;
	resized: boolean;
	hash: string;
	notes: string[];
}

interface BatchItem extends ItemReservation {
	status: ItemStatus;
	source?: Buffer;
	processed?: ProcessedImage;
	processedAutoResize?: boolean;
	error?: string;
}

export interface PublicBatchItem extends ItemReservation {
	status: ItemStatus;
	error?: string;
	mimeType?: string;
	width?: number;
	height?: number;
	originalWidth?: number;
	originalHeight?: number;
	sourceFormat?: string;
	outputFormat?: string;
	resized?: boolean;
	notes: string[];
}

export interface PublicBatchState {
	revision: number;
	phase: BatchPhase;
	items: PublicBatchItem[];
	totalSourceBytes: number;
}

export interface MessageReservation {
	id: string;
	text: string;
	streamingBehavior?: "steer" | "followUp";
	images: ImageContent[];
	digest: string;
	preflightStarted: boolean;
}

export type CompleteResult = { kind: "ready" } | { kind: "duplicate"; existingId: string };

export class BatchError extends Error {
	constructor(
		message: string,
		readonly code: "closed" | "frozen" | "stale" | "limit" | "invalid" | "not-found" | "not-ready",
	) {
		super(message);
	}
}

export class BatchStore {
	private items: BatchItem[] = [];
	private revision = 0;
	private reservation?: MessageReservation;
	private closed = false;

	constructor(private readonly settings: ImageDropSettings) {}

	publicState(): PublicBatchState {
		return {
			revision: this.revision,
			phase: this.phase(),
			items: this.items.map((item) => ({
				id: item.id,
				name: item.name,
				size: item.size,
				status: item.status,
				error: item.error,
				mimeType: item.processed?.mimeType,
				width: item.processed?.width,
				height: item.processed?.height,
				originalWidth: item.processed?.originalWidth,
				originalHeight: item.processed?.originalHeight,
				sourceFormat: item.processed?.sourceFormat,
				outputFormat: item.processed?.outputFormat,
				resized: item.processed?.resized,
				notes: [...(item.processed?.notes ?? [])],
			})),
			totalSourceBytes: this.items.reduce((sum, item) => sum + item.size, 0),
		};
	}

	reserveItems(inputs: readonly ItemReservation[], expectedRevision = this.revision): number {
		this.assertMutable(expectedRevision);
		if (inputs.length === 0) throw new BatchError("No images supplied", "invalid");
		const ids = new Set(this.items.map((item) => item.id));
		let addedBytes = 0;
		for (const input of inputs) {
			if (!isSafeIdentifier(input.id) || ids.has(input.id)) {
				throw new BatchError("Image id is invalid or duplicated", "invalid");
			}
			if (!input.name || input.name.length > 255 || hasControlCharacter(input.name)) {
				throw new BatchError("Image name is invalid", "invalid");
			}
			if (!Number.isSafeInteger(input.size) || input.size <= 0) {
				throw new BatchError("Image size is invalid", "invalid");
			}
			if (input.size > this.settings.maxImageBytes) {
				throw new BatchError("Image exceeds the per-image limit", "limit");
			}
			ids.add(input.id);
			addedBytes += input.size;
		}
		if (this.items.length + inputs.length > this.settings.maxImages) {
			throw new BatchError("Batch exceeds the image-count limit", "limit");
		}
		const currentBytes = this.items.reduce((sum, item) => sum + item.size, 0);
		if (currentBytes + addedBytes > this.settings.maxBatchBytes) {
			throw new BatchError("Batch exceeds the byte limit", "limit");
		}
		this.items.push(...inputs.map((input) => ({ ...input, status: "uploading" as const })));
		return this.bump();
	}

	startProcessing(id: string, source: Buffer): number {
		this.assertOpen();
		if (this.reservation) throw new BatchError("Batch is frozen", "frozen");
		const item = this.item(id);
		if (source.byteLength !== item.size) {
			throw new BatchError("Uploaded size does not match the reservation", "invalid");
		}
		item.source = Buffer.from(source);
		item.processed = undefined;
		item.processedAutoResize = undefined;
		item.error = undefined;
		item.status = "processing";
		return this.bump();
	}

	complete(id: string, processed: ProcessedImage, autoResize?: boolean): CompleteResult {
		this.assertOpen();
		if (this.reservation) throw new BatchError("Batch is frozen", "frozen");
		const item = this.item(id);
		if (item.status !== "processing") throw new BatchError("Image is not processing", "invalid");
		const itemIndex = this.items.indexOf(item);
		const duplicates = this.items
			.map((candidate, index) => ({ candidate, index }))
			.filter(
				({ candidate }) => candidate.id !== id && candidate.processed?.hash === processed.hash,
			);
		const earlier = duplicates.find(({ index }) => index < itemIndex);
		if (earlier) {
			this.items = this.items.filter((candidate) => candidate.id !== id);
			this.bump();
			return { kind: "duplicate", existingId: earlier.candidate.id };
		}
		item.processed = cloneProcessed(processed);
		item.processedAutoResize = autoResize;
		item.status = "ready";
		item.error = undefined;
		if (duplicates.length > 0) {
			const laterIds = new Set(duplicates.map(({ candidate }) => candidate.id));
			this.items = this.items.filter((candidate) => !laterIds.has(candidate.id));
			this.bump();
			return { kind: "duplicate", existingId: item.id };
		}
		this.bump();
		return { kind: "ready" };
	}

	fail(id: string, error: string): number {
		this.assertOpen();
		if (this.reservation) throw new BatchError("Batch is frozen", "frozen");
		const item = this.item(id);
		item.status = "error";
		item.error = sanitizeError(error);
		item.processed = undefined;
		item.processedAutoResize = undefined;
		return this.bump();
	}

	failUpload(id: string, error: string): number {
		this.assertOpen();
		if (this.reservation) throw new BatchError("Batch is frozen", "frozen");
		const item = this.item(id);
		if (item.status !== "uploading") {
			throw new BatchError("Upload is no longer pending", "invalid");
		}
		item.status = "error";
		item.error = sanitizeError(error);
		return this.bump();
	}

	beginAutoResizeReprocessing(autoResize: boolean): Array<{ id: string; source: Buffer }> {
		this.assertOpen();
		if (this.reservation) throw new BatchError("Batch is frozen", "frozen");
		if (this.items.some((item) => item.status !== "ready")) {
			throw new BatchError("Every image must be ready before reprocessing", "not-ready");
		}
		const candidates = this.items.filter(
			(item) => item.processedAutoResize !== undefined && item.processedAutoResize !== autoResize,
		);
		if (candidates.length === 0) return [];
		const jobs = candidates.map((item) => {
			if (!item.source) throw new BatchError("Image source bytes are unavailable", "not-ready");
			return { id: item.id, source: Buffer.from(item.source) };
		});
		for (const item of candidates) {
			item.status = "processing";
			item.processed = undefined;
			item.processedAutoResize = undefined;
			item.error = undefined;
		}
		this.bump();
		return jobs;
	}

	retrySource(id: string): Buffer {
		this.assertOpen();
		if (this.reservation) throw new BatchError("Batch is frozen", "frozen");
		const item = this.item(id);
		if (item.status !== "error" || !item.source) {
			throw new BatchError("Image cannot be retried without uploaded source bytes", "not-ready");
		}
		item.status = "processing";
		item.error = undefined;
		item.processedAutoResize = undefined;
		this.bump();
		return Buffer.from(item.source);
	}

	delete(id: string, expectedRevision = this.revision): number {
		this.assertMutable(expectedRevision);
		const before = this.items.length;
		this.items = this.items.filter((item) => item.id !== id);
		if (this.items.length === before) throw new BatchError("Image not found", "not-found");
		return this.bump();
	}

	reorder(ids: readonly string[], expectedRevision = this.revision): number {
		this.assertMutable(expectedRevision);
		if (
			ids.length !== this.items.length ||
			new Set(ids).size !== ids.length ||
			ids.some((id) => !this.items.some((item) => item.id === id))
		) {
			throw new BatchError("Order must contain every image exactly once", "invalid");
		}
		const byId = new Map(this.items.map((item) => [item.id, item]));
		this.items = ids.map((id) => byId.get(id) as BatchItem);
		return this.bump();
	}

	clear(expectedRevision = this.revision): number {
		this.assertMutable(expectedRevision);
		this.items = [];
		return this.bump();
	}

	reserveMessage(text: string, streamingBehavior?: "steer" | "followUp"): MessageReservation {
		this.assertOpen();
		if (this.reservation) throw new BatchError("Batch is already frozen", "frozen");
		if (!text.trim()) throw new BatchError("Message text is required", "invalid");
		if (this.items.length === 0 || this.items.some((item) => item.status !== "ready")) {
			throw new BatchError("Every image must be ready", "not-ready");
		}
		const images = this.items.map((item) => ({
			type: "image" as const,
			data: item.processed?.bytes.toString("base64") ?? "",
			mimeType: item.processed?.mimeType ?? "",
		}));
		const reservation: MessageReservation = {
			id: cryptoId(this.revision, images),
			text,
			streamingBehavior,
			images,
			digest: digestImages(images),
			preflightStarted: false,
		};
		this.reservation = reservation;
		this.bump();
		return cloneReservation(reservation);
	}

	markPreflightStarted(): void {
		if (this.reservation) this.reservation.preflightStarted = true;
	}

	currentReservation(): MessageReservation | undefined {
		return this.reservation ? cloneReservation(this.reservation) : undefined;
	}

	preview(id: string): { bytes: Buffer; mimeType: string } {
		this.assertOpen();
		const processed = this.item(id).processed;
		if (!processed) throw new BatchError("Image preview is not ready", "not-ready");
		return { bytes: Buffer.from(processed.bytes), mimeType: processed.mimeType };
	}

	commitReservation(digest: string): boolean {
		if (!this.reservation || this.reservation.digest !== digest) return false;
		this.reservation = undefined;
		this.items = [];
		this.bump();
		return true;
	}

	restoreReservation(): MessageReservation | undefined {
		if (!this.reservation) return undefined;
		const restored = cloneReservation(this.reservation);
		this.reservation = undefined;
		this.bump();
		return restored;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.reservation = undefined;
		this.items = [];
		this.bump();
	}

	private phase(): BatchPhase {
		if (this.closed) return "closed";
		if (this.reservation) return "reserved";
		if (this.items.length === 0) return "empty";
		if (this.items.some((item) => item.status === "error")) return "blocked";
		if (this.items.every((item) => item.status === "ready")) return "ready";
		return "editing";
	}

	private assertOpen(): void {
		if (this.closed) throw new BatchError("Batch is closed", "closed");
	}

	private assertMutable(expectedRevision: number): void {
		this.assertOpen();
		if (this.reservation) throw new BatchError("Batch is frozen", "frozen");
		if (expectedRevision !== this.revision)
			throw new BatchError("Batch revision is stale", "stale");
	}

	private item(id: string): BatchItem {
		const item = this.items.find((candidate) => candidate.id === id);
		if (!item) throw new BatchError("Image not found", "not-found");
		return item;
	}

	private bump(): number {
		this.revision += 1;
		return this.revision;
	}
}

export function digestImages(images: readonly ImageContent[]): string {
	const hash = createHash("sha256");
	for (const image of images) {
		hash.update(image.mimeType);
		hash.update("\0");
		hash.update(image.data);
		hash.update("\0");
	}
	return hash.digest("hex");
}

function cloneProcessed(processed: ProcessedImage): ProcessedImage {
	return { ...processed, bytes: Buffer.from(processed.bytes), notes: [...processed.notes] };
}

function cloneReservation(reservation: MessageReservation): MessageReservation {
	return { ...reservation, images: reservation.images.map((image) => ({ ...image })) };
}

function sanitizeError(error: string): string {
	const normalized = [...error]
		.map((character) => (isControlCharacter(character) ? " " : character))
		.join("")
		.replace(/\s+/g, " ")
		.trim();
	return normalized.slice(0, 500) || "Image processing failed";
}

function hasControlCharacter(value: string): boolean {
	return [...value].some(isControlCharacter);
}

function isControlCharacter(character: string): boolean {
	const code = character.charCodeAt(0);
	return code <= 31 || code === 127;
}

function isSafeIdentifier(id: string): boolean {
	return /^[A-Za-z0-9_-]{1,80}$/.test(id);
}

function cryptoId(revision: number, images: readonly ImageContent[]): string {
	return createHash("sha256")
		.update(`${revision}\0${Date.now()}\0${digestImages(images)}`)
		.digest("hex")
		.slice(0, 24);
}
