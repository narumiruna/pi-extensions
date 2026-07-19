import {
	applyConversationEvent,
	applyLease,
	applySnapshot,
	busyLabel,
	canSend,
	completeSend,
	deliveryNotice,
	failSend,
	followLatest,
	initialState,
	invalidateSendAttempt,
	noteUnseenUpdate,
	prepareSend,
	setNearBottom,
} from "./state.js";
import { createTranscriptRenderer } from "./transcript.js";

const clientId = crypto.randomUUID();
let model = initialState();
let events;
let reconnectTimer;
let reconnectDelay = 500;
let snapshotRefresh;
let snapshotTarget = 0;
let transcriptFrame;
let transcriptAnnouncement = "";
let dragDepth = 0;
let previewReturnFocus;

const ui = {
	project: document.querySelector("#project-name"),
	session: document.querySelector("#session-name"),
	cwd: document.querySelector("#cwd"),
	connection: document.querySelector("#connection-status"),
	empty: document.querySelector("#empty-state"),
	transcript: document.querySelector("#transcript"),
	transcriptStatus: document.querySelector("#transcript-status"),
	jumpLatest: document.querySelector("#jump-latest"),
	blocking: document.querySelector("#blocking-state"),
	blockingTitle: document.querySelector("#blocking-title"),
	blockingMessage: document.querySelector("#blocking-message"),
	composer: document.querySelector("#composer"),
	input: document.querySelector("#message-input"),
	imageInput: document.querySelector("#image-input"),
	addImages: document.querySelector('label[for="image-input"]'),
	previews: document.querySelector("#image-previews"),
	attachmentStatus: document.querySelector("#attachment-status"),
	status: document.querySelector("#composer-status"),
	error: document.querySelector("#composer-error"),
	send: document.querySelector("#send-next"),
	steer: document.querySelector("#steer"),
	previewDialog: document.querySelector("#image-preview-dialog"),
	previewTitle: document.querySelector("#image-preview-title"),
	previewImage: document.querySelector("#image-preview"),
	previewClose: document.querySelector("#image-preview-close"),
	previewDismiss: document.querySelector("#image-preview-dismiss"),
};

const transcriptRenderer = createTranscriptRenderer({ documentRef: document, list: ui.transcript });

ui.input.addEventListener("input", () => {
	model = invalidateSendAttempt({ ...model, text: ui.input.value, error: "" });
	resizeInput();
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
ui.jumpLatest.addEventListener("click", () => {
	model = followLatest(model);
	renderJumpLatest();
	requestAnimationFrame(() =>
		window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }),
	);
});
window.addEventListener(
	"scroll",
	() => {
		model = setNearBottom(model, isNearBottom());
		renderJumpLatest();
	},
	{ passive: true },
);
document.addEventListener("paste", (event) => {
	const files = [...(event.clipboardData?.files ?? [])].filter((file) =>
		file.type.startsWith("image/"),
	);
	if (files.length === 0 || composerLocked()) return;
	event.preventDefault();
	void addFiles(files);
});
ui.composer.addEventListener("dragenter", (event) => {
	if (!hasDraggedFile(event) || composerLocked()) return;
	event.preventDefault();
	dragDepth += 1;
	ui.composer.classList.add("drag-active");
});
ui.composer.addEventListener("dragover", (event) => {
	if (!hasDraggedFile(event) || composerLocked()) return;
	event.preventDefault();
});
ui.composer.addEventListener("dragleave", () => {
	dragDepth = Math.max(0, dragDepth - 1);
	if (dragDepth === 0) ui.composer.classList.remove("drag-active");
});
ui.composer.addEventListener("drop", (event) => {
	dragDepth = 0;
	ui.composer.classList.remove("drag-active");
	const files = [...(event.dataTransfer?.files ?? [])].filter((file) =>
		file.type.startsWith("image/"),
	);
	if (files.length === 0 || composerLocked()) return;
	event.preventDefault();
	void addFiles(files);
});
ui.previewClose.addEventListener("click", () => ui.previewDialog.close());
ui.previewDismiss.addEventListener("click", () => ui.previewDialog.close());
ui.previewDialog.addEventListener("close", () => {
	ui.previewImage.removeAttribute("src");
	ui.previewImage.alt = "";
	if (previewReturnFocus?.isConnected) previewReturnFocus.focus();
	previewReturnFocus = undefined;
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
				const snapshot = await response.json();
				model = applySnapshot(model, snapshot);
				if (typeof snapshot.lease?.activeClientId === "string") {
					model = applyLease(model, snapshot.lease, clientId);
				}
				render({ updateKey: "snapshot" });
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
	model = applyLease(model, await response.json(), clientId, true);
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
		render({
			updateKey: conversationUpdateKey(conversationEvent),
			announcement: conversationAnnouncement(conversationEvent),
		});
	});
	events.addEventListener("snapshot", (event) => {
		model = applySnapshot(model, JSON.parse(event.data));
		render({ updateKey: "snapshot" });
	});
	events.addEventListener("lease", (event) => {
		model = applyLease(model, JSON.parse(event.data), clientId);
		render();
	});
	events.addEventListener("session-ended", () => {
		model = { ...model, closed: true, activity: "ended", connected: false };
		events?.close();
		render({ announcement: "Pi session ended." });
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
		if (attempt.images.some((image) => image.previewUrl === ui.previewImage.src)) {
			ui.previewDialog.close();
		}
		model = completeSend(model, attempt, accepted.delivery);
		render();
		ui.input.focus();
	} catch (error) {
		model = failSend(model, attempt, errorMessage(error));
		render();
	}
}

async function addFiles(fileList) {
	if (composerLocked()) return;
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
				break;
			}
			if (!supported.has(file.type)) {
				model = { ...model, error: `${file.name || "Image"} is not a supported image.` };
				continue;
			}
			if (file.size > 10 * 1024 * 1024) {
				model = { ...model, error: `${file.name || "Image"} is larger than 10 MB.` };
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
			} catch (error) {
				model = { ...model, error: errorMessage(error) };
			}
			render();
		}
	} finally {
		model = { ...model, readingImages: Math.max(0, model.readingImages - 1) };
		renderComposer();
	}
}

function removeImage(id) {
	if (model.pending) return;
	const removed = model.images.find((image) => image.id === id);
	if (removed) {
		if (ui.previewImage.src === removed.previewUrl) ui.previewDialog.close();
		URL.revokeObjectURL(removed.previewUrl);
	}
	model = invalidateSendAttempt({
		...model,
		images: model.images.filter((image) => image.id !== id),
	});
	render();
}

function openImagePreview(image) {
	previewReturnFocus = document.activeElement;
	ui.previewTitle.textContent = image.name;
	ui.previewImage.src = image.previewUrl;
	ui.previewImage.alt = image.name;
	ui.previewDialog.showModal();
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

function render(options = {}) {
	renderHeader();
	queueTranscriptRender(options.updateKey, options.announcement);
	renderComposer();
	renderBlocking();
	renderJumpLatest();
}

function renderHeader() {
	ui.project.textContent = model.session?.projectName ?? "Connecting…";
	ui.session.textContent = model.session?.name ?? "Current session";
	ui.cwd.textContent = model.session?.cwd ?? "—";
	if (model.closed) ui.connection.textContent = "Session ended";
	else if (!model.connected) ui.connection.textContent = "Reconnecting…";
	else if (model.stale) ui.connection.textContent = "Read-only tab";
	else ui.connection.textContent = model.activity === "running" ? "Pi is working" : "Connected";
}

function queueTranscriptRender(updateKey, announcement) {
	if (updateKey) model = noteUnseenUpdate(model, updateKey);
	if (announcement) transcriptAnnouncement = announcement;
	if (transcriptFrame) return;
	transcriptFrame = requestAnimationFrame(() => {
		transcriptFrame = undefined;
		transcriptRenderer.render(model.messages, model.tools);
		ui.empty.hidden = model.messages.length > 0;
		if (transcriptAnnouncement) {
			ui.transcriptStatus.textContent = transcriptAnnouncement;
			transcriptAnnouncement = "";
		}
		if (model.following) window.scrollTo({ top: document.body.scrollHeight });
		renderJumpLatest();
	});
}

function renderComposer() {
	if (ui.input.value !== model.text) ui.input.value = model.text;
	resizeInput();
	const locked = composerLocked();
	ui.composer.classList.toggle("locked", locked);
	ui.send.textContent = busyLabel(model);
	ui.send.disabled = !canSend(model);
	ui.steer.hidden = model.activity !== "running";
	ui.steer.disabled = !canSend(model);
	ui.input.disabled = locked;
	ui.imageInput.disabled = locked;
	ui.addImages.classList.toggle("disabled", locked);
	ui.addImages.setAttribute("aria-disabled", String(locked));
	ui.status.textContent = composerStatus();
	ui.error.hidden = !model.error;
	ui.error.textContent = model.error;
	ui.attachmentStatus.hidden = model.images.length === 0;
	const attachmentStatus =
		model.images.length === 0
			? ""
			: `${model.images.length} of 8 images attached · Sensitive metadata is removed before sending.`;
	if (ui.attachmentStatus.textContent !== attachmentStatus) {
		ui.attachmentStatus.textContent = attachmentStatus;
	}
	ui.previews.replaceChildren();
	for (const image of model.images) {
		const item = document.createElement("li");
		item.className = "image-preview-item";
		const previewButton = document.createElement("button");
		previewButton.type = "button";
		previewButton.className = "attachment-preview";
		previewButton.setAttribute("aria-label", `Preview image ${image.name}`);
		previewButton.disabled = model.pending;
		previewButton.addEventListener("click", () => openImagePreview(image));
		const preview = document.createElement("img");
		preview.src = image.previewUrl;
		preview.alt = "";
		previewButton.append(preview);
		const name = document.createElement("span");
		name.textContent = image.name;
		const remove = document.createElement("button");
		remove.type = "button";
		remove.className = "remove-image";
		remove.textContent = "Remove";
		remove.disabled = model.pending;
		remove.setAttribute("aria-label", `Remove image ${image.name}`);
		remove.addEventListener("click", () => removeImage(image.id));
		item.append(previewButton, name, remove);
		ui.previews.append(item);
	}
	document.documentElement.style.setProperty("--composer-height", `${ui.composer.offsetHeight}px`);
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

function renderJumpLatest() {
	const count = model.unseenUpdateIds.length;
	ui.jumpLatest.hidden = count === 0;
	ui.jumpLatest.textContent = count > 1 ? `↓ ${count} new updates` : "↓ Jump to latest";
}

function resizeInput() {
	ui.input.style.height = "auto";
	ui.input.style.height = `${Math.min(ui.input.scrollHeight, window.innerHeight * 0.32)}px`;
}

function composerStatus() {
	if (model.readingImages > 0) return "Preparing images…";
	if (model.pending) return "Submitting message…";
	const notice = deliveryNotice(model);
	if (notice) return notice;
	if (!model.connected) return "Connection unavailable · Draft is preserved.";
	if (model.closed) return "This Pi session has ended.";
	if (model.stale) return "Another tab controls this session.";
	if (model.activity === "running")
		return "Pi is working · Queue waits; Steer redirects the active turn.";
	return "Pi is idle · Messages send immediately.";
}

function conversationUpdateKey(event) {
	if (event.type === "message" && event.payload?.id) return `message:${event.payload.id}`;
	if (event.type === "tool" && event.payload?.id) return `tool:${event.payload.id}`;
	return event.type;
}

function conversationAnnouncement(event) {
	if (event.type === "message" && event.payload?.final && event.payload.role === "assistant") {
		return "New completed message from Pi.";
	}
	if (event.type === "tool" && event.payload?.phase === "end") {
		return event.payload.isError ? "Tool failed." : "Tool completed.";
	}
	return "";
}

function composerLocked() {
	return model.closed || model.stale || model.pending;
}

function hasDraggedFile(event) {
	return [...(event.dataTransfer?.items ?? [])].some((item) => item.kind === "file");
}

function isNearBottom() {
	return document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 160;
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
