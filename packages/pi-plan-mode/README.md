# 🧭 pi-plan-mode — Plan Before Pi Edits Code

[![npm](https://img.shields.io/npm/v/@narumitw/pi-plan-mode)](https://www.npmjs.com/package/@narumitw/pi-plan-mode) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Use a Codex-like `/plan` mode to explore a codebase, resolve important questions, and approve an implementation-ready plan before Pi edits files.

## ✨ Features

- Starts and manages Plan mode through `/plan`, `/plan start`, or `/plan <prompt>`.
- Blocks mutations, inactive helpers, and unsafe shell forms while keeping helper schemas stable.
- Uses structured questions for important ambiguity and explicit completion for a decision-ready plan.
- Reviews the complete plan before implementation, export, save, further planning, or discard.
- Implements in the planning session or a fresh linked session with the approved plan.
- Restores Plan state and one saved plan across resume and compaction.
- Configures the Plan tool allowlist, export path, plan reinjection, shortcut, and thinking level.
- Publishes statusline state and cooperates anonymously with Workflow Mutex Protocol v1 participants.

## 📦 Install

This release requires Pi 0.80.6 or newer.
Native PowerShell tool support requires Pi 0.84.3 or newer on Windows; earlier Pi versions omit that optional tool and retain the existing Plan policy.

```bash
pi install npm:@narumitw/pi-plan-mode
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-plan-mode
```

Build and try this package locally from the repository root:

```bash
npm --workspace @narumitw/pi-plan-mode run build
pi -e ./packages/pi-plan-mode
```

The package declares `dist/index.ts`, so build an unbuilt local checkout before Pi loads the package directory.
Install only from sources you trust because Pi extensions run with Pi's permissions.

## 🚀 Quick start

Run `/plan` to open the state-aware menu, then start Plan mode and ask the agent to inspect and design the change.
Run `/plan <prompt>` when the first planning request is already known.

## 💬 Commands

```text
/plan
/plan start
/plan <prompt>
/plan tools
/plan show
/plan finalize
/plan implement
/plan save
/plan export [path]
/plan exit
```

In TUI and RPC, use bare `/plan` to open the menu for the current Plan state.
When Plan mode is off and no plan is stored, the launch menu shows the effective next-start tools and offers **Start Plan mode**, **Choose tools, then start…**, **Settings**, and **How Plan mode works**.
Settings edits the persistent defaults for later workflows.
Launch-menu policy changes remain a draft until **Done — start with this policy** is selected; Back, Escape, Ctrl+C, disposal, session replacement, and shutdown discard the draft without changing Plan state, active tools, thinking, or the stored selection.

Use `/plan start` when you want to enter Plan mode directly without sending a model message.
Use `/plan <prompt>` to enter Plan mode and immediately submit `<prompt>` as the first Plan-mode user message.
The exact argument `start` is reserved for direct activation; longer text such as `/plan start a migration` remains an inline planning prompt.
The extension does not register a startup flag; run `/plan start` after launch for direct activation.

Use **Choose tools, then start…** or the `/plan tools` compatibility shortcut to choose a session-specific Plan policy before planning starts.
Both routes use the same draft selector: **Done — start with this policy** stores the allowlist and starts the workflow, while cancellation leaves Plan mode off and changes nothing.
The bounded multi-select shows 10 rows at a time, supports viewport paging, descriptions, and explicit unavailable rows for blocked, currently inactive, or configured but not-yet-registered tools.
Configured or previously selected names without current metadata appear as pending registration and remain selected for first-request resolution.
Reopen the picker to refresh tools registered while it was closed because Pi exposes no live tool-registration event.
In TUI mode, type to fuzzy-search tool names, descriptions, policy, and source metadata; RPC shows the complete unfiltered list.
Once Plan mode is active, tools are locked: `/plan` no longer offers tool or Settings actions, and `/plan tools` rejects the request.
Exit and start a new workflow if a different tool set is required.
The `plan_mode_question` tool keeps a dedicated model-requested questionnaire instead of using command-menu navigation.
`/plan show` displays the stored plan without starting a model turn, including the accepted plan while implementation is active.
`/plan finalize` explicitly asks the agent to complete the plan or ask one remaining material question, `/plan save` stores a completed ready plan for later and leaves Plan mode, and `/plan export [path]` writes a ready, saved, or active implementation plan to Markdown.
Completed and saved plan menus offer **Implement here**, which continues with the planning conversation, and **Start fresh and implement**, which opens a new session and transfers only the approved plan.
The direct `/plan implement` compatibility route remains equivalent to **Implement here** and never opens a selector.
A successful ready-plan export also leaves Plan mode; saved and active implementation exports retain their existing state.
`show`, `save`, `export`, and `implement` fail closed when no applicable plan is stored; `finalize` requires active Plan mode.
Pi executes extension commands immediately during streaming, but changing Plan state or handing off implementation during an active run would mix two mode contracts inside one run.
Plan mode therefore rejects busy start, exit, save, ready-plan export, implementation, state-changing menu action, and configured-shortcut transitions without changing state; wait for the run to settle and retry.
Prompts submitted while Plan mode is already active remain ordinary Plan follow-ups, and `/plan finalize` remains available as a Plan-preserving follow-up.
TUI and RPC show a warning for a rejected busy transition, while print and JSON routes throw an observable error.

`/plan export` uses the configured **Export destination**, which defaults to `PLAN.md`.
Supply a path to override that default for one export.
Relative paths resolve from the command's current `ctx.cwd` at export time, absolute paths remain absolute, a leading `@` is accepted for Pi path compatibility, and missing parent directories are created.
Explicit `/plan export <path>` input always wins over the setting.
Export never overwrites an existing file, directory, or symbolic link: choose another path or remove the existing target first.
A successful export adds one trailing newline but otherwise preserves the accepted Markdown exactly.
After a ready plan is written, Plan mode ends, its thinking level is restored, the stable helper envelope is unchanged, and the ready state is cleared without starting a model turn.
Exporting a saved or active implementation plan leaves that state unchanged.
Failed or cancelled exports leave every Plan-mode state unchanged.
The resulting file is available to the agent through its normal file-reading tools.
Export is an explicit user-requested file mutation.
Model-initiated Plan-mode writes remain blocked.

In TUI and RPC, **Export plan…** opens a single-line path input from every ready, saved, or active plan menu.
The input shows both the configured value and its currently resolved path.
Submit an empty value to use the configured destination, or enter a relative or absolute one-off path.
A failed TUI export retains the draft for correction; RPC reopens its input dialog.
Escape returns to the owning menu without writing a file.
A successful ready-plan export closes the menu and ends Plan mode; saved and active implementation menus close without changing their stored state.

## 🔒 Security and privacy

While Plan mode is active, the policy blocks built-in editing tools and instructs the agent not to edit files or implement the change.
It should explore first and ask structured questions when a preference or tradeoff materially changes the plan.
Configure persistent defaults or a one-workflow tool override before activation; active and ready workflows lock those controls.

Plan mode registers `plan_mode_question` and `plan_mode_complete` during extension load and never changes their active status itself.
Another active-tool policy may hide them, in which case Plan start or restore fails without widening that policy.
By default, the Plan policy allows active safe built-ins such as `read`, limited `bash`, limited `powershell`, `grep`, `find`, and `ls`.
The optional native `powershell` tool must be active when an automatic Plan policy starts, for example through Pi's Windows `defaultTools` setting, unless its name was explicitly retained for first-request resolution.
Built-in `edit` and `write`, `update_plan`, tools still inactive at the first request, and deselected tools are blocked at execution time even though active schemas remain visible.
Extension and custom tools are denied by default because Pi tools do not expose standardized mutability metadata; explicitly allow a custom-tool name before starting only when you accept the risk.
For example, you can opt into `firecrawl_scrape`, `firecrawl_search`, or `lsp_diagnostics` when you want to use the effective active tool during planning.
An active selectable tool omitted from the Plan policy reports that it needs explicit selection through `/plan tools` or `defaultPlanTools` before the next workflow.
Registered but inactive, unregistered, metadata-free, and built-in blocked tools report their distinct fail-closed reasons instead of suggesting that every denial is a missing selection.
A tool admitted before later deactivation can be reactivated and reused in the current workflow without restarting.
After they become visible, the Plan-only helpers remain visible in Normal mode, but their handlers and the `tool_call` policy reject calls unless Plan mode owns the active workflow.

Limited `bash` uses a fail-closed Bash policy, including when an extension overrides the canonical `bash` tool name.
It accepts common inspection commands, read-only Git and npm queries, pipelines and command lists composed entirely of accepted commands, plus selected checks such as `npm test`, `npm run typecheck`, and `cargo test`.
It also accepts `cd`, read-only Windows diagnostics (`tasklist`, `where`, `hostname`, `ipconfig`, `netstat`, and `wmic` without the `call`/`create`/`delete`/`set` verbs), leading `VAR=value` environment assignments, bare glob patterns, and double-quoted variable references.
Stderr sinks `2>&1` and `2>`/`2>>` targeting `/dev/null` or `$null` are accepted.
Reviewed Git inspections may place `--no-pager` before the accepted subcommand.
They may also place one or more complete `-C <path>` pairs before the accepted subcommand only when every path is `.` or the exact current Pi working directory.
Other targets are rejected so `git -C` cannot introduce executable configuration, hooks, filters, signing programs, or lazy-fetch remotes from another repository.
It rejects output/input redirects, command substitution, brace expansion, subshells, background jobs, incomplete or directory-changing `-C` pairs, other Git global options, Git config overrides, mutating flags, dependency changes, editors, and unknown commands.

Limited `powershell` uses a separate fail-closed PowerShell policy, including when an extension overrides the canonical `powershell` tool name.
It accepts canonical inspection cmdlets such as `cd`, `Get-ChildItem`, `Get-Content`, `Get-Item`, `Get-Location`, `Get-Process`, `Get-Service`, `Resolve-Path`, `Select-String`, `Test-Path`, `Measure-Object`, `Sort-Object`, `Format-List`, `Format-Table`, `Out-String`, and `Write-Output`.
It also accepts the same reviewed `git` and configured `gh` queries as limited Bash, including pipelines and semicolon-delimited command lists composed entirely of accepted commands.
It rejects redirects, variables, substitutions, script blocks, call operators, type or method expressions, stop-parsing tokens, multiline input, non-ASCII quotation delimiters, aliases, mutating cmdlets, and unknown commands.
Use canonical cmdlet names because PowerShell aliases are intentionally outside the reviewed policy.

A rejected parsed command list or pipeline identifies its first blocked command segment; malformed or unsupported shell syntax reports the complete submitted input instead.
Tests and builds may still write ignored caches or build artifacts and may execute project-defined hooks; enable or invoke them only when the repository is trusted.
Both limited-shell policies reduce risk but do not provide an OS sandbox or confidentiality boundary.

## 🧭 Planning and implementation

`plan_mode_question` follows Codex's `request_user_input` pattern: the agent can ask 1-3 concise questions, each with meaningful options and a free-form Other path.
In TUI mode, a single question shows its header as plain muted text, submits as soon as its preset or custom answer is confirmed, and does not show tabs, Review, or question-navigation controls.
Add an optional note with `n` before confirming a single preset answer.
With two or three questions, one question appears at a time with question tabs and a final Review tab.
Use Tab, Shift+Tab, left, or right to visit any question or Review, including unanswered future questions.
Use up and down to choose an option, Enter to record it and advance, or `n` to record the highlighted option and open its optional note editor.
Press `n` again on an answered item to edit or clear its note.
Revisit a question to replace its answer; changing the chosen option clears its prior note.
Review lists every answer and note, blocks incomplete submission, and requires returning to a question to edit its answer or note.
Custom answers and notes retain their raw submitted text in the tool result, while terminal rendering is sanitized.
The TUI rejects either field above 4,000 characters instead of truncating it.
RPC keeps the existing sequential `select` and `editor` dialogs because Pi RPC cannot render custom TUI components.
If you cancel or no interactive UI is available, the agent should ask a concise plain-text question or proceed only with a clearly stated low-risk assumption instead of prematurely producing a final plan.

Pi identifies tools by tool name.
The pre-start selector stores accepted session policy names and shows each effective tool's source from Pi metadata, such as `built-in`, a user extension path, or a project extension path.
A selected name can run in Plan mode only when Pi has registered and activated the effective selectable tool by that workflow's first provider-bound context.
The allowlist freezes at that boundary, so a tool registered or activated later waits for the next Plan workflow.
If an extension overrides a built-in tool with the same name, Pi exposes the effective tool for that name and the selector shows that source.

A complete Plan mode answer should appear only after the agent has resolved discoverable facts and high-impact user decisions.
The agent must call `plan_mode_complete({ plan })` alone as its final action, passing the complete Markdown plan.
The tool rejects empty or whitespace-only plans and plans longer than 50,000 JavaScript characters; it does not truncate.
Its visible result contains the full plan, and versioned result details let the extension restore it safely from the active session branch.

`plan_mode_complete` uses Pi's `terminate: true` hint.
Termination is best effort: if a model puts it in a parallel tool batch, Pi terminates the batch early only when every finalized sibling tool also terminates.
The prompt therefore requires the completion call to be standalone and last.
The extension deliberately does not infer completion from phrases such as “I will present the plan,” and ordinary research or clarification turns never trigger automatic retries.
`/plan finalize` and its exact canonical finalization prompt are explicit recovery requests.
If one of those requests ends normally without a valid structured question or completed plan, Plan mode waits for `agent_settled` and retries once with stronger tool guidance.
A valid question, accepted completion, user cancellation, explicit exit, workflow supersession, reload, session replacement, or shutdown cancels the retry.
A second prose-only failure leaves Plan mode active, warns in interactive modes, and requires another explicit `/plan finalize` request.

Legacy sessions and models may still submit one non-empty `<proposed_plan>` block with tags on their own lines.
That compatibility path remains accepted, but it is not the primary workflow.
Empty, malformed, unclosed, or multiple legacy blocks keep Plan mode active and produce a warning.

After completion, `/plan` opens the ready actions when interactive UI is available.
The same flat menu shows **Implement here** and **Start fresh and implement**, explains which conversation context each choice uses, and previews the selected **Plan reinjection** policy.
**Implement here**—and the compatibility route `/plan implement`—appends the Normal contract, lifts the Plan runtime policy, captures the reinjection setting, and starts implementation in the current session with its complete planning conversation and tool calls.
**Start fresh and implement** waits for the source session to become idle, verifies the selected model and authentication, creates a new session linked to the persisted source as its parent, and transfers the exact approved plan without copying planning messages, tool results, or compaction/branch summaries.
The destination still loads its normal `AGENTS.md`, skills, project resources, and extensions.
Choosing **Export plan…** asks for a destination, writes the plan, appends the Normal contract, restores inherited thinking, and leaves Plan mode without starting a model turn or changing active tools.
Choosing **Save for later**—or running `/plan save`—instead stores one plan in the current Pi session before leaving Plan mode.

When a resumed active Plan workflow completes before `/plan` has run in that resumed session, the automatic menu cannot obtain Pi's command-only session replacement capability; choosing fresh asks you to reopen `/plan`, where the same action is available.
A successful fresh handoff does not delete or consume the source planning session.
Resume it later to inspect or hand off the ready/saved plan again; this deliberate duplication is the recovery path if the destination work is abandoned.
In-memory sessions create an unlinked fresh session because no parent file exists.
Escape, Ctrl+C, menu disposal, source replacement/shutdown, model/auth failure, or cancellation by another extension before replacement leaves the source plan unchanged.
Under **Off — conversation history only**, the destination receives the complete plan in its initial user prompt and does not persist active-plan state.
If that kickoff fails, the complete request remains in the destination editor and the source remains resumable.
Under either guaranteed-plan policy, the destination persists active-plan state before kickoff.
If guaranteed-plan persistence fails, the complete request is placed in the destination editor and the source remains resumable.
If a guaranteed-plan kickoff fails, the destination retains the active plan; send a message to continue, use `/plan exit` to clear it, or resume the parent planning session.

A saved plan appears as `plan saved` and remains available after reload, resume, branch-local fork, and compaction in that session.
It does not expire automatically, cross into a new session, or participate in ordinary model context.
Open `/plan` to Show, Implement here, Start fresh and implement, Export, open Settings, or Clear it; `/plan show`, `/plan implement`, `/plan export [path]`, and `/plan exit`/`off` retain their direct routes in TUI and RPC.
Fresh implementation checks idle state, the selected model, and authentication before session replacement; Implement here keeps its established preflight behavior.
Starting another workflow with `/plan start`, `/plan <prompt>`, or `/plan tools` is blocked until the saved plan is implemented or cleared, so the single saved slot is never silently overwritten.
Resuming that session keeps the plan saved; open `/plan` to review, implement, export, or clear it.
Cancellation or failed implementation preflight leaves it unchanged.

Text print and JSON modes cannot display the bare `/plan` menu and reject that route before changing state; use `/plan start` for direct no-prompt activation or `/plan <prompt>` to start planning with a prompt.
`/plan tools` also rejects before changing state because its staged selector requires TUI or RPC.
These modes can export any stored plan with `/plan export [path]`, save a ready plan with `/plan save`, and clear it with `/plan exit` or `/plan off`.
Successful export is observable through the created file; exporting a ready plan also leaves Plan mode, while saved and active implementation state remains unchanged.
An existing target or missing plan fails the command without changing state.
These modes reject saved-plan display and implementation before changing state because Pi provides neither printable custom-message output nor acknowledged extension-triggered turns; resume the session in TUI or RPC to show or implement it.

Both implementation paths apply the current **Plan reinjection** policy in their destination.
The default **Off — conversation history only** policy does not create active-plan state or inject a hidden plan context.
Implement here sends `Implement the plan.` and leaves the accepted plan in ordinary planning history.
Start fresh and implement, or implementing a saved plan here, puts the complete plan in one ordinary initial user prompt because no reliable planning conversation is present.
Later model calls then rely on Pi's normal conversation history and compaction behavior.
**Through first implementation run** guarantees the exact plan throughout that run, including retries, compaction retries, and queued continuation, then clears active-plan state at `agent_settled`.
**Until manually cleared** guarantees the exact plan across later turns, resume, and manual or automatic compaction until `/plan exit` or supersession.
The guaranteed policies avoid a duplicate context block while the original implementation handoff remains available and inject one hidden canonical copy after that handoff is compacted away.
Reinjection can consume up to the existing 50,000-character plan limit in model context.
Cleanup is bound to the matching implementation, so an older run settling cannot clear a newer handoff.

While a guaranteed plan is active, `/plan show` displays the accepted plan.
Interactive `/plan` offers Show, Export plan…, Settings, Start a new plan, and Clear; `/plan exit` and `/plan off` are the direct clear routes.
Settings changes never alter the policy already captured by an active guaranteed-plan implementation.
Automatic first-run cleanup removes the active status and future injected context after the triggering implementation run has received the complete plan.
Starting a new Plan-mode workflow or implementing a replacement plan supersedes an active guaranteed plan.
The extension deliberately does not infer completion from assistant prose or agent settlement under **Until manually cleared**, so clear the active plan when it no longer applies.
Under **Off — conversation history only**, implementation messages remain ordinary conversation history and there is no active plan for `/plan exit` to remove.
Choosing Stay before implementation keeps the plan ready.
Revision feedback starts another Plan-mode turn and clears the previous implementable plan until an updated completion arrives.
For clarification-only follow-ups, the agent answers and resubmits the complete unchanged plan so it remains implementable.
Before saving or implementation, exit/off discards the ready plan and removes its completion result from later non-Plan model context.

While Plan mode is enabled, the extension also publishes a compact status for Pi statuslines.
With `@narumitw/pi-statusline`, this appears in the extension status area:

- `plan active`: Plan mode is enabled and still gathering context or drafting a plan.
- `plan ready`: A completed plan is stored until you implement it, export it, save it, continue planning, or exit Plan mode.
- `plan saved`: One completed plan is stored outside model context in the current session until you implement or clear it.
- `plan implementing`: The exact accepted plan is guaranteed under **Through first implementation run** or **Until manually cleared**.

You can also exit directly.
Before implementation, direct exit discards the latest proposed plan; while a plan is saved, it clears that saved plan.
During a guaranteed-plan implementation, it removes both the original implementation handoff and the extension's canonical active-plan block from later model calls; an earlier Pi-generated compaction summary may still describe prior work:

```text
/plan exit
```

## 🧱 Cache-stable mode transitions

Plan and Normal requests share one append-only conversation.
The extension appends one hidden, model-visible, versioned Plan contract before the first Plan prompt and one Normal contract before the first post-Plan Normal or implementation prompt.
Ordinary linear turns do not rewrite or duplicate these contracts.
**Implement here** retains the Plan dialogue, structured questions, tool calls, completion evidence, and `Implement the plan.` kickoff in order.
**Start fresh and implement** is the isolation path and transfers only the approved plan plus the Normal contract to a linked session.

The `context` hook filters repeated legacy `plan-mode-context` artifacts but preserves current transition messages.
If compaction removes the effective transition, the hook inserts one canonical fallback at a deterministic retained-history boundary.
Repeated transforms leave that fallback in place instead of moving it to the newest turn.
An inactive legacy state entry does not inject a Normal contract, so sessions that never entered Plan mode keep their ordinary context after resume or reload.
Manual `/tree` navigation restores branch-owned Plan state and chooses the matching contract without navigating or adding a branch summary.
Pi lists hidden transition messages in `/tree`; Plan mode rejects those internal targets, so select an adjacent conversation entry.

Plan mode registers `plan_mode_question` and `plan_mode_complete` once and keeps their names and definitions stable across Normal, Plan, ready, implementation, and restored workflows.
Visible helpers do not mean `/plan` is active, and their descriptions exclude ordinary planning, the `writing-plans` skill, roadmaps, checklists, and plan-file work.
Only the latest active Plan contract authorizes the helpers; inactive or stale calls fail without accepting a plan or opening question UI.
Plan mode does not widen a restrictive active-tool policy; start or restore fails when a required helper is unavailable.
Stable schemas preserve a cache-eligible prefix but cannot guarantee a hit because provider serialization, cache lifetime, minimum prefix size, implementation details, and session affinity remain external.

The default `thinkingLevel: "inherit"` avoids a Plan-specific reasoning-parameter change.
A fixed Plan thinking level remains supported, but changing reasoning parameters can prevent provider-side state reuse even when prompts and tool schemas stay stable.

## 🤝 Workflow coexistence

Plan mode is independently installable and keeps its standalone behavior when no other protocol participant is present.
On the characterized Pi `0.84.2` runtime, it participates in the anonymous `workflow:mutex:v1` `agent-workflow` group.
It holds the group while Planning is active, while a completed plan awaits review, and while revision is underway.
Saved plans and ordinary implementation after Plan handoff do not hold the group.

Every inactive start performs one final synchronous admission after asynchronous preflight and before changing Plan state, persistence, prompts, tools, thinking level, queues, or status.
If another participant is active, TUI and RPC show an anonymous warning that another workflow is active.
Print and JSON direct routes throw the same anonymous error before mutation.
Launch-menu, selected-tool, shortcut, active-implementation **Start a new plan**, and restored activation use the same admission boundary.
A rejected selected-tool launch does not save its draft choices.

Restored active Plan state acquires before restoring restrictive tools, thinking, status, or model hooks.
If restoration is busy, Plan mode stays non-running, leaves persisted history and active tools untouched, and requires a later reload or explicit new start after the other workflow ends.
Planning-session cancellation during a fresh implementation preflight keeps the source Plan and its ownership.
Successful session replacement relies on source-session shutdown to clean up and release; the destination's ordinary active implementation does not acquire the Plan mutex.

The coexistence guarantee is cooperative and applies only when every contender implements v1 on the characterized Pi runtime and shares its event bus and session-manager identity.
A pre-v1, mixed-version, non-participating, forked, or otherwise uncharacterized counterpart remains unsupported for mutual exclusion.
Plan mode does not identify, inspect, configure, start, stop, or depend on another extension.
Guaranteed coexistence with Goal requires `@narumitw/pi-goal` `0.53.0` or newer and this package at `0.52.0` or newer on the characterized Pi `0.84.2` runtime.

| Installation | Support |
| --- | --- |
| Plan mode without another workflow participant | Supported standalone behavior |
| Plan mode `>=0.52.0` with Goal `>=0.53.0` on Pi `0.84.2` | Workflow Mutex v1 coexistence guarantee |
| Either package below its floor, or another Pi runtime | Standalone behavior only; mutual exclusion unsupported |

## 🛠️ Tools

- `plan_mode_question` asks up to three structured questions, supports optional answer notes, submits one answer directly, and reviews multiple answers before TUI submission.
- `plan_mode_complete` records the complete approved Markdown plan and terminates the planning turn when called alone.

## ⚙️ Settings

Open **Settings** from an inactive `/plan` menu to edit **Plan thinking**, **Plan policy tools**, **Plan reinjection**, **Export destination**, and **Plan mode shortcut**.
You can also edit `$PI_CODING_AGENT_DIR/pi-plan-mode.json` (normally `~/.pi/agent/pi-plan-mode.json`) manually.
`safeSubcommands` is JSON-only.
The optional file is read at session start, watched for changes, and created only by an explicit Settings save or manual edit.
The shortcut is disabled when `toggleShortcut` is omitted.
```json
{
  "thinkingLevel": "inherit",
  "defaultPlanTools": ["read", "bash", "grep", "find", "ls"],
  "implementationPlanRetention": "clear-on-start",
  "defaultPlanExportPath": "PLAN.md",
  "safeSubcommands": {
    "git": ["status", "log", "rev-parse", "blame"],
    "gh": ["pr view", "pr list", "issue view", "issue list"]
  },
  "toggleShortcut": "<your_key>"
}
```

### Plan helper tools

Plan helper schemas are stable from extension registration onward, and Plan mode does not call `setActiveTools()`.
Tool visibility alone is not Plan activation.
Only the latest effective active Plan contract authorizes `plan_mode_question` or `plan_mode_complete`; ordinary planning and the `writing-plans` skill use their own workflow instead.
The retired `toolVisibility` key is ignored and preserved as unknown data when another setting is saved or a legacy settings file is migrated.

### Default Plan policy tools

`defaultPlanTools` defines the initial runtime allowlist when a session has no stored pre-start selection.
Omit it—or choose **Use automatic safe built-ins**—to allow already-active safe built-ins by default.
An explicit empty array appears as **No optional tools** and denies every ordinary tool while the required helpers remain callable in Plan mode.
Neither setting changes model-visible tool schemas.

Tool names must be non-empty strings; duplicates are removed in first-seen order.
Explicit configured or session-selected names remain policy intent when their tool is unknown or inactive, but Plan mode never registers or activates them.
The inactive menu takes a fresh registered and active tool snapshot each time it opens, while an already open picker does not update in place.
At the workflow's first provider-bound context, after every `before_agent_start` handler has settled, Plan mode resolves retained names against Pi's live registered and active tools and freezes the executable allowlist.
Automatic defaults recheck the effective source metadata at that boundary, so a custom override of a safe built-in name still requires explicit opt-in.
The resolved allowlist persists with the active workflow and restores without reopening the resolution boundary after reload, resume, or tree navigation.
Unknown, inactive, and Plan-mode-blocked names remain unavailable after that resolution, and a later registration or activation waits for the next Plan workflow rather than a new session.
Settings shows unresolved names as pending registration; resetting to automatic removes the entire override.
Non-built-in names in this global setting are an explicit user-risk opt-in, just like selecting them in the pre-start workflow selector.
Plan mode does not interpret a selected custom tool's arguments or actions: allowing one trusts the whole effective tool.
Pi resolves tools by name, so if an extension overrides a built-in name, the effective extension tool is selected instead.
An effective active tool named `bash` or `powershell` remains subject to its limited-shell policy regardless of its source metadata.

A selection accepted through **Choose tools, then start…** or `/plan tools` is stored in that Pi session and takes precedence over `defaultPlanTools` when the session resumes.
The global setting remains the policy baseline for fresh sessions and sessions without an explicit selection.
Settings saves immediately, but saved policy names and thinking apply only when a later Plan workflow starts; they never mutate active schemas or a workflow already in progress.

### Plan reinjection

The stable JSON field `implementationPlanRetention` controls whether and how long the `context` hook restores the exact approved plan when ordinary model context no longer contains it.
Omit it or use `clear-on-start` for **Off — conversation history only**, the default Codex-like behavior with no active-plan state or hidden context injection.
In the planning session, this policy sends `Implement the plan.` and relies on the accepted plan already present in ordinary conversation history.
A fresh session or saved-plan implementation instead places the complete plan in one ordinary kickoff prompt because its planning history is unavailable or intentionally excluded.
Use `clear-after-first-run` for **Through first implementation run** to guarantee the exact plan until that implementation's first fully settled run ends.
Use `keep` for **Until manually cleared** to guarantee and reinject the exact plan until `/plan exit` or supersession.
A resumed guaranteed-plan cleanup policy re-arms against the first context in the replacement session.
Failed handoff delivery restores the ready or saved plan and does not run automatic cleanup.

Changing this setting applies to the next Implement action only.
Each guaranteed-plan implementation stores its effective policy, so a later Settings save cannot shorten or extend an implementation already in progress.
Conversation-history-only implementation has no active Plan-mode state to show, export, or clear after kickoff.

### Export destination

`defaultPlanExportPath` controls only exports that omit a path.
Omit it—or submit an empty value in Settings—to use `PLAN.md`.
The value must be a non-empty string of at most 4,096 characters without terminal control characters or NUL.
Relative values are resolved against the current working directory at export time; the Settings detail and every export input preview the concrete resolved destination.
An explicit `/plan export <path>` is a one-off override and does not edit Settings.
Saving a new destination affects the next export immediately, including export of a currently active implementation.

The existing no-overwrite, cancellation, and atomic Plan-state behavior is unchanged.
A failed save rolls the row back to its previous value; a failed or cancelled export preserves the plan and target.
Long previews wrap or truncate to the available terminal width without changing the raw path used by the action.

### Toggle shortcut

`toggleShortcut` controls the global Plan-mode keybinding used by the TUI shortcut.
Omit this setting to keep the shortcut disabled.
Set `toggleShortcut` to the key string you want.
Avoid values that conflict with editor shortcuts.

### Safe shell subcommands

`safeSubcommands` adds reviewed command validators to limited `bash` and `powershell`; it is not a raw shell allowlist.
Only the following exact values are accepted:

- `git`: `status`, `log`, `diff`, `show`, `branch`, `remote`, `ls-files`, `grep`, `rev-parse`, `blame`, `describe`, `merge-base`, `ls-tree`, and `cat-file`.
- `gh`: `pr view`, `pr list`, `issue view`, and `issue list`.

The first eight Git validators are built in and remain enabled when omitted, so listing them is valid but redundant.
The other six Git validators and every `gh` path require an explicit opt-in.
Git entries select one exact subcommand; `gh` entries select one exact two-word path, so `"pr view"` never enables `pr merge`, `pr close`, or `pr edit`.
Omitted `safeSubcommands`, an empty object, and empty arrays preserve the default policy.
Duplicate values are removed in first-seen order.

With the example configuration above, commands such as these are accepted:

```bash
git -C . status --short
git rev-parse --show-toplevel
git blame -- src/plan-mode.ts
git diff --cached
git show --stat --oneline HEAD
git log -p -1 HEAD -- src/plan-mode.ts
git -C . diff --check
gh pr view 218 --json number,title,state
gh issue list --state open --json number,title,state
```

The command-specific validators still reject unsafe forms, including:

```bash
git -C
git -C packages/pi-plan-mode status --short
git -C packages -C .. status --short
git -c core.fsmonitor=false -C . status --short
git -C . checkout main
git blame --textconv -- src/plan-mode.ts
git cat-file --filters HEAD
git diff --ext-diff
git log --show-signature -1
git remote show origin
git show --textconv HEAD
gh pr merge 218
gh pr view 218
gh pr view 218 --web
gh pr view 218 > pr.txt
gh pr list --json number,title && gh pr merge 218
```

Redirects, shell expansion and substitution, explicit pager or browser requests, explicit external diff/textconv/filter/signature helpers, output flags, malformed command layouts, and any chain containing an unsafe segment fail closed.
Read-dominant Git validators accept ordinary inspection flags without requiring `--no-textconv` or `--no-ext-diff`; Git may therefore invoke a helper configured by the user or trusted repository even when the command does not request one explicitly.
Use the negative flags when you want to suppress those configured helpers.
Mixed read/write surfaces remain narrower: use `git remote show -n` to avoid invoking a transport helper, while mutating `branch` and `remote` forms remain blocked.
GitHub CLI read paths require `--json <fields>` output so Plan mode does not rely on `GH_PAGER`, `PAGER`, or gh pager configuration.
Unknown `safeSubcommands` keys or values, non-array values, and non-string entries invalidate the entire settings file and trigger the normal warning/default fallback on session start.

Read-only does not mean private: Git inspection can expose repository history and tracked secrets, while `gh` queries can expose remote repository, pull request, and issue data available to your authenticated account.
A `git -C <path>` inspection is accepted only when the path keeps Git in Pi's current working directory.
The policy reduces accidental mutation and cross-repository executable configuration; it is not a sandbox or a confidentiality boundary.

### Thinking level

Plan mode inherits Pi's current thinking level by default.
Set `thinkingLevel` to request a fixed level only while Plan mode is active.
Supported values are `inherit`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
The extension snapshots the prior level and restores it on exit only if the level still matches the value it applied; a manual change made during Plan mode is preserved.
A Settings save does not change Pi's current or default thinking level and takes effect only when the next Plan workflow starts.

Settings saves are serialized in invocation order inside one Pi process.
Each save re-reads the latest valid document, preserves unknown top-level fields and unedited `safeSubcommands`, then publishes through a same-directory temporary file and rename.
A missing file stays absent until an explicit save.
Invalid JSON, invalid values, oversized content, non-regular files, and read failures make Settings read-only; the existing bytes and previous effective settings remain.
This in-process queue is not a cross-process lock, so concurrent separate Pi processes can still race.

Invalid settings produce a warning and fall back to inherited thinking, available safe-built-in tool defaults, `clear-on-start`, and `PLAN.md`.
Compatibility: a valid legacy `plan-mode.json` remains readable with a warning and is never modified automatically.
If Settings is explicitly saved while only that legacy file exists, the extension creates canonical `pi-plan-mode.json` from the complete legacy document, applies the selected change, preserves unknown fields, and leaves the legacy file untouched.
If both files exist, the canonical filename takes precedence.

## 🧠 Codex-like behavior

This extension maps Codex's `ModeKind::Plan` behavior onto Pi's extension API:

- Plan mode is conversational collaboration, not TODO or progress tracking.
- `/plan <prompt>` enters Plan mode before submitting the prompt.
- The agent uses `plan_mode_question` for material preferences and completes with a standalone `plan_mode_complete` call instead of prose detection.
- `update_plan` is blocked until the explicit implementation boundary restores Normal mode.
- The default `clear-on-start` policy uses conversation history; `clear-after-first-run` and `keep` add exact-plan guarantees.
- Append-only Plan and Normal contracts keep helper schemas stable, but Pi's tool policy is risk reduction rather than Codex sandbox enforcement.

## 🗂️ Package layout

```txt
packages/pi-plan-mode/
├── dist/                  # Generated TypeScript runtime loaded by Jiti
├── scripts/
│   └── build-runtime.mjs  # Deterministic runtime builder and boundary validator
├── src/
│   ├── index.ts           # Thin Pi package entrypoint
│   ├── plan-mode.ts      # Extension registration, mode state, and UI loading boundary
│   ├── interactive-ui.ts # Lazily loaded interactive menu surface
│   └── *.ts              # Package-local prompt, policy, question, and message modules
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

`index.ts` is the Pi entrypoint and forwards to `plan-mode.ts`; the other source modules are internal.
The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./dist/index.ts"]
  }
}
```

The generated runtime is built from the authoritative `src/index.ts` graph and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, plan mode, Codex-like plan mode, AI coding workflow, read-only planning, implementation plan.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
