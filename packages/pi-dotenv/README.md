# 🌱 pi-dotenv — Load an Explicit Environment File for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-dotenv)](https://www.npmjs.com/package/@narumitw/pi-dotenv) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Load missing process environment variables from one explicitly selected dotenv file while Pi starts.
The early factory-time load makes provider credentials available to Pi's post-extension model availability refresh.

## ✨ Features

- Adds `--env-file <path>` without implicitly reading `.env`.
- Supports standard dotenv comments, quoting, multiline values, and empty values.
- Loads before Pi's post-extension provider availability refresh in normal CLI startup.
- Preserves every variable already inherited from the launching environment.
- Keeps secret values out of extension output, Pi messages, tools, and session data.

## 📦 Install

Install the extension permanently:

```bash
pi install npm:@narumitw/pi-dotenv
```

Try it without installing permanently:

```bash
pi -e npm:@narumitw/pi-dotenv --env-file .env
```

Try this package locally from the repository root:

```bash
pi -e ./packages/pi-dotenv --env-file .env
```

Pi extensions run with the Pi process's user permissions, so install only trusted packages.
The selected file may contain credentials that become available to Pi, every loaded extension, and inherited subprocesses.

## 🚀 Quick start

Create a dotenv file:

```dotenv
OPENAI_API_KEY=sk-example
PI_CACHE_RETENTION=long
```

Then start Pi after installing the extension:

```bash
pi --env-file .env --provider openai --model gpt-5.4
```

A value exported by the launching shell takes precedence over the file:

```bash
OPENAI_API_KEY=from-shell pi --env-file .env
```

Relative paths resolve from the directory where Pi was launched.
Use `--env-file=<path>` when a path begins with `-`; the last occurrence before the `--` argument terminator wins.

## 🏁 CLI flag

```text
--env-file <path>  Load missing environment variables from a dotenv file
```

The flag is supported by normal interactive, print, JSON, and RPC startup.
A valid, readable file also affects `--help` and `--list-models` paths that load extensions, but current Pi metadata paths can exit without reporting extension-load diagnostics, so do not use them to validate the file.
Normal startup reports a missing or unreadable file as an extension-load failure without printing its contents or parsed values.

Loading is process-wide and lasts until Pi exits.
`/reload` reads the selected file again but does not replace values already loaded into the process, so restart Pi after changing a value.

## ⏱️ Startup timing

These limits apply when the runtime passes `--env-file` to Pi unchanged.
Some Node.js versions process this option themselves before Pi starts; on those launches, Node's dotenv parser and earlier timing apply, and pi-dotenv preserves the values Node already loaded.
Use a pre-launch tool when behavior must be consistent across runtimes.

Current Pi help lists 42 provider or cloud variables and 6 Pi configuration variables.
Pi's environment-variable documentation lists another 11 process configuration variables omitted from help.
Of these 59 variables, a factory-time dotenv load can affect 55 before their relevant post-extension use, subject to provider and Pi setting precedence.

The 13 late-read Pi variables are:

```text
PI_SKIP_VERSION_CHECK
PI_TELEMETRY
PI_CACHE_RETENTION
PI_SHARE_VIEWER_URL
PI_HARDWARE_CURSOR
PI_HYPERLINKS
PI_IMAGE_PROTOCOL
PI_TRUE_COLOR
PI_TUI_ESC_TIMEOUT
VISUAL
EDITOR
HTTP_PROXY
HTTPS_PROXY
```

Terminal settings override the corresponding capability environment variables.
A startup selector may also initialize Pi's terminal capability cache before extensions load, so `PI_HYPERLINKS`, `PI_IMAGE_PROTOCOL`, and `PI_TRUE_COLOR` are not guaranteed to change an already initialized interface.

`PI_OFFLINE` is only partially effective because Pi captures its main offline mode and model-network state before extension discovery.
The following variables are too late to configure the current runtime correctly:

```text
PI_CODING_AGENT_DIR
PI_CODING_AGENT_SESSION_DIR
PI_PACKAGE_DIR
```

Set those variables before launching Pi instead.
For complete pre-launch dotenv behavior, use a launcher such as:

```bash
dotenvx run -f .env -- pi
```

## 🔒 Security and privacy

pi-dotenv reads only the file explicitly passed through `--env-file` and does not perform network requests.
It does not log, render, persist, or send parsed values to the model.

The values still become part of `process.env`.
Pi extensions and commands spawned by Pi can read inherited variables, so use only trusted extensions and tools when loading credentials.
Existing process variables are never overwritten, which also preserves Pi's process markers.
Pi continues to inject its own session metadata into supported shell tools.

## 🚧 Limitations

- Pi applies registered extension flag values after extension factories finish, so pi-dotenv reparses the raw CLI arguments with Pi's exported parser during factory loading instead of calling `pi.getFlag()` there.
- Provider discovery depends on Pi's current post-extension offline refresh sequence; compatibility tests cover that sequence for the supported Pi runtime.
- `pi auth`, `pi install`, `pi remove`, `pi uninstall`, `pi update`, `pi list`, `pi config`, `--version`, and `--export` finish or branch before normal extension loading and cannot use this flag.
- The extension loads one file and does not expand values such as `${OTHER_VARIABLE}`.
- Use a pre-launch dotenv tool when every Pi startup stage must observe the file.

## 🗂️ Package layout

```text
packages/pi-dotenv/
├── src/
│   ├── index.ts        # Thin Pi entrypoint
│   └── dotenv.ts       # CLI resolution and environment loading
├── test/               # Argument, lifecycle, failure, and provider-refresh tests
├── package.json
├── README.md
└── LICENSE
```

The package publishes its TypeScript source entrypoint for Pi's Jiti runtime and needs no build step.

## 🔎 Keywords

Pi extension, Pi coding agent, dotenv, environment variables, provider credentials, API keys, startup configuration.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
