import {
	acknowledgeDraftText,
	applyAttachments,
	applyConversationEvent,
	applyDraft,
	applyImageLimits,
	applyLease,
	applySentImages,
	applySnapshot,
	busyLabel,
	canSend,
	completeSend,
	deliveryNotice,
	editDraftText,
	failSend,
	followLatest,
	initialState,
	invalidateSendAttempt,
	moveImage,
	moveImageBefore,
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
let lastAttachmentAnnouncement = "";
let dragDepth = 0;
let previewReturnFocus;
let mutatingAttachments = false;
let draftSaveTimer;
let draftSaveQueue = Promise.resolve();
const retryFiles = new Map();
const uploadProgress = new Map();

const SUPPORTED_IMAGE_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"image/bmp",
	"image/x-ms-bmp",
	"image/tiff",
	"image/heic",
	"image/heif",
	"image/avif",
]);

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
	clearAttachments: document.querySelector("#clear-attachments"),
	clearDialog: document.querySelector("#clear-attachments-dialog"),
	clearMessage: document.querySelector("#clear-attachments-message"),
	previews: document.querySelector("#image-previews"),
	attachmentSummary: document.querySelector("#attachment-summary"),
	attachmentAnnouncement: document.querySelector("#attachment-announcement"),
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

const transcriptRenderer = createTranscriptRenderer({
	documentRef: document,
	list: ui.transcript,
	onReattach: (id) => void reattachSentImage(id),
	onForget: (id) => void forgetSentImage(id),
});

ui.input.addEventListener("input", () => {
	model = editDraftText(model, ui.input.value);
	scheduleDraftSave();
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
ui.clearAttachments.addEventListener("click", () => {
	if (composerLocked() || model.images.length < 2) return;
	ui.clearDialog.returnValue = "cancel";
	ui.clearMessage.textContent = `Remove all ${model.images.length} unsent image attachments? Message text will be kept.`;
	ui.clearDialog.showModal();
});
ui.clearDialog.addEventListener("close", () => {
	if (ui.clearDialog.returnValue !== "confirm") {
		requestAnimationFrame(() => ui.clearAttachments.focus());
		return;
	}
	void clearAttachments();
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
	const files = [...(event.clipboardData?.files ?? [])].filter(isSupportedImageFile);
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
	const files = [...(event.dataTransfer?.files ?? [])].filter(isSupportedImageFile);
	if (files.length === 0 || composerLocked()) return;
	event.preventDefault();
	void addFiles(files);
});
ui.previewClose.addEventListener("click", () => ui.previewDialog.close());
ui.previewDismiss.addEventListener("click", () => ui.previewDialog.close());
ui.previewDialog.addEventListener("close", () => {
	ui.previewImage.removeAttribute("src");
	delete ui.previewImage.dataset.imageId;
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
	if (model.textDirty) scheduleDraftSave();
	render();
}

function connectEvents() {
	clearTimeout(reconnectTimer);
	events?.close();
	events = new EventSource(`/api/events?since=${model.sequence}`);
	events.addEventListener("open", () => {
		reconnectDelay = 500;
		model = { ...model, connected: true, error: "" };
		if (model.textDirty) scheduleDraftSave();
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
	events.addEventListener("draft", (event) => {
		model = applyDraft(model, JSON.parse(event.data));
		renderComposer();
	});
	events.addEventListener("attachments", (event) => {
		model = applyAttachments(model, JSON.parse(event.data));
		render();
	});
	events.addEventListener("image-limits", (event) => {
		model = applyImageLimits(model, JSON.parse(event.data));
		renderComposer();
	});
	events.addEventListener("sent-images", (event) => {
		model = applySentImages(model, JSON.parse(event.data));
		render({ updateKey: "sent-images" });
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
	try {
		await flushDraftText();
	} catch (error) {
		model = { ...model, error: errorMessage(error) };
		render();
		return;
	}
	if (!canSend(model) || model.textDirty) return;
	const prepared = prepareSend(model, crypto.randomUUID(), steer ? "steer" : "next");
	const attempt = prepared.attempt;
	model = prepared.state;
	renderComposer();
	const payload = {
		requestId: attempt.requestId,
		draftRevision: attempt.draftRevision,
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
		if (accepted.draft) model = applyDraft(model, accepted.draft);
		if (accepted.attachments) model = applyAttachments(model, accepted.attachments);
		if (accepted.sentImages) model = applySentImages(model, accepted.sentImages);
		if (attempt.attachmentIds.includes(ui.previewImage.dataset.imageId)) {
			ui.previewDialog.close();
		}
		for (const id of attempt.attachmentIds) retryFiles.delete(id);
		model = completeSend(model, attempt, accepted.delivery);
		render();
		ui.input.focus();
	} catch (error) {
		model = failSend(model, attempt, errorMessage(error));
		render();
	}
}

async function addFiles(fileList) {
	if (composerLocked() || model.readingImages > 0) return;
	const files = [...(fileList ?? [])];
	if (files.length === 0) return;
	const limits = model.imageLimits;
	if (!limits) {
		model = { ...model, error: "Effective image limits are still loading." };
		render();
		return;
	}
	if (model.images.length + files.length > limits.maxImages) {
		model = { ...model, error: `You can attach at most ${limits.maxImages} images.` };
		render();
		return;
	}
	for (const file of files) {
		if (!isSupportedImageFile(file)) {
			model = { ...model, error: `${file.name || "Image"} is not a supported image.` };
			render();
			return;
		}
		if (file.size > limits.maxImageBytes) {
			model = {
				...model,
				error: `${file.name || "Image"} is larger than ${formatMib(limits.maxImageBytes)}.`,
			};
			render();
			return;
		}
	}
	const batchBytes =
		model.images.reduce((total, image) => total + (image.size ?? 0), 0) +
		files.reduce((total, file) => total + file.size, 0);
	if (batchBytes > limits.maxBatchBytes) {
		model = {
			...model,
			error: `Combined image input is larger than ${formatMib(limits.maxBatchBytes)}.`,
		};
		render();
		return;
	}
	const pending = files.map((file) => ({ id: crypto.randomUUID(), file }));
	try {
		mutatingAttachments = true;
		renderComposer();
		const response = await attachmentMutation("/api/attachments/reserve", {
			method: "POST",
			body: JSON.stringify({
				revision: model.attachmentRevision,
				items: pending.map(({ id, file }) => ({
					id,
					name: file.name || "Pasted image",
					size: file.size,
					mimeType: file.type,
				})),
			}),
		});
		model = applyAttachments(model, response);
		for (const { id, file } of pending) retryFiles.set(id, file);
		render();
		for (const { id, file } of pending) await uploadFile(id, file);
	} catch (error) {
		model = { ...model, error: errorMessage(error) };
		render();
	} finally {
		mutatingAttachments = false;
		renderComposer();
	}
}

async function uploadFile(id, file) {
	uploadProgress.set(id, { loaded: 0, total: file.size });
	renderComposer();
	try {
		const state = await uploadAttachment(
			`/api/attachments/${encodeURIComponent(id)}/upload?revision=${model.attachmentRevision}`,
			file,
			(progress) => {
				uploadProgress.set(id, progress);
				renderComposer();
			},
		);
		retryFiles.delete(id);
		model = applyAttachments(model, state);
		render();
	} finally {
		uploadProgress.delete(id);
		renderComposer();
	}
}

function uploadAttachment(path, file, onProgress) {
	return new Promise((resolve, reject) => {
		const request = new XMLHttpRequest();
		request.open("POST", path);
		request.responseType = "json";
		request.setRequestHeader("Content-Type", "application/octet-stream");
		request.setRequestHeader("X-Pi-Web-Client", clientId);
		request.upload.addEventListener("progress", (event) => {
			if (event.lengthComputable) onProgress({ loaded: event.loaded, total: event.total });
		});
		request.addEventListener("load", () => {
			if (request.status >= 200 && request.status < 300) {
				resolve(request.response);
				return;
			}
			reject(new Error(request.response?.error || `Request failed (${request.status}).`));
		});
		request.addEventListener("error", () => reject(new Error("Image upload failed.")));
		request.addEventListener("abort", () => reject(new Error("Image upload was cancelled.")));
		request.send(file);
	});
}

async function retryImage(id) {
	if (composerLocked()) return;
	mutatingAttachments = true;
	renderComposer();
	try {
		const file = retryFiles.get(id);
		if (file) {
			await uploadFile(id, file);
		} else {
			const response = await attachmentMutation(
				`/api/attachments/${encodeURIComponent(id)}/retry`,
				{
					method: "POST",
					body: JSON.stringify({ revision: model.attachmentRevision }),
				},
			);
			model = applyAttachments(model, response);
			render();
		}
	} catch (error) {
		model = { ...model, error: errorMessage(error) };
		render();
	} finally {
		mutatingAttachments = false;
		renderComposer();
	}
}

function scheduleDraftSave() {
	clearTimeout(draftSaveTimer);
	if (!model.textDirty || model.closed || model.stale || !model.connected) return;
	draftSaveTimer = setTimeout(() => {
		draftSaveTimer = undefined;
		void flushDraftText().catch((error) => {
			model = { ...model, error: errorMessage(error) };
			render();
		});
	}, 180);
}

function flushDraftText() {
	clearTimeout(draftSaveTimer);
	draftSaveTimer = undefined;
	draftSaveQueue = draftSaveQueue
		.catch(() => undefined)
		.then(async () => {
			while (model.textDirty) {
				if (model.closed || model.stale || !model.connected) {
					throw new Error("Reconnect the active tab to save this draft.");
				}
				const submittedText = model.text;
				const response = await fetch("/api/draft", {
					method: "POST",
					headers: { "Content-Type": "application/json", "X-Pi-Web-Client": clientId },
					body: JSON.stringify({
						requestId: crypto.randomUUID(),
						revision: model.draftRevision,
						text: submittedText,
					}),
				});
				if (response.status === 409) {
					await refreshSnapshot();
					continue;
				}
				if (!response.ok) throw new Error(await responseError(response));
				model = acknowledgeDraftText(model, await response.json(), submittedText);
				renderComposer();
			}
		});
	return draftSaveQueue;
}

function isSupportedImageFile(file) {
	return (
		SUPPORTED_IMAGE_TYPES.has(file.type) ||
		/\.(?:bmp|tif|tiff|heic|heif|avif)$/i.test(file.name || "")
	);
}

async function reattachSentImage(retainedImageId) {
	if (composerLocked() || !retainedImageId) return;
	if (model.attachmentPhase !== "empty" && model.attachmentPhase !== "ready") {
		model = { ...model, error: "Wait for current images to finish before attaching again." };
		render();
		return;
	}
	mutatingAttachments = true;
	renderComposer();
	try {
		const response = await attachmentMutation("/api/sent-images/reattach", {
			method: "POST",
			body: JSON.stringify({
				revision: model.attachmentRevision,
				items: [{ retainedId: retainedImageId, id: crypto.randomUUID() }],
			}),
		});
		model = applyDraft(model, response.draft);
		model = applyAttachments(model, response.attachments);
		model = applySentImages(model, response.sentImages);
		model = { ...model, error: "" };
		render();
	} catch (error) {
		model = { ...model, error: errorMessage(error) };
		render();
	} finally {
		mutatingAttachments = false;
		renderComposer();
	}
}

async function forgetSentImage(retainedImageId) {
	if (composerLocked() || !retainedImageId) return;
	if (!window.confirm("Forget this retained image? This does not retract provider content."))
		return;
	try {
		const response = await attachmentMutation(
			`/api/sent-images/${encodeURIComponent(retainedImageId)}?revision=${model.sentImages.revision}`,
			{ method: "DELETE" },
		);
		model = applySentImages(model, response);
		render({ updateKey: "sent-images" });
	} catch (error) {
		model = { ...model, error: errorMessage(error) };
		render();
	}
}

async function clearAttachments() {
	if (composerLocked() || model.images.length < 2) return;
	const clearedIds = model.images.map((image) => image.id);
	if (clearedIds.includes(ui.previewImage.dataset.imageId)) ui.previewDialog.close();
	const state = await mutateAttachmentState("/api/attachments/clear", {
		method: "POST",
		body: JSON.stringify({ revision: model.attachmentRevision }),
	});
	if (!state) return;
	for (const id of clearedIds) retryFiles.delete(id);
	ui.input.focus();
}

async function reorderImages(images, focusId) {
	if (composerLocked()) return;
	const state = await mutateAttachmentState("/api/attachments/reorder", {
		method: "POST",
		body: JSON.stringify({
			revision: model.attachmentRevision,
			ids: images.map((image) => image.id),
		}),
	});
	if (state) focusImageItem(focusId);
}

function focusImageItem(id) {
	requestAnimationFrame(() => {
		const escapedId = CSS.escape(id);
		const item = ui.previews.querySelector(`[data-image-id="${escapedId}"]`);
		(item?.tabIndex === 0 ? item : item?.querySelector(".remove-image"))?.focus();
	});
}

async function removeImage(id) {
	if (composerLocked()) return;
	if (ui.previewImage.dataset.imageId === id) ui.previewDialog.close();
	const state = await mutateAttachmentState(
		`/api/attachments/${encodeURIComponent(id)}?revision=${model.attachmentRevision}`,
		{ method: "DELETE", headers: { "Content-Type": "application/json" } },
	);
	if (state) {
		retryFiles.delete(id);
		uploadProgress.delete(id);
	}
}

async function mutateAttachmentState(path, options) {
	if (composerLocked()) return;
	mutatingAttachments = true;
	renderComposer();
	try {
		const state = await attachmentMutation(path, options);
		model = applyAttachments(model, state);
		model = { ...model, error: "" };
		render();
		return state;
	} catch (error) {
		model = { ...model, error: errorMessage(error) };
		render();
	} finally {
		mutatingAttachments = false;
		renderComposer();
	}
}

async function attachmentMutation(path, options) {
	const response = await fetch(path, {
		...options,
		headers: {
			"Content-Type": "application/json",
			"X-Pi-Web-Client": clientId,
			...options.headers,
		},
	});
	if (!response.ok) throw new Error(await responseError(response));
	return response.json();
}

function openImagePreview(image) {
	if (image.status !== "ready") return;
	previewReturnFocus = document.activeElement;
	ui.previewTitle.textContent = image.name;
	ui.previewImage.src = `/api/attachments/${encodeURIComponent(image.id)}/preview?v=${model.attachmentRevision}`;
	ui.previewImage.dataset.imageId = image.id;
	ui.previewImage.alt = image.name;
	ui.previewDialog.showModal();
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
		transcriptRenderer.render(model.messages, model.tools, model.sentImages);
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
	ui.input.disabled = model.closed || model.stale;
	const admissionLocked = locked || model.readingImages > 0;
	ui.imageInput.disabled = admissionLocked;
	ui.addImages.classList.toggle("disabled", admissionLocked);
	ui.addImages.setAttribute("aria-disabled", String(admissionLocked));
	ui.clearAttachments.hidden = model.images.length < 2;
	ui.clearAttachments.disabled = locked;
	ui.status.textContent = composerStatus();
	ui.error.hidden = !model.error;
	ui.error.textContent = model.error;
	const maximum = model.imageLimits?.maxImages ?? model.images.length;
	ui.attachmentSummary.hidden = model.images.length === 0;
	ui.attachmentSummary.textContent = model.images.length
		? `${model.images.length}/${maximum} images attached · Sensitive metadata is removed before sending.`
		: "";
	const attachmentAnnouncement = model.images.length
		? `Attachment state: ${attachmentPhaseLabel(model.attachmentPhase)}.`
		: "";
	if (attachmentAnnouncement !== lastAttachmentAnnouncement) {
		lastAttachmentAnnouncement = attachmentAnnouncement;
		ui.attachmentAnnouncement.textContent = attachmentAnnouncement;
	}
	ui.previews.replaceChildren();
	for (const [index, image] of model.images.entries()) {
		const item = document.createElement("li");
		item.className = "image-preview-item";
		item.dataset.imageId = image.id;
		const retryable = image.status === "error" && (image.retryable || retryFiles.has(image.id));
		const orderingLocked = locked || model.attachmentPhase !== "ready";
		item.draggable = model.images.length > 1 && image.status === "ready" && !orderingLocked;
		if (item.draggable) {
			item.tabIndex = 0;
			item.setAttribute(
				"aria-label",
				`${image.name}, image ${index + 1} of ${model.images.length}. Drag to reorder or press Alt plus Up or Down Arrow.`,
			);
			item.setAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
		}
		item.addEventListener("keydown", (event) => {
			if (
				event.target !== item ||
				orderingLocked ||
				!event.altKey ||
				event.ctrlKey ||
				event.metaKey
			)
				return;
			const direction = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
			if (direction === 0 || index + direction < 0 || index + direction >= model.images.length)
				return;
			event.preventDefault();
			void reorderImages(moveImage(model.images, image.id, direction), image.id);
		});
		item.addEventListener("dragstart", (event) => {
			if (orderingLocked || !event.dataTransfer) return;
			event.dataTransfer.effectAllowed = "move";
			event.dataTransfer.setData("application/x-pi-webui-image", image.id);
			item.classList.add("dragging");
		});
		item.addEventListener("dragend", () => {
			item.classList.remove("dragging");
			for (const candidate of ui.previews.children) candidate.classList.remove("drag-target");
		});
		item.addEventListener("dragover", (event) => {
			const draggedId = event.dataTransfer?.getData("application/x-pi-webui-image");
			if (orderingLocked || !draggedId || draggedId === image.id) return;
			event.preventDefault();
			item.classList.add("drag-target");
		});
		item.addEventListener("dragleave", () => item.classList.remove("drag-target"));
		item.addEventListener("drop", (event) => {
			const draggedId = event.dataTransfer?.getData("application/x-pi-webui-image");
			item.classList.remove("drag-target");
			if (orderingLocked || !draggedId || draggedId === image.id) return;
			event.preventDefault();
			event.stopPropagation();
			void reorderImages(moveImageBefore(model.images, draggedId, image.id), draggedId);
		});
		const previewButton = document.createElement("button");
		previewButton.type = "button";
		previewButton.className = "attachment-preview";
		previewButton.setAttribute("aria-label", `Preview image ${image.name}`);
		previewButton.disabled = locked || image.status !== "ready";
		previewButton.addEventListener("click", () => openImagePreview(image));
		const preview = document.createElement("img");
		if (image.status === "ready") {
			preview.src = `/api/attachments/${encodeURIComponent(image.id)}/preview?v=${model.attachmentRevision}`;
		}
		preview.alt = "";
		previewButton.append(preview);
		const details = document.createElement("span");
		details.className = "attachment-details";
		const name = document.createElement("span");
		name.textContent = image.name;
		const itemStatus = document.createElement("span");
		itemStatus.className = `attachment-item-status ${image.status}`;
		itemStatus.textContent = attachmentItemLabel(image, uploadProgress.get(image.id));
		details.append(name, itemStatus);
		if (Array.isArray(image.notes) && image.notes.length > 0) {
			const summary = document.createElement("span");
			summary.className = "attachment-conversion-summary";
			summary.textContent = image.notes.join(" · ");
			details.append(summary);
		}
		if (model.images.length > 1) {
			const order = document.createElement("span");
			order.className = "attachment-order-context";
			order.textContent = `Order ${index + 1} of ${model.images.length}`;
			details.append(order);
		}
		const actions = document.createElement("div");
		actions.className = "image-actions";
		const remove = document.createElement("button");
		remove.type = "button";
		remove.className = "remove-image";
		remove.disabled = locked;
		remove.setAttribute("aria-label", `Remove image ${image.name}`);
		remove.title = `Remove ${image.name}`;
		remove.append(createTrashIcon());
		remove.addEventListener("click", () => void removeImage(image.id));
		if (retryable) {
			const retry = document.createElement("button");
			retry.type = "button";
			retry.className = "retry-image";
			retry.textContent = "Retry";
			retry.disabled = locked;
			retry.setAttribute("aria-label", `Retry image ${image.name}`);
			retry.addEventListener("click", () => void retryImage(image.id));
			actions.append(retry);
		}
		actions.append(remove);
		item.append(previewButton, details, actions);
		ui.previews.append(item);
	}
	document.documentElement.style.setProperty("--composer-height", `${ui.composer.offsetHeight}px`);
}

function createTrashIcon() {
	const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	icon.setAttribute("viewBox", "0 0 24 24");
	icon.setAttribute("aria-hidden", "true");
	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute("d", "M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14M10 10v6m4-6v6");
	icon.append(path);
	return icon;
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

function attachmentPhaseLabel(phase) {
	if (phase === "uploading") return "Uploading";
	if (phase === "processing") return "Processing";
	if (phase === "blocked") return "Needs attention";
	if (phase === "reserved") return "Submitting";
	return "Ready";
}

function attachmentItemLabel(image, progress) {
	if (image.status === "uploading" && progress?.total > 0) {
		const percent = Math.min(100, Math.round((progress.loaded / progress.total) * 100));
		return `Uploading · ${percent}%`;
	}
	if (image.status === "uploading") return "Uploading…";
	if (image.status === "processing") return "Processing…";
	if (image.status === "error") return image.error || "Needs attention";
	const dimensions =
		Number.isSafeInteger(image.width) && Number.isSafeInteger(image.height)
			? ` · ${image.width}×${image.height}`
			: "";
	return `Ready${dimensions}`;
}

function composerStatus() {
	if (model.readingImages > 0) return "Staging images on this Pi session…";
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
	return (
		model.closed ||
		model.stale ||
		model.pending ||
		mutatingAttachments ||
		model.attachmentPhase === "reserved"
	);
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

function formatMib(bytes) {
	return `${bytes / (1024 * 1024)} MiB`;
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
