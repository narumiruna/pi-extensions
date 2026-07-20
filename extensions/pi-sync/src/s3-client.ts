import { createHash, createHmac } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { encodeKey, posixJoin } from "./paths.js";
import type { LatestPointer, RemoteObject, Snapshot, SyncConfig } from "./types.js";

const VERSION = 1;

function iso8601Basic(date: Date) {
	return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function snapshotIncludesSessions(snapshot: Snapshot) {
	return snapshot.syncSessions === true || snapshot.files.some((file) => file.path.startsWith("sessions/"));
}

function isCloudflareR2Endpoint(endpoint: string | undefined) {
	const value = endpoint?.trim();
	if (!value) return false;
	try {
		const hostname = new URL(value).hostname.toLowerCase();
		return hostname === "r2.cloudflarestorage.com" || hostname.endsWith(".r2.cloudflarestorage.com");
	} catch {
		return false;
	}
}

export class S3Client {
	private config: SyncConfig;
	private endpoint: URL;
	private omitSessionTokenAfterRejection = false;

	constructor(config: SyncConfig) {
		this.config = config;
		this.endpoint = new URL(config.endpoint);
	}

	async getJson<T>(key: string): Promise<RemoteObject<T>> {
		const maxAttempts = 3;
		let lastError: unknown;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const object = await this.request("GET", key);
			if (object.status === 404) return { missing: true };
			if (!object.ok) throw new Error(`S3 GET failed (${object.status}): ${await object.text()}`);
			const body = await object.text();
			// R2 can intermittently return an empty 200 body (read-after-write
			// inconsistency on a long-lived keep-alive connection), which makes
			// response.json() throw "JSON Parse error: Unexpected EOF" under Bun.
			// Retry so the transient blip is absorbed instead of surfacing as a
			// "pi-sync auto sync skipped" warning on every session start.
			if (body.length > 0) {
				try {
					return { value: JSON.parse(body) as T, etag: normalizeEtag(object.headers.get("etag")), missing: false };
				} catch (error) {
					lastError = error;
				}
			} else {
				lastError = new Error(`S3 GET returned an empty body for ${key}`);
			}
			if (attempt < maxAttempts) {
				await sleep(250 * attempt);
			}
		}
		throw lastError;
	}

	async getBuffer(key: string): Promise<RemoteObject<Buffer>> {
		const maxAttempts = 3;
		let lastError: unknown;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const object = await this.request("GET", key);
			if (object.status === 404) return { missing: true };
			if (!object.ok) throw new Error(`S3 GET failed (${object.status}): ${await object.text()}`);
			const buffer = Buffer.from(await object.arrayBuffer());
			// R2 can intermittently return an empty 200 body on a long-lived
			// keep-alive connection (same root cause as the getJson retry
			// above). getBuffer is only used for snapshot .json.gz payloads,
			// which are always non-empty, so an empty body is a transient
			// blip, not a legitimate response. Retry so the checksum guard
			// downstream doesn't surface it as "Remote snapshot checksum
			// mismatch".
			if (buffer.length > 0) {
				return { value: buffer, etag: normalizeEtag(object.headers.get("etag")), missing: false };
			}
			lastError = new Error(`S3 GET returned an empty body for ${key}`);
			if (attempt < maxAttempts) {
				await sleep(250 * attempt);
			}
		}
		throw lastError;
	}

	async putJson(key: string, value: unknown) {
		const body = Buffer.from(JSON.stringify(value, null, "\t"), "utf8");
		await this.putBuffer(key, body, "application/json");
	}

	async putBuffer(key: string, body: Buffer, contentType: string) {
		const headers: Record<string, string> = { "content-type": contentType };
		const response = await this.request("PUT", key, body, headers);
		if (!response.ok) throw new Error(`S3 PUT failed (${response.status}): ${await response.text()}`);
	}

	private async request(
		method: "GET" | "PUT",
		key: string,
		body?: Buffer,
		extraHeaders: Record<string, string> = {},
	) {
		const url = new URL(this.endpoint.toString());
		url.pathname = posixJoin(url.pathname, this.config.bucket, encodeKey(key));
		const send = async (sessionToken: string | undefined) => {
			const headers = await signedHeaders({
				method,
				url,
				body,
				extraHeaders,
				accessKeyId: this.config.accessKeyId,
				secretAccessKey: this.config.secretAccessKey,
				sessionToken,
				region: this.config.region,
			});
			return fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined });
		};
		const sessionToken = this.omitSessionTokenAfterRejection ? undefined : this.config.sessionToken;
		const response = await send(sessionToken);
		if (!(await this.shouldRetryWithoutSessionToken(response, sessionToken))) return response;

		const retry = await send(undefined);
		if (retry.ok || retry.status === 404) this.omitSessionTokenAfterRejection = true;
		return retry;
	}

	private async shouldRetryWithoutSessionToken(response: Response, sessionToken: string | undefined) {
		if (
			!sessionToken ||
			!isCloudflareR2Endpoint(this.config.endpoint) ||
			response.ok ||
			response.status !== 400
		) {
			return false;
		}
		return isSecurityTokenInvalidArgument(await response.clone().text());
	}
}

async function signedHeaders(input: {
	method: string;
	url: URL;
	body?: Buffer;
	extraHeaders: Record<string, string>;
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	region: string;
}) {
	const now = new Date();
	const amzDate = iso8601Basic(now);
	const dateStamp = amzDate.slice(0, 8);
	const payloadHash = sha256(input.body ?? Buffer.alloc(0));
	const headers: Record<string, string> = {
		...lowercaseKeys(input.extraHeaders),
		host: input.url.host,
		"x-amz-content-sha256": payloadHash,
		"x-amz-date": amzDate,
	};
	if (input.sessionToken) headers["x-amz-security-token"] = input.sessionToken;
	const signedHeaderNames = Object.keys(headers).sort();
	const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]?.trim()}\n`).join("");
	const canonicalRequest = [
		input.method,
		input.url.pathname,
		input.url.searchParams.toString(),
		canonicalHeaders,
		signedHeaderNames.join(";"),
		payloadHash,
	].join("\n");
	const scope = `${dateStamp}/${input.region}/s3/aws4_request`;
	const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(Buffer.from(canonicalRequest))].join("\n");
	const signingKey = hmac(
		hmac(hmac(hmac(Buffer.from(`AWS4${input.secretAccessKey}`), dateStamp), input.region), "s3"),
		"aws4_request",
	);
	const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
	return {
		...headers,
		authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`,
	};
}

function hmac(key: Buffer, value: string) {
	return createHmac("sha256", key).update(value).digest();
}

function sha256(value: Buffer) {
	return createHash("sha256").update(value).digest("hex");
}

export function latestKey(config: SyncConfig) {
	return posixJoin(profilePrefix(config), "latest.json");
}

export function historyKey(config: SyncConfig) {
	return posixJoin(profilePrefix(config), "history.json");
}

export function snapshotKey(config: SyncConfig, id: string) {
	return posixJoin(profilePrefix(config), "snapshots", `${id}.json.gz`);
}

export function profilePrefix(config: SyncConfig) {
	return posixJoin(config.prefix, "profiles", config.profile);
}

export function pointerFor(config: SyncConfig, snapshot: Snapshot, checksum: string): LatestPointer {
	return {
		version: VERSION,
		profile: config.profile,
		snapshot: snapshot.id,
		sha256: checksum,
		createdAt: snapshot.createdAt,
		machine: snapshot.machine,
		syncSessions: snapshotIncludesSessions(snapshot),
	};
}

function lowercaseKeys(value: Record<string, string>) {
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.toLowerCase(), item]));
}

function normalizeEtag(value: string | null) {
	return value ?? undefined;
}

function isSecurityTokenInvalidArgument(text: string) {
	return text.includes("<Code>InvalidArgument</Code>") && text.includes("<Message>X-Amz-Security-Token</Message>");
}
