# Runtime and Security Reference

Use this authoritative public reference before enabling or explaining network, command-backed, development, cloud, deployment, host, user, or width-sensitive modules, and when checking runtime limitations.

## 🔒 Security and privacy

### 🔎 Native GitHub pull requests

`$github_pr` is independent of `pi-github-pr`; installing that extension is not required.
It runs one bounded GitHub CLI query for the current branch:

```text
gh pr view --json number,isDraft,url,state,closedAt,mergedAt,reviewDecision,statusCheckRollup
```

Install and authenticate `gh` first:

```bash
gh auth login
```

For GitHub Enterprise Server, authenticate the repository host and keep that host in the repository remote, for example `gh auth login --hostname github.example.com`. pi-starship starts `gh` directly with child-only environment data that omits ambient `GH_HOST` and `GH_REPO` overrides, so `gh` resolves the correct repository and host from the current checkout.
It never mutates Pi's environment, calls the GitHub API directly, or manages tokens.

Variables have these values:

- `$number`: digits such as `123`.
- `$link`: an OSC 8 `#123` link for a safe HTTP(S) URL when Pi's effective terminal capabilities enable hyperlinks, otherwise plain `#123`.
- `$state`: `open`, `draft`, `merged`, or `closed`.
- `$checks`: all non-zero check counts in passed, failed, pending order, or `-` when no checks exist.
- `$review`: `R✓` for approved, `R×` for changes requested, `R?` for review required, or empty when unknown.
- `$status`: one result selected in this order: merged, closed, draft, failing checks, changes requested, pending checks, approved, review required, passing checks, then no checks.

The compact symbols are font-safe and distinct from Git's default `$`, `!`, and `?` worktree markers:

| Compact value | Meaning |
| --- | --- |
| `✓<n>` | Checks that passed, including successful, skipped, and neutral conclusions |
| `×<n>` | Checks that failed |
| `…<n>` | Checks that are pending |
| `R✓` | Review approved |
| `R×` | Changes requested |
| `R?` | Review required |
| `M` / `C` / `D` | Merged, closed, or draft PR |
| `-` | No checks |

The unchanged default module format uses `$status` and now renders compact output:

```text
PR #123 · ×2
PR #123 · R✓
PR #123 · M
```

Use the existing `$checks` and `$review` variables together when every check category and the review result should remain visible:

```toml
[github_pr]
format = "[$symbol$link( $checks)( $review) ]($style)"
```

```text
PR #123 ✓12 ×2 …7 R×
```

This is a breaking display migration for custom formats that use these variables:

| Previous value | Compact value |
| --- | --- |
| `checks passing` | `✓<n>` |
| `<n> failing` | `×<n>` |
| `<n> pending` | `…<n>` |
| `no checks` | `-` |
| `approved` / `changes requested` / `review required` | `R✓` / `R×` / `R?` |
| `merged` / `closed` / `draft` | `M` / `C` / `D` |

The old English values have no verbose aliases.
The variable names and default module format remain unchanged, so no TOML field migration is needed.

The query runs only in TUI sessions when the enabled module is reachable from the root format.
It refreshes at session start, immediately after a branch change, after each agent run, after accepted settings changes, and every 60 seconds.
Each query has a 10-second timeout.
Branch changes clear the old PR before querying the new branch.
Closed and merged PRs remain visible for 24 hours, then expire without waiting for the next refresh.
Missing `gh`, missing authentication, no current PR, timeout, malformed or oversized output, and network failures all render an empty module without exposing raw errors or credentials.

The query sends the repository and current branch through authenticated `gh` to the repository's configured GitHub host.
It requests only the fields above—never comments, review bodies, inline comments, or review threads.
Footer rendering and previews read only the immutable cached snapshot and perform no network or subprocess work.

**Breaking migration:** `$git_branch.$pr` has been removed without a compatibility alias or automatic migration.
Replace it with root `$github_pr` and an optional `[github_pr]` table.
If `pi-github-pr` remains installed, its independent `github-pr` status can also appear under `$extension_status`.
Disable or remove that extension when adopting the native module to avoid duplicate information.

### 📦 Package and language modules

Module behavior and formatter syntax are inspired by Starship, with explicit Pi default and safety adaptations.
This is not complete Starship module or configuration compatibility; [module behavior](modules.md) and [configuration grammar](configuration.md) define the supported contract.

| Area | Adopted | Adapted | Intentionally omitted |
| --- | --- | --- | --- |
| `package` | `package.json` → Cargo → PEP 621/Poetry precedence, `$version`, private npm visibility control | Direct manifests only; Cargo workspace version lookup is capped at eight ancestors; private versions remain visible by default | Other package ecosystems, dynamic Python versions, package-manager execution |
| Node.js | Direct markers/extensions, `node --version`, package engine text, optional npm-semver checks | Bun/Deno markers suppress default detection; requirement text stays visible; checks require explicit styling | Manager/shim evaluation and runtime installation |
| Python | Direct markers, selected interpreter `--version`, virtualenv name, explicit argv alternatives and pyenv labels | Default selection remains an existing active virtualenv interpreter or `python`; explicit label mode can run `pyenv version-name` | Generated Python code, shell activation, and broad environment discovery |
| Rust | Direct markers and native `rustc --version` | `.cargo`/`.rustup` shim paths are rejected to avoid toolchain installation | Falling back to rustup or any installing probe |
| Go | Direct markers, `go version`, direct `go.mod` minimum, optional minimum check | Requirement text stays visible; checks require explicit styling | `go list`, module downloads, and toolchain installation |
| Bun / Deno | Direct markers and `bun --version` / `deno -V` | Negative detection avoids overlapping Node defaults | Runtime installation and recursive source detection |

Workspace runtime commands use argv execution in `ctx.cwd`, a 2-second timeout per command, and a 64 KiB combined stdout/stderr limit.
Language version commands run only for reachable modules and required values; explicit Node.js/Go requirement styling can also request a version command, but a symbol-only language format cannot.
Missing, killed, oversized, or malformed commands clear that value independently.
`version_format`, `detect_files`, `detect_extensions`, and `detect_folders` are available on language modules; package supports `version_format` and `display_private`.
Node/Go requirement reads use only direct `package.json`/`go.mod`, capped at 64 KiB, with no manager or network access.
See [requirement behavior](modules.md#nodejs-and-go-requirements) for the opt-in `not_capable_style` sentinel and failure behavior.

Python alternatives are bounded to 16 commands, 16 argv elements per alternative, and 1,024 characters per element; the runner appends `--version` without shell parsing.
A configured executable or argument can still execute arbitrary program logic. Review imported `python_binary` settings before applying them.
`pyenv_version_name` can read `PYENV_VERSION` or run only `pyenv version-name`; no Python script, shell initialization, or pyenv activation is generated.
See [command grammar](configuration.md#python-command-alternatives) and [Python labels](modules.md#python-interpreter-and-environment-labels).

### 🧰 Development environments

| Module | Detection / allowed inputs | Optional command | Options |
| --- | --- | --- | --- |
| `mise` | Direct `mise.toml`, `.mise.toml`, or `.tool-versions` | `mise doctor` only for `$health` | Detection arrays, healthy/unhealthy labels |
| `direnv` | Direct `.envrc` or explicitly configured environment detection; the file is never read or sourced | `direnv status --json` only for status variables | Detection arrays, `detect_env_vars`, permission/load messages |
| `conda` | Non-empty `CONDA_DEFAULT_ENV`, with an optional detector gate | None | `ignore_base` (default `true`), `detect_env_vars`, truncation |
| `pixi` | Direct `pixi.toml`/`pixi.lock`, `PIXI_ENVIRONMENT_NAME`, `PIXI_PROJECT_NAME` | `pixi --version` only for `$version` | Detection arrays, `version_format`, `show_default_environment` |
| `nix_shell` | `IN_NIX_SHELL`, `NIX_SHELL_NAME`, `NIX_SHELL_LEVEL` | None | Pure/impure messages; no unknown-shell heuristic |
| `guix_shell` | Non-empty `GUIX_ENVIRONMENT` | None | None |

The workspace collector never enumerates the process environment, activates a shell, evaluates Nix, lists installed tools, or publishes arbitrary environment values.
It copies a fixed allowlist plus valid names explicitly configured in `detect_env_vars` into its runtime/child environment; a leading `!` is removed from those names.
Presence includes empty strings, positive names use OR, and present negatives veto the environment detector; file/environment precedence is [module-specific](modules.md#environment-detection-and-messages).
Configured detector values are not output, but can be passed to workspace subprocesses: do not name credentials merely to test their presence.
Python's known labels use `VIRTUAL_ENV`, `CONDA_DEFAULT_ENV`, `PYENV_VERSION`; Rust uses `RUSTC`, `RUSTUP_TOOLCHAIN`, and `PATH`.
No unrestricted `env_var` output is provided.
Names and paths are control-sanitized and bounded before publication.

### 🚢 Deployment and cloud context

These modules read inert local metadata only.
They do **not** contact Docker, Kubernetes, Terraform/OpenTofu backends, cloud APIs, OAuth flows, credential helpers, or metadata services.
They remain opt-in because context labels may be sensitive.

- `docker_context`: `DOCKER_CONTEXT`, then `DOCKER_CONFIG/config.json` or `~/.docker/config.json`.
  The `default` context is suppressed.
  `only_with_files` and detection arrays are supported.
- `kubernetes`: at most `max_config_files` (1–32, default 8) from `KUBECONFIG` or `~/.kube/config`, with first-wins merge semantics.
  Only context, namespace, cluster name, and user name are selected.
  Configured direct detectors take precedence over environment detectors; with none configured, the optional environment gate applies.
  Up to 64 ordered context/user rules use whole-label bounded RE2JS matching (AND, first match) and can set aliases, symbol, and style; legacy alias maps remain exact and run afterward.
  Patterns, replacement bounds, unsupported syntax, and rule failures are defined in [configuration grammar](configuration.md#bounded-regex-and-structured-options).
  Kubeconfig `exec`, auth-provider, token files, certificates, and cluster URLs are never executed, followed, or contacted.
- `terraform`: direct `.tf`, `.tfplan`, `.tfstate`, or `.terraform`; workspace precedence is `TF_WORKSPACE` → `TF_DATA_DIR/environment` → `.terraform/environment`.
  `terraform version`, then `tofu version`, runs only for `$version`.
  Workspace, init, provider, and state commands never run.
- `aws`: `AWS_PROFILE`/`AWS_DEFAULT_PROFILE`, `AWS_REGION`/`AWS_DEFAULT_REGION`, then the selected AWS config section.
  The credentials file is never read.
  Exact profile/region aliases are supported.
- `gcloud`: active selector plus allowlisted `core.account`, `core.project`, and `compute.region` INI keys.
  `detect_env_vars` adds a presence gate before config reads; exact project/region aliases are supported.
- `azure`: the default local `azureProfile.json` subscription name.
  `show_username` defaults to `false`; exact subscription aliases are supported.
- `openstack`: `OS_CLOUD`, `OS_PROJECT_NAME`, or the selected `clouds.yaml` `auth.project_name` only.
  Exact cloud/project aliases are supported.

Cloud files often colocate credentials with labels.
Parsers allowlist fields while reading and discard source documents; token, key, password, auth URL, tenant, and credential-derived duration fields never enter snapshots, diagnostics, notifications, or rendered output.
Presence indicates only selected local metadata—not valid credentials or connectivity.

### 🖥️ Execution context

`hostname` is SSH-only by default and supports `ssh_only`, `trim_at`, exact `aliases`, a configurable SSH-only `ssh_symbol`, and an additional `detect_env_vars` presence gate.
`username` appears only for `show_always`, SSH, root/Administrator, a login-user mismatch, or configured `detect_env_vars`; it supports exact aliases.
Negated username detection names are rejected.
`os` is disabled by default and supports an exact `symbols` map.
`container` uses only Dev Container/Codespaces markers, WSL metadata, `/.dockerenv`, `/run/.containerenv`, and `/run/systemd/container`; it does not scan process tables or cgroups.
Ordinary local hostname/username sessions stay empty by default.
All identity labels are bounded and stripped of C0/C1 controls, ANSI, newlines, and OSC control bytes.

### Directory and Git metadata

Directory defaults add no physical-path or permission probes.
`use_logical_path = false` requests cached `realpath` only for referenced path variables; failure keeps Pi's cwd.
A non-empty `$read_only` indicator in the main or enabled alternate root format requests `fs.access(W_OK)` on cwd, following symlinks.
Only `EACCES`, `EPERM`, or `EROFS` means known denial; other failures mean unknown and hide the indicator.
This is a cached current-process writability approximation, not proof of ACL state or a future write result.
No file contents are read for these probes.

Git identity/status queries have a 3-second timeout per command and a 64 KiB accepted combined-output limit.
Optional tag, metrics, submodule, and bare-repository queries are controlled by the [Git settings](modules.md#git-display-controls-and-status-templates).
They do not fetch, pull, push, or intentionally modify the checkout; Git and its local configuration remain trusted executable inputs.
All new format/template/substitution output is terminal-sanitized before display; raw stored settings and snapshots are not rewritten for display.

### Jujutsu and native system reads

`jj_bookmark`, `jj_change`, `jj_metrics`, `jj_status`, `memory_usage`, and `battery` are disabled by default and absent from the built-in root.
They add no reads or commands until explicitly enabled and reachable, including through `$all`.
Rendering, inspection, and live previews use only existing immutable snapshots.

Jujutsu discovery checks at most 64 directories, starting at cwd, for a directory named `.jj`; each listing is bounded to 2,048 entries and does not recurse into children.
One shared bounded `jj show` query uses fixed argv with `--color never --ignore-working-copy --no-integrate-operation --no-pager --quiet --repository <root>`, `--no-patch`, a fixed revset, and a fixed template.
It selects the recorded working-copy change, latest mutable conflicted ancestor head, and latest bookmark ancestor.
The query does not snapshot dirty files or integrate pending operations, so unrecorded worktree changes are deliberately absent.
It collects IDs/unique-prefix lengths, bookmark labels, boolean flags, line totals, and file-status counts, not description text or patches.
There is no fetch/push, shell command, credential lookup, or network request added by this collector.
Missing/unsupported `jj`, timeout, cancellation, malformed output, or the 64 KiB output bound makes the result unavailable.
The installed CLI and repository configuration must still be trusted.

Memory uses Node's native `totalmem()` and `freemem()`, not a subprocess or process-table scan.
Only referenced swap variables, after the RAM threshold passes, can read Linux `/proc/meminfo` (64 KiB) for `SwapTotal`/`SwapFree`.
Other platforms and unavailable/zero swap totals omit swap; no cross-platform swap reader is claimed.

Battery is Linux sysfs only: it lists `/sys/class/power_supply`, rejects enumerations over 32 entries, and reads each accepted device's `uevent` at most 8,192 bytes.
Only `Battery` sources with `POWER_SUPPLY_PRESENT` omitted or equal to `1` and valid energy totals are usable.
Charge conversion uses valid `VOLTAGE_MIN_DESIGN` when available, otherwise `VOLTAGE_NOW`; a missing or non-positive selected voltage makes charge-only data unusable.
Totals are energy-weighted, and capacity-only or invalid sources have no percentage fallback.
No external command, privileged probe, device installation, or alternate-platform reader is used.
Charging/discharging/full/empty, physical multi-battery transitions, and native behavior on other hardware remain unverified; deterministic fixtures do not establish cross-platform hardware support.
See [native module behavior](modules.md#native-memory-and-battery) for threshold, state, and display rules.

## 📐 Layout and lifecycle

### ↔️ Fill layout

Add `${fill}` between left and right root content (braces disambiguate adjacent text):

```toml
format = "$directory$git_branch${fill}$model$context"

[fill]
symbol = " " # native invisible default; use "·" for a visible pattern
style = "dimmed"
```

Fill resolves independently on each logical line before ANSI serialization and wrapping.
Multiple fills divide remaining cells left-to-right; complete positive-width patterns repeat and any remainder uses styled spaces.
Empty/zero-width patterns become spaces.
Fixed content is never truncated: when it already meets or exceeds the width, fill contributes zero and normal ANSI-aware wrapping applies.
Unicode wide/combining symbols, palettes, `prev_fg`/`prev_bg`, ANSI, and OSC hyperlinks use Pi TUI visible-width semantics.
`$all` deliberately includes enabled fill, so use `$all` only when that whole-catalog layout is intended.
There is no `line_break` module; use literal newlines in `format`.

### 🔄 Cached refresh lifecycle

Workspace (including optional Jujutsu/system readers), Git, and GitHub PR readers start only in TUI sessions and only for reachable enabled modules.
Root format reachability, `$all`, module `disabled`, and module-format variables determine file and command requirements.
Workspace/Git refreshes run at session start, after accepted settings, branch changes, tool/turn completion, and a 30-second fallback.
GitHub PR uses the narrower lifecycle and 60-second network refresh described above.
One read runs with at most one latest pending refresh.
Immutable snapshot equality suppresses collector-driven redraws, and session or request generations reject stale results.
The 30-second fallback does not request a redraw for unchanged snapshots.
For a reachable time module referencing `$time`, or using a non-empty `time_range` other than `"-"`, the fallback also re-evaluates clock output and range visibility from the last rendered snapshot without re-reading session history.
This includes range-gated symbol-only/static formats; seconds, dates, and ranges use the existing 30-second fallback, not a one-second timer.
Only changed rendered lines request that redraw; unrelated Pi events can also redraw the footer.
Background collection continues even when a terminal pane is not visible.
Shutdown, replacement, footer disposal, branch changes, and accepted settings abort active command work before starting replacements; disabling `github_pr` also stops its query and timers.
Bounded local filesystem operations may finish, but stale generations cannot publish them.
Execution identity is retained rather than re-read by the periodic fallback.
Render and live preview consume snapshots synchronously and perform zero reads or commands.

Missing, unreadable, malformed, oversized, timed-out, or unavailable sources produce empty values.
Workspace metadata files are capped at 64 KiB unless a smaller bound is stated; direct project detection shares one bounded current-directory listing and never recurses.
Git command output is capped as described above; Git operation/progress markers are local reads.
The Cargo package lookup stops after eight parents; Jujutsu root discovery is the separate bounded ancestor walk described above.
These collectors make no network calls; the native GitHub PR query is the documented background network exception.

## 🚧 Limitations

- The formatter and modules are Starship-inspired, not fully compatible with Starship.
- The extension does not load `starship.toml`, invoke the Starship binary, run custom shell modules, or provide unrestricted `env_var` behavior.
- JVM/.NET and other long-tail languages, VCS integrations beyond Git/Jujutsu, system monitoring beyond the documented RAM/Linux battery readers, and additional DevOps modules remain outside this package's supported surface.
- AWS credential inspection/expiration and `force_display`, Nix heuristic discovery, `terraform.commands`, and `pixi.pixi_binary` remain intentionally unsupported.
- Battery has no non-Linux or capacity-only fallback; native hardware transitions remain unverified. Memory has no non-Linux swap reader.
- Pi does not expose the auto-compaction toggle, so the footer cannot reliably show Pi's native `(auto)` marker.
