# 🔎 pi-web-search — Web Search through Cloudflare

[![npm](https://img.shields.io/npm/v/@narumitw/pi-web-search)](https://www.npmjs.com/package/@narumitw/pi-web-search) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Search current web information through Cloudflare AI Gateway and Ceramic.ai, with structured results available to Codemode scripts.

> Cloudflare Web Search API is beta. Searches send your query to external services and may incur charges. Search results are untrusted source data, not instructions.

## ✨ Features

- Ordered web results with URLs, titles, descriptions, and available request metadata.
- Script-first tool exposure, configurable independently of Pi's Codemode settings.
- User-owned JSON settings with private credentials and atomic saves.
- Cancellable requests, configurable deadlines, and bounded output.

## 📦 Install

Install permanently:

```bash
pi install npm:@narumitw/pi-web-search
```

Try without permanent installation:

```bash
pi -e npm:@narumitw/pi-web-search
```

Load a local checkout from the repository root; no generated-runtime build is required:

```bash
npm install
pi -e ./packages/pi-web-search
```

Extensions run with Pi's operating-system permissions; install only trusted packages.
You need a Cloudflare account, an AI Gateway, and credits or a provider key stored on that gateway.
Create a Cloudflare API token with **Account > Workers AI > Read** and **Account > AI Gateway > Read** permissions.

## 🚀 Quick start

Create `<getAgentDir()>/pi-web-search.json`, normally `~/.pi/agent/pi-web-search.json`, with private permissions (`0600` on POSIX):

```json
{
  "accountId": "YOUR_32_CHARACTER_CLOUDFLARE_ACCOUNT_ID",
  "apiToken": "YOUR_CLOUDFLARE_API_TOKEN"
}
```

Edit credentials locally, not through a model prompt. The settings UI never echoes or accepts an API token because Pi's built-in input dialog does not mask passwords.

Separately, enable the built-in Codemode tool in Pi's `settings.json`:

```json
{
  "defaultTools": ["+codemode"]
}
```

Restart Pi or run `/reload`, then ask it to search the web for current information.
A Codemode script can call:

```js
const result = await tools.web_search({ query: "Cloudflare Web Search API" });
return result.items;
```

## 💬 Commands

`/web-search` opens Settings, Status, and Help in TUI mode and accepts no arguments.
Settings edits save and apply immediately; closing the screen does not undo committed changes.
API tokens are managed only in the private JSON file; the menu shows credential presence, never the token.
RPC mode reports status, help, and the manual settings path through a notification.
JSON mode emits the same information as a custom-message event without making a model request or opening a custom TUI.
Text print mode rejects through Pi's extension-error channel with status and manual setup instructions; Pi controls the process exit status.

## 🛠️ Tools

`web_search` takes a required nonblank `query` (maximum 1,024 Unicode code points) and an optional integer `limit` (1–10).
It uses the saved default limit when omitted.
Results contain `provider: "ceramic"`, ordered `items` with URLs and optional titles/descriptions, `metadata` with the query and available request ID/latency, and a `truncated` flag.
Codemode receives this object directly through Pi's structured result contract.

Failures are tool errors, not success-shaped error messages.
Cancellation, session replacement, shutdown, or the configured deadline stop unfinished network requests.
Text output stays within Pi's 50 KB/2,000-line limits and includes a notice if rendered text is omitted.
Titleless results display their URL once; the structured `truncated` flag describes bounded structured fields/items independently of any rendered-text notice.
Structured title and description fields are bounded, and URLs must be HTTP(S).
The extension does not fetch result pages, synthesize answers, retry failed requests, switch providers, or fall back to another billing source.

## 🧠 Skills

The bundled [pi-web-search-setup skill](./skills/pi-web-search-setup/SKILL.md) is manual-only.
Run `/skill:pi-web-search-setup` to get Cloudflare setup guidance or request changes to `pi-web-search.json`, for example `/skill:pi-web-search-setup set limit to 3`.
Pi excludes it from automatic model selection; ordinary searches and search failures do not activate it.
Agent-assisted edits preserve existing credentials and unknown fields through the package settings store without displaying the raw file.
Insert or replace API tokens locally, never in a prompt; live searches and billing changes require separate approval.

## ⚙️ Settings

All extension settings are stored in one canonical user file:

```text
<getAgentDir()>/pi-web-search.json
```

`getAgentDir()` honors Pi's agent-directory configuration, including custom directories.
There are no project overrides or extension-specific environment aliases; effective values are code defaults followed by explicit user fields.
Edit preferences through `/web-search` or edit JSON manually and run `/reload`.
Manual edits are also loaded on session start/replacement.

| Field | Default | Accepted values |
| --- | --- | --- |
| `accountId` | Empty; required for searches | 32 hexadecimal characters, or empty while unconfigured |
| `apiToken` | Empty; required for searches | Printable ASCII without whitespace, maximum 4,096 characters; manual file editing only |
| `gatewayId` | `default` | 1–64 letters, digits, underscores, or hyphens |
| `exposure` | `codemode` | `codemode`, `direct`, `deferred`, `model-only`, `hidden` |
| `limit` | `5` | Integer 1–10 |
| `timeoutMs` | `30000` | Integer 1,000–120,000; UI offers common deadlines |
| `byokAlias` | Unset/empty | 1–64 letters, digits, underscores, or hyphens, or empty |

Exposure controls tool visibility, not authorization:

- `codemode`: callable from scripts without a direct model declaration; inline listing is subject to Pi's description budget.
- `direct`: declared while active and callable from scripts while active.
- `deferred`: callable from scripts and discoverable, but not listed inline by Codemode; this extension does not automatically activate it.
- `model-only`: declared while active, never callable from scripts.
- `hidden`: not declared or callable.

Explicit Pi activation can directly declare `codemode`/`deferred` tools.
Choosing a different exposure in this extension's Settings explicitly resets its own declaration to that exposure's default and leaves other tools alone.
This is an intentional model-visible prefix transition, not ordinary-turn lazy loading; subsequent ordinary turns keep the tool definition and prompt prefix stable.
`/reload` reapplies the configured indirect (`codemode`, `deferred`, or `hidden`) exposure as inactive, including after explicit Pi activation; unchanged non-reload session switches preserve explicit activation.
The extension does not automatically enable Codemode or `tool_search`.

Missing-file reads do not create files or directories.
An explicit preference save creates the file, patches only changed fields in the latest valid document, and preserves unknown fields.
On POSIX, missing parent directories created by that save receive exact private `0700` permissions independently of umask; existing directory permissions are never changed.
A malformed, invalid, oversized, symlinked, nonregular, or insecure file blocks saves and searches until repaired.
Settings files are limited to 64 KB and require `0600` permissions on POSIX.
Writes use a private same-directory temporary file followed by rename, with ordered in-process saves, failure rollback, and temporary-file cleanup.
If runtime exposure application fails, edited preferences are restored from the latest valid document and unrelated external changes become effective.
Recovery never changes an exposure mid-run; if disk or runtime recovery fails, searches stop until you repair the file and run `/reload`.
Separate Pi processes are not protected against concurrent edits; avoid editing the same file from multiple processes.
A save already committed by rename remains saved even if the UI closes immediately afterward.

## 🔒 Security and privacy

The extension stores your Cloudflare token only in the canonical user settings file and sends it only in the Cloudflare authorization header.
Tokens never appear in status, notifications, search output, or session details.
Do not put this file into source control, project settings, or model prompts.

Cloudflare receives the query and routes it to Ceramic.ai through AI Gateway.
Requests appear in gateway logs, subject to your gateway configuration; provider retention terms do not imply that gateway logging is disabled.
Consult the [Cloudflare provider documentation](https://developers.cloudflare.com/web-search/providers/) and your own data-handling requirements before searching confidential information.

With an explicit `byokAlias`, Cloudflare uses that stored provider key and rejects missing configuration rather than falling back to credits.
Without an alias, Cloudflare uses the provider's gateway key named `default` if available; otherwise it bills AI Gateway credits.
See [Cloudflare's BYOK behavior](https://developers.cloudflare.com/web-search/how-to-use/#bring-your-own-key-byok).
This package does not store underlying search-provider keys or promise a fixed search price.

VT, C0/C1, and Unicode directional formatting controls are removed at display boundaries before wrapping; legitimate Unicode joiners remain intact.
Bounded structured result fields and requests retain raw source text except for credential redaction in returned fields.
URLs and snippets are untrusted and must not be treated as agent instructions.

## 🚧 Limitations

Only Cloudflare REST Web Search API with Ceramic.ai is supported; there is no provider selection, fan-out, automatic fallback, crawler, or persistent result cache.
The API is beta and external account permissions, gateway availability, credits, provider terms, and pricing may change.
The settings screen is TUI-only; other modes provide manual instructions.

## 🗂️ Package layout

```text
packages/pi-web-search/
├── src/
│   ├── index.ts          # Source entrypoint forwarder
│   ├── web-search.ts     # Tool, command, exposure and lifecycle ownership
│   ├── settings.ts       # Validation and private atomic persistence
│   ├── settings-ui.ts    # Pi SettingsList and input submenus
│   └── client.ts         # Cloudflare requests and bounded result formatting
├── skills/               # Manual-only setup and safe settings-editing skill
├── test/                 # Storage, client, UI, lifecycle and Pi runtime tests
├── package.json
├── tsconfig.json
├── README.md
└── LICENSE
```

The published extension loads source TypeScript through Pi's Jiti loader.

## 🔎 Keywords

Pi extension, web search, Cloudflare, AI Gateway, Ceramic.ai, Codemode, structured tools.

## 📄 License

MIT. See [LICENSE](./LICENSE).
