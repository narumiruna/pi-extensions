import { lexer, type Token, type Tokens } from "marked";

export const MAX_CONTENT_BYTES = 64 * 1024;
export const MAX_MARKDOWN_BYTES = MAX_CONTENT_BYTES * 4;
const MAX_NODE_DEPTH = 64;
const MAX_NODE_COUNT = 10_000;
const TELEGRAPH_TAGS = new Set([
	"a",
	"aside",
	"b",
	"blockquote",
	"br",
	"code",
	"em",
	"figcaption",
	"figure",
	"h3",
	"h4",
	"hr",
	"i",
	"iframe",
	"img",
	"li",
	"ol",
	"p",
	"pre",
	"s",
	"strong",
	"u",
	"ul",
	"video",
]);

export type TelegraphNode = string | TelegraphNodeElement;
export interface TelegraphNodeElement {
	tag: string;
	attrs?: Record<string, string>;
	children?: TelegraphNode[];
}

export function markdownToTelegraphNodes(markdown: string): TelegraphNode[] {
	if (typeof markdown !== "string" || markdown.trim().length === 0) {
		throw new Error("markdown must be a non-empty string.");
	}
	if (Buffer.byteLength(markdown) > MAX_MARKDOWN_BYTES) {
		throw new Error("markdown is too large to safely convert to Telegraph content.");
	}
	const nodes = blockTokensToNodes(lexer(markdown));
	return validateTelegraphNodes(nodes);
}

export function validateTelegraphNodes(value: unknown): TelegraphNode[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error("Telegraph content nodes must be a non-empty array.");
	}
	let nodeCount = 0;
	const ancestors = new Set<object>();
	const cloneNode = (node: unknown, depth: number): TelegraphNode => {
		if (depth > MAX_NODE_DEPTH) {
			throw new Error(`Telegraph node nesting exceeds the ${MAX_NODE_DEPTH}-level limit.`);
		}
		nodeCount += 1;
		if (nodeCount > MAX_NODE_COUNT) {
			throw new Error(`Telegraph content exceeds the ${MAX_NODE_COUNT}-node limit.`);
		}
		if (typeof node === "string") return node;
		if (!isPlainObject(node)) {
			throw new Error("Each Telegraph node must be a string or a plain node object.");
		}
		if (ancestors.has(node)) throw new Error("Telegraph content contains a node cycle.");
		ancestors.add(node);
		try {
			const keys = Object.keys(node);
			const unknown = keys.filter((key) => !["tag", "attrs", "children"].includes(key));
			if (unknown.length > 0) {
				throw new Error(`Telegraph node contains unknown property: ${unknown.join(", ")}.`);
			}
			if (typeof node.tag !== "string" || !TELEGRAPH_TAGS.has(node.tag)) {
				throw new Error(`Unsupported Telegraph tag: ${String(node.tag)}.`);
			}
			const result: TelegraphNodeElement = { tag: node.tag };
			if (node.attrs !== undefined) result.attrs = validateAttributes(node.tag, node.attrs);
			if (node.children !== undefined) {
				if (!Array.isArray(node.children)) {
					throw new Error(`Telegraph ${node.tag} children must be an array.`);
				}
				result.children = node.children.map((child) => cloneNode(child, depth + 1));
			}
			return result;
		} finally {
			ancestors.delete(node);
		}
	};

	const normalized = value.map((node) => cloneNode(node, 0));
	if (!containsMeaningfulContent(normalized)) {
		throw new Error("Telegraph content nodes must not be empty.");
	}
	if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_CONTENT_BYTES) {
		throw new Error("Telegraph content exceeds the 64 KB API limit.");
	}
	return normalized;
}

export function telegraphNodesToMarkdown(value: unknown): string {
	const nodes = validateTelegraphNodes(value);
	const output = nodes
		.map((node) => renderBlock(node, 0))
		.join("")
		.trim();
	return output ? `${output}\n` : "";
}

function blockTokensToNodes(tokens: Token[]): TelegraphNode[] {
	const nodes: TelegraphNode[] = [];
	for (const token of tokens) {
		switch (token.type) {
			case "space":
			case "def":
				break;
			case "heading": {
				const heading = token as Tokens.Heading;
				nodes.push({
					tag: heading.depth <= 3 ? "h3" : "h4",
					children: inlineTokensToNodes(heading.tokens),
				});
				break;
			}
			case "paragraph": {
				const paragraph = token as Tokens.Paragraph;
				nodes.push({ tag: "p", children: inlineTokensToNodes(paragraph.tokens) });
				break;
			}
			case "text": {
				const text = token as Tokens.Text;
				nodes.push({
					tag: "p",
					children: text.tokens ? inlineTokensToNodes(text.tokens) : [text.text],
				});
				break;
			}
			case "code":
				nodes.push({ tag: "pre", children: [(token as Tokens.Code).text] });
				break;
			case "blockquote":
				nodes.push({
					tag: "blockquote",
					children: blockTokensToNodes((token as Tokens.Blockquote).tokens),
				});
				break;
			case "hr":
				nodes.push({ tag: "hr" });
				break;
			case "list":
				nodes.push(listTokenToNode(token as Tokens.List));
				break;
			case "table":
				nodes.push({ tag: "pre", children: [tableToText(token as Tokens.Table)] });
				break;
			case "html":
				nodes.push({ tag: "p", children: [(token as Tokens.HTML).text] });
				break;
			default:
				if (typeof token.raw === "string" && token.raw.trim()) {
					nodes.push({ tag: "p", children: [token.raw] });
				}
		}
	}
	return nodes;
}

function inlineTokensToNodes(tokens: Token[]): TelegraphNode[] {
	const nodes: TelegraphNode[] = [];
	for (const token of tokens) {
		switch (token.type) {
			case "text": {
				const text = token as Tokens.Text;
				appendNodes(nodes, text.tokens ? inlineTokensToNodes(text.tokens) : [text.text]);
				break;
			}
			case "escape":
				appendNodes(nodes, [(token as Tokens.Escape).text]);
				break;
			case "strong":
				nodes.push({
					tag: "strong",
					children: inlineTokensToNodes((token as Tokens.Strong).tokens),
				});
				break;
			case "em":
				nodes.push({ tag: "em", children: inlineTokensToNodes((token as Tokens.Em).tokens) });
				break;
			case "del":
				nodes.push({ tag: "s", children: inlineTokensToNodes((token as Tokens.Del).tokens) });
				break;
			case "codespan":
				nodes.push({ tag: "code", children: [(token as Tokens.Codespan).text] });
				break;
			case "br":
				nodes.push({ tag: "br" });
				break;
			case "link": {
				const link = token as Tokens.Link;
				const href = normalizeSafeAttribute("a", "href", link.href);
				nodes.push({
					tag: "a",
					attrs: { href },
					children: inlineTokensToNodes(link.tokens),
				});
				break;
			}
			case "image": {
				const image = token as Tokens.Image;
				const src = normalizeSafeAttribute("img", "src", image.href);
				const imageNode: TelegraphNodeElement = { tag: "img", attrs: { src } };
				nodes.push(
					image.text
						? {
								tag: "figure",
								children: [imageNode, { tag: "figcaption", children: [image.text] }],
							}
						: imageNode,
				);
				break;
			}
			case "checkbox":
				appendNodes(nodes, [(token as Tokens.Checkbox).checked ? "[x] " : "[ ] "]);
				break;
			case "html":
				appendNodes(nodes, [(token as Tokens.HTML).text]);
				break;
			default:
				if (typeof token.raw === "string") appendNodes(nodes, [token.raw]);
		}
	}
	return nodes;
}

function listTokenToNode(list: Tokens.List): TelegraphNodeElement {
	return {
		tag: list.ordered ? "ol" : "ul",
		children: list.items.map((item) => {
			const blocks = blockTokensToNodes(item.tokens);
			const children: TelegraphNode[] = [];
			for (const block of blocks) {
				if (typeof block !== "string" && block.tag === "p") {
					appendNodes(children, block.children ?? []);
				} else {
					children.push(block);
				}
			}
			return { tag: "li", children };
		}),
	};
}

function tableToText(table: Tokens.Table) {
	const rows = [table.header, ...table.rows];
	return rows
		.map((row) =>
			row.map((cell) => inlineNodesToPlainText(inlineTokensToNodes(cell.tokens))).join(" | "),
		)
		.join("\n");
}

function validateAttributes(tag: string, value: unknown) {
	if (!isPlainObject(value)) throw new Error(`Telegraph ${tag} attrs must be a plain object.`);
	const result: Record<string, string> = {};
	for (const [name, item] of Object.entries(value)) {
		if (name !== "href" && name !== "src") {
			throw new Error(`Unsupported Telegraph attribute: ${name}.`);
		}
		if (typeof item !== "string" || item.trim().length === 0) {
			throw new Error(`Telegraph ${name} must be a non-empty string.`);
		}
		if (
			(name === "href" && tag !== "a") ||
			(name === "src" && !["img", "iframe", "video"].includes(tag))
		) {
			throw new Error(`Telegraph ${name} is not supported on ${tag}.`);
		}
		result[name] = normalizeSafeAttribute(tag, name, item);
	}
	return result;
}

function normalizeSafeAttribute(tag: string, name: "href" | "src", value: string) {
	const normalized = value.trim();
	let protocol: string;
	try {
		protocol = new URL(normalized, "https://telegra.ph").protocol;
	} catch {
		throw new Error(`Unsafe ${name} URL on Telegraph ${tag}: ${value}.`);
	}
	const allowed = name === "href" ? ["https:", "http:", "mailto:"] : ["https:", "http:"];
	if (!allowed.includes(protocol)) {
		throw new Error(`Unsafe ${name} URL scheme on Telegraph ${tag}: ${protocol}.`);
	}
	return normalized;
}

function containsMeaningfulContent(nodes: TelegraphNode[]): boolean {
	return nodes.some((node) => {
		if (typeof node === "string") return node.trim().length > 0;
		if (["hr", "img", "iframe", "video"].includes(node.tag)) return true;
		return containsMeaningfulContent(node.children ?? []);
	});
}

function renderBlock(node: TelegraphNode, depth: number): string {
	if (typeof node === "string") return `${escapeInline(node)}\n\n`;
	const inline = () => renderInlineChildren(node.children ?? []);
	switch (node.tag) {
		case "h3":
			return `### ${inline()}\n\n`;
		case "h4":
			return `#### ${inline()}\n\n`;
		case "p":
		case "figcaption":
			return `${inline()}\n\n`;
		case "blockquote":
		case "aside": {
			const content = (node.children ?? [])
				.map((child) => renderBlock(child, depth))
				.join("")
				.trim();
			return `${content
				.split("\n")
				.map((line) => `> ${line}`)
				.join("\n")}\n\n`;
		}
		case "pre": {
			const content = inlineNodesToPlainText(node.children ?? []);
			const fence = backtickFence(content, 3);
			return `${fence}\n${content}\n${fence}\n\n`;
		}
		case "ul":
		case "ol":
			return `${renderList(node, depth)}\n\n`;
		case "hr":
			return "---\n\n";
		case "figure":
			return `${(node.children ?? []).map((child) => renderInline(child)).join("")}\n\n`;
		default:
			return `${renderInline(node)}\n\n`;
	}
}

function renderList(node: TelegraphNodeElement, depth: number): string {
	let index = 0;
	return (node.children ?? [])
		.filter(
			(child): child is TelegraphNodeElement => typeof child !== "string" && child.tag === "li",
		)
		.map((item) => {
			index += 1;
			const prefix = node.tag === "ol" ? `${index}. ` : "- ";
			const content: string = (item.children ?? [])
				.map((child) =>
					typeof child !== "string" && (child.tag === "ul" || child.tag === "ol")
						? `\n${renderList(child, depth + 1)}`
						: renderInline(child),
				)
				.join("")
				.trimEnd();
			const indentation = "  ".repeat(depth);
			return `${indentation}${prefix}${content.replace(/\n/g, `\n${indentation}  `)}`;
		})
		.join("\n");
}

function renderInlineChildren(children: TelegraphNode[]) {
	return children.map((child) => renderInline(child)).join("");
}

function renderInline(node: TelegraphNode): string {
	if (typeof node === "string") return escapeInline(node);
	const children = renderInlineChildren(node.children ?? []);
	switch (node.tag) {
		case "strong":
		case "b":
			return `**${children}**`;
		case "em":
		case "i":
			return `*${children}*`;
		case "s":
			return `~~${children}~~`;
		case "code":
			return renderCode(inlineNodesToPlainText(node.children ?? []));
		case "a":
			return `[${children || "Link"}](${markdownDestination(node.attrs?.href ?? "")})`;
		case "img":
			return `![](${markdownDestination(node.attrs?.src ?? "")})`;
		case "iframe":
			return `[Embedded content](${markdownDestination(node.attrs?.src ?? "")})`;
		case "video":
			return `[Video](${markdownDestination(node.attrs?.src ?? "")})`;
		case "br":
			return "  \n";
		case "hr":
			return "---";
		default:
			return children;
	}
}

function markdownDestination(value: string) {
	const escaped = value.replaceAll("<", "%3C").replaceAll(">", "%3E");
	return /[()\s]/u.test(escaped) ? `<${escaped}>` : escaped;
}

function renderCode(content: string) {
	const fence = backtickFence(content, 1);
	const needsPadding =
		content.startsWith("`") ||
		content.endsWith("`") ||
		(content.startsWith(" ") && content.endsWith(" ") && content.trim().length > 0);
	const padding = needsPadding ? " " : "";
	return `${fence}${padding}${content}${padding}${fence}`;
}

function backtickFence(content: string, minimumLength: number) {
	let longestRun = 0;
	for (const match of content.matchAll(/`+/g)) {
		longestRun = Math.max(longestRun, match[0].length);
	}
	return "`".repeat(Math.max(minimumLength, longestRun + 1));
}

function inlineNodesToPlainText(nodes: TelegraphNode[]): string {
	return nodes
		.map((node) => (typeof node === "string" ? node : inlineNodesToPlainText(node.children ?? [])))
		.join("");
}

function escapeInline(value: string) {
	return value.replace(/([\\`*_[\]<>])/g, "\\$1");
}

function appendNodes(target: TelegraphNode[], source: TelegraphNode[]) {
	for (const node of source) {
		const previous = target.at(-1);
		if (typeof previous === "string" && typeof node === "string") {
			target[target.length - 1] = previous + node;
		} else {
			target.push(node);
		}
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
