import assert from "node:assert/strict";
import { test } from "vitest";
import {
	builtinTool,
	createMockContext,
	createMockPi,
	extensionTool,
} from "../../../test/support.js";
import planMode from "../src/plan-mode.js";
import type { ImplementationPlanRetention } from "../src/settings.js";
import { restorePlanModeState } from "../src/state.js";
import {
	capturePlanModeBranchPoint,
	PLAN_MODE_BRANCH_POINT_ENTRY_TYPE,
} from "../src/tree-implementation.js";

const PLAN = `# Clean branch plan

1. Return to the Normal-mode prefix.
2. Implement from the exact approved plan.`;
const STATE_ENTRY_TYPE = "plan-mode-state";

type TreeEntry = {
	id: string;
	parentId: string | null;
	type: "message" | "custom";
	customType?: string;
	data?: unknown;
	message?: { role: string; content?: string; toolName?: string; details?: unknown };
};

class FaithfulSessionTree {
	readonly entries: TreeEntry[] = [];
	leafId: string | null = null;
	private nextId = 1;

	constructor() {
		this.appendMessage({ role: "user", content: "A" }, "aaaaaaaa");
		this.appendMessage({ role: "assistant", content: "B" }, "bbbbbbbb");
	}

	getLeafId() {
		return this.leafId;
	}

	getEntry(id: string) {
		return this.entries.find((entry) => entry.id === id);
	}

	getEntries() {
		return [...this.entries];
	}

	getBranch(fromId = this.leafId) {
		const branch: TreeEntry[] = [];
		let id = fromId;
		while (id) {
			const entry = this.getEntry(id);
			if (!entry) break;
			branch.push(entry);
			id = entry.parentId;
		}
		return branch.reverse();
	}

	appendCustom(customType: string, data: unknown) {
		return this.append({ type: "custom", customType, data });
	}

	appendMessage(message: TreeEntry["message"], fixedId?: string) {
		return this.append({ type: "message", message }, fixedId);
	}

	branch(id: string) {
		assert.ok(this.getEntry(id), `missing branch target ${id}`);
		this.leafId = id;
	}

	private append(entry: Omit<TreeEntry, "id" | "parentId">, fixedId?: string) {
		const id = fixedId ?? this.nextEntryId();
		this.entries.push({ ...entry, id, parentId: this.leafId });
		this.leafId = id;
		return id;
	}

	private nextEntryId() {
		const id = this.nextId.toString(16).padStart(8, "0");
		this.nextId += 1;
		return id;
	}
}

function setupTreePlanMode(
	options: {
		failDelivery?: boolean;
		thinkingLevel?: string;
		retention?: ImplementationPlanRetention;
	} = {},
) {
	const tree = new FaithfulSessionTree();
	const normalTools = ["read", "write", "custom"];
	const mock = createMockPi({
		activeTools: normalTools,
		thinkingLevel: options.thinkingLevel ?? "low",
		allTools: [builtinTool("read"), builtinTool("write"), extensionTool("custom")],
	});
	const appendEntry = mock.rawPi.appendEntry.bind(mock.rawPi);
	mock.rawPi.appendEntry = (customType, data) => {
		appendEntry(customType, data);
		tree.appendCustom(customType, data);
	};
	const sendUserMessage = mock.rawPi.sendUserMessage.bind(mock.rawPi);
	mock.rawPi.sendUserMessage = (text, messageOptions) => {
		if (options.failDelivery && /previous agent produced|Plan mode is now disabled/iu.test(text)) {
			throw new Error("delivery failed");
		}
		sendUserMessage(text, messageOptions);
		tree.appendMessage({ role: "user", content: text });
	};

	let context!: ReturnType<typeof createMockContext>;
	context = createMockContext({
		mode: "rpc",
		hasUI: true,
		sessionManager: tree,
		navigateTree: async (targetId: string, navigationOptions?: { summarize?: boolean }) => {
			assert.equal(navigationOptions?.summarize, false);
			const oldLeafId = tree.getLeafId();
			tree.branch(targetId);
			await mock.events.get("session_tree")?.[0]?.(
				{ type: "session_tree", oldLeafId, newLeafId: targetId },
				context.ctx,
			);
			return { cancelled: false };
		},
	});
	planMode(mock.pi, {
		readSettings: async () => ({
			kind: "loaded" as const,
			settings: {
				thinkingLevel: options.thinkingLevel ? ("medium" as const) : ("inherit" as const),
				implementationPlanRetention: options.retention ?? ("clear-on-start" as const),
			},
		}),
	});
	return { context, mock, normalTools, tree };
}

async function completePlan(
	mock: ReturnType<typeof createMockPi>,
	tree: FaithfulSessionTree,
	ctx: unknown,
) {
	tree.appendMessage({ role: "user", content: "Plan C" });
	tree.appendMessage({ role: "assistant", content: "Research C" });
	const complete = mock.tools.find((tool) => tool.name === "plan_mode_complete")?.execute as
		| ((...args: unknown[]) => Promise<{ details?: unknown }>)
		| undefined;
	assert.ok(complete);
	const result = await complete("complete", { plan: PLAN }, undefined, undefined, ctx);
	return tree.appendMessage({
		role: "toolResult",
		toolName: "plan_mode_complete",
		details: result.details,
	});
}

function contextMessages(tree: FaithfulSessionTree) {
	return tree
		.getBranch()
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message?.content ?? entry.message?.toolName);
}

test("branch-point markers preserve empty, user, assistant, and tool-result model context", () => {
	for (const leafRole of [null, "user", "assistant", "toolResult"] as const) {
		const tree = new FaithfulSessionTree();
		tree.entries.splice(0);
		tree.leafId = null;
		if (leafRole) {
			tree.appendMessage({
				role: leafRole,
				content: leafRole === "toolResult" ? undefined : leafRole,
				toolName: leafRole === "toolResult" ? "read" : undefined,
			});
		}
		const mock = createMockPi({ activeTools: ["write", "read"] });
		const appendEntry = mock.rawPi.appendEntry.bind(mock.rawPi);
		mock.rawPi.appendEntry = (customType, data) => {
			appendEntry(customType, data);
			tree.appendCustom(customType, data);
		};
		const context = createMockContext({ sessionManager: tree });
		const messagesBefore = contextMessages(tree);
		const previousLeafId = tree.getLeafId();

		const point = capturePlanModeBranchPoint(mock.pi, context.ctx, ["write", "read"]);

		assert.ok(point);
		assert.deepEqual(point.tools, ["write", "read"]);
		const marker = tree.getEntry(point.id);
		assert.equal(marker?.type, "custom");
		assert.equal(marker?.parentId, previousLeafId);
		assert.deepEqual(contextMessages(tree), messagesBefore);
	}
});

test("the startup flag captures a context-free branch point before Plan activation", async () => {
	const { context, mock, normalTools, tree } = setupTreePlanMode();
	const flag = mock.flags.get("plan");
	assert.ok(flag);
	flag.value = true;
	await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);

	const branchPoint = tree.entries.find(
		(entry) => entry.type === "custom" && entry.customType === PLAN_MODE_BRANCH_POINT_ENTRY_TYPE,
	);
	assert.ok(branchPoint);
	const activeState = tree.entries.at(-1)?.data as {
		branchPointId?: string;
		toolsBeforePlanMode?: string[];
	};
	assert.equal(activeState.branchPointId, branchPoint.id);
	assert.deepEqual(activeState.toolsBeforePlanMode, normalTools);
	assert.deepEqual(contextMessages(tree), ["A", "B"]);
});

test("active Plan implementation returns to its branch point with the exact Normal tool order", async () => {
	const { context, mock, normalTools, tree } = setupTreePlanMode();
	await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
	await mock.commands.get("plan")?.handler("start", context.ctx);

	const branchPoint = tree.entries.find(
		(entry) => entry.type === "custom" && entry.customType === PLAN_MODE_BRANCH_POINT_ENTRY_TYPE,
	);
	assert.ok(branchPoint);
	const persistedActivation = tree.entries.find(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === STATE_ENTRY_TYPE &&
			(entry.data as { enabled?: boolean }).enabled,
	);
	assert.ok(persistedActivation);
	assert.deepEqual(
		(persistedActivation.data as { toolsBeforePlanMode?: string[] }).toolsBeforePlanMode,
		normalTools,
	);

	const planLeafId = await completePlan(mock, tree, context.ctx);
	await mock.commands.get("plan")?.handler("implement", context.ctx);

	assert.deepEqual(mock.rawPi.getActiveTools(), normalTools);
	assert.deepEqual(contextMessages(tree).slice(0, 3), [
		"A",
		"B",
		mock.sentUserMessages.at(-1)?.text,
	]);
	assert.match(mock.sentUserMessages.at(-1)?.text ?? "", /Clean branch plan/);
	assert.ok(!tree.getBranch().some((entry) => entry.id === planLeafId));
	assert.ok(tree.getEntry(planLeafId), "the disposable Plan branch remains in the session tree");
	assert.equal(
		tree.getBranch().some((entry) => entry.id === branchPoint.id),
		true,
	);

	const beforeAgentStart = mock.events.get("before_agent_start")?.[0];
	assert.ok(beforeAgentStart);
	assert.equal(
		await beforeAgentStart({ systemPrompt: "normal", prompt: "implement" }, context.ctx),
		undefined,
	);
});

test("clean tree handoff preserves each guaranteed Plan-retention policy without duplication", async () => {
	for (const retention of ["clear-after-first-run", "keep"] as const) {
		const { context, mock, tree } = setupTreePlanMode({ retention });
		await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		await completePlan(mock, tree, context.ctx);
		await mock.commands.get("plan")?.handler("implement", context.ctx);

		const handoff = mock.sentUserMessages.at(-1)?.text ?? "";
		const contextHook = mock.events.get("context")?.[0];
		assert.ok(contextHook);
		const initial = (await contextHook(
			{ messages: [{ role: "user", content: handoff }] },
			context.ctx,
		)) as { messages: unknown[] };
		assert.equal(JSON.stringify(initial.messages).split("Clean branch plan").length - 1, 1);
		assert.doesNotMatch(JSON.stringify(initial.messages), /plan-mode-implementation-context/);

		const compacted = (await contextHook(
			{ messages: [{ role: "compactionSummary", summary: "Earlier implementation context." }] },
			context.ctx,
		)) as { messages: unknown[] };
		assert.match(JSON.stringify(compacted.messages), /plan-mode-implementation-context/);
		assert.match(JSON.stringify(compacted.messages), /Clean branch plan/);

		const activeState = tree
			.getBranch()
			.filter((entry) => entry.customType === STATE_ENTRY_TYPE)
			.at(-1)?.data as { activeImplementation?: { retention?: string } };
		assert.equal(activeState.activeImplementation?.retention, retention);
		await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
		const settledState = tree
			.getBranch()
			.filter((entry) => entry.customType === STATE_ENTRY_TYPE)
			.at(-1)?.data as { activeImplementation?: { retention?: string } };
		assert.equal(
			settledState.activeImplementation?.retention,
			retention === "keep" ? "keep" : undefined,
		);
	}
});

test("manual tree navigation restores Plan and Normal runtime state symmetrically", async () => {
	const { context, mock, normalTools, tree } = setupTreePlanMode({ thinkingLevel: "low" });
	await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const planLeafId = await completePlan(mock, tree, context.ctx);
	const branchPoint = tree.entries.find(
		(entry) => entry.type === "custom" && entry.customType === PLAN_MODE_BRANCH_POINT_ENTRY_TYPE,
	);
	assert.ok(branchPoint);

	await (
		context.ctx as { navigateTree(id: string, options: unknown): Promise<unknown> }
	).navigateTree(branchPoint.id, { summarize: false });
	assert.deepEqual(mock.rawPi.getActiveTools(), normalTools);
	assert.equal(mock.thinkingLevel, "low");
	assert.equal(context.statuses.get("plan-mode"), undefined);

	await (
		context.ctx as { navigateTree(id: string, options: unknown): Promise<unknown> }
	).navigateTree(planLeafId, { summarize: false });
	assert.ok(mock.rawPi.getActiveTools().includes("plan_mode_complete"));
	assert.ok(!mock.rawPi.getActiveTools().includes("write"));
	assert.equal(mock.thinkingLevel, "medium");
	assert.equal(context.statuses.get("plan-mode"), "plan ready");
});

test("reload, resume, fork, and compaction restore branch-owned Plan metadata", async () => {
	for (const reason of ["reload", "resume", "fork"] as const) {
		const { context, mock, tree } = setupTreePlanMode({ thinkingLevel: "low" });
		await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		await completePlan(mock, tree, context.ctx);
		tree.appendMessage({ role: "compactionSummary", content: "Compacted Plan research." });

		await mock.events.get("session_shutdown")?.[0]?.({ reason }, context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "write", "custom"]);
		await mock.events.get("session_start")?.[0]?.({ reason }, context.ctx);

		assert.ok(mock.rawPi.getActiveTools().includes("plan_mode_complete"));
		assert.ok(!mock.rawPi.getActiveTools().includes("write"));
		assert.equal(mock.thinkingLevel, "medium");
		const restored = tree
			.getBranch()
			.filter((entry) => entry.customType === STATE_ENTRY_TYPE)
			.at(-1)?.data as { branchPointId?: string; toolsBeforePlanMode?: string[] };
		assert.ok(restored.branchPointId);
		assert.deepEqual(restored.toolsBeforePlanMode, ["read", "write", "custom"]);
	}
});

test("cancelled and stale clean-branch navigation leave the completed Plan branch ready", async () => {
	for (const stale of [false, true]) {
		const { context, mock, tree } = setupTreePlanMode();
		await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		await completePlan(mock, tree, context.ctx);
		const planLeafId = tree.getLeafId();
		(context.ctx as { navigateTree(): Promise<{ cancelled: boolean }> }).navigateTree =
			async () => ({
				cancelled: !stale,
			});
		if (stale) {
			(context.ctx as { waitForIdle(): Promise<void> }).waitForIdle = async () => {
				await mock.events.get("session_shutdown")?.[0]?.({ reason: "resume" }, context.ctx);
			};
		}

		await mock.commands.get("plan")?.handler("implement", context.ctx);
		assert.ok(tree.getBranch().some((entry) => entry.id === planLeafId));
		if (stale) {
			assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "write", "custom"]);
		} else {
			assert.ok(mock.rawPi.getActiveTools().includes("plan_mode_complete"));
		}
		assert.equal(mock.sentUserMessages.length, 0);
	}
});

test("print and JSON modes reject clean-branch implementation before navigation", async () => {
	for (const mode of ["print", "json"] as const) {
		const { context, mock, tree } = setupTreePlanMode();
		await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		await completePlan(mock, tree, context.ctx);
		const planLeafId = tree.getLeafId();
		(context.ctx as { mode: string; hasUI: boolean }).mode = mode;
		(context.ctx as { mode: string; hasUI: boolean }).hasUI = false;

		await assert.rejects(
			mock.commands.get("plan")?.handler("implement", context.ctx) as Promise<unknown>,
			/print\/JSON mode/i,
		);
		assert.equal(tree.getLeafId(), planLeafId);
		assert.ok(mock.rawPi.getActiveTools().includes("plan_mode_complete"));
		assert.equal(mock.sentUserMessages.length, 0);
	}
});

test("missing command context and invalid branch points fail before leaving the Plan branch", async () => {
	for (const invalidBranchPoint of [false, true]) {
		const { context, mock, tree } = setupTreePlanMode();
		await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		await completePlan(mock, tree, context.ctx);
		const planLeafId = tree.getLeafId();
		if (invalidBranchPoint) {
			const marker = tree.entries.find(
				(entry) => entry.customType === PLAN_MODE_BRANCH_POINT_ENTRY_TYPE,
			);
			assert.ok(marker);
			marker.customType = "invalid-branch-point";
		} else {
			Reflect.deleteProperty(context.ctx as object, "navigateTree");
		}

		await mock.commands.get("plan")?.handler("implement", context.ctx);
		assert.equal(tree.getLeafId(), planLeafId);
		assert.ok(mock.rawPi.getActiveTools().includes("plan_mode_complete"));
		assert.equal(mock.sentUserMessages.length, 0);
		assert.match(
			context.notifications.at(-1)?.message ?? "",
			invalidBranchPoint ? /no valid branch point/i : /reopen \/plan/i,
		);
	}
});

test("session replacement after navigation cannot publish the staged Plan into a stale destination", async () => {
	const { context, mock, tree } = setupTreePlanMode();
	await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const planLeafId = await completePlan(mock, tree, context.ctx);
	const branchPoint = tree.entries.find(
		(entry) => entry.customType === PLAN_MODE_BRANCH_POINT_ENTRY_TYPE,
	);
	assert.ok(branchPoint);
	(context.ctx as { navigateTree(id: string): Promise<{ cancelled: boolean }> }).navigateTree =
		async (targetId) => {
			const oldLeafId = tree.getLeafId();
			tree.branch(targetId);
			await mock.events.get("session_tree")?.[0]?.(
				{ type: "session_tree", oldLeafId, newLeafId: targetId },
				context.ctx,
			);
			await mock.events.get("session_shutdown")?.[0]?.({ reason: "resume" }, context.ctx);
			return { cancelled: false };
		};

	await mock.commands.get("plan")?.handler("implement", context.ctx);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.ok(tree.getEntry(planLeafId));
	const destinationStates = tree
		.getBranch()
		.filter((entry) => entry.customType === STATE_ENTRY_TYPE)
		.map((entry) => entry.data as { savedPlan?: unknown; activeImplementation?: unknown });
	assert.ok(destinationStates.every((entry) => !entry.savedPlan && !entry.activeImplementation));
});

test("idle-wait and navigation errors retain the ready Plan branch", async () => {
	for (const failure of ["wait", "navigate"] as const) {
		const { context, mock, tree } = setupTreePlanMode();
		await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		await completePlan(mock, tree, context.ctx);
		const planLeafId = tree.getLeafId();
		if (failure === "wait") {
			(context.ctx as { waitForIdle(): Promise<void> }).waitForIdle = async () => {
				throw new Error("wait failed");
			};
		} else {
			(context.ctx as { navigateTree(): Promise<unknown> }).navigateTree = async () => {
				throw new Error("navigation failed");
			};
		}

		await mock.commands.get("plan")?.handler("implement", context.ctx);
		assert.equal(tree.getLeafId(), planLeafId);
		assert.ok(mock.rawPi.getActiveTools().includes("plan_mode_complete"));
		assert.equal(mock.sentUserMessages.length, 0);
		assert.match(context.notifications.at(-1)?.message ?? "", /plan remains ready|remains ready/i);
	}
});

test("delivery failure preserves the exact Plan on the clean destination branch", async () => {
	const { context, mock, normalTools, tree } = setupTreePlanMode({ failDelivery: true });
	await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
	await mock.commands.get("plan")?.handler("start", context.ctx);
	await completePlan(mock, tree, context.ctx);
	await mock.commands.get("plan")?.handler("implement", context.ctx);

	assert.deepEqual(mock.rawPi.getActiveTools(), normalTools);
	assert.match(context.editorText, /Clean branch plan/);
	const recovered = tree
		.getBranch()
		.filter((entry) => entry.customType === STATE_ENTRY_TYPE)
		.at(-1)?.data as { savedPlan?: { plan?: string } };
	assert.equal(recovered.savedPlan?.plan, PLAN);
	assert.match(context.notifications.at(-1)?.message ?? "", /complete request is in the editor/i);
});

test("branch metadata restores only for enabled valid state shapes", () => {
	const marker = {
		id: "11111111",
		type: "custom",
		customType: PLAN_MODE_BRANCH_POINT_ENTRY_TYPE,
		data: { version: 1 },
	};
	const restored = restorePlanModeState(
		[
			marker,
			{
				type: "custom",
				customType: STATE_ENTRY_TYPE,
				data: {
					enabled: true,
					awaitingAction: false,
					branchPointId: marker.id,
					toolsBeforePlanMode: ["write", "read", "write"],
				},
			},
		],
		STATE_ENTRY_TYPE,
	);
	assert.equal(restored.branchPointId, marker.id);
	assert.deepEqual(restored.toolsBeforePlanMode, ["write", "read"]);

	const malformed = restorePlanModeState(
		[
			{
				type: "custom",
				customType: STATE_ENTRY_TYPE,
				data: {
					enabled: true,
					awaitingAction: false,
					branchPointId: "bad\u001b-id",
					toolsBeforePlanMode: ["read", 7],
				},
			},
		],
		STATE_ENTRY_TYPE,
	);
	assert.equal(malformed.branchPointId, undefined);
	assert.equal(malformed.toolsBeforePlanMode, undefined);
});
