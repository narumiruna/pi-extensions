import type { LatestPointer, SyncConfig } from "../src/types.js";
import { registerSyncBackendContractSuite } from "./backend-contract-suite.js";
import { createSyncBackend } from "./backend-factory-eager.js";

registerSyncBackendContractSuite("s3", () => {
	const harness = new ContractS3Harness();
	return { backend: createSyncBackend(s3Config()), dispose: harness.install() };
});

class ContractS3Harness {
	private snapshots = new Map<string, Buffer>();
	private pointer?: LatestPointer;
	private history: LatestPointer[] = [];
	private revision = 0;

	install() {
		const original = globalThis.fetch;
		globalThis.fetch = this.fetch as typeof globalThis.fetch;
		return () => {
			globalThis.fetch = original;
		};
	}

	private fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		if (url.pathname.endsWith("/latest.json")) {
			if (method === "PUT") {
				this.pointer = parseJsonBody(init?.body) as unknown as LatestPointer;
				this.revision += 1;
				return new Response(null, { status: 200 });
			}
			return this.pointer
				? Response.json(this.pointer, { headers: { etag: `"revision-${this.revision}"` } })
				: new Response(null, { status: 404 });
		}
		if (url.pathname.endsWith("/history.json")) {
			if (method === "PUT") {
				const body = parseJsonBody(init?.body) as { snapshots?: LatestPointer[] };
				this.history = body.snapshots ?? [];
				return new Response(null, { status: 200 });
			}
			return this.history.length > 0
				? Response.json({ version: 1, snapshots: this.history })
				: new Response(null, { status: 404 });
		}
		if (url.pathname.includes("/snapshots/")) {
			const reference = decodeURIComponent(url.pathname.split("/").at(-1) ?? "").replace(
				/\.json\.gz$/,
				"",
			);
			if (method === "PUT") {
				if (
					new Headers(init?.headers).get("if-none-match") === "*" &&
					this.snapshots.has(reference)
				) {
					return new Response("already exists", { status: 412 });
				}
				this.snapshots.set(reference, Buffer.from(init?.body as Uint8Array));
				return new Response(null, { status: 200 });
			}
			const snapshot = this.snapshots.get(reference);
			return snapshot
				? new Response(new Uint8Array(snapshot), { status: 200 })
				: new Response(null, { status: 404 });
		}
		throw new Error(`Unexpected request: ${method} ${url.pathname}`);
	};
}

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

function parseJsonBody(body: BodyInit | null | undefined) {
	if (!body) throw new Error("Expected request body");
	if (typeof body === "string") return JSON.parse(body) as Record<string, unknown>;
	if (body instanceof Uint8Array) {
		return JSON.parse(Buffer.from(body).toString("utf8")) as Record<string, unknown>;
	}
	throw new Error("Unexpected request body");
}
