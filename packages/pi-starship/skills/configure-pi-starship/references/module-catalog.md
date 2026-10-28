# Complete Module Configuration Catalog

Use this authoritative public reference for exact module names, format variables, defaults, accepted style fields, display rules, option types, ranges, and enum values.

The catalog order is also the `$all` expansion order.

## Shared module fields

Every `[module]` table accepts these fields:

| Field | Type | Behavior |
| --- | --- | --- |
| `format` | string | Module-local format parsed with only the module's listed format and style variables. |
| `symbol` | string | Value supplied as `$symbol`; an empty string hides only the symbol. |
| `disabled` | boolean | Removes the module from direct root references and `$all` when `true`. |

Most modules also accept `style` as listed below.
Modules with state-selected or multiple style fields list those exact fields instead.
`provider`, `model`, and `thinking` additionally accept an ordered `style_rules` array whose default is empty; each module section lists its exact selectors.
Unknown fields warn and remain inactive.
A wrong type or out-of-range option warns and uses that field's default.

String maps require string values.
String arrays require non-empty strings.
Detection arrays document whether they allow a leading `!` rejection rule. Command, context-rule, and substitution arrays use the bounded shapes documented below.
All enum values are case-sensitive.

## Catalog order

`brand` → `provider` → `model` → `thinking` → `directory` → `git_worktree` → `git_branch` → `github_pr` → `git_commit` → `git_state` → `git_metrics` → `git_status` → `jj_bookmark` → `jj_change` → `jj_metrics` → `jj_status` → `package` → `nodejs` → `python` → `rust` → `golang` → `bun` → `deno` → `mise` → `direnv` → `conda` → `pixi` → `nix_shell` → `guix_shell` → `docker_context` → `kubernetes` → `terraform` → `aws` → `gcloud` → `azure` → `openstack` → `os` → `container` → `hostname` → `username` → `memory_usage` → `battery` → `activity` → `context` → `tokens` → `cache` → `cost` → `time` → `turn` → `fill` → `extension_status`

## Module schemas

### `brand`

pi-starship brand mark.

- Format variables: `$symbol`.
- Style variables in `format`: `$style`.
- Default `format`: `"[ $symbol ]($style)"`.
- Default `symbol`: `"π"`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold white"` |

### `provider`

Current Pi model provider.

- Format variables: `$symbol`, `$provider`.
- Style variables in `format`: `$style`.
- Default `format`: `"[$symbol $provider ]($style)"`.
- Default `symbol`: `"🔌"`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold blue"` |

Accepted style-rule selectors (`style_rules` default: `[]`):

| Selector | Matches |
| --- | --- |
| `provider` | Exact raw runtime provider. |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `provider_aliases` | string-to-string table | `{}` | Keys and values are strings. Exact provider-name to display-label replacements; an empty replacement hides only the provider text. |

### `model`

Current Pi model.

- Format variables: `$symbol`, `$model`.
- Style variables in `format`: `$style`.
- Default `format`: `"[$symbol $model ]($style)"`.
- Default `symbol`: `"🤖"`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold blue"` |

Accepted style-rule selectors (`style_rules` default: `[]`):

| Selector | Matches |
| --- | --- |
| `provider` | Exact raw runtime provider. |
| `model` | Exact raw runtime model. |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `shorten_model` | boolean | `false` | Opt in to removing a leading `claude-`, a trailing `-20` plus six digits, or a trailing `-latest` from model IDs that do not match an alias; `gpt-` is unchanged. |
| `truncation_length` | integer | `0` | Inclusive range 0 through 1000. Inclusive range 0 through 1000. Maximum retained model-label grapheme clusters; zero disables truncation. |
| `truncation_symbol` | string | `"…"` | May be empty. Marker placed at the removed start, middle, or end; an empty string removes text without a marker. |
| `truncation_direction` | string enum | `"end"` | One of `start`, `middle`, `end`. One of `start`, `middle`, `end`. Which part of the model label is removed when truncating. |
| `model_aliases` | string-to-string table | `{}` | Keys and values are strings. Exact model-ID replacements that bypass optional shortening and are then subject to configured truncation. |

### `thinking`

Current Pi thinking level or streaming state.

- Format variables: `$symbol`, `$level`.
- Style variables in `format`: `$style`.
- Default `format`: `"[$symbol $level ]($style)"`.
- Default `symbol`: `"🧠"`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold purple"` |
| `style_off` | `""` |
| `style_minimal` | `""` |
| `style_low` | `""` |
| `style_medium` | `""` |
| `style_high` | `""` |
| `style_xhigh` | `""` |
| `style_max` | `""` |

Accepted style-rule selectors (`style_rules` default: `[]`):

| Selector | Matches |
| --- | --- |
| `provider` | Exact raw runtime provider. |
| `level` | Exact raw runtime level. |

### `directory`

Current working directory.

- Format variables: `$symbol`, `$path`, `$full_path`, `$before_root_path`, `$repo_root`, `$read_only`.
- Style variables in `format`: `$style`, `$repo_root_style`, `$before_repo_root_style`, `$read_only_style`.
- Default `format`: `"[ $symbol $path ]($style)"`.
- Default `symbol`: `"📁"`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"cyan bold"` |
| `repo_root_style` | `""` |
| `before_repo_root_style` | `""` |
| `read_only_style` | `"red"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `truncation_length` | integer | `3` | Inclusive range 0 through 1000000. Inclusive range 0 through 1000000. Number of trailing path components retained; zero keeps every component. |
| `truncate_to_repo` | boolean | `true` | Contracts the displayed path relative to the current Git repository root before component truncation. |
| `fish_style_pwd_dir_length` | integer | `0` | Inclusive range 0 through 1000. Inclusive range 0 through 1000. Abbreviates otherwise omitted parent components to this many grapheme clusters when no substitution is configured. |
| `truncation_symbol` | string | `""` | May be empty. Prefix placed before a contracted or component-truncated path when fish-style abbreviation is inactive. |
| `home_symbol` | string | `"~"` | May be empty. Replacement for the current user's home-directory prefix. |
| `use_os_path_sep` | boolean | `true` | Uses the platform path separator instead of always rendering `/`. |
| `use_logical_path` | boolean | `true` | Use Pi's current path when true; false uses cached realpath, falling back to the current path when unavailable. |
| `repo_root_format` | string | `""` | Alternate root-aware format. Empty inherits the normal format unless repo_root_style selects the split fallback; used only when the root remains visible. |
| `read_only` | string | `"🔒"` | Indicator supplied as $read_only only when a requested cached W_OK probe reports read-only. Empty disables the probe. |
| `substitutions` | substitution table or array | `{}` | Ordered literal replacements applied to the home- or repository-contracted display path before component truncation; also accepts from/to/regex rows with bounded RE2 matching. |

### `git_worktree`

Current linked Git worktree identity.

- Format variables: `$symbol`, `$name`, `$path`.
- Style variables in `format`: `$style`.
- Default `format`: `"[ $symbol $name ]($style)"`.
- Default `symbol`: `"🌳"`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"cyan bold"` |

### `git_branch`

Current Git branch and upstream identity.

- Format variables: `$symbol`, `$branch`, `$remote_name`, `$remote_branch`.
- Style variables in `format`: `$style`.
- Default `format`: `"[ $symbol $branch ]($style)"`.
- Default `symbol`: `"🌿"`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold purple"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `truncation_length` | integer | `0` | Inclusive range 0 through 1000000. Inclusive range 0 through 1000000. Grapheme clusters retained independently for branch and remote labels; zero disables truncation. |
| `truncation_symbol` | string | `"…"` | May be empty. Its first grapheme is appended to each truncated branch or remote label. |
| `only_attached` | boolean | `false` | Hide the branch when HEAD is detached. |
| `always_show_remote` | boolean | `true` | Keep equal branch/remote labels when true (Pi default); false hides the matching remote branch after truncation. |
| `ignore_branches` | string array | `[]` | Exact branch names to hide. |
| `ignore_remotes` | string array | `[]` | Exact remote names to hide; does not hide the remote branch. |
| `ignore_bare_repo` | boolean | `true` | Hide bare repositories by default; false permits bounded bare-repository detection. |

### `github_pr`

Current branch's GitHub pull request state, checks, and review.

- Format variables: `$symbol`, `$number`, `$link`, `$state`, `$checks`, `$review`, `$status`.
- Style variables in `format`: `$style`.
- Default `format`: `"[ $symbol$link( · $status) ]($style)"`.
- Default `symbol`: `"PR "`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold blue"` |

### `git_commit`

Current Git commit hash or tag.

- Format variables: `$symbol`, `$hash`, `$tag`.
- Style variables in `format`: `$style`.
- Default `format`: `"[ ($hash) ]($style)"`.
- Default `symbol`: `""`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"green bold"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `commit_hash_length` | integer | `7` | Inclusive range 0 through 64. Inclusive range 0 through 64. Maximum commit-hash characters retained from the collected HEAD hash. |
| `only_detached` | boolean | `false` | Show the commit only while HEAD is detached. |
| `tag_symbol` | string | `" 🏷 "` | Prefix included in the rendered $tag value. |
| `tag_disabled` | boolean | `false` | Do not collect or display a tag. |
| `tag_max_candidates` | integer | `0` | Inclusive range 0 through 100. Zero preserves exact HEAD-tag lookup; positive values permit first-parent tag discovery with this candidate limit. |

### `git_state`

Current Git operation such as merge, rebase, or cherry-pick.

- Format variables: `$symbol`, `$state`, `$progress_current`, `$progress_total`.
- Style variables in `format`: `$style`.
- Default `format`: `"[ ($state( $progress_current/$progress_total)) ]($style)"`.
- Default `symbol`: `""`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold yellow"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `rebase` | string | `"REBASING"` | Replacement label for the rebase operation. |
| `merge` | string | `"MERGING"` | Replacement label for the merge operation. |
| `revert` | string | `"REVERTING"` | Replacement label for the revert operation. |
| `cherry_pick` | string | `"CHERRY-PICKING"` | Replacement label for the cherry pick operation. |
| `bisect` | string | `"BISECTING"` | Replacement label for the bisect operation. |
| `am` | string | `"AM"` | Replacement label for the am operation. |
| `am_or_rebase` | string | `"AM/REBASE"` | Replacement label for the am or rebase operation. |

### `git_metrics`

Added and deleted lines in the current Git worktree.

- Format variables: `$symbol`, `$added`, `$deleted`.
- Style variables in `format`: `$added_style`, `$deleted_style`.
- Default `format`: `"([+$added]($added_style) )([-$deleted]($deleted_style) )"`.
- Default `symbol`: `""`.
- Default `disabled`: `true`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `added_style` | `"bold green"` |
| `deleted_style` | `"bold red"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `only_nonzero_diffs` | boolean | `true` | Hide zero added/deleted values when true. |
| `ignore_submodules` | boolean | `false` | Ignore submodule diffs and disable external diff/textconv for that query. |

### `git_status`

Current Git worktree and index status summary.

- Format variables: `$symbol`, `$all_status`, `$ahead_behind`, `$ahead`, `$behind`, `$up_to_date`, `$diverged`, `$conflicted`, `$stashed`, `$deleted`, `$renamed`, `$modified`, `$typechanged`, `$staged`, `$untracked`, `$worktree_added`, `$worktree_deleted`, `$worktree_modified`, `$worktree_typechanged`, `$index_added`, `$index_deleted`, `$index_modified`, `$index_typechanged`.
- Style variables in `format`: `$style`.
- Default `format`: `"[$all_status( $ahead_behind) ]($style)"`.
- Default `symbol`: `""`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"red bold"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `ahead` | string | `"⇡$count"` | Bounded formatter template (4096 characters, 16 nested groups); variables: `$count`. |
| `behind` | string | `"⇣$count"` | Bounded formatter template (4096 characters, 16 nested groups); variables: `$count`. |
| `up_to_date` | string | `""` | Bounded formatter template (4096 characters, 16 nested groups); no content variables. |
| `diverged` | string | `"⇕⇡$ahead_count⇣$behind_count"` | Bounded formatter template (4096 characters, 16 nested groups); variables: `$ahead_count`, `$behind_count`. |
| `conflicted` | string | `"=$count"` | Bounded formatter template (4096 characters, 16 nested groups); variables: `$count`. |
| `stashed` | string | `"\\$$count"` | Bounded formatter template (4096 characters, 16 nested groups); variables: `$count`. |
| `deleted` | string | `"✘$count"` | Bounded formatter template (4096 characters, 16 nested groups); variables: `$count`. |
| `renamed` | string | `"»$count"` | Bounded formatter template (4096 characters, 16 nested groups); variables: `$count`. |
| `modified` | string | `"!$count"` | Bounded formatter template (4096 characters, 16 nested groups); variables: `$count`. |
| `typechanged` | string | `"T$count"` | Bounded formatter template (4096 characters, 16 nested groups); variables: `$count`. |
| `staged` | string | `"+$count"` | Bounded formatter template (4096 characters, 16 nested groups); variables: `$count`. |
| `untracked` | string | `"?$count"` | Bounded formatter template (4096 characters, 16 nested groups); variables: `$count`. |
| `worktree_added` | string | `"A$count"` | Bounded formatter template (4096 characters, 16 nested groups); variables: `$count`. |
| `worktree_deleted` | string | `"D$count"` | Bounded formatter template (4096 characters, 16 nested groups); variables: `$count`. |
| `worktree_modified` | string | `"M$count"` | Bounded formatter template (4096 characters, 16 nested groups); variables: `$count`. |
| `worktree_typechanged` | string | `"T$count"` | Bounded formatter template (4096 characters, 16 nested groups); variables: `$count`. |
| `index_added` | string | `"A$count"` | Bounded formatter template (4096 characters, 16 nested groups); variables: `$count`. |
| `index_deleted` | string | `"D$count"` | Bounded formatter template (4096 characters, 16 nested groups); variables: `$count`. |
| `index_modified` | string | `"M$count"` | Bounded formatter template (4096 characters, 16 nested groups); variables: `$count`. |
| `index_typechanged` | string | `"T$count"` | Bounded formatter template (4096 characters, 16 nested groups); variables: `$count`. |
| `ignore_submodules` | boolean | `false` | Ignore dirty submodule worktrees while retaining changed gitlinks. |

### `jj_bookmark`

Closest ancestor bookmark in the current Jujutsu repository.

- Format variables: `$symbol`, `$bookmark`, `$remote`, `$diverged`, `$overflow_count`.
- Style variables in `format`: `$style`.
- Default `format`: `"on [$symbol$bookmark(@$remote)$diverged( \\(+$overflow_count others\\))]($style) "`.
- Default `symbol`: `" "`.
- Default `disabled`: `true`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold purple"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `truncation_length` | integer | `65535` | Inclusive range 0 through 65535. Controls truncation length; see [module behavior](modules.md) for selection and fallback rules. |
| `truncation_symbol` | string | `"…"` | Symbol for the truncation state. |
| `diverged_symbol` | string | `"*"` | Symbol for the diverged state. |
| `ignore_names` | string array | `[]` | Exact values used by this module's selection policy; see module behavior. |
| `ignore_remotes` | string array | `[]` | Exact values used by this module's selection policy; see module behavior. |

### `jj_change`

Current Jujutsu change and commit identity.

- Format variables: `$change`, `$commit`, `$change_prefix`, `$change_suffix`, `$change_offset`, `$commit_prefix`, `$commit_suffix`.
- Style variables in `format`: `$prefix_style`, `$suffix_style`, `$change_offset_style`.
- Default `format`: `"$change "`.
- Default `symbol`: `""`.
- Default `disabled`: `true`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `prefix_style` | `"green bold"` |
| `suffix_style` | `"dimmed"` |
| `change_offset_style` | `"bold"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `change_hash_length` | integer | `7` | Inclusive range 0 through 255. Controls change hash length; see [module behavior](modules.md) for selection and fallback rules. |
| `commit_hash_length` | integer | `7` | Inclusive range 0 through 255. Controls commit hash length; see [module behavior](modules.md) for selection and fallback rules. |

### `jj_metrics`

Added and deleted lines in the current Jujutsu change.

- Format variables: `$added`, `$deleted`.
- Style variables in `format`: `$added_style`, `$deleted_style`.
- Default `format`: `"([+$added]($added_style) )([-$deleted]($deleted_style) )"`.
- Default `symbol`: `""`.
- Default `disabled`: `true`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `added_style` | `"bold green"` |
| `deleted_style` | `"bold red"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `only_nonzero_diffs` | boolean | `true` | Controls only nonzero diffs; see [module behavior](modules.md) for selection and fallback rules. |

### `jj_status`

Current Jujutsu change status.

- Format variables: `$all`, `$conflicted`, `$description`, `$hidden`, `$immutable`, `$added`, `$copied`, `$deleted`, `$modified`, `$renamed`.
- Style variables in `format`: `$style`.
- Default `format`: `"([\\[$all\\]]($style) )"`.
- Default `symbol`: `""`.
- Default `disabled`: `true`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold red"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `conflicted` | string | `"!"` | Bounded formatter template (4096 characters, 16 nested groups); no content variables. |
| `description_empty` | string | `"◌"` | Bounded formatter template (4096 characters, 16 nested groups); no content variables. |
| `description_present` | string | `""` | Bounded formatter template (4096 characters, 16 nested groups); no content variables. |
| `hidden` | string | `""` | Bounded formatter template (4096 characters, 16 nested groups); no content variables. |
| `immutable` | string | `"◆"` | Bounded formatter template (4096 characters, 16 nested groups); no content variables. |
| `added` | string | `"+"` | Bounded formatter template (4096 characters, 16 nested groups); variables: `$count`. |
| `copied` | string | `"="` | Bounded formatter template (4096 characters, 16 nested groups); variables: `$count`. |
| `deleted` | string | `"✘"` | Bounded formatter template (4096 characters, 16 nested groups); variables: `$count`. |
| `modified` | string | `"~"` | Bounded formatter template (4096 characters, 16 nested groups); variables: `$count`. |
| `renamed` | string | `"»"` | Bounded formatter template (4096 characters, 16 nested groups); variables: `$count`. |

### `package`

Current workspace package version and manifest source.

- Format variables: `$symbol`, `$version`, `$source`.
- Style variables in `format`: `$style`.
- Default `format`: `"via [$symbol$version]($style) "`.
- Default `symbol`: `"📦 "`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold 208"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `version_format` | string | `"v$raw"` | May be empty. Version template in which `$raw` is replaced with the collected version. |
| `display_private` | boolean | `true` | Display package.json versions with private=true; false can fall through to the next supported manifest. |

### `nodejs`

Node.js version detected in the current workspace.

- Format variables: `$symbol`, `$version`, `$engines_version`.
- Style variables in `format`: `$style`.
- Default `format`: `"via [$symbol($version )]($style)"`.
- Default `symbol`: `" "`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold green"` |
| `not_capable_style` | `"none"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `version_format` | string | `"v$raw"` | May be empty. Version template in which `$raw` is replaced with the collected version. |
| `detect_files` | string array | `[]` | Entries may start with `!`. Direct current-directory file-name detectors; a non-empty array replaces that module's built-in file defaults. |
| `detect_extensions` | string array | `[]` | Entries may start with `!`. Direct current-directory extension detectors without a leading dot; a non-empty array replaces built-in extension defaults. |
| `detect_folders` | string array | `[]` | Entries may start with `!`. Direct current-directory folder-name detectors; a non-empty array replaces built-in folder defaults. |

### `python`

Python version, virtual environment, and pyenv state.

- Format variables: `$symbol`, `$version`, `$virtualenv`, `$pyenv_prefix`.
- Style variables in `format`: `$style`.
- Default `format`: `"via [$symbol$pyenv_prefix($version )(\\($virtualenv\\) )]($style)"`.
- Default `symbol`: `" "`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"yellow bold"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `version_format` | string | `"v$raw"` | May be empty. Version template in which `$raw` is replaced with the collected version. |
| `detect_files` | string array | `[]` | Entries may start with `!`. Direct current-directory file-name detectors; a non-empty array replaces that module's built-in file defaults. |
| `detect_extensions` | string array | `[]` | Entries may start with `!`. Direct current-directory extension detectors without a leading dot; a non-empty array replaces built-in extension defaults. |
| `detect_folders` | string array | `[]` | Entries may start with `!`. Direct current-directory folder-name detectors; a non-empty array replaces built-in folder defaults. |
| `pyenv_version_name` | boolean | `false` | Use the current PYENV_VERSION name instead of the interpreter version when available. |
| `pyenv_prefix` | string | `"pyenv "` | Text supplied as $pyenv_prefix in pyenv mode. |
| `python_binary` | command alternatives | `[]` | Scalar command or ordered command/argv alternatives; at most 16 alternatives, 16 arguments each, and 1024 characters per argument, without controls. Empty preserves current interpreter selection. |
| `detect_env_vars` | string array | `[]` | Presence detectors: positive names are OR conditions and !name vetoes presence, including empty values; an empty list preserves the module's existing detection. |
| `generic_venv_names` | string array | `[]` | Virtualenv basenames replaced with the parent-directory name. |

### `rust`

Rust toolchain detected in the current workspace.

- Format variables: `$symbol`, `$version`, `$numver`, `$toolchain`.
- Style variables in `format`: `$style`.
- Default `format`: `"via [$symbol($version )]($style)"`.
- Default `symbol`: `" "`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold red"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `version_format` | string | `"v$raw"` | May be empty. Version template in which `$raw` is replaced with the collected version. |
| `detect_files` | string array | `[]` | Entries may start with `!`. Direct current-directory file-name detectors; a non-empty array replaces that module's built-in file defaults. |
| `detect_extensions` | string array | `[]` | Entries may start with `!`. Direct current-directory extension detectors without a leading dot; a non-empty array replaces built-in extension defaults. |
| `detect_folders` | string array | `[]` | Entries may start with `!`. Direct current-directory folder-name detectors; a non-empty array replaces built-in folder defaults. |

### `golang`

Go version detected in the current workspace.

- Format variables: `$symbol`, `$version`, `$mod_version`.
- Style variables in `format`: `$style`.
- Default `format`: `"via [$symbol($version )]($style)"`.
- Default `symbol`: `" "`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold cyan"` |
| `not_capable_style` | `"none"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `version_format` | string | `"v$raw"` | May be empty. Version template in which `$raw` is replaced with the collected version. |
| `detect_files` | string array | `[]` | Entries may start with `!`. Direct current-directory file-name detectors; a non-empty array replaces that module's built-in file defaults. |
| `detect_extensions` | string array | `[]` | Entries may start with `!`. Direct current-directory extension detectors without a leading dot; a non-empty array replaces built-in extension defaults. |
| `detect_folders` | string array | `[]` | Entries may start with `!`. Direct current-directory folder-name detectors; a non-empty array replaces built-in folder defaults. |

### `bun`

Bun version detected in the current workspace.

- Format variables: `$symbol`, `$version`.
- Style variables in `format`: `$style`.
- Default `format`: `"via [$symbol($version )]($style)"`.
- Default `symbol`: `"🍞 "`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold red"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `version_format` | string | `"v$raw"` | May be empty. Version template in which `$raw` is replaced with the collected version. |
| `detect_files` | string array | `[]` | Entries may start with `!`. Direct current-directory file-name detectors; a non-empty array replaces that module's built-in file defaults. |
| `detect_extensions` | string array | `[]` | Entries may start with `!`. Direct current-directory extension detectors without a leading dot; a non-empty array replaces built-in extension defaults. |
| `detect_folders` | string array | `[]` | Entries may start with `!`. Direct current-directory folder-name detectors; a non-empty array replaces built-in folder defaults. |

### `deno`

Deno version detected in the current workspace.

- Format variables: `$symbol`, `$version`.
- Style variables in `format`: `$style`.
- Default `format`: `"via [$symbol($version )]($style)"`.
- Default `symbol`: `"🦕 "`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"green bold"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `version_format` | string | `"v$raw"` | May be empty. Version template in which `$raw` is replaced with the collected version. |
| `detect_files` | string array | `[]` | Entries may start with `!`. Direct current-directory file-name detectors; a non-empty array replaces that module's built-in file defaults. |
| `detect_extensions` | string array | `[]` | Entries may start with `!`. Direct current-directory extension detectors without a leading dot; a non-empty array replaces built-in extension defaults. |
| `detect_folders` | string array | `[]` | Entries may start with `!`. Direct current-directory folder-name detectors; a non-empty array replaces built-in folder defaults. |

### `mise`

Current mise configuration health.

- Format variables: `$symbol`, `$health`.
- Style variables in `format`: `$style`.
- Default `format`: `"via [$symbol$health]($style) "`.
- Default `symbol`: `"mise "`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold purple"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `detect_files` | string array | `[]` | Entries may not start with `!`. Direct current-directory file-name detectors; a non-empty array replaces that module's built-in file defaults. |
| `detect_extensions` | string array | `[]` | Entries may not start with `!`. Direct current-directory extension detectors without a leading dot; a non-empty array replaces built-in extension defaults. |
| `detect_folders` | string array | `[]` | Entries may not start with `!`. Direct current-directory folder-name detectors; a non-empty array replaces built-in folder defaults. |
| `healthy_symbol` | string | `"healthy"` | Symbol for the healthy state. |
| `unhealthy_symbol` | string | `"issues"` | Symbol for the unhealthy state. |

### `direnv`

Current direnv loading and permission state.

- Format variables: `$symbol`, `$rc_path`, `$allowed`, `$loaded`.
- Style variables in `format`: `$style`.
- Default `format`: `"[$symbol$loaded]($style) "`.
- Default `symbol`: `"direnv "`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold bright-yellow"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `detect_files` | string array | `[]` | Entries may not start with `!`. Direct current-directory file-name detectors; a non-empty array replaces that module's built-in file defaults. |
| `detect_extensions` | string array | `[]` | Entries may not start with `!`. Direct current-directory extension detectors without a leading dot; a non-empty array replaces built-in extension defaults. |
| `detect_folders` | string array | `[]` | Entries may not start with `!`. Direct current-directory folder-name detectors; a non-empty array replaces built-in folder defaults. |
| `detect_env_vars` | string array | `[]` | Presence detectors: positive names are OR conditions and !name vetoes presence, including empty values; an empty list preserves the module's existing detection. |
| `allowed_msg` | string | `"allowed"` | Replacement display text for the allowed state. |
| `not_allowed_msg` | string | `"not allowed"` | Replacement display text for the not allowed state. |
| `denied_msg` | string | `"denied"` | Replacement display text for the denied state. |
| `loaded_msg` | string | `"loaded"` | Replacement display text for the loaded state. |
| `unloaded_msg` | string | `"not loaded"` | Replacement display text for the unloaded state. |

### `conda`

Active Conda environment.

- Format variables: `$symbol`, `$environment`.
- Style variables in `format`: `$style`.
- Default `format`: `"via [$symbol$environment]($style) "`.
- Default `symbol`: `"🅒 "`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"green bold"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `ignore_base` | boolean | `true` | Hides the Conda module when `CONDA_DEFAULT_ENV` is exactly `base`. |
| `detect_env_vars` | string array | `[]` | Presence detectors: positive names are OR conditions and !name vetoes presence, including empty values; an empty list preserves the module's existing detection. |
| `truncation_length` | integer | `1` | Inclusive range 0 through 1000000. Inclusive range 0 through 1000000. Number of trailing environment-path components retained; zero keeps the complete value. |

### `pixi`

Active Pixi environment and project.

- Format variables: `$symbol`, `$version`, `$environment`, `$project_name`.
- Style variables in `format`: `$style`.
- Default `format`: `"via [$symbol$environment]($style) "`.
- Default `symbol`: `"🧚 "`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"yellow bold"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `detect_files` | string array | `[]` | Entries may not start with `!`. Direct current-directory file-name detectors; a non-empty array replaces that module's built-in file defaults. |
| `detect_extensions` | string array | `[]` | Entries may not start with `!`. Direct current-directory extension detectors without a leading dot; a non-empty array replaces built-in extension defaults. |
| `detect_folders` | string array | `[]` | Entries may not start with `!`. Direct current-directory folder-name detectors; a non-empty array replaces built-in folder defaults. |
| `version_format` | string | `"v$raw"` | May be empty. Version template in which `$raw` is replaced with the collected version. |
| `show_default_environment` | boolean | `false` | Shows Pixi's environment when its name is exactly `default`. |

### `nix_shell`

Current Nix shell state, name, and nesting level.

- Format variables: `$symbol`, `$state`, `$name`, `$level`.
- Style variables in `format`: `$style`.
- Default `format`: `"via [$symbol$state( \\($name\\))]($style) "`.
- Default `symbol`: `" "`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold blue"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `pure_msg` | string | `"pure"` | Replacement display text for the pure state. |
| `impure_msg` | string | `"impure"` | Replacement display text for the impure state. |

### `guix_shell`

Current Guix shell state.

- Format variables: `$symbol`, `$state`.
- Style variables in `format`: `$style`.
- Default `format`: `"via [$symbol]($style) "`.
- Default `symbol`: `"🐃 "`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"yellow bold"` |

### `docker_context`

Active Docker context.

- Format variables: `$symbol`, `$context`.
- Style variables in `format`: `$style`.
- Default `format`: `"via [$symbol$context]($style) "`.
- Default `symbol`: `" "`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"blue bold"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `detect_files` | string array | `[]` | Entries may not start with `!`. Direct current-directory file-name detectors; a non-empty array replaces that module's built-in file defaults. |
| `detect_extensions` | string array | `[]` | Entries may not start with `!`. Direct current-directory extension detectors without a leading dot; a non-empty array replaces built-in extension defaults. |
| `detect_folders` | string array | `[]` | Entries may not start with `!`. Direct current-directory folder-name detectors; a non-empty array replaces built-in folder defaults. |
| `only_with_files` | boolean | `false` | Requires a matching direct project detector before showing a non-default Docker context. |

### `kubernetes`

Active Kubernetes context, namespace, cluster, and user.

- Format variables: `$symbol`, `$context`, `$namespace`, `$cluster`, `$user`.
- Style variables in `format`: `$style`.
- Default `format`: `"on [$symbol$context( \\($namespace\\))]($style) "`.
- Default `symbol`: `"☸ "`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"cyan bold"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `detect_files` | string array | `[]` | Direct current-directory files detectors; a nonempty array replaces built-in defaults. A leading ! is a rejection rule. |
| `detect_extensions` | string array | `[]` | Direct current-directory extensions detectors; a nonempty array replaces built-in defaults. A leading ! is a rejection rule. |
| `detect_folders` | string array | `[]` | Direct current-directory folders detectors; a nonempty array replaces built-in defaults. A leading ! is a rejection rule. |
| `detect_env_vars` | string array | `[]` | Presence detectors: positive names are OR conditions and !name vetoes presence, including empty values; an empty list preserves the module's existing detection. |
| `contexts` | context-rule array | `[]` | At most 64 first-match rules with required context_pattern and optional user_pattern, symbol, style, context_alias, and user_alias; patterns use bounded RE2 full matching. |
| `context_aliases` | string-to-string table | `{}` | Keys and values are strings. Exact Kubernetes context-name to display-label replacements. |
| `namespace_aliases` | string-to-string table | `{}` | Keys and values are strings. Exact Kubernetes namespace-name to display-label replacements. |
| `cluster_aliases` | string-to-string table | `{}` | Keys and values are strings. Exact Kubernetes cluster-name to display-label replacements. |
| `user_aliases` | string-to-string table | `{}` | Keys and values are strings. Exact Kubernetes user-name to display-label replacements. |
| `max_config_files` | integer | `8` | Inclusive range 1 through 32. Inclusive range 1 through 32. Maximum number of `KUBECONFIG` files read from left to right. |

### `terraform`

Active Terraform workspace and version.

- Format variables: `$symbol`, `$workspace`, `$version`.
- Style variables in `format`: `$style`.
- Default `format`: `"via [$symbol$workspace]($style) "`.
- Default `symbol`: `"💠 "`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold 105"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `detect_files` | string array | `[]` | Entries may not start with `!`. Direct current-directory file-name detectors; a non-empty array replaces that module's built-in file defaults. |
| `detect_extensions` | string array | `[]` | Entries may not start with `!`. Direct current-directory extension detectors without a leading dot; a non-empty array replaces built-in extension defaults. |
| `detect_folders` | string array | `[]` | Entries may not start with `!`. Direct current-directory folder-name detectors; a non-empty array replaces built-in folder defaults. |
| `version_format` | string | `"v$raw"` | May be empty. Version template in which `$raw` is replaced with the collected version. |

### `aws`

Active AWS profile and region.

- Format variables: `$symbol`, `$profile`, `$region`.
- Style variables in `format`: `$style`.
- Default `format`: `"on [$symbol($profile )(\\($region\\) )]($style)"`.
- Default `symbol`: `"☁️  "`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold yellow"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `profile_aliases` | string-to-string table | `{}` | Keys and values are strings. Exact AWS profile-name to display-label replacements. |
| `region_aliases` | string-to-string table | `{}` | Keys and values are strings. Exact region-name to display-label replacements. |

### `gcloud`

Active Google Cloud project, account, and region.

- Format variables: `$symbol`, `$active`, `$account`, `$domain`, `$project`, `$region`.
- Style variables in `format`: `$style`.
- Default `format`: `"on [$symbol$project]($style) "`.
- Default `symbol`: `"☁️  "`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold blue"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `project_aliases` | string-to-string table | `{}` | Keys and values are strings. Exact project-name to display-label replacements. |
| `region_aliases` | string-to-string table | `{}` | Keys and values are strings. Exact region-name to display-label replacements. |
| `detect_env_vars` | string array | `[]` | Presence detectors: positive names are OR conditions and !name vetoes presence, including empty values; an empty list preserves the module's existing detection. |

### `azure`

Active Azure subscription and optional username.

- Format variables: `$symbol`, `$subscription`, `$username`.
- Style variables in `format`: `$style`.
- Default `format`: `"on [$symbol$subscription]($style) "`.
- Default `symbol`: `"󰠅 "`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"blue bold"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `subscription_aliases` | string-to-string table | `{}` | Keys and values are strings. Exact Azure subscription-name to display-label replacements. |
| `show_username` | boolean | `false` | Allows the Azure module to expose the selected subscription's local username field. |

### `openstack`

Active OpenStack cloud and project.

- Format variables: `$symbol`, `$cloud`, `$project`.
- Style variables in `format`: `$style`.
- Default `format`: `"on [$symbol$cloud( \\($project\\))]($style) "`.
- Default `symbol`: `"☁️  "`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold yellow"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `cloud_aliases` | string-to-string table | `{}` | Keys and values are strings. Exact OpenStack cloud-name to display-label replacements. |
| `project_aliases` | string-to-string table | `{}` | Keys and values are strings. Exact project-name to display-label replacements. |

### `os`

Current operating system identity.

- Format variables: `$symbol`, `$type`, `$name`, `$version`, `$edition`, `$codename`.
- Style variables in `format`: `$style`.
- Default `format`: `"[$symbol($name )]($style)"`.
- Default `symbol`: `""`.
- Default `disabled`: `true`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold white"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `symbols` | string-to-string table | `{"linux":"🐧 ","macos":"🍎 ","windows":" ","wsl":" "}` | Keys and values are strings. Exact OS type to symbol replacements for `linux`, `macos`, `windows`, `wsl`, or another reported platform type. |

### `container`

Current container or remote development environment.

- Format variables: `$symbol`, `$name`, `$type`.
- Style variables in `format`: `$style`.
- Default `format`: `"[$symbol$name]($style) "`.
- Default `symbol`: `"⬢ "`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold red dimmed"` |

### `hostname`

Current host name, normally shown for remote sessions.

- Format variables: `$symbol`, `$hostname`, `$ssh_symbol`.
- Style variables in `format`: `$style`.
- Default `format`: `"[$ssh_symbol$hostname]($style) in "`.
- Default `symbol`: `""`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold dimmed green"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `ssh_only` | boolean | `true` | Shows hostname only when `SSH_CONNECTION` or `SSH_TTY` is present. |
| `ssh_symbol` | string | `"🌐 "` | Symbol for the ssh state. |
| `detect_env_vars` | string array | `[]` | Presence detectors: positive names are OR conditions and !name vetoes presence, including empty values; an empty list preserves the module's existing detection. |
| `trim_at` | string | `"."` | May be empty. Removes the first occurrence of this delimiter and everything after it before hostname alias lookup; empty disables trimming. |
| `aliases` | string-to-string table | `{}` | Keys and values are strings. Exact collected value to display-label replacements for this module. |

### `username`

Current user identity when configured to display.

- Format variables: `$symbol`, `$user`.
- Style variables in `format`: `$style`.
- Default `format`: `"[$user]($style) in "`.
- Default `symbol`: `""`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style_user` | `"yellow bold"` |
| `style_root` | `"red bold"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `show_always` | boolean | `false` | Shows username outside SSH, privileged, login-mismatch, and configured environment-variable conditions. |
| `aliases` | string-to-string table | `{}` | Keys and values are strings. Exact collected value to display-label replacements for this module. |
| `detect_env_vars` | string array | `[]` | Entries may not start with `!`. Environment-variable names whose presence makes username visible; negated names are rejected. |

### `memory_usage`

Current system memory and available swap usage.

- Format variables: `$symbol`, `$ram`, `$ram_pct`, `$swap`, `$swap_pct`.
- Style variables in `format`: `$style`.
- Default `format`: `"via $symbol[$ram( \| $swap)]($style) "`.
- Default `symbol`: `"🐏 "`.
- Default `disabled`: `true`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"white bold dimmed"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `threshold` | number | `75` | Inclusive range -100 through 10000. Display threshold applied to the collected percentage; see module behavior. |

### `battery`

Local battery charge and charging state on supported platforms.

- Format variables: `$symbol`, `$percentage`.
- Style variables in `format`: `$style`.
- Default `format`: `"[$symbol$percentage]($style) "`.
- Default `symbol`: `""`.
- Default `disabled`: `true`.

Accepted state-selected style field:

- `display`: array of tables with finite numeric `threshold`, valid string `style`, and boolean `hidden`.
- Default `display`: `[{"threshold":10,"style":"red bold","hidden":false}]`.

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `full_symbol` | string | `"󰁹 "` | Symbol for the full state. |
| `charging_symbol` | string | `"󰂄 "` | Symbol for the charging state. |
| `discharging_symbol` | string | `"󰂃 "` | Symbol for the discharging state. |
| `unknown_symbol` | string | `"󰂑 "` | Symbol for the unknown state. |
| `empty_symbol` | string | `"󰂎 "` | Symbol for the empty state. |

### `activity`

Current Pi activity, extension UI wait, or most recently completed tool.

- Format variables: `$symbol`, `$state`, `$tool`, `$count`, `$kind`, `$title`, `$text`.
- Style variables in `format`: `$style`.
- Default `format`: `"[ $text ]($style)"`.
- Default `symbol`: `"⚙️"`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold yellow"` |

### `context`

Current model context-window usage.

- Format variables: `$symbol`, `$percentage`, `$tokens`, `$window`.
- Style variables in `format`: `$style`.
- Default `format`: `"[$symbol ctx $percentage ]($style)"`.
- Default `symbol`: `"🪟"`.
- Default `disabled`: `false`.

Accepted state-selected style field:

- `display`: array of tables with finite numeric `threshold`, valid string `style`, and boolean `hidden`.
- Default `display`: `[{"threshold":0,"style":"bold green","hidden":true},{"threshold":30,"style":"bold green","hidden":false},{"threshold":60,"style":"bold yellow","hidden":false},{"threshold":80,"style":"bold red","hidden":false}]`.

### `tokens`

Session input and output token totals.

- Format variables: `$symbol`, `$input`, `$output`, `$total`.
- Style variables in `format`: `$style`.
- Default `format`: `"[$symbol ↑$input ↓$output ]($style)"`.
- Default `symbol`: `"🔢"`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold cyan"` |

### `cache`

Prompt-cache usage and latest cache hit rate.

- Format variables: `$symbol`, `$rate`, `$read`, `$write`.
- Style variables in `format`: `$style`.
- Default `format`: `"[$symbol (CH$rate )]($style)"`.
- Default `symbol`: `"📦"`.
- Default `disabled`: `true`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold green"` |

### `cost`

Reported estimated session cost or subscription state.

- Format variables: `$symbol`, `$cost`, `$subscription`.
- Style variables in `format`: `$style`.
- Default `format`: `"[ $symbol \\$$cost( $subscription) ]($style)"`.
- Default `symbol`: `"💸"`.
- Default `disabled`: `false`.

Accepted state-selected style field:

- `display`: array of tables with finite numeric `threshold`, valid string `style`, and boolean `hidden`.
- Default `display`: `[{"threshold":0,"style":"bold green","hidden":true},{"threshold":1,"style":"bold yellow","hidden":false},{"threshold":5,"style":"bold red","hidden":false}]`.

### `time`

Current local time.

- Format variables: `$symbol`, `$time`.
- Style variables in `format`: `$style`.
- Default `format`: `"[$symbol $time ]($style)"`.
- Default `symbol`: `"🕒"`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold yellow"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `use_12hr` | boolean | `false` | Select the 12-hour fallback format when time_format is empty. |
| `time_format` | string | `""` | Bounded strftime subset; empty selects the Pi HH:mm default or 12-hour fallback. See module behavior for supported tokens and invalid-value fallback. |
| `utc_time_offset` | string | `"local"` | local, a decimal hour offset strictly between -24 and 24, UTC, or a supported IANA zone. Invalid values use local time. |
| `time_range` | string | `"-"` | Local-clock visibility interval with strict optional endpoints; '-' leaves the clock unrestricted. See module behavior for midnight and invalid-endpoint rules. |

### `turn`

Current user-turn count.

- Format variables: `$symbol`, `$count`.
- Style variables in `format`: `$style`.
- Default `format`: `"[$symbol #$count ]($style)"`.
- Default `symbol`: `"🔁"`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold purple"` |

### `fill`

Flexible spacing that aligns content within the footer width.

- Format variables: `$symbol`.
- Style variables in `format`: `$style`.
- Default `format`: `"[$symbol]($style)"`.
- Default `symbol`: `" "`.
- Default `disabled`: `false`.
- Layout role: `"fill"`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"bold black"` |

### `extension_status`

Statuses published through Pi's extension-neutral status map.

- Format variables: `$symbol`, `$statuses`, `$count`.
- Style variables in `format`: `$style`.
- Default `format`: `"[$statuses]($style)"`.
- Default `symbol`: `""`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"dimmed white"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `separator` | string | `" • "` | Text inserted between rendered extension statuses. |
| `max_statuses` | integer | `5` | Inclusive range 0 through 100. Zero hides all status values. |
| `icons` | string-to-string table | `{}` | Exact raw status keys, explicit namespace wildcards, and optional fallback. |
| `styles` | string-to-style table | `{}` | Valid Starship styles by exact raw key, namespace wildcard, or fallback. |
