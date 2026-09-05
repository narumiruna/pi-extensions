# 🌳 pi-worktree — Create, Switch, and Remove Git Worktrees in Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-worktree)](https://www.npmjs.com/package/@narumitw/pi-worktree) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Create, inspect, switch, remove, and prune Git worktrees through one guarded `/worktree` manager.
Because `cd` cannot change Pi's parent process directory, switching prepares a Pi session whose cwd is the selected worktree and carries over the active conversation when possible.

## ✨ Features

- Lists main, linked, current, detached, locked, and prunable worktrees with searchable local status details.
- Creates a worktree from a new branch or an unoccupied local branch after showing the exact base commit.
- Suggests a configurable path under `~/.worktrees/` and rejects unsafe, occupied, or ambiguous targets.
- Switches Pi to an existing or newly created worktree while preserving the active conversation when possible.
- Removes only non-current, unlocked worktrees after checking tracked, untracked, index, submodule, and detached-commit risks.
- Shows ignored files and stale metadata before confirmed removal or pruning, then revalidates the approved plan.
- Passes arguments directly to Git without interpolating user input into shell commands.

## 📦 Install

This extension runs Git and writes settings and Pi sessions with Pi's process permissions.
Install it only from a source you trust.

```bash
pi install npm:@narumitw/pi-worktree
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-worktree
```

Try this package locally from the repository root:

```bash
npm --workspace @narumitw/pi-worktree run build
pi -e ./packages/pi-worktree
```

The package declares `dist/index.ts`, so an unbuilt local checkout must be built before Pi loads the package directory.

## 🚀 Quick start

Run `/worktree` in TUI or RPC mode and choose an action.
Before each Git mutation, the extension runs its safety checks and shows the exact change for confirmation.

## 💬 Commands

Run `/worktree` to inspect, create, switch, or remove Git worktrees, prune stale metadata, and configure the default root in TUI or RPC mode.
It accepts no arguments; print and JSON modes reject it before any Git call.
Git must be installed and Pi must be inside a non-bare worktree.
Destructive changes require confirmation and never delete branches; review [Safety boundaries](#-safety-boundaries), including ignored-file and recovery-pointer loss.
See [Add defaults](#-add-defaults) for creation rules and [Pi workspace switching](#-pi-workspace-switching) for conversation transfer and failure recovery.

## 🌿 Add defaults

For a new branch, the current symbolic branch is the default start point.
If Pi is running from detached HEAD, the command requires an explicit commit-ish.
Git must resolve the start point to exactly one commit.

Before mutation, Add identifies whether the branch is new or existing.
It shows the current branch, explicit commit-ish, or existing local branch used as provenance, plus the full resolved OID and target path.
New branches are created from that approved OID even if the source ref later moves.
Existing branches are checked again immediately before mutation and the created worktree HEAD is verified afterward.
Git has no atomic compare-and-add operation for attaching an existing branch, so a post-add mismatch is retained for inspection rather than rolled back.

The default root is `~/.worktrees`, where `~` is Node's platform home directory.
Suggestions use the registered main worktree's directory name, not the current linked-worktree cwd:

```text
main worktree: /home/user/workspace/project
branch:        feat/login
root:          /home/user/.worktrees
suggested:     /home/user/.worktrees/project/feat-login
```

On Windows, the equivalent default is such as `C:\Users\Alice\.worktrees`.
Branch `/` characters become `-`.
The extension does not add hashes or collision suffixes.
If normalized paths collide or the target already exists, Add stops before mutating Git state.

Leave the path input blank to accept the suggestion.
A custom absolute path is used directly; a custom relative path is resolved from the current Pi cwd.
The target itself must not exist, and its nearest existing ancestor must resolve without a broken or looping symbolic link.
Existing registered worktrees are never moved when this default changes.

The MVP does not expose `--force`, `-B`, `--detach`, `--orphan`, or lock options.

## ⚙️ Settings

The machine-local user settings file is:

```text
<getAgentDir()>/pi-worktree.json
```

For a default Pi installation this is typically `~/.pi/agent/pi-worktree.json`.
Configure it through **Configure worktree root** or edit it manually:

```json
{
  "worktreeRoot": "~/worktrees"
}
```

`worktreeRoot` accepts `~`, a home-prefixed path such as `~/worktrees`, or a native-platform absolute path.
It does not expand `$VAR`, `%VAR%`, or other shell syntax.
Empty, relative, NUL-containing, non-string, and invalid paths are rejected.
There is no project override or extension-specific environment variable.

A missing `worktreeRoot` uses `~/.worktrees`.
A successful interactive change is the only operation that creates the settings file.
Submitting a blank value in the interactive action removes the override.
Within one Pi process, queued saves run in invocation order.
Each save rereads the latest valid document before merging `worktreeRoot` and preserves concurrent edits to unknown fields.
Settings reload on every `session_start`, including `/reload` and workspace replacement; a successful interactive save applies immediately to the next Add flow.

Malformed or invalid settings are warned about but never overwritten, including an invalid edit made while a settings action is open.
An initial failure uses `~/.worktrees`; a later failure retains the last valid effective root.
Interactive configuration remains blocked until the invalid file is fixed manually.
Failed publication leaves the prior file and effective runtime root unchanged, and the save queue remains usable after rejection.

## 🔀 Pi workspace switching

Switching uses Pi's public `SessionManager` and `ctx.switchSession()` APIs in this order:

1. The command waits for Pi to become fully idle so the current assistant/tool results are persisted.
2. A linear persisted session is forked into the target worktree.
   If `/tree` points at an older branch, only that active branch's documented session entries are written to the target.
   Switching therefore cannot jump to a newer serialized leaf.
3. Pi tears down the old cwd-bound runtime and creates the target runtime.
4. The extension reports success only through the fresh replacement-session context.

If the current session is completely empty, the extension creates a valid empty Pi session for the target.
For an ephemeral session created with `--no-session`, the extension copies the active conversation branch into a persisted target session.
This preserves context across the workspace switch.

If switching fails after Add, the extension retains the successfully created Git worktree.
If Pi prepared a target session before the failure, it retains that session too.
Resolve the reported Pi or session issue, then run `/worktree` and choose **Switch worktree**.

## 🛡️ Safety boundaries

- The main worktree and current worktree cannot be removed.
- Locked or stale worktrees cannot be removed through this extension.
- Dirty, untracked, initialized-submodule, and intentional `assume-unchanged`/`skip-worktree` index state causes removal to fail closed.
  Sparse-checkout-managed `skip-worktree` entries outside the active sparsity rules are allowed when Git's rule checker confirms them.
  Clear other intentional index flags before removing the worktree.
- Ignored-only files and directories do not block removal.
  The confirmation lists them, and the extension rechecks the exact ignored inventory before Git deletes the worktree.
- A detached HEAD must be reachable from a local branch, tag, or remote ref before removal or prune.
- Removal and prune inspect reflogs, pseudorefs, per-worktree refs, and `FETCH_HEAD`.
  Historical commits reachable only through this administrative recovery state are listed by full OID in the destructive confirmation.
  Approval removes those recovery pointers, so Git may later garbage-collect the commits.
  Create a branch or tag instead when any listed commit should survive.
- Staged-only administrative index state, a missing attached branch ref, or an unreachable current detached HEAD still blocks prune without an override.
- Removal never deletes a branch and never uses `--force`.
- Remove invokes only argv-based `git worktree remove <path>`; production runtime never invokes a shell, `rm`, `rm -rf`, or a Node filesystem directory-deletion API for worktrees.
- Prune runs `git worktree prune --dry-run --verbose`, inspects candidates omitted from porcelain, and shows the result before confirmation.
  After confirmation, it rechecks the exact preview and recovery-risk set before pruning with Git's default expiry.
  Remove likewise rechecks worktree identity, inventory, administrative path, and the approved recovery-risk set before mutation.
- The status browser uses only local Git state and never fetches a remote; its cards never authorize Remove or Prune.
- The extension does not commit, push, fetch, rebase, repair, move, lock, or unlock worktrees.

Status is an on-demand local snapshot of each worktree's state, full HEAD, working-tree counts, upstream divergence, and last commit.
Unavailable worktrees remain visible with a reason.
A missing upstream means **not configured**, not proof that no commits are unpushed.
Snapshots can become stale immediately and never replace the stricter Remove and Prune checks.

Use Git directly for force removal, branch deletion, custom prune expiry, detach or orphan creation, move, repair, lock, unlock, and remote refresh operations.

## 🚧 Limitations

- Git must be installed and the current Pi cwd must be inside a non-bare Git worktree.
- The command requires a UI-capable Pi mode; print and JSON modes cannot drive its dialogs.
- Project trust and cwd-bound extension/resource loading during a switch remain owned by Pi.
- The extension registers no LLM tool, background watcher, project settings, or statusline item.

## 🗂️ Package layout

```text
packages/pi-worktree/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── worktree.ts                    # Worktree manager and lifecycle
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

`pi-package`, `pi-extension`, `git`, `worktree`, `workspace`, `session`

## 📄 License

[MIT](./LICENSE)
