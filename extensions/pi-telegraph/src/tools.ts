import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	type ExtensionContext,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ensureTelegraphAccount, requireTelegraphAccessToken } from "./account.js";
import { telegraphRequest } from "./client.js";
import {
	markdownToTelegraphNodes,
	type TelegraphNode,
	telegraphNodesToMarkdown,
	validateTelegraphNodes,
} from "./content.js";
import { saveTemporaryOutput } from "./outputs.js";

const STATUS_KEY = "telegraph";

interface TelegraphPage {
	path: string;
	url: string;
	title: string;
	description?: string;
	author_name?: string;
	author_url?: string;
	image_url?: string;
	content?: TelegraphNode[];
	views?: number;
	can_edit?: boolean;
}

type ContentParams = { markdown?: unknown; nodes?: unknown };

const contentProperties = {
	markdown: Type.Optional(
		Type.String({ description: "Markdown content. Mutually exclusive with nodes." }),
	),
	nodes: Type.Optional(
		Type.Array(Type.Any(), {
			description: "Raw Telegraph Node array. Mutually exclusive with markdown.",
			minItems: 1,
		}),
	),
};
const mutationProperties = {
	authorName: Type.Optional(
		Type.String({ description: "Author name override. An empty string clears it on edit." }),
	),
	authorUrl: Type.Optional(
		Type.String({ description: "HTTP/HTTPS author URL. An empty string clears it on edit." }),
	),
	confirmed: Type.Optional(
		Type.Boolean({
			description:
				"Required as true in print/JSON mode after the user explicitly requests this public mutation. Interactive modes still prompt.",
		}),
	),
};

export const createPageTool = defineTool({
	name: "telegraph_create_page",
	label: "Telegraph: Create Page",
	description:
		"Create and immediately publish a public Telegraph page from Markdown or raw Telegraph nodes.",
	promptSnippet: "Create and publish a public Telegraph page",
	promptGuidelines: [
		"Use telegraph_create_page only when the user explicitly asks to publish public content; Telegraph pages have no delete API.",
		"Do not set telegraph_create_page confirmed=true unless the user explicitly authorized publication in a headless run.",
		"Do not retry telegraph_create_page after the user cancels its confirmation.",
	],
	parameters: Type.Object({
		title: Type.String({ description: "Public page title, 1-256 characters." }),
		...contentProperties,
		...mutationProperties,
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const title = validateTitle(params.title);
		const content = resolveContent(params, true);
		const hasAuthorName = Object.hasOwn(params, "authorName");
		const hasAuthorUrl = Object.hasOwn(params, "authorUrl");
		const authorName = validateAuthorName(params.authorName, hasAuthorName);
		const authorUrl = validateAuthorUrl(params.authorUrl, hasAuthorUrl);
		if (
			!(await confirmMutation(ctx, params.confirmed, `Publish public Telegraph page “${title}”?`))
		) {
			return cancelledResult("Telegraph page publication cancelled by the user. Do not retry it.");
		}

		return withStatus(ctx, "publishing", async () => {
			const account = await ensureTelegraphAccount(signal);
			const accessToken = account.config.accessToken;
			if (!accessToken) throw new Error("Telegraph account setup did not produce an access token.");
			const page = parsePage(
				await telegraphRequest(
					"createPage",
					undefined,
					{
						access_token: accessToken,
						title,
						author_name: hasAuthorName ? authorName : account.config.authorName,
						author_url: hasAuthorUrl ? authorUrl : account.config.authorUrl,
						content: JSON.stringify(content),
						return_content: false,
					},
					signal,
				),
				false,
			);
			return {
				content: [
					{
						type: "text" as const,
						text: [
							"Published Telegraph page.",
							`Title: ${page.title}`,
							`URL: ${page.url}`,
							`Path: ${page.path}`,
							`Account created: ${account.accountCreated ? "yes" : "no"}`,
						].join("\n"),
					},
				],
				details: { page: pageMetadata(page), accountCreated: account.accountCreated },
			};
		});
	},
});

export const getPageTool = defineTool({
	name: "telegraph_get_page",
	label: "Telegraph: Get Page",
	description: `Read a Telegraph page as Markdown or raw nodes. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; complete truncated output is saved privately to a temporary file.`,
	promptSnippet: "Read a public Telegraph page",
	parameters: Type.Object({
		path: Type.String({ description: "Bare Telegraph path or https://telegra.ph/... URL." }),
		rawNodes: Type.Optional(
			Type.Boolean({ description: "Return raw Telegraph Node JSON instead of Markdown." }),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const path = normalizeTelegraphPath(params.path);
		return withStatus(ctx, "fetching", async () => {
			const page = parsePage(
				await telegraphRequest("getPage", path, { return_content: true }, signal),
				true,
			);
			return formatFetchedPage(page, params.rawNodes === true);
		});
	},
});

export const editPageTool = defineTool({
	name: "telegraph_edit_page",
	label: "Telegraph: Edit Page",
	description:
		"Edit a public Telegraph page while preserving every omitted title, content, and author field.",
	promptSnippet: "Edit an existing public Telegraph page",
	promptGuidelines: [
		"Use telegraph_edit_page only when the user explicitly asks to change a public Telegraph page.",
		"Do not set telegraph_edit_page confirmed=true unless the user explicitly authorized the edit in a headless run.",
		"Do not retry telegraph_edit_page after the user cancels its confirmation.",
	],
	parameters: Type.Object({
		path: Type.String({ description: "Bare Telegraph path or https://telegra.ph/... URL." }),
		title: Type.Optional(Type.String({ description: "Replacement title, 1-256 characters." })),
		...contentProperties,
		...mutationProperties,
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const path = normalizeTelegraphPath(params.path);
		assertEditHasChanges(params);
		const title = params.title === undefined ? undefined : validateTitle(params.title);
		const replacementContent = resolveContent(params, false);
		const authorName = Object.hasOwn(params, "authorName")
			? validateAuthorName(params.authorName, true)
			: undefined;
		const authorUrl = Object.hasOwn(params, "authorUrl")
			? validateAuthorUrl(params.authorUrl, true)
			: undefined;
		if (!(await confirmMutation(ctx, params.confirmed, `Edit public Telegraph page “${path}”?`))) {
			return cancelledResult("Telegraph page edit cancelled by the user. Do not retry it.");
		}

		return withStatus(ctx, "editing", async () => {
			const { accessToken } = await requireTelegraphAccessToken();
			const current = parsePage(
				await telegraphRequest("getPage", path, { return_content: true }, signal),
				true,
			);
			const page = parsePage(
				await telegraphRequest(
					"editPage",
					path,
					{
						access_token: accessToken,
						title: title ?? current.title,
						content: JSON.stringify(replacementContent ?? current.content),
						author_name: authorName ?? current.author_name ?? "",
						author_url: authorUrl ?? current.author_url ?? "",
						return_content: false,
					},
					signal,
				),
				false,
			);
			return {
				content: [
					{
						type: "text" as const,
						text: [
							"Updated Telegraph page.",
							`Title: ${page.title}`,
							`URL: ${page.url}`,
							`Path: ${page.path}`,
						].join("\n"),
					},
				],
				details: { page: pageMetadata(page) },
			};
		});
	},
});

export function normalizeTelegraphPath(value: string) {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error("Telegraph path must be a non-empty string.");
	}
	const input = value.trim();
	let path = input.replace(/^\/+/, "");
	if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) {
		let url: URL;
		try {
			url = new URL(input);
		} catch {
			throw new Error(`Invalid Telegraph URL: ${input}`);
		}
		if (
			url.protocol !== "https:" ||
			url.hostname.toLowerCase() !== "telegra.ph" ||
			url.port ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			throw new Error("Telegraph URLs must use the exact https://telegra.ph/<path> form.");
		}
		path = url.pathname.replace(/^\/+|\/+$/g, "");
	}
	try {
		path = decodeURIComponent(path);
	} catch {
		throw new Error(`Invalid encoded Telegraph path: ${path}`);
	}
	if (
		!path ||
		path === "." ||
		path === ".." ||
		path.includes("/") ||
		/[\\/:?#\s]/u.test(path) ||
		Array.from(path).length > 512
	) {
		throw new Error(`Invalid Telegraph page path: ${path || "(empty)"}.`);
	}
	return path;
}

async function formatFetchedPage(page: TelegraphPage, rawNodes: boolean) {
	const content = page.content ?? [];
	const fullOutput = rawNodes
		? JSON.stringify({ ...pageMetadata(page), content }, null, 2)
		: [
				"Telegraph page",
				`Title: ${page.title}`,
				`URL: ${page.url}`,
				`Path: ${page.path}`,
				...(page.author_name ? [`Author: ${page.author_name}`] : []),
				...(typeof page.views === "number" ? [`Views: ${page.views}`] : []),
				"",
				"Content (Markdown):",
				telegraphNodesToMarkdown(content).trimEnd(),
			].join("\n");
	let truncated = truncateHead(fullOutput, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});
	let text = fullOutput;
	let fullOutputPath: string | undefined;
	if (truncated.truncated) {
		fullOutputPath = await saveTemporaryOutput(`${fullOutput}\n`, rawNodes ? ".json" : ".md");
		const note = `[Output truncated. Full output saved to: ${fullOutputPath}]`;
		truncated = truncateHead(fullOutput, {
			maxBytes: Math.max(1, DEFAULT_MAX_BYTES - Buffer.byteLength(`\n\n${note}`)),
			maxLines: DEFAULT_MAX_LINES - 2,
		});
		text = `${truncated.content}\n\n${note}`;
	}
	return {
		content: [{ type: "text" as const, text }],
		details: {
			page: pageMetadata(page),
			truncated: truncated.truncated,
			...(fullOutputPath ? { fullOutputPath } : {}),
		},
	};
}

function parsePage(value: unknown, requireContent: boolean): TelegraphPage {
	if (!isPlainObject(value)) throw new Error("Telegraph returned a malformed Page object.");
	for (const field of ["path", "url", "title"] as const) {
		if (typeof value[field] !== "string" || !value[field]) {
			throw new Error(`Telegraph Page is missing ${field}.`);
		}
	}
	const path = value.path;
	const url = value.url;
	const title = value.title;
	if (typeof path !== "string" || typeof url !== "string" || typeof title !== "string") {
		throw new Error("Telegraph Page has invalid required fields.");
	}
	const normalizedPath = normalizeTelegraphPath(path);
	if (normalizeTelegraphPath(url) !== normalizedPath) {
		throw new Error("Telegraph Page URL does not match its path.");
	}
	const page: TelegraphPage = { path: normalizedPath, url, title: validateTitle(title) };
	for (const field of ["description", "author_name", "author_url", "image_url"] as const) {
		if (value[field] !== undefined) {
			if (typeof value[field] !== "string") throw new Error(`Telegraph Page ${field} is invalid.`);
			page[field] = value[field];
		}
	}
	if (page.author_name !== undefined) page.author_name = validateAuthorName(page.author_name, true);
	if (page.author_url !== undefined) page.author_url = validateAuthorUrl(page.author_url, true);
	if (value.views !== undefined) {
		if (typeof value.views !== "number" || !Number.isFinite(value.views)) {
			throw new Error("Telegraph Page views is invalid.");
		}
		page.views = value.views;
	}
	if (value.can_edit !== undefined) {
		if (typeof value.can_edit !== "boolean") throw new Error("Telegraph Page can_edit is invalid.");
		page.can_edit = value.can_edit;
	}
	if (value.content !== undefined) page.content = validateTelegraphNodes(value.content);
	if (requireContent && !page.content) throw new Error("Telegraph Page response omitted content.");
	return page;
}

function resolveContent(params: ContentParams, required: true): TelegraphNode[];
function resolveContent(params: ContentParams, required: false): TelegraphNode[] | undefined;
function resolveContent(params: ContentParams, required: boolean) {
	const hasMarkdown = params.markdown !== undefined;
	const hasNodes = params.nodes !== undefined;
	if (hasMarkdown && hasNodes) {
		throw new Error("Provide exactly one of markdown or nodes, not both.");
	}
	if (!hasMarkdown && !hasNodes) {
		if (required) throw new Error("Provide exactly one of markdown or nodes.");
		return undefined;
	}
	if (hasMarkdown) {
		if (typeof params.markdown !== "string") throw new Error("markdown must be a string.");
		return markdownToTelegraphNodes(params.markdown);
	}
	return validateTelegraphNodes(params.nodes);
}

function assertEditHasChanges(params: Record<string, unknown>) {
	if (
		!["title", "markdown", "nodes", "authorName", "authorUrl"].some(
			(key) => Object.hasOwn(params, key) && params[key] !== undefined,
		)
	) {
		throw new Error(
			"telegraph_edit_page requires at least one changed title, content, authorName, or authorUrl field.",
		);
	}
}

function validateTitle(value: unknown) {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error("Telegraph title must be a non-empty string.");
	}
	const title = value.trim();
	if (hasControlCharacter(title)) {
		throw new Error("Telegraph title must not contain control characters.");
	}
	if (Array.from(title).length > 256) {
		throw new Error("Telegraph title must be at most 256 characters.");
	}
	return title;
}

function validateAuthorName(value: unknown, allowEmpty = false) {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error("Telegraph authorName must be a string.");
	const authorName = value.trim();
	if (!authorName && allowEmpty) return "";
	if (!authorName) return undefined;
	if (hasControlCharacter(authorName)) {
		throw new Error("Telegraph authorName must not contain control characters.");
	}
	if (Array.from(authorName).length > 128) {
		throw new Error("Telegraph authorName must be at most 128 characters.");
	}
	return authorName;
}

function validateAuthorUrl(value: unknown, allowEmpty = false) {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error("Telegraph authorUrl must be a string.");
	const authorUrl = value.trim();
	if (!authorUrl && allowEmpty) return "";
	if (!authorUrl) return undefined;
	if (hasControlCharacter(authorUrl)) {
		throw new Error("Telegraph authorUrl must not contain control characters.");
	}
	if (Array.from(authorUrl).length > 512) {
		throw new Error("Telegraph authorUrl must be at most 512 characters.");
	}
	let url: URL;
	try {
		url = new URL(authorUrl);
	} catch {
		throw new Error("Telegraph authorUrl must be an HTTP or HTTPS URL.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Telegraph authorUrl must be an HTTP or HTTPS URL.");
	}
	return authorUrl;
}

async function confirmMutation(
	ctx: ExtensionContext,
	confirmed: boolean | undefined,
	message: string,
) {
	if (ctx.hasUI) {
		return ctx.ui.confirm(
			"Public Telegraph mutation",
			`${message}\n\nThe page is public immediately and Telegraph has no delete API.`,
		);
	}
	if (confirmed !== true) {
		throw new Error(
			"Public Telegraph mutations in print/JSON mode require confirmed: true after explicit user authorization.",
		);
	}
	return true;
}

function cancelledResult(message: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: { cancelled: true },
	};
}

async function withStatus<T>(ctx: ExtensionContext, status: string, callback: () => Promise<T>) {
	ctx.ui.setStatus(STATUS_KEY, status);
	try {
		return await callback();
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

function pageMetadata(page: TelegraphPage) {
	const { content: _content, ...metadata } = page;
	return metadata;
}

function hasControlCharacter(value: string) {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
