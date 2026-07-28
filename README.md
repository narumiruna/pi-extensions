# 🧩 Pi Extensions for the Pi Coding Agent

[![npm scope](https://img.shields.io/badge/npm-@narumitw-blue)](https://www.npmjs.com/org/narumitw) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Independently installable [Pi Coding Agent](https://pi.dev) extensions and reusable extension
libraries for coding, research, browser automation, workflow management, observability, and terminal
ergonomics.

Install only what you need. Every package is published separately under the `@narumitw` npm scope.

## 🚀 Quick start

Install an extension permanently:

```bash
pi install npm:@narumitw/pi-goal
```

Try one without adding it permanently:

```bash
pi -e npm:@narumitw/pi-statusline
```

Combine multiple extensions:

```bash
pi -e npm:@narumitw/pi-goal \
  -e npm:@narumitw/pi-statusline \
  -e npm:@narumitw/pi-lsp
```

> [!IMPORTANT]
> Pi extensions run with your full user permissions. Review an extension before installing it from any third party.

## 📦 Choose an extension

### Coding and delegation

| Package | Use it for | Install |
| --- | --- | --- |
| [`pi-lsp`](./extensions/pi-lsp) | Language-server diagnostics and code actions across JavaScript, TypeScript, Python, Rust, Go, Ruby, C/C++, JVM, .NET, Swift, shell, infrastructure formats, and more. | `pi install npm:@narumitw/pi-lsp` |
| [`pi-plan-mode`](./extensions/pi-plan-mode) | Codex-like, read-only `/plan` collaboration before implementation begins. | `pi install npm:@narumitw/pi-plan-mode` |
| [`pi-subagents`](./extensions/pi-subagents) | Delegate isolated work in single, parallel, or chained execution modes. | `pi install npm:@narumitw/pi-subagents` |

### Browser and research

| Package | Use it for | Install |
| --- | --- | --- |
| [`pi-chrome-devtools`](./extensions/pi-chrome-devtools) | Inspect tabs, navigate pages, evaluate JavaScript, and capture screenshots through Chrome DevTools Protocol. | `pi install npm:@narumitw/pi-chrome-devtools` |
| [`pi-firecrawl`](./extensions/pi-firecrawl) | Scrape pages, crawl websites, discover URLs, and search the web with Firecrawl. | `pi install npm:@narumitw/pi-firecrawl` |
| [`pi-google-genai`](./extensions/pi-google-genai) | Ground agent work with Google Search, Google Maps, and URL context. | `pi install npm:@narumitw/pi-google-genai` |

### Task and workspace workflows

| Package | Use it for | Install |
| --- | --- | --- |
| [`pi-btw`](./extensions/pi-btw) | Ask a quick `/btw` side question without adding it to the main conversation. | `pi install npm:@narumitw/pi-btw` |
| [`pi-caffeinate`](./extensions/pi-caffeinate) | Prevent system sleep while Pi processes a long-running prompt. | `pi install npm:@narumitw/pi-caffeinate` |
| [`pi-goal`](./extensions/pi-goal) | Keep the agent working until a goal is verified complete; optionally enable an experimental ordered queue. | `pi install npm:@narumitw/pi-goal` |
| [`pi-worktree`](./extensions/pi-worktree) | Create, switch, remove, and prune Git worktrees while carrying the Pi session into another workspace. | `pi install npm:@narumitw/pi-worktree` |

### Accounts and data

| Package | Use it for | Install |
| --- | --- | --- |
| [`pi-accounts`](./extensions/pi-accounts) | Switch named OpenAI Codex, Anthropic, and GitHub Copilot subscription OAuth accounts with `/account`. | `pi install npm:@narumitw/pi-accounts` |
| [`pi-usage`](./extensions/pi-usage) | View current-account Codex subscription limits or OpenRouter API-key spend limits with `/usage`. | `pi install npm:@narumitw/pi-usage` |
| [`pi-sync`](./extensions/pi-sync) | Sync allowlisted Pi settings and optional sessions through Cloudflare R2 or S3-compatible storage. | `pi install npm:@narumitw/pi-sync` |

### Status and observability

| Package | Use it for | Install |
| --- | --- | --- |
| [`pi-github-pr`](./extensions/pi-github-pr) | Show current-branch pull request checks, reviews, and comment counts through the authenticated `gh` CLI. | `pi install npm:@narumitw/pi-github-pr` |
| [`pi-langfuse`](./extensions/pi-langfuse) | Send agent runs, generations, token usage, costs, and tool activity to Langfuse. | `pi install npm:@narumitw/pi-langfuse` |
| [`pi-starship`](./extensions/pi-starship) | Use a native Starship-style TOML footer with Pi-specific modules and no Starship binary dependency. | `pi install npm:@narumitw/pi-starship` |
| [`pi-statusline`](./extensions/pi-statusline) | Show model, tools, Git state, context usage, tokens, cost, and time in a preset or JSON-configured footer. | `pi install npm:@narumitw/pi-statusline` |

Choose either `pi-starship` or `pi-statusline`; do not enable both footer extensions together.

### Browser companions

| Package | Use it for | Install |
| --- | --- | --- |
| [`pi-image-drop`](./extensions/pi-image-drop) | Stage an ordered, memory-only image batch in a private loopback page for the next Pi message. | `pi install npm:@narumitw/pi-image-drop` |

## 🧱 Extension libraries

| Package | Use it for | Install |
| --- | --- | --- |
| [`pi-tui-kit`](./packages/pi-tui-kit) | Extend `@earendil-works/pi-tui` with reusable navigation helpers and declarative action, detail, settings, and multi-select flows. | `npm install @narumitw/pi-tui-kit` |

Libraries are runtime dependencies for extension authors, not standalone Pi extensions. New standard
manager menus should use `@narumitw/pi-tui-kit`; extensions continue to own domain state,
commands, settings persistence, confirmations, and specialized UI.

## 🧪 Experimental extensions

> [!WARNING]
> Experimental extensions are published and installable, but their interaction models and package APIs may change between releases.

| Package | Use it for | Install |
| --- | --- | --- |
| [`pi-file-context`](./experimental/pi-file-context) | Browse project files, preview text, select exact lines or Git diff hunks, and attach immutable snapshots with Git provenance to the next prompt. Open it by typing `@` at a word boundary or running `/file-context`. | `pi install npm:@narumitw/pi-file-context` |
| [`pi-jupyter`](./experimental/pi-jupyter) | Choose and preview saved Jupyter notebooks from one `/jupyter` current-state menu without running a kernel. | `pi install npm:@narumitw/pi-jupyter` |
| [`pi-webui`](./experimental/pi-webui) | Use a private loopback browser companion for the current terminal session with live activity and text/image input. | `pi install npm:@narumitw/pi-webui` |

## 🔧 Advanced installation

<details>
<summary>Install this repository directly from GitHub</summary>

Install the repository as one Pi package:

```bash
pi install git:github.com/narumiruna/pi-extensions
```

The repository root auto-discovers every production extension under `extensions/`, so this enables all of them. Experimental packages under `experimental/` are not auto-discovered by the root Git package.

To load only selected extensions, replace the installed package entry in `~/.pi/agent/settings.json` with a resource filter:

```json
{
  "packages": [
    {
      "source": "git:github.com/narumiruna/pi-extensions",
      "extensions": [
        "extensions/pi-accounts/src/index.ts",
        "extensions/pi-usage/src/index.ts"
      ]
    }
  ]
}
```

Filters use resource paths relative to the repository root. A package directory such as `extensions/pi-accounts` is not enough; select its `src/index.ts` entrypoint.

Restart Pi or run `/reload` after changing the filter. Update the checkout later with:

```bash
pi update --extensions
```

</details>

## 🧑‍💻 Local development

From the repository root:

```bash
npm install
npm run check
```

Use the generic Just recipes with an unscoped extension name:

```bash
just try goal
just pack goal

# Experimental packages use the same recipes
just try file-context
just pack file-context

# Libraries have dedicated pack recipes
just pack-tui-kit
```

Run `just --list` to see all development, install, pack, and publishing recipes.

<details>
<summary>Publishing a new scoped package</summary>

`just npm-public @narumitw/pi-new-extension` only changes visibility for an existing npm package. If npm returns 404 for a brand-new package, publish it once with public access:

```bash
npm publish --workspace @narumitw/pi-new-extension --access public
```

After the initial publication, the shared release workflow handles libraries, production extensions,
and publishable experimental packages.

</details>

## 🗂️ Repository structure

```text
packages/                Reusable publishable extension libraries
extensions/              Production extension packages
experimental/            Published experiments with visible stability warnings
deprecated/              Reference packages excluded from active workspace scripts
docs/                    Repository conventions and plans
scripts/                 Shared checks, tests, versioning, and release helpers
test/                    Root integration and repository tests
```

Each active package contains its own `package.json`, `README.md`, `LICENSE`, `tsconfig.json`, and
TypeScript source under `src/`. Extension `src/index.ts` files are thin Pi entrypoints; reusable
libraries publish built ESM and declarations from `dist/`.

<details>
<summary>Deprecated packages</summary>

The following packages remain available as source references but are excluded from active workspace scripts:

- `pi-biome-lsp` and `pi-python-lsp` — replaced by [`pi-lsp`](./extensions/pi-lsp)
- `pi-codex-accounts` — replaced by [`pi-accounts`](./extensions/pi-accounts)
- `pi-codex-usage` — replaced by [`pi-usage`](./extensions/pi-usage)
- `pi-retry` — replaced by Pi's built-in provider retry and timeout behavior
- `pi-auto-thinking`
- `pi-sidebar`
- `pi-telegram-bot`
- `pi-telegraph`
- `pi-wait-what`

</details>

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
