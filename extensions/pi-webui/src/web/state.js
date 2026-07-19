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
		text: "",
		images: [],
		error: "",
	};
}

export function applySnapshot(current, snapshot) {
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

export function applyLease(current, lease, clientId) {
	return { ...current, stale: lease?.activeClientId !== clientId };
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
	return current.activity === "running" ? "Send next" : "Send now";
}
