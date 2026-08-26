import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { registerStatefulSubagents } from "../src/stateful.js";
import { resolveStatefulLimits } from "../src/stateful-limits.js";

test("stateful tools are available by default, disable cleanly, and expose the lifecycle surface", async () => {
	const originalDir = process.env.PI_CODING_AGENT_DIR;
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-config-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const mock = createMockPi({ activeTools: ["read"] });
		const controller = registerStatefulSubagents(mock.pi);
		assert.deepEqual(controller.getRuntimeStatus(), {
			enabled: true,
			initialized: false,
			transport: "subprocess",
			completionDelivery: "next-turn",
			limits: resolveStatefulLimits(),
			activeAgents: 0,
			retainedAgents: 0,
		});
		assert.deepEqual(controller.listAgents(), []);
		assert.equal(await controller.clearAgents(), 0);
		assert.deepEqual(
			mock.tools.map((tool) => tool.name),
			["subagent_spawn", "subagent_send", "subagent_await", "subagent_manage", "subagent_mailbox"],
		);
		assert.equal(
			mock.tools.some((tool) =>
				[
					"subagent_message",
					"subagent_messages",
					"subagent_list",
					"subagent_interrupt",
					"subagent_close",
				].includes(String(tool.name)),
			),
			false,
		);
		assert.equal(mock.commands.has("subagents:agents"), false);
		const context = createMockContext();
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		assert.deepEqual(controller.getRuntimeStatus(), {
			enabled: true,
			initialized: true,
			transport: "subprocess",
			completionDelivery: "next-turn",
			limits: resolveStatefulLimits(),
			activeAgents: 0,
			retainedAgents: 0,
		});
		const spawn = mock.tools.find((tool) => tool.name === "subagent_spawn") as unknown as {
			name: string;
			description: string;
			promptGuidelines: string[];
			parameters: {
				properties?: Record<string, { description?: string; maximum?: number; enum?: string[] }>;
			};
		};
		const spawnRegistrations = () =>
			mock.tools.filter((tool) => tool.name === "subagent_spawn") as (typeof spawn)[];
		assert.equal(spawnRegistrations().length, 1);
		const providerVisibleDefinition = {
			description: spawn.description,
			parameters: spawn.parameters,
			promptGuidelines: spawn.promptGuidelines,
		};
		assert.match(spawn.description, /session-guidance message/i);
		assert.match(spawn.promptGuidelines.join("\n"), /next-turn.*auto-resume/i);
		for (const guideline of spawn.promptGuidelines) assert.match(guideline, /subagent_spawn/);
		controller.setCompletionDelivery("auto-resume");
		controller.setCompletionDelivery("next-turn");
		assert.equal(spawnRegistrations().length, 1);
		assert.deepEqual(
			{
				description: spawn.description,
				parameters: spawn.parameters,
				promptGuidelines: spawn.promptGuidelines,
			},
			providerVisibleDefinition,
		);
		assert.equal(spawn.name, "subagent_spawn");
		assert.match(spawn.parameters.properties?.timeoutMs?.description ?? "", /work deadline/i);
		assert.match(spawn.parameters.properties?.idleTimeoutMs?.description ?? "", /completed/i);
		assert.match(spawn.parameters.properties?.maxTurns?.description ?? "", /assistant turns/i);
		assert.match(spawn.parameters.properties?.maxTurns?.description ?? "", /omit.*tight bound/i);
		assert.match(spawn.parameters.properties?.maxToolCalls?.description ?? "", /tool calls/i);
		assert.match(
			spawn.parameters.properties?.maxToolCalls?.description ?? "",
			/omit.*tight bound/i,
		);
		assert.match(
			spawn.parameters.properties?.allowConcurrentWrites?.description ?? "",
			/deprecated compatibility field.*allowed by default/i,
		);
		assert.match(
			spawn.parameters.properties?.workspaceMode?.description ?? "",
			/shared workspace \(default\).*worktree/i,
		);
		assert.match(spawn.promptGuidelines.join("\n"), /timeoutMs.*task difficulty/i);
		assert.match(
			spawn.promptGuidelines.join("\n"),
			/shared workspaces permit concurrent writes by default.*workspaceMode worktree/i,
		);

		const send = mock.tools.find((tool) => tool.name === "subagent_send") as {
			description: string;
			promptSnippet?: string;
			parameters: {
				properties?: Record<string, { description?: string; maximum?: number; enum?: string[] }>;
			};
		};
		assert.match(
			send.parameters.properties?.timeoutMs?.description ?? "",
			/work deadline.*follow-up/i,
		);
		assert.match(send.parameters.properties?.idleTimeoutMs?.description ?? "", /completed/i);
		assert.match(send.parameters.properties?.maxTurns?.description ?? "", /assistant turns/i);
		assert.match(send.parameters.properties?.maxToolCalls?.description ?? "", /tool calls/i);
		assert.match(
			send.parameters.properties?.revalidate?.description ?? "",
			/semantic resource snapshot/i,
		);
		assert.deepEqual(send.parameters.properties?.completionRequirement?.enum, [
			"background",
			"required",
		]);
		assert.match(
			send.parameters.properties?.allowConcurrentWrites?.description ?? "",
			/deprecated compatibility field.*allowed by default/i,
		);
		const awaitTool = mock.tools.find((tool) => tool.name === "subagent_await") as {
			description: string;
			promptGuidelines?: string[];
			parameters: {
				required?: string[];
				properties?: Record<string, { description?: string; maximum?: number; minimum?: number }>;
			};
		};
		assert.match(awaitTool.description, /blocks Pi.*queued steering/i);
		assert.match(awaitTool.description, /timeout.*never interrupts or closes/i);
		assert.deepEqual(awaitTool.parameters.required, ["agentId"]);
		assert.equal(awaitTool.parameters.properties?.timeoutMs?.minimum, 1);
		assert.equal(awaitTool.parameters.properties?.timeoutMs?.maximum, 2_147_483_647);
		assert.match(
			awaitTool.parameters.properties?.timeoutMs?.description ?? "",
			/defaults to 30000/i,
		);
		assert.match(awaitTool.promptGuidelines?.join("\n") ?? "", /required.*blocking.*intentional/i);
		assert.match(awaitTool.promptGuidelines?.join("\n") ?? "", /do not repeatedly call/i);
		const manage = mock.tools.find((tool) => tool.name === "subagent_manage") as {
			description: string;
			parameters: { properties?: Record<string, { description?: string; enum?: string[] }> };
			execute: (...args: unknown[]) => Promise<{
				content: Array<{ text: string }>;
				details: Record<string, unknown>;
			}>;
		};
		const mailbox = mock.tools.find((tool) => tool.name === "subagent_mailbox") as {
			description: string;
			parameters: {
				required?: string[];
				properties?: Record<
					string,
					{
						description?: string;
						enum?: string[];
						maximum?: number;
						maxLength?: number;
						minimum?: number;
					}
				>;
			};
			execute: (...args: unknown[]) => Promise<unknown>;
		};
		assert.match(send.description, /follow-up.*start.*turn/i);
		assert.match(send.description, /subagent_mailbox.*queue-only/i);
		assert.doesNotMatch(manage.description, /list retained/i);
		assert.match(manage.description, /interrupt.*close/i);
		assert.deepEqual(manage.parameters.properties?.action?.enum, ["interrupt", "close"]);
		assert.match(manage.parameters.properties?.action?.description ?? "", /interrupt.*close/i);
		assert.match(mailbox.description, /without starting a turn.*read/i);
		assert.deepEqual(mailbox.parameters.properties?.action?.enum, ["send", "read"]);
		assert.match(mailbox.parameters.properties?.action?.description ?? "", /send.*read/i);
		assert.deepEqual(mailbox.parameters.required?.sort(), ["action", "agentId"]);
		assert.equal(mailbox.parameters.properties?.message?.maxLength, 16 * 1024);
		assert.equal(mailbox.parameters.properties?.limit?.minimum, 1);
		assert.equal(mailbox.parameters.properties?.limit?.maximum, 20);
		await assert.rejects(
			() => manage.execute("id", { action: "list" }, undefined, undefined, context.ctx),
			/use subagent_inspect/i,
		);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read"]);
		await assert.rejects(
			() => manage.execute("id", { action: "interrupt" }, undefined, undefined, context.ctx),
			/subagent_manage action "interrupt" requires agentId/,
		);
		await assert.rejects(
			() =>
				manage.execute(
					"id",
					{ action: "list", unexpected: true },
					undefined,
					undefined,
					context.ctx,
				),
			/subagent_manage does not accept unexpected/,
		);
		await assert.rejects(
			() => manage.execute("id", { action: 1 }, undefined, undefined, context.ctx),
			/subagent_manage action must be one of/,
		);
		await assert.rejects(
			() =>
				manage.execute(
					"id",
					{ action: "interrupt", agentId: "sa_unknown", includeClosed: false },
					undefined,
					undefined,
					context.ctx,
				),
			/subagent_manage does not accept includeClosed/,
		);
		await assert.rejects(
			() =>
				manage.execute(
					"id",
					{
						action: "interrupt",
						agentId: "sa_unknown",
						subtree: false,
					},
					undefined,
					undefined,
					context.ctx,
				),
			/Unknown subagent/,
		);
		await assert.rejects(
			() =>
				manage.execute("id", { action: "close", agentId: 1 }, undefined, undefined, context.ctx),
			/subagent_manage action "close" requires agentId to be a non-empty string/,
		);
		await assert.rejects(
			() =>
				mailbox.execute(
					"id",
					{ action: "send", agentId: "sa_unknown" },
					undefined,
					undefined,
					context.ctx,
				),
			/subagent_mailbox action "send" requires message/,
		);
		await assert.rejects(
			() =>
				mailbox.execute(
					"id",
					{
						action: "read",
						agentId: "sa_unknown",
						message: "provider default",
						senderId: "provider default",
						deduplicationKey: "provider-default",
						acknowledge: true,
						limit: 20,
					},
					undefined,
					undefined,
					context.ctx,
				),
			/Unknown subagent/,
		);
		await assert.rejects(
			() =>
				mailbox.execute(
					"id",
					{ action: "read", agentId: "sa_unknown", unexpected: true },
					undefined,
					undefined,
					context.ctx,
				),
			/subagent_mailbox does not accept unexpected/,
		);
		await assert.rejects(
			() =>
				mailbox.execute(
					"id",
					{
						action: "send",
						agentId: "sa_unknown",
						message: "ok",
						acknowledge: true,
						limit: 20,
					},
					undefined,
					undefined,
					context.ctx,
				),
			/Unknown subagent/,
		);
		await assert.rejects(
			() =>
				mailbox.execute(
					"id",
					{ action: "send", agentId: "sa_unknown", message: "x".repeat(16 * 1024 + 1) },
					undefined,
					undefined,
					context.ctx,
				),
			/subagent_mailbox action "send" requires message at most 16384 characters/,
		);
		await assert.rejects(
			() => mailbox.execute("id", { action: "archive" }, undefined, undefined, context.ctx),
			/subagent_mailbox action must be one of/,
		);
		await assert.rejects(
			() =>
				mailbox.execute(
					"id",
					{ action: "read", agentId: "sa_unknown", acknowledge: "yes" },
					undefined,
					undefined,
					context.ctx,
				),
			/subagent_mailbox action "read" requires acknowledge to be a boolean/,
		);
		await assert.rejects(
			() =>
				mailbox.execute(
					"id",
					{ action: "read", agentId: "sa_unknown", limit: 21 },
					undefined,
					undefined,
					context.ctx,
				),
			/subagent_mailbox action "read" requires limit between 1 and 20/,
		);
		await assert.rejects(
			() =>
				mailbox.execute(
					"id",
					{ action: "read", agentId: "sa_unknown" },
					undefined,
					undefined,
					context.ctx,
				),
			/Unknown subagent/,
		);

		const project = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-project-"));
		const projectAgents = path.join(project, ".pi", "agents");
		mkdirSync(projectAgents, { recursive: true });
		writeFileSync(
			path.join(projectAgents, "project.md"),
			"---\nname: project\ndescription: project agent\n---\nDo project work.",
		);
		new ProjectTrustStore(dir).set(project, true);
		const untrusted = createMockContext({ cwd: project, isProjectTrusted: () => false });
		const spawnTool = mock.tools.find((tool) => tool.name === "subagent_spawn") as {
			description: string;
			execute: (...args: unknown[]) => Promise<unknown>;
			parameters: {
				properties?: Record<
					string,
					{
						description?: string;
						enum?: string[];
						maxLength?: number;
						properties?: Record<string, unknown>;
					}
				>;
			};
			promptGuidelines: string[];
		};
		const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		assert.deepEqual(spawnTool.parameters.properties?.thinkingLevel?.enum, thinkingLevels);
		assert.equal(spawnTool.parameters.properties?.idempotencyKey?.maxLength, 256);
		assert.deepEqual(spawnTool.parameters.properties?.resultFormat?.enum, [
			"text",
			"structured-v1",
			"structured-v2",
		]);
		assert.deepEqual(spawnTool.parameters.properties?.completionRequirement?.enum, [
			"background",
			"required",
		]);
		assert.match(
			spawnTool.parameters.properties?.completionRequirement?.description ?? "",
			/hard pre-display.*barrier/i,
		);
		assert.ok(spawnTool.parameters.properties?.contract);
		const contractSchema = JSON.stringify(spawnTool.parameters.properties?.contract);
		assert.match(contractSchema, /ordinary delegation.*omit/i);
		assert.match(contractSchema, /readPaths.*writePaths.*network.*secrets.*unsupported/i);
		assert.match(contractSchema, /enforcement.*enforce.*reject/i);
		assert.match(
			spawnTool.parameters.properties?.thinkingLevel?.description ?? "",
			/task difficulty/i,
		);
		assert.match(spawnTool.description, /thinking level.*task difficulty/i);
		const spawnGuidance = spawnTool.promptGuidelines.join("\n");
		assert.match(spawnGuidance, /simple or critical-path work/);
		assert.match(
			spawnGuidance,
			/main agent.*planning.*critical-path.*integration.*final verification.*final answer/i,
		);
		assert.match(
			spawnGuidance,
			/before.*one.*subagent_spawn.*identify.*non-overlapping.*main-agent work.*start immediately.*integration path/i,
		);
		assert.match(spawnGuidance, /session-guidance.*next-turn.*auto-resume/i);
		assert.match(spawnGuidance, /ordinary review.*main agent.*review skill.*deterministic checks/i);
		assert.match(
			spawnGuidance,
			/detached review.*consequential independent verification.*concrete parallel value/i,
		);
		assert.doesNotMatch(spawnGuidance, /broad asynchronous research or review/i);
		assert.match(spawnGuidance, /next-turn.*current response.*does not depend/i);
		assert.match(spawnGuidance, /overlap.*subagent_await/i);
		assert.match(spawnGuidance, /completionRequirement.*required/i);
		assert.match(spawnGuidance, /deprecated subagent/i);
		assert.doesNotMatch(spawnGuidance, /even when.*final answer.*depends/i);
		assert.match(
			spawnGuidance,
			/existing caller.*explicit user request.*chain.*fan-in.*panel.*workflow/i,
		);
		assert.match(
			spawnGuidance,
			/single subagent_spawn.*bounded.*clear ownership.*beside.*main-agent work/i,
		);
		assert.match(
			spawnGuidance,
			/without concurrent main-agent work.*specialist model.*tool profile.*isolation/i,
		);
		assert.doesNotMatch(
			spawnGuidance,
			/use one blocking subagent parallel call for multiple independent one-shot tasks/i,
		);
		assert.match(spawnGuidance, /immediately continue.*identified.*local task/i);
		assert.match(
			spawnGuidance,
			/local work.*exhausted.*at most one brief progress sentence.*end the turn.*do not repeat.*requested final format.*verdict/i,
		);
		assert.match(spawnGuidance, /do not merely announce.*wait.*poll.*end/i);
		assert.doesNotMatch(spawnGuidance, /tell the user.*end the response/i);
		assert.match(spawnGuidance, /do not poll.*subagent_inspect/i);
		assert.match(spawnGuidance, /subagent_mailbox.*action.*read/i);
		assert.doesNotMatch(spawnGuidance, /subagent_(?:list|messages)/i);
		assert.match(spawnGuidance, /synthesize available.*completion/i);
		assert.match(spawnGuidance, /subagent_spawn.*lowest sufficient.*thinking level/i);
		assert.match(
			spawnGuidance,
			/subagent_spawn.*maxTurns.*maxToolCalls.*headroom.*discovery.*evidence.*final synthesis.*omit.*speculative.*tight/i,
		);
		assert.match(spawnGuidance, /ordinary subagent_spawn.*omit.*contract/i);
		assert.match(
			spawnGuidance,
			/subagent_spawn.*enforcement.*enforce.*readPaths.*writePaths.*network.*secrets.*reject/i,
		);
		assert.match(
			spawnGuidance,
			/subagent_spawn.*retry.*advisory.*required security boundary.*stop/i,
		);
		assert.match(spawnGuidance, /off.*minimal.*extraction.*mechanical/i);
		assert.match(spawnGuidance, /low.*straightforward.*bounded/i);
		assert.match(spawnGuidance, /medium.*multi-step/i);
		assert.match(spawnGuidance, /high.*debugging.*design.*review/i);
		assert.match(spawnGuidance, /xhigh.*ambiguous.*cross-system.*high-risk/i);
		assert.match(spawnGuidance, /max.*hardest.*quality.*latency.*cost/i);
		for (const guideline of spawnTool.promptGuidelines) {
			assert.match(
				guideline,
				/subagent_spawn/,
				`flattened spawn guideline must identify subagent_spawn: ${guideline}`,
			);
		}
		const originalDepth = process.env.PI_SUBAGENT_DEPTH;
		process.env.PI_SUBAGENT_DEPTH = "1";
		try {
			await assert.rejects(
				() =>
					spawnTool.execute(
						"id",
						{ agent: "explorer", task: "nested" },
						undefined,
						undefined,
						context.ctx,
					),
				/recursion depth limit/,
			);
		} finally {
			if (originalDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
			else process.env.PI_SUBAGENT_DEPTH = originalDepth;
		}
		await assert.rejects(
			() =>
				spawnTool.execute(
					"id",
					{
						agent: "project",
						task: "task",
						cwd: project,
						agentScope: "project",
						confirmProjectAgents: false,
					},
					undefined,
					undefined,
					createMockContext({ isProjectTrusted: () => true }).ctx,
				),
			/overridden cwd/,
		);
		await assert.rejects(
			() =>
				spawnTool.execute(
					"id",
					{
						agent: "project",
						task: "task",
						agentScope: "project",
						confirmProjectAgents: false,
					},
					undefined,
					undefined,
					untrusted.ctx,
				),
			/trusted project/,
		);
		await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
		assert.deepEqual(controller.getRuntimeStatus(), {
			enabled: true,
			initialized: false,
			transport: "subprocess",
			completionDelivery: "next-turn",
			limits: resolveStatefulLimits(),
			activeAgents: 0,
			retainedAgents: 0,
		});

		writeFileSync(
			path.join(dir, "pi-subagents.json"),
			JSON.stringify({ stateful: { completionDelivery: "auto-resume" } }),
		);
		const autoResume = createMockPi();
		registerStatefulSubagents(autoResume.pi);
		const autoResumeSpawn = autoResume.tools.find((tool) => tool.name === "subagent_spawn");
		assert.ok(Array.isArray(autoResumeSpawn?.promptGuidelines));
		const autoResumeGuidance = autoResumeSpawn.promptGuidelines.join("\n");
		assert.equal(autoResumeGuidance, spawnGuidance);
		assert.match(autoResumeGuidance, /next-turn.*auto-resume/i);
		assert.match(
			autoResumeGuidance,
			/every final-answer-dependent subagent_spawn.*completionRequirement.*required.*visible.*terminal/i,
		);
		assert.match(
			autoResumeGuidance,
			/do not duplicate.*assigned work.*running.*fallback.*failure.*insufficient evidence/i,
		);
		assert.match(
			autoResumeGuidance,
			/smallest named files or questions.*maxTurns.*maxToolCalls.*sufficient/i,
		);
		assert.match(
			autoResumeGuidance,
			/ordinary review.*main agent.*review skill.*deterministic checks/i,
		);
		assert.match(
			autoResumeGuidance,
			/detached review.*consequential independent verification.*concrete parallel value/i,
		);
		assert.doesNotMatch(autoResumeGuidance, /broad asynchronous research or review/i);
		assert.match(autoResumeGuidance, /immediately continue.*identified.*local task/i);
		assert.doesNotMatch(autoResumeGuidance, /tell the user.*end the response/i);
		assert.match(autoResumeGuidance, /session-guidance/i);

		writeFileSync(
			path.join(dir, "pi-subagents.json"),
			JSON.stringify({ stateful: { enabled: false } }),
		);
		const disabled = createMockPi();
		const disabledController = registerStatefulSubagents(disabled.pi);
		assert.equal(disabled.tools.length, 0);
		assert.equal(disabled.events.size, 0);
		assert.deepEqual(disabledController.getRuntimeStatus(), {
			enabled: false,
			initialized: false,
			transport: "subprocess",
			completionDelivery: "next-turn",
			limits: resolveStatefulLimits(),
			activeAgents: 0,
			retainedAgents: 0,
		});
		assert.deepEqual(disabledController.listAgents(), []);
		assert.equal(await disabledController.clearAgents(), 0);
	} finally {
		if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalDir;
	}
});
