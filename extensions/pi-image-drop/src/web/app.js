import {
	attemptMutation,
	canMutate,
	formatBytes,
	moveItem,
	moveItemBefore,
	preferNewestState,
	summarizeBatch,
} from "/state.js";

const $ = (selector) => document.querySelector(selector);
const ui = {
	session: $("#session-label"),
	cwd: $("#cwd"),
	drop: $("#drop-zone"),
	choose: $("#choose-files"),
	input: $("#file-input"),
	status: $("#status"),
	clear: $("#clear-all"),
	error: $("#error-banner"),
	grid: $("#grid"),
	overlay: $("#connection-overlay"),
	connectionTitle: $("#connection-title"),
	connectionMessage: $("#connection-message"),
	dialog: $("#clear-dialog"),
	previewDialog: $("#image-preview-dialog"),
	previewTitle: $("#image-preview-title"),
	previewDismiss: $("#image-preview-dismiss"),
	previewImage: $("#image-preview"),
};
const clientId = crypto.randomUUID();
const pendingFiles = new Map();
let state;
let draggedId;
let highlightedId;
let reconnectTimer;

wire();
void start();

async function start() {
	try {
		state = await request("/api/lease", { method: "POST", json: { clientId } });
		render();
		connectEvents();
	} catch (error) {
		connectionFailure("Could not connect", errorMessage(error));
	}
}

function wire() {
	ui.choose.addEventListener("click", () => ui.input.click());
	ui.input.addEventListener("change", () => {
		void addFiles([...ui.input.files]);
		ui.input.value = "";
	});
	document.addEventListener("paste", (event) => {
		const files = [...(event.clipboardData?.items ?? [])]
			.filter((item) => item.kind === "file")
			.map((item) => item.getAsFile())
			.filter(Boolean);
		if (files.length === 0) return;
		event.preventDefault();
		void addFiles(files);
	});
	for (const name of ["dragenter", "dragover"])
		document.addEventListener(name, (event) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			ui.drop.classList.add("drag-active");
		});
	for (const name of ["dragleave", "drop"])
		document.addEventListener(name, (event) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			ui.drop.classList.remove("drag-active");
			if (name === "drop") void addFiles([...event.dataTransfer.files]);
		});
	ui.clear.addEventListener("click", () => {
		ui.dialog.returnValue = "cancel";
		ui.dialog.showModal();
	});
	ui.dialog.addEventListener("close", () => {
		if (ui.dialog.returnValue === "confirm") void clearAll();
	});
	ui.previewDismiss.addEventListener("click", closePreview);
	ui.previewDialog.addEventListener("click", (event) => {
		if (event.target === ui.previewDialog) closePreview();
	});
	ui.previewDialog.addEventListener("close", () => {
		ui.previewImage.removeAttribute("src");
	});
}

function connectEvents() {
	const events = new EventSource(`/api/events?client=${encodeURIComponent(clientId)}`);
	events.addEventListener("state", (event) => {
		clearTimeout(reconnectTimer);
		applyState(JSON.parse(event.data));
		reconcileFiles();
		render();
	});
	events.addEventListener("stale", (event) => {
		events.close();
		connectionFailure("Opened in another tab", JSON.parse(event.data).message);
	});
	events.addEventListener("session-ended", (event) => {
		events.close();
		connectionFailure("Pi session ended", JSON.parse(event.data).message);
	});
	events.onerror = () => {
		clearTimeout(reconnectTimer);
		reconnectTimer = setTimeout(async () => {
			try {
				applyState(await request("/api/state"));
				render();
			} catch {
				events.close();
				connectionFailure("Connection lost", "Run /image-drop in Pi for a new link.");
			}
		}, 2000);
	};
}

async function addFiles(files) {
	if (!state || files.length === 0) return;
	if (!canMutate(state.batch)) return showError("This batch is already queued with Pi.");
	clearError();
	const items = files.map((file) => ({
		id: crypto.randomUUID(),
		name: file.name || "pasted-image",
		size: file.size,
		file,
	}));
	try {
		applyState(
			await request("/api/items", {
				method: "POST",
				json: {
					revision: state.batch.revision,
					items: items.map(({ id, name, size }) => ({ id, name, size })),
				},
			}),
		);
		for (const item of items) pendingFiles.set(item.id, item.file);
		render();
		await mapConcurrent(items, 4, upload);
	} catch (error) {
		showError(errorMessage(error));
	}
}

async function upload(item) {
	try {
		const response = await request(`/api/items/${item.id}/content`, {
			method: "PUT",
			body: item.file,
			headers: { "content-type": "application/octet-stream" },
		});
		applyState(response);
		if (response.duplicateOf) highlight(response.duplicateOf);
		if (
			!state.batch.items.some(
				(candidate) => candidate.id === item.id && candidate.status === "error",
			)
		)
			pendingFiles.delete(item.id);
		render();
	} catch (error) {
		try {
			if (!(error instanceof ApiError) || error.status === 413) {
				applyState(
					await request(`/api/items/${item.id}/fail`, {
						method: "POST",
						json: { error: `Upload failed: ${errorMessage(error)}` },
					}),
				);
			} else {
				applyState(await request("/api/state"));
			}
			render();
		} catch {
			/* The session may be disconnected. */
		}
		showError(errorMessage(error));
	}
}

async function retry(id) {
	try {
		const file = pendingFiles.get(id);
		const response = file
			? await request(`/api/items/${id}/content`, {
					method: "PUT",
					body: file,
					headers: { "content-type": "application/octet-stream" },
				})
			: await request(`/api/items/${id}/retry`, { method: "POST" });
		applyState(response);
		if (response.duplicateOf) highlight(response.duplicateOf);
		if (!state.batch.items.some((item) => item.id === id && item.status === "error"))
			pendingFiles.delete(id);
		clearError();
		render();
	} catch (error) {
		showError(
			`${errorMessage(error)} Delete and choose the image again if its source is unavailable.`,
		);
	}
}

async function remove(id) {
	if (await mutate(`/api/items/${id}?revision=${state.batch.revision}`, { method: "DELETE" })) {
		pendingFiles.delete(id);
	}
}

async function reorder(ids) {
	if (ids.every((id, index) => state.batch.items[index]?.id === id)) return;
	await mutate("/api/order", { method: "PUT", json: { revision: state.batch.revision, ids } });
}

async function clearAll() {
	if (await mutate("/api/clear", { method: "POST", json: { revision: state.batch.revision } })) {
		pendingFiles.clear();
	}
}

async function mutate(path, options) {
	const result = await attemptMutation(() => request(path, options));
	if (!result.ok) {
		showError(errorMessage(result.error));
		return false;
	}
	applyState(result.value);
	clearError();
	render();
	return true;
}

function render() {
	if (!state) return;
	document.title = `${state.projectName} · Pi Image Drop`;
	ui.session.textContent = state.sessionName
		? `${state.projectName} · ${state.sessionName}`
		: state.projectName;
	ui.cwd.textContent = state.cwd;
	const summary = summarizeBatch(state.batch);
	ui.status.textContent = `${summary.label} · ${formatBytes(summary.bytes)}`;
	const mutable = canMutate(state.batch);
	ui.clear.disabled = !mutable || summary.total === 0;
	ui.choose.disabled = !mutable;
	ui.input.disabled = !mutable;
	ui.drop.classList.toggle("disabled", !mutable);
	ui.drop.setAttribute("aria-disabled", String(!mutable));
	ui.grid.replaceChildren(...state.batch.items.map((item, index) => card(item, index, mutable)));
}

function card(item, index, mutable) {
	const article = document.createElement("article");
	article.className = `image-card status-${item.status}${item.id === highlightedId ? " duplicate-highlight" : ""}`;
	article.dataset.id = item.id;
	article.draggable = mutable;
	article.tabIndex = 0;
	article.setAttribute("aria-label", `${index + 1}. ${item.name}, ${item.status}`);
	article.addEventListener("dragstart", () => {
		draggedId = item.id;
	});
	article.addEventListener("dragover", (event) => {
		if (mutable && draggedId) event.preventDefault();
	});
	article.addEventListener("drop", (event) => {
		event.preventDefault();
		if (draggedId) void reorder(moveItemBefore(ids(), draggedId, item.id));
		draggedId = undefined;
	});

	let preview;
	if (item.status === "ready") {
		preview = element("button", "preview preview-button");
		preview.type = "button";
		preview.setAttribute("aria-label", `Enlarge preview of ${item.name}`);
		preview.addEventListener("click", () => openPreview(item));
		const image = document.createElement("img");
		image.src = `/api/items/${item.id}/preview?revision=${state.batch.revision}`;
		image.alt = `Preview of ${item.name}`;
		image.loading = "lazy";
		preview.append(image);
	} else {
		preview = element("div", "preview");
		const placeholder = element("span", "placeholder", item.status === "error" ? "!" : "…");
		placeholder.setAttribute("aria-hidden", "true");
		preview.append(placeholder);
	}
	article.append(preview);

	const body = element("div", "card-body");
	body.append(element("h3", "", item.name));
	const dimensions = item.width && item.height ? ` · ${item.width}×${item.height}` : "";
	body.append(
		element("p", "meta", `${index + 1} · ${formatBytes(item.size)}${dimensions} · ${item.status}`),
	);
	if (item.sourceFormat && item.sourceFormat !== item.outputFormat)
		body.append(
			element(
				"p",
				"conversion",
				`${item.sourceFormat.toUpperCase()} → ${item.outputFormat.toUpperCase()}`,
			),
		);
	for (const note of item.notes ?? []) body.append(element("p", "note", note));
	if (item.error) body.append(element("p", "item-error", item.error));
	article.append(body);

	const actions = element("div", "card-actions");
	actions.append(
		button("Move backward", "←", !mutable || index === 0, () =>
			reorder(moveItem(ids(), item.id, -1)),
		),
		button("Move forward", "→", !mutable || index === state.batch.items.length - 1, () =>
			reorder(moveItem(ids(), item.id, 1)),
		),
	);
	if (item.status === "error")
		actions.append(button("Retry", "Retry", !mutable, () => retry(item.id)));
	actions.append(button("Delete", "Delete", !mutable, () => remove(item.id), "delete"));
	article.append(actions);
	return article;
}

function openPreview(item) {
	ui.previewTitle.textContent = item.name;
	ui.previewImage.src = `/api/items/${item.id}/preview?revision=${state.batch.revision}`;
	ui.previewImage.alt = `Enlarged preview of ${item.name}`;
	ui.previewDialog.showModal();
}

function closePreview() {
	ui.previewDialog.close();
}

function button(label, text, disabled, action, className = "") {
	const result = element("button", className, text);
	result.type = "button";
	result.disabled = disabled;
	result.setAttribute("aria-label", label);
	result.addEventListener("click", () => void action());
	return result;
}

async function request(path, options = {}) {
	const headers = new Headers(options.headers);
	headers.set("x-image-drop-client", clientId);
	let body = options.body;
	if (options.json !== undefined) {
		headers.set("content-type", "application/json");
		body = JSON.stringify(options.json);
	}
	const response = await fetch(path, { method: options.method, headers, body });
	const data = (response.headers.get("content-type") ?? "").includes("application/json")
		? await response.json()
		: undefined;
	if (!response.ok) {
		throw new ApiError(
			response.status,
			data?.error ?? `Image Drop request failed (${response.status})`,
		);
	}
	return data;
}

class ApiError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

function element(tag, className, text) {
	const result = document.createElement(tag);
	if (className) result.className = className;
	if (text !== undefined) result.textContent = text;
	return result;
}
function ids() {
	return state.batch.items.map((item) => item.id);
}
function hasFiles(event) {
	return [...(event.dataTransfer?.types ?? [])].includes("Files");
}
function showError(text) {
	ui.error.textContent = text;
	ui.error.hidden = false;
}
function clearError() {
	ui.error.hidden = true;
	ui.error.textContent = "";
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
function connectionFailure(title, text) {
	ui.connectionTitle.textContent = title;
	ui.connectionMessage.textContent = text;
	ui.overlay.hidden = false;
}
function reconcileFiles() {
	for (const id of pendingFiles.keys())
		if (!state.batch.items.some((item) => item.id === id)) pendingFiles.delete(id);
}
function highlight(id) {
	highlightedId = id;
	render();
	requestAnimationFrame(() => document.querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus());
	setTimeout(() => {
		highlightedId = undefined;
		document
			.querySelector(`[data-id="${CSS.escape(id)}"]`)
			?.classList.remove("duplicate-highlight");
	}, 1800);
}
function applyState(next) {
	state = preferNewestState(state, next);
}
async function mapConcurrent(values, limit, task) {
	let cursor = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, values.length) }, async () => {
			while (cursor < values.length) {
				const value = values[cursor++];
				await task(value);
			}
		}),
	);
}
