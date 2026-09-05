# 🚀 pi-starship — Build Pi's Footer with Starship-style TOML

[![npm](https://img.shields.io/npm/v/@narumitw/pi-starship)](https://www.npmjs.com/package/@narumitw/pi-starship) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Build a customizable Pi footer with Starship-style TOML, native Pi modules, conditional formats, palettes, and responsive multiline layout.
The extension parses and renders the footer itself, so it does not need the `starship` executable or a shell prompt.

> **Different package:** The unscoped npm package `pi-starship` delegates to the Starship binary.
> This package is `@narumitw/pi-starship` and renders Pi-specific modules natively.

## ✨ Features

- Starts with a readable built-in footer and offers Starship presets plus a Pi-native Minimal preset.
- Supports root and module formats, conditional groups, `$all`, styles, palettes, and width-aware `$fill` alignment.
- Provides Pi, model, usage, Git, pull request, package, language, environment, deployment, cloud, and execution modules.
- Wraps native multiline layouts to terminal width instead of truncating them.
- Keeps rendering pure while refreshing filesystem, process, and network-derived data through bounded caches.
- Uses `/starship` for presets, preview, configuration health, searchable module details, customization, and recovery.
- Bundles the authoritative configuration skill and references for editing `pi-starship.toml` or answering setup questions.
- Loads a generated split runtime to reduce Pi package startup work.

## 📦 Install

```bash
pi install npm:@narumitw/pi-starship
```

Try the published package without installing it permanently:

```bash
pi -e npm:@narumitw/pi-starship
```

Build the generated runtime and try the local package from this repository:

```bash
npm --workspace @narumitw/pi-starship run build
pi -e ./packages/pi-starship
```

The package declares `dist/index.ts`, so build an unbuilt local checkout before Pi loads the package directory.
Install only from sources you trust because Pi extensions and skills run with Pi's permissions.
Do not enable this with `@narumitw/pi-statusline`: both own Pi's footer, and Pi does not arbitrate that conflict.

## 🚀 Quick start

Start Pi with the extension to use the built-in footer without creating a settings file.
Run `/starship` to inspect the footer, choose a preset, or customize the configuration.

The bundled configuration skill is manual-only and is not available for automatic model invocation.
Run `/skill:configuring-pi-starship` before asking Pi to explain or edit `pi-starship.toml`:

```text
/skill:configuring-pi-starship explain the aws module
/skill:configuring-pi-starship enable the directory and git_branch modules
```

The skill loads the relevant reference and validates file edits.
It does not cover general TOML, shell Starship configuration, extension source development, or unrelated footer work.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/starship` | Open the current-state menu in TUI mode; show help in RPC |
| `/starship settings` | Edit, preview, and confirm TOML in TUI; show the file path in RPC |
| `/starship status` | Show the configuration source, path, and diagnostics in TUI or RPC |
| `/starship help` | Show command and configuration help in TUI or RPC |

The main menu keeps seven actions on one level: **Customize footer**, **Presets**, **Explain footer**, **Modules**, **Configuration**, **Help**, and **Restore built-in…**.
It shows the current source and configuration health.
Presets, Explain, Modules, and Configuration are menu-only; they do not add textual subcommands.
Restore is unavailable when there is no document to replace.

The TOML editor, live footer previews, Explain view, module inspector, and configuration reviews use specialized TUI screens.
Their content and key hints adapt to terminal width and Pi's configured keybindings.
Escape returns to the previous screen, while Ctrl+C closes the workflow.
Direct routes reject trailing arguments.
Print and JSON modes produce no ad hoc output, and footer lifecycle work runs only in TUI mode.

## ⚙️ Settings

The package bundles the `configuring-pi-starship` skill as the authoritative configuration guide for users and agents.
Invoke `/skill:configuring-pi-starship` before asking Pi how to configure the footer or edit `pi-starship.toml`.
The skill answers from its references and consults the bundled source only when the public documentation does not cover a question.

Read the references directly when preferred:

- [Configuration and format](./skills/configuring-pi-starship/references/configuration.md) — settings schema, validation and fallback behavior, presets, examples, format grammar, styles, palettes, and display thresholds.
- [Complete module catalog](./skills/configuring-pi-starship/references/module-catalog.md) — exact variables, default formats, symbols, enabled state, style fields, display defaults, option types, ranges, and enum values.
- [Module behavior](./skills/configuring-pi-starship/references/modules.md) — reachability, exact detection defaults, command gates, output semantics, aliases, truncation, and module-specific behavior.
- [Runtime and security](./skills/configuring-pi-starship/references/runtime-and-security.md) — network and command execution, local metadata, cloud and deployment context, fill layout, refresh behavior, and limitations.

The only configuration source remains `<getAgentDir()>/pi-starship.toml`.
A minimal custom document can select and style only the modules it needs:

```toml
format = "$model$directory$git_branch"

[model]
style = "bold blue"
```

Use `/starship` for interactive configuration, preview, diagnostics, presets, and recovery.
Manual file edits load at the next `session_start`, including `/reload`.

## 🔒 Security and privacy

Some opt-in modules read local development, deployment, cloud, host, or user metadata, run bounded local commands, or query GitHub through `gh`.
Review [Runtime and security](./skills/configuring-pi-starship/references/runtime-and-security.md) before enabling them.

## 🚧 Limitations

pi-starship is Starship-inspired rather than fully compatible with shell Starship.
The complete supported and intentionally omitted behavior is documented in [Runtime and security](./skills/configuring-pi-starship/references/runtime-and-security.md).

## ➕ Adding a module

Create `src/modules/<name>.ts` with its format variables, defaults, and runtime value resolver, then register it in display order in `src/modules/catalog.ts`.
Configuration names, validation variables, defaults, and `$all` ordering are derived from that catalog.
Add the module to the built-in root format only when it should be visible by default, then document and test its user-facing values.
Keep `extension_status` last in the catalog so arbitrary third-party statuses follow native module output.

## 🗂️ Package layout

```text
packages/pi-starship/
├── src/                               # Modules, formats, presets, and runtime collectors
│   ├── index.ts                       # Thin Pi entrypoint
│   └── pi-starship.ts                 # Footer lifecycle and cached refresh
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
├── skills/configuring-pi-starship/    # Authoritative configuration skill and references
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi Coding Agent, Starship statusline, Starship TOML, terminal footer, native statusline, configuration editing, agent skill, GitHub pull request, prompt cache, cache hit rate, Pi extension

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
Starship attribution and its ISC license are included in [`NOTICES.md`](./NOTICES.md).
