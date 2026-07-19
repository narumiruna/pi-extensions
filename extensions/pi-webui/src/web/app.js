import {
	applyConversationEvent,
	applyLease,
	applySnapshot,
	busyLabel,
	canSend,
	completeSend,
	deliveryNotice,
	failSend,
	initialState,
	invalidateSendAttempt,
	prepareSend,
} from "./state.js";

const clientId = crypto.randomUUID();
let model = initialState();
let events;
let reconnectTimer;
let reconnectDelay = 500;
let snapshotRefresh;
let snapshotTarget = 0;

const ui = {
	project: document.querySelector("#project-name"),
	session: document.querySelector("#session-name"),
	connection: document.querySelector("#connection-status"),
	empty: document.querySelector("#empty-state"),
	transcript: document.querySelector("#transcript"),
	blocking: document.querySelector("#blocking-state"),
	blockingTitle: document.querySelector("#blocking-title"),
	blockingMessage: document.querySelector("#blocking-message"),
	composer: document.querySelector("#composer"),
	input: document.querySelector("#message-input"),
	imageInput: document.querySelector("#image-input"),
	previews: document.querySelector("#image-previews"),
	status: document.querySelector("#composer-status"),
	error: document.querySelector("#composer-error"),
	send: document.querySelector("#send-next"),
	steer: document.querySelector("#steer"),
};

ui.input.addEventListener("input", () => {
	model = invalidateSendAttempt({ ...model, text: ui.input.value, error: "" });
	renderComposer();
});
ui.composer.addEventListener("submit", (event) => {
	event.preventDefault();
	void send(false);
});
ui.steer.addEventListener("click", () => void send(true));
ui.imageInput.addEventListener("change", () => {
	void addFiles(ui.imageInput.files);
	ui.imageInput.value = "";
});
ui.input.addEventListener("keydown", (event) => {
	if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
		event.preventDefault();
		void send(false);
	}
});
document.addEventListener("paste", (event) => {
	const files = [...(event.clipboardData?.files ?? [])].filter((file) =>
		file.type.startsWith("image/"),
	);
	if (files.length === 0 || model.pending) return;
	event.preventDefault();
	void addFiles(files);
});
ui.composer.addEventListener("dragover", (event) => {
	if (
		!model.pending &&
		[...(event.dataTransfer?.items ?? [])].some((item) => item.kind === "file")
	) {
		event.preventDefault();
	}
});
ui.composer.addEventListener("drop", (event) => {
	const files = [...(event.dataTransfer?.files ?? [])].filter((file) =>
		file.type.startsWith("image/"),
	);
	if (files.length === 0 || model.pending) return;
	event.preventDefault();
	void addFiles(files);
});

void initialize();

async function initialize() {
	try {
		await refreshSnapshot();
		await claimLease();
		connectEvents();
	} catch (error) {
		model = { ...model, connected: false, error: errorMessage(error) };
		render();
		scheduleReconnect();
	}
}

async function refreshSnapshot(requiredSequence = 0) {
	snapshotTarget = Math.max(snapshotTarget, requiredSequence);
	if (!snapshotRefresh) {
		snapshotRefresh = (async () => {
			do {
				const response = await fetch("/api/state", { cache: "no-store" });
				if (!response.ok) throw new Error(await responseError(response));
				model = applySnapshot(model, await response.json());
				render();
			} while (model.sequence < snapshotTarget);
		})().finally(() => {
			snapshotRefresh = undefined;
		});
	}
	return snapshotRefresh;
}

async function claimLease() {
	const response = await fetch("/api/lease", {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Pi-Web-Client": clientId },
		body: JSON.stringify({ clientId }),
	});
	if (!response.ok) throw new Error(await responseError(response));
	model = applyLease(model, await response.json(), clientId);
	render();
}

function connectEvents() {
	clearTimeout(reconnectTimer);
	events?.close();
	events = new EventSource(`/api/events?since=${model.sequence}`);
	events.addEventListener("open", () => {
		reconnectDelay = 500;
		model = { ...model, connected: true, error: "" };
		render();
	});
	events.addEventListener("conversation", (event) => {
		const conversationEvent = JSON.parse(event.data);
		model = applyConversationEvent(model, conversationEvent);
		if (model.needsSnapshot) {
			void refreshSnapshot(conversationEvent.sequence).catch(connectionFailure);
			return;
		}
		render();
	});
	events.addEventListener("snapshot", (event) => {
		model = applySnapshot(model, JSON.parse(event.data));
		render();
	});
	events.addEventListener("lease", (event) => {
		model = applyLease(model, JSON.parse(event.data), clientId);
		render();
	});
	events.addEventListener("session-ended", () => {
		model = { ...model, closed: true, activity: "ended", connected: false };
		events?.close();
		render();
	});
	events.addEventListener("error", () => {
		events?.close();
		if (model.closed) return;
		model = { ...model, connected: false };
		render();
		scheduleReconnect();
	});
}

function scheduleReconnect() {
	if (model.closed || reconnectTimer) return;
	reconnectTimer = setTimeout(async () => {
		reconnectTimer = undefined;
		try {
			await refreshSnapshot();
			if (!model.leaseClaimed) await claimLease();
			connectEvents();
		} catch (error) {
			connectionFailure(error);
		}
	}, reconnectDelay);
	reconnectDelay = Math.min(reconnectDelay * 2, 5_000);
}

function connectionFailure(error) {
	model = { ...model, connected: false, error: errorMessage(error) };
	render();
	scheduleReconnect();
}

async function send(steer) {
	if (!canSend(model)) return;
	const prepared = prepareSend(model, crypto.randomUUID(), steer ? "steer" : "next");
	const attempt = prepared.attempt;
	model = prepared.state;
	renderComposer();
	const payload = {
		requestId: attempt.requestId,
		text: attempt.text,
		images: attempt.images.map(({ name, mimeType, data }) => ({ name, mimeType, data })),
		delivery: attempt.delivery,
	};
	try {
		const response = await fetch("/api/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Pi-Web-Client": clientId },
			body: JSON.stringify(payload),
		});
		if (!response.ok) {
			const message = await responseError(response);
			model = invalidateSendAttempt(model);
			throw new Error(message);
		}
		const accepted = await response.json();
		for (const image of attempt.images) URL.revokeObjectURL(image.previewUrl);
		model = completeSend(model, attempt, accepted.delivery);
		render();
		ui.input.focus();
	} catch (error) {
		model = failSend(model, attempt, errorMessage(error));
		render();
	}
}

async function addFiles(fileList) {
	if (model.pending) return;
	const supported = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
	const files = [...(fileList ?? [])];
	if (model.images.length + files.length > 8) {
		model = { ...model, error: "You can attach at most 8 images." };
		render();
		return;
	}
	model = { ...model, readingImages: model.readingImages + 1 };
	renderComposer();
	try {
		for (const file of files) {
			if (model.images.length >= 8) {
				model = { ...model, error: "You can attach at most 8 images." };
				render();
				break;
			}
			if (!supported.has(file.type)) {
				model = { ...model, error: `${file.name || "Image"} is not a supported image.` };
				render();
				continue;
			}
			if (file.size > 10 * 1024 * 1024) {
				model = { ...model, error: `${file.name || "Image"} is larger than 10 MB.` };
				render();
				continue;
			}
			try {
				const data = await readBase64(file);
				model = invalidateSendAttempt({
					...model,
					images: [
						...model.images,
						{
							id: crypto.randomUUID(),
							name: file.name || "Pasted image",
							mimeType: file.type,
							data,
							previewUrl: URL.createObjectURL(file),
						},
					],
					error: "",
				});
				render();
			} catch (error) {
				model = { ...model, error: errorMessage(error) };
				render();
			}
		}
	} finally {
		model = { ...model, readingImages: Math.max(0, model.readingImages - 1) };
		renderComposer();
	}
}

function removeImage(id) {
	if (model.pending) return;
	const removed = model.images.find((image) => image.id === id);
	if (removed) URL.revokeObjectURL(removed.previewUrl);
	model = invalidateSendAttempt({
		...model,
		images: model.images.filter((image) => image.id !== id),
	});
	render();
}

function readBase64(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.addEventListener("error", () => reject(new Error(`Could not read ${file.name}.`)));
		reader.addEventListener("load", () => {
			if (typeof reader.result !== "string") {
				reject(new Error(`Could not read ${file.name}.`));
				return;
			}
			resolve(reader.result.slice(reader.result.indexOf(",") + 1));
		});
		reader.readAsDataURL(file);
	});
}

function render() {
	renderHeader();
	renderTranscript();
	renderComposer();
	renderBlocking();
}

function renderHeader() {
	ui.project.textContent = model.session?.projectName ?? "Connecting…";
	ui.session.textContent = model.session?.name ?? model.session?.cwd ?? "";
	if (model.closed) ui.connection.textContent = "Session ended";
	else if (!model.connected) ui.connection.textContent = "Reconnecting…";
	else if (model.stale) ui.connection.textContent = "Read-only tab";
	else ui.connection.textContent = model.activity === "running" ? "Pi is working" : "Connected";
}

function renderTranscript() {
	const distanceFromBottom =
		document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
	ui.transcript.replaceChildren();
	for (const message of model.messages) ui.transcript.append(renderMessage(message));
	ui.empty.hidden = model.messages.length > 0;
	if (distanceFromBottom < 160)
		requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight }));
}

function renderMessage(message) {
	const item = document.createElement("li");
	item.className = `message ${message.role}`;
	const heading = document.createElement("div");
	heading.className = "message-heading";
	heading.textContent = roleLabel(message);
	item.append(heading);
	for (const block of message.content ?? []) {
		if (block.type === "text") {
			const text = document.createElement("p");
			text.className = "message-text";
			text.textContent = block.text;
			item.append(text);
		} else if (block.type === "thinking") {
			const details = document.createElement("details");
			details.className = "thinking";
			const summary = document.createElement("summary");
			summary.textContent = "Thinking";
			const text = document.createElement("pre");
			text.textContent = block.text;
			details.append(summary, text);
			item.append(details);
		} else if (block.type === "image") {
			const image = document.createElement("span");
			image.className = "image-chip";
			image.textContent = `Image${block.mimeType ? ` · ${block.mimeType}` : ""}`;
			item.append(image);
		} else if (block.type === "toolCall") {
			item.append(
				renderTool(
					block,
					model.tools.find((tool) => tool.id === block.id),
				),
			);
		}
	}
	if (message.errorMessage) {
		const error = document.createElement("p");
		error.className = "message-error";
		error.textContent = message.errorMessage;
		item.append(error);
	}
	return item;
}

function renderTool(call, tool) {
	const details = document.createElement("details");
	details.className = `tool ${tool?.isError ? "failed" : ""}`;
	const summary = document.createElement("summary");
	summary.textContent = `${call.name} · ${tool?.phase ?? "requested"}`;
	const args = document.createElement("pre");
	args.textContent = safeJson(tool?.args ?? call.arguments);
	details.append(summary, args);
	if (tool?.result !== undefined) {
		const result = document.createElement("pre");
		result.textContent = safeJson(tool.result);
		details.append(result);
	}
	return details;
}

function renderComposer() {
	if (ui.input.value !== model.text) ui.input.value = model.text;
	ui.send.textContent = busyLabel(model);
	ui.send.disabled = !canSend(model);
	ui.steer.hidden = model.activity !== "running";
	ui.steer.disabled = !canSend(model);
	ui.input.disabled = model.closed || model.stale || model.pending;
	ui.imageInput.disabled = model.closed || model.stale || model.pending;
	ui.status.textContent =
		model.readingImages > 0
			? "Preparing images…"
			: model.pending
				? "Submitting message…"
				: deliveryNotice(model) ||
					(model.activity === "running"
						? "Send next waits until Pi finishes. Steer interrupts after the current tool batch."
						: "Messages send immediately while Pi is idle.");
	ui.error.hidden = !model.error;
	ui.error.textContent = model.error;
	ui.previews.replaceChildren();
	for (const image of model.images) {
		const item = document.createElement("li");
		const preview = document.createElement("img");
		preview.src = image.previewUrl;
		preview.alt = "";
		const name = document.createElement("span");
		name.textContent = image.name;
		const remove = document.createElement("button");
		remove.type = "button";
		remove.className = "remove-image";
		remove.textContent = "Remove";
		remove.disabled = model.pending;
		remove.setAttribute("aria-label", `Remove image ${image.name}`);
		remove.addEventListener("click", () => removeImage(image.id));
		item.append(preview, name, remove);
		ui.previews.append(item);
	}
}

function renderBlocking() {
	ui.blocking.hidden = !model.closed && !model.stale;
	if (model.closed) {
		ui.blockingTitle.textContent = "Pi session ended";
		ui.blockingMessage.textContent =
			"Return to the terminal and run /webui for the active session.";
	} else if (model.stale) {
		ui.blockingTitle.textContent = "Another tab is active";
		ui.blockingMessage.textContent = "This tab remains readable. Refresh it to take control.";
	}
}

function roleLabel(message) {
	if (message.role === "user") return "You";
	if (message.role === "assistant") return message.final ? "Pi" : "Pi · streaming";
	if (message.role === "toolResult")
		return message.toolName ? `Tool · ${message.toolName}` : "Tool";
	return message.role;
}

function safeJson(value) {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return "Details unavailable";
	}
}

async function responseError(response) {
	try {
		const body = await response.json();
		return body.error || `${response.status} ${response.statusText}`;
	} catch {
		return `${response.status} ${response.statusText}`;
	}
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
