import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { PreparedAttachment } from "../src/attachments.js";
import { ConversationProjection } from "../src/conversation.js";
import { type WebSendRequest, type WebSendResult, WebUIServer } from "../src/server.js";

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
		body?: BodyInit;
		origin?: string;
		contentType?: string;
	} = {},
) {
	const headers = new Headers();
	if (options.cookie) headers.set("cookie", options.cookie);
	if (options.client) headers.set("x-pi-web-client", options.client);
	if (options.method && options.method !== "GET") {
		headers.set("content-type", options.contentType ?? "application/json");
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
		for (const module of ["app.js", "state.js", "markdown.js", "transcript.js", "image-drag.js"]) {
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
					body: JSON.stringify({
						requestId: "r1",
						draftRevision: 0,
						delivery: "next",
					}),
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
		const draft = await setDraftText(server, cookie, firstClient, "hello");
		const sending = api(server, "/api/messages", {
			method: "POST",
			cookie,
			client: firstClient,
			body: JSON.stringify({
				requestId: "in-flight",
				draftRevision: draft.revision,
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
		const draft = await setDraftText(server, cookie, client, "hello");
		const request = rawMessageRequest(server, cookie, client, {
			requestId: "disconnect",
			draftRevision: draft.revision,
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

test("in-flight request ids remain deduplicated when the completed-result cache is full", async () => {
	const conversation = new ConversationProjection({ id: "s", cwd: "/w", projectName: "w" });
	const gate = deferred<WebSendResult>();
	let attempts = 0;
	const server = await WebUIServer.start({
		conversation,
		send: async () => {
			attempts += 1;
			return gate.promise;
		},
	});
	try {
		const cookie = await authenticate(server);
		const client = await takeLease(server, cookie);
		const draft = await setDraftText(server, cookie, client, "stress");
		const send = (requestId: string) =>
			api(server, "/api/messages", {
				method: "POST",
				cookie,
				client,
				body: JSON.stringify({
					requestId,
					draftRevision: draft.revision,
					delivery: "next",
				}),
			});
		const originals = Array.from({ length: 129 }, (_, index) => send(`pending-${index}`));
		await waitFor(() => attempts === 129);
		const replay = send("pending-0");
		await new Promise((resolve) => setTimeout(resolve, 20));
		const attemptsAfterReplay = attempts;
		gate.resolve({ delivery: "immediate" });
		const responses = await Promise.all([...originals, replay]);
		assert.equal(attemptsAfterReplay, 129);
		assert.equal(
			responses.every((response) => response.status === 202),
			true,
		);
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
		const draft = await setDraftText(server, cookie, client, "hello");
		const body = JSON.stringify({
			requestId: "retryable",
			draftRevision: draft.revision,
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

test("accepted sends clear only their snapshot while preserving text edited during the request", async () => {
	const conversation = new ConversationProjection({ id: "s", cwd: "/w", projectName: "w" });
	const started = deferred<void>();
	const gate = deferred<WebSendResult>();
	const server = await WebUIServer.start({
		conversation,
		send: async () => {
			started.resolve(undefined);
			return gate.promise;
		},
	});
	try {
		const cookie = await authenticate(server);
		const client = await takeLease(server, cookie);
		const original = await setDraftText(server, cookie, client, "old", 0, "old");
		const sending = api(server, "/api/messages", {
			method: "POST",
			cookie,
			client,
			body: JSON.stringify({
				requestId: "pending",
				draftRevision: original.revision,
				delivery: "next",
			}),
		});
		await started.promise;
		const newer = await setDraftText(server, cookie, client, "new", original.revision, "new");
		gate.resolve({ delivery: "immediate" });
		const accepted = await sending;
		assert.equal(accepted.status, 202);
		assert.deepEqual(((await accepted.json()) as { draft: unknown }).draft, newer);
		const recovered = (await (await api(server, "/api/state", { cookie })).json()) as {
			draft: { text: string };
		};
		assert.equal(recovered.draft.text, "new");
	} finally {
		gate.resolve({ delivery: "immediate" });
		await server.close();
	}
});

test("message requests validate, deduplicate, and reject request-id payload conflicts", async () => {
	const { sends, server } = await harness();
	try {
		const cookie = await authenticate(server);
		const client = await takeLease(server, cookie);
		const draft = await setDraftText(server, cookie, client, "hello");
		const body = JSON.stringify({
			requestId: "request-1",
			draftRevision: draft.revision,
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
			draft: {
				revision: 2,
				text: "",
				attachmentRevision: 0,
				attachmentIds: [],
			},
			attachments: {
				revision: 0,
				phase: "empty",
				items: [],
				totalSourceBytes: 0,
				totalResidentBytes: 0,
			},
			sentImages: {
				revision: 0,
				enabled: false,
				items: [],
				totalBytes: 0,
				maxImages: 32,
				maxBytes: 128 * 1024 * 1024,
			},
		});
		const conflict = await api(server, "/api/messages", {
			method: "POST",
			cookie,
			client,
			body: JSON.stringify({
				requestId: "request-1",
				draftRevision: draft.revision,
				delivery: "steer",
			}),
		});
		assert.equal(conflict.status, 409);
		assert.equal(
			(
				await api(server, "/api/messages", {
					method: "POST",
					cookie,
					client,
					body: JSON.stringify({
						requestId: "empty",
						draftRevision: 2,
						delivery: "next",
					}),
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
				draftRevision: 0,
				delivery: "next",
				padding: "x".repeat(300),
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

test("draft mutations enforce auth, lease, revisions, deduplication, and UTF-8 body bounds", async () => {
	const conversation = new ConversationProjection({ id: "s", cwd: "/w", projectName: "w" });
	const server = await WebUIServer.start({
		conversation,
		maxDraftTextBytes: 8,
		send: async () => ({ delivery: "immediate" }),
	});
	try {
		const cookie = await authenticate(server);
		let client = await takeLease(server, cookie, "first");
		assert.equal(
			(
				await api(server, "/api/draft", {
					method: "POST",
					client,
					body: JSON.stringify({ requestId: "missing-cookie", revision: 0, text: "x" }),
				})
			).status,
			401,
		);
		const first = await setDraftText(server, cookie, client, "hello", 0, "same");
		assert.equal(first.revision, 1);
		assert.deepEqual(await setDraftText(server, cookie, client, "hello", 0, "same"), first);
		assert.equal(
			(
				await api(server, "/api/draft", {
					method: "POST",
					cookie,
					client,
					body: JSON.stringify({ requestId: "same", revision: 1, text: "changed" }),
				})
			).status,
			409,
		);
		assert.equal(
			(
				await api(server, "/api/draft", {
					method: "POST",
					cookie,
					client,
					body: JSON.stringify({ requestId: "stale", revision: 0, text: "stale" }),
				})
			).status,
			409,
		);
		assert.equal(
			(
				await api(server, "/api/draft", {
					method: "POST",
					cookie,
					client,
					body: JSON.stringify({ requestId: "large", revision: 1, text: "界界界" }),
				})
			).status,
			413,
		);
		client = await takeLease(server, cookie, "second");
		const recovered = (await (await api(server, "/api/state", { cookie })).json()) as {
			draft: { text: string; revision: number };
		};
		assert.deepEqual(recovered.draft, {
			text: "hello",
			revision: 1,
			attachmentRevision: 0,
			attachmentIds: [],
		});
		assert.equal(
			(
				await api(server, "/api/draft", {
					method: "POST",
					cookie,
					client: "first",
					body: JSON.stringify({ requestId: "old-tab", revision: 1, text: "lost" }),
				})
			).status,
			409,
		);
	} finally {
		await server.close();
	}
});

test("attachment endpoints reserve, upload, preview, retry, reorder, delete, and clear by revision", async () => {
	const conversation = new ConversationProjection({ id: "s", cwd: "/w", projectName: "w" });
	let failOnce = true;
	const server = await WebUIServer.start({
		conversation,
		attachmentLimits: { maxImages: 3, maxImageBytes: 8, maxPromptBytes: 16 },
		processAttachment: async (source) => {
			if (Buffer.from(source).toString() === "bad" && failOnce) {
				failOnce = false;
				throw new Error("decoder failed");
			}
			return preparedAttachment(`safe-${Buffer.from(source).toString()}`);
		},
		send: async () => ({ delivery: "immediate" }),
	});
	try {
		const cookie = await authenticate(server);
		const client = await takeLease(server, cookie);
		assert.equal(
			(
				await api(server, "/api/attachments/reserve", {
					method: "POST",
					cookie,
					client: "stale-client",
					body: JSON.stringify({
						revision: 0,
						items: [{ id: "one", name: "one.png", size: 3 }],
					}),
				})
			).status,
			409,
		);
		let response = await api(server, "/api/attachments/reserve", {
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
		assert.equal(response.status, 201);
		let attachments = (await response.json()) as { revision: number };
		response = await api(server, `/api/attachments/one/upload?revision=${attachments.revision}`, {
			method: "POST",
			cookie,
			client,
			contentType: "application/octet-stream",
			body: Buffer.from("one"),
		});
		assert.equal(response.status, 200);
		await waitForAttachmentPhase(server, cookie, "uploading");
		attachments = await attachmentState(server, cookie);
		response = await api(server, `/api/attachments/two/upload?revision=${attachments.revision}`, {
			method: "POST",
			cookie,
			client,
			contentType: "application/octet-stream",
			body: Buffer.from("bad"),
		});
		assert.equal(response.status, 200);
		await waitForAttachmentPhase(server, cookie, "blocked");
		attachments = await attachmentState(server, cookie);
		response = await api(server, "/api/attachments/two/retry", {
			method: "POST",
			cookie,
			client,
			body: JSON.stringify({ revision: attachments.revision }),
		});
		assert.equal(response.status, 200);
		await waitForAttachmentPhase(server, cookie, "ready");
		const preview = await api(server, "/api/attachments/one/preview", { cookie });
		assert.equal(preview.status, 200);
		assert.equal(await preview.text(), "safe-one");
		attachments = await attachmentState(server, cookie);
		response = await api(server, "/api/attachments/reorder", {
			method: "POST",
			cookie,
			client,
			body: JSON.stringify({ revision: attachments.revision, ids: ["two", "one"] }),
		});
		assert.equal(response.status, 200);
		attachments = (await response.json()) as { revision: number };
		response = await api(server, `/api/attachments/one?revision=${attachments.revision}`, {
			method: "DELETE",
			cookie,
			client,
		});
		assert.equal(response.status, 200);
		attachments = (await response.json()) as { revision: number };
		response = await api(server, "/api/attachments/clear", {
			method: "POST",
			cookie,
			client,
			body: JSON.stringify({ revision: attachments.revision }),
		});
		assert.equal(response.status, 200);
		assert.equal(((await response.json()) as { phase: string }).phase, "empty");
	} finally {
		await server.close();
	}
});

test("raw attachment uploads enforce actual bytes, duplicate state, and declared limits", async () => {
	const conversation = new ConversationProjection({ id: "s", cwd: "/w", projectName: "w" });
	const gate = deferred<void>();
	const server = await WebUIServer.start({
		conversation,
		attachmentLimits: { maxImages: 2, maxImageBytes: 4, maxPromptBytes: 8 },
		processAttachment: async (source) => {
			await gate.promise;
			return preparedAttachment(Buffer.from(source).toString());
		},
		send: async () => ({ delivery: "immediate" }),
	});
	try {
		const cookie = await authenticate(server);
		const client = await takeLease(server, cookie);
		const response = await api(server, "/api/attachments/reserve", {
			method: "POST",
			cookie,
			client,
			body: JSON.stringify({
				revision: 0,
				items: [
					{ id: "one", name: "one.png", size: 4 },
					{ id: "two", name: "two.png", size: 4 },
				],
			}),
		});
		const revision = ((await response.json()) as { revision: number }).revision;
		let rawResponse = await rawUpload(
			server,
			cookie,
			client,
			"one",
			revision,
			Buffer.from("12345"),
			false,
		);
		assert.equal(rawResponse.statusCode, 413);
		const failedUpload = await attachmentState(server, cookie);
		assert.equal(failedUpload.phase, "blocked");
		assert.equal(failedUpload.items?.[0]?.status, "error");
		rawResponse = await rawUpload(
			server,
			cookie,
			client,
			"one",
			revision,
			Buffer.from("1234"),
			false,
		);
		assert.equal(rawResponse.statusCode, 200);
		const processingRevision = (await attachmentState(server, cookie)).revision;
		rawResponse = await rawUpload(
			server,
			cookie,
			client,
			"one",
			processingRevision,
			Buffer.from("1234"),
			true,
		);
		assert.equal(rawResponse.statusCode, 409);
		gate.resolve(undefined);
		await waitForAttachmentPhase(server, cookie, "uploading");
	} finally {
		gate.resolve(undefined);
		await server.close();
	}
});

test("lease takeover and deletion cancel processing without stale completion resurrection", async () => {
	const conversation = new ConversationProjection({ id: "s", cwd: "/w", projectName: "w" });
	const releases: Array<() => void> = [];
	const signals: AbortSignal[] = [];
	const server = await WebUIServer.start({
		conversation,
		attachmentLimits: { maxImages: 2, maxImageBytes: 8, maxPromptBytes: 16 },
		processAttachment: async (source, signal) => {
			signals.push(signal ?? new AbortController().signal);
			await new Promise<void>((resolve) => releases.push(resolve));
			return preparedAttachment(Buffer.from(source).toString());
		},
		send: async () => ({ delivery: "immediate" }),
	});
	try {
		const cookie = await authenticate(server);
		let client = await takeLease(server, cookie, "first");
		let response = await api(server, "/api/attachments/reserve", {
			method: "POST",
			cookie,
			client,
			body: JSON.stringify({
				revision: 0,
				items: [{ id: "one", name: "one.png", size: 3 }],
			}),
		});
		let revision = ((await response.json()) as { revision: number }).revision;
		await api(server, `/api/attachments/one/upload?revision=${revision}`, {
			method: "POST",
			cookie,
			client,
			contentType: "application/octet-stream",
			body: Buffer.from("one"),
		});
		await waitFor(() => signals.length === 1);
		client = await takeLease(server, cookie, "second");
		await waitFor(() => signals[0]?.aborted === true);
		assert.equal((await attachmentState(server, cookie)).phase, "blocked");
		releases.shift()?.();
		await waitForAttachmentPhase(server, cookie, "blocked");
		revision = (await attachmentState(server, cookie)).revision;
		response = await api(server, `/api/attachments/one?revision=${revision}`, {
			method: "DELETE",
			cookie,
			client,
		});
		assert.equal(response.status, 200);
		assert.equal(((await response.json()) as { phase: string }).phase, "empty");
	} finally {
		for (const release of releases) release();
		await server.close();
	}
});

test("accepted sanitized images can be previewed, reattached atomically, forgotten, and expired", async () => {
	const conversation = new ConversationProjection({ id: "s", cwd: "/w", projectName: "w" });
	let attempts = 0;
	let holdNextSend = false;
	const nextSend = deferred<WebSendResult>();
	const seenRetainedIds: string[][] = [];
	const server = await WebUIServer.start({
		conversation,
		sentImageSettings: { enabled: true, maxImages: 2, maxBytes: 16 },
		attachmentLimits: { maxImages: 3, maxImageBytes: 8, maxPromptBytes: 16 },
		processAttachment: async (source) => preparedAttachment(Buffer.from(source).toString()),
		send: async (request) => {
			attempts += 1;
			seenRetainedIds.push(request.retainedImageIds ?? []);
			if (attempts === 1) throw new Error("Pi rejected the send");
			if (holdNextSend) return nextSend.promise;
			return { delivery: "immediate" };
		},
	});
	try {
		const cookie = await authenticate(server);
		const client = await takeLease(server, cookie);
		let response = await api(server, "/api/attachments/reserve", {
			method: "POST",
			cookie,
			client,
			body: JSON.stringify({
				revision: 0,
				items: [{ id: "one", name: "one.png", size: 3 }],
			}),
		});
		const attachments = (await response.json()) as { revision: number };
		await api(server, `/api/attachments/one/upload?revision=${attachments.revision}`, {
			method: "POST",
			cookie,
			client,
			contentType: "application/octet-stream",
			body: Buffer.from("one"),
		});
		await waitForAttachmentPhase(server, cookie, "ready");
		const state = (await (await api(server, "/api/state", { cookie })).json()) as {
			draft: { revision: number };
		};
		const body = JSON.stringify({
			requestId: "retained-send",
			draftRevision: state.draft.revision,
			delivery: "next",
		});
		assert.equal(
			(await api(server, "/api/messages", { method: "POST", cookie, client, body })).status,
			500,
		);
		const afterFailure = (await (await api(server, "/api/state", { cookie })).json()) as {
			sentImages: { items: unknown[] };
			attachments: { phase: string };
		};
		assert.deepEqual(afterFailure.sentImages.items, []);
		assert.equal(afterFailure.attachments.phase, "ready");
		response = await api(server, "/api/messages", { method: "POST", cookie, client, body });
		assert.equal(response.status, 202);
		const accepted = (await response.json()) as {
			attachments: { revision: number };
			sentImages: { revision: number; items: Array<{ id: string }> };
		};
		assert.equal(seenRetainedIds[0]?.length, 1);
		assert.deepEqual(seenRetainedIds[1], seenRetainedIds[0]);
		const retainedId = accepted.sentImages.items[0]?.id;
		assert.ok(retainedId);
		assert.equal((await api(server, `/api/sent-images/${retainedId}/preview`)).status, 401);
		assert.equal(
			await (await api(server, `/api/sent-images/${retainedId}/preview`, { cookie })).text(),
			"one",
		);
		const activeClient = await takeLease(server, cookie, "client-two");
		assert.equal(
			(
				await api(server, "/api/sent-images/reattach", {
					method: "POST",
					cookie,
					client,
					body: JSON.stringify({
						revision: accepted.attachments.revision,
						items: [{ retainedId, id: "stale-tab" }],
					}),
				})
			).status,
			409,
		);
		response = await api(server, "/api/sent-images/reattach", {
			method: "POST",
			cookie,
			client: activeClient,
			body: JSON.stringify({
				revision: accepted.attachments.revision,
				items: [{ retainedId, id: "again" }],
			}),
		});
		assert.equal(response.status, 200);
		const reattached = (await response.json()) as {
			attachments: { revision: number; items: Array<{ id: string }> };
			draft: { revision: number };
		};
		assert.deepEqual(
			reattached.attachments.items.map((item) => item.id),
			["again"],
		);
		assert.equal(
			(
				await api(server, "/api/sent-images/reattach", {
					method: "POST",
					cookie,
					client: activeClient,
					body: JSON.stringify({
						revision: reattached.attachments.revision,
						items: [{ retainedId, id: "duplicate" }],
					}),
				})
			).status,
			409,
		);
		holdNextSend = true;
		const pendingSend = api(server, "/api/messages", {
			method: "POST",
			cookie,
			client: activeClient,
			body: JSON.stringify({
				requestId: "pending-retained-send",
				draftRevision: reattached.draft.revision,
				delivery: "next",
			}),
		});
		await waitFor(() => attempts === 3);
		response = await api(server, "/api/sent-images/reattach", {
			method: "POST",
			cookie,
			client: activeClient,
			body: JSON.stringify({
				revision: reattached.attachments.revision,
				items: [{ retainedId, id: "during-send" }],
			}),
		});
		assert.equal(response.status, 409);
		assert.match(await response.text(), /reserved for sending/i);
		nextSend.resolve({ delivery: "immediate" });
		assert.equal((await pendingSend).status, 202);
		response = await api(
			server,
			`/api/sent-images/${retainedId}?revision=${accepted.sentImages.revision}`,
			{ method: "DELETE", cookie, client: activeClient },
		);
		assert.equal(response.status, 200);
		assert.deepEqual(((await response.json()) as { items: unknown[] }).items, []);
		assert.equal(
			(await api(server, `/api/sent-images/${retainedId}/preview`, { cookie })).status,
			404,
		);
	} finally {
		await server.close();
	}
});

test("effective image limits drive public state, admission, upload, and batch memory", async () => {
	const conversation = new ConversationProjection({ id: "s", cwd: "/w", projectName: "w" });
	const limits = {
		maxImages: 1,
		maxImageBytes: 3,
		maxBatchBytes: 3,
		maxImagePixels: 10,
	};
	const server = await WebUIServer.start({
		conversation,
		imageLimits: limits,
		processAttachment: async (source) => preparedAttachment(Buffer.from(source).toString()),
		send: async () => ({ delivery: "immediate" }),
	});
	try {
		const cookie = await authenticate(server);
		const client = await takeLease(server, cookie);
		const state = (await (await api(server, "/api/state", { cookie })).json()) as {
			imageLimits: typeof limits;
		};
		assert.deepEqual(state.imageLimits, limits);
		assert.equal(
			(
				await api(server, "/api/attachments/reserve", {
					method: "POST",
					cookie,
					client,
					body: JSON.stringify({
						revision: 0,
						items: [
							{ id: "one", name: "one.png", size: 1 },
							{ id: "two", name: "two.png", size: 1 },
						],
					}),
				})
			).status,
			413,
		);
		assert.equal(
			(
				await api(server, "/api/attachments/reserve", {
					method: "POST",
					cookie,
					client,
					body: JSON.stringify({
						revision: 0,
						items: [{ id: "large", name: "large.png", size: 4 }],
					}),
				})
			).status,
			413,
		);
		let response = await api(server, "/api/attachments/reserve", {
			method: "POST",
			cookie,
			client,
			body: JSON.stringify({
				revision: 0,
				items: [{ id: "exact", name: "exact.png", size: 3 }],
			}),
		});
		const reserved = (await response.json()) as { revision: number };
		response = await api(server, `/api/attachments/exact/upload?revision=${reserved.revision}`, {
			method: "POST",
			cookie,
			client,
			contentType: "application/octet-stream",
			body: Buffer.from("four"),
		});
		assert.equal(response.status, 413);
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

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
	while (!(await predicate())) await new Promise((resolve) => setTimeout(resolve, 5));
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

async function setDraftText(
	server: WebUIServer,
	cookie: string,
	client: string,
	text: string,
	revision = 0,
	requestId = `draft-${revision}-${text.length}`,
): Promise<{ revision: number; text: string; attachmentIds: string[] }> {
	const response = await api(server, "/api/draft", {
		method: "POST",
		cookie,
		client,
		body: JSON.stringify({ requestId, revision, text }),
	});
	assert.equal(response.status, 200);
	return response.json() as Promise<{ revision: number; text: string; attachmentIds: string[] }>;
}

function preparedAttachment(marker: string): PreparedAttachment {
	return {
		bytes: Buffer.from(marker),
		mimeType: "image/png",
		width: 1,
		height: 1,
		originalWidth: 1,
		originalHeight: 1,
		sourceFormat: "png",
		outputFormat: "png",
		resized: false,
		notes: [],
	};
}

async function attachmentState(
	server: WebUIServer,
	cookie: string,
): Promise<{ revision: number; phase?: string; items?: Array<{ id: string; status: string }> }> {
	const state = (await (await api(server, "/api/state", { cookie })).json()) as {
		attachments: {
			revision: number;
			phase: string;
			items: Array<{ id: string; status: string }>;
		};
	};
	return state.attachments;
}

async function waitForAttachmentPhase(
	server: WebUIServer,
	cookie: string,
	phase: string,
): Promise<void> {
	await waitFor(async () => (await attachmentState(server, cookie)).phase === phase);
}

function rawUpload(
	server: WebUIServer,
	cookie: string,
	client: string,
	id: string,
	revision: number,
	body: Buffer,
	declareLength: boolean,
): Promise<http.IncomingMessage> {
	const url = new URL(server.origin);
	return new Promise((resolve, reject) => {
		const request = http.request(
			{
				hostname: url.hostname,
				port: Number(url.port),
				path: `/api/attachments/${id}/upload?revision=${revision}`,
				method: "POST",
				headers: {
					Cookie: cookie,
					Origin: server.origin,
					"Content-Type": "application/octet-stream",
					"X-Pi-Web-Client": client,
					...(declareLength ? { "Content-Length": String(body.byteLength) } : {}),
				},
			},
			(response) => {
				response.resume();
				response.once("end", () => resolve(response));
			},
		);
		request.once("error", reject);
		request.end(body);
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
