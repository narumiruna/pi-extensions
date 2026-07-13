# 🧭 pi-plan-mode — Codex-like Plan Mode for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-plan-mode)](https://www.npmjs.com/package/@narumitw/pi-plan-mode) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-plan-mode` adds a Codex-like `/plan` collaboration mode to Pi. Plan mode is for read-only exploration, clarifying questions, and a structured implementation-ready plan before any code mutation happens.

Pi core intentionally does not ship a built-in plan mode; this package provides one as an independently installable extension.

## ✨ Features

- Adds `/plan` to enter or manage Plan mode.
- Adds `--plan` to start a session in Plan mode.
- Enables built-in read-only tools by default while Plan mode is active.
- Disables extension and custom tools by default, with a `/plan tools` selector for explicit user-risk opt-in.
- Blocks `update_plan`, mutating built-in tools, and unsafe shell forms such as writes, substitutions, background jobs, dependency installs, and mutating Git commands.
- Injects Codex-like Plan mode instructions: explore first, ask decision questions for high-impact ambiguity, do not mutate files, and finalize only when decision-complete.
- Adds required `plan_mode_question` and `plan_mode_complete` tools for structured questions and completion.
- Presents the complete plan and prompts you to implement, stay in Plan mode, or exit and discard it.
- Keeps legacy `<proposed_plan>` responses compatible without advertising XML as the primary workflow.
- Shows Plan mode state in Pi's statusline as `plan active` or `plan ready`; `@narumitw/pi-statusline` adds the default `📝` icon unless configured otherwise.
- Persists Plan mode state in the Pi session so resume restores the mode.

## 📦 Install

This release requires Pi 0.80.6 or newer.

```bash
pi install npm:@narumitw/pi-plan-mode
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-plan-mode
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/pi-plan-mode
```

## 🚀 Usage

```text
/plan
/plan <prompt>
/plan tools
/plan show
/plan finalize
/plan implement
/plan exit
```

Use `/plan` to enter Plan mode before writing your planning prompt. Use `/plan <prompt>` to enter Plan mode and immediately submit `<prompt>` as the first Plan-mode user message. Use `/plan tools` to choose which tools are active while Plan mode is enabled; the selector is paginated at 10 tools per page. `/plan show` displays the stored plan without starting a model turn, `/plan finalize` explicitly asks the agent to complete the plan or ask one remaining material question, and `/plan implement` hands a stored plan to a normal implementation turn. `show` and `implement` fail closed when no plan is stored; `finalize` requires active Plan mode.

When Plan mode is active, ask the agent to design the change. The agent may inspect files and run read-only commands, but it should not edit files or execute the implementation. It should explore first, then use structured questions when your preference or a tradeoff materially changes the plan.

By default, Plan mode manages only Pi's built-in tools: `read`, limited `bash`, available read-only built-ins such as `grep`, `find`, and `ls`, plus the required `plan_mode_question` and `plan_mode_complete` tools. Built-in `edit` and `write` are blocked. `update_plan` is also blocked because it tracks execution progress rather than conversational planning. Extension and custom tools are disabled by default because Pi tools do not expose standardized mutability metadata; enable them from `/plan tools` only when you accept the risk for that session. For example, you can opt into `firecrawl_scrape`, `firecrawl_search`, or `lsp_diagnostics` if those extensions are loaded and you want to use them during planning.

Limited `bash` uses a fail-closed policy. It accepts common inspection commands, read-only Git and npm queries, pipelines and command lists composed entirely of accepted commands, plus selected checks such as `npm test`, `npm run typecheck`, and `cargo test`. It rejects output/input redirects, command substitution, subshells, background jobs, mutating flags, dependency changes, editors, and unknown commands. Tests and builds may still write ignored caches or build artifacts and may execute project-defined hooks; enable or invoke them only when the repository is trusted. This is extension-level risk reduction, not an OS sandbox.

`plan_mode_question` follows Codex's `request_user_input` pattern: the agent can ask 1-3 concise questions, each with meaningful options and a free-form Other path. If you cancel or no interactive UI is available, the agent should ask a concise plain-text question or proceed only with a clearly stated low-risk assumption instead of prematurely producing a final plan.

Pi activates tools by tool name. The `/plan tools` selector stores selections by name and shows each currently effective tool's source from Pi metadata, such as `built-in`, a user extension path, or a project extension path. If an extension overrides a built-in tool with the same name, Pi exposes the effective tool for that name and the selector shows that source.

A complete Plan mode answer should appear only after the agent has resolved discoverable facts and high-impact user decisions. The agent must call `plan_mode_complete({ plan })` alone as its final action, passing the complete Markdown plan. The tool rejects empty or whitespace-only plans and plans longer than 50,000 JavaScript characters; it does not truncate. Its visible result contains the full plan, and versioned result details let the extension restore it safely from the active session branch.

`plan_mode_complete` uses Pi's `terminate: true` hint. Termination is best effort: if a model puts it in a parallel tool batch, Pi terminates the batch early only when every finalized sibling tool also terminates. The prompt therefore requires the completion call to be standalone and last. The extension deliberately does not infer completion from phrases such as “I will present the plan,” and it does not automatically retry a turn with no plan because research and clarification turns may legitimately remain unfinished. If a turn ends without a plan, Plan mode stays active; use `/plan finalize` for explicit recovery.

Legacy sessions and models may still submit one non-empty `<proposed_plan>` block with tags on their own lines. That compatibility path remains accepted, but it is not the primary workflow. Empty, malformed, unclosed, or multiple legacy blocks keep Plan mode active and produce a warning.

After completion, `/plan` opens the ready actions when interactive UI is available. Choosing implementation—or running `/plan implement`—disables Plan mode, restores full tool access, and starts an implementation turn with the stored plan. Choosing Stay keeps the plan ready. Revision feedback starts another Plan-mode turn and clears the previous implementable plan until an updated completion arrives. For clarification-only follow-ups, the agent answers and resubmits the complete unchanged plan so it remains implementable. Exit/off discards the plan and removes its completion result from later non-Plan model context. Without interactive UI, the plan remains visible in the tool result and stored as `plan ready`; use `/plan show`, `/plan implement`, or `/plan exit` directly.

While Plan mode is enabled, the extension also publishes a compact status for Pi statuslines. With `@narumitw/pi-statusline`, this appears in the extension status area:

- `plan active`: Plan mode is enabled and still gathering context or drafting a plan.
- `plan ready`: A completed plan is stored until you implement it, continue planning, or exit Plan mode.

You can also exit directly. Direct exit discards the latest proposed plan instead of treating it as an implementation request:

```text
/plan exit
```

## ⚙️ Thinking level

Plan mode inherits Pi's current thinking level by default. To request a fixed level only while Plan mode is active, create `$PI_CODING_AGENT_DIR/pi-plan-mode.json` (normally `~/.pi/agent/pi-plan-mode.json`):

```json
{
  "thinkingLevel": "medium"
}
```

Supported values are `inherit`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. The extension snapshots the prior level and restores it on exit only if the level still matches the value it applied; a manual change made during Plan mode is preserved. The settings file is optional, is read at session start, and never changes Pi's default setting. Invalid settings produce a warning and fall back to `inherit`.

Compatibility: a valid legacy `plan-mode.json` is migrated automatically to `pi-plan-mode.json`. If both files exist, the new filename takes precedence.

## 🧠 Codex-like behavior

This extension maps Codex's `ModeKind::Plan` behavior onto Pi's extension API:

- Plan mode is a conversational collaboration mode, not TODO/progress tracking.
- `/plan <prompt>` follows Codex behavior by switching to Plan mode before submitting the inline prompt.
- The agent should use `plan_mode_question` for important non-discoverable preferences or tradeoffs before finalizing.
- The agent completes with a standalone `plan_mode_complete` tool call instead of relying on semantic prose detection.
- `update_plan` checklist use is blocked while Plan mode is active.
- The implementation boundary is explicit: Plan mode restores tools before starting implementation, choosing implementation immediately triggers a normal agent turn with full tool access, and plain exit/off discards the stored plan.
- Pi extension safety is approximated with tool classification and fail-closed bash filtering; non-built-in tools remain user-selected at user risk because Pi does not expose standardized tool mutability metadata.
- Unlike native Codex, this extension uses a terminating Pi tool plus an `agent_settled` ready flow; Pi cannot provide sandbox-level enforcement.

## 🗂️ Package layout

```txt
extensions/pi-plan-mode/
├── src/
│   ├── plan-mode.ts  # Pi entrypoint and mode state
│   └── *.ts          # Package-local prompt, policy, question, and message modules
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

Only `plan-mode.ts` is a Pi entrypoint; the other source modules are internal. The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/plan-mode.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, plan mode, Codex-like plan mode, AI coding workflow, read-only planning, implementation plan.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
