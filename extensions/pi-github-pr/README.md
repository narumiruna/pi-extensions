# 🔎 pi-github-pr — GitHub Pull Request Statusline for Pi Agents

[![npm](https://img.shields.io/npm/v/@narumitw/pi-github-pr)](https://www.npmjs.com/package/@narumitw/pi-github-pr) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-github-pr` is a passive [Pi coding agent](https://pi.dev) extension that shows the current branch GitHub pull request status in Pi's statusline.

It only reads PR metadata for the current branch. It counts comments and reviews, but does not fetch or display comment bodies, review text, or review-thread content.

It is intentionally ambient: no slash command, no custom tool, no widget, and no comment injection.

## ✨ Features

- Automatically shows compact PR status in Pi's statusline.
- Refreshes the current branch PR after agent turns.
- Shows PR number, GitHub checks state, review state, and comment/review count.
- Does not read or expose PR discussion text; use `gh pr view --comments` or GitHub directly when you need the conversation.
- Uses GitHub CLI auth and repository resolution; the extension stores no GitHub token.
- No slash commands, LLM tools, widgets, polling loop, webhook server, or runtime service.

Example statusline text:

```text
PR #123: checks passing, approved, 7 comments
PR #123: checks failing (2), changes requested, 3 comments
PR #123: checks pending (5), commented, 12 comments
PR #123: no checks, draft, no comments
```

The check wording follows GitHub's Checks terminology. The trailing comment count is the
combined comments + reviews count. When rendered by `pi-statusline`, the `github-pr` icon comes
from pi-statusline icon settings.

## 📦 Install

```bash
pi install npm:@narumitw/pi-github-pr
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-github-pr
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/pi-github-pr
```

## ⚙️ Prerequisites

Install and authenticate GitHub CLI yourself:

```bash
brew install gh
gh auth login
```

The extension shells out to `gh pr view`; GitHub Enterprise hosts and credential storage are delegated to `gh`.

## 💬 Behavior

The extension runs passively:

- On session start, it checks the current branch PR and sets a compact statusline entry.
- After each agent turn, it refreshes that same current branch PR status.
- On session shutdown, it clears the statusline entry.
- If the directory has no GitHub PR, the statusline entry stays empty.
- If `gh` is missing or unauthenticated, the statusline shows a short hint such as `PR gh missing` or `PR gh auth`.

## Known limits

- Requires `gh`; there is no direct GitHub API or `GITHUB_TOKEN` fallback.
- Only the current branch PR is shown; there is no command or tool for arbitrary PR lookup.
- Comment count uses `gh pr view` comments and reviews, not precise unresolved review-thread counts.
- It does not read PR comment bodies, review bodies, inline diff comments, or unresolved review-thread text.
- No continuous polling; refresh happens on session start and after agent turns.

## 📁 Package layout

```text
extensions/pi-github-pr/
├── src/github-pr.ts
├── test/github-pr.test.ts
├── package.json
├── README.md
├── LICENSE
└── tsconfig.json
```

## 🏷️ Keywords

`pi-package`, `pi-extension`, `github`, `pull-request`, `statusline`, `gh`

## 📄 License

MIT
