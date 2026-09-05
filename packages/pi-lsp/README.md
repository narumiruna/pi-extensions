# 🧠 pi-lsp — Run Targeted LSP Diagnostics and Fixes

[![npm](https://img.shields.io/npm/v/@narumitw/pi-lsp)](https://www.npmjs.com/package/@narumitw/pi-lsp) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Give Pi targeted Language Server Protocol diagnostics and source fixes during an edit.
Configure language servers by command and file extension instead of relying on hard-coded language families.

## ✨ Features

- Configures language servers in JSON and routes files by extension.
- Runs multiple servers for the same file type when complementary diagnostics are useful.
- Exposes `lsp_diagnostics` for exact ranges and `lsp_fix` for supported source actions.
- Supports workspace roots, bounded discovery, per-call server overrides, and preview-or-write edits.
- Starts servers only for tool calls, shuts them down afterward, and shows activity only while they run.

## 📦 Install

```bash
pi install npm:@narumitw/pi-lsp
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-lsp
```

Build and try this package locally from the repository root:

```bash
npm --workspace @narumitw/pi-lsp run build
pi -e ./packages/pi-lsp
```

The package declares `dist/index.ts`, so Pi cannot load an unbuilt local checkout.
Pi extensions run with your user permissions.
Review extension source before installing it.

## 🚀 Quick start

Install at least one language server from the built-in catalog on `PATH`, then run `/lsp` to check command availability.
The agent can call `lsp_diagnostics` for targeted diagnostics and `lsp_fix` for supported source actions.

## 🎯 When to use pi-lsp

Use pi-lsp when a language server can answer a targeted question about the files being edited faster than the project's authoritative checks.
It is most useful when:

- a full-project lint or typecheck is slow, but only a few files need intermediate feedback;
- exact diagnostic ranges and severity are easier to act on than CLI output;
- a server provides a useful source action such as `source.fixAll` or `source.organizeImports`;
- a multi-language repository benefits from one configurable diagnostics interface.

First document the repository's authoritative format, lint, typecheck, build, and test commands in `AGENTS.md`.
Use pi-lsp for intermediate feedback, then run those authoritative commands before declaring the task complete.
If the repository checks are already fast and reliable, pi-lsp may add little value.

A practical workflow is:

1. Call `lsp_diagnostics` when targeted feedback is useful.
2. Optionally call `lsp_fix` for a server-supported source action.
3. Run the repository's authoritative validation commands before completion.
4. Use pre-commit hooks and CI as the final enforcement layer.

## ⚙️ Settings

Without a settings file, pi-lsp uses its [built-in server catalog](./docs/settings.md#built-in-servers).
Install the language-server commands you need on `PATH`; pi-lsp never downloads them and starts a server only for a matching tool call.
Diagnostics skips unavailable default commands, but an explicitly selected or custom-configured missing command is an error.

Configuration uses the trusted project's `<workspace>/.pi/pi-lsp.json`, then the user file `~/.pi/agent/pi-lsp.json`, then the built-in catalog.
A custom configuration replaces the entire server map rather than merging with the defaults.
For example, this file selects only Ruff:

```json
{
  "ruff": {
    "command": ["ruff", "server"],
    "extensions": [".py", ".pyi"]
  }
}
```

Project settings come only from the trusted Pi session workspace; a tool's `root` does not authorize another directory's settings.
Server commands run with Pi's permissions and inherit its environment.

Read the [settings reference](./docs/settings.md) for the complete catalog, installation examples, global timeout, server options, multi-server configurations, and legacy migration.

## ⚠️ Tool changes

`lsp_format` is no longer provided. pi-lsp now focuses on LSP diagnostics and source code actions:

- `lsp_diagnostics`
- `lsp_fix`

Use project formatters or shell commands for formatting workflows.

## 🛠️ Tools

### `lsp_diagnostics`

Run diagnostics through configured servers.

Parameters:

- `paths?`: files or directories to check.
  Defaults to the workspace root.
- `root?`: workspace root.
  Defaults to cwd.
- `limit?`: maximum files to open per selected server.
- `server?`: configured server name, or an array of names.
  Defaults to all matching servers.

### `lsp_fix`

Apply source fixes or import organization through a configured server that matches its extension.
If multiple servers match, pass `server` explicitly.

Parameters:

- `path`: file to fix.
- `root?`: workspace root.
  Defaults to cwd.
- `kind?`: source action kind.
  Defaults to `source.fixAll`.
- `write?`: write fixed text back to the file.
  Defaults to false.
- `server?`: optional configured server name.

## 💬 Commands

```text
/lsp
```

In TUI and RPC modes, it shows each configured LSP command and whether it is available on `PATH`.
For compatibility, `/lsp` ignores command arguments.

## 🔒 Security and privacy

pi-lsp starts configured language-server commands with your user permissions.
User config is trusted input, and project config is used only when Pi trusts the current project.
Review every configured command, argument, environment value, and initialization option before using it.
A server process inherits Pi's environment and receives any `servers[].env` overrides.

## 🚧 Limitations

- Diagnostics are not injected continuously; the agent must call `lsp_diagnostics`.
- Language servers start and stop for each tool call, so pi-lsp does not keep an editor-like incremental session.
- The tools provide diagnostics and source code actions, not symbol navigation, references, or semantic rename.
- A clean LSP result does not replace the repository's formatter, linter, type checker, build, or tests.
- This project has not demonstrated through benchmarks that LSP improves agent task success, latency, or tool use.

This guidance is informed by [Eric Traut's comment on LSP integration for coding agents](https://github.com/openai/codex/issues/8745#issuecomment-3713058579).
The comment notes that repository-native checks may already provide much of the useful verification.

## 🗂️ Package layout

```text
packages/pi-lsp/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── pi-lsp.ts                      # Diagnostics and source-fix tools
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
├── docs/                              # Published reference documentation
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi Coding Agent, Language Server Protocol, LSP diagnostics, code actions, source fixes, configurable language servers, TypeScript Pi package.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
