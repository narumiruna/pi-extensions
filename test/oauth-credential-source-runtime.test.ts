import assert from "node:assert/strict";
import {
	createEventBus,
	DefaultResourceLoader,
	ExtensionRunner,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

const CHANNEL = "oauth:credential-source:v1";

type Credential = {
	type: "oauth";
	access: string;
	refresh: string;
	expires: number;
};

type CredentialRequest = {
	session: object;
	provider: string;
	offer: (credential: Credential) => void;
};

test("createEventBus collects every synchronous credential offer before emit returns", async () => {
	const eventBus = createEventBus();
	let releaseAsyncListener!: () => void;
	let finishAsyncListener!: () => void;
	const asyncGate = new Promise<void>((resolve) => {
		releaseAsyncListener = resolve;
	});
	const asyncFinished = new Promise<void>((resolve) => {
		finishAsyncListener = resolve;
	});
	const session = {};
	const otherSession = {};
	const offers: string[] = [];
	const request: CredentialRequest = {
		session,
		provider: "github-copilot",
		offer(credential) {
			offers.push(credential.access);
		},
	};

	eventBus.on(CHANNEL, (data) => {
		const current = data as CredentialRequest;
		if (current.session !== session || current.provider !== "github-copilot") return;
		current.offer({ type: "oauth", access: "first", refresh: "one", expires: 1 });
	});
	eventBus.on(CHANNEL, (data) => {
		const current = data as CredentialRequest;
		if (current.session === otherSession) {
			current.offer({ type: "oauth", access: "wrong-session", refresh: "two", expires: 2 });
		}
	});
	eventBus.on(CHANNEL, async (data) => {
		const current = data as CredentialRequest;
		current.offer({ type: "oauth", access: "before-await", refresh: "three", expires: 3 });
		await asyncGate;
		current.offer({ type: "oauth", access: "after-await", refresh: "four", expires: 4 });
		finishAsyncListener();
	});

	eventBus.emit(CHANNEL, request);
	assert.deepEqual(offers, ["first", "before-await"]);

	releaseAsyncListener();
	await asyncFinished;
	assert.deepEqual(offers, ["first", "before-await", "after-await"]);
});

test("inline extension factories share one bus and stale runtimes unsubscribe", async () => {
	const eventBus = createEventBus();
	const session = {};
	const offers: string[] = [];
	const loader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir: process.cwd(),
		settingsManager: SettingsManager.inMemory({}),
		eventBus,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			{
				name: "credential-owner",
				factory(pi) {
					pi.events.on(CHANNEL, (data) => {
						const request = data as CredentialRequest;
						if (request.session !== session) return;
						request.offer({ type: "oauth", access: "shared", refresh: "secret", expires: 1 });
					});
				},
			},
			{
				name: "credential-consumer-observer",
				factory(pi) {
					pi.events.on(CHANNEL, (data) => {
						assert.equal((data as CredentialRequest).session, session);
					});
				},
			},
		],
	});

	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 2);

	const request = (): CredentialRequest => ({
		session,
		provider: "github-copilot",
		offer(credential) {
			offers.push(credential.access);
		},
	});
	eventBus.emit(CHANNEL, request());
	assert.deepEqual(offers, ["shared"]);

	loaded.runtime.invalidate("credential source runtime characterization cleanup");
	eventBus.emit(CHANNEL, request());
	assert.deepEqual(offers, ["shared"]);
});

test("ExtensionRunner contexts preserve exact sessionManager identity", async () => {
	const eventBus = createEventBus();
	const observedSessionManagers: object[] = [];
	const loader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir: process.cwd(),
		settingsManager: SettingsManager.inMemory({}),
		eventBus,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			(pi) => {
				pi.on("session_start", (_event, ctx) => {
					observedSessionManagers.push(ctx.sessionManager);
				});
			},
		],
	});
	const sessionManager = {};

	await loader.reload();
	const loaded = loader.getExtensions();
	const runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		process.cwd(),
		sessionManager as never,
		{} as never,
	);

	assert.equal(runner.createContext().sessionManager, sessionManager);
	assert.equal(runner.createCommandContext().sessionManager, sessionManager);
	await runner.emit({ type: "session_start", reason: "startup" });
	assert.deepEqual(observedSessionManagers, [sessionManager]);
});
