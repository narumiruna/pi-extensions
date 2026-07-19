import { randomUUID } from "node:crypto";

export type AttachmentStatus = "uploading" | "processing" | "ready" | "error";
export type AttachmentPhase =
	| "empty"
	| "uploading"
	| "processing"
	| "blocked"
	| "ready"
	| "reserved"
	| "closed";

export interface AttachmentLimits {
	maxImages: number;
	maxImageBytes: number;
	maxPromptBytes: number;
}

export interface AttachmentReservationInput {
	id: string;
	name: string;
	size: number;
	mimeType?: string;
}

export interface PreparedAttachment {
	bytes: Buffer;
	mimeType: string;
	width?: number;
	height?: number;
	originalWidth?: number;
	originalHeight?: number;
	sourceFormat?: string;
	outputFormat?: string;
	resized?: boolean;
	notes?: string[];
}

export interface PublicAttachment {
	id: string;
	name: string;
	size: number;
	status: AttachmentStatus;
	mimeType?: string;
	width?: number;
	height?: number;
	originalWidth?: number;
	originalHeight?: number;
	sourceFormat?: string;
	outputFormat?: string;
	resized?: boolean;
	notes: string[];
	retryable: boolean;
	error?: string;
}

export interface PublicAttachmentState {
	revision: number;
	phase: AttachmentPhase;
	items: PublicAttachment[];
	totalSourceBytes: number;
	totalResidentBytes: number;
}

export interface StagedBrowserImage {
	name: string;
	mimeType: string;
	data: string;
}

export interface SendReservation {
	token: string;
	images: StagedBrowserImage[];
}

export interface PreparedAttachmentInput {
	id: string;
	name: string;
	prepared: PreparedAttachment;
}

interface AttachmentItem extends AttachmentReservationInput {
	status: AttachmentStatus;
	reservedRevision: number;
	source?: Buffer;
	prepared?: PreparedAttachment;
	error?: string;
	operation?: symbol;
	controller?: AbortController;
}

interface ProcessingJob {
	item: AttachmentItem;
	operation: symbol;
	controller: AbortController;
	removeExternalAbort?: () => void;
}

export interface AttachmentStoreOptions {
	limits: AttachmentLimits;
	process: (source: Uint8Array, signal?: AbortSignal) => Promise<PreparedAttachment>;
	concurrency?: number;
	onChange?: (state: PublicAttachmentState) => void;
}

export class AttachmentError extends Error {
	constructor(
		message: string,
		readonly status = 409,
	) {
		super(message);
		this.name = "AttachmentError";
	}
}

export class AttachmentStore {
	private readonly items: AttachmentItem[] = [];
	private readonly queue: ProcessingJob[] = [];
	private readonly idleWaiters = new Set<() => void>();
	private readonly concurrency: number;
	private revision = 0;
	private active = 0;
	private closed = false;
	private sendToken?: string;

	constructor(private readonly options: AttachmentStoreOptions) {
		validateLimits(options.limits);
		this.concurrency = options.concurrency ?? 2;
		if (!Number.isSafeInteger(this.concurrency) || this.concurrency <= 0) {
			throw new Error("Attachment processing concurrency must be a positive integer.");
		}
	}

	publicState(): PublicAttachmentState {
		return {
			revision: this.revision,
			phase: this.phase(),
			items: this.items.map((item) => ({
				id: item.id,
				name: item.name,
				size: item.size,
				status: item.status,
				mimeType: item.prepared?.mimeType,
				width: item.prepared?.width,
				height: item.prepared?.height,
				originalWidth: item.prepared?.originalWidth,
				originalHeight: item.prepared?.originalHeight,
				sourceFormat: item.prepared?.sourceFormat,
				outputFormat: item.prepared?.outputFormat,
				resized: item.prepared?.resized,
				notes: [...(item.prepared?.notes ?? [])],
				retryable: item.status === "error" && Boolean(item.source),
				error: item.error,
			})),
			totalSourceBytes: this.reservedSourceBytes(),
			totalResidentBytes: this.residentBytes(),
		};
	}

	residentBytes(): number {
		return this.items.reduce(
			(total, item) =>
				total + (item.source?.byteLength ?? 0) + (item.prepared?.bytes.byteLength ?? 0),
			0,
		);
	}

	reservedSourceBytes(): number {
		return this.items.reduce((total, item) => total + item.size, 0);
	}

	waitForIdle(): Promise<void> {
		if (this.active === 0 && this.queue.length === 0) return Promise.resolve();
		return new Promise((resolve) => this.idleWaiters.add(resolve));
	}

	reserve(inputs: AttachmentReservationInput[], expectedRevision: number): PublicAttachmentState {
		this.assertMutable(expectedRevision);
		if (!Array.isArray(inputs) || inputs.length === 0) {
			throw new AttachmentError("At least one attachment is required.", 400);
		}
		const normalized = inputs.map((input) => normalizeReservation(input, this.options.limits));
		const ids = new Set(this.items.map((item) => item.id));
		for (const item of normalized) {
			if (ids.has(item.id)) throw new AttachmentError("Attachment id is duplicate.", 400);
			ids.add(item.id);
		}
		if (this.items.length + normalized.length > this.options.limits.maxImages) {
			throw new AttachmentError(
				`Attachment count exceeds the maximum of ${this.options.limits.maxImages}.`,
				413,
			);
		}
		const total = this.reservedSourceBytes() + normalized.reduce((sum, item) => sum + item.size, 0);
		if (total > this.options.limits.maxPromptBytes) {
			throw new AttachmentError("Combined attachment input is too large.", 413);
		}
		const reservedRevision = this.revision + 1;
		this.items.push(
			...normalized.map((item) => ({
				...item,
				status: "uploading" as const,
				reservedRevision,
			})),
		);
		this.changed();
		return this.publicState();
	}

	attachPrepared(
		inputs: readonly PreparedAttachmentInput[],
		expectedRevision: number,
	): PublicAttachmentState {
		this.assertMutable(expectedRevision);
		if (!Array.isArray(inputs) || inputs.length === 0) {
			throw new AttachmentError("At least one prepared attachment is required.", 400);
		}
		if (this.items.some((item) => item.status !== "ready")) {
			throw new AttachmentError(
				"Current attachments must be ready before attaching retained images.",
			);
		}
		if (this.items.length + inputs.length > this.options.limits.maxImages) {
			throw new AttachmentError(
				`Attachment count exceeds the maximum of ${this.options.limits.maxImages}.`,
				413,
			);
		}
		const ids = new Set(this.items.map((item) => item.id));
		const existingBytes = this.items.flatMap((item) =>
			item.prepared ? [item.prepared.bytes] : [],
		);
		const additions = inputs.map((input) => {
			const prepared = validatePrepared(input.prepared, this.options.limits);
			const reservation = normalizeReservation(
				{ id: input.id, name: input.name, size: prepared.bytes.byteLength },
				this.options.limits,
			);
			if (ids.has(reservation.id)) throw new AttachmentError("Attachment id is duplicate.", 400);
			ids.add(reservation.id);
			if (
				existingBytes.some((bytes) => bytes.equals(prepared.bytes)) ||
				additionsContainBytes(inputs, input, prepared.bytes)
			) {
				throw new AttachmentError("Prepared attachment is a duplicate of the draft.");
			}
			return { reservation, prepared };
		});
		const total =
			this.reservedSourceBytes() +
			additions.reduce((sum, item) => sum + item.prepared.bytes.byteLength, 0);
		if (total > this.options.limits.maxPromptBytes) {
			throw new AttachmentError("Combined prepared attachments are too large.", 413);
		}
		const reservedRevision = this.revision + 1;
		this.items.push(
			...additions.map(({ reservation, prepared }) => ({
				...reservation,
				status: "ready" as const,
				reservedRevision,
				prepared,
			})),
		);
		this.changed();
		return this.publicState();
	}

	upload(
		id: string,
		source: Uint8Array,
		expectedRevision: number,
		signal?: AbortSignal,
	): PublicAttachmentState {
		this.assertOpen();
		if (this.sendToken) throw new AttachmentError("Attachments are reserved for sending.");
		const item = this.requireItem(id);
		this.assertUploadRevision(item, expectedRevision);
		if (item.status !== "uploading" && !(item.status === "error" && !item.source)) {
			throw new AttachmentError("Attachment is not waiting for an upload.");
		}
		if (source.byteLength !== item.size) {
			throw new AttachmentError("Attachment upload size does not match its reservation.", 400);
		}
		if (source.byteLength === 0 || source.byteLength > this.options.limits.maxImageBytes) {
			throw new AttachmentError("Attachment upload is outside the allowed size.", 413);
		}
		item.source = Buffer.from(source);
		this.schedule(item, signal);
		return this.publicState();
	}

	failUpload(id: string, error: unknown): PublicAttachmentState {
		this.assertOpen();
		if (this.sendToken) throw new AttachmentError("Attachments are reserved for sending.");
		const item = this.requireItem(id);
		if (item.status !== "uploading") {
			throw new AttachmentError("Attachment upload is no longer pending.");
		}
		item.status = "error";
		item.error = publicError(error);
		this.changed();
		return this.publicState();
	}

	retry(id: string, expectedRevision: number, signal?: AbortSignal): PublicAttachmentState {
		this.assertMutable(expectedRevision);
		const item = this.requireItem(id);
		if (item.status !== "error" || !item.source) {
			throw new AttachmentError("Attachment is not available for retry.");
		}
		this.schedule(item, signal);
		return this.publicState();
	}

	cancelInFlight(message: string): boolean {
		this.assertOpen();
		if (this.sendToken) return false;
		let changed = false;
		for (const item of this.items) {
			if (item.status === "uploading") {
				item.status = "error";
				item.error = publicError(message);
				changed = true;
				continue;
			}
			if (item.status === "processing") {
				item.controller?.abort();
				item.operation = undefined;
				item.controller = undefined;
				item.status = "error";
				item.error = publicError(message);
				item.prepared = undefined;
				changed = true;
			}
		}
		if (changed) this.changed();
		return changed;
	}

	reorder(ids: string[], expectedRevision: number): PublicAttachmentState {
		this.assertMutable(expectedRevision);
		if (
			!Array.isArray(ids) ||
			ids.length !== this.items.length ||
			new Set(ids).size !== ids.length ||
			ids.some((id) => typeof id !== "string")
		) {
			throw new AttachmentError("Attachment order must contain every id exactly once.", 400);
		}
		const byId = new Map(this.items.map((item) => [item.id, item]));
		const ordered = ids.map((id) => byId.get(id));
		if (ordered.some((item) => !item)) {
			throw new AttachmentError("Attachment order contains an unknown id.", 400);
		}
		this.items.splice(0, this.items.length, ...(ordered as AttachmentItem[]));
		this.changed();
		return this.publicState();
	}

	remove(id: string, expectedRevision: number): PublicAttachmentState {
		this.assertMutable(expectedRevision);
		const index = this.items.findIndex((item) => item.id === id);
		if (index === -1) throw new AttachmentError("Attachment was not found.", 404);
		const [removed] = this.items.splice(index, 1);
		this.releaseItem(removed);
		this.changed();
		return this.publicState();
	}

	clear(expectedRevision: number): PublicAttachmentState {
		this.assertMutable(expectedRevision);
		this.releaseItems();
		this.changed();
		return this.publicState();
	}

	preview(id: string): PreparedAttachment {
		this.assertOpen();
		const item = this.requireItem(id);
		if (item.status !== "ready" || !item.prepared) {
			throw new AttachmentError("Attachment preview is not ready.", 404);
		}
		return clonePrepared(item.prepared);
	}

	beginSend(ids: string[], expectedRevision: number): SendReservation {
		this.assertMutable(expectedRevision);
		if (
			ids.length !== this.items.length ||
			ids.some((id, index) => id !== this.items[index]?.id) ||
			this.items.some((item) => item.status !== "ready" || !item.prepared)
		) {
			throw new AttachmentError("Every ordered attachment must be ready before sending.");
		}
		const token = randomUUID();
		this.sendToken = token;
		this.notify();
		return {
			token,
			images: this.items.map((item) => ({
				name: item.name,
				mimeType: item.prepared?.mimeType ?? "",
				data: item.prepared?.bytes.toString("base64") ?? "",
			})),
		};
	}

	finishSend(token: string, committed: boolean): PublicAttachmentState {
		this.assertOpen();
		if (!this.sendToken || token !== this.sendToken) {
			throw new AttachmentError("Attachment send reservation is stale.");
		}
		this.sendToken = undefined;
		if (committed) {
			this.releaseItems();
			this.changed();
		} else {
			this.notify();
		}
		return this.publicState();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.sendToken = undefined;
		this.releaseItems();
		this.revision += 1;
		this.notify();
	}

	private schedule(item: AttachmentItem, externalSignal?: AbortSignal): void {
		const operation = Symbol(item.id);
		const controller = new AbortController();
		let removeExternalAbort: (() => void) | undefined;
		if (externalSignal) {
			const abort = () => controller.abort();
			if (externalSignal.aborted) controller.abort();
			else {
				externalSignal.addEventListener("abort", abort, { once: true });
				removeExternalAbort = () => externalSignal.removeEventListener("abort", abort);
			}
		}
		item.operation = operation;
		item.controller = controller;
		item.status = "processing";
		item.error = undefined;
		item.prepared = undefined;
		this.queue.push({ item, operation, controller, removeExternalAbort });
		this.changed();
		this.pump();
	}

	private pump(): void {
		while (this.active < this.concurrency && this.queue.length > 0) {
			const job = this.queue.shift();
			if (!job) break;
			if (job.controller.signal.aborted) {
				this.finishProcessing(job, undefined, abortError());
				continue;
			}
			this.active += 1;
			void this.options
				.process(Buffer.from(job.item.source ?? []), job.controller.signal)
				.then(
					(prepared) => this.finishProcessing(job, prepared),
					(error) => this.finishProcessing(job, undefined, error),
				)
				.finally(() => {
					this.active -= 1;
					this.pump();
					this.resolveIdle();
				});
		}
		this.resolveIdle();
	}

	private finishProcessing(
		job: ProcessingJob,
		prepared?: PreparedAttachment,
		error?: unknown,
	): void {
		job.removeExternalAbort?.();
		if (!this.isCurrent(job.item, job.operation)) return;
		job.item.operation = undefined;
		job.item.controller = undefined;
		if (error || job.controller.signal.aborted) {
			job.item.status = "error";
			job.item.error = publicError(job.controller.signal.aborted ? abortError() : error);
			job.item.prepared = undefined;
			this.changed();
			return;
		}
		try {
			if (!prepared?.bytes.length || !prepared.mimeType.startsWith("image/")) {
				throw new Error("Image processing returned an invalid result.");
			}
			const otherPreparedBytes = this.items.reduce(
				(total, item) => total + (item === job.item ? 0 : (item.prepared?.bytes.byteLength ?? 0)),
				0,
			);
			if (otherPreparedBytes + prepared.bytes.byteLength > this.options.limits.maxPromptBytes) {
				throw new Error("Combined processed attachments are too large.");
			}
			const maximumResident =
				this.options.limits.maxPromptBytes + this.options.limits.maxImageBytes * this.concurrency;
			if (this.residentBytes() + prepared.bytes.byteLength > maximumResident) {
				throw new Error("Attachment memory limit exceeded.");
			}
			job.item.prepared = clonePrepared(prepared);
			job.item.source = undefined;
			job.item.status = "ready";
			job.item.error = undefined;
		} catch (processingError) {
			job.item.status = "error";
			job.item.error = publicError(processingError);
			job.item.prepared = undefined;
		}
		this.changed();
	}

	private isCurrent(item: AttachmentItem, operation: symbol): boolean {
		return !this.closed && item.operation === operation && this.items.includes(item);
	}

	private requireItem(id: string): AttachmentItem {
		const item = this.items.find((candidate) => candidate.id === id);
		if (!item) throw new AttachmentError("Attachment was not found.", 404);
		return item;
	}

	private assertUploadRevision(item: AttachmentItem, expectedRevision: number): void {
		if (
			!Number.isSafeInteger(expectedRevision) ||
			expectedRevision < item.reservedRevision ||
			expectedRevision > this.revision
		) {
			throw new AttachmentError(
				`Attachment revision mismatch; current revision is ${this.revision}.`,
			);
		}
	}

	private assertMutable(expectedRevision: number): void {
		this.assertOpen();
		if (this.sendToken) throw new AttachmentError("Attachments are reserved for sending.");
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.revision) {
			throw new AttachmentError(
				`Attachment revision mismatch; current revision is ${this.revision}.`,
			);
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new AttachmentError("Attachment store is closed.", 410);
	}

	private changed(): void {
		this.revision += 1;
		this.notify();
	}

	private notify(): void {
		this.options.onChange?.(this.publicState());
	}

	private releaseItem(item: AttachmentItem): void {
		item.controller?.abort();
		item.operation = undefined;
		item.controller = undefined;
		item.source = undefined;
		item.prepared = undefined;
	}

	private releaseItems(): void {
		for (const item of this.items) this.releaseItem(item);
		this.items.length = 0;
	}

	private resolveIdle(): void {
		if (this.active !== 0 || this.queue.length !== 0) return;
		for (const resolve of this.idleWaiters) resolve();
		this.idleWaiters.clear();
	}

	private phase(): AttachmentPhase {
		if (this.closed) return "closed";
		if (this.sendToken) return "reserved";
		if (this.items.length === 0) return "empty";
		if (this.items.some((item) => item.status === "error")) return "blocked";
		if (this.items.some((item) => item.status === "processing")) return "processing";
		if (this.items.some((item) => item.status === "uploading")) return "uploading";
		return "ready";
	}
}

function normalizeReservation(
	input: AttachmentReservationInput,
	limits: AttachmentLimits,
): AttachmentReservationInput {
	if (!input || typeof input.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.id)) {
		throw new AttachmentError("Attachment id is invalid.", 400);
	}
	if (
		typeof input.name !== "string" ||
		input.name.length === 0 ||
		input.name.length > 255 ||
		hasControlCharacter(input.name)
	) {
		throw new AttachmentError("Attachment name is invalid.", 400);
	}
	if (!Number.isSafeInteger(input.size) || input.size <= 0) {
		throw new AttachmentError("Attachment size is invalid.", 400);
	}
	if (input.size > limits.maxImageBytes) {
		throw new AttachmentError("Attachment exceeds the per-image maximum.", 413);
	}
	if (
		input.mimeType !== undefined &&
		(typeof input.mimeType !== "string" || input.mimeType.length > 128)
	) {
		throw new AttachmentError("Attachment MIME type is invalid.", 400);
	}
	return { id: input.id, name: input.name, size: input.size, mimeType: input.mimeType };
}

function validatePrepared(
	prepared: PreparedAttachment,
	limits: AttachmentLimits,
): PreparedAttachment {
	if (
		!prepared ||
		!Buffer.isBuffer(prepared.bytes) ||
		prepared.bytes.length === 0 ||
		prepared.bytes.length > limits.maxImageBytes ||
		typeof prepared.mimeType !== "string" ||
		!/^image\/[a-z0-9.+-]{1,64}$/i.test(prepared.mimeType)
	) {
		throw new AttachmentError("Prepared attachment is invalid.", 400);
	}
	return clonePrepared(prepared);
}

function additionsContainBytes(
	inputs: readonly PreparedAttachmentInput[],
	current: PreparedAttachmentInput,
	bytes: Buffer,
): boolean {
	const currentIndex = inputs.indexOf(current);
	return inputs
		.slice(0, currentIndex)
		.some((input) => Buffer.isBuffer(input.prepared?.bytes) && input.prepared.bytes.equals(bytes));
}

function validateLimits(limits: AttachmentLimits): void {
	for (const value of [limits.maxImages, limits.maxImageBytes, limits.maxPromptBytes]) {
		if (!Number.isSafeInteger(value) || value <= 0) {
			throw new Error("Attachment limits must be positive integers.");
		}
	}
	if (limits.maxImageBytes > limits.maxPromptBytes) {
		throw new Error("Attachment per-image limit cannot exceed the combined limit.");
	}
}

function hasControlCharacter(value: string): boolean {
	return [...value].some((character) => {
		const code = character.charCodeAt(0);
		return code < 32 || code === 127;
	});
}

function clonePrepared(prepared: PreparedAttachment): PreparedAttachment {
	return {
		...prepared,
		bytes: Buffer.from(prepared.bytes),
		notes: [...(prepared.notes ?? [])],
	};
}

function publicError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const cleaned = [...message]
		.map((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127 ? " " : character;
		})
		.join("")
		.replace(/\s+/g, " ")
		.trim();
	return (cleaned || "Image processing failed.").slice(0, 240);
}

function abortError(): Error {
	const error = new Error("Image processing was cancelled.");
	error.name = "AbortError";
	return error;
}
