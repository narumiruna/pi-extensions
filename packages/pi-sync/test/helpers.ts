import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { lockPath } from "../src/config.js";

export function writeOldLock(contents: string) {
	writeFileSync(lockPath(), contents);
	const old = new Date(Date.now() - 60_000);
	utimesSync(lockPath(), old, old);
}

export function snapshot(files: Array<{ path: string; content: Buffer }>) {
	return {
		version: 1,
		id: "snap",
		createdAt: "2026-01-01T00:00:00.000Z",
		machine: "test",
		profile: "default",
		files: files.map((file) => ({
			path: file.path,
			contentBase64: file.content.toString("base64"),
			sha256: createHash("sha256").update(file.content).digest("hex"),
		})),
	};
}

export function v3S3Settings(
	options: {
		automatic?: boolean;
		include?: string[];
		path?: string;
		bucket?: string;
		skipSecretScan?: boolean;
	} = {},
) {
	return {
		version: 3,
		activeSyncSetup: "home",
		onSwitch: "ask-before-pull",
		skipSecretScan: options.skipSecretScan ?? false,
		storageConnections: {
			r2: {
				type: "s3",
				endpoint: "https://example.r2.cloudflarestorage.com",
				region: "auto",
				credentials: { accessKeyId: "access-key", secretAccessKey: "secret-key" },
			},
		},
		syncSetups: {
			home: {
				storage: {
					connection: "r2",
					bucket: options.bucket ?? "pi-sync-test",
					path: options.path ?? "pi-sync/home",
				},
				sync: {
					include: options.include ?? ["settings.json"],
					automatic: options.automatic ?? false,
				},
			},
		},
	};
}

export function v3WebDavSettings(options: { automatic?: boolean; include?: string[] } = {}) {
	return {
		version: 3,
		activeSyncSetup: "home",
		onSwitch: "ask-before-pull",
		storageConnections: {
			dav: {
				type: "webdav",
				url: "https://cloud.example.com/dav",
				credentials: { username: "user", password: "pass" },
			},
		},
		syncSetups: {
			home: {
				storage: { connection: "dav", path: "pi-sync/home" },
				sync: {
					include: options.include ?? ["settings.json"],
					automatic: options.automatic ?? false,
				},
			},
		},
	};
}

/** Legacy flat fixture retained only by backend-unit tests that do not load settings. */
export function requiredConfig() {
	return {
		backend: "s3" as const,
		endpoint: "https://example.r2.cloudflarestorage.com",
		bucket: "pi-sync-test",
		accessKeyId: "access-key",
		secretAccessKey: "secret-key",
		extraFiles: [],
	};
}

export async function withTempHome<T>(fn: (agentDir: string) => Promise<T>) {
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
	const home = mkdtempSync(path.join(os.tmpdir(), "pi-sync-home-"));
	const agentDir = path.join(home, ".pi", "agent");
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_CODING_AGENT_SESSION_DIR;
	try {
		return await fn(agentDir);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
		else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
		rmSync(home, { recursive: true, force: true });
	}
}

export async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>) {
	const keys = [
		"PI_SYNC_ENDPOINT",
		"PI_SYNC_BUCKET",
		"PI_SYNC_ACCESS_KEY_ID",
		"PI_SYNC_SECRET_ACCESS_KEY",
		"PI_SYNC_SESSIONS",
		"PI_SYNC_SESSION_TOKEN",
		"PI_SYNC_REGION",
		"PI_SYNC_PROFILE",
		"PI_SYNC_PREFIX",
		"PI_SYNC_AUTO_SYNC",
		"PI_CODING_AGENT_DIR",
		"PI_CODING_AGENT_SESSION_DIR",
		"R2_ENDPOINT",
		"R2_BUCKET",
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
		"AWS_REGION",
	];
	const previous = new Map(keys.map((key) => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
	Object.assign(process.env, env);
	try {
		return await fn();
	} finally {
		for (const key of keys) {
			const value = previous.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}
