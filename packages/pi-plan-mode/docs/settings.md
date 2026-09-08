# Pi Plan Mode settings reference

[Back to README](../README.md)

- [Default Plan policy tools](#default-plan-policy-tools)
- [Plan reinjection](#plan-reinjection)
- [Export destination](#export-destination)
- [Toggle shortcut](#toggle-shortcut)
- [Safe shell subcommands](#safe-shell-subcommands)
- [Thinking level and persistence](#thinking-level)

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

`safeSubcommands` maps any command prefix to subcommand prefixes that the user chooses to trust completely in limited `bash` and `powershell`.
For example, `"kubectl": ["get", "apply"]` trusts commands beginning with `kubectl get` or `kubectl apply`, while `"npm": ["run inspect-custom"]` trusts commands beginning with `npm run inspect-custom`.
Command keys and subcommand entries are trimmed and must be non-empty strings.
Matches are literal and case-sensitive after leading whitespace in the submitted command is ignored.
A match requires the complete `<command> <subcommand>` prefix followed by whitespace, a shell control operator, or the end of the submitted command, so `"kubectl": ["apply"]` does not match `kubectl applies`.
Duplicate values and command keys that become equal after trimming are merged in first-seen order.
Omitted `safeSubcommands`, an empty object, and empty arrays preserve the default policy.

When a configured prefix matches, Plan mode permits the complete submitted command without parsing or applying any command, argument, mutation, chain, redirect, expansion, substitution, multiline, or PowerShell syntax checks.
For example, `"kubectl": ["apply"]` also permits `kubectl apply -f deployment.yaml && rm -rf build`.
Likewise, `"gh": ["pr view"]` permits `gh pr view 218 --web`, `gh pr view 218 > pr.txt`, and any trailing shell content.
The setting therefore delegates the complete shell decision to the user and can allow arbitrary code execution with Pi's permissions.
It is not a sandbox, confirmation gate, or read-only guarantee.
Choose entries that are as specific as your workflow permits, and configure them only for commands and repositories you fully trust.

Commands that do not match still use the built-in fail-closed reviewed policy.
That default policy includes Git `status`, `log`, `diff`, `show`, `branch`, `remote`, `ls-files`, and `grep`, with command-specific argument checks.
It rejects output and input redirects, shell expansion and substitution, explicit pager or browser requests, explicit external diff, textconv, filter, or signature helpers, mutating flags, malformed command layouts, and any parsed chain containing an unsafe segment.
Read-dominant Git validators accept ordinary inspection flags without requiring `--no-textconv` or `--no-ext-diff`; Git may therefore invoke a helper configured by the user or trusted repository even when the command does not request one explicitly.
Use the negative flags when you want to suppress those configured helpers.
Mixed read/write surfaces remain narrower: use `git remote show -n` to avoid invoking a transport helper, while mutating `branch` and `remote` forms remain blocked unless explicitly trusted through `safeSubcommands`.

Read-only does not mean private: Git inspection can expose repository history and tracked secrets, while configured commands can expose or modify any data available to Pi's process.
A built-in-policy `git -C <path>` inspection is accepted only when the path keeps Git in Pi's current working directory.
The default policy reduces accidental mutation and cross-repository executable configuration; configured `safeSubcommands` bypass that protection.
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

Invalid settings produce a warning and fall back to inherited thinking, available safe-built-in tool defaults, `clear-on-start`, and `PLAN.md`.
Compatibility: a valid legacy `plan-mode.json` remains readable with a warning and is never modified automatically.
If Settings is explicitly saved while only that legacy file exists, the extension creates canonical `pi-plan-mode.json` from the complete legacy document, applies the selected change, preserves unknown fields, and leaves the legacy file untouched.
If both files exist, the canonical filename takes precedence.
