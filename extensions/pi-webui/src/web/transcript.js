import { renderMarkdown } from "./markdown.js";

export function createTranscriptRenderer({ documentRef = document, list }) {
	const messages = new Map();

	return {
		render(nextMessages, tools) {
			const toolById = new Map(tools.map((tool) => [tool.id, tool]));
			const retained = new Set();
			const changed = [];
			let cursor = list.firstChild;
			for (const message of nextMessages) {
				retained.add(message.id);
				let view = messages.get(message.id);
				if (!view) {
					view = createMessageView(message.role, documentRef);
					messages.set(message.id, view);
				}
				if (updateMessageView(view, message, toolById, documentRef)) changed.push(message.id);
				if (view.node !== cursor) list.insertBefore(view.node, cursor);
				cursor = view.node.nextSibling;
			}
			for (const [id, view] of messages) {
				if (retained.has(id)) continue;
				view.node.remove();
				messages.delete(id);
			}
			return changed;
		},
	};
}

export function isCollapsibleMessageRole(role) {
	return role === "toolResult";
}

export function toolPhaseLabel(tool) {
	if (tool?.isError) return "Failed";
	if (tool?.phase === "end") return "Completed";
	if (tool?.phase === "start" || tool?.phase === "update") return "Running";
	return "Requested";
}

export function toolCommandPreview(tool) {
	const command = tool?.args?.command;
	if (typeof command !== "string") return "";
	return command.length > 120 ? `${command.slice(0, 120)}…` : command;
}

function createMessageView(role, documentRef) {
	const node = documentRef.createElement("li");
	const body = documentRef.createElement("div");
	body.className = "message-body";
	let heading;
	if (isCollapsibleMessageRole(role)) {
		const disclosure = documentRef.createElement("details");
		disclosure.className = "tool-result-disclosure";
		heading = documentRef.createElement("summary");
		heading.className = "message-heading";
		disclosure.append(heading, body);
		node.append(disclosure);
	} else {
		heading = documentRef.createElement("div");
		heading.className = "message-heading";
		node.append(heading, body);
	}
	return { node, heading, body, blocks: new Map(), role: "", final: undefined };
}

function updateMessageView(view, message, toolById, documentRef) {
	let changed = false;
	const role = knownRole(message.role);
	if (view.role !== role) {
		view.node.className = `message ${role}`;
		view.role = role;
		changed = true;
	}
	const heading = roleLabel(message);
	if (view.final !== message.final || view.heading.textContent !== heading) {
		view.heading.textContent = heading;
		view.final = message.final;
		changed = true;
	}

	const retained = new Set();
	let cursor = view.body.firstChild;
	for (const [index, block] of (message.content ?? []).entries()) {
		const key = `${index}:${block.type}:${block.id ?? ""}`;
		retained.add(key);
		let blockView = view.blocks.get(key);
		if (!blockView) {
			blockView = createBlockView(block, documentRef);
			view.blocks.set(key, blockView);
			changed = true;
		}
		if (updateBlockView(blockView, block, toolById.get(block.id), documentRef)) changed = true;
		if (blockView.node !== cursor) view.body.insertBefore(blockView.node, cursor);
		cursor = blockView.node.nextSibling;
	}
	for (const [key, blockView] of view.blocks) {
		if (retained.has(key)) continue;
		blockView.node.remove();
		view.blocks.delete(key);
		changed = true;
	}

	const errorText = message.errorMessage ?? "";
	if (errorText) {
		if (!view.error) {
			view.error = documentRef.createElement("p");
			view.error.className = "message-error";
			view.body.append(view.error);
			changed = true;
		}
		if (view.error.textContent !== errorText) {
			view.error.textContent = errorText;
			changed = true;
		}
	} else if (view.error) {
		view.error.remove();
		view.error = undefined;
		changed = true;
	}
	return changed;
}

function createBlockView(block, documentRef) {
	if (block.type === "thinking") {
		const node = documentRef.createElement("details");
		node.className = "thinking";
		const summary = documentRef.createElement("summary");
		summary.textContent = "Thinking";
		const text = documentRef.createElement("pre");
		node.append(summary, text);
		return { type: block.type, node, text, value: undefined };
	}
	if (block.type === "toolCall") return createToolView(documentRef);
	const node = documentRef.createElement(block.type === "image" ? "span" : "div");
	if (block.type === "image") node.className = "image-chip";
	else node.className = "message-markdown";
	return { type: block.type, node, value: undefined };
}

function updateBlockView(view, block, tool, documentRef) {
	if (block.type === "text") {
		if (view.value === block.text) return false;
		view.value = block.text;
		view.node.replaceChildren(renderMarkdown(block.text, documentRef));
		return true;
	}
	if (block.type === "thinking") {
		if (view.value === block.text) return false;
		view.value = block.text;
		view.text.textContent = block.text;
		return true;
	}
	if (block.type === "image") {
		const label = `Image${block.mimeType ? ` · ${block.mimeType}` : ""}`;
		if (view.value === label) return false;
		view.value = label;
		view.node.textContent = label;
		return true;
	}
	if (block.type === "toolCall") return updateToolView(view, block, tool);
	return false;
}

function createToolView(documentRef) {
	const node = documentRef.createElement("details");
	node.className = "tool";
	const summary = documentRef.createElement("summary");
	const title = documentRef.createElement("span");
	const command = documentRef.createElement("code");
	command.className = "tool-command";
	const args = documentRef.createElement("pre");
	args.className = "tool-arguments";
	const result = documentRef.createElement("pre");
	result.className = "tool-result";
	summary.append(title, command);
	node.append(summary, args, result);
	return { type: "toolCall", node, title, command, args, result, value: undefined };
}

function updateToolView(view, call, tool) {
	const phase = toolPhaseLabel(tool);
	const command = toolCommandPreview(tool);
	const args = safeJson(tool?.args ?? call.arguments);
	const result = tool?.result === undefined ? "" : safeJson(tool.result);
	const value = JSON.stringify([call.name, phase, command, args, result, Boolean(tool?.isError)]);
	if (view.value === value) return false;
	view.value = value;
	view.node.className = `tool ${tool?.isError ? "failed" : ""}`;
	view.title.textContent = `${call.name} · ${phase}`;
	view.command.textContent = command;
	view.command.hidden = !command;
	view.args.textContent = args;
	view.result.textContent = result;
	view.result.hidden = !result;
	return true;
}

function roleLabel(message) {
	if (message.role === "user") return "You";
	if (message.role === "assistant") return message.final ? "Pi" : "Pi · Streaming";
	if (message.role === "toolResult") {
		return message.toolName ? `Tool · ${message.toolName}` : "Tool";
	}
	return message.role;
}

function knownRole(role) {
	if (role === "user" || role === "assistant" || role === "toolResult") return role;
	return "other";
}

function safeJson(value) {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return "Details unavailable";
	}
}
