# 🧩 Pi Extensions for the Pi Coding Agent

[![npm scope](https://img.shields.io/badge/npm-@narumitw-blue)](https://www.npmjs.com/org/narumitw) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Production-ready, independently installable [Pi](https://pi.dev) Coding Agent extension packages for AI coding workflows. This TypeScript monorepo publishes npm packages under `@narumitw` and gives Pi native tools, slash commands, and statusline integrations for LSP diagnostics and code actions across JavaScript, TypeScript, Python, Rust, Go, Ruby, C/C++, JVM, .NET, Swift, shell, infrastructure formats, and more; Chrome DevTools Protocol browser automation; Firecrawl web scraping, crawling, and web search; Google GenAI grounding for Google Search, Maps, and URL context; Langfuse LLM observability; ChatGPT Codex account switching and usage status; GitHub pull request checks; autonomous goal mode with opt-in ordered queues; Codex-like plan mode; local browser image staging and lightweight current-session web chat; subagents; rich terminal statuslines; Cloudflare R2/S3 settings sync; retry handling; side questions; and keep-awake automation.

**Search keywords:** Pi Coding Agent extensions, AI coding agent tools, npm Pi packages, LSP diagnostics, Language Server Protocol, Chrome DevTools Protocol, browser automation, web scraping, Firecrawl, Google GenAI grounding, browser image staging, browser session chat, image attachments, Langfuse, LLM observability, ChatGPT Codex tools, subagents, terminal statusline, Cloudflare R2 sync, S3 sync.

## 📦 Pi extension packages

Install only the Pi extensions you need. Each package is published under the `@narumitw` npm scope and can be installed directly with the package-specific `pi install npm:@narumitw/...` command.

| Pi extension | What it adds | Install |
| --- | --- | --- |
| [`@narumitw/pi-btw`](./extensions/pi-btw) | 💬 `/btw` side-question command for asking quick questions without polluting the main conversation. | `pi install npm:@narumitw/pi-btw` |
| [`@narumitw/pi-caffeinate`](./extensions/pi-caffeinate) | ☕ Cross-platform sleep prevention while the Pi agent is processing long-running prompts. | `pi install npm:@narumitw/pi-caffeinate` |
| [`@narumitw/pi-chrome-devtools`](./extensions/pi-chrome-devtools) | 🌐 Native Chrome DevTools Protocol tools for listing tabs, navigating pages, evaluating JavaScript, and taking screenshots. | `pi install npm:@narumitw/pi-chrome-devtools` |
| [`@narumitw/pi-codex-accounts`](./extensions/pi-codex-accounts) | 🔐 `/codex-login`, `/codex-account`, and `/codex-logout` for switching self-managed ChatGPT Codex subscription accounts without changing Pi's `/login` list. | `pi install npm:@narumitw/pi-codex-accounts` |
| [`@narumitw/pi-codex-usage`](./extensions/pi-codex-usage) | 📊 `/codex-status` command and automatic statusline item for ChatGPT Codex subscription usage, using Pi auth first and Codex CLI only as fallback. | `pi install npm:@narumitw/pi-codex-usage` |
| [`@narumitw/pi-firecrawl`](./extensions/pi-firecrawl) | 🔥 Firecrawl-powered web scraping, crawling, URL discovery, and web search tools for documentation and research workflows. | `pi install npm:@narumitw/pi-firecrawl` |
| [`@narumitw/pi-github-pr`](./extensions/pi-github-pr) | 🔎 Passive current-branch GitHub PR checks, review, and comment counts in the statusline. | `pi install npm:@narumitw/pi-github-pr` |
| [`@narumitw/pi-goal`](./extensions/pi-goal) | 🎯 `/goal` mode that keeps the agent working until verified completion, with an opt-in experimental ordered queue. | `pi install npm:@narumitw/pi-goal` |
| [`@narumitw/pi-google-genai`](./extensions/pi-google-genai) | 🔎 Google GenAI grounding tools for Google Search, Maps, and URL context. | `pi install npm:@narumitw/pi-google-genai` |
| [`@narumitw/pi-image-drop`](./extensions/pi-image-drop) | 🖼️ `/image-drop` browser staging for ordered, memory-only image attachments on the next Pi message. | `pi install npm:@narumitw/pi-image-drop` |
| [`@narumitw/pi-langfuse`](./extensions/pi-langfuse) | 🪢 Langfuse traces for Pi agent runs, LLM generations, token usage, costs, and tool activity. | `pi install npm:@narumitw/pi-langfuse` |
| [`@narumitw/pi-lsp`](./extensions/pi-lsp) | 🧠 Language-agnostic LSP diagnostics and code actions for JavaScript, TypeScript, Python, Rust, Go, Ruby, C/C++, JVM, .NET, Swift, shell, infrastructure formats, and more. | `pi install npm:@narumitw/pi-lsp` |
| [`@narumitw/pi-plan-mode`](./extensions/pi-plan-mode) | 🧭 Codex-like read-only `/plan` collaboration mode with safe exploration and implementation-ready plans. | `pi install npm:@narumitw/pi-plan-mode` |
| [`@narumitw/pi-retry`](./extensions/pi-retry) | 🔁 Retry support for unknown provider errors, retryable Codex backend failures, websocket limits, and stalled streams. | `pi install npm:@narumitw/pi-retry` |
| [`@narumitw/pi-statusline`](./extensions/pi-statusline) | ✨ A rich Pi terminal statusline with model, tools, git branch/status, context usage, token totals, cost, and time. | `pi install npm:@narumitw/pi-statusline` |
| [`@narumitw/pi-sync`](./extensions/pi-sync) | ☁️ Sync allowlisted Pi settings, skills, prompts, themes, extensions, and optional sessions through Cloudflare R2 or S3-compatible storage. | `pi install npm:@narumitw/pi-sync` |
| [`@narumitw/pi-subagents`](./extensions/pi-subagents) | 🤖 Delegate work to specialized isolated subagents with single, parallel, and chained execution modes. | `pi install npm:@narumitw/pi-subagents` |
| [`@narumitw/pi-webui`](./extensions/pi-webui) | 🌐 `/webui` lightweight browser companion for the current terminal Pi session, with semantic live sync and text/image input. | `pi install npm:@narumitw/pi-webui` |

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

Use [`@narumitw/pi-lsp`](./extensions/pi-lsp) to let Pi run configurable Language Server Protocol servers through one shared runner. Without custom config, it provides direct-command routes across web, systems, scripting, JVM, .NET, mobile, markup, and infrastructure languages when the corresponding commands are available on `PATH`. Configure servers in `.pi/pi-lsp.json`, `~/.pi/agent/pi-lsp.json`, or `PI_LSP_CONFIG` with simple `{ command, extensions }` entries, then use Pi tools for diagnostics and source code actions. The older split packages [`@narumitw/pi-biome-lsp`](./extensions/deprecated/pi-biome-lsp) and [`@narumitw/pi-python-lsp`](./extensions/deprecated/pi-python-lsp) are deprecated, kept for reference, and excluded from active workspace scripts.

### 🧬 JavaScript and TypeScript coding with Biome

Use [`@narumitw/pi-lsp`](./extensions/pi-lsp) to route TypeScript, JavaScript, JSON, CSS, and other supported files to `biome lsp-proxy` for diagnostics and source actions such as organize imports or fix-all code actions.

### 🌐 Browser automation and debugging

Use [`@narumitw/pi-chrome-devtools`](./extensions/pi-chrome-devtools) when you want the Pi agent to inspect browser tabs, navigate web apps, run JavaScript in Chrome, or capture screenshots through the Chrome DevTools Protocol.

### 🔎 Web scraping, crawling, and research

Use [`@narumitw/pi-firecrawl`](./extensions/pi-firecrawl) to give Pi native Firecrawl tools for scraping markdown or HTML, mapping URLs, crawling websites, and searching the web from inside an agent workflow.

### 🔎 Google GenAI grounding

Use [`@narumitw/pi-google-genai`](./extensions/pi-google-genai) to give Pi Google Search, Google Maps, and URL-context grounding through Gemini Interactions with Pi Google auth or a private `pi-google-genai.json` config.

### 🖼️ Local image staging

Use [`@narumitw/pi-image-drop`](./extensions/pi-image-drop) to paste, drop, preview, and order images on a private loopback page, then attach the memory-only batch to the next non-empty interactive Pi message. `/image-drop` prints a one-time link and never launches a browser automatically.

### 🌐 Lightweight current-session web chat

Use [`@narumitw/pi-webui`](./extensions/pi-webui) to open a private loopback companion for the current terminal Pi session. `/webui` shows a one-time link; the page streams semantic messages and tool activity, sends text immediately or as follow-up/steer, and accepts sanitized image prompts without mirroring terminal ANSI pixels.

### 🪢 LLM observability

Use [`@narumitw/pi-langfuse`](./extensions/pi-langfuse) to send Pi agent, generation, token usage, cost, and tool spans to Langfuse with credentials stored in a private `pi-langfuse.json` file.

### 🔐 Codex subscription accounts

Use [`@narumitw/pi-codex-accounts`](./extensions/pi-codex-accounts) to keep multiple ChatGPT Codex subscription accounts in a private `pi-codex-accounts.json` file and switch the active account with `/codex-account`. It does not add provider aliases or change Pi's built-in `/login` provider list.

### 📊 Codex usage status

Use [`@narumitw/pi-codex-usage`](./extensions/pi-codex-usage) to show ChatGPT Codex subscription usage and reset windows from Pi with `/codex-status`. When the current model uses `openai-codex`, it also shows compact quota status in the statusline. It uses Pi's OpenAI Codex auth first, so Codex CLI is optional.

### 🔎 GitHub pull request status

Use [`@narumitw/pi-github-pr`](./extensions/pi-github-pr) to passively show the current branch PR number, checks state, review state, and comment/review count in Pi's statusline through the authenticated `gh` CLI.

### 🐍 Python coding with ty and Ruff

Use [`@narumitw/pi-lsp`](./extensions/pi-lsp) to route Python files to configured servers such as `ty server` for type diagnostics and `ruff server` for lint diagnostics or source actions such as import organization.

### 🎯 Autonomous task completion

Use [`@narumitw/pi-goal`](./extensions/pi-goal) for long-running implementation, debugging, refactoring, or verification work where the agent should continue past planning and call `goal_complete` only after the active goal is done. Single-goal behavior remains the default. Set `experimental.goals` to `true` in `~/.pi/agent/pi-goal.json` to add ordered `/goal add`, `prioritize`, `drop-last`, and `skip` operations while retaining the same singular command and tools.

### 🧭 Read-only planning mode

Use [`@narumitw/pi-plan-mode`](./extensions/pi-plan-mode) when you want a Codex-like `/plan` mode where the agent explores with read-only tools, asks structured questions, and produces an implementation-ready plan before editing.

### 🗃️ Deprecated extensions

[`@narumitw/pi-telegram-bot`](./extensions/deprecated/pi-telegram-bot), [`@narumitw/pi-telegraph`](./extensions/deprecated/pi-telegraph), and [`@narumitw/pi-wait-what`](./extensions/deprecated/pi-wait-what) are deprecated and kept under `extensions/deprecated/` for reference.

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
pi -e ./extensions/pi-codex-accounts
pi -e ./extensions/pi-codex-usage
pi -e ./extensions/pi-firecrawl
pi -e ./extensions/pi-github-pr
pi -e ./extensions/pi-goal
pi -e ./extensions/pi-google-genai
pi -e ./extensions/pi-image-drop
pi -e ./extensions/pi-langfuse
pi -e ./extensions/pi-lsp
pi -e ./extensions/pi-plan-mode
pi -e ./extensions/pi-retry
pi -e ./extensions/pi-statusline
pi -e ./extensions/pi-sync
pi -e ./extensions/pi-subagents
pi -e ./extensions/pi-webui
```

Preview npm package contents before publishing:

```bash
npm run pack:btw
npm run pack:caffeinate
npm run pack:chrome-devtools
npm run pack:codex-accounts
npm run pack:codex-usage
npm run pack:firecrawl
npm run pack:github-pr
npm run pack:goal
npm run pack:google-genai
npm run pack:image-drop
npm run pack:langfuse
npm run pack:lsp
npm run pack:plan-mode
npm run pack:retry
npm run pack:statusline
npm run pack:sync
npm run pack:subagents
npm run pack:webui
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
│   ├── pi-telegram-bot/
│   ├── pi-telegraph/
│   └── pi-wait-what/
├── pi-btw/
├── pi-caffeinate/
├── pi-chrome-devtools/
├── pi-codex-accounts/
├── pi-codex-usage/
├── pi-firecrawl/
├── pi-github-pr/
├── pi-goal/
├── pi-google-genai/
├── pi-image-drop/
├── pi-langfuse/
├── pi-lsp/
├── pi-plan-mode/
├── pi-retry/
├── pi-statusline/
├── pi-sync/
├── pi-subagents/
└── pi-webui/
```

Each production extension package contains its own `package.json`, `README.md`, `LICENSE`, `tsconfig.json`, and TypeScript source under `src/`. Experimental extensions live under `extensions/experimental/`, remain covered by root checks, and may be published only through an explicit local maintainer recipe—not `publish-all` or GitHub workflows. Deprecated packages live under `extensions/deprecated/` and are excluded from workspace scripts.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
