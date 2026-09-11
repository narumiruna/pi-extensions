# 🔍 pi-youcom: You.com Web Search for Pi

[![npm scope](https://img.shields.io/badge/npm-@narumitw-blue)](https://www.npmjs.com/package/@narumitw/pi-youcom)
[![Pi extension](https://img.shields.io/badge/pi-extension-purple)](https://pi.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Pi extension that exposes You.com web search and page reading tools to the
model. Search works without any API key through You.com's keyless endpoint;
setting an API key enables page content extraction.

## ✨ Features

- Current web search through the You.com MCP server with ranked results, URLs,
  snippets, and query-relevant passages.
- Keyless operation by default: no account or API key is required for search.
- Optional page content extraction when a You.com API key is configured.
- Bounded tool output with complete truncated responses saved to a temporary
  file, following Pi's output limits.

## 📦 Install

Install the extension permanently:

```bash
pi install npm:@narumitw/pi-youcom
```

Try it without adding it permanently:

```bash
pi -e npm:@narumitw/pi-youcom
```

From a local checkout of this repository, Pi can also load
`packages/pi-youcom/src/index.ts` directly through the root manifest.

> [!IMPORTANT]
> Pi extensions run with your full user permissions. Review this extension
> before installing it from any third party.

## 🚀 Quick start

1. Install the extension.
2. Ask Pi something that needs current web information, for example:
   "Search the web for the latest Node.js LTS release schedule."

No configuration is required for search. To enable page reading, set
`YDC_API_KEY` from [you.com/platform/api-keys](https://you.com/platform/api-keys)
in your shell or Pi environment.

## 🛠️ Tools

| Tool | Purpose | Prerequisite |
| --- | --- | --- |
| `youcom_search` | Search the web for current information and return ranked results with URLs, snippets, and passages. | None. |
| `youcom_contents` | Read a web page and return extracted page content. | `YDC_API_KEY`. |

## ⚙️ Settings

The extension is configured through environment variables only; it owns no
settings file.

| Variable | Purpose |
| --- | --- |
| `YDC_API_KEY` | Optional You.com API key. When set, requests use the authenticated endpoint and `youcom_contents` becomes available. |
| `YOUCOM_MCP_URL` | Optional override for the You.com MCP endpoint URL, for testing or an alternate server. |

Without `YDC_API_KEY`, the extension uses the keyless free profile of the
You.com MCP endpoint, which exposes `youcom_search` only.

## 🔒 Security and privacy

Search queries and page URLs are sent to You.com's hosted MCP endpoint, and
results are external data. The extension does not store queries or results on
disk beyond temporary truncated-response artifacts, which are removed at
session shutdown. An API key is passed only as an Authorization header to the
configured You.com endpoint.

## 🚧 Limitations

- The keyless free profile exposes search only; page reading requires an API key.
- The You.com MCP server uses the streamable-HTTP transport; a session id
  issued by the server is not persisted, so each tool call is an independent
  JSON-RPC request.

## 🗂️ Package layout

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Source forwarder for the extension entrypoint. |
| `src/youcom.ts` | Extension factory: tool registration and session lifecycle. |
| `src/tools.ts` | Model-facing tool definitions for search and page reading. |
| `src/client.ts` | You.com MCP streamable-HTTP client with SSE response parsing. |
| `src/response-format.ts` | Bounded output formatting and temporary response artifacts. |
| `src/tool-names.ts` | Tool name constants. |

## 🔎 Keywords

pi-package, pi-extension, you.com, web search, mcp, search

## 📄 License

MIT, see [LICENSE](./LICENSE).
