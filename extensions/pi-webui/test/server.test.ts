import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { ConversationProjection } from "../src/conversation.js";
import { type WebSendRequest, WebUIServer } from "../src/server.js";

async function harness() {
	const conversation = new ConversationProjection({
		id: "session",
		cwd: "/workspace/demo",
		projectName: "demo",
	});
	const sends: WebSendRequest[] = [];
	const server = await WebUIServer.start({
		conversation,
		send: async (request) => {
			sends.push(request);
			return { delivery: request.delivery === "steer" ? "steer" : "immediate" };
		},
	});
	return { conversation, sends, server };
}

async function authenticate(server: WebUIServer) {
	const response = await fetch(server.issueLink(), { redirect: "manual" });
	assert.equal(response.status, 303);
	const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
	assert.ok(cookie);
	return cookie;
}

async function api(
	server: WebUIServer,
	path: string,
	options: {
		method?: string;
		cookie?: string;
		client?: string;
		body?: string;
		origin?: string;
	} = {},
) {
	const headers = new Headers();
	if (options.cookie) headers.set("cookie", options.cookie);
	if (options.client) headers.set("x-pi-web-client", options.client);
	if (options.method && options.method !== "GET") {
		headers.set("content-type", "application/json");
		headers.set("origin", options.origin ?? server.origin);
	}
	return fetch(`${server.origin}${path}`, {
		method: options.method,
		headers,
		body: options.body,
	});
}

async function takeLease(server: WebUIServer, cookie: string, client = "client-one") {
	const response = await api(server, "/api/lease", {
		method: "POST",
		cookie,
		client,
		body: JSON.stringify({ clientId: client }),
	});
	assert.equal(response.status, 200);
	return client;
}

test("bootstrap links rotate and exchange once for isolated secure cookies", async () => {
	const first = await harness();
	const second = await harness();
	try {
		const stale = first.server.issueLink();
		const current = first.server.issueLink();
		assert.equal((await fetch(stale, { redirect: "manual" })).status, 401);
		const response = await fetch(current, { redirect: "manual" });
		assert.equal(response.status, 303);
		assert.equal(response.headers.get("location"), "/");
		assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly/i);
		assert.match(response.headers.get("set-cookie") ?? "", /SameSite=Strict/i);
		assert.equal((await fetch(current, { redirect: "manual" })).status, 401);
		const firstCookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
		const secondCookie = await authenticate(second.server);
		assert.notEqual(first.server.origin, second.server.origin);
		assert.notEqual(firstCookie.split("=")[0], secondCookie.split("=")[0]);
		assert.equal((await api(first.server, "/api/state", { cookie: secondCookie })).status, 401);
	} finally {
		await Promise.all([first.server.close(), second.server.close()]);
	}
});

test("assets and APIs require auth and carry restrictive headers", async () => {
	const { server } = await harness();
	try {
		assert.equal((await api(server, "/")).status, 401);
		const cookie = await authenticate(server);
		const page = await api(server, "/", { cookie });
		assert.equal(page.status, 200);
		assert.equal(page.headers.get("cache-control"), "no-store");
		assert.equal(page.headers.get("x-content-type-options"), "nosniff");
		assert.equal(page.headers.get("referrer-policy"), "no-referrer");
		assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
		assert.equal(page.headers.get("access-control-allow-origin"), null);
		assert.match(await page.text(), /id="composer"/);
		for (const module of ["app.js", "state.js", "markdown.js", "transcript.js"]) {
			const asset = await api(server, `/${module}`, { cookie });
			assert.equal(asset.status, 200, module);
			assert.match(asset.headers.get("content-type") ?? "", /javascript/, module);
		}
		const state = await (await api(server, "/api/state", { cookie })).json();
		assert.equal(state.session.projectName, "demo");
	} finally {
		await server.close();
	}
});

test("mutations require exact Origin, Host, cookie, and current tab lease", async () => {
	const { server } = await harness();
	try {
		const cookie = await authenticate(server);
		assert.equal(
			(
				await api(server, "/api/lease", {
					method: "POST",
					cookie,
					client: "one",
					origin: "http://attacker.invalid",
					body: JSON.stringify({ clientId: "one" }),
				})
			).status,
			403,
		);
		await takeLease(server, cookie, "one");
		await takeLease(server, cookie, "two");
		const state = await (await api(server, "/api/state", { cookie })).json();
		assert.deepEqual(state.lease, { activeClientId: "two", generation: 2 });
		assert.equal(
			(
				await api(server, "/api/messages", {
					method: "POST",
					cookie,
					client: "one",
					body: JSON.stringify({ requestId: "r1", text: "hello", images: [], delivery: "next" }),
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

test("a new tab lease aborts an in-flight asynchronous send before mutation", async () => {
	const conversation = new ConversationProjection({ id: "s", cwd: "/w", projectName: "w" });
	let mutated = false;
	const server = await WebUIServer.start({
		conversation,
		send: async (request) => {
			await new Promise<void>((resolve, reject) => {
				request.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
					once: true,
				});
				setTimeout(resolve, 1_000);
			});
			mutated = true;
			return { delivery: "immediate" };
		},
	});
	try {
		const cookie = await authenticate(server);
		const firstClient = await takeLease(server, cookie, "first");
		const sending = api(server, "/api/messages", {
			method: "POST",
			cookie,
			client: firstClient,
			body: JSON.stringify({
				requestId: "in-flight",
				text: "hello",
				images: [{ data: "raw" }],
				delivery: "next",
			}),
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		await takeLease(server, cookie, "second");
		assert.equal((await sending).status, 409);
		assert.equal(mutated, false);
	} finally {
		await server.close();
	}
});

test("a completed upload aborts when its response connection closes", async () => {
	const conversation = new ConversationProjection({ id: "s", cwd: "/w", projectName: "w" });
	const started = deferred<void>();
	let aborted = false;
	const server = await WebUIServer.start({
		conversation,
		send: async (request) => {
			started.resolve(undefined);
			await new Promise<void>((resolve) => {
				request.signal?.addEventListener(
					"abort",
					() => {
						aborted = true;
						resolve();
					},
					{ once: true },
				);
			});
			throw new Error("cancelled");
		},
	});
	try {
		const cookie = await authenticate(server);
		const client = await takeLease(server, cookie);
		const request = rawMessageRequest(server, cookie, client, {
			requestId: "disconnect",
			text: "hello",
			images: [],
			delivery: "next",
		});
		await started.promise;
		request.destroy();
		await Promise.race([
			waitFor(() => aborted),
			new Promise((_, reject) => setTimeout(() => reject(new Error("send was not aborted")), 500)),
		]);
		assert.equal(aborted, true);
	} finally {
		await server.close();
	}
});

test("failed sends release their request id for an unchanged browser retry", async () => {
	const conversation = new ConversationProjection({ id: "s", cwd: "/w", projectName: "w" });
	let attempts = 0;
	const server = await WebUIServer.start({
		conversation,
		send: async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("temporary validation failure");
			return { delivery: "immediate" };
		},
	});
	try {
		const cookie = await authenticate(server);
		const client = await takeLease(server, cookie);
		const body = JSON.stringify({
			requestId: "retryable",
			text: "hello",
			images: [],
			delivery: "next",
		});
		assert.equal(
			(await api(server, "/api/messages", { method: "POST", cookie, client, body })).status,
			500,
		);
		assert.equal(
			(await api(server, "/api/messages", { method: "POST", cookie, client, body })).status,
			202,
		);
		assert.equal(attempts, 2);
	} finally {
		await server.close();
	}
});

test("message requests validate, deduplicate, and reject request-id payload conflicts", async () => {
	const { sends, server } = await harness();
	try {
		const cookie = await authenticate(server);
		const client = await takeLease(server, cookie);
		const body = JSON.stringify({
			requestId: "request-1",
			text: "hello",
			images: [],
			delivery: "next",
		});
		const first = await api(server, "/api/messages", { method: "POST", cookie, client, body });
		const replay = await api(server, "/api/messages", { method: "POST", cookie, client, body });
		assert.equal(first.status, 202);
		assert.equal(replay.status, 202);
		assert.equal(sends.length, 1);
		assert.deepEqual(await replay.json(), {
			accepted: true,
			requestId: "request-1",
			delivery: "immediate",
		});
		const conflict = await api(server, "/api/messages", {
			method: "POST",
			cookie,
			client,
			body: JSON.stringify({
				requestId: "request-1",
				text: "changed",
				images: [],
				delivery: "next",
			}),
		});
		assert.equal(conflict.status, 409);
		assert.equal(
			(
				await api(server, "/api/messages", {
					method: "POST",
					cookie,
					client,
					body: JSON.stringify({ requestId: "empty", text: "  ", images: [], delivery: "next" }),
				})
			).status,
			400,
		);
	} finally {
		await server.close();
	}
});

test("oversized and cancelled request bodies do not mutate or stop the server", async () => {
	const conversation = new ConversationProjection({ id: "s", cwd: "/w", projectName: "w" });
	let sends = 0;
	const server = await WebUIServer.start({
		conversation,
		maxRequestBytes: 256,
		send: async () => {
			sends += 1;
			return { delivery: "immediate" };
		},
	});
	try {
		const cookie = await authenticate(server);
		const client = await takeLease(server, cookie);
		const oversized = await api(server, "/api/messages", {
			method: "POST",
			cookie,
			client,
			body: JSON.stringify({
				requestId: "large",
				text: "x".repeat(300),
				images: [],
				delivery: "next",
			}),
		});
		assert.equal(oversized.status, 413);
		await cancelRequest(server, cookie, client);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(sends, 0);
		assert.equal((await api(server, "/api/state", { cookie })).status, 200);
	} finally {
		await server.close();
	}
});

test("empty SSE streams flush immediately and remain available for later events", async () => {
	const { conversation, server } = await harness();
	try {
		const cookie = await authenticate(server);
		const controller = new AbortController();
		const response = await fetch(`${server.origin}/api/events?since=0`, {
			headers: { cookie },
			signal: controller.signal,
		});
		assert.equal(response.status, 200);
		const reader = response.body?.getReader();
		assert.ok(reader);
		const connected = new TextDecoder().decode((await reader.read()).value);
		assert.match(connected, /: connected/);
		conversation.setActivity("running");
		const update = new TextDecoder().decode((await reader.read()).value);
		assert.match(update, /"type":"activity"/);
		controller.abort();
		await reader.cancel().catch(() => undefined);
	} finally {
		await server.close();
	}
});

test("new SSE streams receive the current lease before relying on broadcasts", async () => {
	const { conversation, server } = await harness();
	try {
		const cookie = await authenticate(server);
		await takeLease(server, cookie, "first");
		await takeLease(server, cookie, "second");
		const controller = new AbortController();
		const response = await fetch(`${server.origin}/api/events?since=0`, {
			headers: { cookie },
			signal: controller.signal,
		});
		const reader = response.body?.getReader();
		assert.ok(reader);
		let text = new TextDecoder().decode((await reader.read()).value);
		if (!text.includes("event: lease")) {
			conversation.setActivity("running");
			text += new TextDecoder().decode((await reader.read()).value);
		}
		assert.match(text, /event: lease/);
		assert.match(text, /"activeClientId":"second"/);
		assert.match(text, /"generation":2/);
		controller.abort();
		await reader.cancel().catch(() => undefined);
	} finally {
		await server.close();
	}
});

test("SSE replays retained events and sends a snapshot after a sequence gap", async () => {
	const { conversation, server } = await harness();
	try {
		const cookie = await authenticate(server);
		conversation.recordMessage({ role: "user", content: "one", timestamp: 1 });
		const controller = new AbortController();
		const response = await fetch(`${server.origin}/api/events?since=0`, {
			headers: { cookie },
			signal: controller.signal,
		});
		assert.equal(response.status, 200);
		const reader = response.body?.getReader();
		assert.ok(reader);
		const chunk = await reader.read();
		const text = new TextDecoder().decode(chunk.value);
		assert.match(text, /"type":"message"/);
		controller.abort();
		await reader.cancel().catch(() => undefined);
	} finally {
		await server.close();
	}
});

test("SSE sequence gaps receive an authoritative snapshot", async () => {
	const conversation = new ConversationProjection(
		{ id: "session", cwd: "/workspace", projectName: "workspace" },
		[],
		1,
	);
	conversation.setActivity("running");
	conversation.setActivity("idle");
	const server = await WebUIServer.start({
		conversation,
		send: async () => ({ delivery: "immediate" }),
	});
	try {
		const cookie = await authenticate(server);
		const controller = new AbortController();
		const response = await fetch(`${server.origin}/api/events?since=0`, {
			headers: { cookie },
			signal: controller.signal,
		});
		const reader = response.body?.getReader();
		assert.ok(reader);
		const chunk = await reader.read();
		const text = new TextDecoder().decode(chunk.value);
		assert.match(text, /event: snapshot/);
		assert.match(text, /"sequence":2/);
		controller.abort();
		await reader.cancel().catch(() => undefined);
	} finally {
		await server.close();
	}
});

test("close waits for terminal SSE data to flush before destroying connections", async () => {
	const { server } = await harness();
	let finish: (() => void) | undefined;
	let settled = false;
	const response = {
		destroyed: false,
		writableEnded: false,
		write: () => true,
		end: (callback?: () => void) => {
			finish = callback;
			return response;
		},
	};
	const clients = (server as unknown as { sseClients: Set<{ response: typeof response }> })
		.sseClients;
	clients.add({ response });
	const closing = server.close().then(() => {
		settled = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(settled, false);
	assert.ok(finish);
	finish();
	await closing;
});

test("close ends connections and is idempotent", async () => {
	const { conversation, server } = await harness();
	conversation.close();
	await server.close();
	await server.close();
	await assert.rejects(() => fetch(`${server.origin}/api/state`));
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 5));
}

function rawMessageRequest(
	server: WebUIServer,
	cookie: string,
	client: string,
	body: object,
): http.ClientRequest {
	const url = new URL(server.origin);
	const encoded = JSON.stringify(body);
	const request = http.request({
		hostname: url.hostname,
		port: Number(url.port),
		path: "/api/messages",
		method: "POST",
		headers: {
			Cookie: cookie,
			Origin: server.origin,
			"Content-Type": "application/json",
			"Content-Length": Buffer.byteLength(encoded),
			"X-Pi-Web-Client": client,
		},
	});
	request.once("error", () => undefined);
	request.end(encoded);
	return request;
}

function cancelRequest(server: WebUIServer, cookie: string, client: string): Promise<void> {
	const url = new URL(server.origin);
	return new Promise((resolve) => {
		const request = http.request({
			hostname: url.hostname,
			port: Number(url.port),
			path: "/api/messages",
			method: "POST",
			headers: {
				Cookie: cookie,
				Origin: server.origin,
				"Content-Type": "application/json",
				"X-Pi-Web-Client": client,
			},
		});
		request.once("error", () => resolve());
		request.write('{"requestId":"cancelled"');
		request.destroy();
		setTimeout(resolve, 20);
	});
}

function rawRequest(server: WebUIServer, path: string, headers: Record<string, string>) {
	const url = new URL(server.origin);
	return new Promise<http.IncomingMessage>((resolve, reject) => {
		const request = http.request(
			{ hostname: url.hostname, port: Number(url.port), path, headers },
			(response) => {
				response.resume();
				response.once("end", () => resolve(response));
			},
		);
		request.once("error", reject);
		request.end();
	});
}
