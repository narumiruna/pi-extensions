import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9222;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_HTTP_TIMEOUT_MS = 1_000;
const DEFAULT_ENDPOINT_WAIT_MS = 5_000;
const DEFAULT_ENDPOINT_RETRY_MS = 250;
const STATUS_KEY = "chrome-devtools";

interface StatusContext {
	ui: { setStatus: (key: string, value: string | undefined) => void };
}

interface DevToolsPage {
	id: string;
	type: string;
	title: string;
	url: string;
	webSocketDebuggerUrl?: string;
}

interface ChromeDevToolsState {
	host: string;
	port: number;
	activePageId?: string;
}

interface CdpResponse<T = unknown> {
	id: number;
	result?: T;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
}

const state: ChromeDevToolsState = {
	host: process.env.PI_CHROME_DEVTOOLS_HOST ?? DEFAULT_HOST,
	port: Number(process.env.PI_CHROME_DEVTOOLS_PORT ?? DEFAULT_PORT),
};

const listPagesTool = defineTool({
	name: "chrome_devtools_list_pages",
	label: "Chrome DevTools: List Pages",
	description: "List Chrome tabs/pages from a running Chrome DevTools Protocol endpoint.",
	promptSnippet: "List Chrome tabs/pages available over Chrome DevTools Protocol",
	parameters: Type.Object({}),
	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		return withStatus(ctx, "🌐 list pages", async () => {
			const pages = await listPages();
			return textResult(JSON.stringify(pages.map(formatPage), null, 2), { pages });
		});
	},
});

const selectPageTool = defineTool({
	name: "chrome_devtools_select_page",
	label: "Chrome DevTools: Select Page",
	description: "Select the active Chrome page for later chrome_devtools_* tool calls.",
	promptSnippet: "Select the Chrome tab/page to inspect or control",
	parameters: Type.Object({
		pageId: Type.String({ description: "Page id from chrome_devtools_list_pages." }),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		return withStatus(ctx, "🌐 select page", async () => {
			const page = await getPage(params.pageId);
			state.activePageId = page.id;
			return textResult(`Selected page ${page.id}: ${page.title}\n${page.url}`, {
				page: formatPage(page),
			});
		});
	},
});

const navigateTool = defineTool({
	name: "chrome_devtools_navigate",
	label: "Chrome DevTools: Navigate",
	description:
		"Navigate a Chrome page to a URL through Chrome DevTools Protocol, creating a page first if none is available.",
	promptSnippet: "Navigate the selected or first Chrome tab to a URL, creating one if needed",
	parameters: Type.Object({
		url: Type.String({ description: "URL to navigate to." }),
		pageId: Type.Optional(
			Type.String({ description: "Optional page id. Defaults to selected or first page." }),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		return withStatus(ctx, "🌐 navigate", async () => {
			const { created, page } = await resolvePageForNavigation(params.pageId);
			const result = await withCdp(page, async (client) => {
				await client.send("Page.enable");
				return client.send("Page.navigate", { url: params.url });
			});

			state.activePageId = page.id;
			const action = created ? "Created page and navigated" : "Navigated";
			return textResult(`${action} ${page.id} to ${params.url}`, {
				created,
				page: formatPage(page),
				result,
			});
		});
	},
});

const evaluateTool = defineTool({
	name: "chrome_devtools_evaluate",
	label: "Chrome DevTools: Evaluate",
	description: "Evaluate JavaScript in a Chrome page through Chrome DevTools Protocol.",
	promptSnippet: "Evaluate JavaScript in the selected Chrome tab",
	parameters: Type.Object({
		expression: Type.String({ description: "JavaScript expression to evaluate." }),
		pageId: Type.Optional(
			Type.String({ description: "Optional page id. Defaults to selected or first page." }),
		),
		awaitPromise: Type.Optional(
			Type.Boolean({ description: "Whether to await a returned Promise. Defaults to true." }),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		return withStatus(ctx, "🌐 evaluate", async () => {
			const page = await resolvePage(params.pageId);
			const result = await withCdp(page, (client) =>
				client.send("Runtime.evaluate", {
					expression: params.expression,
					awaitPromise: params.awaitPromise ?? true,
					returnByValue: true,
				}),
			);

			state.activePageId = page.id;
			return textResult(JSON.stringify(result, null, 2), { page: formatPage(page), result });
		});
	},
});

const screenshotTool = defineTool({
	name: "chrome_devtools_screenshot",
	label: "Chrome DevTools: Screenshot",
	description: "Capture a PNG screenshot from a Chrome page through Chrome DevTools Protocol.",
	promptSnippet: "Capture a screenshot from the selected Chrome tab",
	parameters: Type.Object({
		pageId: Type.Optional(
			Type.String({ description: "Optional page id. Defaults to selected or first page." }),
		),
		fullPage: Type.Optional(
			Type.Boolean({ description: "Capture the full document, not just the viewport." }),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		return withStatus(ctx, "🌐 screenshot", async () => {
			const page = await resolvePage(params.pageId);
			const result = await withCdp(page, async (client) => {
				await client.send("Page.enable");

				if (!params.fullPage) {
					return client.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
				}

				const metrics = await client.send<{
					contentSize: { x: number; y: number; width: number; height: number };
				}>("Page.getLayoutMetrics");

				return client.send<{ data: string }>("Page.captureScreenshot", {
					captureBeyondViewport: true,
					format: "png",
					clip: {
						x: metrics.contentSize.x,
						y: metrics.contentSize.y,
						width: metrics.contentSize.width,
						height: metrics.contentSize.height,
						scale: 1,
					},
				});
			});

			state.activePageId = page.id;
			return {
				content: [
					{ type: "text", text: `Captured PNG screenshot from ${page.title || page.url}` },
					{ type: "image", data: result.data, mimeType: "image/png" },
				],
				details: { page: formatPage(page), bytes: Buffer.byteLength(result.data, "base64") },
			};
		});
	},
});

export default function chromeDevtools(pi: ExtensionAPI) {
	pi.registerTool(listPagesTool);
	pi.registerTool(selectPageTool);
	pi.registerTool(navigateTool);
	pi.registerTool(evaluateTool);
	pi.registerTool(screenshotTool);

	pi.registerCommand("chrome-devtools", {
		description: "Show Chrome DevTools endpoint and quick start help",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Chrome DevTools endpoint: ${devToolsEndpoint()}\n${launchHint()}`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}

async function listPages(options: { waitMs?: number } = {}) {
	return withEndpointRetry(async () => {
		const pages = await fetchDevToolsJson<DevToolsPage[]>("/json/list");
		return pages.filter((page) => page.type === "page" && page.webSocketDebuggerUrl);
	}, options.waitMs ?? DEFAULT_ENDPOINT_WAIT_MS);
}

async function getPage(pageId: string) {
	const pages = await listPages();
	return requirePage(pageId, pages);
}

async function resolvePage(pageId?: string) {
	const pages = await listPages();
	if (pageId) return requirePage(pageId, pages);

	const page = resolveDefaultPage(pages);
	if (!page) {
		throw new Error(
			[
				`No Chrome pages found at ${devToolsEndpoint()}.`,
				"Use chrome_devtools_navigate with a URL to create a page, or open a Chrome tab manually.",
				launchHint(),
			].join("\n"),
		);
	}

	return page;
}

async function resolvePageForNavigation(pageId?: string) {
	const pages = await listPages();
	if (pageId) return { created: false, page: requirePage(pageId, pages) };

	const page = resolveDefaultPage(pages);
	if (page) return { created: false, page };

	return { created: true, page: await createPage("about:blank") };
}

function resolveDefaultPage(pages: DevToolsPage[]) {
	if (!state.activePageId) return pages[0];

	const activePage = pages.find((candidate) => candidate.id === state.activePageId);
	if (activePage) return activePage;

	state.activePageId = undefined;
	return pages[0];
}

function requirePage(pageId: string, pages: DevToolsPage[]) {
	const page = pages.find((candidate) => candidate.id === pageId);
	if (page) return page;

	const availablePages = pages.map(formatPageListItem).join("\n");
	throw new Error(
		[
			`Chrome DevTools page not found: ${pageId}.`,
			availablePages
				? `Available pages:\n${availablePages}`
				: "No inspectable Chrome pages are currently available.",
		].join("\n"),
	);
}

async function createPage(url: string) {
	const page = await fetchDevToolsJson<DevToolsPage>(`/json/new?${encodeURIComponent(url)}`, {
		method: "PUT",
	});
	if (page.type !== "page" || !page.webSocketDebuggerUrl) {
		throw new Error("Chrome DevTools created a target that is not an inspectable page.");
	}

	return page;
}

async function fetchDevToolsJson<T>(path: string, init?: RequestInit) {
	const url = `${devToolsEndpoint()}${path}`;
	let response: Response;
	try {
		response = await fetch(url, {
			...init,
			signal: AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT_MS),
		});
	} catch (error) {
		throw new DevToolsEndpointError(endpointConnectionErrorMessage(error), { retryable: true });
	}

	if (!response.ok) {
		const body = (await response.text().catch(() => "")).trim();
		const suffix = body ? `: ${body.slice(0, 200)}` : "";
		throw new DevToolsEndpointError(
			[
				`Chrome DevTools endpoint ${url} returned ${response.status} ${response.statusText}${suffix}.`,
				endpointConfigHint(),
			].join("\n"),
			{ retryable: response.status === 429 || response.status >= 500 },
		);
	}

	return (await response.json()) as T;
}

async function withEndpointRetry<T>(operation: () => Promise<T>, waitMs: number) {
	const deadline = Date.now() + waitMs;
	while (true) {
		try {
			return await operation();
		} catch (error) {
			if (!isRetryableEndpointError(error)) throw error;

			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) throw error;

			await sleep(Math.min(DEFAULT_ENDPOINT_RETRY_MS, remainingMs));
		}
	}
}

function isRetryableEndpointError(error: unknown) {
	return error instanceof DevToolsEndpointError && error.retryable;
}

function endpointConnectionErrorMessage(error: unknown) {
	const reason = isTimeoutError(error) ? "request timed out" : "connection failed";
	return [
		`Cannot connect to Chrome DevTools endpoint at ${devToolsEndpoint()} (${reason}).`,
		launchHint(),
		endpointConfigHint(),
	].join("\n");
}

function isTimeoutError(error: unknown) {
	return error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
}

function devToolsEndpoint() {
	return `http://${state.host}:${state.port}`;
}

function launchHint() {
	return `Start Chrome with remote debugging enabled: ${chromeLaunchCommand()}`;
}

function chromeLaunchCommand() {
	const executable =
		process.platform === "darwin"
			? "/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome"
			: process.platform === "win32"
				? "chrome.exe"
				: "google-chrome";
	const dataDir = process.platform === "win32" ? "%TEMP%\\pi-chrome-devtools" : "/tmp/pi-chrome-devtools";
	return `${executable} --remote-debugging-port=${state.port} --user-data-dir=${dataDir}`;
}

function endpointConfigHint() {
	return "Set PI_CHROME_DEVTOOLS_HOST and PI_CHROME_DEVTOOLS_PORT if Chrome uses a different endpoint.";
}

function formatPageListItem(page: DevToolsPage) {
	return `- ${page.id}: ${page.title || "(untitled)"} ${page.url}`;
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class DevToolsEndpointError extends Error {
	readonly retryable: boolean;

	constructor(message: string, options: { retryable?: boolean } = {}) {
		super(message);
		this.name = "DevToolsEndpointError";
		this.retryable = options.retryable ?? false;
	}
}

function formatPage(page: DevToolsPage) {
	return {
		id: page.id,
		type: page.type,
		title: page.title,
		url: page.url,
	};
}

function textResult(text: string, details: unknown) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

async function withStatus<T>(ctx: StatusContext, status: string, callback: () => Promise<T>) {
	ctx.ui.setStatus(STATUS_KEY, status);
	try {
		return await callback();
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

async function withCdp<T>(page: DevToolsPage, callback: (client: CdpClient) => Promise<T>) {
	if (!page.webSocketDebuggerUrl) throw new Error(`Page has no webSocketDebuggerUrl: ${page.id}`);

	const client = await CdpClient.connect(page.webSocketDebuggerUrl);
	try {
		return await callback(client);
	} finally {
		client.close();
	}
}

class CdpClient {
	#nextId = 1;
	#pending = new Map<
		number,
		{
			resolve: (value: unknown) => void;
			reject: (reason: unknown) => void;
			timeout: NodeJS.Timeout;
		}
	>();
	private readonly socket: WebSocket;

	private constructor(socket: WebSocket) {
		this.socket = socket;
		socket.addEventListener("message", (event) => {
			const response = JSON.parse(String(event.data)) as CdpResponse;
			if (typeof response.id !== "number") return;

			const pending = this.#pending.get(response.id);
			if (!pending) return;

			clearTimeout(pending.timeout);
			this.#pending.delete(response.id);

			if (response.error) {
				pending.reject(new Error(`CDP error ${response.error.code}: ${response.error.message}`));
			} else {
				pending.resolve(response.result);
			}
		});

		socket.addEventListener("close", () => {
			this.rejectAll(new Error("Chrome DevTools WebSocket closed"));
		});

		socket.addEventListener("error", () => {
			this.rejectAll(new Error("Chrome DevTools WebSocket error"));
		});
	}

	static connect(url: string) {
		return new Promise<CdpClient>((resolve, reject) => {
			const socket = new WebSocket(url);
			const timeout = setTimeout(() => {
				socket.close();
				reject(new Error(`Timed out connecting to Chrome DevTools WebSocket: ${url}`));
			}, DEFAULT_TIMEOUT_MS);

			socket.addEventListener("open", () => {
				clearTimeout(timeout);
				resolve(new CdpClient(socket));
			});

			socket.addEventListener("error", () => {
				clearTimeout(timeout);
				reject(new Error(`Failed to connect to Chrome DevTools WebSocket: ${url}`));
			});
		});
	}

	send<T = unknown>(method: string, params?: Record<string, unknown>) {
		const id = this.#nextId;
		this.#nextId += 1;

		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`Timed out waiting for CDP response: ${method}`));
			}, DEFAULT_TIMEOUT_MS);

			this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
			this.socket.send(JSON.stringify({ id, method, params: params ?? {} }));
		});
	}

	close() {
		this.socket.close();
	}

	private rejectAll(error: Error) {
		for (const [id, pending] of this.#pending) {
			clearTimeout(pending.timeout);
			pending.reject(error);
			this.#pending.delete(id);
		}
	}
}
