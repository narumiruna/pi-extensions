# 🗄️ pi-agentfs — AgentFS Workspaces for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-agentfs)](https://www.npmjs.com/package/@narumitw/pi-agentfs) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Pi AgentFS replaces Pi's `read`, `write`, `edit`, and `bash` tools with tools that share one AgentFS database.
Use it when a trusted service selects a virtual file workspace for a session.

**This is not an operating-system sandbox.** Extensions run with all permissions of the Pi process.
The service must authorize database access and control other tools, resources, attachments, and conversation history.

## ✨ Features

- Persistent virtual files shared by text tools and a restricted `just-bash` interpreter.
- Explicit database selection through CLI/RPC startup or an SDK extension factory.
- Session-owned connections, ordered operations, and failure paths without host-tool fallback.

## 📦 Install

Requires Node.js `>=22.19.0` and a compatible Pi runtime.
Runtime dependency versions and the Node.js minimum are declared in [package.json](./package.json).

The npm name, publication permissions, and trusted publishing setup are not yet verified. Use the local checkout until a published release is available.
After publication, persistent installation and temporary execution use:

```bash
pi install npm:@narumitw/pi-agentfs
pi -e npm:@narumitw/pi-agentfs
```

From a local repository checkout:

```bash
npm install
npm run build
pi --no-extensions -e ./packages/pi-agentfs
```

The root build prepares Kit before its consumers. Run it before local extension loading or the SDK example.
Pi loads the source entrypoint. SDK imports use built JavaScript.

Only install trusted code. The restricted tool interface does not remove the extension's process permissions.

## 🚀 Quick start

Have the operator create and secure `/srv/agentfs` first, then authorize `/srv/agentfs/alice.db` for this session.
AgentFS can initialize a new database at that approved path; this package does not create host parent directories.

For a local checkout, start Pi with only this extension and the four workspace tools:

```bash
pi --no-extensions -e ./packages/pi-agentfs \
  --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve \
  --no-session --tools read,write,edit,bash \
  --agentfs-path /srv/agentfs/alice.db
```

Ask Pi to write `hello` to `/notes/hello.txt`, then read it with `read` or `bash` using `cat /notes/hello.txt`.
`/notes/hello.txt` is inside the database, not on the host.

This CLI example limits common discovery paths, not all host access.
In particular, Pi can still load personal system-prompt files and credentials; `--no-context-files` does not disable `SYSTEM.md` or `APPEND_SYSTEM.md`.
Use controlled service configuration as described in [Integration](./docs/integration.md), not this command as a multi-user security boundary.

## 🛠️ Tools

| Tool | Behavior |
| --- | --- |
| `read` | Reads text with one-based `offset` and optional line `limit`; output uses Pi's truncation helpers. No image support. |
| `write` | Creates or overwrites a virtual file and creates required virtual parent directories. |
| `edit` | Uses Pi's exact text replacement and diff behavior with AgentFS operations. |
| `bash` | Runs the allowed virtual shell commands through `just-bash`, not a host shell. |

File-tool relative paths start at `/`. Absolute paths also refer to the virtual root.
`~` and `~/` refer to that root, not the host home directory; named home directories and links are unsupported.
There are no additional slash commands or standalone search tools.
Tool views omit host-file links and speculative edit previews; completed edit diffs remain available.

## ⚙️ Settings

The extension has no settings file or extension-specific environment variables.
Enable it with `--agentfs-path <absolute-database-path>` at CLI/RPC startup, or pass `{ path }` to `createAgentfsExtension()` in the SDK.
The path is fixed for that extension runtime; tools cannot change it.

Without the CLI flag, the extension stays disabled and leaves ordinary Pi tools unchanged.
An explicitly invalid path is not disabled mode: requested workspace tools reject operations during loading, after initialization failure, or after closure. They never switch to host tools.
SDK callers must check loader errors, `onError`, and `await extension.ready(session.sessionManager)` after `bindExtensions()` before admitting requests.
See [SDK startup and shutdown](./docs/integration.md#sdk-startup-and-shutdown) and the runnable [service example](./examples/service.ts).

## 🔒 Security and privacy

Only the trusted operator or service supplies the host database path. A model-supplied path is a virtual file path, never a database selector.
Database authorization, host directory permissions, backups, encryption, retention, and user-to-workspace mapping belong to the service.
AgentFS files persist in the selected database; Pi conversation history is separate and is not automatically stored there.

When workspace mode is requested, `!` and `!!` are explicitly blocked. Use the model-facing `bash` tool instead.
Do not expose SDK `session.executeBash()` to untrusted requests: that direct API bypasses the `user_bash` hook and can execute on the host.
Other extensions, MCP tools, native file/search tools, host attachments, and session import/export routes can also bypass the four-tool interface.

The shell does not receive `process.env`, service secrets, network commands, or arbitrary program executors.
This restriction applies to the workspace tools, not to the surrounding Pi process.
Review dependency advisories and deployment controls before production use; a command allowlist is not a security audit of every installed dependency.
See [Dependency security](./docs/dependency-security.md) for repository dependency overrides and their scope.

## 🚧 Limitations

`bash` is a limited interpreter, not GNU Bash or a Linux environment. Each call starts at `/` with a fresh shell environment.
`cd`, `export`, shell functions, and variables do not persist between calls; file changes do.
Unsupported commands fail without a native-shell fallback. See the exact [shell contract and bounds](./docs/integration.md#shell-contract-and-bounds).

All four tools serialize complete operations within one session workspace. This does not coordinate multiple processes or separate owners of the same database.
Use one owner per database; simultaneous same-database sessions and cross-process access are not supported.
Cancellation and failure do not roll back file changes that already completed.

Real service deployment and end-to-end multi-user isolation remain unverified.
The [service handoff](./docs/integration.md#deployment-and-publication-handoff) lists the remaining responsibilities.

## 🗂️ Package layout

- `src/index.ts`: thin Pi source entrypoint.
- `src/factory.ts`: SDK factory, readiness barrier, and session lifecycle.
- `src/workspace.ts`, `src/tools.ts`, `src/paths.ts`: shared database ownership, tool implementations, and virtual paths.
- `dist/`: built JavaScript and declarations for SDK imports; generated by the package build.
- `docs/integration.md`, `examples/service.ts`: service contract and no-model startup example.

The package publishes source for Pi and built output for the SDK, plus its documentation, example, and license.

## 🔎 Keywords

Pi extension, AgentFS, virtual filesystem, workspace, just-bash, SDK integration.

## 📄 License

[MIT](./LICENSE).
