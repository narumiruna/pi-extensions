import { createHash, randomUUID } from "node:crypto";

export interface DraftSettings {
	maxTextBytes: number;
	maxMutationRecords?: number;
}

export interface PublicDraftState {
	revision: number;
	text: string;
	attachmentRevision: number;
	attachmentIds: string[];
}

export interface DraftSendReservation {
	token: string;
	revision: number;
	text: string;
	attachmentRevision: number;
	attachmentIds: string[];
}

interface MutationRecord {
	digest: string;
	result: PublicDraftState;
}

export class DraftError extends Error {
	constructor(
		message: string,
		readonly status = 409,
	) {
		super(message);
		this.name = "DraftError";
	}
}

export class DraftStore {
	private readonly mutations = new Map<string, MutationRecord>();
	private readonly reservations = new Map<string, DraftSendReservation>();
	private readonly maxMutationRecords: number;
	private revision = 0;
	private text = "";
	private attachmentRevision = 0;
	private attachmentIds: string[] = [];
	private closed = false;

	constructor(private readonly settings: DraftSettings) {
		if (!Number.isSafeInteger(settings.maxTextBytes) || settings.maxTextBytes <= 0) {
			throw new Error("Draft maxTextBytes must be a positive integer.");
		}
		this.maxMutationRecords = settings.maxMutationRecords ?? 128;
		if (!Number.isSafeInteger(this.maxMutationRecords) || this.maxMutationRecords <= 0) {
			throw new Error("Draft maxMutationRecords must be a positive integer.");
		}
	}

	publicState(): PublicDraftState {
		return {
			revision: this.revision,
			text: this.text,
			attachmentRevision: this.attachmentRevision,
			attachmentIds: [...this.attachmentIds],
		};
	}

	residentBytes(): number {
		return Buffer.byteLength(this.text);
	}

	setText(text: string, expectedRevision: number, mutationId: string): PublicDraftState {
		this.assertOpen();
		const normalized = normalizeText(text, this.settings.maxTextBytes);
		const id = normalizeMutationId(mutationId);
		const digest = mutationDigest(normalized);
		const prior = this.mutations.get(id);
		if (prior) {
			if (prior.digest !== digest) throw new DraftError("Draft mutation id was reused.");
			return cloneState(prior.result);
		}
		this.assertRevision(expectedRevision);
		if (normalized !== this.text) {
			this.text = normalized;
			this.revision += 1;
		}
		const result = this.publicState();
		this.mutations.set(id, { digest, result: cloneState(result) });
		this.evictMutations();
		return result;
	}

	syncAttachments(ids: readonly string[], attachmentRevision: number): PublicDraftState {
		this.assertOpen();
		const normalized = normalizeAttachmentIds(ids);
		if (!Number.isSafeInteger(attachmentRevision) || attachmentRevision < 0) {
			throw new DraftError("Attachment revision is invalid.", 400);
		}
		if (sameIds(normalized, this.attachmentIds)) return this.publicState();
		this.attachmentIds = normalized;
		this.attachmentRevision = attachmentRevision;
		this.revision += 1;
		return this.publicState();
	}

	beginSend(expectedRevision: number): DraftSendReservation {
		this.assertOpen();
		this.assertRevision(expectedRevision);
		if (!this.text.trim() && this.attachmentIds.length === 0) {
			throw new DraftError("Draft cannot be empty.", 400);
		}
		const reservation: DraftSendReservation = {
			token: randomUUID(),
			revision: this.revision,
			text: this.text,
			attachmentRevision: this.attachmentRevision,
			attachmentIds: [...this.attachmentIds],
		};
		this.reservations.set(reservation.token, reservation);
		return cloneReservation(reservation);
	}

	finishSend(
		token: string,
		committed: boolean,
		attachments?: { revision: number; ids: readonly string[] },
	): PublicDraftState {
		this.assertOpen();
		const reservation = this.reservations.get(token);
		if (!reservation) throw new DraftError("Draft send reservation is stale.");
		this.reservations.delete(token);
		if (!committed) return this.publicState();
		let changed = false;
		if (this.text === reservation.text && this.text !== "") {
			this.text = "";
			changed = true;
		}
		if (attachments && sameIds(this.attachmentIds, reservation.attachmentIds)) {
			const normalized = normalizeAttachmentIds(attachments.ids);
			if (!Number.isSafeInteger(attachments.revision) || attachments.revision < 0) {
				throw new DraftError("Attachment revision is invalid.", 400);
			}
			if (
				!sameIds(this.attachmentIds, normalized) ||
				this.attachmentRevision !== attachments.revision
			) {
				this.attachmentIds = normalized;
				this.attachmentRevision = attachments.revision;
				changed = true;
			}
		}
		if (changed) this.revision += 1;
		return this.publicState();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.text = "";
		this.attachmentIds = [];
		this.attachmentRevision = 0;
		this.mutations.clear();
		this.reservations.clear();
		this.revision += 1;
	}

	private assertRevision(expectedRevision: number): void {
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.revision) {
			throw new DraftError(`Draft revision mismatch; current revision is ${this.revision}.`);
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new DraftError("Draft store is closed.", 410);
	}

	private evictMutations(): void {
		while (this.mutations.size > this.maxMutationRecords) {
			const oldest = this.mutations.keys().next().value;
			if (typeof oldest !== "string") return;
			this.mutations.delete(oldest);
		}
	}
}

function normalizeText(value: string, maxBytes: number): string {
	if (typeof value !== "string") throw new DraftError("Draft text is invalid.", 400);
	if (Buffer.byteLength(value) > maxBytes) throw new DraftError("Draft text is too large.", 413);
	return value;
}

function normalizeMutationId(value: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
		throw new DraftError("Draft mutation id is invalid.", 400);
	}
	return value;
}

function normalizeAttachmentIds(values: readonly string[]): string[] {
	if (!Array.isArray(values)) throw new DraftError("Attachment ids are invalid.", 400);
	const result = values.map((value) => {
		if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
			throw new DraftError("Attachment id is invalid.", 400);
		}
		return value;
	});
	if (new Set(result).size !== result.length) {
		throw new DraftError("Attachment ids contain a duplicate.", 400);
	}
	return result;
}

function mutationDigest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((id, index) => id === right[index]);
}

function cloneState(state: PublicDraftState): PublicDraftState {
	return { ...state, attachmentIds: [...state.attachmentIds] };
}

function cloneReservation(reservation: DraftSendReservation): DraftSendReservation {
	return { ...reservation, attachmentIds: [...reservation.attachmentIds] };
}
