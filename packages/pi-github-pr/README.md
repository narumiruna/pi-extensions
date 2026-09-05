# 🔎 pi-github-pr — See Current Pull Request Status in Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-github-pr)](https://www.npmjs.com/package/@narumitw/pi-github-pr) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

See the current branch's pull request number, checks, review state, and discussion count in Pi's statusline.
The extension reads only GitHub pull request metadata.
It does not register a command or model tool, render a widget, or inject model context.

## ✨ Features

- Shows compact PR number, checks, review state, and combined comment/review count.
- Starts the initial refresh in the background without delaying Pi startup.
- Refreshes once per minute, after agent turns, and when the Git branch changes.
- Keeps a recently merged or closed pull request visible for up to 24 hours.
- Uses GitHub CLI authentication and repository resolution without storing a token.
- Never reads or displays discussion bodies, review text, inline comments, or review threads.
- Runs without commands, model tools, widgets, webhooks, or a separate service.

## 📦 Install

Install and authenticate GitHub CLI first:

```bash
brew install gh
gh auth login
# For GitHub Enterprise Server (include the port if your URL uses one):
gh auth login --hostname github.example.com:8443
```

The extension delegates authentication, credential storage, and repository resolution to `gh`.
It uses the pull request URL host, including its port, for follow-up API calls.
You do not need to set `GH_HOST` manually.

Install the extension persistently:

```bash
pi install npm:@narumitw/pi-github-pr
```

Try the published package without installing it:

```bash
pi -e npm:@narumitw/pi-github-pr
```

Build and load a local checkout from the repository root:

```bash
npm --workspace @narumitw/pi-github-pr run build
pi -e ./packages/pi-github-pr
```

The package declares `dist/index.ts`, so Pi cannot load an unbuilt local checkout.
Pi extensions run with your user permissions.
Review extension source before installing it.

## 🚀 Quick start

Authenticate `gh`, then start Pi in a Git worktree whose current branch has a GitHub pull request.
The pull request status appears automatically:

```text
PR #123: checks passing, approved, 7 comments
PR #123: checks failing (2), changes requested, 3 comments
PR #123: checks pending (5), commented, 12 comments
PR #123: no checks, draft, no comments
```

The PR number is an OSC 8 link when Pi's terminal capabilities allow hyperlinks, and plain text otherwise.
Checks use GitHub's terminology; the trailing count combines comments and reviews.
When rendered by `pi-statusline`, the `github-pr` icon comes from its icon settings.

## 🔄 Refresh behavior

The extension runs passively:

- On session start, it checks the current branch in the background without delaying Pi startup.
- On a Git branch change, it clears the old status immediately and refreshes the new branch.
- While the session is open, it refreshes every 60 seconds and after each agent turn.
- If an agent turn is aborted, it keeps the last successful status instead of reporting a GitHub failure.
- On branch change, session replacement, or session shutdown, it cancels the previous refresh timer and applicable in-flight initialization or refresh request.
- On session shutdown, it clears the statusline entry.
- An open pull request stays visible, while a merged or closed pull request stays visible for at most 24 hours after its terminal timestamp.
- If the current branch has no GitHub pull request, the statusline entry stays empty.
- If `gh` is missing or unauthenticated, the statusline shows `PR gh missing` or `PR gh auth`.

## 🚧 Limitations

- Requires `gh`; there is no direct GitHub API or `GITHUB_TOKEN` fallback.
- Shows only the current branch's pull request; arbitrary pull request lookup is not supported.
- Counts pull request comments and reviews, not unresolved review threads.
- Does not read pull request comment bodies, review bodies, inline diff comments, or unresolved review-thread text.
- Each refresh invokes `gh pr view` and one GraphQL count query.

## 🗂️ Package layout

```text
packages/pi-github-pr/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── github-pr.ts                   # GitHub queries and status refresh
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

`pi-package`, `pi-extension`, `github`, `pull-request`, `statusline`, `gh`

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
