# 🌳 pi-worktree — Safe Git Worktree Management for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-worktree)](https://www.npmjs.com/package/@narumitw/pi-worktree) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-worktree` adds one interactive `/worktree` command for common Git worktree operations and Pi workspace switching.

Pi cannot change its parent process working directory with `cd`. This extension performs the safe equivalent: it prepares a Pi session whose cwd is the selected worktree and switches to that session, preserving the current conversation when it has already been persisted.

## ✨ Features

- Lists main, linked, current, detached, locked, and prunable worktree state from `git worktree list --porcelain -z`.
- Creates a new branch worktree or attaches an existing unoccupied local branch.
- Suggests a sibling path such as `/workspace/project-feat-login` for `feat/login`.
- Optionally switches Pi into a newly created worktree while continuing the current conversation.
- Switches among existing registered worktrees through Pi's public session replacement API.
- Removes only clean, unlocked, non-current linked worktrees and preserves their branches.
- Refuses removal when tracked, untracked, ignored, submodule, or unreachable detached-commit data may be lost.
- Always previews stale metadata before pruning it.
- Runs Git through argv-based subprocess calls, without interpolating user input into shell commands.

## 📦 Install

```bash
pi install npm:@narumitw/pi-worktree
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-worktree
```

Try this package locally from the repository root:

```bash
just try-worktree
# or: pi -e ./extensions/pi-worktree
```

## 💬 Usage

Run the command without arguments:

```text
/worktree
```

Choose one action:

- **List worktrees** — show compact path, branch/HEAD, and administrative state.
- **Add worktree** — enter a branch, optional start point, and optional path; confirm creation and optionally switch.
- **Switch worktree** — select another existing worktree and continue this Pi conversation there.
- **Remove worktree** — remove a confirmed clean linked worktree without deleting its branch.
- **Prune stale metadata** — inspect Git's dry-run output, then optionally run the matching prune.

`/worktree` intentionally does not accept text subcommands in this version. Every mutation is initiated and confirmed through the interactive UI.

## 🌿 Add defaults

For a new branch, the current symbolic branch is the default start point. If Pi is running from detached HEAD, the command requires an explicit commit-ish. Git must resolve the start point to exactly one commit.

The suggested path is a sibling of the main worktree:

```text
main worktree: /home/user/workspace/project
branch:        feat/login
suggested:     /home/user/workspace/project-feat-login
```

Leave the path input blank to accept the suggestion. A custom absolute path is used directly; a custom relative path is resolved from the current Pi cwd.

The MVP does not expose `--force`, `-B`, `--detach`, `--orphan`, or lock options.

## 🔀 Pi workspace switching

Switching uses Pi's public `SessionManager` and `ctx.switchSession()` APIs:

1. The command waits for Pi to become fully idle so the current assistant/tool results are persisted.
2. A linear persisted session is forked into the target worktree. If `/tree` currently points at an older branch, the documented session entries for that active branch are written to the target instead, so switching cannot jump to a newer serialized leaf.
3. Pi tears down the old cwd-bound runtime and creates the target runtime.
4. The extension reports success only through the fresh replacement-session context.

If the current session is completely empty, the extension creates a valid empty Pi session for the target. If an in-memory session contains conversation entries but has no persisted session file, switching is refused to avoid losing context.

A successfully created Git worktree is never rolled back merely because Pi session switching fails. Re-run `/worktree` and choose **Switch worktree** after resolving the reported Pi/session issue.

## 🛡️ Safety boundaries

- The main worktree and current worktree cannot be removed.
- Locked or stale worktrees cannot be removed through this extension.
- Dirty, untracked, ignored, and initialized-submodule data causes removal to fail closed.
- A detached HEAD must be reachable from a local branch, tag, or remote ref before removal or prune.
- Removal and prune also protect reflog-only and per-worktree administrative history: every discovered commit must remain reachable from a durable branch, tag, or remote ref. This can require creating a branch or tag after a reset or rebase, even when the worktree is otherwise clean.
- Removal never deletes a branch and never uses `--force`.
- Prune always runs `git worktree prune --dry-run --verbose` before confirmation, inspects linked-worktree administrative HEAD, index, reflog, pseudoref, and per-worktree ref state (including candidates omitted from porcelain), and uses Git's default expiry.
- The extension does not commit, push, rebase, repair, move, lock, or unlock worktrees.

Use Git directly when you intentionally need force removal, branch deletion, custom prune expiry, detach/orphan creation, move, repair, lock, or unlock behavior.

## Requirements and limits

- Git must be installed and the current Pi cwd must be inside a non-bare Git worktree.
- The command requires a UI-capable Pi mode; print and JSON modes cannot drive its dialogs.
- Project trust and cwd-bound extension/resource loading during a switch remain owned by Pi.
- The extension registers no LLM tool, background watcher, settings file, or statusline item.

## 📁 Package layout

```text
extensions/pi-worktree/
├── src/
│   ├── command.ts
│   ├── git.ts
│   ├── session.ts
│   └── worktree.ts
├── test/
│   ├── command.test.ts
│   ├── git.integration.test.ts
│   ├── git.test.ts
│   └── session.test.ts
├── package.json
├── README.md
├── LICENSE
└── tsconfig.json
```

## 🏷️ Keywords

`pi-package`, `pi-extension`, `git`, `worktree`, `workspace`, `session`

## 📄 License

MIT
