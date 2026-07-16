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
		"rg '*.ts' src",
		"rg '$value' README.md",
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
		"git log *",
		"git log {--output=log.txt,HEAD}",
		'rg "$value" README.md',
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

test("configured Git validators are additive and exact", () => {
	const cases = [
		["rev-parse", "git rev-parse --show-toplevel"],
		["blame", "git blame -- path/to/file"],
		["describe", "git describe --always"],
		["merge-base", "git merge-base HEAD origin/main"],
		["ls-tree", "git ls-tree HEAD path/to/dir"],
		["cat-file", "git cat-file -p HEAD"],
	] as const;

	for (const [subcommand, command] of cases) {
		assert.equal(isSafeCommandWithPolicy(command), false, `default: ${command}`);
		assert.equal(
			isSafeCommandWithPolicy(command, { git: [subcommand] }),
			true,
			`configured: ${command}`,
		);
	}
	assert.equal(
		isSafeCommandWithPolicy("git rev-parse --show-toplevel | head -1", {
			git: ["rev-parse"],
		}),
		true,
	);
	assert.equal(
		isSafeCommandWithPolicy("git rev-parse --show-toplevel && git status --short", {
			git: ["rev-parse"],
		}),
		true,
	);
	assert.equal(
		isSafeCommandWithPolicy("git rev-parse --show-toplevel && git blame -- file", {
			git: ["rev-parse"],
		}),
		false,
	);
	assert.equal(
		isSafeCommandWithPolicy("git rev-parse --show-toplevel | touch output", {
			git: ["rev-parse"],
		}),
		false,
	);
});

test("configured gh validators require exact read-only paths", () => {
	const cases = [
		["pr view", "gh pr view 218"],
		["pr list", "gh pr list --limit 20"],
		["issue view", "gh issue view 212 --comments"],
		["issue list", "gh issue list --state open"],
	] as const;

	for (const [path, command] of cases) {
		assert.equal(isSafeCommandWithPolicy(command), false, `default: ${command}`);
		assert.equal(isSafeCommandWithPolicy(command, { gh: [path] }), true, `configured: ${command}`);
	}
	const allGh = { gh: cases.map(([path]) => path) };
	for (const command of [
		"gh pr merge 218",
		"gh pr close 218",
		"gh pr edit 218 --title changed",
		"gh issue edit 212 --title changed",
		"gh issue close 212",
		"gh issue create --title changed",
		"gh alias list",
		"gh co 218",
		"gh pr view 218 --web",
		"gh pr view 218 --web=true",
		"gh pr view 218 -w",
		"gh pr view 218 -w=true",
		"gh pr view 218 --pager=less",
		"gh pr view $PI_PLAN_GH_ARGUMENTS",
		"gh issue view 212 --web",
		"gh --repo owner/repo pr view 218",
		"gh pr --help view",
		"gh pr view 218 > output",
		"gh pr view 218 && gh pr merge 218",
	]) {
		assert.equal(isSafeCommandWithPolicy(command, allGh), false, command);
	}
	assert.equal(isSafeCommandWithPolicy("gh pr view 218 && gh issue list --limit 5", allGh), true);
});

test("maximal Git opt-in preserves execution and mutation guards", () => {
	const git = ["rev-parse", "blame", "describe", "merge-base", "ls-tree", "cat-file"];
	for (const command of [
		"git cat-file --filters HEAD",
		"git cat-file --filters=blob HEAD",
		"git cat-file --textconv HEAD",
		"git cat-file --textconv=true HEAD",
		"git cat-file -p HEAD --output=copy",
		"git --exec-path=/tmp cat-file -p HEAD",
		"git --paginate cat-file -p HEAD",
		"git -c alias.x='!touch output' x",
		"git branch -D old",
		"git branch --set-upstream-to=origin/main",
		"git remote add origin url",
		"git remote update",
		"git diff --ext-diff",
		"git show --ext-diff=true HEAD",
		"git show --textconv HEAD",
		"git rev-parse $PI_PLAN_GIT_ARGUMENTS",
		"git status\ngit rev-parse --show-toplevel",
	]) {
		assert.equal(isSafeCommandWithPolicy(command, { git }), false, command);
	}
	assert.equal(
		isSafeCommandWithPolicy("git checkout main", { git: ["checkout"] }),
		false,
		"unknown configured names must not become permissions",
	);
});

test("tool policy classifies built-ins and extension tools consistently", () => {
	type PlanTool = Parameters<typeof classifyPlanModeTool>[0];
	assert.equal(classifyPlanModeTool(builtinTool("read") as PlanTool), "read-only");
	assert.equal(classifyPlanModeTool(builtinTool("bash") as PlanTool), "limited");
	assert.equal(classifyPlanModeTool(builtinTool("write") as PlanTool), "blocked");
	assert.equal(classifyPlanModeTool(extensionTool("custom") as PlanTool), "user-opt-in");
});

type TestSafeSubcommands = { git?: readonly string[]; gh?: readonly string[] };
const isSafeCommandWithPolicy = isSafeCommand as unknown as (
	command: string,
	safeSubcommands?: TestSafeSubcommands,
) => boolean;

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
