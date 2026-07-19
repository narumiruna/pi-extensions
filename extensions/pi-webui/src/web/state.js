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
		following: true,
		unseenUpdateIds: [],
		text: "",
		images: [],
		error: "",
	};
}

export function applySnapshot(current, snapshot) {
	if (!Number.isSafeInteger(snapshot?.sequence) || snapshot.sequence < current.sequence)
		return current;
	return {
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
