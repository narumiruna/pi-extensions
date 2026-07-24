# 🚀 pi-starship — Native Starship-style Statusline for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-starship)](https://www.npmjs.com/package/@narumitw/pi-starship) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

A native Pi footer configured with Starship-style TOML. It parses and renders formats itself—no `starship` executable or shell prompt required.

> **Different package:** the unscoped npm package `pi-starship` delegates to the Starship binary. This package is `@narumitw/pi-starship` and renders Pi-specific modules natively.

## ✨ Features

- Automatically creates a readable Tokyo Night configuration on first session start.
- Starship-style root/module formats, conditional groups, `$all`, styles, and palettes.
- Pi modules for model, thinking, activity, context, tokens, cost, turn, and extension statuses.
- Cached Git branch, commit, operation state, line metrics, detailed status, and linked-worktree identity.
- Opt-in package, language, development-shell, deployment, cloud, and execution-context modules.
- Width-aware `$fill` alignment for native multiline left/right layouts.
- Footer rendering is pure: no subprocess, network, filesystem, timer, or environment work runs from `render()`.
- Multiline output wraps to the terminal width instead of truncating.
- Goal-oriented `/starship` menu with configuration health, preview, confirmation, and recovery.

## 📦 Install

```bash
pi install npm:@narumitw/pi-starship
```

Try it from a checkout:

```bash
pi -e ./extensions/pi-starship
```

Do not enable this together with `@narumitw/pi-statusline`: both own Pi's footer. `pi-starship` warns when it detects the conflict.

## ⚙️ Configuration

The only configuration source is:

```text
<getAgentDir()>/pi-starship.toml
```

On the first session start, the extension atomically creates this file from its readable Tokyo Night default. It never overwrites an existing document, including a malformed one. If initialization fails, the built-in configuration remains active and the failure is reported as a warning.

The extension does **not** read project overrides, `pi-statusline.json`, `PI_STATUSLINE_PRESET`, or `~/.config/starship.toml`, and does not migrate statusline settings.

Open the interactive menu in TUI mode:

```text
/starship
```

Choose **Customize footer** to edit the TOML. Closing the editor validates the draft and opens a width-aware preview; saving happens only after a separate confirmation. Confirmed changes are atomically saved and applied immediately. Editor cancellation, preview cancellation, invalid drafts, write failures, and runtime application failures preserve the previous file and effective footer.

The **Advanced** menu is one level deep and contains configuration details plus **Restore built-in**. Restore shows the concrete built-in preview and requires explicit overwrite confirmation.

### 📝 Example

```toml
format = "$brand$provider$model$thinking\n$directory$git_branch$git_status\n$activity$context$tokens$cost$time$turn\n$extension_status"
palette = "tokyo-night"

[palettes.tokyo-night]
header = "#7aa2f7"
header_fg = "#1a1b26"
custom = "208"

[model]
format = "[ $symbol$model ]($style)"
symbol = "◆ "
style = "bold fg:header_fg bg:header"
disabled = false

[activity]
format = "([ $text ]($style))"
style = "fg:custom"

[git_branch]
format = "[ $symbol$branch$pr ]($style)"

[package]
version_format = "v$raw"

[nodejs]
detect_files = ["package.json", "!deno.json"]
detect_extensions = ["js", "ts"]

[hostname]
ssh_only = true
trim_at = "."
aliases = { "build.example.test" = "builder" }

[extension_status]
format = "([$statuses ]($style))"
icons = { "github-pr" = "PR", "foo:*" = "🧪", "@narumitw/pi-goal" = "◎", fallback = "•" }
```

All module tables support `format`, `symbol`, `style`, and `disabled`. Module-specific
options are catalog-owned, type-checked, and listed below; unknown options warn and stay inactive.
Version formats replace `$raw`. Detection arrays replace defaults when non-empty and inspect only one
listing of the current directory. A leading `!` is supported by language detection arrays and rejects
a matching project.
`[extension_status].icons` accepts arbitrary exact Pi status keys, explicit colon namespace
wildcards such as `foo:*`, and installed package IDs; `fallback` controls unmatched statuses. Icon
matching uses exact key, longest `:*` wildcard, unambiguous package alias, leading status emoji,
built-in icon, then `fallback`/`🔌`. An empty icon suppresses only the icon. `foo:*` matches
`foo:server` but not `foo`, `foobar`, or `foo/server`.

Pi does not expose which package owns a status, so package aliases are best-effort conveniences and
exact raw keys are the reliable third-party contract. Extension authors may adopt
`<extension-id>` or `<extension-id>:<stable-slot>` for interoperability, but pi-starship cannot
require that convention. Canonical built-ins use `sync` and `retry`; compatibility mappings keep
`pisync` and `unknown-error-retry` settings and older producer versions working.

## 🧩 Format grammar

- Variables: `$name` and `${name}`. Unknown variables render empty and produce a warning when loaded from TOML.
- Escapes: `\\$`, `\\[`, `\\]`, `\\(`, `\\)`, and `\\\\` render functional characters literally.
- Styled groups: `[format string](style string)`.
- Conditional groups: `(format string)` render only when a nested variable has a non-empty value.
- Nested groups are supported.
- `$all` expands enabled modules in the default order and omits modules already referenced explicitly.

Module formats can use `$style` in a style expression. Module output keeps its own style when embedded in an outer styled group.

## 🎨 Styles and palettes

Style expressions support:

- Named colors and ANSI numbers `0`–`255`.
- Hex RGB (`#7aa2f7`).
- `fg:<color>` and `bg:<color>`; an unprefixed color is foreground.
- `bold`, `dimmed`, `italic`, `underline`, `blink`, `inverted`, `hidden`, and `strikethrough`.
- `none`, `fg:none`, and `bg:none`.
- `prev_fg` and `prev_bg` to inherit the previous rendered chunk's colors.
- Color names from the active `[palettes.<name>]` table. The active palette overlays the built-in Tokyo Night colors so the default module styles remain available.

An invalid root format falls back to the built-in root format. An invalid module format or style falls back only for that module. `/starship status` reports warnings.

## 🧱 Modules

| Module | Format variables | Meaning |
| --- | --- | --- |
| `brand` | `$symbol` | Pi brand marker |
| `provider` | `$symbol`, `$provider` | Current model provider |
| `model` | `$symbol`, `$model` | Current model name |
| `thinking` | `$symbol`, `$level` | Thinking level |
| `directory` | `$symbol`, `$path`, `$full_path` | Current working directory |
| `git_worktree` | `$symbol`, `$name`, `$path` | Linked worktree name and top-level path |
| `git_branch` | `$symbol`, `$branch`, `$remote_name`, `$remote_branch`, `$pr` | Branch, upstream, and actionable PR state |
| `git_commit` | `$symbol`, `$hash`, `$tag` | Seven-character HEAD hash and optional exact tag |
| `git_state` | `$symbol`, `$state`, `$progress_current`, `$progress_total` | Rebase, merge, revert, cherry-pick, bisect, or mail-apply state |
| `git_metrics` | `$symbol`, `$added`, `$deleted` | Added/deleted line totals from the working tree diff |
| `git_status` | `$symbol`, `$all_status`, `$ahead_behind`, `$ahead`, `$behind`, `$diverged`, `$up_to_date`, `$conflicted`, `$stashed`, `$deleted`, `$renamed`, `$modified`, `$typechanged`, `$staged`, `$untracked`, and detailed index/worktree counters | Cached porcelain-v2 counters |
| `activity` | `$symbol`, `$state`, `$tool`, `$count`, `$text` | Active tools, streaming, completion, or idle |
| `context` | `$symbol`, `$percentage`, `$tokens`, `$window` | Context-window use |
| `tokens` | `$symbol`, `$input`, `$output`, `$total` | Token totals |
| `cost` | `$symbol`, `$cost` | Session cost |
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

`git_worktree` is empty in the primary worktree. In a linked worktree it defaults to the top-level directory name; use `$path` when the full absolute path is needed.

`git_commit`, `git_state`, and `git_metrics` are intentionally not present in the built-in root format. Add their variables to `format` to opt in; also set `[git_metrics].disabled = false`, matching Starship's opt-in metrics default. `$tag` resolves only an exact tag on HEAD and is queried only when the configured `git_commit` format references it.

If `$git_branch.$pr` is present in the module format, its selected PR token is removed from `extension_status` to avoid duplication.

### 📦 Package and language modules

The native behavior is inspired by Starship pinned at
`9f4d07ed45804e280d6884bb8ced7ea3d3033093`; it is not complete Starship compatibility.

| Area | Adopted | Adapted | Intentionally omitted |
| --- | --- | --- | --- |
| `package` | `package.json` → Cargo → PEP 621/Poetry precedence, `$version` | Direct manifests only; Cargo workspace version lookup is capped at eight ancestors | Other package ecosystems, dynamic Python versions, package-manager execution |
| Node.js | Direct markers/extensions, `node --version`, package engine text | Bun/Deno markers suppress Node's default detection | Constraint checks and manager/shim evaluation |
| Python | Direct markers, selected interpreter `--version`, virtualenv name | Interpreter selection uses only an existing active virtualenv path or `python` | Python code execution and broad environment discovery |
| Rust | Direct markers and native `rustc --version` | `.cargo`/`.rustup` shim paths are rejected to avoid toolchain installation | Falling back to rustup or any installing probe |
| Go | Direct markers and `go version` | `$mod_version` stays empty | `go list`, module downloads, and constraint enforcement |
| Bun / Deno | Direct markers and `bun --version` / `deno -V` | Negative detection avoids overlapping Node defaults | Runtime installation and recursive source detection |

All runtime commands use argv execution in `ctx.cwd`, a 2-second timeout, and 64 KiB accepted output.
Commands run only when the reachable module format references the command-backed variable. Missing,
killed, oversized, or malformed commands clear that value independently. `version_format`,
`detect_files`, `detect_extensions`, and `detect_folders` are available on language modules; package
supports `version_format`.

### 🧰 Development environments

| Module | Detection / allowed inputs | Optional command | Options |
| --- | --- | --- | --- |
| `mise` | Direct `mise.toml`, `.mise.toml`, or `.tool-versions` | `mise doctor` only for `$health` | Detection arrays |
| `direnv` | Direct `.envrc`; the file is never read or sourced | `direnv status --json` only for status variables | Detection arrays |
| `conda` | `CONDA_DEFAULT_ENV` only | None | `ignore_base` (default `true`) |
| `pixi` | Direct `pixi.toml`/`pixi.lock`, `PIXI_ENVIRONMENT_NAME`, `PIXI_PROJECT_NAME` | `pixi --version` only for `$version` | Detection arrays, `version_format`, `show_default_environment` |
| `nix_shell` | `IN_NIX_SHELL`, `NIX_SHELL_NAME`, `NIX_SHELL_LEVEL` | None | None |
| `guix_shell` | Presence of `GUIX_ENVIRONMENT` | None | None |

The extension never enumerates the process environment, activates a shell, evaluates Nix, lists
installed tools, or publishes arbitrary environment values. Names and paths are control-sanitized and
bounded before publication.

### 🚢 Deployment and cloud context

These modules read inert local metadata only. They do **not** contact Docker, a Kubernetes cluster,
a Terraform/OpenTofu backend, a cloud API, an OAuth flow, a credential helper, or a metadata service.
The deployment/cloud safety review retained opt-in root behavior: context labels may be sensitive and
there is no usage evidence justifying more default footer density.

- `docker_context`: `DOCKER_CONTEXT`, then `DOCKER_CONFIG/config.json` or `~/.docker/config.json`;
  `default` is suppressed. `only_with_files` and detection arrays are supported.
- `kubernetes`: at most `max_config_files` (default 8) from `KUBECONFIG` or `~/.kube/config`, with
  first-wins merge semantics. Only context, namespace, cluster name, and user name are selected.
  Exact `context_aliases`, `namespace_aliases`, `cluster_aliases`, and `user_aliases` apply.
- `terraform`: direct `.tf`, `.tfplan`, `.tfstate`, or `.terraform`; workspace precedence is
  `TF_WORKSPACE` → `TF_DATA_DIR/environment` → `.terraform/environment`. `terraform version`, then
  `tofu version`, runs only for `$version`. Workspace, init, provider, and state commands never run.
- `aws`: `AWS_PROFILE`/`AWS_DEFAULT_PROFILE`, `AWS_REGION`/`AWS_DEFAULT_REGION`, then the selected AWS
  config section. The credentials file is never read. Exact profile/region aliases are supported.
- `gcloud`: active selector plus allowlisted `core.account`, `core.project`, and `compute.region` INI
  keys. Exact project/region aliases are supported.
- `azure`: the default local `azureProfile.json` subscription name. `show_username` defaults to
  `false`; exact subscription aliases are supported.
- `openstack`: `OS_CLOUD`, `OS_PROJECT_NAME`, or the selected `clouds.yaml` `auth.project_name` only;
  exact cloud/project aliases are supported.

Cloud files often colocate credentials with labels. Parsers allowlist fields while reading and
discard source documents; token, key, password, auth URL, tenant, and credential-derived duration
fields never enter snapshots, diagnostics, notifications, or rendered output. Presence indicates only
selected local metadata—not valid credentials or connectivity.

### 🖥️ Execution context

`hostname` is SSH-only by default and supports `ssh_only`, `trim_at`, and exact `aliases`. `username`
appears only for `show_always`, SSH, root/Administrator, a login-user mismatch, or configured
`detect_env_vars`; it supports exact aliases. Negated username detection names are rejected. `os` is
disabled by default and supports an exact `symbols` map. `container` uses only Dev Container/Codespaces
markers, WSL metadata, `/.dockerenv`, `/run/.containerenv`, and `/run/systemd/container`; it does not
scan process tables or cgroups. Ordinary local hostname/username sessions stay empty. All identity
labels are bounded and stripped of C0/C1 controls, ANSI, newlines, and OSC control bytes.

### ↔️ Fill layout

Add `${fill}` between left and right root content (braces disambiguate adjacent text):

```toml
format = "$directory$git_branch${fill}$model$context"

[fill]
symbol = " " # native invisible default; use "·" for a visible pattern
style = "dimmed"
```

Fill resolves independently on each logical line before ANSI serialization and wrapping. Multiple
fills divide remaining cells left-to-right; complete positive-width patterns repeat and any remainder
uses styled spaces. Empty/zero-width patterns become spaces. Fixed content is never truncated: when it
already meets or exceeds the width, fill contributes zero and normal ANSI-aware wrapping applies.
Unicode wide/combining symbols, palettes, `prev_fg`/`prev_bg`, ANSI, and OSC hyperlinks use Pi TUI
visible-width semantics. `$all` deliberately includes enabled fill, so use `$all` only when that
whole-catalog layout is intended. There is no `line_break` module; use literal newlines in `format`.

### 🔄 Cached refresh lifecycle

Workspace and Git readers start only in TUI sessions and only for reachable enabled modules. Root
format reachability, `$all`, module `disabled`, and module-format variables determine file and command
requirements. Refreshes run at session start, after accepted settings, branch changes, tool/turn
completion, and a 30-second fallback. One read runs with at most one latest pending refresh; immutable
snapshot equality suppresses redraws, and session/config generations reject stale results. Shutdown,
replacement, and footer disposal stop timers, clear pending work, and prevent late publication.
Execution identity is retained rather than re-read by the periodic fallback. Render and live preview
consume snapshots synchronously and perform zero reads or commands.

Missing, unreadable, malformed, oversized, timed-out, or unavailable sources fail to empty values.
Readers cap direct files at 64 KiB, use one bounded current-directory listing, never recurse, and make
no network calls. Package's explicitly documented Cargo lookup is the only ancestor walk and is capped
at eight parents.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/starship` | Open the current-state menu in TUI mode; retain help behavior outside TUI |
| `/starship settings` | Open the compatible direct edit → preview → confirm flow (TUI only) |
| `/starship status` | Show config source/path and diagnostics |
| `/starship help` | Show command and configuration help |

The main menu keeps frequent goals visible: **Customize footer**, **Check configuration**, and **Help**. It shows whether the footer uses the built-in or custom document and displays the current warning count. **Advanced** contains uncommon details and the confirmed restore action, with an explicit **Back** path.

Status and help remain safe in TUI, RPC, JSON, and print modes. RPC receives notifications but never opens custom terminal UI; print and JSON modes produce no ad hoc output. Footer/timer/Git lifecycle work starts only in TUI mode.

## 📐 Scope

The formatter, style concepts, and selected contextual modules are Starship-inspired, while Pi owns
the lifecycle, snapshots, privacy boundary, and footer layout. This extension does not load
`starship.toml`, claim complete module/config compatibility, invoke the Starship binary, run custom
shell modules, or expose unrestricted `env_var` behavior. JVM/.NET, other long-tail languages,
alternative VCS, system-monitor, and additional DevOps modules remain demand-gated; the first-wave
review found no issue/discussion evidence for a coherent follow-up batch, so no second wave is added.

Pi-native model, context, cost, Git metrics, and activity remain owned by the existing modules. The
lifecycle design rejects provider-specific duplicates and ambiguous `turn_duration`/`last_result`
modules until separately approved semantics exist.

## ➕ Adding a module

Create `src/modules/<name>.ts` with its format variables, defaults, and runtime value resolver, then register it in display order in `src/modules/catalog.ts`. Configuration names, validation variables, defaults, and `$all` ordering are derived from that catalog. Add the module to the built-in root format when it should be visible by default, then document and test its user-facing values.

Keep `extension_status` last in the catalog so earlier modules can consume extension-owned status values without rendering duplicates.

## 🗂️ Package layout

- `src/index.ts` — Pi package entrypoint.
- `src/pi-starship.ts` — extension lifecycle, cached refresh binding, live preview, and footer.
- `src/commands.ts` — goal-oriented menu, preview/confirmation, diagnostics, and compatibility routes.
- `src/config.ts` — TOML loading, draft validation, defaults, atomic persistence, and rollback.
- `src/format/` — native format/style parser and renderer.
- `src/modules/` — domain module definitions, ordered registry, reachability, and width-aware renderer.
- `src/modules/git/` — bounded Git reader plus branch, status, and worktree modules.
- `src/runtime/` — shared refresh controller and bounded package/language/context collectors.

## 🔎 Keywords

Pi Coding Agent, Starship statusline, Starship TOML, terminal footer, native statusline, Pi extension

## 📄 License

MIT. See [`LICENSE`](./LICENSE). Starship attribution and its ISC license are included in [`NOTICES.md`](./NOTICES.md).
