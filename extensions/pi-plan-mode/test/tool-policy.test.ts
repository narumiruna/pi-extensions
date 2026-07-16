import assert from "node:assert/strict";
import test from "node:test";
import {
	builtinTool,
	createMockContext,
	createMockPi,
	extensionTool,
} from "../../../test/support.js";
import planMode, {
	canSelectToolInPlanMode,
	classifyPlanModeTool,
	isSafeCommand,
	withoutPlanModeQuestionTool,
	withRequiredPlanModeTools,
} from "../src/plan-mode.js";

test("tool selection allows safe built-ins and non-built-ins only", () => {
	type PlanTool = Parameters<typeof canSelectToolInPlanMode>[0];
	assert.equal(canSelectToolInPlanMode(builtinTool("read") as PlanTool), true);
	assert.equal(canSelectToolInPlanMode(builtinTool("edit") as PlanTool), false);
	assert.equal(canSelectToolInPlanMode(extensionTool("custom") as PlanTool), true);
	assert.equal(canSelectToolInPlanMode(extensionTool("edit") as PlanTool), true);
	assert.deepEqual(withRequiredPlanModeTools(["read", "plan_mode_question", "read"]), [
		"read",
		"plan_mode_question",
		"plan_mode_complete",
	]);
	assert.deepEqual(withoutPlanModeQuestionTool(["read", "plan_mode_question"]), ["read"]);
});

test("isSafeCommand permits read-only command lists and rejects shell mutation", () => {
	for (const command of [
		"git status --short && git diff --check",
		"git branch --show-current",
		"git remote get-url origin",
		"rg -n 'plan' src | head -20",
		"npm test -- --help",
		"npm run typecheck",
		"cargo test --no-run",
		"sed -n '1,20p' file.ts",
	]) {
		assert.equal(isSafeCommand(command), true, command);
	}
	for (const command of [
		"rm -rf build",
		"npm install",
		"echo $(rm file)",
		"cat file > copy",
		"git status; touch file",
		"cat file & touch file",
		"find . -delete",
		"find . -exec rm {} ;",
		"sed -i 's/a/b/' file",
		"sed -ni 's/a/b/' file",
		"sed -n 'w output' input",
		"sed -n 'e touch output' input",
		"uniq input output",
		"diff left right --output=diff.txt",
		"sort --compress-program='touch output' input",
		"sort -T /tmp input",
		"git grep --open-files-in-pager='sh -c touch output' pattern",
		"git grep -O'sh -c touch output' pattern",
		"git grep -O 'sh -c touch output' pattern",
		"git branch -D old",
		"git branch --unset-upstream",
		"git branch --set-upstream-to=origin/main",
		"git remote add origin url",
		"git remote set-head origin -a",
		"git remote set-branches origin main",
		"npm audit --fix",
		"npm audit fix",
		"env sh -c 'touch file'",
		"date --set tomorrow",
		"sort input -o output",
		"sort -o/tmp/output input",
		"tree -o output",
		"find . -fprint output",
		"find . -fprint0 output",
		"fd pattern --exec touch file",
		"fd pattern -x rm {}",
		"rg pattern --pre 'touch file'",
		"bat file --pager 'sh -c touch file'",
		"git diff --ext-diff",
		"git log --output=log.txt",
		"git remote update",
		"tsc --noEmit --incremental --tsBuildInfoFile info.tsbuildinfo",
		"tsc --noEmit --generateTrace trace",
		"go build ./cmd/app",
		"cargo build",
		"npm run build",
		"awk 'BEGIN { system(\"touch file\") }'",
		"rg x || (echo bad > file)",
		"cat <<EOF",
		"unknown-command --dry-run",
		"",
	]) {
		assert.equal(isSafeCommand(command), false, command);
	}
});

test("tool policy classifies built-ins and extension tools consistently", () => {
	type PlanTool = Parameters<typeof classifyPlanModeTool>[0];
	assert.equal(classifyPlanModeTool(builtinTool("read") as PlanTool), "read-only");
	assert.equal(classifyPlanModeTool(builtinTool("bash") as PlanTool), "limited");
	assert.equal(classifyPlanModeTool(builtinTool("write") as PlanTool), "blocked");
	assert.equal(classifyPlanModeTool(extensionTool("custom") as PlanTool), "user-opt-in");
});

test("active Plan mode blocks update_plan and blocked built-ins at the tool hook", async () => {
	const mock = createMockPi({
		activeTools: ["read", "bash", "update_plan", "danger"],
		allTools: [
			builtinTool("read"),
			builtinTool("bash"),
			builtinTool("danger"),
			extensionTool("edit"),
		],
	});
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("", context.ctx);
	const hook = mock.events.get("tool_call")?.[0];
	const blocked = await hook?.({ toolName: "update_plan", input: {} }, context.ctx);
	const blockedBuiltin = await hook?.({ toolName: "danger", input: {} }, context.ctx);
	const allowed = await hook?.({ toolName: "read", input: {} }, context.ctx);
	const optedInExtension = await hook?.({ toolName: "edit", input: {} }, context.ctx);
	assert.deepEqual(blocked, {
		block: true,
		reason:
			"Plan mode blocks update_plan because it tracks execution progress rather than conversational planning.",
	});
	assert.deepEqual(blockedBuiltin, {
		block: true,
		reason: "Plan mode blocks built-in tool 'danger' because its policy class is blocked.",
	});
	assert.equal(allowed, undefined);
	assert.equal(optedInExtension, undefined);
});
