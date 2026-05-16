# 🧩 Pi Extensions for the Pi Coding Agent

[![npm scope](https://img.shields.io/badge/npm-@narumitw-blue)](https://www.npmjs.com/org/narumitw) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Production-ready, independently installable [Pi](https://pi.dev) extension packages for the Pi coding agent. This monorepo provides native Pi tools and commands for Chrome DevTools automation, Firecrawl web scraping, Python LSP diagnostics with ty and Ruff, goal-driven task completion, retry handling, terminal statuslines, and keep-awake automation.

## 📦 Pi extension packages

Install only the Pi extensions you need. Each package is published under the `@narumitw` npm scope and can be installed directly with `pi install npm:<package>`.

| Pi extension | What it adds | Install |
| --- | --- | --- |
| [`@narumitw/pi-btw`](./extensions/pi-btw) | 💬 `/btw` side-question command for asking quick questions without polluting the main conversation. | `pi install npm:@narumitw/pi-btw` |
| [`@narumitw/pi-caffeinate`](./extensions/pi-caffeinate) | ☕ Cross-platform sleep prevention while the Pi agent is processing long-running prompts. | `pi install npm:@narumitw/pi-caffeinate` |
| [`@narumitw/pi-chrome-devtools`](./extensions/pi-chrome-devtools) | 🌐 Native Chrome DevTools Protocol tools for listing tabs, navigating pages, evaluating JavaScript, and taking screenshots. | `pi install npm:@narumitw/pi-chrome-devtools` |
| [`@narumitw/pi-firecrawl`](./extensions/pi-firecrawl) | 🔥 Firecrawl-powered web scraping, crawling, URL discovery, and web search tools for research workflows. | `pi install npm:@narumitw/pi-firecrawl` |
| [`@narumitw/pi-goal`](./extensions/pi-goal) | 🎯 `/goal` mode that keeps the agent working until a verifiable task is complete. | `pi install npm:@narumitw/pi-goal` |
| [`@narumitw/pi-python-lsp`](./extensions/pi-python-lsp) | 🐍 Python language-server tools for ty type diagnostics and Ruff linting, formatting, and fixes. | `pi install npm:@narumitw/pi-python-lsp` |
| [`@narumitw/pi-retry`](./extensions/pi-retry) | 🔁 Retry support for provider responses that fail with `Unknown error (no error details in response)`. | `pi install npm:@narumitw/pi-retry` |
| [`@narumitw/pi-statusline`](./extensions/pi-statusline) | ✨ A rich Pi terminal statusline with model, tools, git branch, context usage, token totals, cost, and time. | `pi install npm:@narumitw/pi-statusline` |
| [`@narumitw/pi-subagents`](./extensions/pi-subagents) | 🤖 Delegate work to specialized isolated subagents with single, parallel, and chained execution modes. | `pi install npm:@narumitw/pi-subagents` |

## 🚀 Quick start

Install a package from npm:

```bash
pi install npm:@narumitw/pi-goal
```

Try an extension once without adding it permanently:

```bash
pi -e npm:@narumitw/pi-statusline
```

Use multiple Pi extensions together:

```bash
pi -e npm:@narumitw/pi-goal -e npm:@narumitw/pi-statusline -e npm:@narumitw/pi-python-lsp
```

## 🛠️ Extension use cases

### 🌐 Browser automation and debugging

Use [`@narumitw/pi-chrome-devtools`](./extensions/pi-chrome-devtools) when you want the Pi agent to inspect browser tabs, navigate web apps, run JavaScript in Chrome, or capture screenshots through the Chrome DevTools Protocol.

### 🔎 Web scraping, crawling, and research

Use [`@narumitw/pi-firecrawl`](./extensions/pi-firecrawl) to give Pi native Firecrawl tools for scraping markdown or HTML, mapping URLs, crawling websites, and searching the web from inside an agent workflow.

### 🐍 Python coding with ty and Ruff

Use [`@narumitw/pi-python-lsp`](./extensions/pi-python-lsp) to let Pi run Python type checks through `ty server`, lint diagnostics through `ruff server`, Ruff formatting, and Ruff source fixes such as import organization.

### 🎯 Autonomous task completion

Use [`@narumitw/pi-goal`](./extensions/pi-goal) for long-running implementation, debugging, refactoring, and verification tasks where the agent should continue past planning and call `goal_complete` only after the goal is done.

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
pi -e ./extensions/pi-firecrawl
pi -e ./extensions/pi-goal
pi -e ./extensions/pi-python-lsp
pi -e ./extensions/pi-retry
pi -e ./extensions/pi-statusline
pi -e ./extensions/pi-subagents
```

Preview npm package contents before publishing:

```bash
npm run pack:btw
npm run pack:caffeinate
npm run pack:chrome-devtools
npm run pack:firecrawl
npm run pack:goal
npm run pack:python-lsp
npm run pack:retry
npm run pack:statusline
npm run pack:subagents
```

## 🗂️ Repository structure

```txt
extensions/
├── pi-btw/
├── pi-caffeinate/
├── pi-chrome-devtools/
├── pi-firecrawl/
├── pi-goal/
├── pi-python-lsp/
├── pi-retry/
├── pi-statusline/
└── pi-subagents/
```

Each extension package contains its own `package.json`, `README.md`, `LICENSE`, `tsconfig.json`, and TypeScript source under `src/`.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
