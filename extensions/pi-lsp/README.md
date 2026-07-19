# 🧠 pi-lsp — Configurable Language Server Tools for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-lsp)](https://www.npmjs.com/package/@narumitw/pi-lsp) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-lsp` is a native [Pi coding agent](https://pi.dev) extension that exposes diagnostics and source-fix tools through configurable Language Server Protocol routes.

The extension is language-agnostic: servers are selected by config and file extension instead of hard-coded language families.

## ✨ Features

- Configure LSP servers with simple JSON keyed by server name.
- Routes diagnostics and source fixes by configured file extensions.
- Supports multiple servers for the same extension, for example `ty` and `ruff` for `.py`/`.pyi` diagnostics.
- Uses one internal LSP runner for JSON-RPC framing, subprocess lifecycle, diagnostics, code actions, and workspace edit application.
- Supports workspace roots, file limits, recursive file discovery, server overrides, and write-or-preview edits.
- Starts language servers only for tool calls, then shuts them down.
- Shows statusline activity only while LSP tools are running.

## 📦 Install

```bash
pi install npm:@narumitw/pi-lsp
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-lsp
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/pi-lsp
```

## ⚙️ Configuration

If no config is provided, pi-lsp ships a broad catalog of direct-command defaults. Servers are started only when matching files are requested. pi-lsp does not download language servers, so install the commands you need and make them available on `PATH`. During no-config diagnostics, unavailable default commands are filtered before workspace discovery. If none can run, diagnostics completes successfully and reports the skipped servers. Explicitly selected or custom-configured missing commands still report an error.

| Language or format | Default server | Startup command | Extensions |
| --- | --- | --- | --- |
| JavaScript, TypeScript, JSON, CSS, GraphQL, HTML, Vue, Astro, Svelte | `biome` | `biome lsp-proxy` | `.js`, `.jsx`, `.ts`, `.tsx`, `.json`, `.jsonc`, `.css`, `.graphql`, `.gql`, `.html`, `.vue`, `.astro`, `.svelte`, and module variants |
| Python typing | `ty` | `ty server` | `.py`, `.pyi` |
| Python linting and fixes | `ruff` | `ruff server` | `.py`, `.pyi` |
| Rust | `rust-analyzer` | `rust-analyzer` | `.rs` |
| Go | `gopls` | `gopls` | `.go` |
| Ruby | `rubocop` | `rubocop --lsp` | `.rb`, `.rake`, `.gemspec`, `.ru` |
| Elixir | `elixir-ls` | `language_server.sh` (`language_server.bat` on Windows) | `.ex`, `.exs` |
| Zig | `zls` | `zls` | `.zig`, `.zon` |
| C# | `csharp` | `roslyn-language-server --stdio --autoLoadProjects` | `.cs`, `.csx` |
| F# | `fsharp` | `fsautocomplete` | `.fs`, `.fsi`, `.fsx`, `.fsscript` |
| Swift and Objective-C++ | `sourcekit-lsp` | `sourcekit-lsp` | `.swift`, `.mm` |
| C and C++ | `clangd` | `clangd --background-index --clang-tidy` | C/C++ source and header extensions |
| Java | `jdtls` | `jdtls` | `.java` |
| Kotlin | `kotlin-lsp` | `kotlin-lsp --stdio` | `.kt`, `.kts` |
| YAML | `yaml-language-server` | `yaml-language-server --stdio` | `.yaml`, `.yml` |
| Lua | `lua-language-server` | `lua-language-server` | `.lua` |
| PHP | `intelephense` | `intelephense --stdio` | `.php` |
| Prisma | `prisma` | `prisma-language-server --stdio` | `.prisma` |
| Dart | `dart` | `dart language-server` | `.dart` |
| OCaml | `ocaml-lsp` | `ocamllsp` | `.ml`, `.mli` |
| Bash | `bash-language-server` | `bash-language-server start` | `.sh`, `.bash` |
| Terraform | `terraform-ls` | `terraform-ls serve` | `.tf`, `.tfvars` |
| LaTeX and BibTeX | `texlab` | `texlab` | `.tex`, `.bib` |
| Gleam | `gleam` | `gleam lsp` | `.gleam` |
| Clojure | `clojure-lsp` | `clojure-lsp listen` | `.clj`, `.cljs`, `.cljc`, `.edn` |
| Nix | `nixd` | `nixd` | `.nix` |
| Typst | `tinymist` | `tinymist` | `.typ`, `.typc` |
| Haskell | `haskell-language-server` | `haskell-language-server-wrapper --lsp` | `.hs`, `.lhs` |

For example, install the Rust and Go servers with their official toolchains:

```bash
rustup component add rust-analyzer rust-src
go install golang.org/x/tools/gopls@latest
```

Ensure the Go install directory (`$GOBIN` or `$(go env GOPATH)/bin`) is also on `PATH`.

Custom config can be supplied in one of these locations:

1. `PI_LSP_CONFIG` as inline JSON or a path to a JSON file
2. `<workspace>/.pi/pi-lsp.json`
3. `~/.pi/agent/pi-lsp.json`

`PI_LSP_CONFIG` only accepts JSON or a JSON file path; JavaScript and TypeScript config files are not evaluated.

Compatibility: a user-scoped legacy `lsp.json` is migrated automatically. A project-scoped legacy `.pi/lsp.json` remains readable with a warning but is not renamed automatically, so the extension never modifies a repository working tree. New paths take precedence when both names exist.

Providing custom config replaces the default server map. The following `pi-lsp.json` example intentionally keeps five selected servers:

```json
{
  "ty": {
    "command": ["ty", "server"],
    "extensions": [".py", ".pyi"]
  },
  "ruff": {
    "command": ["ruff", "server"],
    "extensions": [".py", ".pyi"]
  },
  "biome": {
    "command": ["biome", "lsp-proxy"],
    "extensions": [
      ".astro",
      ".css",
      ".graphql",
      ".gql",
      ".html",
      ".js",
      ".jsx",
      ".json",
      ".jsonc",
      ".ts",
      ".tsx",
      ".vue"
    ]
  },
  "rust-analyzer": {
    "command": ["rust-analyzer"],
    "extensions": [".rs"]
  },
  "gopls": {
    "command": ["gopls"],
    "extensions": [".go"]
  }
}
```

Use `servers` when you need global pi-lsp options such as timeout:

```json
{
  "timeout": 30000,
  "servers": {
    "ty": {
      "command": ["ty", "server"],
      "extensions": [".py", ".pyi"],
      "env": {
        "LSP_LOG": "debug"
      },
      "initialization": {
        "settings": {}
      },
      "skipDirectories": ["generated"]
    }
  }
}
```

Each server entry supports:

- `command`: argv array used to start the LSP server.
- `extensions`: file extensions that should route to this server.
- `env`: extra environment variables for the LSP server process.
- `initialization`: LSP initialization options and workspace configuration values.
- `skipDirectories`: additional directory names to exclude from recursive discovery. Explicitly requested paths remain available.
- `diagnosticsSettleMs`: positive number of milliseconds without another push-diagnostics publication before using the latest result. Defaults to `800`; the built-in intelephense route uses `4000`. The global timeout remains the upper bound.

Global options:

- `timeout`: request timeout in milliseconds. Defaults to `20000`.

pi-lsp infers `languageId` from common extensions and falls back to the extension without the leading dot.

Per-server command overrides still use the normalized server name:

```bash
PI_TY_LSP_COMMAND="uvx ty server" \
PI_RUFF_LSP_COMMAND="uvx ruff server" \
pi -e ./extensions/pi-lsp
```

## ⚠️ Tool changes

`lsp_format` is no longer provided. pi-lsp now focuses on LSP diagnostics and source code actions:

- `lsp_diagnostics`
- `lsp_fix`

Use project formatters or shell commands for formatting workflows.

## 🛠️ Pi tools

### `lsp_diagnostics`

Run diagnostics through configured servers.

Parameters:

- `paths?`: files or directories to check. Defaults to the workspace root.
- `root?`: workspace root. Defaults to cwd.
- `limit?`: maximum files to open per selected server.
- `server?`: configured server name, or an array of names. Defaults to all matching servers.

### `lsp_fix`

Apply source fixes or import organization through a configured server that matches its extension. If multiple servers match, pass `server` explicitly.

Parameters:

- `path`: file to fix.
- `root?`: workspace root. Defaults to cwd.
- `kind?`: source action kind. Defaults to `source.fixAll`.
- `write?`: write fixed text back to the file. Defaults to false.
- `server?`: optional configured server name.

## 💬 Command

```text
/lsp
```

Shows configured LSP commands and whether each command is available on `PATH`.

## 🗂️ Package layout

```txt
extensions/pi-lsp/
├── src/
│   ├── adapters.ts
│   ├── command.ts
│   ├── files.ts
│   ├── lsp-client.ts
│   ├── pi-lsp.ts
│   ├── routes.ts
│   ├── runner.ts
│   ├── text-edits.ts
│   └── types.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
