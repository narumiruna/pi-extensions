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
      await hook({ toolName: "bash", input: { command: "git rev-parse --show-toplevel" } }, context.ctx),
      undefined,
    );
    assert.equal(
      await hook({ toolName: "bash", input: { command: "gh pr view 218 --json number,title" } }, context.ctx),
      undefined,
    );
    const compoundCommand = "git status --short && gh pr list --json number && git diff --cached";
    assert.deepEqual(await hook({ toolName: "bash", input: { command: compoundCommand } }, context.ctx), {
      block: true,
      reason:
        "Plan mode blocks bash commands outside its reviewed inspection policy or containing explicitly unsafe arguments.\nBlocked command: gh pr list --json number",
    });
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
      reason: `Plan mode blocks bash commands outside its reviewed inspection policy or containing explicitly unsafe arguments.\nBlocked command: ${heredoc}`,
    });
    assert.equal(
      await hook({ toolName: "bash", input: { command: "git rev-parse --show-toplevel" } }, context.ctx),
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
      await hook({ toolName: "powershell", input: { command: "Remove-Item README.md" } }, context.ctx),
      undefined,
      "inactive Plan mode must not enforce its PowerShell policy",
    );
    await mock.events.get("session_start")?.[0]?.({}, context.ctx);
    await mock.commands.get("plan")?.handler("start", context.ctx);
    assert.equal(
      await hook({ toolName: "powershell", input: { command: "git rev-parse --show-toplevel" } }, context.ctx),
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
          "Plan mode blocks PowerShell commands outside its reviewed inspection policy or containing explicitly unsafe syntax.\nBlocked command: Remove-Item README.md",
      },
    );
  });
});

test("active Plan mode fully trusts session-loaded safe subcommands", async () => {
  await withAgentDir(async (agentDir) => {
    await writeFile(
      join(agentDir, "pi-plan-mode.json"),
      JSON.stringify({
        safeSubcommands: {
          deploy: ["now"],
          "Invoke-Trusted": ["run"],
        },
      }),
    );
    const mock = createMockPi({
      activeTools: ["bash", "powershell"],
      allTools: [builtinTool("bash"), builtinTool("powershell")],
    });
    planMode(mock.pi);
    const context = createMockContext();
    const hook = mock.events.get("tool_call")?.[0];
    assert.ok(hook);

    await mock.events.get("session_start")?.[0]?.({}, context.ctx);
    await mock.commands.get("plan")?.handler("start", context.ctx);
    for (const [toolName, command] of [
      ["bash", "deploy now > release.txt && rm -rf src"],
      ["powershell", "Invoke-Trusted run; Remove-Item -Recurse src"],
    ] as const) {
      assert.equal(await hook({ toolName, input: { command } }, context.ctx), undefined, command);
    }
    assert.ok(
      await hook({ toolName: "bash", input: { command: "deploy nowhere && rm -rf src" } }, context.ctx),
      "a partial literal prefix must remain blocked",
    );
  });
});

test("session reload removes stale or invalid safe subcommand policy", async () => {
  await withAgentDir(async (agentDir) => {
    const settingsPath = join(agentDir, "pi-plan-mode.json");
    await writeFile(settingsPath, JSON.stringify({ safeSubcommands: { git: ["rev-parse"], gh: ["pr view"] } }));
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
      await hook({ toolName: "bash", input: { command: "gh pr view 218 --json number,title" } }, context.ctx),
      undefined,
    );
    await mock.commands.get("plan")?.handler("exit", context.ctx);

    await rm(settingsPath);
    await mock.events.get("session_start")?.[0]?.({}, context.ctx);
    await mock.commands.get("plan")?.handler("start", context.ctx);
    assert.ok(await hook({ toolName: "bash", input: { command: "gh pr view 218 --json number,title" } }, context.ctx));
    await mock.commands.get("plan")?.handler("exit", context.ctx);

    await writeFile(settingsPath, JSON.stringify({ safeSubcommands: { gh: [42] } }));
    await mock.events.get("session_start")?.[0]?.({}, context.ctx);
    assert.match(context.notifications.at(-1)?.message ?? "", /settings ignored/i);
    await mock.commands.get("plan")?.handler("start", context.ctx);
    assert.ok(await hook({ toolName: "bash", input: { command: "gh pr view 218 --json number,title" } }, context.ctx));
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
