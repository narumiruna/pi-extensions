# pi-starship module capabilities verification

The implementation adds six disabled native modules and completes 76 selected top-level settings from the 84-field comparison. Existing default footer output, the settings location, presets, and enabled states remain unchanged. The remaining eight fields and unselected modules are intentionally deferred below.

The comparison used Starship `ae8fecf3` and the original 45-module pi-starship catalog at pi-extensions `970edfd5`. Implementation started from `origin/main` at `338e6fcf`; its pi-starship source matched that baseline. The resulting catalog has 51 modules. This is a selected Starship-inspired implementation, not full compatibility.

## Verification status

All implementation checks passed. No required agent check remains open.

| Check | Evidence |
| --- | --- |
| Dependency preparation | Root `npm install`; zero reported audit vulnerabilities; no unrelated manifest or lockfile changes. |
| Formatting and static gates | `npm run format` and `npm run check` passed; the latter covers builds, Biome, package boundaries, and all workspace typechecks. |
| Full repository suite | `npm test`: 753 files passed, one file skipped; 13,871 tests passed, two tests skipped; no failures or unhandled errors. Skipped tests are outside pi-starship. |
| Complete package suite | 44 files and 1,298 tests passed, without skips; includes the configuration skill, profiles/recovery, previews, themes, and generated runtime. |
| Review regressions | Fractional clock offsets/static ranges; suppressed Git templates; raw/quoted Jujutsu names and latest-ancestor selection; present/absent prototype-like detector names; 125 three-battery state combinations; ordered effective TOML substitution maps. |
| Generated runtime | Explicit package build passed; exact emitted import inventory and the Jiti loader/profile-menu lazy boundary passed. |
| Package contents | `npm run package:pack -- starship` passed; actual tarball inspected: 141 files, 41 generated relative imports resolve, no generated import back into source, and dependencies/skills/notices are present. Tarball SHA-1: `8df839b2a442018ccb16790eaca2e47e04d722ac`. |
| Package-directory Pi smoke | `pi -e ./packages/pi-starship` through a bounded RPC harness: readiness, command registration, and clean exit passed; no prompt/provider request. |
| Native metadata smoke | Production Node version and native RAM readers passed; values were not printed. Physical battery state was not asserted. |
| Documentation | Required-heading audit across 36 package READMEs, local links/anchors, schema/catalog parity, and TOML examples passed. |
| Release intent | One minor Changeset for pi-starship; `npm run changeset:status` succeeded. Existing unrelated Kit-floor warnings remain unchanged; no consumer-floor migration or publication occurred. |

The initial pre-install checks could not find dependencies, and the first baseline full-suite attempt exceeded the command deadline. Dependencies were prepared and every required final gate was rerun successfully. Intermediate review regressions were corrected, not waived.

## Semantic audits

Reviewed [extension conventions](../extension-conventions.md), [settings conventions](../extension-settings.md), and [README conventions](../readme-conventions.md), including their touched-area and verification checklists.

Discovery and independent implementation ran concurrently: the full inventory was recorded after some independent edits, rather than before every edit. Required contracts were resolved before integration and all final dispositions were verified. This sequencing deviation does not waive any behavioral or safety check.

- Rendering, module inspection, and profile preview use snapshots only. Native reads and subprocesses remain in collectors; default directory metadata and disabled/unreachable new modules perform no additional probes.
- Production Git and all new commands use bounded argv execution, no shell, combined-output caps, timeout, cancellation, and process-tree cleanup. No new network or credential reader was added; Go probes force the local toolchain.
- Collectors check cancellation after awaits. Existing refresh generations prevent publication after disposal, shutdown, session replacement, branch change, or accepted-settings replacement.
- Settings normalization, effective TOML projection, and profile/document round trips cover the new nested arrays. Persistence remains unchanged: read-only startup, invalid-file protection, unknown raw-field preservation, ordered writes, failure recovery, and atomic publication.
- Terminal controls are removed at display boundaries before path transformations, filtering, or truncation. Alias identities and raw cached payloads remain separate from sanitized output.
- Model-visible prompts, tools, context hooks, and command routes are unchanged. No model-prefix transition is introduced.
- Independent review fixes cover structured raw bookmark fields at every serialization site, latest-bookmark source selection with distinct ancestor tables, explicit timezone clock comparison, and status availability based on referenced variables. Environment tests cover both empty-present and absent prototype-like names; child environments accept only own string values.
- Native state aggregation is independent of device order: charging/discharging have priority and mixed full/empty remains unknown. Effective TOML keeps the semantic order of legacy substitution maps.
- Existing defaults are preserved, not all custom-format semantics: version formats now follow formatter variable boundaries and escapes. The bundled configuration reference and Changeset describe the braced-variable/literal-dollar migration.

## External handoff and release limits

Real Jujutsu CLI execution remains unverified because `jj` was not installed. Its query grammar and serialization methods were checked against upstream source/documentation and deterministic fixtures. A maintainer with the supported CLI can run the documented read-only query against a disposable repository and confirm unchanged repository state. Do not claim a live CLI result from these fixtures.

Battery reading is Linux sysfs only. Linux reader fixtures and native metadata checks do not verify physical charging transitions. A maintainer with Linux battery hardware must check charging, discharging, full, missing, and multiple-battery behavior without privileged probes before making a hardware-tested claim. Windows/macOS battery readers and non-Linux swap are not implemented; native path/permission behavior on those systems remains unverified. Directory permissions use the documented W_OK approximation, not upstream UID/group/DACL parity.

The CLI load smoke is headless RPC with no prompt/provider request; deterministic loader/TUI harness tests cover the generated lazy command boundary, rendering, themes, widths, and disposal. Subjective real-terminal acceptance is not claimed.

No packages were published, visibility changed, version tags created, or release workflows dispatched. Those actions require separate user approval; completing the implementation does not authorize them.

## Comparison dispositions

## Missing fixed modules: 76

| Module | Decision | Reason |
| --- | --- | --- |
| `battery` | Implement | Selected native module; disabled by default. |
| `buf` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `c` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `character` | Defer | Shell-state semantics are not a Pi footer contract. |
| `claude_context` | Adapt | Use Pi-native usage/model modules or literal newlines; no compatibility alias. |
| `claude_cost` | Adapt | Use Pi-native usage/model modules or literal newlines; no compatibility alias. |
| `claude_model` | Adapt | Use Pi-native usage/model modules or literal newlines; no compatibility alias. |
| `cmake` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `cmd_duration` | Defer | Shell-state semantics are not a Pi footer contract. |
| `cobol` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `cpp` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `crystal` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `daml` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `dart` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `dotnet` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `elixir` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `elm` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `erlang` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `fennel` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `fortran` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `fossil_branch` | Defer | Additional VCS, deployment, or system integration is outside selected delivery. |
| `fossil_metrics` | Defer | Additional VCS, deployment, or system integration is outside selected delivery. |
| `gleam` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `gradle` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `haskell` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `haxe` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `helm` | Defer | Additional VCS, deployment, or system integration is outside selected delivery. |
| `hg_branch` | Defer | Additional VCS, deployment, or system integration is outside selected delivery. |
| `hg_state` | Defer | Additional VCS, deployment, or system integration is outside selected delivery. |
| `java` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `jj_bookmark` | Implement | Selected native module; disabled by default. |
| `jj_change` | Implement | Selected native module; disabled by default. |
| `jj_metrics` | Implement | Selected native module; disabled by default. |
| `jj_status` | Implement | Selected native module; disabled by default. |
| `jobs` | Defer | Shell-state semantics are not a Pi footer contract. |
| `julia` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `kotlin` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `line_break` | Adapt | Use Pi-native usage/model modules or literal newlines; no compatibility alias. |
| `localip` | Defer | Additional VCS, deployment, or system integration is outside selected delivery. |
| `lua` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `maven` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `memory_usage` | Implement | Selected native module; disabled by default. |
| `meson` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `mojo` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `nats` | Defer | Additional VCS, deployment, or system integration is outside selected delivery. |
| `netns` | Defer | Additional VCS, deployment, or system integration is outside selected delivery. |
| `nim` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `ocaml` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `odin` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `opa` | Defer | Additional VCS, deployment, or system integration is outside selected delivery. |
| `perl` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `php` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `pijul_channel` | Defer | Additional VCS, deployment, or system integration is outside selected delivery. |
| `pulumi` | Defer | Additional VCS, deployment, or system integration is outside selected delivery. |
| `purescript` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `quarto` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `raku` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `red` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `rlang` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `ruby` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `scala` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `shell` | Defer | Shell-state semantics are not a Pi footer contract. |
| `shlvl` | Defer | Shell-state semantics are not a Pi footer contract. |
| `singularity` | Defer | Additional VCS, deployment, or system integration is outside selected delivery. |
| `solidity` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `spack` | Defer | Additional VCS, deployment, or system integration is outside selected delivery. |
| `status` | Defer | Shell-state semantics are not a Pi footer contract. |
| `sudo` | Defer | Shell-state semantics are not a Pi footer contract. |
| `swift` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `typst` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `vagrant` | Defer | Additional VCS, deployment, or system integration is outside selected delivery. |
| `vcs` | Defer | Additional VCS, deployment, or system integration is outside selected delivery. |
| `vcsh` | Defer | Additional VCS, deployment, or system integration is outside selected delivery. |
| `vlang` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `xmake` | Defer | No concrete ecosystem requirement; outside selected delivery. |
| `zig` | Defer | No concrete ecosystem requirement; outside selected delivery. |

### Missing top-level fields: 84

`Implement/adapt` means implement the setting with the existing Pi default and the explicit compatibility rules above. `Defer` entries are excluded by this plan. Nested rule fields, existing format variables, and existing fields with reduced semantics are not counted again.

| Module | Implement/adapt | Defer and reason |
| --- | --- | --- |
| `aws` | None | `expiration_symbol`, `force_display` — fixed runner, credential/privacy policy, or excluded heuristic. |
| `conda` | `detect_env_vars` | None. |
| `directory` | `use_logical_path`, `repo_root_format`, `repo_root_style`, `before_repo_root_style`, `read_only`, `read_only_style` | None. |
| `direnv` | `detect_env_vars`, `allowed_msg`, `not_allowed_msg`, `denied_msg`, `loaded_msg`, `unloaded_msg` | None. |
| `gcloud` | `detect_env_vars` | None. |
| `git_branch` | `only_attached`, `always_show_remote`, `ignore_branches`, `ignore_remotes`, `ignore_bare_repo` | None. |
| `git_commit` | `only_detached`, `tag_symbol`, `tag_disabled`, `tag_max_candidates` | None. |
| `git_metrics` | `only_nonzero_diffs`, `ignore_submodules` | None. |
| `git_state` | `rebase`, `merge`, `revert`, `cherry_pick`, `bisect`, `am`, `am_or_rebase` | None. |
| `git_status` | `stashed`, `ahead`, `behind`, `up_to_date`, `diverged`, `conflicted`, `deleted`, `renamed`, `modified`, `staged`, `untracked`, `typechanged`, `worktree_added`, `worktree_deleted`, `worktree_modified`, `worktree_typechanged`, `index_added`, `index_deleted`, `index_modified`, `index_typechanged`, `ignore_submodules` | `use_git_executable`, `windows_starship` — fixed runner, credential/privacy policy, or excluded heuristic. |
| `hostname` | `ssh_symbol`, `detect_env_vars` | None. |
| `kubernetes` | `detect_extensions`, `detect_files`, `detect_folders`, `detect_env_vars`, `contexts` | None. |
| `mise` | `healthy_symbol`, `unhealthy_symbol` | None. |
| `nix_shell` | `impure_msg`, `pure_msg` | `unknown_msg`, `heuristic` — unknown state requires excluded heuristic discovery; do not expose an inert setting. |
| `nodejs` | `not_capable_style` | None. |
| `package` | `display_private` | None. |
| `pixi` | None | `pixi_binary` — fixed runner, credential/privacy policy, or excluded heuristic. |
| `python` | `pyenv_version_name`, `pyenv_prefix`, `python_binary`, `detect_env_vars`, `generic_venv_names` | None. |
| `terraform` | None | `commands` — fixed runner, credential/privacy policy, or excluded heuristic. |
| `time` | `use_12hr`, `time_format`, `utc_time_offset`, `time_range` | None. |
| `golang` | `not_capable_style` | None. |

### Resolved grammar and safety contracts

- Status templates use the existing formatter, at most 4,096 characters and 16 nested groups, with only `count`, or `ahead_count`/`behind_count` for divergence; clean tracking templates have no variables. Pi compact counts remain the default.
- Regex uses the package-owned bounded RE2JS wrapper: at most 512 source-pattern characters, 4,096 input/replacement characters, 8,192 replacement-output characters, and 64 cached patterns. Unsupported backreferences and lookaround are rejected; directory rules run in order and Kubernetes uses full-match first-rule selection. Legacy aliases remain exact matches.
- Time keeps local `HH:mm` by default. Supported strftime tokens, offset/IANA rules, invalid-value fallback, and local-clock range gating are documented in the bundled reference and deterministic fixtures.
- Nested context rules require `context_pattern`, allow optional user pattern, symbol, style, and aliases, and have at most 64 entries. Substitutions accept legacy maps or at most 64 bounded `from`/`to`/`regex` rows. Invalid shapes fall back with diagnostics; unknown document fields remain preserved on disk.
- Python command alternatives are at most 16 strings or argv arrays, at most 16 argv elements each and 1,024 characters per element, without control characters. The runner appends `--version` and never starts a shell.
- Environment detectors use presence (including empty values), positive OR, and negative veto. Only named detector inputs enter the child environment; no unrestricted environment output is added.
- Jujutsu uses bounded read-only `show` queries with working-copy snapshotting and operation integration disabled. Values describe the recorded change, not a newly captured dirty working copy.
- Native battery support is Linux sysfs only; unavailable sources/platforms yield no module. Memory uses native system totals, with Linux swap only when requested. Physical battery transitions remain an external handoff.
