import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { BatchStore, type ProcessedImage } from "../src/batch.js";
import { ImageDropServer } from "../src/server.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

const SETTINGS = {
	...DEFAULT_SETTINGS,
	maxImages: 3,
	maxImageBytes: 16,
	maxBatchBytes: 32,
	maxImagePixels: 1_000,
};

function result(source: Uint8Array): ProcessedImage {
	const bytes = Buffer.from(source);
	return {
		bytes,
		mimeType: "image/png",
		width: 1,
		height: 1,
		originalWidth: 1,
		originalHeight: 1,
		sourceFormat: "png",
		outputFormat: "png",
		resized: false,
		hash: bytes.toString("hex"),
		notes: [],
	};
}

async function harness() {
	const batch = new BatchStore(SETTINGS);
	const server = await ImageDropServer.start({
		batch,
		settings: SETTINGS,
		projectName: "demo",
		sessionName: "session",
		cwd: "/workspace/demo",
		process: async (source) => result(source),
		getAutoResize: async () => true,
	});
	return { batch, server };
}

async function authenticate(server: ImageDropServer) {
	const link = server.issueLink();
	const response = await fetch(link, { redirect: "manual" });
	assert.equal(response.status, 303);
	assert.equal(response.headers.get("location"), "/");
	const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
	assert.ok(cookie);
	return cookie;
}

async function lease(server: ImageDropServer, cookie: string, client = "client-one") {
	const response = await api(server, "/api/lease", {
		method: "POST",
		cookie,
		client,
		body: JSON.stringify({ clientId: client }),
	});
	assert.equal(response.status, 200);
	return client;
}

function api(
	server: ImageDropServer,
	path: string,
	options: {
		method?: string;
		cookie?: string;
		client?: string;
		body?: BodyInit;
		headers?: Record<string, string>;
	} = {},
) {
	const headers = new Headers(options.headers);
	if (options.cookie) headers.set("cookie", options.cookie);
	if (options.client) headers.set("x-image-drop-client", options.client);
	if (options.method && options.method !== "GET" && !headers.has("origin")) {
		headers.set("origin", server.origin);
	}
	const init: RequestInit & { duplex?: "half" } = {
		method: options.method,
		headers,
		body: options.body,
	};
	if (options.body instanceof ReadableStream) init.duplex = "half";
	return fetch(`${server.origin}${path}`, init);
}

test("bootstrap tokens rotate, replay fails, and clean pages require the session cookie", async () => {
	const { server } = await harness();
	try {
		const oldLink = server.issueLink();
		const currentLink = server.issueLink();
		assert.equal((await fetch(oldLink, { redirect: "manual" })).status, 401);
		const response = await fetch(currentLink, { redirect: "manual" });
		assert.equal(response.status, 303);
		assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly/i);
		assert.match(response.headers.get("set-cookie") ?? "", /SameSite=Strict/i);
		assert.equal((await fetch(currentLink, { redirect: "manual" })).status, 401);
		assert.equal((await fetch(`${server.origin}/`, { redirect: "manual" })).status, 401);
		const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
		const page = await api(server, "/", { cookie });
		assert.equal(page.status, 200);
		assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
		assert.equal(page.headers.get("cache-control"), "no-store");
		assert.equal(page.headers.get("x-content-type-options"), "nosniff");
		assert.equal(page.headers.get("access-control-allow-origin"), null);
	} finally {
		await server.close();
	}
});

test("simultaneous Pi servers keep random ports and credentials isolated", async () => {
	const first = await harness();
	const second = await harness();
	try {
		assert.notEqual(first.server.origin, second.server.origin);
		const firstCookie = await authenticate(first.server);
		const secondCookie = await authenticate(second.server);
		assert.notEqual(firstCookie.split("=", 1)[0], secondCookie.split("=", 1)[0]);
		assert.equal((await api(first.server, "/api/state", { cookie: secondCookie })).status, 401);
		assert.equal((await api(second.server, "/api/state", { cookie: firstCookie })).status, 401);
		const sharedBrowserJar = `${firstCookie}; ${secondCookie}`;
		assert.equal((await api(first.server, "/api/state", { cookie: sharedBrowserJar })).status, 200);
		assert.equal(
			(await api(second.server, "/api/state", { cookie: sharedBrowserJar })).status,
			200,
		);
	} finally {
		await Promise.all([first.server.close(), second.server.close()]);
	}
});

test("mutations require exact Host, Origin, cookie, and active client lease", async () => {
	const { server } = await harness();
	try {
		const cookie = await authenticate(server);
		assert.equal((await api(server, "/api/state")).status, 401);
		assert.equal(
			(
				await api(server, "/api/lease", {
					method: "POST",
					cookie,
					client: "client-one",
					body: JSON.stringify({ clientId: "client-one" }),
					headers: { origin: "http://attacker.invalid" },
				})
			).status,
			403,
		);
		await lease(server, cookie);
		assert.equal(
			(
				await api(server, "/api/items", {
					method: "POST",
					cookie,
					client: "other-client",
					body: JSON.stringify({ revision: 0, items: [] }),
				})
			).status,
			409,
		);
		const badHost = await rawRequest(server, "/api/state", {
			Host: "attacker.invalid",
			Cookie: cookie,
		});
		assert.equal(badHost.statusCode, 421);
	} finally {
		await server.close();
	}
});

test("reserve, upload, state, reorder, delete, retry errors, and clear use revisions", async () => {
	const { batch, server } = await harness();
	try {
		const cookie = await authenticate(server);
		const client = await lease(server, cookie);
		const reserve = await api(server, "/api/items", {
			method: "POST",
			cookie,
			client,
			body: JSON.stringify({
				revision: 0,
				items: [
					{ id: "one", name: "one.png", size: 3 },
					{ id: "two", name: "two.png", size: 3 },
				],
			}),
		});
		assert.equal(reserve.status, 200);
		assert.equal(
			(
				await api(server, "/api/items/one/content", {
					method: "PUT",
					cookie,
					client,
					body: Buffer.from("one"),
				})
			).status,
			200,
		);
		assert.equal(
			(
				await api(server, "/api/items/two/content", {
					method: "PUT",
					cookie,
					client,
					body: Buffer.from("two"),
				})
			).status,
			200,
		);
		const stateResponse = await api(server, "/api/state", { cookie });
		const state = (await stateResponse.json()) as {
			batch: { revision: number; phase: string; items: Array<{ id: string }> };
			projectName: string;
			cwd: string;
		};
		assert.equal(state.projectName, "demo");
		assert.equal(state.cwd, "/workspace/demo");
		assert.equal(state.batch.phase, "ready");
		assert.deepEqual(
			state.batch.items.map((item) => item.id),
			["one", "two"],
		);
		assert.equal(
			(
				await api(server, "/api/order", {
					method: "PUT",
					cookie,
					client,
					body: JSON.stringify({ revision: 0, ids: ["two", "one"] }),
				})
			).status,
			409,
		);
		assert.equal(
			(
				await api(server, "/api/order", {
					method: "PUT",
					cookie,
					client,
					body: JSON.stringify({ revision: state.batch.revision, ids: ["two", "one"] }),
				})
			).status,
			200,
		);
		const revision = batch.publicState().revision;
		assert.equal(
			(
				await api(server, `/api/items/one?revision=${revision}`, {
					method: "DELETE",
					cookie,
					client,
				})
			).status,
			200,
		);
		assert.equal(
			(
				await api(server, "/api/clear", {
					method: "POST",
					cookie,
					client,
					body: JSON.stringify({ revision: batch.publicState().revision }),
				})
			).status,
			200,
		);
		assert.equal(batch.publicState().phase, "empty");
	} finally {
		await server.close();
	}
});

test("raw uploads enforce the configured limit even without Content-Length", async () => {
	const { batch, server } = await harness();
	try {
		const cookie = await authenticate(server);
		const client = await lease(server, cookie);
		await api(server, "/api/items", {
			method: "POST",
			cookie,
			client,
			body: JSON.stringify({ revision: 0, items: [{ id: "big", name: "big.png", size: 16 }] }),
		});
		const response = await api(server, "/api/items/big/content", {
			method: "PUT",
			cookie,
			client,
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array(17));
					controller.close();
				},
			}),
		});
		assert.equal(response.status, 413);
		assert.equal(batch.publicState().items[0]?.status, "error");
		assert.match(batch.publicState().items[0]?.error ?? "", /too large/i);
	} finally {
		await server.close();
	}
});

test("an interrupted browser upload becomes a visible deletable error after refresh", async () => {
	const { batch, server } = await harness();
	try {
		const cookie = await authenticate(server);
		const client = await lease(server, cookie, "before-refresh");
		await api(server, "/api/items", {
			method: "POST",
			cookie,
			client,
			body: JSON.stringify({ revision: 0, items: [{ id: "one", name: "one.png", size: 3 }] }),
		});
		await abortRawUpload(server, "/api/items/one/content", {
			Cookie: cookie,
			Origin: server.origin,
			"X-Image-Drop-Client": client,
			"Content-Length": "3",
		});
		for (
			let attempt = 0;
			attempt < 20 && batch.publicState().items[0]?.status !== "error";
			attempt += 1
		) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.equal(batch.publicState().items[0]?.status, "error");
		assert.match(batch.publicState().items[0]?.error ?? "", /aborted/i);
		const refreshed = await lease(server, cookie, "after-refresh");
		const deletion = await api(server, `/api/items/one?revision=${batch.publicState().revision}`, {
			method: "DELETE",
			cookie,
			client: refreshed,
		});
		assert.equal(deletion.status, 200);
		assert.equal(batch.publicState().phase, "empty");
	} finally {
		await server.close();
	}
});

test("deleting an item during processing discards late native output", async () => {
	const batch = new BatchStore(SETTINGS);
	let release!: () => void;
	let processing!: () => void;
	const started = new Promise<void>((resolve) => {
		processing = resolve;
	});
	const server = await ImageDropServer.start({
		batch,
		settings: SETTINGS,
		projectName: "demo",
		cwd: "/workspace/demo",
		process: async (source) => {
			processing();
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return result(source);
		},
		getAutoResize: async () => true,
	});
	try {
		const cookie = await authenticate(server);
		const client = await lease(server, cookie);
		await api(server, "/api/items", {
			method: "POST",
			cookie,
			client,
			body: JSON.stringify({ revision: 0, items: [{ id: "one", name: "one.png", size: 3 }] }),
		});
		const upload = api(server, "/api/items/one/content", {
			method: "PUT",
			cookie,
			client,
			body: Buffer.from("one"),
		});
		await started;
		const deletion = await api(server, `/api/items/one?revision=${batch.publicState().revision}`, {
			method: "DELETE",
			cookie,
			client,
		});
		assert.equal(deletion.status, 200);
		release();
		assert.equal((await upload).status, 200);
		assert.equal(batch.publicState().phase, "empty");
	} finally {
		await server.close();
	}
});

test("processing failures stay retryable and duplicate processed images collapse", async () => {
	const batch = new BatchStore(SETTINGS);
	let attempts = 0;
	const server = await ImageDropServer.start({
		batch,
		settings: SETTINGS,
		projectName: "demo",
		cwd: "/workspace/demo",
		process: async (source) => {
			attempts += 1;
			if (attempts === 1) throw new Error("decoder failed\nprivately");
			return result(source);
		},
		getAutoResize: async () => true,
	});
	try {
		const cookie = await authenticate(server);
		const client = await lease(server, cookie);
		await api(server, "/api/items", {
			method: "POST",
			cookie,
			client,
			body: JSON.stringify({ revision: 0, items: [{ id: "one", name: "one.png", size: 3 }] }),
		});
		const failed = await api(server, "/api/items/one/content", {
			method: "PUT",
			cookie,
			client,
			body: Buffer.from("one"),
		});
		assert.equal(failed.status, 422);
		assert.equal(batch.publicState().items[0]?.status, "error");
		assert.equal(batch.publicState().items[0]?.error, "decoder failed privately");
		assert.equal(
			(
				await api(server, "/api/items/one/retry", {
					method: "POST",
					cookie,
					client,
				})
			).status,
			200,
		);
		assert.equal(batch.publicState().phase, "ready");

		const revision = batch.publicState().revision;
		await api(server, "/api/items", {
			method: "POST",
			cookie,
			client,
			body: JSON.stringify({ revision, items: [{ id: "duplicate", name: "copy.png", size: 3 }] }),
		});
		assert.equal(
			(
				await api(server, "/api/items/duplicate/content", {
					method: "PUT",
					cookie,
					client,
					body: Buffer.from("one"),
				})
			).status,
			200,
		);
		assert.deepEqual(
			batch.publicState().items.map((item) => item.id),
			["one"],
		);
	} finally {
		await server.close();
	}
});

test("SSE reports state and invalidates the previous editing lease", async () => {
	const { server } = await harness();
	const controller = new AbortController();
	try {
		const cookie = await authenticate(server);
		await lease(server, cookie, "old-client");
		const events = await fetch(`${server.origin}/api/events?client=old-client`, {
			headers: { cookie },
			signal: controller.signal,
		});
		assert.equal(events.status, 200);
		assert.match(events.headers.get("content-type") ?? "", /text\/event-stream/);
		const reader = events.body?.getReader();
		assert.ok(reader);
		const first = await reader.read();
		assert.match(Buffer.from(first.value ?? []).toString(), /event: state/);
		await lease(server, cookie, "new-client");
		let tail = "";
		while (!tail.includes("event: stale")) {
			const next = await reader.read();
			if (next.done) break;
			tail += Buffer.from(next.value).toString();
		}
		assert.match(tail, /event: stale/);
	} finally {
		controller.abort();
		await server.close();
	}
});

test("SSE delivers a terminal session event before shutdown closes sockets", async () => {
	const { server } = await harness();
	try {
		const cookie = await authenticate(server);
		await lease(server, cookie, "client");
		const events = await fetch(`${server.origin}/api/events?client=client`, {
			headers: { cookie },
		});
		const reader = events.body?.getReader();
		assert.ok(reader);
		await reader.read();
		const closing = server.close();
		let tail = "";
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			tail += Buffer.from(chunk.value).toString();
		}
		await closing;
		assert.match(tail, /event: session-ended/);
		assert.match(tail, /Pi session ended/);
	} finally {
		await server.close();
	}
});

test("a new page takes the editing lease and stale clients cannot mutate", async () => {
	const { server } = await harness();
	try {
		const cookie = await authenticate(server);
		await lease(server, cookie, "old-client");
		await lease(server, cookie, "new-client");
		assert.equal(
			(
				await api(server, "/api/clear", {
					method: "POST",
					cookie,
					client: "old-client",
					body: JSON.stringify({ revision: 0 }),
				})
			).status,
			409,
		);
		assert.equal(
			(
				await api(server, "/api/clear", {
					method: "POST",
					cookie,
					client: "new-client",
					body: JSON.stringify({ revision: 0 }),
				})
			).status,
			200,
		);
	} finally {
		await server.close();
	}
});

test("shutdown aborts in-flight processing and is idempotent", async () => {
	const batch = new BatchStore(SETTINGS);
	let observedSignal: AbortSignal | undefined;
	let started!: () => void;
	const processingStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const server = await ImageDropServer.start({
		batch,
		settings: SETTINGS,
		projectName: "demo",
		cwd: "/workspace/demo",
		process: async (_source, options) => {
			observedSignal = options.signal;
			started();
			await new Promise<void>((_resolve, reject) => {
				options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
					once: true,
				});
			});
			return result(Buffer.from("one"));
		},
		getAutoResize: async () => true,
	});
	const cookie = await authenticate(server);
	const client = await lease(server, cookie);
	await api(server, "/api/items", {
		method: "POST",
		cookie,
		client,
		body: JSON.stringify({ revision: 0, items: [{ id: "one", name: "one.png", size: 3 }] }),
	});
	const upload = api(server, "/api/items/one/content", {
		method: "PUT",
		cookie,
		client,
		body: Buffer.from("one"),
	}).catch(() => undefined);
	await processingStarted;
	await Promise.all([server.close(), server.close()]);
	await upload;
	assert.equal(observedSignal?.aborted, true);
	assert.throws(() => server.issueLink(), /closed/i);
});

function abortRawUpload(
	server: ImageDropServer,
	path: string,
	headers: Record<string, string>,
): Promise<void> {
	return new Promise((resolve) => {
		const url = new URL(server.origin);
		const request = http.request({
			hostname: url.hostname,
			port: url.port,
			path,
			method: "PUT",
			headers,
		});
		request.once("error", () => resolve());
		request.write("o");
		setTimeout(() => request.destroy(), 5);
	});
}

function rawRequest(
	server: ImageDropServer,
	path: string,
	headers: Record<string, string>,
): Promise<{ statusCode?: number; body: string }> {
	return new Promise((resolve, reject) => {
		const url = new URL(server.origin);
		const request = http.request(
			{ hostname: url.hostname, port: url.port, path, headers },
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
				response.on("end", () =>
					resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString() }),
				);
			},
		);
		request.on("error", reject);
		request.end();
	});
}
