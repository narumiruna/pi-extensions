import { type ColorPalette, parseStyle, type StyledChunk, type TextStyle } from "./style.js";

export type FormatNode =
	| { type: "text"; value: string }
	| { type: "variable"; name: string }
	| { type: "group"; children: FormatNode[]; style: StyleNode[] }
	| { type: "conditional"; children: FormatNode[] };

export type StyleNode = { type: "text"; value: string } | { type: "variable"; name: string };
export type FormatValue = string | readonly StyledChunk[] | undefined;

export interface RenderFormatOptions {
	variables: Readonly<Record<string, FormatValue>>;
	styleVariables?: Readonly<Record<string, string | undefined>>;
	palette?: ColorPalette;
}

export class FormatSyntaxError extends Error {
	readonly offset: number;

	constructor(message: string, offset: number) {
		super(`${message} at offset ${offset}`);
		this.name = "FormatSyntaxError";
		this.offset = offset;
	}
}

const FUNCTIONAL = new Set(["[", "]", "(", ")", "\\", "$"]);

export function parseFormat(format: string): FormatNode[] {
	const parser = new FormatParser(format);
	const nodes = parser.parseNodes();
	if (!parser.done()) throw new FormatSyntaxError("Unexpected character", parser.offset());
	return nodes;
}

class FormatParser {
	private index = 0;

	constructor(private readonly input: string) {}

	offset() {
		return this.index;
	}

	done() {
		return this.index === this.input.length;
	}

	parseNodes(end?: "]" | ")"): FormatNode[] {
		const nodes: FormatNode[] = [];
		let text = "";
		const flushText = () => {
			if (!text) return;
			nodes.push({ type: "text", value: text });
			text = "";
		};

		while (!this.done()) {
			const current = this.input[this.index];
			if (current === end) {
				flushText();
				this.index += 1;
				return nodes;
			}
			if (current === "\\") {
				const escaped = this.input[this.index + 1];
				if (!escaped || !FUNCTIONAL.has(escaped)) {
					throw new FormatSyntaxError("Invalid escape", this.index);
				}
				text += escaped;
				this.index += 2;
				continue;
			}
			if (current === "$") {
				flushText();
				nodes.push({ type: "variable", name: this.parseVariable() });
				continue;
			}
			if (current === "[") {
				flushText();
				this.index += 1;
				const children = this.parseNodes("]");
				if (this.input[this.index] !== "(") {
					throw new FormatSyntaxError("Text group requires a style", this.index);
				}
				this.index += 1;
				nodes.push({ type: "group", children, style: this.parseStyleNodes() });
				continue;
			}
			if (current === "(") {
				flushText();
				this.index += 1;
				nodes.push({ type: "conditional", children: this.parseNodes(")") });
				continue;
			}
			if (current === "]" || current === ")") {
				throw new FormatSyntaxError(`Unexpected ${current}`, this.index);
			}
			text += current;
			this.index += 1;
		}

		if (end) throw new FormatSyntaxError(`Missing ${end}`, this.index);
		flushText();
		return nodes;
	}

	private parseVariable(): string {
		const start = this.index;
		this.index += 1;
		if (this.input[this.index] === "{") {
			this.index += 1;
			const nameStart = this.index;
			while (!this.done() && this.input[this.index] !== "}") {
				const current = this.input[this.index];
				if (!current || FUNCTIONAL.has(current) || current === "{") {
					throw new FormatSyntaxError("Invalid scoped variable", this.index);
				}
				this.index += 1;
			}
			if (this.done() || this.index === nameStart) {
				throw new FormatSyntaxError("Unclosed scoped variable", start);
			}
			const name = this.input.slice(nameStart, this.index);
			this.index += 1;
			return name;
		}
		const match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(this.input.slice(this.index));
		if (!match) throw new FormatSyntaxError("Invalid variable", start);
		this.index += match[0].length;
		return match[0];
	}

	private parseStyleNodes(): StyleNode[] {
		const nodes: StyleNode[] = [];
		let text = "";
		const flushText = () => {
			if (!text) return;
			nodes.push({ type: "text", value: text });
			text = "";
		};
		while (!this.done()) {
			const current = this.input[this.index];
			if (current === ")") {
				flushText();
				this.index += 1;
				return nodes;
			}
			if (current === "$") {
				flushText();
				nodes.push({ type: "variable", name: this.parseVariable() });
				continue;
			}
			if (current === "(" || current === "[" || current === "]" || current === "\\") {
				throw new FormatSyntaxError("Invalid style character", this.index);
			}
			text += current;
			this.index += 1;
		}
		throw new FormatSyntaxError("Missing )", this.index);
	}
}

export function formatVariables(nodes: readonly FormatNode[]): Set<string> {
	const variables = new Set<string>();
	for (const node of nodes) {
		if (node.type === "variable") variables.add(node.name);
		else if (node.type === "group" || node.type === "conditional") {
			for (const variable of formatVariables(node.children)) variables.add(variable);
		}
	}
	return variables;
}

export function styleVariables(nodes: readonly FormatNode[]): Set<string> {
	const variables = new Set<string>();
	for (const node of nodes) {
		if (node.type === "group") {
			for (const part of node.style) {
				if (part.type === "variable") variables.add(part.name);
			}
		}
		if (node.type === "group" || node.type === "conditional") {
			for (const variable of styleVariables(node.children)) variables.add(variable);
		}
	}
	return variables;
}

export function renderFormat(
	nodes: readonly FormatNode[],
	options: RenderFormatOptions,
): StyledChunk[] {
	return renderNodes(nodes, options, undefined);
}

function renderNodes(
	nodes: readonly FormatNode[],
	options: RenderFormatOptions,
	inheritedStyle: TextStyle | undefined,
): StyledChunk[] {
	const chunks: StyledChunk[] = [];
	for (const node of nodes) {
		switch (node.type) {
			case "text":
				chunks.push({ text: node.value, style: inheritedStyle });
				break;
			case "variable":
				chunks.push(...chunksForValue(ownValue(options.variables, node.name), inheritedStyle));
				break;
			case "conditional":
				if (conditionalVisible(node.children, options.variables)) {
					chunks.push(...renderNodes(node.children, options, inheritedStyle));
				}
				break;
			case "group": {
				const styleString = node.style
					.map((part) =>
						part.type === "text" ? part.value : (ownValue(options.styleVariables, part.name) ?? ""),
					)
					.join("");
				const style = parseStyle(styleString, options.palette);
				const rendered = renderNodes(node.children, options, style);
				if (node.children.length === 0) chunks.push({ text: "", style });
				else chunks.push(...rendered);
				break;
			}
		}
	}
	return chunks;
}

function ownValue<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
	return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

function chunksForValue(value: FormatValue, inheritedStyle: TextStyle | undefined): StyledChunk[] {
	if (value === undefined) return [];
	if (typeof value === "string") return [{ text: value, style: inheritedStyle }];
	return value.map((chunk) => ({
		...chunk,
		style: chunk.style ?? inheritedStyle,
	}));
}

function conditionalVisible(
	nodes: readonly FormatNode[],
	variables: Readonly<Record<string, FormatValue>>,
): boolean {
	for (const variable of formatVariables(nodes)) {
		const value = ownValue(variables, variable);
		if (
			typeof value === "string" ? value.length > 0 : value?.some((chunk) => chunk.text.length > 0)
		) {
			return true;
		}
	}
	return false;
}
