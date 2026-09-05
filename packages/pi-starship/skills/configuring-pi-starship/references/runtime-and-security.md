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

Module behavior is inspired by Starship pinned at `9f4d07ed45804e280d6884bb8ced7ea3d3033093`; formatter style semantics and the approved multi/state-style surfaces are aligned with the checked-in Starship source at `cad50cd8`.
This is not complete Starship module or configuration compatibility.

| Area | Adopted | Adapted | Intentionally omitted |
| --- | --- | --- | --- |
| `package` | `package.json` → Cargo → PEP 621/Poetry precedence, `$version` | Direct manifests only; Cargo workspace version lookup is capped at eight ancestors | Other package ecosystems, dynamic Python versions, package-manager execution |
| Node.js | Direct markers/extensions, `node --version`, package engine text | Bun/Deno markers suppress Node's default detection | Constraint checks and manager/shim evaluation |
| Python | Direct markers, selected interpreter `--version`, virtualenv name | Interpreter selection uses only an existing active virtualenv path or `python` | Python code execution and broad environment discovery |
| Rust | Direct markers and native `rustc --version` | `.cargo`/`.rustup` shim paths are rejected to avoid toolchain installation | Falling back to rustup or any installing probe |
| Go | Direct markers and `go version` | `$mod_version` stays empty | `go list`, module downloads, and constraint enforcement |
| Bun / Deno | Direct markers and `bun --version` / `deno -V` | Negative detection avoids overlapping Node defaults | Runtime installation and recursive source detection |

All runtime commands use argv execution in `ctx.cwd`, a 2-second timeout, and 64 KiB accepted output.
Commands run only when the reachable module format references the command-backed variable.
Missing, killed, oversized, or malformed commands clear that value independently.
`version_format`, `detect_files`, `detect_extensions`, and `detect_folders` are available on language modules; package supports `version_format`.

### 🧰 Development environments

| Module | Detection / allowed inputs | Optional command | Options |
| --- | --- | --- | --- |
| `mise` | Direct `mise.toml`, `.mise.toml`, or `.tool-versions` | `mise doctor` only for `$health` | Detection arrays |
| `direnv` | Direct `.envrc`; the file is never read or sourced | `direnv status --json` only for status variables | Detection arrays |
| `conda` | `CONDA_DEFAULT_ENV` only | None | `ignore_base` (default `true`) |
| `pixi` | Direct `pixi.toml`/`pixi.lock`, `PIXI_ENVIRONMENT_NAME`, `PIXI_PROJECT_NAME` | `pixi --version` only for `$version` | Detection arrays, `version_format`, `show_default_environment` |
| `nix_shell` | `IN_NIX_SHELL`, `NIX_SHELL_NAME`, `NIX_SHELL_LEVEL` | None | None |
| `guix_shell` | Presence of `GUIX_ENVIRONMENT` | None | None |

The extension never enumerates the process environment, activates a shell, evaluates Nix, lists installed tools, or publishes arbitrary environment values.
Names and paths are control-sanitized and bounded before publication.

### 🚢 Deployment and cloud context

These modules read inert local metadata only.
They do **not** contact Docker, Kubernetes, Terraform/OpenTofu backends, cloud APIs, OAuth flows, credential helpers, or metadata services.
They remain opt-in because context labels may be sensitive.

- `docker_context`: `DOCKER_CONTEXT`, then `DOCKER_CONFIG/config.json` or `~/.docker/config.json`.
  The `default` context is suppressed.
  `only_with_files` and detection arrays are supported.
- `kubernetes`: at most `max_config_files` (default 8) from `KUBECONFIG` or `~/.kube/config`, with first-wins merge semantics.
  Only context, namespace, cluster name, and user name are selected.
  Exact `context_aliases`, `namespace_aliases`, `cluster_aliases`, and `user_aliases` apply.
- `terraform`: direct `.tf`, `.tfplan`, `.tfstate`, or `.terraform`; workspace precedence is `TF_WORKSPACE` → `TF_DATA_DIR/environment` → `.terraform/environment`.
  `terraform version`, then `tofu version`, runs only for `$version`.
  Workspace, init, provider, and state commands never run.
- `aws`: `AWS_PROFILE`/`AWS_DEFAULT_PROFILE`, `AWS_REGION`/`AWS_DEFAULT_REGION`, then the selected AWS config section.
  The credentials file is never read.
  Exact profile/region aliases are supported.
- `gcloud`: active selector plus allowlisted `core.account`, `core.project`, and `compute.region` INI keys.
  Exact project/region aliases are supported.
- `azure`: the default local `azureProfile.json` subscription name.
  `show_username` defaults to `false`; exact subscription aliases are supported.
- `openstack`: `OS_CLOUD`, `OS_PROJECT_NAME`, or the selected `clouds.yaml` `auth.project_name` only.
  Exact cloud/project aliases are supported.

Cloud files often colocate credentials with labels.
Parsers allowlist fields while reading and discard source documents; token, key, password, auth URL, tenant, and credential-derived duration fields never enter snapshots, diagnostics, notifications, or rendered output.
Presence indicates only selected local metadata—not valid credentials or connectivity.

### 🖥️ Execution context

`hostname` is SSH-only by default and supports `ssh_only`, `trim_at`, and exact `aliases`.
`username` appears only for `show_always`, SSH, root/Administrator, a login-user mismatch, or configured `detect_env_vars`; it supports exact aliases.
Negated username detection names are rejected.
`os` is disabled by default and supports an exact `symbols` map.
`container` uses only Dev Container/Codespaces markers, WSL metadata, `/.dockerenv`, `/run/.containerenv`, and `/run/systemd/container`; it does not scan process tables or cgroups.
Ordinary local hostname/username sessions stay empty.
All identity labels are bounded and stripped of C0/C1 controls, ANSI, newlines, and OSC control bytes.

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

Workspace, Git, and GitHub PR readers start only in TUI sessions and only for reachable enabled modules.
Root format reachability, `$all`, module `disabled`, and module-format variables determine file and command requirements.
Workspace/Git refreshes run at session start, after accepted settings, branch changes, tool/turn completion, and a 30-second fallback.
GitHub PR uses the narrower lifecycle and 60-second network refresh described above.
One read runs with at most one latest pending refresh.
Immutable snapshot equality suppresses redraws, and session or request generations reject stale results.
Shutdown, replacement, footer disposal, branch changes, and accepted settings abort active command work before starting replacements; disabling `github_pr` also stops its query and timers.
Bounded local filesystem operations may finish, but stale generations cannot publish them.
Execution identity is retained rather than re-read by the periodic fallback.
Render and live preview consume snapshots synchronously and perform zero reads or commands.

Missing, unreadable, malformed, oversized, timed-out, or unavailable sources produce empty values.
Workspace and Git readers cap direct files at 64 KiB, use one bounded current-directory listing, never recurse, and make no network calls.
The native GitHub PR query is the documented network exception.
The Cargo package lookup is the only ancestor walk and stops after eight parents.

## 🚧 Limitations

- The formatter and modules are Starship-inspired, not fully compatible with Starship.
- The extension does not load `starship.toml`, invoke the Starship binary, run custom shell modules, or provide unrestricted `env_var` behavior.
- JVM/.NET, other long-tail languages, alternative version-control systems, system monitoring, and additional DevOps modules are not implemented.
- Pi does not expose the auto-compaction toggle, so the footer cannot reliably show Pi's native `(auto)` marker.
