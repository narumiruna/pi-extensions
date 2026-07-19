export function initialState() {
	return {
		sequence: 0,
		session: undefined,
		messages: [],
		tools: [],
		activity: "idle",
		closed: false,
		connected: false,
		stale: false,
		needsSnapshot: false,
		pending: false,
		readingImages: 0,
		leaseClaimed: false,
		leaseGeneration: 0,
		draftRevision: 0,
		authoritativeText: "",
		textDirty: false,
		attachmentRevision: 0,
		attachmentPhase: "empty",
		imageLimits: undefined,
		sentImages: {
			revision: 0,
			enabled: false,
			items: [],
			totalBytes: 0,
			maxImages: 0,
			maxBytes: 0,
		},
		following: true,
		unseenUpdateIds: [],
		text: "",
		images: [],
		error: "",
	};
}

export function applySnapshot(current, snapshot) {
	let next = current;
	if (Number.isSafeInteger(snapshot?.sequence) && snapshot.sequence >= current.sequence) {
		next = {
			...current,
			sequence: snapshot.sequence,
			session: snapshot.session,
			messages: Array.isArray(snapshot.messages) ? snapshot.messages : [],
			tools: Array.isArray(snapshot.tools) ? snapshot.tools : [],
			activity: snapshot.activity ?? "idle",
			closed: Boolean(snapshot.closed),
			needsSnapshot: false,
		};
	}
	return applySentImages(
		applyImageLimits(
			applyAttachments(applyDraft(next, snapshot?.draft), snapshot?.attachments),
			snapshot?.imageLimits,
		),
		snapshot?.sentImages,
	);
}

export function applyDraft(current, draft) {
	if (
		!Number.isSafeInteger(draft?.revision) ||
		draft.revision < current.draftRevision ||
		typeof draft.text !== "string"
	) {
		return current;
	}
	const preserveLocal = current.textDirty && current.text !== draft.text;
	return {
		...current,
		draftRevision: draft.revision,
		authoritativeText: draft.text,
		text: preserveLocal ? current.text : draft.text,
		textDirty: preserveLocal,
	};
}

export function editDraftText(current, text) {
	return invalidateSendAttempt({
		...current,
		text,
		textDirty: text !== current.authoritativeText,
		error: "",
	});
}

export function acknowledgeDraftText(current, draft, submittedText) {
	if (current.text === submittedText) {
		return applyDraft({ ...current, textDirty: false }, draft);
	}
	return applyDraft(current, draft);
}

export function applyImageLimits(current, limits) {
	if (
		!limits ||
		!["maxImages", "maxImageBytes", "maxBatchBytes", "maxImagePixels"].every(
			(key) => Number.isSafeInteger(limits[key]) && limits[key] > 0,
		)
	) {
		return current;
	}
	return {
		...current,
		imageLimits: {
			maxImages: limits.maxImages,
			maxImageBytes: limits.maxImageBytes,
			maxBatchBytes: limits.maxBatchBytes,
			maxImagePixels: limits.maxImagePixels,
		},
	};
}

export function applySentImages(current, sentImages) {
	if (
		!Number.isSafeInteger(sentImages?.revision) ||
		sentImages.revision < current.sentImages.revision ||
		!Array.isArray(sentImages.items)
	) {
		return current;
	}
	return {
		...current,
		sentImages: {
			revision: sentImages.revision,
			enabled: Boolean(sentImages.enabled),
			items: sentImages.items
				.filter((item) => item && typeof item.id === "string")
				.map((item) => ({ ...item })),
			totalBytes: Number.isSafeInteger(sentImages.totalBytes) ? sentImages.totalBytes : 0,
			maxImages: Number.isSafeInteger(sentImages.maxImages) ? sentImages.maxImages : 0,
			maxBytes: Number.isSafeInteger(sentImages.maxBytes) ? sentImages.maxBytes : 0,
		},
	};
}

export function applyAttachments(current, attachments) {
	if (
		!Number.isSafeInteger(attachments?.revision) ||
		attachments.revision < current.attachmentRevision ||
		!Array.isArray(attachments.items)
	) {
		return current;
	}
	const revisionChanged = attachments.revision !== current.attachmentRevision;
	const images = attachments.items
		.filter((item) => item && typeof item.id === "string" && typeof item.status === "string")
		.map((item) => ({
			...item,
			notes: Array.isArray(item.notes) ? [...item.notes] : [],
		}));
	return {
		...current,
		attachmentRevision: attachments.revision,
		attachmentPhase: typeof attachments.phase === "string" ? attachments.phase : "blocked",
		images,
		readingImages: images.filter(
			(image) => image.status === "uploading" || image.status === "processing",
		).length,
		outbox: revisionChanged ? undefined : current.outbox,
		lastDelivery: revisionChanged ? undefined : current.lastDelivery,
	};
}

export function applyConversationEvent(current, event) {
	if (!Number.isSafeInteger(event?.sequence) || event.sequence <= current.sequence) return current;
	if (event.sequence !== current.sequence + 1) return { ...current, needsSnapshot: true };
	if (event.type === "snapshot") {
		return event.payload?.sequence === event.sequence
			? applySnapshot(current, event.payload)
			: { ...current, needsSnapshot: true };
	}
	const next = { ...current, sequence: event.sequence };
	switch (event.type) {
		case "message":
			if (event.payload?.id) next.messages = upsertById(current.messages, event.payload);
			break;
		case "tool":
			if (event.payload?.id) next.tools = upsertById(current.tools, event.payload);
			break;
		case "activity":
			if (["idle", "running", "ended"].includes(event.payload?.activity)) {
				next.activity = event.payload.activity;
			}
			break;
		case "session-ended":
			next.closed = true;
			next.activity = "ended";
			break;
	}
	return next;
}

export function applyLease(current, lease, clientId, claimed = false) {
	const generation = Number.isSafeInteger(lease?.generation) ? lease.generation : 0;
	if (generation < current.leaseGeneration) {
		return claimed && !current.leaseClaimed ? { ...current, leaseClaimed: true } : current;
	}
	return {
		...current,
		leaseClaimed: current.leaseClaimed || claimed,
		leaseGeneration: generation,
		stale: lease?.activeClientId !== clientId,
	};
}

export function prepareSend(current, requestId, delivery = "next") {
	const attempt = current.outbox ?? {
		requestId,
		text: current.text,
		draftRevision: current.draftRevision,
		attachmentRevision: current.attachmentRevision,
		attachmentIds: current.images.map((image) => image.id),
		images: [...current.images],
		delivery,
	};
	return {
		state: { ...current, pending: true, error: "", outbox: attempt },
		attempt,
	};
}

export function completeSend(current, attempt, delivery) {
	const submittedImageIds = new Set(attempt.images.map((image) => image.id));
	return {
		...current,
		pending: false,
		text: current.text === attempt.text ? "" : current.text,
		images: current.images.filter((image) => !submittedImageIds.has(image.id)),
		outbox: current.outbox === attempt ? undefined : current.outbox,
		error: "",
		lastDelivery: delivery,
	};
}

export function failSend(current, attempt, error) {
	return {
		...current,
		pending: false,
		outbox: current.outbox === attempt ? attempt : current.outbox,
		error,
	};
}

export function invalidateSendAttempt(current) {
	return { ...current, outbox: undefined, lastDelivery: undefined };
}

export function clearDraftImages(current) {
	return invalidateSendAttempt({ ...current, images: [], error: "" });
}

export function setNearBottom(current, nearBottom) {
	if (!nearBottom) return current.following ? { ...current, following: false } : current;
	if (current.following && current.unseenUpdateIds.length === 0) return current;
	return { ...current, following: true, unseenUpdateIds: [] };
}

export function noteUnseenUpdate(current, key) {
	if (current.following || current.unseenUpdateIds.includes(key)) return current;
	return { ...current, unseenUpdateIds: [...current.unseenUpdateIds, key] };
}

export function followLatest(current) {
	return { ...current, following: true, unseenUpdateIds: [] };
}

export function moveImage(images, id, direction) {
	const from = images.findIndex((image) => image.id === id);
	if (from === -1) return [...images];
	const to = Math.max(0, Math.min(images.length - 1, from + direction));
	if (to === from) return [...images];
	const next = [...images];
	const [image] = next.splice(from, 1);
	if (image) next.splice(to, 0, image);
	return next;
}

export function moveImageBefore(images, id, targetId) {
	if (id === targetId) return [...images];
	const from = images.findIndex((image) => image.id === id);
	const target = images.findIndex((image) => image.id === targetId);
	if (from === -1 || target === -1) return [...images];
	const next = images.filter((image) => image.id !== id);
	const targetIndex = next.findIndex((image) => image.id === targetId);
	if (targetIndex === -1) return [...images];
	next.splice(targetIndex, 0, images[from]);
	return next;
}

export function moveImageAfter(images, id, targetId) {
	if (id === targetId) return [...images];
	const from = images.findIndex((image) => image.id === id);
	const target = images.findIndex((image) => image.id === targetId);
	if (from === -1 || target === -1) return [...images];
	const next = images.filter((image) => image.id !== id);
	const targetIndex = next.findIndex((image) => image.id === targetId);
	if (targetIndex === -1) return [...images];
	next.splice(targetIndex + 1, 0, images[from]);
	return next;
}

export function upsertById(items, value) {
	const index = items.findIndex((item) => item.id === value.id);
	if (index < 0) return [...items, value];
	const next = [...items];
	next[index] = value;
	return next;
}

export function canSend(current) {
	return Boolean(
		current.connected &&
			!current.closed &&
			!current.stale &&
			!current.pending &&
			current.readingImages === 0 &&
			(current.images.length === 0 || current.attachmentPhase === "ready") &&
			(current.text.trim() || current.images.length > 0),
	);
}

export function deliveryNotice(current) {
	if (current.lastDelivery === "immediate") return "Message accepted by Pi.";
	if (current.lastDelivery === "followUp") return "Queued to run after Pi finishes.";
	if (current.lastDelivery === "steer") return "Steering message accepted by Pi.";
	return "";
}

export function busyLabel(current) {
	if (!current.connected) return "Reconnect to send";
	if (current.closed) return "Session ended";
	if (current.stale) return "Tab is read-only";
	return current.activity === "running" ? "Queue next" : "Send";
}
