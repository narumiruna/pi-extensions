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
Unknown fields warn and remain inactive.
A wrong type or out-of-range option warns and uses that field's default.

String maps require string values.
String arrays require non-empty strings.
Language detection arrays allow a leading `!` rejection rule, while other string arrays reject negated entries.
All enum values are case-sensitive.

## Catalog order

`brand` → `provider` → `model` → `thinking` → `directory` → `git_worktree` → `git_branch` → `github_pr` → `git_commit` → `git_state` → `git_metrics` → `git_status` → `package` → `nodejs` → `python` → `rust` → `golang` → `bun` → `deno` → `mise` → `direnv` → `conda` → `pixi` → `nix_shell` → `guix_shell` → `docker_context` → `kubernetes` → `terraform` → `aws` → `gcloud` → `azure` → `openstack` → `os` → `container` → `hostname` → `username` → `activity` → `context` → `tokens` → `cache` → `cost` → `time` → `turn` → `fill` → `extension_status`

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

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `truncation_length` | integer | `0` | Inclusive range 0 through 1000. Maximum retained model-label grapheme clusters; zero disables truncation. |
| `truncation_symbol` | string | `"…"` | May be empty. Marker placed at the removed start, middle, or end; an empty string removes text without a marker. |
| `truncation_direction` | string enum | `"end"` | One of `start`, `middle`, `end`. Which part of the model label is removed when truncating. |
| `model_aliases` | string-to-string table | `{}` | Keys and values are strings. Exact model-ID to display-label replacements applied before built-in shortening and truncation. |

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

### `directory`

Current working directory.

- Format variables: `$symbol`, `$path`, `$full_path`.
- Style variables in `format`: `$style`.
- Default `format`: `"[ $symbol $path ]($style)"`.
- Default `symbol`: `"📁"`.
- Default `disabled`: `false`.

Accepted style fields:

| Field | Default |
| --- | --- |
| `style` | `"cyan bold"` |

Additional options:

| Option | Type | Default | Constraints and meaning |
| --- | --- | --- | --- |
| `truncation_length` | integer | `3` | Inclusive range 0 through 1000000. Number of trailing path components retained; zero keeps every component. |
| `truncate_to_repo` | boolean | `true` | Contracts the displayed path relative to the current Git repository root before component truncation. |
| `fish_style_pwd_dir_length` | integer | `0` | Inclusive range 0 through 1000. Abbreviates otherwise omitted parent components to this many grapheme clusters when no substitution is configured. |
| `truncation_symbol` | string | `""` | May be empty. Prefix placed before a contracted or component-truncated path when fish-style abbreviation is inactive. |
| `home_symbol` | string | `"~"` | May be empty. Replacement for the current user's home-directory prefix. |
| `use_os_path_sep` | boolean | `true` | Uses the platform path separator instead of always rendering `/`. |
| `substitutions` | string-to-string table | `{}` | Keys and values are strings. Ordered literal path replacements applied before ordinary path contraction. |

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
| `truncation_length` | integer | `0` | Inclusive range 0 through 1000000. Grapheme clusters retained independently for branch and remote labels; zero disables truncation. |
| `truncation_symbol` | string | `"…"` | May be empty. Its first grapheme is appended to each truncated branch or remote label. |

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
| `commit_hash_length` | integer | `7` | Inclusive range 0 through 64. Maximum commit-hash characters retained from the collected HEAD hash. |

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

### `package`

Current workspace package name and version.

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
| `truncation_length` | integer | `1` | Inclusive range 0 through 1000000. Number of trailing environment-path components retained; zero keeps the complete value. |

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
| `context_aliases` | string-to-string table | `{}` | Keys and values are strings. Exact Kubernetes context-name to display-label replacements. |
| `namespace_aliases` | string-to-string table | `{}` | Keys and values are strings. Exact Kubernetes namespace-name to display-label replacements. |
| `cluster_aliases` | string-to-string table | `{}` | Keys and values are strings. Exact Kubernetes cluster-name to display-label replacements. |
| `user_aliases` | string-to-string table | `{}` | Keys and values are strings. Exact Kubernetes user-name to display-label replacements. |
| `max_config_files` | integer | `8` | Inclusive range 1 through 32. Maximum number of `KUBECONFIG` files read from left to right. |

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
| `separator` | string | `" • "` | May be empty. Text inserted between rendered extension statuses. |
| `max_statuses` | integer | `5` | Inclusive range 0 through 100. Maximum number of extension statuses rendered; zero hides all status values. |
| `icons` | string-to-string table | `{}` | Keys and values are strings. Exact status-key and explicit `namespace:*` icon mappings, plus optional `fallback`. |
