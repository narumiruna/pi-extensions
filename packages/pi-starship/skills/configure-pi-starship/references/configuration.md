# Configuration and Format Reference

Use this authoritative public reference for configuration location and persistence, presets, complete-document examples, format grammar, styles, palettes, content-selected styles, and state-selected styles.

## ⚙️ Settings

The only configuration source is:

```text
<getAgentDir()>/pi-starship.toml
```

When this file is absent, the extension uses Pi's native footer without creating the file or its parent directory.
The built-in Starship example remains an editing seed; saving it enables a Starship footer, not Pi's native footer.
Its root is the explicit sequence `$brand$model$thinking$directory` `$git_branch$git_status$activity$context$time`; it does not start the opt-in GitHub PR query.
The first successful settings save creates the file atomically.
Existing malformed documents are never overwritten.

The extension does **not** read project overrides, `pi-statusline.json`, `PI_STATUSLINE_PRESET`, or `~/.config/starship.toml`, and does not migrate statusline settings.

Open the interactive menu in TUI mode:

```text
/starship
```

Choose **Configure with agent** for edits and explanations.
The compatibility command `/starship settings` retains the raw TOML editor.
Closing the editor validates the draft and opens a scrollable preview with **Apply changes…**, **Continue editing**, and **Discard draft**.
Saving requires separate confirmation, then atomically updates the file and active footer.
Manual TOML edits load at the next `session_start`, including `/reload` and session replacement.
Cancellation, disposal, invalid drafts, write failures, and runtime application failures preserve the previous file and footer.

Choose **Configure with agent** for a separate, temporary configuration conversation with the bundled skill and `read`, `write`, and `edit` tools.
The agent can write only its private draft, not the active settings file; validated mutations update the preview without `/reload`, and invalid mutations retain the last valid preview.
Reads cover immutable disk and loaded-document snapshots, normalized active public TOML, source/path/health/diagnostics, module inspection, the private draft, and bundled skill/source documents; the draft is limited to 64 KiB.
These read-only documents are fixed at chat opening and do not change with draft previews or later runtime updates.
The disk baseline can differ from the loaded document after external edits; normalized TOML excludes comments, unknown fields, parser ASTs, and private selectors while preserving effective replacement order.
Module inspection includes states, current previews, reachability, variables, style-rule metadata, display rules, and reasons from existing runtime data without starting collectors.
When runtime inspection or loaded text is unavailable, report that limit instead of guessing.
The ordinary main-session skill has no live runtime access; direct active-state questions to this hosted chat.
The preview uses cached data without starting module commands or network requests.
During a response, normal submission queues steering for the next assistant turn; the configured app.message.followUp action queues work after natural completion and submits normally when idle.
The app.message.dequeue action restores pending messages to the editor; these message actions use Pi's native precedence, including explicit history bindings.
The configured cancel action stops a response and restores undelivered messages; when idle, it leaves the conversation open without opening a menu. Editor actions win cancel-key collisions, with Escape as a stop fallback unless assigned to an editor action.
Failed or aborted responses restore undelivered input without automatic restart.
Ctrl+C discards the flow, clears both queues, and restores the active footer unless its session was replaced.
When idle with a valid draft, Ctrl+S opens the Save draft as profile flow directly; its gray editor-border hint switches to F2 if Ctrl+S is reserved, or is omitted when both keys conflict.
Saving requires exact-draft review and a profile name; invalid or existing names are rejected without overwriting a profile.
After saving, the host asks whether to apply that profile through managed History and atomic replacement; declining keeps the profile without changing active settings.
Cancelling naming returns to the chat without saving; closing or session replacement removes the temporary draft, not any saved profile.
Application checks the initial disk snapshot, loaded revision, and saved profile identity, blocks detected concurrent changes, and warns before explicitly repairing an invalid original.
Chat content and settings read by the agent go to the selected model provider; the child uses the opening model/thinking selection with Pi authentication, has no shell tool, and does not persist its transcript or change the main conversation.
The fullscreen view uses Pi's native user/assistant/tool message components. Short gray status and control labels sit on the editor borders; the live preview ends at the terminal bottom, in the saved footer's position.
It shows recent output with expanded, read-only tool results; saving opens an exact-draft review.
Choose **Continue** to leave the save review; cancelling the review discards the flow without publishing.

Outside this hosted chat, the bundled `configure-pi-starship` skill uses a separate external-edit workflow.
Before its apply script replaces an existing document, it preserves the inspected document under `<getAgentDir()>/pi-starship/pi-starship-YYYYMMDDHHmm.toml`; these backups use local time and remain after a successful apply.
Backups are written and flushed under a private temporary name, atomically renamed to their final private file, and followed by flushes of the backup directory and its parent directory before publication continues; a recoverable failure removes the owned temporary file and preserves the active document.
If configuration publication fails after that backup is durable, the failure reports its retained path; cleanup failures report both their operation and cause without hiding the primary failure.
A missing document creates no backup, and a backup with the same minute name blocks publication when observed before rename; this check does not provide cross-process locking.
The interactive `/starship` flows do not invoke this script. They preserve replaced documents in the separate recovery history described below; existing skill backups remain available read-only in History.

The main menu orders **Configure with agent**, **Presets**, **Profiles**, **Configuration**, **Restore built-in…**, and **Help**.
Configuration shows state, source, settings path, health, and all current warnings above **Reload from disk…**, **Share settings as Gist…**, **Import settings from Gist…**, and **History**.
Configured selection page-up/page-down actions scroll the summary without moving the selected action; selection and cancellation bindings take priority when bindings conflict.
The focused action remains visible at small terminal heights; enlarge an extremely short terminal to read the summary.
Gist actions use `gh` authentication for github.com and transfer only `pi-starship.toml`, limited to 64 KiB; sharing includes comments and unknown fields and requires review and confirmation before creating an unlisted Gist.
Unlisted Gists are readable by anyone with the link; remove sensitive data before sharing, and check GitHub before retrying a cancelled or failed upload because a remote Gist may already exist.
Import accepts a Gist ID or URL, validates the complete document, requires raw TOML review, footer preview, and full-replacement confirmation, and preserves the previous document before applying; review untrusted settings for command execution and network access before accepting.
A missing file uses Pi's native footer, an exact bundled document uses its preset name, and read or parse errors are **Built-in fallback**.
Reload from disk reads only after the explicit action, validates and previews the current external state from the existing runtime snapshot, and asks for separate confirmation before changing the active session.
A deleted document is a valid previewable transition to Pi's native footer and creates no file.
An unchanged document is a no-op, while read or parse failure, cancellation, disposal, external changes after preview, session replacement, shutdown, or runtime apply failure preserves the prior effective footer and every file byte.
Reload re-reads immediately after confirmation and rejects a different external snapshot; it does not claim cross-process locking or continuing synchronization with later edits.
**Restore built-in…** remains in the main menu and is disabled only when no settings document exists.
A saved built-in Starship example is not Pi's native footer and can be restored.
Restore previews Pi's native footer and asks for confirmation before archiving the exact document bytes in History and removing the active settings document, including custom settings, unknown fields, and comments.
Invalid content is preserved through the explicit recovery path.

### Named profiles

Profiles are complete TOML documents saved under `<getAgentDir()>/pi-starship/profiles/<name>.toml`.
The active settings remain an independent copy at `<getAgentDir()>/pi-starship.toml`.
There is no active-profile pointer or live link: editing, renaming, or deleting a profile does not modify active settings.
The browser marks every profile whose exact bytes match the active document; identical profiles can all match.

Open **Profiles** to save the current document, browse saved documents, and manage the selected profile.
Selection previews the footer from existing runtime data without saving, creating history, starting collectors, running commands, or accessing the network.
Modules with no data in the current snapshot can be empty.
Display text removes terminal controls before layout and style rendering; generated colors and validated HTTP(S) hyperlinks remain supported without changing stored TOML.
Invalid documents show diagnostics, cannot be applied, and never silently preview the built-in fallback.
Documents with invalid UTF-8 remain visible and can be renamed, duplicated, or deleted without changing their bytes.
Repairing such a profile requires explicit confirmation before opening an empty text draft; only a validated save replaces its unreadable bytes.

**Edit TOML** uses a separate draft and validates it before saving.
The draft review offers saving only the profile, saving and applying it, continuing the edit, or discarding the draft.
Saving a profile and applying it are separate operations: application failure does not delete a successfully saved profile.
Applying requires confirmation and replaces the entire active document.
**Rename**, **Duplicate**, and confirmed **Delete** act only on the saved profile.
Preset and reviewed Gist candidates can also be saved as profiles without changing the active file.

New names are normalized to NFC and contain 1–80 Unicode code points, excluding path separators, terminal controls, leading dots, leading/trailing whitespace, and platform-reserved names or characters.
Encoded filenames must fit the filesystem limit, and names cannot collide without regard to case.
Invalid names are rejected, not silently rewritten; case-only renames are rejected unless supported safely.
Only regular files are used; package-owned storage directories and files cannot be symbolic links.
Comments, ordering, and unknown fields remain unchanged.

Escape returns one level; Ctrl+C closes the workflow.
Leaving a browser removes its temporary preview, while an already committed change remains active.
The native Pi editor has no public abort method; session cancellation removes the preview immediately and blocks stale saves, but an open editor can remain until it is closed.

### Recovery history

Managed active-file replacements preserve the previous document in `<getAgentDir()>/pi-starship/history/<timestamp>-<random-id>.toml` before writing the replacement.
Editor, configuration-chat save, preset, profile, restore, and Gist application use this policy.
A missing file or a byte-identical no-op creates no recovery copy.
Backup failure blocks replacement; runtime-application failure attempts guarded disk/runtime restoration and retains the backup.
A recovery copy can therefore come from an unsuccessful application attempt; it is not proof that a candidate was applied.

**Configuration** → **History** supports read-only review, preview and confirmed restore, saving valid content as a profile, and confirmed deletion of new history entries.
Legacy `pi-starship-YYYYMMDDHHmm.toml` skill backups remain in their existing directory and are read-only in History.
Malformed recovery content remains available for inspection; it cannot be applied without repair and validation.
History has no automatic pruning.

Explicit **Reload from disk** preserves the previous loaded document before changing the runtime, without rewriting the external file.
Ordinary `session_start`, including `/reload`, does not write history or materialize defaults.
Versions overwritten by an external editor before Pi observes them cannot be recovered automatically.

New directories and documents use private POSIX permissions (`0700` and `0600`).
Files are flushed before publication; directory-entry flushing is used on POSIX and is not available through the same API on Windows, so the same crash-durability guarantee is not claimed there.
Mutations preserve exact document bytes, use temporary files plus rename, and publish recovery before active-file replacement.
There is no atomic transaction across history, the active file, and the running footer.
Detected changes after review block the operation rather than overwrite the changed document.
In-process ordering and cooperative storage locking do not lock out external editors; external check-to-rename races remain possible.
A stale cooperative mutation lock is never removed automatically; after confirming no storage operation is running, inspect the reported lock path before removing it manually.

### 🎛️ Presets

Choose **Presets** from `/starship` to browse complete Pi-native starting points.
The catalog adapts all styles listed by `starship preset --list` in Starship 1.26.0, plus a Pi-specific Minimal option.
Colors, separators, typography, and layout follow the named Starship preset; modules are deliberately selected for Pi's model, thinking, workspace, Git, activity, context, and time snapshots.

| Preset | Adapted visual treatment | Font requirement |
| --- | --- | --- |
| **Minimal** | Compact Pi essentials | Standard Unicode |
| **Bracketed Segments** | Balanced Pi and Git information in brackets | Standard Unicode |
| **Catppuccin Powerline** | Connected Catppuccin Mocha blocks; other Catppuccin palettes remain in the document for customization | Nerd Font |
| **Gruvbox Rainbow** | Warm Gruvbox connected segments | Nerd Font |
| **Jetpack** | Airy geometric activity/context and workspace columns joined by fill | Standard Unicode |
| **Nerd Font Symbols** | Balanced default layout with icon-rich symbols | Nerd Font |
| **No Empty Icons** | Conditional text labels that cannot appear without their values | Standard Unicode |
| **No Nerd Font** | Portable Unicode symbols without private-use glyphs | Standard Unicode |
| **No Runtime Versions** | Presence indicators without model or thinking details | Standard Unicode |
| **Pastel Powerline** | Connected magenta, coral, orange, blue, teal, and navy blocks | Nerd Font |
| **Plain Text Symbols** | Plain words replace pictograms | Standard Unicode |
| **Pure Preset** | Clean two-line workspace and session context | Standard Unicode |
| **Tokyo Night** | Connected cool blue Tokyo Night blocks | Nerd Font |

Moving through the preset picker temporarily renders the selected preset in the footer without writing settings or starting collectors.
Press Enter to confirm replacement, press `e` to edit the selected complete TOML document before preview and confirmation, or use the displayed `s` save-as-profile action without applying.
Standard configured actions take precedence over these additive shortcuts; a conflicting shortcut is omitted from the hint.
Escape returns to the main menu, while Ctrl+C closes the workflow; both restore the active footer.

Presets are complete documents, not overlays.
After confirmation, applying one replaces all of `pi-starship.toml`, including custom settings, unknown fields, and comments; the previous document is retained in History.
Cancellation, disposal, validation failure, write failure, and runtime-apply failure preserve the previous document and footer.
An exact match is **Currently applied** and cannot be selected again; editing any byte makes it custom.
Use **Restore built-in…** for deterministic recovery.

The bundled presets use only pi-starship's local Pi and Git snapshot modules.
They do not enable the GitHub PR query, cloud/deployment readers, or optional command-backed workspace collectors.
They are Pi-native adaptations of the color and format treatments emitted by Starship 1.26.0; they do not copy Starship's module selections because Pi exposes different runtime information.
There is no `/starship preset` textual route and no remote preset download.

### 📝 Example

```toml
format = """
$brand\
$provider\
$model\
$thinking\
$directory\
$git_branch\
$git_status\
$activity\
$context\
$time"""

[model]
format = "[ $symbol$model ]($style)"
symbol = "◆ "
style = "bold blue"
truncation_length = 36
truncation_symbol = "…"
truncation_direction = "middle"

[provider]
style = "bold green"

[[provider.style_rules]]
provider = "openai"
style = "bold blue"

[[model.style_rules]]
provider = "openai"
style = "bold blue"

[[thinking.style_rules]]
provider = "openai"
style = "bold blue"

[directory]
style = "cyan bold"

[git_branch]
style = "bold purple"

[context]
format = "[$symbol $percentage/$window ]($style)"

[[context.display]]
threshold = 0
style = "bold green"
hidden = true

[[context.display]]
threshold = 30
style = "bold green"
hidden = false

[[context.display]]
threshold = 60
style = "bold yellow"
hidden = false

[[context.display]]
threshold = 80
style = "bold red"
hidden = false

[git_metrics]
added_style = "bold green"
deleted_style = "bold red"
disabled = false

[username]
style_user = "yellow bold"
style_root = "red bold"

[extension_status]
format = "([$statuses ]($style))"
icons = { "foo:*" = "🧪", "third_party/key" = "◎", fallback = "•" }
styles = { "foo:*" = "bold green", "foo:error" = "bold red", fallback = "dimmed white" }
```

Every module table supports `format`, `symbol`, and `disabled`.
Most modules also support one `style`.
The exceptions include Git/Jujutsu metrics (`added_style` and `deleted_style`), `jj_change` (prefix/suffix/offset styles), `username` (`style_user` and `style_root`), and threshold-selected `context`, `cost`, and `battery` `display` arrays.
Directory root/read-only styles and Node.js/Go requirement styles supplement their ordinary `style`; see [module behavior](modules.md).
`thinking` retains its `style` fallback and also accepts the per-level overrides documented below.
Module-specific options are catalog-owned and type-checked; unknown options warn and stay inactive.
[Version formats](#version-formats) support raw and numeric component variables.
Detection arrays inspect one bounded listing of the current directory; replacement and fallback rules are [module-specific](modules.md#reachability-and-collection-rules).
Language and Kubernetes file detectors support leading `!` rejection rules; [environment detectors](modules.md#environment-detection-and-messages) have separate presence rules.
`[extension_status].icons` accepts arbitrary exact Pi status keys and explicit colon namespace wildcards such as `foo:*`; `fallback` controls unmatched statuses.
Icon matching uses the exact key, the longest `:*` wildcard, a leading status emoji, then `fallback`/`🔌`.
An empty configured icon suppresses only the icon.
`foo:*` matches `foo:server` but not `foo`, `foobar`, or `foo/server`.
`[extension_status].styles` applies a Starship style to each complete status (icon and text) by exact raw key, then longest `:*` wildcard, then optional `fallback`; unmatched statuses inherit the module's `style`.
Separators retain the module style. An explicit `none` style removes the inherited module style for that status.

Pi does not expose status ownership, so exact raw keys are the reliable third-party contract.
pi-starship does not inspect installed packages, infer aliases, assign known-extension icons, or bridge compatibility keys.
Extension authors may use `<extension-id>` or `<extension-id>:<stable-slot>` for interoperability, but pi-starship does not require it.

**Icon migration:** configurations that relied on package-ID aliases, built-in known-extension icons, or compatibility mappings must use an exact raw status key, an explicit namespace wildcard, a leading emoji in the status value, or `fallback`.

## Configuration schema and validation

### Root fields

A settings document is one TOML table with these accepted root keys:

| Key | Type | Behavior |
| --- | --- | --- |
| `format` | string | Root layout whose variables are module names or `$all`. |
| `palette` | string | Selects one exact table name from `[palettes.<name>]`. |
| `palettes` | table of tables | Defines direct color names used by style expressions. |
| `<module>` | table | Configures one module listed in [the complete module catalog](module-catalog.md). |

Unknown root keys produce warnings and remain inactive.
The loader normalizes `palettes` before resolving `palette`, so their textual order in TOML does not matter.
An unknown selected palette warns and supplies no custom colors.

### Shared module fields

Every module table accepts `format`, `symbol`, and `disabled`.
The exact accepted style fields, display arrays, module-specific options, defaults, enum values, and numeric ranges are listed in [the complete module catalog](module-catalog.md).

`format` and `symbol` must be strings.
`disabled` must be boolean.
A standard `style` field must be a valid style string.
`thinking` accepts `style` plus `style_off`, `style_minimal`, `style_low`, `style_medium`, `style_high`, `style_xhigh`, and `style_max`.
`provider`, `model`, and `thinking` additionally accept the ordered `style_rules` arrays described under [Content-selected styles](#content-selected-styles).
`git_metrics` and `jj_metrics` accept `added_style` and `deleted_style` instead of `style`.
`jj_change` accepts `prefix_style`, `suffix_style`, and `change_offset_style` instead of `style`.
`directory` additionally accepts `repo_root_style`, `before_repo_root_style`, and `read_only_style`.
`nodejs` and `golang` additionally accept `not_capable_style`; its exact default `"none"` disables requirement checks.
`username` accepts `style_user` and `style_root` instead of `style`.
`context`, `cost`, and `battery` accept `display` arrays instead of a direct `style` field.

`[[context.display]]`, `[[cost.display]]`, and `[[battery.display]]` entries require these typed fields:

```toml
threshold = 60 # finite number
style = "bold yellow" # valid style string
hidden = false # boolean
```

Unknown display fields warn.
Invalid display entries are discarded independently.
When no valid entries remain, the complete module display default is restored.

`extension_status` additionally accepts `separator`, `max_statuses`, `icons`, and `styles`.
`separator` is a string, `max_statuses` is an integer from 0 through 100, `icons` is a string-to-string table, and `styles` maps raw status keys to valid Starship style strings.
Invalid `styles` entries warn and are ignored independently; a non-table value warns and uses an empty table.

### Module option types

Module-specific options use these validation rules:

| Type | Accepted value |
| --- | --- |
| string | A TOML string; options marked non-empty reject `""`. |
| string enum | An exact case-sensitive listed string. |
| boolean | A TOML boolean, not a quoted string. |
| integer | An integer inside the inclusive range listed in the module catalog. |
| number | A finite number inside the inclusive range listed in the module catalog; fractions are accepted. |
| string array | An array containing only non-empty strings. |
| string-to-string table | A TOML table whose values are all strings. |
| command alternatives | One command string, or at most 16 command strings/argv arrays; see below. |
| context rules | At most 64 ordered Kubernetes rule tables; see below. |
| substitutions | A legacy string-to-string table or at most 64 ordered structured rows; see below. |

Language and Kubernetes `detect_files`, `detect_extensions`, and `detect_folders` arrays allow entries beginning with `!` as rejection rules.
`detect_env_vars` allows negation for `python`, `conda`, `direnv`, `gcloud`, `hostname`, and `kubernetes`; `username` retains positive-only detection.
Other string-array options reject entries beginning with `!`.
Detection fallback and replacement behavior differs by module and is specified in [module behavior](modules.md).

### Version formats

`version_format` applies to package, language, Pixi, and Terraform/OpenTofu versions and defaults to `v$raw`.
It uses the [format grammar](#-format-grammar): `$raw`, `$major`, `$minor`, `$patch`, their `${name}` forms, escapes, and conditional groups, but returns plain text without ANSI styles.
One leading lowercase `v` is removed from `$raw`; suffixes and leading zeroes remain in that raw value.
Numeric components are available only for a dotted numeric release with an optional suffix matching `[-+][0-9A-Za-z.+_-]+` or `[A-Za-z][0-9A-Za-z.+_-]*`.
A single numeric component is valid; missing minor/patch values are empty, extra components after patch are ignored, and component leading zeroes are removed.
For example, `01.002.0003-rc1` exposes `1`, `2`, `3`, and raw `01.002.0003-rc1`; malformed `1..2` exposes only raw text.
Unknown variables render empty, and an empty template hides the version.
Custom formats now use formatter variable boundaries and escapes, not raw substring replacement: use `${raw}_suffix` for appended identifier text and `\$` for a literal dollar sign.
Malformed format syntax or a template over 4,096 characters falls back to `v` plus the raw value.
Python's explicit pyenv-label mode bypasses this formatter.

### Bounded regex and structured options

Directory regex substitutions and Kubernetes context patterns use RE2JS, not JavaScript's backtracking regex engine.
Patterns are limited to 512 source characters; input and replacement strings to 4,096 characters; replacement output to 8,192 characters; the cache retains at most 64 compiled patterns, including invalid-pattern entries.
Backreferences and lookaround are unsupported and rejected.
Replacement fields are `$1`/`${1}`, `$name`/`${name}`, or `$$` for a literal dollar; unknown captures become empty.
These are regex capture fields, not footer module variables.

`directory.substitutions` accepts either an ordered legacy literal map or ordered `{ from, to, regex }` rows.
Each structured row requires string `from` (at most 512 characters) and `to` (at most 4,096 characters); optional boolean `regex` defaults to `false`.
No other row keys are accepted; empty `from`/`to` strings are allowed.
Literal rules replace all occurrences with literal text and skip empty search strings; regex rules replace only the first match, including an empty regex match.
The legacy map has no schema row/string bound, but rendering skips the complete sequence when it has more than 64 rules; all sequences have a 16,384-character intermediate path bound.
See [directory behavior](modules.md#directory-git-and-environment-contraction) for order and runtime-failure fallback.

`kubernetes.contexts` requires `context_pattern` and allows only `user_pattern`, `context_alias`, `user_alias`, `symbol`, and `style` as optional strings.
Both patterns use the 512-character bound; other strings use the 4,096-character bound, and `style` must be a valid style under the selected palette.
Rules match bounded source context/user labels before aliases with AND and first-match semantics; [Kubernetes behavior](modules.md#kubernetes-detection-and-context-rules) defines exact-match precedence and alias order.
An invalid row, unsupported regex, unknown row key, or oversized array rejects the entire corresponding substitutions/rules option with a warning and restores its default, not just the failing row.
Unknown document fields still remain on disk.

### Python command alternatives

`python_binary = []` preserves the existing active-virtualenv interpreter or `python` fallback.
A scalar such as `python_binary = "python3"` becomes one alternative; a non-empty array replaces that choice, for example `python_binary = ["python3", ["py", "-3"]]`.
Each string is one executable name/path, not a shell command line; each nested argv array contains 1–16 elements including its executable.
A flat string array lists alternative executables, not arguments to one executable.
There can be at most 16 alternatives, and each element must contain 1–1,024 characters without C0/C1 controls (`U+0000`–`U+001F`, `U+007F`–`U+009F`).
The runner appends `--version`, never starts an implicit shell, and stops at the first successful command even if its version output is malformed.
Invalid settings warn and restore the empty-array default.
Only use trusted executables and arguments: direct argv execution does not make a configured program safe.

### Status templates

Git's 20 status options and Jujutsu status options use the normal format grammar with at most 4,096 characters and 16 nested groups.
Static group styles and the selected palette are supported; style variables such as `$style` are not.
Counted states accept only `$count`/`${count}`; Git `diverged` accepts only `ahead_count` and `behind_count`; clean/boolean/description templates accept no variables.
Invalid templates warn and restore that field's default; empty templates suppress that state.
See [Git status behavior](modules.md#git-display-controls-and-status-templates) and [Jujutsu behavior](modules.md#jujutsu-modules) for count formatting, activation, and ordering.

### Diagnostic and fallback behavior

| Failure | Result |
| --- | --- |
| Missing file | Use Pi's native footer without creating a file or directory. |
| Read failure | Use built-in defaults and report an error diagnostic. |
| TOML syntax failure | Preserve the raw document, use built-in defaults, and report an error diagnostic. |
| Unknown root, module, option, or display field | Warn, ignore that field, and keep processing the document. |
| Wrong field type | Warn and retain the default for that field. |
| Invalid root `format` | Warn and restore only the built-in root format. |
| Invalid module `format` | Warn and restore only that module's default format. |
| Unknown format or style variable | Warn and render that variable empty. |
| Invalid literal group style | Warn and render that group unstyled. |
| Invalid module style field | Warn and restore only that style field's module default. |
| Invalid `style_rules` value | Warn and use an empty rule array for that module. |
| Invalid style-rule entry | Warn and discard only that entry. |
| Invalid palette color | Warn and omit only that palette entry. |
| Invalid module option | Warn and restore only that option's default. |
| Invalid display entry | Warn and discard only that entry; restore defaults if none remain. |

TOML syntax and read failures are errors that block interactive saving or reload application.
Semantic warnings do not prevent a document from loading or being saved, but `/starship status` reports them.
Unknown fields and comments remain in the settings document even though they are excluded from the normalized effective configuration.

## 🧩 Format grammar

- Variables: `$name` and `${name}`.
  Unknown variables render empty and produce a warning when loaded from TOML.
- Escapes: `\\$`, `\\[`, `\\]`, `\\(`, `\\)`, and `\\\\` render functional characters literally.
- Styled groups: `[format string](style string)`.
- Conditional groups: `(format string)` render only when a nested variable has a non-empty value.
- Nested groups are supported.
- `$all` expands enabled modules in the default order and omits modules already referenced explicitly.

Module formats can use `$style` in a style expression.
Module output keeps its own style when embedded in an outer styled group.

## 🎨 Styles and palettes

Style expressions support:

- Named colors and ANSI numbers `0`–`255`.
- Hex RGB (`#7aa2f7`), rendered as ANSI-256 when Pi's effective terminal capabilities disable true color.
- `pi:<role>` references to exact public Pi theme colors; see [Pi theme colors](#pi-theme-colors).
- `fg:<color>` and `bg:<color>`; an unprefixed color is foreground.
- `bold`, `dimmed`, `italic`, `underline`, `blink`, `inverted`, `hidden`, and `strikethrough`.
- `none` and `fg:none`, which make the complete expression unstyled regardless of position.
- `bg:none`, which clears only the absolute background; an unknown legacy `bg:<value>` keeps the same Starship-compatible reset behavior, but an unknown `bg:pi:<role>` is invalid.
- `prev_fg` and `prev_bg`, which use the previous rendered chunk's colors when present and retain any absolute foreground/background in the expression as the no-previous fallback.
- Direct color names from one explicitly selected `[palettes.<name>]` table.

There is no built-in or fallback palette.
A custom palette is active only when its table is explicitly selected, and its values must be direct named, ANSI, RGB, or `pi:<role>` colors—palette entries cannot reference other entries.
Palette keys override terminal color names such as `blue` and are checked before interpreting `pi:<role>`:

```toml
palette = "company"

[palettes.company]
blue = "#86BBD8"
accent = "208"

[model]
style = "bold blue"
```

Existing style keywords and named colors remain case-insensitive, and palette-key matching keeps its existing behavior.
Pi role names are case-sensitive and retain their exact spelling in direct styles and palette values.
Ordinary foreground/background colors are last-wins.
`prev_fg`/`prev_bg` override their absolute fallback only when a previous chunk exists.
Empty styled groups still advance previous-color state.
Invalid literal style expressions warn and render unstyled.
An invalid root format falls back to the built-in root format; an invalid module format or catalog-owned style field falls back only at that field's module scope.
`/starship status` reports warnings.

The background-free defaults are: `brand = "bold white"`, `provider`/`model` = `"bold blue"`, `thinking`/`git_branch`/`turn` = `"bold purple"`, `directory`/`git_worktree` = `"cyan bold"`, `github_pr = "bold blue"`, `git_commit = "green bold"`, `git_state`/`activity`/`time` = `"bold yellow"`, `git_status = "red bold"`, `tokens = "bold cyan"`, `cache = "bold green"`, `extension_status = "dimmed white"`, `direnv = "bold bright-yellow"`, and `fill = "bold black"`.
Context, cost, battery, metrics, Jujutsu IDs, and username use state/multi-style fields; see below and the [complete module catalog](module-catalog.md).

### Pi theme colors

Use `pi:<role>` wherever a color is accepted: module style fields, literal format styles, `style_rules`, `display` styles, extension-status styles, and palette values.
The role must be an exact public Pi `ThemeToken`, such as `accent`, `muted`, `thinkingHigh`, or `selectedBg`; preserve camelCase.
Theme variables and HTML export colors are not public roles.

```toml
format = "$model$directory"

[model]
style = "bold fg:pi:accent bg:pi:selectedBg"

[directory]
style = "fg:pi:muted"
```

A reference supplies only a color through Pi's public `theme.colors` API, not the role's ANSI styling.
Any role can supply either foreground or background: `bg:pi:accent` and `fg:pi:selectedBg` are valid regardless of the role's original slot.
Modifiers remain independent: add `bold` or `dimmed` explicitly when needed; a role adds neither implicitly.
For terminal-default roles, Pi supplies the terminal's reported default color or an appearance-based fallback when it is unavailable.
For faint roles, Pi supplies a concrete approximation mixed toward the background, not an implicit dim modifier.
Theme colors use ANSI-256 output when Pi's effective terminal capabilities disable true color.
Arbitrary theme colors do not guarantee readable contrast when combined as foreground and background.

Palette-key lookup takes precedence over role interpretation:

```toml
palette = "company"

[palettes.company]
"pi:accent" = "#ff0000"
primary = "pi:accent"

[model]
style = "fg:pi:accent" # palette key wins: fixed red

[directory]
style = "fg:primary" # direct palette value: current Pi accent
```

Palette values resolve directly as colors, not as recursive aliases.
Thus `primary = "pi:accent"` uses the Pi role even when the palette defines a `"pi:accent"` key.
An unknown Pi role in either foreground or background, including `bg:pi:unknown`, produces a settings diagnostic and uses the owning field's [fallback behavior](#diagnostic-and-fallback-behavior); an invalid palette value is omitted.
Validation does not rewrite the TOML file.
Unknown legacy background colors still clear the background as described above.

The footer and previews follow Pi theme switches and active theme hot reload without reloading TOML.
Fixed named, ANSI, and RGB colors, built-in defaults, and presets remain unchanged; only explicit `pi:<role>` references follow the theme.
To use the document with an older extension, replace these references with fixed colors before downgrading.

### Content-selected styles

`provider`, `model`, and `thinking` can replace their `$style` value with the first matching entry from an ordered `style_rules` array.
The built-in root format omits `provider`, so add `$provider` to a custom root format or use `$all` when provider output should be visible:

```toml
format = "$provider$model$thinking"

[provider]
style = "bold green"

[[provider.style_rules]]
provider = "openai"
style = "bold blue"

[[provider.style_rules]]
style = "bold white" # catch-all because it declares no selectors
```

Matching is exact and case-sensitive.
Every selector declared by a rule must match, rules are checked in document order, and the first complete match wins.
A rule containing only `style` is a catch-all, so later entries cannot win after it.
When a declared runtime value is unavailable, that rule does not match.
If no rule matches, the module keeps its existing selected style: ordinary `style` for `provider` and `model`, and the matching non-empty `style_<level>` or `style` fallback for `thinking`.
A selected rule changes only `$style`, so a custom module format without `$style` has no visible style change.

The exact selectors are:

| Module | Selector | Compared value |
| --- | --- | --- |
| `provider` | `provider` | Raw Pi provider ID. |
| `model` | `provider` | Raw Pi provider ID. |
| `model` | `model` | Raw Pi model ID. |
| `thinking` | `provider` | Raw Pi provider ID. |
| `thinking` | `level` | Current Pi thinking-level string. |

Provider and model aliases, optional model shortening, configured truncation, and terminal display sanitization do not change these raw selector values.
Style-rule styles use the selected palette and the same style grammar as other style fields.
An unknown field, unsupported selector, non-string selector, missing style, or invalid style warns and discards only that rule; valid sibling rules remain ordered and active.
An invalid non-array `style_rules` value warns and restores the empty default.
`style_rules` on any other module is an unknown setting.

### Thinking level styles

`thinking` can override its appearance for `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` independently:

```toml
[thinking]
style = "bold purple"
style_low = "bold blue"
style_high = "bold yellow"
style_max = "bold red"
```

The matching `style_<level>` wins when it is non-empty.
Every unset or empty level override uses the existing `style`, including levels added by a future Pi release.
Invalid fallback and level styles warn and fall back independently without changing other levels.

### State-selected styles

`context` and `cost` select the last entry at the highest threshold less than or equal to the current value.
A later entry wins when thresholds are equal.
Each display entry requires a finite `threshold`, a valid `style`, and boolean `hidden`.
Invalid entries warn and are ignored; module defaults are used if none remain.

The default context thresholds are hidden at `0`, `bold green` at `30`, `bold yellow` at `60`, and `bold red` at `80`.
The default cost thresholds are hidden at `0`, `bold yellow` at `1`, and `bold red` at `5`:

```toml
[[cost.display]]
threshold = 0
style = "bold green"
hidden = true

[[cost.display]]
threshold = 1
style = "bold yellow"
hidden = false

[[cost.display]]
threshold = 5
style = "bold red"
hidden = false
```

`git_metrics` and `jj_metrics` expose `$added_style` and `$deleted_style` in their module formats.
`jj_change` styles its composite IDs with `prefix_style`, `suffix_style`, and `change_offset_style`.
`battery` uses upper bounds: it selects the lowest threshold greater than or equal to the raw charge percentage, with the first entry winning a tie; no match or `hidden = true` hides the module.
Its default display is visible through 10% with `red bold`, not a context-style lower-bound rule.
`memory_usage.threshold` is a finite number from -100 through 10,000 (default 75); it gates the rounded native RAM percentage and is not a display array.
`username` still uses `$style` in its format, but selects `style_user` or `style_root` from private execution metadata; the selector is not a format variable.

### Breaking palette migration

The previous implicit `tokyo-night` palette and its `lead`, `header`, `header_fg`, `directory`, `directory_fg`, `git`, `git_fg`, `runtime`, `runtime_fg`, `meter`, `meter_fg`, and `extension` aliases were removed.
Existing files are not rewritten.
Old alias-based module styles warn and fall back to the module's new direct-color default; alias-based literal Powerline groups warn and render unstyled.

Choose one migration:

1. Replace old aliases with direct styles such as `cyan bold`, `bold bright-yellow`, or `fg:#e3e5e5 bg:#769ff0`.
2. Define every needed alias under your own `[palettes.<name>]` table and explicitly select it with `palette = "<name>"`.
3. Use **Restore built-in…** from `/starship` to archive the complete document in History, remove the active settings file, and return to Pi's native footer.

There is no hidden compatibility overlay or automatic migration.
