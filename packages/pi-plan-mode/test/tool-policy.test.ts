import assert from "node:assert/strict";
import { test } from "vitest";
import planMode, {
	canSelectToolInPlanMode,
	classifyPlanModeTool,
	isSafeCommand,
	withRequiredPlanModeTools,
} from "../src/plan-mode.js";
import {
	findBlockedCommandSegment,
	findBlockedPowerShellCommandSegment,
	isSafePowerShellCommand,
} from "../src/tool-policy.js";
import { builtinTool, createMockContext, createMockPi, extensionTool } from "./support.js";

test("tool selection allows safe built-ins and non-built-ins only", () => {
	type PlanTool = Parameters<typeof canSelectToolInPlanMode>[0];
	assert.equal(canSelectToolInPlanMode(builtinTool("read") as PlanTool), true);
	assert.equal(canSelectToolInPlanMode(builtinTool("powershell") as PlanTool), true);
	assert.equal(canSelectToolInPlanMode(builtinTool("edit") as PlanTool), false);
	assert.equal(canSelectToolInPlanMode(extensionTool("custom") as PlanTool), true);
	assert.equal(canSelectToolInPlanMode(extensionTool("edit") as PlanTool), true);
	assert.deepEqual(withRequiredPlanModeTools(["read", "plan_mode_question", "read"]), [
		"read",
		"plan_mode_question",
		"plan_mode_complete",
	]);
});

test("isSafeCommand permits read-only command lists and rejects shell mutation", () => {
	for (const command of [
		"git status --short && git diff --check",
		"git branch --show-current",
		"git remote get-url origin",
		"rg -n 'plan' src | head -20",
		"rg '*.ts' src",
		"rg '$value' README.md",
		'rg "$value" README.md',
		"cd /tmp && ls",
		"ls 2>/dev/null | head -3",
		"echo hi 2>&1 | grep hi",
		"FOO=bar rg pattern",
		"git log *",
		"tasklist",
		"wmic process get name",
		"ipconfig | head -5",
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
		"git log {--output=log.txt,HEAD}",
		'wmic process call create "calc.exe"',
		"echo x 2>/dev/nullx",
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

test("blocked command diagnostics identify the first rejected segment", () => {
	const accepted = "git status --short && git diff --cached | head -20";
	const singleBlocked = "touch output";
	const compoundBlocked =
		"git status --short && git reset --hard && git diff --cached | touch output";
	const unsupportedSyntax = "  git status --short && cat file > copy  ";

	assert.equal(findBlockedCommandSegment(accepted), undefined);
	assert.equal(findBlockedCommandSegment(singleBlocked), singleBlocked);
	assert.equal(findBlockedCommandSegment(compoundBlocked), "git reset --hard");
	assert.equal(findBlockedCommandSegment(unsupportedSyntax), unsupportedSyntax.trim());
	assert.equal(findBlockedCommandSegment("   "), "(empty command)");
	for (const command of [accepted, singleBlocked, compoundBlocked, unsupportedSyntax, "   "]) {
		assert.equal(isSafeCommand(command), findBlockedCommandSegment(command) === undefined, command);
	}
});

test("PowerShell policy permits reviewed inspection commands", () => {
	for (const command of [
		"cd packages",
		"Get-Process",
		"Get-Service",
		"Get-ChildItem -Filter *.ts",
		"Get-Content -LiteralPath 'README file.md'",
		"gEt-LoCaTiOn",
		"Get-Item Env:PI_MODEL",
		"Get-Location",
		"Resolve-Path .",
		"Select-String -Path README.md -Pattern 'Plan mode'",
		"Test-Path packages\\pi-plan-mode",
		"Get-Content README.md | Select-String -Pattern Plan",
		"Get-ChildItem packages; Measure-Object",
		"Get-ChildItem | Sort-Object Name | Format-Table Name",
		"Write-Output 'safe; Remove-Item README.md'",
		"Write-Output '$env:PI_MODEL'",
		"Write-Output 'status'; git status --short",
		"git log -1 --oneline",
	]) {
		assert.equal(isSafePowerShellCommand(command), true, command);
	}
});

test("PowerShell policy rejects mutation and dynamic execution syntax", () => {
	for (const command of [
		"Remove-Item README.md",
		"Set-Content README.md changed",
		"New-Item output.txt",
		"Copy-Item source target",
		"Invoke-Expression 'Get-ChildItem'",
		"Start-Process git",
		"Get-Content README.md > copy.md",
		"Get-Content $env:PI_SESSION_FILE",
		"Get-Content $(Get-Location)",
		"Get-ChildItem | ForEach-Object { Remove-Item $_ }",
		"& 'git' status",
		"[System.IO.File]::Delete('README.md')",
		'Get-Content `"README.md`"',
		"git reset --hard",
		"git status; Remove-Item README.md",
		"Get-ChildItem && Remove-Item README.md",
		"Get-ChildItem || Set-Content README.md changed",
		"Get-Content README.md | Tee-Object copy.md",
		"Test-Path README.md ? Get-Content README.md : Remove-Item README.md",
		"Get-ChildItem ?? Remove-Item README.md",
		"Get-ChildItem ! Remove-Item README.md",
		"git --% status; Remove-Item README.md",
		"Get-ChildItem # comment",
		"npm test",
		"node --version",
		"cmd /c dir",
		"powershell -Command Get-ChildItem",
		"Get-Content README.md\nRemove-Item README.md",
		"",
	]) {
		assert.equal(isSafePowerShellCommand(command), false, command);
	}
});

test("PowerShell policy rejects unsupported quote and statement syntax", () => {
	for (let codePoint = 0x2018; codePoint <= 0x201e; codePoint += 1) {
		const quote = String.fromCodePoint(codePoint);
		const command = `Write-Output ${quote}safe${quote}`;
		assert.equal(isSafePowerShellCommand(command), false, command);
		assert.equal(findBlockedPowerShellCommandSegment(command), command);
	}

	for (const command of [
		'Write-Output "safe\u201d; Remove-Item README.md \u201c"',
		"Write-Output 'safe\u2019; Remove-Item README.md \u2018'",
		"Write-Output one && Write-Output two",
		"Write-Output one || Write-Output two",
	]) {
		assert.equal(isSafePowerShellCommand(command), false, command);
		assert.equal(findBlockedPowerShellCommandSegment(command), command);
	}
});

test("PowerShell diagnostics identify the first rejected segment", () => {
	const accepted = "Get-ChildItem -Force; git status --short | Select-String modified";
	const blocked = "Get-ChildItem; git status --short | Remove-Item README.md; Get-Location";
	const unsupported = " Get-Content README.md > copy.md ";

	assert.equal(findBlockedPowerShellCommandSegment(accepted), undefined);
	assert.equal(findBlockedPowerShellCommandSegment(blocked), "Remove-Item README.md");
	assert.equal(findBlockedPowerShellCommandSegment(unsupported), unsupported.trim());
	assert.equal(findBlockedPowerShellCommandSegment("   "), "(empty command)");
});

test("PowerShell policy reuses configured Git and gh validators", () => {
	assert.equal(isSafePowerShellCommand("git rev-parse --show-toplevel"), false);
	assert.equal(
		isSafePowerShellCommand("git rev-parse --show-toplevel", { git: ["rev-parse"] }),
		true,
	);
	assert.equal(isSafePowerShellCommand("gh issue view 973 --json number,title"), false);
	assert.equal(
		isSafePowerShellCommand("gh issue view 973 --json number,title", { gh: ["issue view"] }),
		true,
	);
	assert.equal(
		isSafePowerShellCommand("gh issue view 973 --json number,title; git reset --hard", {
			gh: ["issue view"],
		}),
		false,
	);
});

test("configured Git validators are additive and exact", () => {
	const cases = [
		["rev-parse", "git rev-parse --show-toplevel"],
		["blame", "git blame --no-textconv -- path/to/file"],
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
		["pr view", "gh pr view 218 --json number,title,state"],
		["pr list", "gh pr list --limit 20 --json=number,title"],
		["issue view", "gh issue view 212 --comments --json number,title"],
		["issue list", "gh issue list --state open --json number,title"],
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
		"gh pr view 218",
		"gh pr list --limit 20",
		"gh issue view 212 --comments",
		"gh issue list --state open",
		"gh pr view 218 --json",
		"gh pr view 218 --json --comments",
		"gh pr view 218 --json=",
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
	assert.equal(
		isSafeCommandWithPolicy(
			"gh pr view 218 --json number,title --jq .number && gh issue list --limit 5 --json number,title",
			allGh,
		),
		true,
	);
});

test("maximal Git opt-in preserves execution and mutation guards", () => {
	const git = ["rev-parse", "blame", "describe", "merge-base", "ls-tree", "cat-file"];
	for (const command of [
		"git cat-file --filters HEAD",
		"git cat-file --filters=blob HEAD",
		"git cat-file --filter HEAD:file.foo",
		"git cat-file --filt HEAD:file.foo",
		"git cat-file --textconv HEAD",
		"git cat-file --textc HEAD:file.foo",
		"git cat-file --textconv=true HEAD",
		"git cat-file -p HEAD --output=copy",
		"git --exec-path=/tmp cat-file -p HEAD",
		"git --paginate cat-file -p HEAD",
		"git -c alias.x='!touch output' x",
		"git branch -D old",
		"git branch -mrenamed",
		"git branch -uorigin/main",
		"git branch --e",
		"git branch --u",
		"git branch --creat",
		"git branch --set-upstream-to=origin/main",
		"git remote add origin url",
		"git remote update",
		"git diff --ext-diff",
		"git grep --textc needle",
		"git grep --open=less needle",
		"git grep --ext-grep needle",
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

test("Git validators allow ordinary inspection while rejecting explicit helpers", () => {
	for (const command of [
		"git diff",
		"git diff --cached",
		"git diff --stat",
		"git diff --no-ext-diff",
		"git diff --no-textconv",
		"git diff --check",
		"git diff --no-ext-diff --no-textconv HEAD~1",
		"git show HEAD",
		"git show --stat --oneline HEAD",
		"git show --no-textconv HEAD",
		"git log -p -1",
		"git log -p -1 HEAD -- path/to/file",
		"git log -U3 -1",
		"git log --binary -1",
		"git log --patch-with-stat -1",
		"git log -Ssecret -1",
		"git log -Gsecret -1",
		"git log --find-object=0123456789abcdef -1",
		"git log -p --no-textconv -1",
		"git remote show -n origin",
		"printf 'cached diff:\\n' && git diff --cached | head -20",
	]) {
		assert.equal(isSafeCommandWithPolicy(command), true, command);
	}
	for (const command of [
		"git diff --ext-diff",
		"git show --textconv HEAD",
		"git log --show-signature -1",
		"git log --format=%G? -1",
		"git log --output=history.txt -1",
		"git status --help",
		"git remote show origin",
	]) {
		assert.equal(isSafeCommandWithPolicy(command), false, command);
	}
	assert.equal(isSafeCommandWithPolicy("git blame -- path/to/file", { git: ["blame"] }), true);
	assert.equal(
		isSafeCommandWithPolicy("git blame --textconv -- path/to/file", { git: ["blame"] }),
		false,
	);
});

test("tool policy classifies built-ins and extension tools consistently", () => {
	type PlanTool = Parameters<typeof classifyPlanModeTool>[0];
	assert.equal(classifyPlanModeTool(builtinTool("read") as PlanTool), "read-only");
	assert.equal(classifyPlanModeTool(builtinTool("bash") as PlanTool), "limited");
	assert.equal(classifyPlanModeTool(builtinTool("powershell") as PlanTool), "limited");
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
	await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
	const hook = mock.events.get("tool_call")?.[0];
	const inactiveHelper = await hook?.(
		{ toolName: "plan_mode_complete", input: { plan: "# invalid" } },
		context.ctx,
	);
	assert.deepEqual(inactiveHelper, {
		block: true,
		reason: "plan_mode_complete is only available while Plan mode is active.",
	});
	await mock.commands.get("plan")?.handler("start", context.ctx);
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
		reason:
			"Plan mode blocks tool 'danger' because its built-in policy is blocked and settings cannot enable it.",
	});
	assert.equal(allowed, undefined);
	assert.deepEqual(optedInExtension, {
		block: true,
		reason: "Plan mode blocks mutating tool 'edit'.",
	});

	await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
	assert.deepEqual(await hook?.({ toolName: "read", input: {} }, context.ctx), {
		block: true,
		reason: "Plan mode blocks tool 'read' because workflow ownership is unavailable.",
	});
});
