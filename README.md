# 🧩 Pi Extensions for the Pi Coding Agent

[![npm scope](https://img.shields.io/badge/npm-@narumitw-blue)](https://www.npmjs.com/org/narumitw) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Independently installable [Pi Coding Agent](https://pi.dev) extensions and reusable extension
libraries for coding, research, browser automation, workflow management, observability, and terminal
ergonomics.

Install only what you need.
Published packages use the `@narumitw` npm scope, and package READMEs identify source-only exceptions.

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

## ⭐ Extensions I use every day

These extensions are part of my daily Pi setup:

| Extension | Why I use it |
| --- | --- |
| [`pi-btw`](./packages/pi-btw) | Ask a quick side question without polluting the main context. |
| [`pi-accounts`](./packages/pi-accounts) | Switch between named subscription OAuth accounts. |
| [`pi-caffeinate`](./packages/pi-caffeinate) | Keep my machine awake so Pi can keep working. |
| [`pi-codex-compact`](./packages/pi-codex-compact) | Spend a little more for better compaction quality. |
| [`pi-stamp`](./packages/pi-stamp) | See useful details for each response, such as its timestamp. |
| [`pi-starship`](./packages/pi-starship) | Match Pi's footer to my Starship shell setup. |
| [`pi-sync`](./packages/pi-sync) | Sync my Pi configuration across devices through Git, WebDAV, R2, or S3. |
| [`pi-usage`](./packages/pi-usage) | Check my Codex usage and limit reset times without opening Codex. |

## 📦 Choose an extension

### Coding and delegation

| Package | Use it for | Install |
| --- | --- | --- |
| [`pi-codex-compact`](./packages/pi-codex-compact) | Use OpenAI Codex Remote Compaction V2 to persist and replay bounded opaque checkpoints, with `/codex-compact` manual controls and safe Pi-native fallback. | `pi install npm:@narumitw/pi-codex-compact` |
| [`pi-file-context`](./packages/pi-file-context) | Browse project files, preview text, select exact lines or Git diff hunks, and attach immutable snapshots with Git provenance to the next prompt. Open it with configurable `Ctrl+Shift+X` or `/file-context`. | `pi install npm:@narumitw/pi-file-context` |
| [`pi-lsp`](./packages/pi-lsp) | Language-server diagnostics and code actions across JavaScript, TypeScript, Python, Rust, Go, Ruby, C/C++, JVM, .NET, Swift, shell, infrastructure formats, and more. | `pi install npm:@narumitw/pi-lsp` |
| [`pi-plan-mode`](./packages/pi-plan-mode) | Codex-like, read-only `/plan` collaboration before implementation begins. | `pi install npm:@narumitw/pi-plan-mode` |
| [`pi-subagents`](./packages/pi-subagents) | Start bounded background Pi jobs with authenticated main-agent messaging. | [Install from source](./packages/pi-subagents#-install) |

### Browser and research

| Package | Use it for | Install |
| --- | --- | --- |
| [`pi-chrome-devtools`](./packages/pi-chrome-devtools) | Inspect tabs, navigate pages, evaluate JavaScript, and capture screenshots through Chrome DevTools Protocol. | `pi install npm:@narumitw/pi-chrome-devtools` |
| [`pi-firecrawl`](./packages/pi-firecrawl) | Scrape pages, crawl websites, discover URLs, and search the web with Firecrawl. | `pi install npm:@narumitw/pi-firecrawl` |

### Task and workspace workflows

| Package | Use it for | Install |
| --- | --- | --- |
| [`pi-btw`](./packages/pi-btw) | Ask a quick `/btw` side question without adding it to the main conversation. | `pi install npm:@narumitw/pi-btw` |
| [`pi-caffeinate`](./packages/pi-caffeinate) | Prevent system sleep while Pi processes a long-running prompt. | `pi install npm:@narumitw/pi-caffeinate` |
| [`pi-goal`](./packages/pi-goal) | Keep the agent working until a goal is verified complete; optionally enable an experimental ordered queue. | `pi install npm:@narumitw/pi-goal` |
| [`pi-worktree`](./packages/pi-worktree) | Create, switch, remove, and prune Git worktrees while carrying the Pi session into another workspace. | `pi install npm:@narumitw/pi-worktree` |

Current Plan and Goal releases can coexist on the characterized Pi runtime through their anonymous cooperative workflow mutex.
The deprecated combined `pi-workflow` package has no atomic Plan-to-Goal replacement; follow its [archived migration instructions](./deprecated/pi-workflow/README.md#-migration-from-pi-workflow).

### Local collaboration

| Package | Use it for | Install |
| --- | --- | --- |
| [`pi-chat`](./packages/pi-chat) | Join ephemeral peer-to-peer chat rooms that stay separate from Pi sessions, prompts, and model context. | `pi install npm:@narumitw/pi-chat` |
| [`pi-fleet`](./packages/pi-fleet) | Start a separate Pi process in a terminal split and connect explicit local Pi sessions for bounded messages and one-turn requests. | `pi install npm:@narumitw/pi-fleet` |
| [`pi-herdr`](./packages/pi-herdr) | Report Pi lifecycle state to Herdr and bundle safe Herdr terminal-orchestration guidance. | `pi install npm:@narumitw/pi-herdr` |

### Accounts and data

| Package | Use it for | Install |
| --- | --- | --- |
| [`pi-accounts`](./packages/pi-accounts) | Switch named OpenAI Codex, Anthropic, GitHub Copilot, Kimi For Coding, OpenRouter, Radius, and xAI OAuth accounts with `/accounts`. | `pi install npm:@narumitw/pi-accounts` |
| [`pi-recall`](./packages/pi-recall) | Save selected text messages locally and preview or quote them across Pi sessions. | `pi install npm:@narumitw/pi-recall` |
| [`pi-usage`](./packages/pi-usage) | View current-account Codex subscription limits or OpenRouter API-key spend limits with `/usage`. | `pi install npm:@narumitw/pi-usage` |
| [`pi-sync`](./packages/pi-sync) | Sync allowlisted Pi settings and optional sessions through Git, WebDAV, R2, or S3 with bundled setup guidance. | `pi install npm:@narumitw/pi-sync` |

### Status and observability

| Package | Use it for | Install |
| --- | --- | --- |
| [`pi-analytics`](./packages/pi-analytics) | Review private, content-free local metrics for model calls, skills, tools, response cycles, and observed provider reliability through `/analytics`. | `pi install npm:@narumitw/pi-analytics` |
| [`pi-github-pr`](./packages/pi-github-pr) | Show current-branch pull request checks, reviews, and comment counts through the authenticated `gh` CLI. | `pi install npm:@narumitw/pi-github-pr` |
| [`pi-langfuse`](./packages/pi-langfuse) | Send agent runs, generations, token usage, costs, and tool activity to Langfuse. | `pi install npm:@narumitw/pi-langfuse` |
| [`pi-stamp`](./packages/pi-stamp) | Show configurable timestamps with opt-in assistant metadata, response timing, and tool timing in the TUI transcript. | `pi install npm:@narumitw/pi-stamp` |
| [`pi-starship`](./packages/pi-starship) | Use a native Starship-style TOML footer with Pi-specific modules and no Starship binary dependency. | `pi install npm:@narumitw/pi-starship` |
| [`pi-statusline`](./packages/pi-statusline) | Show model, tools, Git state, context usage, tokens, cost, and time in a preset or JSON-configured footer. | `pi install npm:@narumitw/pi-statusline` |
| [`pi-tool`](./packages/pi-tool) | Browse every configured tool and inspect its active state, source, parameter schema, and prompt guidelines with `/tool`. | `pi install npm:@narumitw/pi-tool` |

Choose either `pi-starship` or `pi-statusline`; do not enable both footer extensions together.

## 🧱 Extension libraries

| Package | Use it for | Install |
| --- | --- | --- |
| [`pi-tui-kit`](./packages/pi-tui-kit) | Extend `@earendil-works/pi-tui` with reusable navigation helpers and declarative action, detail, settings, and multi-select flows. | `npm install @narumitw/pi-tui-kit` |

Libraries are runtime dependencies for extension authors, not standalone Pi extensions. New standard
manager menus should use `@narumitw/pi-tui-kit`; extensions continue to own domain state,
commands, settings persistence, confirmations, and specialized UI.

## 🔧 Advanced installation

<details>
<summary>Install this repository directly from GitHub</summary>

Install the repository as one Pi package:

```bash
pi install git:github.com/narumiruna/pi-extensions
```

The repository root Pi manifest explicitly lists every extension under `packages/`, so this enables all of them.

To load only selected extensions, replace the installed package entry in `~/.pi/agent/settings.json` with a resource filter:

```json
{
  "packages": [
    {
      "source": "git:github.com/narumiruna/pi-extensions",
      "extensions": [
        "packages/pi-accounts/src/index.ts",
        "packages/pi-usage/src/index.ts"
      ]
    }
  ]
}
```

Filters use resource paths relative to the repository root. A package directory such as `packages/pi-accounts` is not enough; select its `src/index.ts` entrypoint.

Restart Pi or run `/reload` after changing the filter. Update the checkout later with:

```bash
pi update --extensions
```

</details>

## 🧑‍💻 Local development

From the repository root:

```bash
npm install
npm test
npm run check
```

`npm test` typechecks the test sources and runs the root and workspace suites with Vitest.

Build generated entries before loading local packages, and use the generic npm pack workflow with an unscoped package name:

```bash
npm --workspace @narumitw/pi-goal run build --if-present
pi -e ./packages/pi-goal
npm run package:pack -- goal

# Another build-backed package uses the same local flow and pack workflow
npm --workspace @narumitw/pi-file-context run build --if-present
pi -e ./packages/pi-file-context
npm run package:pack -- file-context

# Libraries use the same generic pack workflow
npm run package:pack -- tui-kit
```

Run `npm run` to see all development, install, pack, and release workflows.
Pull requests that change published package behavior should add release intent with `npm run changeset`.
Packages version independently.

<details>
<summary>Publishing a new scoped package</summary>

`npm run package:public -- @narumitw/pi-new-extension` only changes visibility for an existing npm package.
If npm returns 404 for a brand-new package, publish it once with public access:

```bash
npm publish --workspace @narumitw/pi-new-extension --access public
```

After the initial publication, Changesets handles extensions and libraries through independent package versions.

</details>

## 🦋 Releases

A behavior-changing package pull request records its affected packages and SemVer bumps with:

```bash
npm run changeset
```

After changesets reach `main`, the release workflow creates or updates one version pull request. That
pull request changes only selected package versions, dependency ranges where configured, changelogs,
and the lockfile. Merging it publishes the new versions with npm provenance and creates
package-specific tags and GitHub releases such as `@narumitw/pi-goal@0.50.0`.

Repository-only documentation, tests, tooling, and path migrations may omit a changeset. Use
`npm run changeset:status` to inspect pending releases. Versioning and publication run through the
release workflow; initial publication remains the manually approved exception described above.

`@narumitw/pi-tui-kit` remains independently versioned. Publish a new Kit API before raising an
extension's compatibility floor to consume it; do not release an unpublished Kit API and its first
consumer together.

## 🗂️ Repository structure

```text
packages/                Extension packages and reusable libraries
deprecated/              Reference packages excluded from active workspace scripts
docs/                    Repository conventions and plans
scripts/                 Shared checks, tests, versioning, and release helpers
test/                    Root integration and repository tests
```

Each active package contains its own `package.json`, `README.md`, `LICENSE`, `tsconfig.json`, and TypeScript source under `src/`.
Every extension keeps a thin `src/index.ts` source forwarder and declares one package entrypoint.
An extension package may load that source entrypoint directly or publish a build-backed `dist/index.ts` bundle for Pi's Jiti runtime.
Reusable libraries publish built ESM and declarations from `dist/`.

<details>
<summary>Deprecated packages</summary>

The following packages remain available as source references but are excluded from active workspace scripts:

- `pi-biome-lsp` and `pi-python-lsp` — replaced by [`pi-lsp`](./packages/pi-lsp)
- `pi-codex-accounts` — replaced by [`pi-accounts`](./packages/pi-accounts)
- `pi-codex-usage` — replaced by [`pi-usage`](./packages/pi-usage)
- [`pi-cbmem`](./deprecated/pi-cbmem) — deprecated without a replacement because a simple benchmark found insufficient benefit and substantially higher token usage
- `pi-retry` — replaced by Pi's built-in provider retry and timeout behavior
- `pi-google-genai` — replaced by the `grounding-with-google-genai` agent skill
- `pi-image-drop` — deprecated without a replacement
- [`pi-workflow`](./deprecated/pi-workflow) — replaced by focused Plan and Goal products; atomic Plan-to-Goal handoff has [no replacement](./deprecated/pi-workflow/README.md#-migration-from-pi-workflow)
- `pi-jupyter` — deprecated without a replacement
- `pi-webui` — deprecated without a replacement
- `pi-auto-thinking`
- `pi-sidebar`
- `pi-telegram-bot`
- `pi-telegraph`
- `pi-wait-what`

</details>

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
