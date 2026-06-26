# 🧩 Pi Extensions for the Pi Coding Agent

[![npm scope](https://img.shields.io/badge/npm-@narumitw-blue)](https://www.npmjs.com/org/narumitw) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Production-ready, independently installable [Pi](https://pi.dev) extension packages for the Pi coding agent. This monorepo provides native Pi tools and commands for configurable LSP diagnostics and source fixes, Chrome DevTools automation, Codex usage status, Firecrawl web scraping, GitHub PR status, goal-driven task completion, read-only plan mode, pause-and-explain interruptions, retry handling, R2/S3 settings sync, terminal statuslines, delegated subagents, and keep-awake automation.

## 📦 Pi extension packages

Install only the Pi extensions you need. Each package is published under the `@narumitw` npm scope and can be installed directly with the package-specific `pi install npm:@narumitw/...` command.

| Pi extension | What it adds | Install |
| --- | --- | --- |
| [`@narumitw/pi-btw`](./extensions/pi-btw) | 💬 `/btw` side-question command for asking quick questions without polluting the main conversation. | `pi install npm:@narumitw/pi-btw` |
| [`@narumitw/pi-caffeinate`](./extensions/pi-caffeinate) | ☕ Cross-platform sleep prevention while the Pi agent is processing long-running prompts. | `pi install npm:@narumitw/pi-caffeinate` |
| [`@narumitw/pi-chrome-devtools`](./extensions/pi-chrome-devtools) | 🌐 Native Chrome DevTools Protocol tools for listing tabs, navigating pages, evaluating JavaScript, and taking screenshots. | `pi install npm:@narumitw/pi-chrome-devtools` |
| [`@narumitw/pi-codex-usage`](./extensions/pi-codex-usage) | 📊 `/codex-status` command and automatic statusline item for ChatGPT Codex subscription usage, using Pi auth first and Codex CLI only as fallback. | `pi install npm:@narumitw/pi-codex-usage` |
| [`@narumitw/pi-firecrawl`](./extensions/pi-firecrawl) | 🔥 Firecrawl-powered web scraping, crawling, URL discovery, and web search tools for research workflows. | `pi install npm:@narumitw/pi-firecrawl` |
| [`@narumitw/pi-github-pr`](./extensions/pi-github-pr) | 🔎 Passive current-branch GitHub PR checks, review, and comment counts in the statusline. | `pi install npm:@narumitw/pi-github-pr` |
| [`@narumitw/pi-goal`](./extensions/pi-goal) | 🎯 `/goal` mode that keeps the agent working until a verifiable task is complete. | `pi install npm:@narumitw/pi-goal` |
| [`@narumitw/pi-lsp`](./extensions/pi-lsp) | 🧠 Configurable language-server diagnostics and source-fix tools routed by file extension. | `pi install npm:@narumitw/pi-lsp` |
| [`@narumitw/pi-plan-mode`](./extensions/pi-plan-mode) | 🧭 Codex-like read-only `/plan` collaboration mode with safe exploration and implementation-ready plans. | `pi install npm:@narumitw/pi-plan-mode` |
| [`@narumitw/pi-retry`](./extensions/pi-retry) | 🔁 Retry support for provider responses that fail with `Unknown error (no error details in response)`. | `pi install npm:@narumitw/pi-retry` |
| [`@narumitw/pi-statusline`](./extensions/pi-statusline) | ✨ A rich Pi terminal statusline with model, tools, git branch, context usage, token totals, cost, and time. | `pi install npm:@narumitw/pi-statusline` |
| [`@narumitw/pi-sync`](./extensions/pi-sync) | ☁️ Sync allowlisted Pi settings, skills, prompts, themes, extensions, and optional sessions through Cloudflare R2 or S3-compatible storage. | `pi install npm:@narumitw/pi-sync` |
| [`@narumitw/pi-subagents`](./extensions/pi-subagents) | 🤖 Delegate work to specialized isolated subagents with single, parallel, and chained execution modes. | `pi install npm:@narumitw/pi-subagents` |
| [`@narumitw/pi-wait-what`](./extensions/pi-wait-what) | 🤔 `/wait-what` pause command for asking the agent to explain surprising actions before continuing. | `pi install npm:@narumitw/pi-wait-what` |

## 🚀 Quick start

Install a package from npm:

```bash
pi install npm:@narumitw/pi-goal
```

Try an extension once without adding it permanently:

```bash
pi -e npm:@narumitw/pi-statusline
pi -e npm:@narumitw/pi-sync
```

Use multiple Pi extensions together:

```bash
pi -e npm:@narumitw/pi-goal -e npm:@narumitw/pi-statusline -e npm:@narumitw/pi-lsp
```

## 🛠️ Extension use cases

### 🧠 Shared language-server workflows

Use [`@narumitw/pi-lsp`](./extensions/pi-lsp) to let Pi run configurable Language Server Protocol servers through one shared runner. Configure servers in `.pi/lsp.json`, `~/.pi/agent/lsp.json`, or `PI_LSP_CONFIG` with simple `{ command, extensions }` entries, then use Pi tools for diagnostics and source code actions. The older split packages [`@narumitw/pi-biome-lsp`](./extensions/deprecated/pi-biome-lsp) and [`@narumitw/pi-python-lsp`](./extensions/deprecated/pi-python-lsp) are deprecated, kept for reference, and excluded from active workspace scripts.

### 🧬 JavaScript and TypeScript coding with Biome

Use [`@narumitw/pi-lsp`](./extensions/pi-lsp) to route TypeScript, JavaScript, JSON, CSS, and other supported files to `biome lsp-proxy` for diagnostics and source actions such as organize imports or fix-all code actions.

### 🌐 Browser automation and debugging

Use [`@narumitw/pi-chrome-devtools`](./extensions/pi-chrome-devtools) when you want the Pi agent to inspect browser tabs, navigate web apps, run JavaScript in Chrome, or capture screenshots through the Chrome DevTools Protocol.

### 🔎 Web scraping, crawling, and research

Use [`@narumitw/pi-firecrawl`](./extensions/pi-firecrawl) to give Pi native Firecrawl tools for scraping markdown or HTML, mapping URLs, crawling websites, and searching the web from inside an agent workflow.

### 📊 Codex usage status

Use [`@narumitw/pi-codex-usage`](./extensions/pi-codex-usage) to show ChatGPT Codex subscription usage and reset windows from Pi with `/codex-status`. When the current model uses `openai-codex`, it also shows compact quota status in the statusline. It uses Pi's OpenAI Codex auth first, so Codex CLI is optional.

### 🔎 GitHub pull request status

Use [`@narumitw/pi-github-pr`](./extensions/pi-github-pr) to passively show the current branch PR number, checks state, review state, and comment/review count in Pi's statusline through the authenticated `gh` CLI.

### 🐍 Python coding with ty and Ruff

Use [`@narumitw/pi-lsp`](./extensions/pi-lsp) to route Python files to configured servers such as `ty server` for type diagnostics and `ruff server` for lint diagnostics or source actions such as import organization.

### 🎯 Autonomous task completion

Use [`@narumitw/pi-goal`](./extensions/pi-goal) for long-running implementation, debugging, refactoring, and verification tasks where the agent should continue past planning and call `goal_complete` only after the goal is done.

### 🧭 Read-only planning mode

Use [`@narumitw/pi-plan-mode`](./extensions/pi-plan-mode) when you want a Codex-like `/plan` mode where the agent explores with read-only tools, asks structured questions, and produces an implementation-ready plan before editing.

### 🤔 Pause and explain surprising actions

Use [`@narumitw/pi-wait-what`](./extensions/pi-wait-what) when you want to pause the agent and ask it to explain what it was doing, why, assumptions, and next step before it continues.

### 📨 Remote Telegram session chat

[`@narumitw/pi-telegram-bot`](./extensions/deprecated/pi-telegram-bot) is deprecated and kept under `extensions/deprecated/` for reference.

### 🤖 Delegated subagents

Use [`@narumitw/pi-subagents`](./extensions/pi-subagents) when you want the Pi agent to delegate scouting, planning, review, or implementation work to isolated worker processes with single, parallel, or chained execution.

### ✨ Better agent ergonomics

Use [`@narumitw/pi-btw`](./extensions/pi-btw), [`@narumitw/pi-caffeinate`](./extensions/pi-caffeinate), [`@narumitw/pi-retry`](./extensions/pi-retry), and [`@narumitw/pi-statusline`](./extensions/pi-statusline) to improve day-to-day Pi coding agent sessions with side questions, sleep prevention, automatic retry hints, and a more informative terminal UI.

## 🧑‍💻 Local development

Install dependencies from the repository root:

```bash
npm install
```

Run the full repository check:

```bash
npm run check
```

Try a package locally:

```bash
pi -e ./extensions/pi-btw
pi -e ./extensions/pi-caffeinate
pi -e ./extensions/pi-chrome-devtools
pi -e ./extensions/pi-codex-usage
pi -e ./extensions/pi-firecrawl
pi -e ./extensions/pi-github-pr
pi -e ./extensions/pi-goal
pi -e ./extensions/pi-lsp
pi -e ./extensions/pi-plan-mode
pi -e ./extensions/pi-retry
pi -e ./extensions/pi-statusline
pi -e ./extensions/pi-sync
pi -e ./extensions/pi-subagents
pi -e ./extensions/pi-wait-what
```

Preview npm package contents before publishing:

```bash
npm run pack:btw
npm run pack:caffeinate
npm run pack:chrome-devtools
npm run pack:codex-usage
npm run pack:firecrawl
npm run pack:github-pr
npm run pack:goal
npm run pack:lsp
npm run pack:plan-mode
npm run pack:retry
npm run pack:statusline
npm run pack:sync
npm run pack:subagents
npm run pack:wait-what
```

Publishing note for new scoped packages: `just npm-public @narumitw/pi-new-extension` only changes visibility for an already-published package. If npm returns 404 for a brand-new package, create it first with the new package's workspace name, for example:

```bash
npm publish --workspace @narumitw/pi-new-extension --access public
```

## 🗂️ Repository structure

```txt
extensions/
├── deprecated/
│   ├── pi-auto-thinking/
│   ├── pi-biome-lsp/
│   ├── pi-python-lsp/
│   ├── pi-sidebar/
│   └── pi-telegram-bot/
├── pi-btw/
├── pi-caffeinate/
├── pi-chrome-devtools/
├── pi-codex-usage/
├── pi-firecrawl/
├── pi-github-pr/
├── pi-goal/
├── pi-lsp/
├── pi-plan-mode/
├── pi-retry/
├── pi-statusline/
├── pi-sync/
├── pi-subagents/
└── pi-wait-what/
```

Each active extension package contains its own `package.json`, `README.md`, `LICENSE`, `tsconfig.json`, and TypeScript source under `src/`. Deprecated packages live under `extensions/deprecated/` and are excluded from workspace scripts.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
