import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { loadLangfuseConfig } from "../src/config.js";
import { createLangfuseExtension } from "../src/langfuse.js";
import { FakeBackend } from "./support.js";

test("/langfuse shows enabled current-session state and context-aware next actions", async () => {
	const backend = new FakeBackend();
	const mock = createMockPi();
	createLangfuseExtension({
		loadConfig: async () => ({
			ok: true,
			config: {
				publicKey: "pk-private-value",
				secretKey: "sk-private-value",
				baseUrl: "https://example.test",
				captureContent: true,
			},
			path: "/private/pi-langfuse.json",
			warnings: [],
		}),
		createBackend: async () => backend,
	})(mock.pi);
	const selectCalls: Array<{ title: string; options: string[] }> = [];
	const { ctx } = createMockContext({
		hasUI: true,
		select: async (title: string, options: string[]) => {
			selectCalls.push({ title, options });
			return undefined;
		},
	});
	await mock.events.get("session_start")?.[0]?.({}, ctx);
	const command = mock.commands.get("langfuse");

	await command?.handler("legacy arguments are ignored", ctx);

	assert.equal(command?.getArgumentCompletions, undefined);
	assert.match(selectCalls[0]?.title ?? "", /Current session:\n {2}Tracing: enabled/);
	assert.match(selectCalls[0]?.title ?? "", /Endpoint: https:\/\/example\.test/);
	assert.match(selectCalls[0]?.title ?? "", /Content capture: enabled/);
	assert.match(selectCalls[0]?.title ?? "", /Configuration: \/private\/pi-langfuse\.json/);
	assert.match(selectCalls[0]?.title ?? "", /this Pi agent directory.*restart each Pi process/i);
	assert.deepEqual(selectCalls[0]?.options, [
		"Flush completed traces for this session",
		"Update Langfuse for this Pi agent directory (restart required)",
		"Show setup and privacy help",
	]);
	assert.doesNotMatch(selectCalls[0]?.title ?? "", /private-value/);
});

test("/langfuse routes the current-session flush action and waits for export", async () => {
	const backend = new FakeBackend();
	let releaseFlush: (() => void) | undefined;
	backend.forceFlush = () =>
		new Promise<void>((resolve) => {
			releaseFlush = resolve;
		});
	const mock = createMockPi();
	createLangfuseExtension({
		loadConfig: async () => ({
			ok: true,
			config: {
				publicKey: "pk",
				secretKey: "sk",
				baseUrl: "https://example.test",
				captureContent: true,
			},
			path: "/private/pi-langfuse.json",
			warnings: [],
		}),
		createBackend: async () => backend,
	})(mock.pi);
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		select: async () => "Flush completed traces for this session",
	});
	await mock.events.get("session_start")?.[0]?.({}, ctx);

	const flush = mock.commands.get("langfuse")?.handler("flush", ctx) as Promise<void>;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(
		notifications.some(({ message }) => /flushed/.test(message)),
		false,
	);
	releaseFlush?.();
	await flush;
	assert.match(notifications.at(-1)?.message ?? "", /flushed/i);
});

test("/langfuse does not apply a pending menu choice after the session changes", async () => {
	const firstBackend = new FakeBackend();
	const secondBackend = new FakeBackend();
	const backends = [firstBackend, secondBackend];
	let choose: ((choice: string) => void) | undefined;
	const mock = createMockPi();
	createLangfuseExtension({
		loadConfig: async () => ({
			ok: true,
			config: {
				publicKey: "pk",
				secretKey: "sk",
				baseUrl: "https://example.test",
				captureContent: true,
			},
			path: "/private/pi-langfuse.json",
			warnings: [],
		}),
		createBackend: async () => backends.shift() ?? secondBackend,
	})(mock.pi);
	const { ctx } = createMockContext({
		hasUI: true,
		select: async () =>
			new Promise<string>((resolve) => {
				choose = resolve;
			}),
	});
	const sessionStart = mock.events.get("session_start")?.[0];
	await sessionStart?.({}, ctx);
	const pending = mock.commands.get("langfuse")?.handler("", ctx) as Promise<void>;
	await new Promise((resolve) => setImmediate(resolve));

	await sessionStart?.({}, ctx);
	assert.ok(choose);
	choose("Flush completed traces for this session");
	await pending;

	assert.equal(firstBackend.flushes, 0);
	assert.equal(secondBackend.flushes, 0);
});

test("/langfuse redacts configured keys from flush failures", async () => {
	const backend = new FakeBackend();
	backend.forceFlush = async () => {
		throw new Error("flush exposed pk-private-ui and sk-private-ui");
	};
	const mock = createMockPi();
	createLangfuseExtension({
		loadConfig: async () => ({
			ok: true,
			config: {
				publicKey: "pk-private-ui",
				secretKey: "sk-private-ui",
				baseUrl: "https://example.test",
				captureContent: true,
			},
			path: "/private/pi-langfuse.json",
			warnings: [],
		}),
		createBackend: async () => backend,
	})(mock.pi);
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		select: async () => "Flush completed traces for this session",
	});
	await mock.events.get("session_start")?.[0]?.({}, ctx);

	await mock.commands.get("langfuse")?.handler("", ctx);

	const message = notifications.at(-1)?.message ?? "";
	assert.match(message, /flush exposed/);
	assert.match(message, /LANGFUSE_KEY_REDACTED/);
	assert.doesNotMatch(message, /pk-private-ui|sk-private-ui/);
});

test("/langfuse disabled state prioritizes agent-directory setup and routes privacy help", async () => {
	const mock = createMockPi();
	createLangfuseExtension({
		loadConfig: async () => ({
			ok: false,
			path: "/config/pi-langfuse.json",
			warnings: [],
			reason: "Configuration file not found: /config/pi-langfuse.json",
		}),
		createBackend: async () => new FakeBackend(),
	})(mock.pi);
	const selectCalls: Array<{ title: string; options: string[] }> = [];
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		select: async (title: string, options: string[]) => {
			selectCalls.push({ title, options });
			return "Show setup and privacy help";
		},
	});
	await mock.events.get("session_start")?.[0]?.({}, ctx);

	await mock.commands.get("langfuse")?.handler("status", ctx);

	assert.match(selectCalls[0]?.title ?? "", /Current session:\n {2}Tracing: disabled/);
	assert.match(selectCalls[0]?.title ?? "", /Configuration file not found/);
	assert.deepEqual(selectCalls[0]?.options, [
		"Set up Langfuse for this Pi agent directory (restart required)",
		"Show setup and privacy help",
	]);
	assert.match(notifications.at(-1)?.message ?? "", /trace content may contain/i);
	assert.match(notifications.at(-1)?.message ?? "", /git branch.*remain in metadata/i);
	assert.match(notifications.at(-1)?.message ?? "", /\/config\/pi-langfuse\.json/);
});

test("/langfuse interactively creates and updates a private agent-directory config", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-langfuse-init-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "nested", "pi-langfuse.json");
	const mock = createMockPi();
	createLangfuseExtension({
		loadConfig: (requestedPath = path) => loadLangfuseConfig(requestedPath),
		createBackend: async () => new FakeBackend(),
	})(mock.pi);
	const session = createMockContext({ hasUI: false });
	await mock.events.get("session_start")?.[0]?.({}, session.ctx);
	const command = mock.commands.get("langfuse");
	const notifications: Array<{ message: string; level?: string }> = [];
	const prompts: Array<{ title: string; placeholder?: string }> = [];
	const menuTitles: string[] = [];
	const answers = ["sk-new", "pk-new", ""];
	const selections = [
		"Set up Langfuse for this Pi agent directory (restart required)",
		"Update Langfuse for this Pi agent directory (restart required)",
	];
	const ctx = {
		hasUI: true,
		ui: {
			select: async (title: string) => {
				menuTitles.push(title);
				return selections.shift();
			},
			input: async (title: string, placeholder?: string) => {
				prompts.push({ title, placeholder });
				return answers.shift();
			},
			notify(message: string, level?: string) {
				notifications.push({ message, level });
			},
		},
	};

	await command?.handler("init", ctx);

	assert.deepEqual(
		prompts.slice(0, 3).map(({ title }) => title),
		[
			"Langfuse secret key (leave blank to keep existing):",
			"Langfuse public key (leave blank to keep existing):",
			"Langfuse base URL (leave blank for default https://us.cloud.langfuse.com):",
		],
	);
	assert.equal(prompts[2]?.placeholder, "https://us.cloud.langfuse.com");
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
		publicKey: "pk-new",
		secretKey: "sk-new",
		baseUrl: "https://us.cloud.langfuse.com",
		captureContent: true,
	});
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.match(
		notifications.at(-1)?.message ?? "",
		/this Pi agent directory.*restart each Pi process/i,
	);
	assert.equal(notifications.at(-1)?.level, "info");

	answers.push("", "", "https://self-hosted.example/");
	await command?.handler("anything", ctx);
	assert.match(menuTitles[1] ?? "", /State: tracing remains disabled until Pi restarts/i);
	assert.match(
		menuTitles[1] ?? "",
		/Pending: Saved; restart each Pi process to use it in subsequent sessions/i,
	);
	assert.doesNotMatch(menuTitles[1] ?? "", /Reason:|Configuration file not found/);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
		publicKey: "pk-new",
		secretKey: "sk-new",
		baseUrl: "https://self-hosted.example",
		captureContent: true,
	});
});

test("/langfuse keeps an active session on its original connection after an update", async () => {
	const backend = new FakeBackend();
	const originalConfig = {
		publicKey: "pk-original",
		secretKey: "sk-original",
		baseUrl: "https://original.example",
		captureContent: true,
	};
	let backendCreations = 0;
	let savedConfig: unknown;
	const menuCalls: Array<{ title: string; options: string[] }> = [];
	const selections = ["Update Langfuse for this Pi agent directory (restart required)", undefined];
	const answers = ["sk-updated", "pk-updated", "https://updated.example"];
	const mock = createMockPi();
	createLangfuseExtension({
		loadConfig: async () => ({
			ok: true,
			config: originalConfig,
			path: "/private/pi-langfuse.json",
			warnings: [],
		}),
		writeConfig: async (config) => {
			savedConfig = config;
			return config;
		},
		createBackend: async () => {
			backendCreations += 1;
			return backend;
		},
	})(mock.pi);
	const { ctx } = createMockContext({
		hasUI: true,
		select: async (title: string, options: string[]) => {
			menuCalls.push({ title, options });
			return selections.shift();
		},
		input: async () => answers.shift(),
	});
	await mock.events.get("session_start")?.[0]?.({}, ctx);
	const command = mock.commands.get("langfuse");

	await command?.handler("", ctx);
	await command?.handler("", ctx);

	assert.deepEqual(savedConfig, {
		publicKey: "pk-updated",
		secretKey: "sk-updated",
		baseUrl: "https://updated.example",
		captureContent: true,
	});
	assert.equal(backendCreations, 1);
	assert.match(menuCalls[1]?.title ?? "", /Endpoint: https:\/\/original\.example/);
	assert.match(menuCalls[1]?.title ?? "", /Content capture: enabled/);
	assert.match(menuCalls[1]?.title ?? "", /Pending: Saved; restart each Pi process/i);
	assert.deepEqual(menuCalls[1]?.options, [
		"Flush completed traces for this session",
		"Update Langfuse for this Pi agent directory (restart required)",
		"Show setup and privacy help",
	]);
});

test("/langfuse redacts entered keys from configuration save failures", async () => {
	const mock = createMockPi();
	createLangfuseExtension({
		loadConfig: async () => ({
			ok: false,
			path: "/private/pi-langfuse.json",
			warnings: [],
			reason: "missing",
		}),
		writeConfig: async (config) => {
			throw new Error(`write exposed ${config.publicKey} and ${config.secretKey}`);
		},
		createBackend: async () => new FakeBackend(),
	})(mock.pi);
	const answers = ["sk-private-ui", "pk-private-ui", "https://example.test"];
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		select: async () => "Set up Langfuse for this Pi agent directory (restart required)",
		input: async () => answers.shift(),
	});
	await mock.events.get("session_start")?.[0]?.({}, ctx);

	await mock.commands.get("langfuse")?.handler("", ctx);

	const message = notifications.at(-1)?.message ?? "";
	assert.match(message, /write exposed/);
	assert.match(message, /LANGFUSE_KEY_REDACTED/);
	assert.doesNotMatch(message, /pk-private-ui|sk-private-ui/);
});

test("/langfuse ignores arguments but requires interactive UI", async () => {
	const mock = createMockPi();
	createLangfuseExtension({
		loadConfig: async () => ({
			ok: false,
			path: "/config/pi-langfuse.json",
			warnings: [],
			reason: "missing",
		}),
		createBackend: async () => new FakeBackend(),
	})(mock.pi);
	const { ctx, notifications } = createMockContext({ hasUI: false });
	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await mock.commands.get("langfuse")?.handler("flush", ctx);
	assert.match(notifications.at(-1)?.message ?? "", /requires interactive UI/i);
	assert.match(notifications.at(-1)?.message ?? "", /Current session tracing: disabled/i);
	assert.match(notifications.at(-1)?.message ?? "", /\/config\/pi-langfuse\.json/);
	assert.equal(notifications.at(-1)?.level, "warning");
});
