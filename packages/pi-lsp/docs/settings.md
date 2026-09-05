# Pi LSP settings reference

[Back to README](../README.md)

- [Built-in servers](#built-in-servers)
- [Configuration sources and migration](#configuration-sources-and-migration)
- [Custom server configurations](#custom-server-configurations)
- [Server and global options](#server-and-global-options)

## Built-in servers

Without a config file, pi-lsp uses the built-in direct-command catalog below.
pi-lsp does not download language servers, so install the commands you need and put them on `PATH`.
A server starts only when a tool call requests a matching file.
With the built-in catalog, diagnostics skips unavailable default commands before workspace discovery.
If no default command can run, diagnostics succeeds and reports the skipped servers.
An explicitly selected or custom-configured missing command still reports an error.

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

## Configuration sources and migration

pi-lsp resolves configuration in this order:

1. `<workspace>/.pi/pi-lsp.json`, only when Pi trusts the current project
2. `~/.pi/agent/pi-lsp.json`
3. the built-in server catalog

pi-lsp ignores both project files when Pi does not trust the project.
A tool's `root` selects files and the server working directory; it does not authorize that directory's project settings.
Project settings always come from the trusted Pi session workspace.

For compatibility, pi-lsp still reads user-scoped `lsp.json` and trusted project-scoped `.pi/lsp.json` with a warning.
It never modifies legacy files automatically.
Rename them to their canonical `pi-lsp.json` names.
Canonical paths take precedence when both names exist.

pi-lsp-specific environment settings have been removed.
Move their values into canonical JSON:

| Removed setting | JSON replacement |
| --- | --- |
| `PI_LSP_CONFIG` inline JSON | Save the same object as user `pi-lsp.json` or trusted project `.pi/pi-lsp.json` |
| `PI_LSP_CONFIG=/path/to/file.json` | Move or copy that configuration to one of the canonical paths above |
| `PI_<SERVER>_LSP_COMMAND` | Set the server's `command` to an argv array, with one string per executable or argument |

`servers[].env` remains supported because it configures the launched language-server process, not pi-lsp.

## Custom server configurations

Any custom config replaces the entire built-in server map.
The following `pi-lsp.json` example intentionally keeps five selected servers:

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
    "extensions": [".rs"],
    "pullDiagnosticsGraceMs": 5000
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

## Server and global options

Each server entry supports:

- `command`: argv array used to start the LSP server.
- `extensions`: file extensions that should route to this server.
- `env`: environment overrides for the LSP server process.
  The child inherits Pi's environment, then applies these values; an `env.PATH` value is also used to resolve `command[0]`.
- `initialization`: LSP initialization options and workspace configuration values.
- `skipDirectories`: additional directory names to exclude from recursive discovery.
  Explicitly requested paths remain available.
- `diagnosticsSettleMs`: positive number of milliseconds without another push-diagnostics publication before using the latest result.
  Defaults to `800`; the built-in intelephense route uses `4000`.
  The global timeout remains the upper bound.
- `pushDiagnosticsGraceMs`: positive number of milliseconds to wait for the first publication from a push-only server.
  It is unset by default, so a silent push-only server waits for the global timeout.
  The built-in Lua and Haskell routes use `3000`; Dart, Terraform, Gleam, and Tinymist use `2000`.
  This lets clean files finish after bounded silence without returning before a late error publication.
- `pullDiagnosticsGraceMs`: positive number of milliseconds to wait for a newer push publication after a server returns an empty pull-diagnostics result.
  It is unset by default; the built-in rust-analyzer route uses `5000` because initial workspace analysis can finish after an early empty pull response.

Global options:

- `timeout`: request timeout in milliseconds.
  Defaults to `20000`.

pi-lsp infers `languageId` from common extensions and falls back to the extension without the leading dot.

For example, run the configured Ruff server through the project's uv environment without shell-string parsing:

```json
{
  "servers": {
    "ruff": {
      "command": ["uv", "run", "--no-sync", "ruff", "server"],
      "extensions": [".py", ".pyi"]
    }
  }
}
```
