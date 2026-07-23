import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { type ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { AgentConfig } from "../src/agents.js";
import {
	type ChildSession,
	type ChildSessionCreateOptions,
	copyRegisteredProviders,
	createInProcessResourceLoader,
	createSdkChildSession,
	InProcessTransport,
	resolveChildModel,
	seedChildSessionManager,
	validateInProcessTools,
} from "../src/in-process-transport.js";
import type { ManagedAgent } from "../src/registry.js";
import { registerStatefulSubagents } from "../src/stateful.js";
import { type IsolatedWorkspace, WorkspaceManager } from "../src/workspace.js";

function managedAgent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
	return {
		id: "sa_test",
		agent: "scout",
		rootId: "sa_test",
		depth: 0,
		children: [],
		state: "running",
		createdAt: 1,
		updatedAt: 1,
		cwd: process.cwd(),
		history: [],
		mailbox: [],
		...overrides,
	};
}

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "scout",
		description: "test scout",
		tools: ["read"],
		systemPrompt: "Scout safely.",
		source: "built-in",
		filePath: "built-in:scout",
		...overrides,
	};
}

interface TestAuthStorage {
	setRuntimeApiKey(provider: string, apiKey: string): void;
}

interface TestCodingAgentModule {
	AuthStorage?: { inMemory(): TestAuthStorage };
	ModelRegistry: {
		new (runtime: unknown): ModelRegistry;
		inMemory?(auth: TestAuthStorage): ModelRegistry;
	};
	ModelRuntime?: {
		create(options: { authPath: string; modelsPath: null }): Promise<unknown>;
	};
}

async function createTestModelRegistry(): Promise<{
	modelRegistry: ModelRegistry;
	dispose(): void;
}> {
	const agentDir = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-model-runtime-"));
	try {
		const codingAgentModule = (await import(
			"@earendil-works/pi-coding-agent"
		)) as unknown as TestCodingAgentModule;
		if (codingAgentModule.ModelRuntime) {
			const runtime = await codingAgentModule.ModelRuntime.create({
				authPath: path.join(agentDir, "auth.json"),
				modelsPath: null,
			});
			return {
				modelRegistry: new codingAgentModule.ModelRegistry(runtime),
				dispose: () => rmSync(agentDir, { recursive: true, force: true }),
			};
		}
		if (!codingAgentModule.AuthStorage || !codingAgentModule.ModelRegistry.inMemory) {
			throw new Error("Pi SDK does not expose a compatible model registry factory");
		}
		const auth = codingAgentModule.AuthStorage.inMemory();
		auth.setRuntimeApiKey("child-smoke", "test-key");
		return {
			modelRegistry: codingAgentModule.ModelRegistry.inMemory(auth),
			dispose: () => rmSync(agentDir, { recursive: true, force: true }),
		};
	} catch (error) {
		rmSync(agentDir, { recursive: true, force: true });
		throw error;
	}
}

class FakeWorkspaceManager extends WorkspaceManager {
	override async create(_ownerId: string, cwd: string): Promise<IsolatedWorkspace> {
		return {
			mode: "worktree",
			path: cwd,
			rootPath: cwd,
			repositoryRoot: cwd,
		};
	}

	override async cleanup(_ownerId: string): Promise<void> {}

	override async cleanupAll(): Promise<void> {}
}

class FakeChildSession implements ChildSession {
	readonly sessionId = "child-session";
	readonly prompts: string[] = [];
	readonly messages: Array<Record<string, unknown>> = [];
	aborts = 0;
	disposals = 0;
	private listeners = new Set<(event: unknown) => void>();
	private remainingAbortWaits: number;

	constructor(waitForAbort: boolean | number = false) {
		this.remainingAbortWaits =
			typeof waitForAbort === "number" ? waitForAbort : waitForAbort ? Infinity : 0;
	}

	waitForNextAbort(): void {
		if (Number.isFinite(this.remainingAbortWaits)) this.remainingAbortWaits++;
	}

	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		const waitForAbort = this.remainingAbortWaits > 0;
		if (Number.isFinite(this.remainingAbortWaits)) this.remainingAbortWaits--;
		if (waitForAbort) {
			await new Promise<void>((resolve) => {
				const listener = (event: unknown) => {
					if ((event as { type?: string }).type === "aborted") resolve();
				};
				this.listeners.add(listener);
			});
		}
		this.messages.push({ role: "user", content: text });
		const assistant = {
			role: "assistant",
			content: [{ type: "text", text: `done:${text}` }],
			stopReason: waitForAbort ? "aborted" : "stop",
		};
		this.messages.push(assistant);
		for (const listener of this.listeners) listener({ type: "message_update", message: assistant });
	}

	subscribe(listener: (event: unknown) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async abort(): Promise<void> {
		this.aborts++;
		for (const listener of this.listeners) listener({ type: "aborted" });
	}

	dispose(): void {
		this.disposals++;
		this.listeners.clear();
	}

	getActiveToolNames(): string[] {
		return ["read"];
	}
}

class DelayedAbortChildSession extends FakeChildSession {
	override async abort(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 30));
		await super.abort();
	}
}

function transportWithFactory(
	factory: (options: ChildSessionCreateOptions) => Promise<ChildSession>,
	options: { timeoutMs?: number } = {},
) {
	return new InProcessTransport({
		modelRegistry: {} as never,
		getParentRuntime: () => ({ model: undefined, thinkingLevel: "off" }),
		createSession: factory,
		discoverAgent: () => agentConfig(),
		defaultTimeoutMs: options.timeoutMs ?? 1_000,
		abortGraceMs: 50,
	});
}

test("InProcessTransport reuses one child session and sends only each current task", async () => {
	const created: ChildSessionCreateOptions[] = [];
	const child = new FakeChildSession();
	const transport = transportWithFactory(async (options) => {
		created.push(options);
		return child;
	});
	const agent = managedAgent({
		thinkingLevel: "high",
		context: "parent context",
		history: [
			{ task: "old task", output: "old output", startedAt: 1, completedAt: 2, exitCode: 0 },
		],
	});

	const first = await transport.runTurn(agent, "first", new AbortController().signal);
	const second = await transport.runTurn(agent, "second", new AbortController().signal);

	assert.equal(created.length, 1);
	assert.equal(created[0].context, "parent context");
	assert.deepEqual(
		created[0].history.map((turn) => [turn.task, turn.output]),
		[["old task", "old output"]],
	);
	assert.deepEqual(child.prompts, ["first", "second"]);
	assert.equal(first.output, "done:first");
	assert.deepEqual(first.policy?.overridden, ["thinkingLevel", "tools"]);
	assert.equal(second.output, "done:second");
	await transport.shutdown();
	assert.equal(child.disposals, 1);
});

test("InProcessTransport does not report stale output when a follow-up fails before replying", async () => {
	class FailingFollowUpSession extends FakeChildSession {
		override async prompt(text: string): Promise<void> {
			if (text === "second") {
				this.prompts.push(text);
				throw new Error("provider failed");
			}
			await super.prompt(text);
		}
	}
	const child = new FailingFollowUpSession();
	const transport = transportWithFactory(async () => child);
	const agent = managedAgent();
	assert.equal(
		(await transport.runTurn(agent, "first", new AbortController().signal)).output,
		"done:first",
	);
	const failed = await transport.runTurn(agent, "second", new AbortController().signal);
	assert.equal(failed.output, "");
	assert.equal(failed.exitCode, 1);
	assert.match(failed.error ?? "", /provider failed/);
	await transport.shutdown();
});

test("InProcessTransport disposes a child when event subscription fails during creation", async () => {
	class SubscriptionFailureSession extends FakeChildSession {
		override subscribe(): () => void {
			throw new Error("subscribe failed");
		}
	}
	const child = new SubscriptionFailureSession();
	const transport = transportWithFactory(async () => child);
	const result = await transport.runTurn(managedAgent(), "task", new AbortController().signal);
	assert.equal(result.exitCode, 1);
	assert.match(result.error ?? "", /subscribe failed/);
	assert.equal(child.disposals, 1);
	assert.deepEqual(child.prompts, []);
});

test("InProcessTransport times out by aborting, remains releasable, and disposes exactly once", async () => {
	const child = new FakeChildSession(true);
	const transport = transportWithFactory(async () => child, { timeoutMs: 5 });
	const agent = managedAgent();

	const result = await transport.runTurn(agent, "slow", new AbortController().signal);
	assert.equal(result.exitCode, 124);
	assert.equal(result.aborted, undefined);
	assert.match(result.error ?? "", /timed out/);
	assert.equal(child.aborts, 1);

	await transport.release?.(agent);
	await transport.release?.(agent);
	await transport.shutdown();
	assert.equal(child.disposals, 1);
});

test("InProcessTransport discards a child that does not settle after timeout abort", async () => {
	class StuckChildSession extends FakeChildSession {
		override async prompt(text: string): Promise<void> {
			this.prompts.push(text);
			await new Promise<void>(() => undefined);
		}
		override async abort(): Promise<void> {
			this.aborts++;
		}
	}
	const stuck = new StuckChildSession();
	const replacement = new FakeChildSession();
	let creations = 0;
	const transport = new InProcessTransport({
		modelRegistry: {} as never,
		getParentRuntime: () => ({ model: undefined, thinkingLevel: "off" }),
		createSession: async () => (++creations === 1 ? stuck : replacement),
		discoverAgent: () => agentConfig(),
		defaultTimeoutMs: 5,
		abortGraceMs: 5,
	});
	const agent = managedAgent();
	assert.equal(
		(await transport.runTurn(agent, "stuck", new AbortController().signal)).exitCode,
		124,
	);
	assert.equal(stuck.disposals, 1);
	assert.equal(
		(await transport.runTurn(agent, "retry", new AbortController().signal)).output,
		"done:retry",
	);
	assert.equal(creations, 2);
	await transport.shutdown();
});

test("InProcessTransport still disposes when subscription cleanup throws", async () => {
	class ThrowingUnsubscribeSession extends FakeChildSession {
		override subscribe(listener: (event: unknown) => void): () => void {
			const unsubscribe = super.subscribe(listener);
			return () => {
				unsubscribe();
				throw new Error("unsubscribe failed");
			};
		}
	}
	const child = new ThrowingUnsubscribeSession();
	const transport = transportWithFactory(async () => child);
	const agent = managedAgent();
	await transport.runTurn(agent, "task", new AbortController().signal);
	await assert.rejects(() => transport.release?.(agent), /unsubscribe failed/);
	assert.equal(child.disposals, 1);
});

test("InProcessTransport shutdown attempts every child disposal when one throws", async () => {
	class ThrowingDisposeSession extends FakeChildSession {
		override dispose(): void {
			super.dispose();
			throw new Error("dispose failed");
		}
	}
	const throwing = new ThrowingDisposeSession();
	const healthy = new FakeChildSession();
	let creations = 0;
	const transport = transportWithFactory(async () => (++creations === 1 ? throwing : healthy));
	await transport.runTurn(managedAgent({ id: "first" }), "one", new AbortController().signal);
	await transport.runTurn(managedAgent({ id: "second" }), "two", new AbortController().signal);
	await assert.rejects(() => transport.shutdown(), /Failed to dispose 1/);
	assert.equal(throwing.disposals, 1);
	assert.equal(healthy.disposals, 1);
});

test("InProcessTransport does not start a prompt when abort wins child creation", async () => {
	const child = new FakeChildSession();
	let finishCreation: ((session: ChildSession) => void) | undefined;
	const transport = transportWithFactory(
		() =>
			new Promise<ChildSession>((resolve) => {
				finishCreation = resolve;
			}),
	);
	const controller = new AbortController();
	const running = transport.runTurn(managedAgent(), "must not start", controller.signal);
	controller.abort();
	finishCreation?.(child);
	const result = await running;
	assert.equal(result.exitCode, 130);
	assert.deepEqual(child.prompts, []);
	await transport.shutdown();
	assert.equal(child.disposals, 1);
});

test("InProcessTransport maps parent abort to an interrupted outcome and reuses a settled child", async () => {
	const child = new FakeChildSession(1);
	const transport = transportWithFactory(async () => child);
	const controller = new AbortController();
	const running = transport.runTurn(managedAgent(), "slow", controller.signal);
	setTimeout(() => controller.abort(), 5);
	const result = await running;
	assert.equal(result.exitCode, 130);
	assert.equal(result.aborted, true);
	assert.equal(child.aborts, 1);
	const followUp = await transport.runTurn(
		managedAgent(),
		"recovered",
		new AbortController().signal,
	);
	assert.equal(followUp.output, "done:recovered");
	await transport.shutdown();
});

test("in-process tool validation rejects unavailable extension tools without widening", () => {
	assert.deepEqual(validateInProcessTools(undefined), undefined);
	assert.deepEqual(validateInProcessTools([]), []);
	assert.deepEqual(validateInProcessTools(["read", "grep", "read"]), ["read", "grep"]);
	assert.throws(
		() => validateInProcessTools(["read", "custom_tool"]),
		/in-process.*custom_tool.*subprocess/i,
	);
});

test("registered providers copy config and native definitions into child runtimes", () => {
	const config = { baseUrl: "https://config.example" };
	const nativeProvider = { id: "native-provider" };
	const configRegistrations: Array<[string, unknown]> = [];
	const nativeRegistrations: unknown[] = [];
	const parentRegistry = {
		getRegisteredProviderIds: () => ["config-provider", "native-provider"],
		getRegisteredProviderConfig: (provider: string) =>
			provider === "config-provider" ? config : undefined,
		getRegisteredNativeProvider: (provider: string) =>
			provider === "native-provider" ? nativeProvider : undefined,
	};
	const childRuntime = {
		registerProvider: (provider: string, providerConfig: unknown) => {
			configRegistrations.push([provider, providerConfig]);
		},
		registerNativeProvider: (provider: unknown) => {
			nativeRegistrations.push(provider);
		},
	};

	copyRegisteredProviders(parentRegistry as never, childRuntime as never);

	assert.deepEqual(configRegistrations, [["config-provider", config]]);
	assert.deepEqual(nativeRegistrations, [nativeProvider]);
});

test("InProcessTransport normalizes unsupported tools without creating a child", async () => {
	let creations = 0;
	const transport = new InProcessTransport({
		modelRegistry: {} as never,
		getParentRuntime: () => ({ model: undefined, thinkingLevel: "off" }),
		createSession: async () => {
			creations++;
			return new FakeChildSession();
		},
		discoverAgent: () => agentConfig({ tools: ["read", "custom_tool"] }),
	});
	const result = await transport.runTurn(managedAgent(), "task", new AbortController().signal);
	assert.equal(result.exitCode, 1);
	assert.match(result.error ?? "", /custom_tool.*subprocess/i);
	assert.equal(creations, 0);
});

test("child session seeding preserves parent context and prior user/assistant boundaries", () => {
	const manager = SessionManager.inMemory(process.cwd());
	const options = {
		agent: managedAgent(),
		agentConfig: agentConfig(),
		context: "parent context",
		history: [
			{ task: "old task", output: "old output", startedAt: 1, completedAt: 2, exitCode: 0 },
		],
		modelRegistry: {} as never,
		parentRuntime: { model: undefined, thinkingLevel: "off" as const },
		tools: ["read"],
	};
	seedChildSessionManager(manager, options, {
		api: "openai-completions",
		provider: "test",
		id: "test-model",
	} as never);
	const messages = manager.buildSessionContext().messages as Array<{
		role: string;
		content: unknown;
	}>;
	assert.deepEqual(
		messages.map((message) => message.role),
		["user", "user", "assistant"],
	);
	assert.match(String(messages[0].content), /parent context/);
	assert.equal(messages[1].content, "old task");
	assert.deepEqual(messages[2].content, [{ type: "text", text: "old output" }]);
	assert.deepEqual(
		manager.getBranch().map((entry) => entry.type),
		["message", "message", "message"],
	);
});

test("child resource loader excludes extensions while retaining the agent prompt", async () => {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-sdk-cwd-"));
	const agentDir = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-sdk-agent-"));
	writeFileSync(path.join(cwd, "AGENTS.md"), "Trusted child context.");
	const { loader, settingsManager } = await createInProcessResourceLoader(
		cwd,
		agentDir,
		"Agent role prompt.",
		true,
	);
	assert.equal(settingsManager.isProjectTrusted(), true);
	assert.deepEqual(loader.getExtensions().extensions, []);
	assert.deepEqual(loader.getAppendSystemPrompt(), ["Agent role prompt."]);
	assert.equal(loader.getAgentsFiles().agentsFiles.at(-1)?.content, "Trusted child context.");
});

test("registered detached spawn auto-resumes without exposing a wait tool", async () => {
	const originalDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-sdk-tools-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(
		path.join(agentDir, "pi-subagents.json"),
		JSON.stringify({
			stateful: {
				transport: "in-process",
				completionDelivery: "auto-resume",
				persistence: false,
			},
		}),
	);
	try {
		const child = new FakeChildSession();
		const created: ChildSessionCreateOptions[] = [];
		const mock = createMockPi();
		registerStatefulSubagents(mock.pi, {
			createInProcessSession: async (options) => {
				created.push(options);
				return child;
			},
		});
		assert.equal(
			mock.tools.some((tool) => tool.name === "subagent_wait"),
			false,
		);
		const initialModel = { id: "initial" };
		const selectedModel = { id: "selected" };
		let rootIdle = false;
		const context = createMockContext({ model: initialModel, isIdle: () => rootIdle });
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		mock.events.get("model_select")?.[0]?.({ model: selectedModel }, context.ctx);
		mock.events.get("thinking_level_select")?.[0]?.({ level: "max" }, context.ctx);
		const execute = async (name: string, params: Record<string, unknown>) => {
			const tool = mock.tools.find((candidate) => candidate.name === name) as {
				execute: (...args: unknown[]) => Promise<unknown>;
			};
			return tool.execute(
				"call",
				params,
				new AbortController().signal,
				undefined,
				context.ctx,
			) as Promise<{
				content: Array<{ text: string }>;
				details: {
					agent: { id: string; state: string; thinkingLevel?: string };
					agents?: Array<{ id: string; thinkingLevel?: string }>;
				};
			}>;
		};
		const waitForCompletionCount = async (expected: number) => {
			for (let attempt = 0; attempt < 50 && mock.sentMessages.length < expected; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 2));
			}
			assert.equal(mock.sentMessages.length, expected);
		};

		child.waitForNextAbort();
		const spawned = await execute("subagent_spawn", {
			agent: "scout",
			task: "first",
			thinkingLevel: "high",
		});
		const agentId = spawned.details.agent.id;
		assert.match(spawned.details.agent.state, /starting|running/);
		assert.equal(spawned.details.agent.thinkingLevel, "high");
		assert.match(spawned.content[0]?.text ?? "", /useful non-overlapping work immediately/i);
		assert.match(spawned.content[0]?.text ?? "", /end the response/i);
		assert.match(spawned.content[0]?.text ?? "", /do not poll/i);
		assert.deepEqual(child.prompts, ["first"]);
		assert.equal(created[0].agent.thinkingLevel, "high");
		const listedAfterSpawn = await execute("subagent_list", {});
		assert.equal(
			listedAfterSpawn.details.agents?.find((agent) => agent.id === agentId)?.thinkingLevel,
			"high",
		);
		await execute("subagent_interrupt", { agentId });
		await new Promise((resolve) => setTimeout(resolve, 15));
		assert.equal(mock.sentMessages.length, 0, "active root completion waits for settlement");
		rootIdle = true;
		mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
		await waitForCompletionCount(1);
		mock.events.get("agent_start")?.[0]?.({}, context.ctx);

		await execute("subagent_send", { agentId, task: "second" });
		await waitForCompletionCount(2);
		mock.events.get("agent_start")?.[0]?.({}, context.ctx);

		child.waitForNextAbort();
		await execute("subagent_send", { agentId, task: "interrupt me" });
		await execute("subagent_interrupt", { agentId });
		await waitForCompletionCount(3);
		mock.events.get("agent_start")?.[0]?.({}, context.ctx);

		await execute("subagent_send", { agentId, task: "recovered" });
		await waitForCompletionCount(4);
		await execute("subagent_close", { agentId });

		assert.deepEqual(child.prompts, ["first", "second", "interrupt me", "recovered"]);
		assert.equal(created.length, 1);
		assert.equal(created[0].parentRuntime.model, selectedModel);
		assert.equal(created[0].parentRuntime.thinkingLevel, "max");
		assert.equal(child.disposals, 1);
		for (const entry of mock.sentMessages) {
			const delivered = entry as {
				message: { customType: string; content: string };
				options: { deliverAs: string; triggerTurn: boolean };
			};
			assert.equal(delivered.message.customType, "pi-subagent-completion");
			assert.match(delivered.message.content, /Message Type: SUBAGENT_COMPLETION/);
			assert.deepEqual(delivered.options, { deliverAs: "steer", triggerTurn: true });
		}
		assert.match(
			String((mock.sentMessages[0] as { message: { content: string } }).message.content),
			/Payload:\ndone:first/,
		);
		assert.equal(mock.sentUserMessages.length, 0, "completion uses a custom message wake");
		await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
	} finally {
		if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalDir;
	}
});

test("session shutdown closes completion delivery before delayed isolated-agent cleanup", async () => {
	const originalDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-shutdown-delivery-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(
		path.join(agentDir, "pi-subagents.json"),
		JSON.stringify({
			stateful: {
				transport: "in-process",
				completionDelivery: "auto-resume",
			},
		}),
	);
	try {
		const completedChild = new FakeChildSession();
		const activeChild = new DelayedAbortChildSession();
		activeChild.waitForNextAbort();
		let childIndex = 0;
		const mock = createMockPi();
		registerStatefulSubagents(mock.pi, {
			createInProcessSession: async () => (childIndex++ === 0 ? completedChild : activeChild),
			workspaceManager: new FakeWorkspaceManager(),
		});
		const context = createMockContext({ isIdle: () => true });
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		const execute = async (name: string, params: Record<string, unknown>) => {
			const tool = mock.tools.find((candidate) => candidate.name === name) as {
				execute: (...args: unknown[]) => Promise<unknown>;
			};
			return tool.execute(
				"call",
				params,
				new AbortController().signal,
				undefined,
				context.ctx,
			) as Promise<{
				details: {
					agent?: { id: string };
					agents?: Array<{ id: string; state: string }>;
				};
			}>;
		};
		const first = await execute("subagent_spawn", {
			agent: "scout",
			task: "complete before shutdown",
			workspaceMode: "worktree",
		});
		const second = await execute("subagent_spawn", {
			agent: "scout",
			task: "delay shutdown cleanup",
			workspaceMode: "worktree",
		});
		for (let attempt = 0; attempt < 50; attempt++) {
			await Promise.resolve();
			const listed = await execute("subagent_list", {});
			const firstState = listed.details.agents?.find(
				(agent) => agent.id === first.details.agent?.id,
			)?.state;
			const secondState = listed.details.agents?.find(
				(agent) => agent.id === second.details.agent?.id,
			)?.state;
			if (firstState === "completed" && secondState === "running") break;
		}
		const listed = await execute("subagent_list", {});
		assert.equal(
			listed.details.agents?.find((agent) => agent.id === first.details.agent?.id)?.state,
			"completed",
		);
		assert.equal(
			listed.details.agents?.find((agent) => agent.id === second.details.agent?.id)?.state,
			"running",
		);
		assert.equal(mock.sentMessages.length, 0, "completion timer has not fired yet");

		await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(mock.sentMessages.length, 0, "shutdown must suppress the queued root wake");
	} finally {
		if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalDir;
	}
});

test("public SDK child-session adapter completes a deterministic in-memory turn and disposes", async (t) => {
	const fixture = await createTestModelRegistry();
	t.after(fixture.dispose);
	const { modelRegistry } = fixture;
	modelRegistry.registerProvider("child-smoke", {
		api: "openai-completions",
		apiKey: "test-key",
		baseUrl: "http://127.0.0.1/unused",
		streamSimple: (model) => {
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "sdk child ok" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 1,
					output: 3,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 4,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
			return stream;
		},
		models: [
			{
				id: "child-model",
				name: "Child Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8_192,
				maxTokens: 1_024,
			},
		],
	});
	const model = modelRegistry.find("child-smoke", "child-model");
	assert.ok(model);
	const inherited = await resolveChildModel({
		agent: managedAgent(),
		agentConfig: agentConfig({ model: undefined }),
		history: [],
		modelRegistry,
		parentRuntime: { model, thinkingLevel: "medium" },
	});
	assert.equal(inherited.model, model);
	assert.equal(inherited.thinkingLevel, "medium");
	const explicit = await resolveChildModel({
		agent: managedAgent(),
		agentConfig: agentConfig({ model: "child-smoke/child-model:max", thinkingLevel: undefined }),
		history: [],
		modelRegistry,
		parentRuntime: { model: undefined, thinkingLevel: "off" },
	});
	assert.equal(explicit.model.provider, model.provider);
	assert.equal(explicit.model.id, model.id);
	assert.equal(explicit.thinkingLevel, "max");
	const agentDefault = await resolveChildModel({
		agent: managedAgent(),
		agentConfig: agentConfig({
			model: "child-smoke/child-model:max",
			thinkingLevel: "high",
		}),
		history: [],
		modelRegistry,
		parentRuntime: { model: undefined, thinkingLevel: "medium" },
	});
	assert.equal(agentDefault.thinkingLevel, "high");
	const spawnOverride = await resolveChildModel({
		agent: managedAgent({ thinkingLevel: "low" }),
		agentConfig: agentConfig({
			model: "child-smoke/child-model:max",
			thinkingLevel: "high",
		}),
		history: [],
		modelRegistry,
		parentRuntime: { model: undefined, thinkingLevel: "medium" },
	});
	assert.equal(spawnOverride.thinkingLevel, "low");
	const childCwd = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-sdk-turn-"));
	const child = await createSdkChildSession({
		agent: managedAgent({ cwd: childCwd }),
		agentConfig: agentConfig({ tools: [] }),
		history: [],
		modelRegistry,
		parentRuntime: { model, thinkingLevel: "off" },
		tools: [],
	});
	const sessionId = child.sessionId;
	await child.prompt("reply deterministically");
	await child.prompt("reply deterministically again");
	assert.equal(child.sessionId, sessionId);
	assert.equal(
		(child.messages.at(-1) as { content: Array<{ text: string }> }).content[0].text,
		"sdk child ok",
	);
	assert.equal(
		child.messages.filter((message) => (message as { role?: string }).role === "assistant").length,
		2,
	);
	child.dispose();
	assert.deepEqual(readdirSync(childCwd), []);
});
