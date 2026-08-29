import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import planMode from "../src/plan-mode.js";
import { builtinTool, createMockContext, createMockPi, extensionTool } from "./support.js";

test("active Plan mode enforces session-loaded safe subcommands", async () => {
	await withAgentDir(async (agentDir) => {
		await writeFile(
			join(agentDir, "pi-plan-mode.json"),
			JSON.stringify({
				safeSubcommands: {
					git: ["rev-parse"],
					gh: ["pr view"],
				},
			}),
		);
		const mock = createMockPi({
			activeTools: ["bash"],
			allTools: [builtinTool("read"), builtinTool("bash")],
		});
		planMode(mock.pi);
		const context = createMockContext();
		const hook = mock.events.get("tool_call")?.[0];
		assert.ok(hook);

		assert.equal(
			await hook({ toolName: "bash", input: { command: "gh pr merge 218" } }, context.ctx),
			undefined,
			"inactive Plan mode must not enforce its shell policy",
		);
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		assert.equal(
			await hook(
				{ toolName: "bash", input: { command: "git rev-parse --show-toplevel" } },
				context.ctx,
			),
			undefined,
		);
		assert.equal(
			await hook(
				{ toolName: "bash", input: { command: "gh pr view 218 --json number,title" } },
				context.ctx,
			),
			undefined,
		);
		const compoundCommand = "git status --short && gh pr list --json number && git diff --cached";
		assert.deepEqual(
			await hook({ toolName: "bash", input: { command: compoundCommand } }, context.ctx),
			{
				block: true,
				reason:
					"Plan mode bash policy (read-only inspection) blocked a segment: gh pr list --json number\n" +
					"Allowed: read-only commands (cat, ls, grep, rg, find, jq, cd, tasklist, ...), git status/log/diff/show/branch, gh pr|issue view|list --json, npm list/ls/view/test, tsc --noEmit, pytest/vitest/jest; pipes, ; and && chains; stderr redirects 2>&1 and 2>/dev/null.\n" +
					"Not allowed: output redirects (> >>), command substitution ($(...) or backticks), python/node -e, curl, mutating commands (rm, mv, cp, mkdir, tee, ...). Adjust the command; do not conclude bash is disabled.",
			},
		);
	});
});

test("active Plan mode enforces limited policy for effective bash overrides", async () => {
	await withAgentDir(async (agentDir) => {
		await writeFile(
			join(agentDir, "pi-plan-mode.json"),
			JSON.stringify({
				thinkingLevel: "inherit",
				defaultPlanTools: ["read", "bash", "grep", "find", "ls"],
				safeSubcommands: {
					git: ["rev-parse", "blame", "describe", "merge-base", "ls-tree", "cat-file"],
				},
			}),
		);
		const mock = createMockPi({
			activeTools: ["read", "bash", "grep", "find", "ls"],
			allTools: [
				builtinTool("read"),
				extensionTool("bash"),
				builtinTool("grep"),
				builtinTool("find"),
				builtinTool("ls"),
			],
		});
		planMode(mock.pi);
		const context = createMockContext();
		const hook = mock.events.get("tool_call")?.[0];
		assert.ok(hook);

		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		assert.ok(mock.rawPi.getActiveTools().includes("bash"));

		const heredoc = `python - <<'PY'\nfrom pathlib import Path\nPath("plan-mode-write-probe.txt").write_text("unexpected write\\n", encoding="utf-8")\nPY`;
		const blocked = await hook({ toolName: "bash", input: { command: heredoc } }, context.ctx);
		assert.deepEqual(blocked, {
			block: true,
			reason: `Plan mode bash policy (read-only inspection) blocked a segment: ${heredoc}\nAllowed: read-only commands (cat, ls, grep, rg, find, jq, cd, tasklist, ...), git status/log/diff/show/branch, gh pr|issue view|list --json, npm list/ls/view/test, tsc --noEmit, pytest/vitest/jest; pipes, ; and && chains; stderr redirects 2>&1 and 2>/dev/null.\nNot allowed: output redirects (> >>), command substitution ($(...) or backticks), python/node -e, curl, mutating commands (rm, mv, cp, mkdir, tee, ...). Adjust the command; do not conclude bash is disabled.`,
		});
		assert.equal(
			await hook(
				{ toolName: "bash", input: { command: "git rev-parse --show-toplevel" } },
				context.ctx,
			),
			undefined,
		);
	});
});

test("active Plan mode enforces limited policy for effective PowerShell overrides", async () => {
	await withAgentDir(async (agentDir) => {
		await writeFile(
			join(agentDir, "pi-plan-mode.json"),
			JSON.stringify({
				defaultPlanTools: ["powershell"],
				safeSubcommands: { git: ["rev-parse"] },
			}),
		);
		const mock = createMockPi({
			activeTools: ["powershell"],
			allTools: [extensionTool("powershell")],
		});
		planMode(mock.pi);
		const context = createMockContext();
		const hook = mock.events.get("tool_call")?.[0];
		assert.ok(hook);

		assert.equal(
			await hook(
				{ toolName: "powershell", input: { command: "Remove-Item README.md" } },
				context.ctx,
			),
			undefined,
			"inactive Plan mode must not enforce its PowerShell policy",
		);
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		assert.equal(
			await hook(
				{ toolName: "powershell", input: { command: "git rev-parse --show-toplevel" } },
				context.ctx,
			),
			undefined,
		);
		assert.deepEqual(
			await hook(
				{
					toolName: "powershell",
					input: { command: "Get-ChildItem; Remove-Item README.md; Get-Location" },
				},
				context.ctx,
			),
			{
				block: true,
				reason:
					"Plan mode powershell policy (read-only inspection) blocked a segment: Remove-Item README.md\n" +
					"Allowed: read-only cmdlets (Get-Content, Get-ChildItem, Select-String, Get-Process, Get-Service, cd, ...), git/gh/npm read-only forms. Not allowed: variables ($), expressions, redirects, mutating verbs. Adjust the command; do not conclude powershell is disabled.",
			},
		);
	});
});

test("session reload removes stale or invalid safe subcommand policy", async () => {
	await withAgentDir(async (agentDir) => {
		const settingsPath = join(agentDir, "pi-plan-mode.json");
		await writeFile(
			settingsPath,
			JSON.stringify({ safeSubcommands: { git: ["rev-parse"], gh: ["pr view"] } }),
		);
		const mock = createMockPi({
			activeTools: ["bash"],
			allTools: [builtinTool("read"), builtinTool("bash")],
		});
		planMode(mock.pi);
		const context = createMockContext();
		const hook = mock.events.get("tool_call")?.[0];
		assert.ok(hook);

		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		assert.equal(
			await hook(
				{ toolName: "bash", input: { command: "gh pr view 218 --json number,title" } },
				context.ctx,
			),
			undefined,
		);
		await mock.commands.get("plan")?.handler("exit", context.ctx);

		await rm(settingsPath);
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		assert.ok(
			await hook(
				{ toolName: "bash", input: { command: "gh pr view 218 --json number,title" } },
				context.ctx,
			),
		);
		await mock.commands.get("plan")?.handler("exit", context.ctx);

		await writeFile(settingsPath, JSON.stringify({ safeSubcommands: { gh: ["pr merge"] } }));
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /settings ignored/i);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		assert.ok(
			await hook(
				{ toolName: "bash", input: { command: "gh pr view 218 --json number,title" } },
				context.ctx,
			),
		);
	});
});

async function withAgentDir(run: (agentDir: string) => Promise<void>) {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-plan-mode-safe-subcommands-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await run(agentDir);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
}
