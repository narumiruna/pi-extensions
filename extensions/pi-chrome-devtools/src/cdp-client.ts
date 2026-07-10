import {
	ensureDevToolsEndpoint,
	devToolsEndpoint,
	fetchDevToolsJson,
	formatPageListItem,
	launchHint,
	withEndpointRetry,
} from "./browser-manager.js";
import {
	DEFAULT_ENDPOINT_WAIT_MS,
	DEFAULT_TIMEOUT_MS,
	state,
	type DevToolsPage,
} from "./runtime.js";

interface CdpResponse<T = unknown> {
	id: number;
	result?: T;
	error?: { code: number; message: string; data?: unknown };
}

export async function listPages(options: { waitMs?: number } = {}) {
	const waitMs = options.waitMs ?? DEFAULT_ENDPOINT_WAIT_MS;
	await ensureDevToolsEndpoint(waitMs);
	return withEndpointRetry(async () => {
		const pages = await fetchDevToolsJson<DevToolsPage[]>("/json/list");
		return pages.filter((page) => page.type === "page" && page.webSocketDebuggerUrl);
	}, waitMs);
}

export async function getPage(pageId: string) {
	const pages = await listPages();
	return requirePage(pageId, pages);
}

export async function resolvePage(pageId?: string) {
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

export async function resolvePageForNavigation(pageId?: string) {
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

export async function createPage(url: string, options: { waitMs?: number } = {}) {
	const waitMs = options.waitMs ?? DEFAULT_ENDPOINT_WAIT_MS;
	await ensureDevToolsEndpoint(waitMs);
	const page = await withEndpointRetry(
		() =>
			fetchDevToolsJson<DevToolsPage>(`/json/new?${encodeURIComponent(url)}`, {
				method: "PUT",
			}),
		waitMs,
	);
	if (page.type !== "page" || !page.webSocketDebuggerUrl) {
		throw new Error("Chrome DevTools created a target that is not an inspectable page.");
	}

	return page;
}

export function formatPage(page: DevToolsPage) {
	return {
		id: page.id,
		type: page.type,
		title: page.title,
		url: page.url,
	};
}

export function textResult(text: string, details: unknown) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

export async function withCdp<T>(page: DevToolsPage, callback: (client: CdpClient) => Promise<T>) {
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
