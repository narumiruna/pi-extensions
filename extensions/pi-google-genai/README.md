# 🔎 pi-google-genai — Google GenAI grounding tools for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-google-genai)](https://www.npmjs.com/package/@narumitw/pi-google-genai) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-google-genai` exposes Google GenAI Interactions grounding tools to Pi.

## ✨ Features

- `google_search` for Google Search grounding.
- `google_maps` for Google Maps/place grounding.
- `google_url_context` for asking about specific `http://` or `https://` URLs.
- Uses Pi auth for Google (`/login google`, `auth.json`, runtime key, or `GEMINI_API_KEY`) unless `pi-google-genai.json` contains a literal `apiKey`.
- Lets `/google-genai tools` persist which of the three tools are active.
- Truncates large outputs and writes the full raw interaction response to a private temp file only when truncation happens.

## 📦 Install

```bash
pi install npm:@narumitw/pi-google-genai
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-google-genai
```

Try from this repository:

```bash
pi -e ./extensions/pi-google-genai
```

## ⚙️ Configuration

Config lives at:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-google-genai.json
```

Example:

```json
{
  "apiKey": "YOUR_GOOGLE_API_KEY",
  "model": "gemini-3.5-flash",
  "apiUrl": "https://generativelanguage.googleapis.com/v1beta/interactions",
  "timeoutMs": 60000,
  "tools": ["google_search", "google_maps", "google_url_context"]
}
```

The file is written as `0600`.

Compatibility: a valid legacy `google-genai.json` is migrated automatically to `pi-google-genai.json` while preserving private permissions. If both files exist, the new filename takes precedence.

Timeout precedence is: per-call `timeoutMs` parameter, `pi-google-genai.json` `timeoutMs`, then
the 60000ms default. Timeout values must be integer milliseconds from 1 to 2147483647.

### 🔐 Auth precedence

1. Literal `apiKey` in `pi-google-genai.json`.
2. Pi Google auth via `/login google`, `auth.json`, runtime key, or `GEMINI_API_KEY`.
3. Missing-auth tool error.

`apiKey` in this config is literal only. `$GEMINI_API_KEY`, `${GEMINI_API_KEY}`, and `!command` are not resolved here. Use Pi `/login google` or `GEMINI_API_KEY` for that behavior.

## 💬 Command

```text
/google-genai init
/google-genai status
/google-genai config
/google-genai help
/google-genai tools
/google-genai enable
/google-genai disable
```

- `init`: interactively creates or updates config. API key may be blank; blank keeps an existing key or uses Pi auth fallback.
- `status` / `config`: shows config path, model, API URL, timeout, auth source, and enabled tools. It never prints the key.
- `tools`: select which Google GenAI tools are active and persist the selection.
- `enable`: enable all three tools.
- `disable`: disable all three tools. The slash command remains available so you can re-enable them.

## 🛠️ Tools

### 🔎 `google_search`

Search Google through Gemini grounding.

Parameters:

- `query`: search question.
- `searchTypes?`: optional array of `web_search` and/or `image_search`. Omit it for Google's default web search.
- `timeoutMs?`: per-call timeout in milliseconds.

#### Large / broad searches

Very broad market-research, comparison, review, or search-result synthesis queries can time out. A
timeout error means the request exceeded the configured duration; it is not a “no results found”
response. Prefer several narrow searches over one big query, or raise config `timeoutMs` or
per-call `timeoutMs` when a broader call is genuinely needed.

Instead of:

```text
2026 AI coding assistant product trends agentic coding IDE local first developer tools web UI Cursor Claude Code GitHub Copilot
```

Try:

```text
Cursor AI coding features 2026
Claude Code features agentic coding
GitHub Copilot coding agent features 2026
AI coding assistant trends 2025 2026
local first AI developer tools trends
```

### 🗺️ `google_maps`

Ask Google Maps-grounded questions.

Parameters:

- `query`: maps/place question.
- `latitude?` and `longitude?`: optional pair for location-sensitive questions. If one is set, both are required. Latitude must be `-90..90`; longitude must be `-180..180`.
- `timeoutMs?`: per-call timeout in milliseconds.

### 🔗 `google_url_context`

Ask Gemini to use specific URLs as context.

Parameters:

- `prompt`: question or instruction.
- `urls`: one or more `http://` or `https://` URLs.
- `timeoutMs?`: per-call timeout in milliseconds.

Use Firecrawl instead when you need raw HTML/markdown extraction, crawling, or URL discovery.

## 🧪 Manual live smoke test

Automated tests mock Google. Before publishing, you can manually try:

```bash
export GEMINI_API_KEY=your-key
pi -e ./extensions/pi-google-genai
```

Then ask Pi to use:

```text
Use google_search to answer: Who won Euro 2024?
Use google_maps to find Italian restaurants near latitude 34.050481 longitude -118.248526.
Use google_url_context to summarize https://ai.google.dev/gemini-api/docs/interactions.
```

## 🪶 Why no `@google/genai` dependency yet?

The first version only needs one POST to the Interactions API, so native `fetch` is enough. Add `@google/genai` later when the extension needs SDK-heavy features such as file upload, live sessions, Vertex/Enterprise auth, batch/video operations, or file-search store management.

## 📁 Package layout

```txt
extensions/pi-google-genai/
├── src/
│   ├── index.ts         # Pi package entrypoint
│   ├── google-genai.ts  # Extension registration and command orchestration
│   └── *.ts             # Package-local config, client, response, and tool modules
├── test/google-genai.test.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

`index.ts` is the Pi entrypoint and forwards to `google-genai.ts`; the other source modules are internal.

## 🏷️ Keywords

`pi-package`, `pi-extension`, `google`, `gemini`, `genai`, `search`, `maps`

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
