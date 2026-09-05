import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { test } from "vitest";
import { S3SyncBackend, snapshotKey } from "../src/s3-backend.js";
import {
	expectedRemoteHead,
	SyncBackendConflictError,
	SyncBackendPublicationOutcomeUnknownError,
} from "../src/sync-backend.js";
import type { LatestPointer, Snapshot, SyncConfig } from "../src/types.js";
import { createSyncBackend } from "./backend-factory-eager.js";
import { snapshot } from "./helpers.js";

test("S3 factory exposes a stable secret-free identity, weak capability, and diagnostics", async () => {
	const config = s3Config();
	const backend = createSyncBackend(config);
	const sameDestination = createSyncBackend({
		...config,
		backend: {
			...config.backend,
			profile: {
				...config.backend.profile,
				endpoint: `${config.backend.profile.endpoint}/`,
				accessKeyId: "different-access",
				secretAccessKey: "different-secret",
				sessionToken: "different-token",
			},
		},
		setupName: "other-local-setup",
	});

	assert.equal(backend.identity, sameDestination.identity);
	assert.equal(backend.capability, "read-check-write-verify");
	assert.doesNotMatch(backend.identity, /access-key|secret-key|different/);
	assert.match(backend.destination, /example\.r2\.cloudflarestorage\.com/);
	assert.deepEqual(await backend.diagnose(), [
		{
			key: "s3-config",
			level: "info",
			message: "s3 config: ok (pi-sync-test/pi-sync)",
		},
	]);
	assert.equal(
		backend.identity,
		createSyncBackend({
			...config,
			snapshotIdentity: "work",
			backend: {
				...config.backend,
				destination: { ...config.backend.destination, namespace: "work" },
			},
		}).identity,
	);
	assert.notEqual(
		backend.identity,
		createSyncBackend({
			...config,
			backend: {
				...config.backend,
				destination: { ...config.backend.destination, prefix: "pi-sync/work" },
			},
		}).identity,
	);
});

test("S3 backend reads an opaque revision and validates immutable snapshot checksums", async () => {
	const remote = snapshot([{ path: "settings.json", content: Buffer.from("remote") }]);
	const harness = new S3Harness(remote);
	await harness.run(async () => {
		const backend = createSyncBackend(s3Config());
		const head = await backend.readHead();
		assert.equal(head?.snapshotRef, remote.id);
		assert.equal(head?.snapshotId, remote.id);
		assert.match(head?.revision ?? "", /^s3:/);
		const otherConfig = s3Config();
		otherConfig.backend.profile.endpoint = "https://other.example.com";
		const otherIdentityHead = await createSyncBackend(otherConfig).readHead();
		assert.notEqual(head?.revision, otherIdentityHead?.revision);
		assert.deepEqual(await backend.readSnapshot(remote.id), remote);
		harness.corruptSnapshot(remote.id);
		const freshBackend = createSyncBackend(s3Config());
		await assert.rejects(freshBackend.readSnapshot(remote.id), /checksum mismatch/i);
		await assert.rejects(
			createSyncBackend(s3Config()).readSnapshot("untracked"),
			/snapshot not found/i,
		);
		const historical = { ...remote, id: "historical" };
		harness.addHistorical(historical);
		harness.corruptSnapshot(historical.id);
		const historyBackend = createSyncBackend(s3Config());
		await historyBackend.listHistory();
		await assert.rejects(historyBackend.readSnapshot(historical.id), /checksum mismatch/i);
	});
});

test("S3 rejects unsafe snapshot references and mismatched immutable bundle identities", async () => {
	const config = s3Config();
	assert.throws(() => snapshotKey(config.backend, "../foreign"), /snapshot reference/i);
	const unsafeDestination = s3Config();
	unsafeDestination.backend.destination.prefix = "../foreign";
	assert.throws(() => createSyncBackend(unsafeDestination), /storage location/i);

	const remote = snapshot([{ path: "settings.json", content: Buffer.from("remote") }]);
	const harness = new S3Harness(remote);
	harness.replaceSnapshotPayload(remote.id, { ...remote, id: "different-id" });
	await harness.run(async () => {
		const backend = createSyncBackend(config);
		const head = await backend.readHead();
		await assert.rejects(backend.readSnapshot(head?.snapshotRef ?? ""), /identity mismatch/i);
		await assert.rejects(
			backend.publishSnapshot(
				{ ...remote, id: "candidate", profile: "other" },
				expectedRemoteHead(head),
			),
			/snapshot identity/i,
		);
	});
});

test("S3 rejects control-bearing or oversized remote display metadata", async () => {
	const remote = snapshot([{ path: "settings.json", content: Buffer.from("remote") }]);
	const harness = new S3Harness(remote);
	harness.replacePointerMetadata({
		machine: `host\u001b]8;;https://evil.example\u0007`,
		createdAt: "x".repeat(65),
	});
	await harness.run(async () => {
		await assert.rejects(createSyncBackend(s3Config()).readHead(), /malformed/i);
	});
});

test("S3 retained snapshots remain recoverable after history gaps and eviction", async () => {
	const remote = snapshot([{ path: "settings.json", content: Buffer.from("remote") }]);
	const upload = { ...remote, id: "upload" };
	const harness = new S3Harness(remote);
	harness.failHistory = true;
	await harness.run(async () => {
		const writer = createSyncBackend(s3Config());
		const observed = await writer.readHead();
		await writer.publishSnapshot(upload, expectedRemoteHead(observed));
		harness.failHistory = false;
		harness.replaceHead({ ...remote, id: "advanced" });
		assert.deepEqual(await createSyncBackend(s3Config()).readSnapshot(upload.id), upload);
		harness.addHistorical(upload);
		harness.clearHistory();
		assert.deepEqual(await createSyncBackend(s3Config()).readSnapshot(upload.id), upload);
	});
});

test("S3 checksum registration rejects immutable-reference rebinding in either read order", async () => {
	const remote = snapshot([{ path: "settings.json", content: Buffer.from("remote") }]);
	const changed = {
		...remote,
		files: snapshot([{ path: "settings.json", content: Buffer.from("changed") }]).files,
	};

	const historyFirst = new S3Harness(remote);
	historyFirst.addHistorical(remote);
	await historyFirst.run(async () => {
		const backend = createSyncBackend(s3Config());
		await backend.listHistory();
		historyFirst.replaceHead(changed);
		await assert.rejects(backend.readHead(), /rebound/i);
	});

	const headFirst = new S3Harness(remote);
	await headFirst.run(async () => {
		const backend = createSyncBackend(s3Config());
		await backend.readHead();
		headFirst.addHistorical(changed);
		await assert.rejects(backend.listHistory(), /conflicts|rebound/i);
	});
});

test("S3 malformed history cannot partially prime snapshot integrity state", async () => {
	const remote = snapshot([{ path: "settings.json", content: Buffer.from("remote") }]);
	const historical = { ...remote, id: "historical" };
	const harness = new S3Harness(remote);
	harness.addHistorical(historical);
	harness.addMalformedHistoryEntry();
	await harness.run(async () => {
		const backend = createSyncBackend(s3Config());
		await assert.rejects(backend.listHistory(), /history entry/i);
		await assert.rejects(backend.readSnapshot(historical.id), /history entry/i);
	});
});

test("S3 publication never overwrites an existing immutable snapshot id", async () => {
	const remote = snapshot([{ path: "settings.json", content: Buffer.from("remote") }]);
	const harness = new S3Harness(remote);
	await harness.run(async () => {
		const backend = createSyncBackend(s3Config());
		const observed = await backend.readHead();
		await assert.rejects(
			backend.publishSnapshot(
				{
					...remote,
					files: snapshot([{ path: "settings.json", content: Buffer.from("different") }]).files,
				},
				expectedRemoteHead(observed),
			),
			SyncBackendConflictError,
		);
		const idempotent = await backend.publishSnapshot(remote, expectedRemoteHead(observed));
		assert.equal(idempotent.head.snapshotId, remote.id);
	});
});

test("S3 publication stages immutably and rejects an observed stale revision", async () => {
	const remote = snapshot([{ path: "settings.json", content: Buffer.from("remote") }]);
	const harness = new S3Harness(remote);
	await harness.run(async () => {
		const backend = createSyncBackend(s3Config());
		const observed = await backend.readHead();
		harness.replaceHead({ ...remote, id: "advanced" });

		await assert.rejects(
			backend.publishSnapshot({ ...remote, id: "local" }, expectedRemoteHead(observed)),
			SyncBackendConflictError,
		);
		assert.equal(harness.snapshotPuts, 1);
		assert.equal(harness.latestPuts, 0);
	});
});

test("S3 publication returns the committed head and reports history repair separately", async () => {
	const remote = snapshot([{ path: "settings.json", content: Buffer.from("remote") }]);
	const upload = { ...remote, id: "upload", createdAt: "2026-01-02T00:00:00.000Z" };
	const harness = new S3Harness(remote);
	harness.failHistory = true;
	await harness.run(async () => {
		const backend = createSyncBackend(s3Config());
		const observed = await backend.readHead();
		let commits = 0;
		const result = await backend.publishSnapshot(upload, expectedRemoteHead(observed), {
			onCommit: () => {
				assert.equal(harness.snapshotPuts, 1);
				assert.equal(harness.latestPuts, 0);
				commits += 1;
			},
		});

		assert.equal(commits, 1);
		assert.equal(result.head.snapshotRef, upload.id);
		assert.equal(harness.latestPuts, 1);
		assert.equal(harness.historyPuts, 1);
		assert.match(result.warnings.join("\n"), /history could not be updated/);
	});
});

test("S3 publication reports an observed post-commit race as a typed conflict", async () => {
	const remote = snapshot([{ path: "settings.json", content: Buffer.from("remote") }]);
	const harness = new S3Harness(remote);
	harness.replaceAfterLatest = true;
	await harness.run(async () => {
		const backend = createSyncBackend(s3Config());
		const observed = await backend.readHead();
		await assert.rejects(
			backend.publishSnapshot({ ...remote, id: "upload" }, expectedRemoteHead(observed)),
			(error: unknown) => {
				assert.ok(error instanceof SyncBackendConflictError);
				assert.equal(error.phase, "after-commit");
				assert.equal(error.currentHead?.snapshotId, "upload");
				assert.equal(error.candidateMayHaveBeenActive, true);
				return true;
			},
		);
	});
});

test("S3 publication bounds active-head commit and verification after the commit boundary", async () => {
	const remote = snapshot([{ path: "settings.json", content: Buffer.from("remote") }]);
	const harness = new S3Harness(remote);
	harness.hangLatest = true;
	await harness.run(async () => {
		const backend = new S3SyncBackend(s3Config().backend, 5);
		const observed = await backend.readHead();
		await assert.rejects(
			backend.publishSnapshot({ ...remote, id: "upload" }, expectedRemoteHead(observed)),
			SyncBackendPublicationOutcomeUnknownError,
		);
	});
});

test("S3 publication classifies active-head write failures as outcome unknown", async () => {
	const remote = snapshot([{ path: "settings.json", content: Buffer.from("remote") }]);
	const harness = new S3Harness(remote);
	harness.failLatest = true;
	await harness.run(async () => {
		const backend = createSyncBackend(s3Config());
		const observed = await backend.readHead();
		await assert.rejects(
			backend.publishSnapshot({ ...remote, id: "upload" }, expectedRemoteHead(observed)),
			SyncBackendPublicationOutcomeUnknownError,
		);
	});
});

function s3Config(): SyncConfig {
	return {
		backend: {
			type: "s3",
			profile: {
				kind: "r2",
				endpoint: "https://example.r2.cloudflarestorage.com",
				region: "auto",
				accessKeyId: "access-key",
				secretAccessKey: "secret-key",
			},
			destination: { bucket: "pi-sync-test", prefix: "pi-sync", namespace: "default" },
		},
		setupName: "default",
		connectionName: "default",
		storagePath: "pi-sync",
		snapshotIdentity: "default",
		include: [],
		automatic: false,
		onSwitch: "switch-only",
		skipSecretScan: false,
	};
}

class S3Harness {
	private originalFetch = globalThis.fetch;
	private snapshots = new Map<string, Buffer>();
	private pointer: LatestPointer;
	private historyPointers: LatestPointer[] = [];
	private etagRevision = 1;
	private replaceOnNextLatestRead = false;
	snapshotPuts = 0;
	latestPuts = 0;
	historyPuts = 0;
	failLatest = false;
	hangLatest = false;
	failHistory = false;
	replaceAfterLatest = false;

	constructor(initial: Snapshot) {
		const encoded = encode(initial);
		this.snapshots.set(initial.id, encoded);
		this.pointer = pointer(initial, encoded);
	}

	addHistorical(value: Snapshot) {
		const encoded = encode(value);
		this.snapshots.set(value.id, encoded);
		this.historyPointers.push(pointer(value, encoded));
	}

	clearHistory() {
		this.historyPointers = [];
	}

	addMalformedHistoryEntry() {
		this.historyPointers.push({ ...this.pointer, snapshot: "../foreign" });
	}

	corruptSnapshot(reference: string) {
		this.snapshots.set(reference, Buffer.from("corrupt"));
	}

	replaceSnapshotPayload(reference: string, value: Snapshot) {
		const encoded = encode(value);
		this.snapshots.set(reference, encoded);
		this.pointer = {
			...this.pointer,
			sha256: createHash("sha256").update(encoded).digest("hex"),
		};
	}

	replacePointerMetadata(value: Partial<LatestPointer>) {
		this.pointer = { ...this.pointer, ...value };
	}

	replaceHead(value: Snapshot) {
		const encoded = encode(value);
		this.snapshots.set(value.id, encoded);
		this.pointer = pointer(value, encoded);
		this.etagRevision += 1;
	}

	async run<T>(fn: () => Promise<T>) {
		globalThis.fetch = this.fetch as typeof globalThis.fetch;
		try {
			return await fn();
		} finally {
			globalThis.fetch = this.originalFetch;
		}
	}

	private fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		if (url.pathname.endsWith("/latest.json")) {
			if (method === "PUT") {
				this.latestPuts += 1;
				if (this.hangLatest) return hangingResponse(init?.signal);
				if (this.failLatest) return new Response("latest failed", { status: 503 });
				this.pointer = parseJsonBody(init?.body) as unknown as LatestPointer;
				this.etagRevision += 1;
				this.replaceOnNextLatestRead = this.replaceAfterLatest;
				return new Response(null, { status: 200 });
			}
			if (this.replaceOnNextLatestRead) {
				this.replaceOnNextLatestRead = false;
				return Response.json(
					{ ...this.pointer, backendMetadata: "concurrent-writer" },
					{ headers: { etag: '"concurrent"' } },
				);
			}
			return Response.json(this.pointer, {
				headers: { etag: `"latest-${this.etagRevision}"` },
			});
		}
		if (url.pathname.includes("/snapshots/")) {
			const reference = decodeURIComponent(url.pathname.split("/").at(-1) ?? "").replace(
				/\.json\.gz$/,
				"",
			);
			if (method === "PUT") {
				this.snapshotPuts += 1;
				const headers = new Headers(init?.headers);
				if (headers.get("if-none-match") === "*" && this.snapshots.has(reference)) {
					return new Response("already exists", { status: 412 });
				}
				this.snapshots.set(reference, Buffer.from(init?.body as Uint8Array));
				return new Response(null, { status: 200 });
			}
			const value = this.snapshots.get(reference);
			return value
				? new Response(new Uint8Array(value), { status: 200 })
				: new Response(null, { status: 404 });
		}
		if (url.pathname.endsWith("/history.json")) {
			if (method === "PUT") {
				this.historyPuts += 1;
				if (this.failHistory) return new Response("history failed", { status: 503 });
				const body = parseJsonBody(init?.body) as { snapshots?: LatestPointer[] };
				this.historyPointers = body.snapshots ?? [];
				return new Response(null, { status: 200 });
			}
			return this.historyPointers.length > 0
				? Response.json({ version: 1, snapshots: this.historyPointers })
				: new Response(null, { status: 404 });
		}
		throw new Error(`Unexpected request: ${method} ${url.pathname}`);
	};
}

function hangingResponse(signal?: AbortSignal | null) {
	return new Promise<Response>((_resolve, reject) => {
		const keepAlive = setInterval(() => undefined, 1_000);
		signal?.addEventListener(
			"abort",
			() => {
				clearInterval(keepAlive);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}

function encode(value: Snapshot) {
	return gzipSync(Buffer.from(JSON.stringify(value), "utf8"));
}

function pointer(value: Snapshot, encoded: Buffer): LatestPointer {
	return {
		version: 1,
		profile: value.profile,
		snapshot: value.id,
		sha256: createHash("sha256").update(encoded).digest("hex"),
		createdAt: value.createdAt,
		machine: value.machine,
		syncSessions: value.syncSessions,
	};
}

function parseJsonBody(body: BodyInit | null | undefined) {
	if (!body) throw new Error("Expected request body");
	if (typeof body === "string") return JSON.parse(body) as Record<string, unknown>;
	if (body instanceof Uint8Array) {
		return JSON.parse(Buffer.from(body).toString("utf8")) as Record<string, unknown>;
	}
	throw new Error("Unexpected request body");
}
