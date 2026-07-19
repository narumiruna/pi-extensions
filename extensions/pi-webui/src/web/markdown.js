export function parseMarkdown(input) {
	const lines = String(input ?? "")
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.split("\n");
	const blocks = [];
	let index = 0;
	while (index < lines.length) {
		const line = lines[index];
		if (!line.trim()) {
			index += 1;
			continue;
		}
		const fence = line.match(/^\s*```([\w-]*)\s*$/);
		if (fence) {
			const content = [];
			index += 1;
			while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
				content.push(lines[index]);
				index += 1;
			}
			if (index < lines.length) index += 1;
			blocks.push({ type: "codeBlock", language: fence[1] ?? "", text: content.join("\n") });
			continue;
		}
		const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
		if (heading) {
			blocks.push({
				type: "heading",
				level: heading[1].length,
				children: parseInline(heading[2]),
			});
			index += 1;
			continue;
		}
		if (/^\s*>\s?/.test(line)) {
			const quoted = [];
			while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
				quoted.push(lines[index].replace(/^\s*>\s?/, ""));
				index += 1;
			}
			blocks.push({ type: "blockquote", children: parseMarkdown(quoted.join("\n")) });
			continue;
		}
		const list = line.match(/^\s*(?:(\d+)[.)]|([-+*]))\s+(.+)$/);
		if (list) {
			const ordered = Boolean(list[1]);
			const items = [];
			while (index < lines.length) {
				const item = lines[index].match(/^\s*(?:(\d+)[.)]|([-+*]))\s+(.+)$/);
				if (!item || Boolean(item[1]) !== ordered) break;
				items.push(parseInline(item[3]));
				index += 1;
			}
			blocks.push({ type: "list", ordered, items });
			continue;
		}
		const paragraph = [line];
		index += 1;
		while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) {
			paragraph.push(lines[index]);
			index += 1;
		}
		blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
	}
	return blocks;
}

export function isSafeLink(url) {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

export function renderMarkdown(input, documentRef = document) {
	const fragment = documentRef.createDocumentFragment();
	for (const block of parseMarkdown(input)) fragment.append(renderBlock(block, documentRef));
	return fragment;
}

function startsBlock(line) {
	return (
		/^\s*```/.test(line) ||
		/^\s{0,3}#{1,6}\s+/.test(line) ||
		/^\s*>\s?/.test(line) ||
		/^\s*(?:(?:\d+)[.)]|[-+*])\s+/.test(line)
	);
}

function parseInline(text) {
	const nodes = [];
	let index = 0;
	while (index < text.length) {
		const codeEnd = text[index] === "`" ? text.indexOf("`", index + 1) : -1;
		if (codeEnd > index + 1) {
			nodes.push({ type: "code", text: text.slice(index + 1, codeEnd) });
			index = codeEnd + 1;
			continue;
		}
		const link = text.slice(index).match(/^\[([^\]]+)\]\(([^)\s]+)\)/);
		if (link) {
			if (isSafeLink(link[2])) {
				nodes.push({ type: "link", href: link[2], children: parseInline(link[1]) });
			} else {
				pushText(nodes, link[0]);
			}
			index += link[0].length;
			continue;
		}
		const strongEnd = text.startsWith("**", index) ? text.indexOf("**", index + 2) : -1;
		if (strongEnd > index + 2) {
			nodes.push({ type: "strong", children: parseInline(text.slice(index + 2, strongEnd)) });
			index = strongEnd + 2;
			continue;
		}
		const emphasisEnd = text[index] === "*" ? text.indexOf("*", index + 1) : -1;
		if (emphasisEnd > index + 1) {
			nodes.push({ type: "emphasis", children: parseInline(text.slice(index + 1, emphasisEnd)) });
			index = emphasisEnd + 1;
			continue;
		}
		pushText(nodes, text[index]);
		index += 1;
	}
	return nodes;
}

function pushText(nodes, text) {
	const previous = nodes.at(-1);
	if (previous?.type === "text") previous.text += text;
	else nodes.push({ type: "text", text });
}

function renderBlock(block, documentRef) {
	if (block.type === "heading") {
		const heading = documentRef.createElement(`h${Math.min(6, block.level + 2)}`);
		heading.className = "markdown-heading";
		appendInline(heading, block.children, documentRef);
		return heading;
	}
	if (block.type === "list") {
		const list = documentRef.createElement(block.ordered ? "ol" : "ul");
		list.className = "markdown-list";
		for (const children of block.items) {
			const item = documentRef.createElement("li");
			appendInline(item, children, documentRef);
			list.append(item);
		}
		return list;
	}
	if (block.type === "blockquote") {
		const quote = documentRef.createElement("blockquote");
		for (const child of block.children) quote.append(renderBlock(child, documentRef));
		return quote;
	}
	if (block.type === "codeBlock") {
		const pre = documentRef.createElement("pre");
		pre.className = "markdown-code";
		const code = documentRef.createElement("code");
		if (block.language) code.dataset.language = block.language;
		code.append(documentRef.createTextNode(block.text));
		pre.append(code);
		return pre;
	}
	const paragraph = documentRef.createElement("p");
	paragraph.className = "message-text";
	appendInline(paragraph, block.children, documentRef);
	return paragraph;
}

function appendInline(parent, nodes, documentRef) {
	for (const node of nodes) {
		if (node.type === "text") {
			parent.append(documentRef.createTextNode(node.text));
			continue;
		}
		const element = documentRef.createElement(
			node.type === "code"
				? "code"
				: node.type === "strong"
					? "strong"
					: node.type === "emphasis"
						? "em"
						: "a",
		);
		if (node.type === "link") {
			element.href = node.href;
			element.target = "_blank";
			element.rel = "noopener noreferrer";
		}
		if (node.type === "code") element.append(documentRef.createTextNode(node.text));
		else appendInline(element, node.children, documentRef);
		parent.append(element);
	}
}
