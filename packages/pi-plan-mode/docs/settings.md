# Pi Plan Mode settings reference

[Back to README](../README.md)

- [Default Plan policy tools](#default-plan-policy-tools)
- [Enable inactive built-in search tools in Pi](#enable-inactive-built-in-search-tools-in-pi)
- [Plan reinjection](#plan-reinjection)
- [Fresh implementation runtime](#fresh-implementation-runtime)
- [Auto model switch](#auto-model-switch)
- [Export destination](#export-destination)
- [Toggle shortcut](#toggle-shortcut)
- [Safe shell subcommands](#safe-shell-subcommands)
- [Thinking level and persistence](#thinking-level)

## ⚙️ Settings

Run `/plan settings` or open **Settings** from an inactive `/plan` menu to edit **Plan thinking**, **Plan policy tools**, **Plan reinjection**, **Fresh model**, **Fresh thinking**, **Export destination**, **Plan mode shortcut**, **Auto switch model**, **Plan enter model**, and **Plan exit model**.
You can also edit `$PI_CODING_AGENT_DIR/pi-plan-mode.json` (normally `~/.pi/agent/pi-plan-mode.json`) manually.
`safeSubcommands` is JSON-only.
The optional file is read at session start, watched for changes, and created only by an explicit Settings save or manual edit.
The shortcut is disabled when `toggleShortcut` is omitted.
```json
{
  "thinkingLevel": "inherit",
  "defaultPlanTools": ["read", "bash", "grep", "find", "ls"],
  "implementationPlanRetention": "clear-on-start",
  "defaultImplementationModel": {
    "provider": "anthropic",
    "modelId": "claude-sonnet-4-5"
  },
  "defaultImplementationThinkingLevel": "high",
  "autoSwitchModel": false,
  "planModel": {
    "provider": "anthropic",
    "modelId": "claude-opus-4-1"
  },
  "normalModel": {
    "provider": "anthropic",
    "modelId": "claude-sonnet-4-5"
  },
  "defaultPlanExportPath": "PLAN.md",
  "safeSubcommands": {
    "git": ["rev-parse", "blame"],
    "gh": ["pr view", "issue list"],
    "kubectl": ["get", "apply"],
    "npm": ["run inspect-custom"]
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
At the workflow's first provider-bound context, after every `before_agent_start` handler has settled, Plan mode resolves retained names against Pi's live registry, exposure, and active declarations and freezes the executable allowlist.
Automatic defaults recheck the effective source metadata at that boundary, so a custom override of a safe built-in name still requires explicit opt-in.
The resolved allowlist persists with the active workflow and restores without reopening the resolution boundary after reload, resume, or tree navigation.
Names unavailable at resolution wait for the next Plan workflow rather than a new session.
An admitted tool may be reactivated or declared later without widening that frozen policy, but current hidden exposure still blocks it.
Settings shows unresolved names as pending registration; resetting to automatic removes the entire override.

Direct and `model-only` tools must be active; registered `codemode` or `deferred` tools can be selected without direct activation.
MCP `codemode-deferred` is represented as public exposure `deferred`.
`model-only` tools cannot run as nested calls; hidden and unsupported exposure remain unavailable regardless of active declarations or saved names.
Missing exposure on older Pi versions retains the direct-tool behavior.
Native MCP tools and orchestration tools require explicit opt-in just like other tools outside the reviewed core policy; server annotations never grant permission.
For example, `"defaultPlanTools": ["read", "codemode", "mcp__docs__read"]` permits that MCP tool through an already-active `codemode` orchestrator.
Selecting either tool does not enable the other, and every nested call needs its own Plan-policy admission.
Pi's `tool_search` can declare a tool without restarting an admitted workflow, but cannot add an unselected name to its frozen Plan policy.

Allowing a custom tool trusts its effective implementation; Plan mode does not infer its side effects from arguments or annotations.
Pi resolves tools by name, so if an extension overrides a built-in name, the effective extension tool is selected instead.
Names `edit`, `write`, and `update_plan` stay blocked, and `bash` or `powershell` stays subject to its limited-shell policy, including nested calls and regardless of source metadata.

A selection accepted through **Choose tools, then start…** or `/plan tools` is stored in that Pi session and takes precedence over `defaultPlanTools` when the session resumes.
The global setting remains the policy baseline for fresh sessions and sessions without an explicit selection.
Settings saves immediately, but saved policy names and thinking apply only when a later Plan workflow starts; they never mutate active schemas or a workflow already in progress.

### Enable inactive built-in search tools in Pi

Pi's default selection leaves the registered built-ins `grep`, `find`, and `ls` inactive.
Settings and `/plan tools` label these rows **inactive in Pi**, not **blocked by Plan policy**.
Pi controls tool activation; `defaultPlanTools` only grants Plan-mode execution permission and never activates tools.
Built-in `edit` and `write` remain policy-blocked even when active in Pi.

Change the Pi settings used by the current session, **not** `pi-plan-mode.json`.
For the CLI, the user file is normally `~/.pi/agent/settings.json`, or `$PI_CODING_AGENT_DIR/settings.json` when configured.
SDK hosts can use a different `agentDir` or a custom or in-memory `SettingsManager`; ask the host which settings source and restart procedure apply rather than assuming the CLI path.
The picker cannot determine that source and does not display a concrete Pi settings path.

**Full selection (including Pi releases before 0.99 with `defaultTools`):** plain names replace the defaults.
If you use Pi's normal defaults, this full list preserves them and adds the search tools:

```json
{
  "defaultTools": ["read", "bash", "edit", "write", "grep", "find", "ls"]
}
```

If you already have a plain-name `defaultTools` list, add `"grep"`, `"find"`, and `"ls"` to it instead of replacing your custom selection with this example.

**Additive selection (Pi 0.99 or newer only):** `+name` and `-name` modifiers change the inherited selection.
With no existing `defaultTools`, use:

```json
{
  "defaultTools": ["+grep", "+find", "+ls"]
}
```

On Pi 0.99+, append these modifiers to an existing non-empty `defaultTools` array to preserve custom inclusions and exclusions.
If your existing list is `[]`, use plain names `["grep", "find", "ls"]` to enable only the search tools; a modifier-only list would restore the inherited defaults too.
Do not use modifiers on older releases: they treat them as exact names and can disable the normal built-in tools.
Preserve unrelated settings in either setup.
Releases without `defaultTools` need an upgrade for this setup; the extension's older-Pi compatibility is unchanged.
Restart Pi, then reopen `/plan settings` → **Plan policy tools** or `/plan tools` and select the tools if your Plan policy does not already allow them.
CLI tool allowlists/exclusions can override this setting, and trusted project settings can affect the effective selection.
If the rows remain inactive, check those overrides before changing Plan policy.
Custom tools and overrides of built-in names still require explicit Plan-policy opt-in; this setup does not bypass blocked policy, hidden exposure, or missing registration.

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

### Fresh implementation runtime

Omit `defaultImplementationModel` and `defaultImplementationThinkingLevel` to use **same as plan**, the default.
A configured model is an object with non-empty `provider` and `modelId` strings of at most 512 characters each.
`defaultImplementationThinkingLevel` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; use omission rather than `inherit` for **same as plan**.
Choosing **Same as plan** in Settings removes the corresponding field.

The model picker snapshots the current session's scoped models when a non-empty scope exists, otherwise Pi's currently available models.
A configured model outside that catalogue remains stored but is ineffective for that handoff: Settings and the ready-plan fresh screen report that it is unavailable and fall back to the planning session model.
The preference becomes effective again if the model returns to the applicable catalogue.
This fallback also protects a persistent default that disappears while the ready-plan fresh screen is open.
Authentication and one-shot model races still use the normal fresh-handoff preflight and recovery behavior.

These persistent values seed each ready-plan **Start fresh and implement** screen, where either choice can be overridden once without changing Settings.
The saved-plan direct fresh action applies the persistent values without an extra picker and warns when its configured model falls back.
Changes save immediately and apply to later fresh implementation actions; an already open fresh-action screen keeps its own menu-local draft.
They never switch the planning session's current model or thinking level.

### Auto model switch

`autoSwitchModel` switches the session model at Plan-mode boundaries and is off by default.
`planModel` is the target when Plan mode starts; `normalModel` is the target when Plan mode ends: Plan exit, plan save, or an implementation started from an active Plan session.
Implementing a previously saved plan outside Plan mode is not a boundary and does not switch models.
Each model is an object with non-empty `provider` and `modelId` strings of at most 512 characters each, matching the `defaultImplementationModel` shape.
An omitted model leaves that direction unchanged, and a target that is already active is left untouched.

The switch applies Pi's normal model-change behavior and then restores the current thinking level, so `thinkingLevel`, per-model thinking overrides, and manual thinking changes are unaffected.
A target outside the current catalogue or without authentication keeps the current model and reports the fallback in a notification; the stored preference is not deleted.
Switching completes inside the transition before any request that transition starts, so a first implementation request already uses the selected model.
Fresh implementation sessions keep using their own **Fresh model** choice instead of these fields.

Changing these settings applies to later Plan transitions only.
Invalid values invalidate the settings document like every other field; a settings read failure falls back to no switching.
A transition that fails after switching restores the model that was active before the transition instead of a configured target.

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

`toggleShortcut` configures the Plan-mode toggle in TUI mode; it is disabled by default.
Set it to a Pi key identifier, or omit it to disable the shortcut on the next load.
Enabling, changing, or removing the shortcut requires `/reload` or restarting Pi, whether saved through Settings or edited in JSON.
The current binding stays unchanged until then; Settings shows the configured value separately from the value loaded at startup.
Pi snapshots shortcut registrations when binding the editor, so Plan mode registers once per extension runtime rather than attempting live rebinding.
Other settings retain their existing watched reload behavior, and `/plan` commands are unchanged.

Avoid conflicts with Pi or other extension shortcuts; the startup value is a registration preference, not a guarantee that Pi accepts it or the terminal sends that key combination.
Tree navigation and compaction do not apply pending shortcut changes.

### Safe shell subcommands

`safeSubcommands` maps command prefixes to subcommand prefixes that the user chooses to trust within individual parsed segments of limited `bash` and `powershell` commands.
For example, `"kubectl": ["get", "apply"]` trusts segments beginning with `kubectl get` or `kubectl apply`, while `"npm": ["run inspect-custom"]` trusts segments beginning with `npm run inspect-custom`.
Command keys and subcommand entries are trimmed and must be non-empty strings.
Matches are literal and case-sensitive after surrounding whitespace in each segment is removed.
A match requires the complete `<command> <subcommand>` prefix followed by a token boundary, so `"kubectl": ["apply"]` does not match `kubectl applies`; extra whitespace or quotes inside the prefix do not match.
Duplicate values and command keys that become equal after trimming are merged in first-seen order.
Omitted `safeSubcommands`, an empty object, and empty arrays preserve the default policy.

Plan mode parses the complete submission before considering any configured exemption.
Bash supports `&&`, `||`, `;`, and `|`; PowerShell supports `;` and `|`, not `&&` or `||`.
Every segment must either match its own configured prefix or pass the built-in reviewed policy, regardless of its position in the chain.
For example, `"kubectl": ["apply"]` permits `git status && kubectl apply -f deployment.yaml` but does not permit `kubectl apply -f deployment.yaml && rm -rf build` unless the second segment is also explicitly trusted.
Parser-unsupported syntax remains blocked even after a trusted prefix, including unquoted redirects, multiline input, and unquoted substitutions such as `kubectl apply $(cat generated-args)`.

A matching segment bypasses command and argument checks: `"gh": ["pr view"]` still permits `gh pr view 218 --web`, and `"kubectl": ["apply"]` still permits deployment changes.
Parser-accepted Bash arguments remain trusted, including variable expansion and double-quoted substitutions; an argument such as `"$(touch output)"` can itself execute code.
The setting can therefore allow arbitrary code execution with Pi's permissions within a trusted segment.
It is not a sandbox, confirmation gate, or read-only guarantee.
Choose entries that are as specific as your workflow permits, and configure them only for commands and repositories you fully trust.

**Migration from whole-command trust:** a configured prefix no longer exempts trailing commands or unsupported syntax.
Simple configured commands continue to work; for supported chains, each additional segment must be reviewed independently or explicitly trusted through its own narrow entry.
Run workflows requiring redirects, multiline input, or other unsupported syntax outside Plan mode after review rather than relying on the old bypass.
The JSON schema and settings file do not need migration.

Segments that do not match still use the built-in fail-closed reviewed policy.
That default policy includes Git `status`, `log`, `diff`, `show`, `branch`, `remote`, `ls-files`, and `grep`, with command-specific argument checks.
It rejects output and input redirects, shell expansion and substitution, explicit pager or browser requests, explicit external diff, textconv, filter, or signature helpers, mutating flags, malformed command layouts, and any parsed chain containing an unsafe segment.
Read-dominant Git validators accept ordinary inspection flags without requiring `--no-textconv` or `--no-ext-diff`; Git may therefore invoke a helper configured by the user or trusted repository even when the command does not request one explicitly.
Use the negative flags when you want to suppress those configured helpers.
Mixed read/write surfaces remain narrower: use `git remote show -n` to avoid invoking a transport helper, while mutating `branch` and `remote` forms remain blocked unless explicitly trusted through `safeSubcommands`.

Read-only does not mean private: Git inspection can expose repository history and tracked secrets, while configured commands can expose or modify any data available to Pi's process.
A built-in-policy `git -C <path>` inspection is accepted only when the path keeps Git in Pi's current working directory.
The default policy reduces accidental mutation and cross-repository executable configuration; configured `safeSubcommands` bypass command and argument protection only within matching segments.
A non-object `safeSubcommands`, empty command or subcommand string, non-array value, or non-string entry invalidates the entire settings file and triggers the normal warning/default fallback on session start.

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

Invalid settings produce a warning and fall back to inherited Plan thinking, available safe-built-in tool defaults, `clear-on-start`, same-as-plan fresh runtime choices, and `PLAN.md`.
Compatibility: a valid legacy `plan-mode.json` remains readable with a warning and is never modified automatically.
If Settings is explicitly saved while only that legacy file exists, the extension creates canonical `pi-plan-mode.json` from the complete legacy document, applies the selected change, preserves unknown fields, and leaves the legacy file untouched.
If both files exist, the canonical filename takes precedence.
