# Module Reference

Use this authoritative public reference whenever a question or change involves a module, format variable, display rule, alias, truncation rule, or module-specific option.

## 🧱 Modules

| Module | Format variables | Meaning |
| --- | --- | --- |
| `brand` | `$symbol` | Pi brand marker |
| `provider` | `$symbol`, `$provider` | Current model provider |
| `model` | `$symbol`, `$model` | Current model name |
| `thinking` | `$symbol`, `$level` | Thinking level |
| `directory` | `$symbol`, `$path`, `$full_path` | Current working directory |
| `git_worktree` | `$symbol`, `$name`, `$path` | Linked worktree name and top-level path |
| `git_branch` | `$symbol`, `$branch`, `$remote_name`, `$remote_branch` | Local branch and upstream |
| `github_pr` | `$symbol`, `$number`, `$link`, `$state`, `$checks`, `$review`, `$status` | Current-branch GitHub pull request |
| `git_commit` | `$symbol`, `$hash`, `$tag` | Seven-character HEAD hash and optional exact tag |
| `git_state` | `$symbol`, `$state`, `$progress_current`, `$progress_total` | Rebase, merge, revert, cherry-pick, bisect, or mail-apply state |
| `git_metrics` | `$symbol`, `$added`, `$deleted` | Added/deleted line totals from the working tree diff |
| `git_status` | `$symbol`, `$all_status`, `$ahead_behind`, `$ahead`, `$behind`, `$diverged`, `$up_to_date`, `$conflicted`, `$stashed`, `$deleted`, `$renamed`, `$modified`, `$typechanged`, `$staged`, `$untracked`, and detailed index/worktree counters | Cached porcelain-v2 counters |
| `activity` | `$symbol`, `$state`, `$tool`, `$count`, `$kind`, `$title`, `$text` | Extension UI waits, active tools, streaming, completion, or idle |
| `context` | `$symbol`, `$percentage`, `$tokens`, `$window` | Context-window use |
| `tokens` | `$symbol`, `$input`, `$output`, `$total` | Token totals |
| `cache` | `$symbol`, `$rate`, `$read`, `$write` | Prompt-cache reads, writes, and latest hit rate; disabled by default |
| `cost` | `$symbol`, `$cost`, `$subscription` | Session cost and optional `(sub)` marker |
| `time` | `$symbol`, `$time` | Current local time |
| `turn` | `$symbol`, `$count` | User turn count |
| `package` | `$symbol`, `$version`, `$source` | Direct project manifest version |
| `nodejs` | `$symbol`, `$version`, `$engines_version` | Detected Node.js project/runtime |
| `python` | `$symbol`, `$version`, `$virtualenv`, `$pyenv_prefix` | Python runtime and allowlisted environment name |
| `rust` | `$symbol`, `$version`, `$numver`, `$toolchain` | Safe native `rustc` runtime and allowlisted toolchain name |
| `golang` | `$symbol`, `$version`, `$mod_version` | Go runtime (`$mod_version` is reserved and currently empty) |
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

The analogous modules keep their display policy local and use Starship defaults:

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

Directory `$path` contracts the home directory and, by default, the current Git repository root before retaining the last three path components.
`$full_path` remains the unmodified absolute cwd.
A positive `fish_style_pwd_dir_length` abbreviates otherwise omitted parent components when no substitution is configured.
`substitutions` is an ordered TOML string table of literal replacements.
Pi exposes one cwd rather than separate logical and physical paths, and pi-starship does not implement Starship's regex substitution array or repo-root-specific split style/format fields.
Directory rendering reads only immutable home and repository-root snapshot data and performs no filesystem or Git work.

Git branch truncation retains the first `N` grapheme clusters and appends the first grapheme of `truncation_symbol` only when truncation occurs.
The same rule applies independently to `$branch`, `$remote_name`, and `$remote_branch`.
Upstream Starship represents its unlimited default as `2^63 - 1`; pi-starship uses `0` for the same behavior because its settings integers are deliberately bounded.
`commit_hash_length` accepts 0 through 64.

Conda retains the last path component by default; `0` keeps the complete environment path.
Hostname trimming runs before exact alias lookup, matching Starship.
These transformations affect display only.
Collectors retain bounded, control-sanitized source metadata.

### Model and provider aliases and model truncation

The model module accepts exact `model_aliases`, Starship-style `truncation_length` and `truncation_symbol` options, plus the Pi-specific `truncation_direction` option:

```toml
[model]
model_aliases = { "/models/Qwen3.6-35B-Q4.gguf" = "Qwen 35B Q4" }
truncation_length = 36
truncation_symbol = "…"
truncation_direction = "middle"
```

An exact alias is selected before the built-in Claude/GPT shortening rules, then the resulting label is subject to the configured truncation.
`truncation_length` counts model grapheme clusters retained before the symbol; `0` disables truncation and is the default.
The direction names the removed portion: `start` retains the suffix, `end` retains the prefix and is the default, and `middle` retains both ends.
When no alias matches, truncation runs after the built-in Claude/GPT shortening rules.
Truncation changes display only; the provider model ID is untouched.
Terminal control sequences in model IDs and truncation symbols are removed at render time.
An empty symbol truncates without a marker.

The provider module accepts exact display aliases without changing the selected provider or model:

```toml
[provider]
provider_aliases = { "openai-codex" = "codex", "amazon-bedrock" = "bedrock" }
```

An empty alias hides only the provider text.
Provider names and aliases are stripped of terminal controls at render time.
For example, `middle` can retain both a Hugging Face model family and its variant, while `start` is useful when a llama.cpp server reports an absolute model path.
pi-starship treats model IDs as opaque strings and does not parse paths, repositories, GGUF suffixes, or quantization names.

`truncation_direction` is a pi-starship adaptation; upstream Starship has no model module or generic truncation-direction setting.

`git_worktree` is empty in the primary worktree.
In a linked worktree it defaults to the top-level directory name; use `$path` when the full absolute path is needed.

`git_commit`, `git_state`, and `git_metrics` are intentionally not present in the built-in root format.
Add their variables to `format` to opt in; also set `[git_metrics].disabled = false`, matching Starship's opt-in metrics default.
`$tag` resolves only an exact tag on HEAD and is queried only when the configured `git_commit` format references it.
