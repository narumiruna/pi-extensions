# Module Reference

Use this authoritative public reference whenever a question or change involves a module, format variable, display rule, alias, truncation rule, or module-specific option.

## 🧱 Modules

| Module | Format variables | Meaning |
| --- | --- | --- |
| `brand` | `$symbol` | Pi brand marker |
| `provider` | `$symbol`, `$provider` | Current model provider |
| `model` | `$symbol`, `$model` | Current model name |
| `thinking` | `$symbol`, `$level` | Thinking level |
| `directory` | `$symbol`, `$path`, `$full_path`, `$before_root_path`, `$repo_root`, `$read_only` | Current directory and optional cached metadata |
| `git_worktree` | `$symbol`, `$name`, `$path` | Linked worktree name and top-level path |
| `git_branch` | `$symbol`, `$branch`, `$remote_name`, `$remote_branch` | Local branch and upstream |
| `github_pr` | `$symbol`, `$number`, `$link`, `$state`, `$checks`, `$review`, `$status` | Current-branch GitHub pull request |
| `git_commit` | `$symbol`, `$hash`, `$tag` | HEAD hash (seven characters by default) and optional tag |
| `git_state` | `$symbol`, `$state`, `$progress_current`, `$progress_total` | Rebase, merge, revert, cherry-pick, bisect, or mail-apply state |
| `git_metrics` | `$symbol`, `$added`, `$deleted` | Added/deleted line totals from the working tree diff |
| `git_status` | `$symbol`, `$all_status`, `$ahead_behind`, `$ahead`, `$behind`, `$diverged`, `$up_to_date`, `$conflicted`, `$stashed`, `$deleted`, `$renamed`, `$modified`, `$typechanged`, `$staged`, `$untracked`, and detailed index/worktree counters | Cached porcelain-v2 counters |
| `jj_bookmark` | `$symbol`, `$bookmark`, `$remote`, `$diverged`, `$overflow_count` | Recorded Jujutsu change/ancestor bookmarks; disabled by default |
| `jj_change` | `$change`, `$commit`, `$change_prefix`, `$change_suffix`, `$change_offset`, `$commit_prefix`, `$commit_suffix` | Recorded Jujutsu IDs; disabled by default |
| `jj_metrics` | `$added`, `$deleted` | Recorded Jujutsu line totals; disabled by default |
| `jj_status` | `$all`, `$conflicted`, `$description`, `$hidden`, `$immutable`, `$added`, `$copied`, `$deleted`, `$modified`, `$renamed` | Recorded Jujutsu flags/counters; disabled by default |
| `memory_usage` | `$symbol`, `$ram`, `$ram_pct`, `$swap`, `$swap_pct` | Native system RAM and optional Linux swap; disabled by default |
| `battery` | `$symbol`, `$percentage` | Linux sysfs battery charge; disabled by default |
| `activity` | `$symbol`, `$state`, `$tool`, `$count`, `$kind`, `$title`, `$text` | Extension UI waits, active tools, streaming, completion, or idle |
| `context` | `$symbol`, `$percentage`, `$tokens`, `$window` | Context-window use |
| `tokens` | `$symbol`, `$input`, `$output`, `$total` | Token totals |
| `cache` | `$symbol`, `$rate`, `$read`, `$write` | Prompt-cache reads, writes, and latest hit rate; disabled by default |
| `cost` | `$symbol`, `$cost`, `$subscription` | Session cost and optional `(sub)` marker |
| `time` | `$symbol`, `$time` | Formatted clock; local `HH:mm` by default |
| `turn` | `$symbol`, `$count` | User turn count |
| `package` | `$symbol`, `$version`, `$source` | Direct project manifest version |
| `nodejs` | `$symbol`, `$version`, `$engines_version` | Detected Node.js project/runtime |
| `python` | `$symbol`, `$version`, `$virtualenv`, `$pyenv_prefix` | Python runtime and allowlisted environment name |
| `rust` | `$symbol`, `$version`, `$numver`, `$toolchain` | Safe native `rustc` runtime and allowlisted toolchain name |
| `golang` | `$symbol`, `$version`, `$mod_version` | Go runtime and direct `go.mod` minimum version |
| `bun` / `deno` | `$symbol`, `$version` | Bun or Deno runtime |
| `mise` | `$symbol`, `$health` | Bounded mise health result |
| `direnv` | `$symbol`, `$rc_path`, `$allowed`, `$loaded` | Inert direnv status; `.envrc` is never sourced |
| `conda` | `$symbol`, `$environment` | Active Conda environment name |
| `pixi` | `$symbol`, `$version`, `$environment`, `$project_name` | Pixi project and environment |
| `nix_shell` | `$symbol`, `$state`, `$name`, `$level` | Allowlisted Nix shell activation metadata |
| `guix_shell` | `$symbol`, `$state` | Guix shell activation marker |
| `docker_context` | `$symbol`, `$context` | Non-default local Docker context |
| `kubernetes` | `$symbol`, `$context`, `$namespace`, `$cluster`, `$user` | Current inert kubeconfig metadata |
| `terraform` | `$symbol`, `$workspace`, `$version` | Local Terraform/OpenTofu workspace and optional version |
| `aws` | `$symbol`, `$profile`, `$region` | AWS profile/region metadata, never credentials |
| `gcloud` | `$symbol`, `$active`, `$account`, `$domain`, `$project`, `$region` | Active gcloud configuration metadata |
| `azure` | `$symbol`, `$subscription`, `$username` | Default Azure subscription; username is separately enabled |
| `openstack` | `$symbol`, `$cloud`, `$project` | Selected OpenStack cloud/project metadata |
| `os` | `$symbol`, `$type`, `$name`, `$version`, `$edition`, `$codename` | Platform/OS metadata; disabled by default |
| `container` | `$symbol`, `$name`, `$type` | Known container, WSL, or Dev Container context |
| `hostname` | `$symbol`, `$hostname`, `$ssh_symbol` | Hostname, SSH-only by default |
| `username` | `$symbol`, `$user` | Contextual login identity |
| `fill` | `$symbol` | Flexible width-aware root-layout marker |
| `extension_status` | `$symbol`, `$statuses`, `$count` | Pi extension statuses |

For exact default formats, symbols, enabled state, accepted style fields, display defaults, option types, numeric ranges, and enum values, use [the complete module catalog](module-catalog.md).

## Reachability and collection rules

A module contributes work only when it is enabled and reachable from the root `format` directly or through `$all`.
Reachability activates that module's collector at module scope, even when its module format references only `$symbol`.
Omitting a data variable does not prevent the package, deployment, cloud, or execution collectors from reading that reachable module's allowlisted files and environment metadata.
Language project detection also runs at module scope. Version commands, requirement-file reads, and optional Python/Rust values are variable-gated, except for explicitly enabled Node.js/Go requirement styling as described below.
The mise health, direnv status, Pixi version, and Terraform/OpenTofu version commands are likewise variable-gated, but their module-level detection and non-command metadata reads still occur when reachable.
Directory physical-path and permission probes consider the union of its main format and configured alternate root format; defaults request neither probe.
A reachable Jujutsu module starts one shared query even for a symbol-only format. Reachable memory/battery modules sample their native sources at module scope; swap is separately variable-gated.
A disabled module is absent even when the root format names it or `$all` is present.

Workspace detection uses at most one direct listing of the current working directory, stops at 2,048 entries, and never recurses.
A positive file, extension, or folder rule must match for direct detection to succeed.
Any matching `!` rule rejects the direct file scan before positive matches are considered.
Language extensions may be configured with or without a leading dot, but defaults omit the dot.
Kubernetes uses its distinct suffix and detector-precedence rules [below](#kubernetes-detection-and-context-rules).

For language modules, each non-empty `detect_files`, `detect_extensions`, or `detect_folders` array replaces only that category's built-in defaults.
An empty category keeps its built-in defaults.
For `mise`, `direnv`, and `pixi`, an empty `detect_files` uses the listed default files while configured extension and folder arrays remain additive detector categories.

## Exact language defaults

| Module | Default files | Default extensions | Default folders | Version command |
| --- | --- | --- | --- | --- |
| `nodejs` | `package.json`, `.node-version`, `.nvmrc`, `!bun.lock`, `!bun.lockb`, `!deno.json`, `!deno.jsonc` | `js`, `mjs`, `cjs`, `ts`, `mts`, `cts` | `node_modules` | `node --version` |
| `python` | `pyproject.toml`, `requirements.txt`, `Pipfile`, `poetry.lock`, `.python-version` | `py` | `.venv`, `venv` | existing active virtualenv interpreter, otherwise `python --version` |
| `rust` | `Cargo.toml` | `rs` | none | safe native `rustc --version` |
| `golang` | `go.mod`, `go.sum`, `go.work` | `go` | none | `go version` |
| `bun` | `bun.lock`, `bun.lockb`, `bunfig.toml` | none | none | `bun --version` |
| `deno` | `deno.json`, `deno.jsonc`, `deno.lock` | none | none | `deno -V` |

Node's negative file defaults prevent Bun and Deno projects from matching Node solely through overlapping JavaScript or TypeScript files.
Rust `$toolchain` reads `RUSTUP_TOOLCHAIN`.
Rust rejects compiler paths beneath `.cargo` or `.rustup` and does not invoke rustup because a shim may install a toolchain.

Every language `version_format` defaults to `v$raw`; the shared [version grammar](configuration.md#version-formats) also supports braced raw/component variables and partial versions.
Malformed, multiline, replacement-character, failed, killed, timed-out, or oversized version output leaves the command-backed value empty.

### Node.js and Go requirements

Node `$engines_version` reads only `engines.node` from direct `package.json` and exposes at most 80 sanitized characters.
Go `$mod_version` reads the first standalone `go M.N` or `go M.N.P` directive in direct `go.mod`; each numeric component has 1–9 digits, horizontal whitespace and a trailing `//` comment are allowed, and `toolchain` is ignored.
Both variables remain visible when the runtime satisfies the requirement; they are not upstream-style mismatch-only output.
Without these variables or explicit requirement styling, neither requirement file is read.

`not_capable_style` defaults to the exact sentinel `"none"`, which disables checks and preserves the normal module style.
A non-empty different value opts in only when the module format uses `$style` and at least one of `$version` or its requirement variable.
An available requirement can then trigger a version command even when only the requirement variable is displayed; symbol-only formats never trigger these reads or commands.
A valid unsatisfied requirement selects the configured style; missing, invalid, or unavailable versions/requirements retain the normal style.
Node uses npm-semver ranges (comparators, `^`, `~`, wildcards, hyphen ranges, `||`, and npm prerelease rules), limited to 256 characters drawn from letters, digits, `. + * | < > = ^ ~ -`, spaces, and tabs; runtime versions are limited to 80 characters.
Go compares a numeric `M.N[.P]` minimum, treating a missing patch as zero; prerelease/non-numeric inputs do not select the incapable style.
No package manager, `go list`, download, or toolchain installation is used.

### Python interpreter and environment labels

By default, `$version` uses an existing `VIRTUAL_ENV/bin/python` (`Scripts/python.exe` on Windows), otherwise `python --version`.
Explicit `python_binary` [command alternatives](configuration.md#python-command-alternatives) replace that selection; the first successful command owns parsing even if the output is empty or malformed.
No shell is started, but configured programs and arguments must be trusted.

`pyenv_version_name = true` replaces the runtime version with sanitized `PYENV_VERSION`, or bounded `pyenv version-name` only when that variable is absent.
An empty present value stays empty without a command fallback; `version_format` is not applied to this label.
In this mode `$pyenv_prefix` uses the configurable string `pyenv_prefix` (default `"pyenv "`).
With the default `pyenv_version_name = false`, `$pyenv_prefix` preserves Pi's existing `PYENV_VERSION` text and does not invoke pyenv.
These optional values are collected only when referenced.

`$virtualenv` uses the basename of non-empty `VIRTUAL_ENV`, then non-empty `CONDA_DEFAULT_ENV`.
`generic_venv_names` defaults to `[]`; an exact matching basename is replaced by its parent-directory basename, so `".venv"` can display the project name.
A non-empty `detect_env_vars` is an alternative to project-file detection, not an additional requirement or a veto over a matching file.

### Package visibility

`package` tries direct `package.json`, Cargo, then PEP 621/Poetry versions; only inherited Cargo workspace versions can search up to eight parents.
`display_private = true` preserves private npm-package visibility.
Setting it to `false` skips only a `package.json` with boolean `private = true` and can continue to a Cargo/Python manifest; it does not infer privacy for other ecosystems.

## Exact environment and deployment defaults

| Module | Activation default | Optional command or read |
| --- | --- | --- |
| `mise` | direct `mise.toml`, `.mise.toml`, or `.tool-versions` | `mise doctor` only for `$health` |
| `direnv` | direct `.envrc` | `direnv status --json` only for `$rc_path`, `$allowed`, or `$loaded` |
| `conda` | non-empty `CONDA_DEFAULT_ENV`, excluding exact `base` by default | none |
| `pixi` | direct `pixi.toml` or `pixi.lock` | `pixi --version` only for `$version`; direct `pixi.toml` may supply project/workspace name |
| `nix_shell` | `IN_NIX_SHELL` is exactly `pure` or `impure` | none |
| `guix_shell` | non-empty `GUIX_ENVIRONMENT` | none |
| `docker_context` | a non-default Docker context; project files are not required by default | `DOCKER_CONTEXT`, then Docker `config.json` |
| `kubernetes` | a current context from `KUBECONFIG` or `~/.kube/config` | reads at most 8 config files by default |
| `terraform` | direct `.tf`, `.tfplan`, `.tfstate`, or `.terraform` | workspace metadata; `terraform version`, then `tofu version`, only for `$version` |

### Environment detection and messages

`detect_env_vars` defaults to `[]` for Python, Conda, direnv, gcloud, hostname, and Kubernetes.
Names use `[A-Za-z_][A-Za-z0-9_]*`, optionally prefixed with `!`.
Presence includes an empty string: positive names use OR, any present negative name vetoes that environment detector, and a negative-only list passes when all named variables are absent.
An empty list adds no condition; an invalid name makes that detector fail.
For Conda, gcloud, and hostname this is an additional gate, not activation by itself; hostname's default SSH gate still applies.
For Python and direnv a non-empty list is an alternative to matching project files, so its veto does not reject a separately matching file.
Kubernetes has the precedence described below.
`username` retains its older positive-only, non-empty-value detector.
Only explicitly named detector values enter the allowlisted runtime/child environment; detector values are not added to footer output.

`mise` maps recognized healthy output through `healthy_symbol` (default `"healthy"`) and warning/problem output through `unhealthy_symbol` (default `"issues"`); unrecognized output leaves `$health` empty.
`direnv` never reads or sources `.envrc`.
Its nested JSON `state.foundRC.allowed` values `0`, `1`, and `2` select `allowed_msg`, `not_allowed_msg`, and `denied_msg` (defaults `"allowed"`, `"not allowed"`, `"denied"`).
Nested `loadedRC.allowed = 0` selects `loaded_msg` (default `"loaded"`); no loaded record or another valid state selects `unloaded_msg` (default `"not loaded"`).
Malformed nested status yields no values.
Legacy top-level snapshots retain boolean/0-or-1 interpretation (`true`/`1` allowed, `false`/`0` denied; a loaded record means loaded).
Bounded `Found RC path ...` text is also accepted, with `0`/`true` allowed, `1` not allowed, and `2`/`false` denied.
`pixi` hides the exact environment name `default` unless `show_default_environment = true`.
`pixi` prefers `PIXI_PROJECT_NAME`, then reads `project.name` or `workspace.name` from direct `pixi.toml`.
`nix_shell` publishes allowlisted `NIX_SHELL_NAME` and `NIX_SHELL_LEVEL` only for exact `pure`/`impure` activation, with `$state` selected by `pure_msg`/`impure_msg` (defaults `"pure"`/`"impure"`).
`unknown_msg` and `heuristic` are not supported: unknown-shell discovery would require the excluded PATH heuristic.
`guix_shell` reports only the literal state `active`.
`hostname.ssh_symbol` defaults to `"🌐 "` and appears only for SSH; setting `ssh_only = false` does not add it to local output.

When `[docker_context].only_with_files = true`, default detection checks `Dockerfile`, `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, and `compose.yaml`.
Non-empty Docker detection arrays replace or extend those direct categories as described above.
Docker suppresses the exact context `default`.

Terraform differs from category-by-category language fallback.
When any Terraform detection array is non-empty, only the complete configured file, extension, and folder arrays are used.
When all three are empty, the built-in `.tf`, `.tfplan`, `.tfstate`, and `.terraform` rules apply.
Terraform workspace precedence is `TF_WORKSPACE`, `TF_DATA_DIR/environment`, then `.terraform/environment`.

### Kubernetes detection and context rules

With all file/extension/folder detectors empty, `detect_env_vars` controls reading kubeconfig; its empty default permits the existing current-context behavior.
If any file/extension/folder detector is configured, only that direct scan is used and environment detectors are ignored.
Positive file/folder/suffix rules use OR; any matching negative rule rejects the scan, and a negative-only scan cannot activate it.
Only regular entries are considered, symlinks are not followed, hidden files supply no extensions, and both the last suffix and full compound suffix match (`yaml` or `tar.gz`, without a leading dot).

`contexts` accepts at most 64 [bounded rules](configuration.md#bounded-regex-and-structured-options).
Each requires `context_pattern`; an optional `user_pattern` must also match, including the requirement that a user label exists.
Rules are checked in order and the first complete match wins, even when it declares no overrides.
A pattern first checks literal equality, then whole-label RE2JS matching; an empty pattern is not a wildcard.
`context_alias` and `user_alias` are literal on the equality branch and use regex capture replacement otherwise.
A `user_alias` without `user_pattern` can supply a display-only user when none exists.
Optional `symbol` and `style` override presentation for that rule; an explicit empty value clears that presentation.
Legacy `context_aliases`, `user_aliases`, `namespace_aliases`, and `cluster_aliases` remain exact maps and apply after rule aliases.
Missing namespace defaults to `default`; cluster/user values normally require matching named kubeconfig entries, except a rule can explicitly supply the user label.
These are inert labels, not evidence of cluster access or valid credentials.

### Usage semantics

- During a blocking extension UI prompt, `activity` sets `$state` to `waiting`, `$kind` to the prompt kind, and `$title` to the sanitized bounded title or an empty string.
- Prompt waiting takes precedence without losing the underlying tool, streaming, completed, or idle state, which returns when the prompt closes.
- `tokens`, `cache`, and `cost` total every usage-bearing session entry, matching Pi's native footer.
  This includes assistant messages, nested-LLM tool results, compactions, and branch summaries, including abandoned branches retained in the session.
- Cache `$read` and `$write` are cumulative.
  `$rate` uses only the latest assistant prompt with `cacheRead / (input + cacheRead + cacheWrite) * 100`.
  The module is empty when Pi has reported no cache reads or writes.
- `cache` is disabled and absent from the built-in root.
  Enable it and add `$cache` to a custom root format (or use `$all`) to display it.
- Context `$percentage` uses native one-decimal precision.
  Its default display hides values below 30%.
  Customize `[[context.display]]` when lower values should remain visible.
  The module name remains `context`, not `context_usage`.
- Subscription-backed OAuth models and `kimi-coding` set cost `$subscription` to `(sub)`.
  The dollar value is usage cost, not proof of an amount billed under a subscription.

### Directory, Git, and environment contraction

These modules keep their display policy local. Existing Pi defaults remain unchanged:

```toml
[directory]
truncation_length = 3
truncate_to_repo = true
fish_style_pwd_dir_length = 0
truncation_symbol = ""
home_symbol = "~"
use_os_path_sep = true
substitutions = { "/Volumes/network/path" = "/net" }

[git_branch]
truncation_length = 0 # pi-starship's bounded no-truncation sentinel
truncation_symbol = "…"

[git_commit]
commit_hash_length = 7

[conda]
ignore_base = true
truncation_length = 1

[hostname]
trim_at = "." # set to "" to keep the complete hostname
```

Directory `$path` contracts to the Git repository name by default when cwd is inside a repository whose root is not home; otherwise it contracts home where applicable.
It then keeps the last three components.
`use_logical_path = true` preserves Pi's cwd; `false` uses cached `realpath` metadata, falling back to cwd on failure.
`$full_path` is the selected absolute path without contraction/substitution/truncation; terminal controls are still removed.
A positive `fish_style_pwd_dir_length` abbreviates omitted parents only when no substitution is configured.
Ordered literal maps or structured regex/literal [substitution rows](configuration.md#bounded-regex-and-structured-options) run after contraction and before component truncation.
A runtime substitution failure discards the whole sequence and preserves the pre-substitution display path, not a partially transformed path.

`repo_root_format = ""` inherits the main format.
A non-empty `repo_root_format` selects an alternate format only when a repository root remains in the visible path and can be split without changing the output.
A non-empty `repo_root_style` with no explicit alternate format selects the built-in split format with `$before_root_path`, `$repo_root`, `$path`, and `$read_only`, preserving Pi's symbol and spacing.
`before_repo_root_style` alone does not activate that format; unset/empty root styles inherit `style`.
Truncation that omits the root, an out-of-tree logical symlink, or a substitution crossing a style boundary falls back to the main format.
Alternate formats accept only directory variables/styles and at most 4,096 characters; invalid syntax/variables warn and restore the empty sentinel.

`read_only` defaults to `"🔒"` with `read_only_style = "red"`, but the normal default format does not display or probe it.
A referenced non-empty indicator requests cached `fs.access(W_OK)` metadata; only known permission/read-only-filesystem denial displays it.
Unknown/error results hide it. This is a current-process writability approximation, not an ACL or future-write guarantee.
Rendering and previews perform no filesystem or Git work.

Conda retains the last path component by default; `0` keeps the complete environment path.
Hostname trimming runs before exact alias lookup.
These transformations affect display only.

### Git display controls and status templates

`git_worktree` is empty in the primary worktree; a linked worktree defaults to its top-level directory name, with `$path` available for the absolute path.
`git_commit`, `git_state`, and `git_metrics` are absent from the built-in root; metrics also requires `disabled = false`.

`git_branch` keeps detached output by default (`only_attached = false`) and suppresses bare repositories by default (`ignore_bare_repo = true`); setting the latter to `false` enables bounded bare-repository identity probes.
`ignore_branches` compares exact sanitized branch names before truncation; it is not a glob/regex list.
`always_show_remote = true` preserves Pi's remote fields even when branch labels agree.
When `false`, both remote fields are suppressed if the truncated remote branch is empty or equals the truncated local branch.
`ignore_remotes` compares exact remote names and suppresses only `$remote_name`, not `$remote_branch`.
Truncation independently retains `N` grapheme clusters of each field and appends the first grapheme of `truncation_symbol` when needed; `truncation_length = 0` is Pi's bounded unlimited sentinel, not upstream's very large integer.

`git_commit.only_detached = false` keeps attached and detached hashes visible; `true` restricts the module to detached HEAD.
`commit_hash_length` accepts 0–64 (default 7).
`$tag` is queried only when referenced and `tag_disabled = false` (default); `tag_symbol` defaults to the existing `" 🏷 "` prefix.
`tag_max_candidates = 0` preserves exact-HEAD tags; 1–100 selects `git describe --tags --first-parent --abbrev=0 --candidates=N HEAD`, which can show an ancestor tag.
`git_metrics.only_nonzero_diffs = true` hides each zero count; `false` exposes zeroes, including a clean `+0 -0`.
Its `ignore_submodules = false` preserves existing diffs; `true` excludes all submodule changes and disables external diff/text conversion for that metrics query.
The separate `git_status.ignore_submodules = true` ignores dirt inside submodules but retains changed gitlinks (`--ignore-submodules=dirty`).
`git_state` labels are configurable through `rebase`, `merge`, `revert`, `cherry_pick`, `bisect`, `am`, and `am_or_rebase`, preserving `REBASING`, `MERGING`, `REVERTING`, `CHERRY-PICKING`, `BISECTING`, `AM`, and `AM/REBASE` by default; progress is unchanged.

All 20 `git_status` state templates are supported: `stashed`, `ahead`, `behind`, `up_to_date`, `diverged`, `conflicted`, `deleted`, `renamed`, `modified`, `staged`, `untracked`, `typechanged`, the four `worktree_{added,deleted,modified,typechanged}`, and the four `index_{added,deleted,modified,typechanged}` options.
They use the [bounded status grammar](configuration.md#status-templates).
Positive safe-integer counts activate counted states; zero does not render even a literal template.
`$count`, `$ahead_count`, and `$behind_count` preserve Pi compact formatting: integers below 1,000, one-decimal `k` below 10,000, integer `k` below 1,000,000, then one-decimal `m`.
`$all_status` joins conflicted, stashed, deleted, renamed, modified, typechanged, staged, and untracked in that order with spaces.
Aggregates preserve Pi counters: deleted = index+worktree deleted; modified = worktree modified+added; staged = index modified+added+typechanged; typechanged = worktree typechanged.
`$ahead_behind` selects divergence when both counts are positive, otherwise ahead, behind, or up-to-date.
Up-to-date requires a known tracked zero/zero relation, not merely absent upstream metadata, and its default template is empty.
Clean output, symbols, count style, and ordering remain unchanged unless configured.

### Time formats, zones, and ranges

Time defaults to local `%H:%M`; `use_12hr = true` changes only the fallback to `%I:%M %p`.
A non-empty valid `time_format` overrides that choice and accepts at most 256 characters, literal text, and only these directives:

| Tokens | Output |
| --- | --- |
| `%%` | Literal `%` |
| `%H`, `%I`, `%M`, `%S` | Two-digit 24-hour, 12-hour, minute, second |
| `%p`, `%P` | `AM`/`PM`, `am`/`pm` |
| `%R`, `%T` | `HH:MM`, `HH:MM:SS` |
| `%r` | Unpadded 12-hour `h:MM:SS AM/PM` |
| `%Y`, `%m`, `%d`, `%F` | Year, two-digit month/day, `YYYY-MM-DD` |
| `%z`, `%:z` | Signed offset `HHMM`, `HH:MM` (minute precision) |

Unsupported directives/flags, a trailing `%`, empty format, or an oversized format use the configured 12/24-hour fallback.
`utc_time_offset` accepts at most 128 characters and defaults to exact `local`; it also accepts `UTC`, a runtime-supported IANA zone matching `[A-Za-z_]+(/[A-Za-z0-9_+.-]+)+`, or numeric hours matching `[+-]?\d{1,2}(\.\d{1,6})?` strictly between -24 and 24.
Numeric offsets truncate to whole seconds; colon offsets, surrounding whitespace, and unsupported/unknown zones fall back to local time.
IANA output follows the runtime's timezone data, including DST; it is not a fixed-offset approximation.

`time_range` defaults to `"-"` (unrestricted), has a 64-character runtime limit, and always gates against local wall time, not the output zone.
Use exactly one `-` between optional `HH:MM`, `HH:MM:SS`, or `HH:MM:SS.sss` endpoints (1–3 fractional digits, hours 00–23, minutes/seconds 00–59).
Endpoints are exclusive; a start later than the end crosses midnight, and equal endpoints exclude only that exact local wall time.
Invalid endpoints are ignored independently; missing/repeated separators or an oversized range disable the gate.
An out-of-range or invalid Date hides the whole module, including literal text.
Second-level formats do not add a one-second timer; refresh remains the [30-second fallback](runtime-and-security.md#-cached-refresh-lifecycle).
A configured range also re-evaluates visibility for symbol-only or static module formats.

### Jujutsu modules

`jj_bookmark`, `jj_change`, `jj_metrics`, and `jj_status` are disabled and absent from the built-in root.
Enable each wanted module with `disabled = false` and name it in `format` (or use `$all`).
They share one read-only `jj show` query with `--ignore-working-copy --no-integrate-operation`: values describe the recorded change, not newly captured dirty files.
See [runtime/security](runtime-and-security.md#jujutsu-and-native-system-reads) before enabling them.

`jj_bookmark` uses current-change bookmarks followed by those on the latest bookmark ancestor selected by `latest(bookmarks() & ::@, 1)`.
It shows the first remaining bookmark plus optional remote/divergence marker and the number of additional entries.
Exact `ignore_names` and `ignore_remotes` filter raw name and remote fields before independent grapheme truncation; literal `@`, quotes, or trailing `*` in a name are not parsed as display syntax.
An unsynced, non-conflicted local bookmark or tracked remote bookmark selects `diverged_symbol` (default `"*"`).
The mutable conflict ancestor contributes conflict state, not additional bookmark names.
`truncation_length` is 0–65,535 (default 65,535; zero disables truncation), and `truncation_symbol` defaults to `"…"`.
`jj_change` exposes composite styled IDs and plain prefix/suffix fields; configured lengths are 0–255 (default 7) but never cut a shortest-unique prefix.
A divergent change adds `/<offset>` to `$change`; `$change_offset` itself contains only digits.
`jj_metrics` shows recorded line additions/deletions and hides each zero by default; `only_nonzero_diffs = false` exposes zeroes.
`jj_status.$all` concatenates conflict, description, hidden, immutable, added, copied, deleted, modified, and renamed without separators.
Conflict includes the selected latest mutable conflicted ancestor; the description flag tests only presence, not description text.
Its templates use the same bounded status grammar: only the five file states accept `$count`, using unshortened integer counts; flag/description states accept no variables.
Missing CLI, unsupported CLI syntax, no repository, cancellation, timeout, and invalid/oversized output leave the modules empty.
Git and Jujutsu can be enabled together without treating either as an alias for the other.

### Native memory and battery

`memory_usage` and `battery` are disabled and absent from the built-in root, including `$all` until explicitly enabled.
Memory samples native `totalmem()`/`freemem()`; `$ram` is used/total in floored binary units (B through PiB), and `$ram_pct` is rounded to an integer percent.
Used bytes are clamped at zero; invalid/zero totals hide the module.
The finite `threshold` is -100–10,000 (default 75) and compares the rounded RAM percent; negative values always show valid samples and values above 100 hide them.
Only requested `$swap`/`$swap_pct` can read Linux `/proc/meminfo`, after the RAM threshold passes; they use the same usage/percentage formats, and absent/zero/invalid swap totals leave swap empty.
No other native swap reader is implemented.

Battery reads Linux sysfs only and uses energy-weighted totals across usable present batteries, not a mean of percentages.
It uses `ENERGY_NOW`/`ENERGY_FULL`, or `CHARGE_NOW`/`CHARGE_FULL` converted with positive design/current voltage; capacity-only devices have no fallback.
The displayed percentage is rounded, but `display` compares the raw percentage against upper bounds: lowest matching threshold wins, first entry wins ties, and no match/hidden rule hides the module.
Default `display` shows at most 10% in `red bold`; symbols are independently configurable through `full_symbol`, `charging_symbol`, `discharging_symbol`, `unknown_symbol`, and `empty_symbol`.
Charging takes priority over discharging when combining states; any remaining mixture of full and empty is unknown, regardless of device order.
Otherwise unknown states yield to a known full or empty state.
Unsupported platforms, no usable battery, or unavailable sources leave battery empty.
Physical charging, discharging, full, empty, and multi-battery transitions remain unverified; this reader is not a cross-platform hardware guarantee.

### Model and provider aliases and model truncation

The model module displays the raw Pi model ID by default. Set `shorten_model = true` to remove the leading `claude-`, a trailing `-20` followed by six digits, or a trailing `-latest`. Shortening does not replace `gpt-` with `gpt `; model IDs such as `gpt-6-sol` retain their hyphens. These rules match the ID text regardless of provider and apply only when no exact alias matches.
The model module also accepts exact `model_aliases`, Starship-style `truncation_length` and `truncation_symbol` options, plus the Pi-specific `truncation_direction` option:

```toml
[model]
shorten_model = true # optional; false by default
model_aliases = { "/models/Qwen3.6-35B-Q4.gguf" = "Qwen 35B Q4" }
truncation_length = 36
truncation_symbol = "…"
truncation_direction = "middle"
```

An exact alias replaces the raw model ID, bypasses optional shortening, and is then subject to the configured truncation.
`truncation_length` counts model grapheme clusters retained before the symbol; `0` disables truncation and is the default.
The direction names the removed portion: `start` retains the suffix, `end` retains the prefix and is the default, and `middle` retains both ends.
When no alias matches, truncation runs on the raw ID or the optionally shortened label.
Shortening and truncation change display only; the provider model ID is untouched.
Terminal control sequences in model IDs and truncation symbols are removed at render time.
An empty symbol truncates without a marker.

The provider module accepts exact display aliases without changing the selected provider or model:

```toml
[provider]
provider_aliases = { "openai-codex" = "codex", "amazon-bedrock" = "bedrock" }
```

An empty alias hides only the provider text.
Provider names and aliases are stripped of terminal controls at render time.
The `provider`, `model`, and `thinking` modules match `style_rules` against raw provider/model IDs and thinking levels before aliases, optional model shortening, configured truncation, or display sanitization.
A selector whose runtime value is unavailable does not match; exact selector fields and precedence are documented in [Configuration and Format](configuration.md#content-selected-styles).
For example, `middle` can retain both a Hugging Face model family and its variant, while `start` is useful when a llama.cpp server reports an absolute model path.
pi-starship treats model IDs as opaque strings and does not parse paths, repositories, GGUF suffixes, or quantization names.

`truncation_direction` is a pi-starship adaptation; upstream Starship has no model module or generic truncation-direction setting.
