## Goal

Add a new `@narumitw/pi-google-genai` Pi extension package that exposes Google GenAI grounding through three LLM tools: `google_search`, `google_maps`, and `google_url_context`. Success means the tools call the Gemini Interactions API with `~/.pi/agent/google-genai.json` config or Pi's built-in Google auth, return compact answer text with sources plus normalized details, are documented, tested without live network calls, and pass repository checks.

## Context

The extension is one package with three tools, not three packages. The tools share the same Gemini Interactions endpoint, API key resolution, model setting, fetch helper, response parser, truncation, source formatting, and error handling.

Configuration is user-level at `${PI_CODING_AGENT_DIR:-~/.pi/agent}/google-genai.json` and is always written with `0600` permissions:

```json
{
	"apiKey": "YOUR_GOOGLE_API_KEY",
	"model": "gemini-3.5-flash",
	"apiUrl": "https://generativelanguage.googleapis.com/v1beta/interactions",
	"timeoutMs": 30000,
	"tools": ["google_search", "google_maps", "google_url_context"]
}
```

Auth precedence is config literal `apiKey` first, then Pi auth for provider `google` through `/login google`, `auth.json`, runtime key, or `GEMINI_API_KEY`, then a clear missing-auth error. Config `apiKey` is literal only for the first version; `$GEMINI_API_KEY`, `${GEMINI_API_KEY}`, `!command`, and Pi's internal `resolveConfigValue` syntax are intentionally out of scope.

## Architecture

- Create `extensions/pi-google-genai` with the standard package layout: `src/google-genai.ts`, `test/google-genai.test.ts`, `package.json`, `tsconfig.json`, `README.md`, and `LICENSE`.
- Register exactly three tools:
  - `google_search`: accepts `query` and optional `searchTypes` limited to `web_search` and `image_search`; default omits `search_types` so Google uses web search.
  - `google_maps`: accepts `query` plus optional `latitude` and `longitude`; coordinates must be provided as a pair and pass range checks.
  - `google_url_context`: accepts `prompt` plus `urls`, only allows `http://` and `https://`, sends `tools: [{ "type": "url_context" }]`, and uses a single string input containing the prompt and URL list.
- Use Node `fetch` directly against the configured Interactions API URL; do not add `@google/genai` until file upload, live sessions, Vertex auth, batch/video operations, or other SDK-heavy features are added.
- Keep one shared helper for request construction, timeout/abort, status updates, JSON parsing, source extraction, output truncation, and result formatting.
- Tool content includes answer text and a compact `Sources:` section with at most 10 sources. Details contain normalized metadata only: model, output text, sources, tool steps, truncation state, and `fullResponsePath` when present.
- If tool content is truncated, write the full raw interaction JSON to a temp file with `0600` permissions and include the file path in content/details. Do not store raw interaction JSON in session `details`.
- Add `/google-genai init|status|help|config|tools|enable|disable` command modes with argument completions. `/google-genai init` asks for API key and model, merges with existing config, preserves existing API key/model on empty input, writes defaults for `apiUrl`, `timeoutMs`, and all tools, and never prints secrets.
- `/google-genai tools|enable|disable` uses `pi.getActiveTools()` / `pi.setActiveTools()` to manage only the three Google GenAI tool names while preserving unrelated tools; selected tool names persist in the same `google-genai.json`. Missing `tools` means all three enabled; unknown names are ignored with a warning.

## Non-Goals

- Do not implement Pi `resolveConfigValue`, `$ENV` interpolation, or `!command` secret lookup in `google-genai.json`.
- Do not add `@google/genai` as a direct dependency in the first version.
- Do not create separate packages for search, maps, and URL context.
- Do not store raw interaction JSON in session details or print resolved API keys in command output, tool content, test fixtures, or docs.
- Do not add deprecated Google Maps `enable_widget` support.
- Do not add per-tool model overrides; use config `model` only.

## Plan

- [x] Add `extensions/pi-google-genai/package.json`, `tsconfig.json`, `LICENSE`, and README scaffolding for `@narumitw/pi-google-genai`; verify with `npm --workspace @narumitw/pi-google-genai run typecheck` after source exists.
- [x] Add root package/recipe wiring for the new workspace (`pack:google-genai` script plus `just pack-google-genai`, `try-google-genai`, `install-google-genai`, and `publish-google-genai` aliases); verify with `npm run check:boundaries` and `just --list | grep google-genai`.
- [x] Implement config loading in `src/google-genai.ts` to read `${PI_CODING_AGENT_DIR:-~/.pi/agent}/google-genai.json`, default `model` to `gemini-3.5-flash`, default `apiUrl` to the official Interactions endpoint, default `timeoutMs` to `30000`, default missing `tools` to all enabled, reject config `apiKey` values starting with `$` or `!`, normalize known tools, ignore unknown tool names with warning metadata, and never log the key; verify with unit tests.
- [x] Implement config writing for `/google-genai init` and tool selection to create parent directories, merge/update existing config, preserve existing API key/model on empty input, write `0600`, and repair config permissions with `chmod 0600`; verify with unit tests using a temporary `PI_CODING_AGENT_DIR`.
- [x] Implement auth resolution so tools use config literal `apiKey` before `ctx.modelRegistry.getApiKeyForProvider("google")`, with no direct `process.env.GEMINI_API_KEY` read; verify with unit tests for config key, Pi auth fallback, missing auth, and rejected interpolation.
- [x] Implement a shared `callInteraction()` helper using `fetch` with `x-goog-api-key`, JSON content type, abort signal, configurable timeout, non-2xx error messages, and interaction response normalization; verify with mocked `globalThis.fetch` tests covering request body, headers, success text extraction, annotations/source extraction, HTTP error, timeout, and aborted signal passthrough.
- [x] Implement `google_search` with `query` and optional `searchTypes` mapped to the Interactions `google_search` tool; verify with unit tests that the request uses `tools: [{ type: "google_search" }]` and includes `search_types` only when supplied.
- [x] Implement `google_maps` with `query`, optional paired/range-checked `latitude` and `longitude`, and no `enable_widget`; verify with unit tests for coordinates present, coordinates omitted, invalid half-pair/range errors, and place citation details from response annotations.
- [x] Implement `google_url_context` with `prompt` and `urls`, only allow `http`/`https`, include URLs in one string input, and use `tools: [{ type: "url_context" }]`; verify with unit tests for request shape, invalid URL rejection, and URL context result details.
- [x] Format tool output as answer text plus at most 10 `Sources:` entries, truncate content to Pi defaults, and write full raw interaction JSON to a `0600` temp file only when truncated; verify with unit tests for source limit, truncation notice, file permissions, and normalized details without `rawInteraction`.
- [x] Register `/google-genai` command modes for `init`, `status`/`config`, `help`, `tools`, `enable`, and `disable`, including command completions; verify with command-handler unit tests using fake UI and active-tool state.
- [x] Document install, `/login google`, config, init/status/help/tools commands, API key precedence, literal-only config `apiKey`, tool usage, manual live smoke tests, and no-SDK-first rationale in `extensions/pi-google-genai/README.md`; verify by README review and package dry-run.
- [x] Run `npm run check`; verify Biome, boundary check, workspace typechecks, and tests pass.
- [x] Run `just pack-google-genai`; verify the tarball contains `src`, `README.md`, `LICENSE`, and `package.json`, and no test files or secrets.

## Risks

- The Interactions API is preview/beta and may change. Keep request/response parsing small and tolerant instead of wrapping every field in rigid SDK-like types.
- `gemini-3.5-flash` availability depends on Google's API. Keep it configurable and test request construction with mocks rather than requiring a live API key.
- Google Maps and URL context response shapes may include partial/error statuses. Return raw relevant normalized `details` so the LLM can report source failures instead of hiding them.
- `setActiveTools()` is global to the current Pi session. Patch only Google GenAI tool names and preserve unrelated active tools to avoid clobbering other extensions.

## Completion Checklist

- [x] `@narumitw/pi-google-genai` exists as an active workspace with correct `pi.extensions` entry and publish `files`; verified by `npm query .workspace --json` and package review.
- [x] The extension registers exactly `google_search`, `google_maps`, and `google_url_context`; verified by unit tests against a fake `ExtensionAPI`.
- [x] API key resolution uses literal config key before Pi auth provider `google`, rejects interpolation in config, and reports missing auth clearly; verified by config/auth unit tests.
- [x] `/google-genai init` merges config, preserves existing values on empty input, writes `0600`, and never prints secrets; verified by command/config unit tests.
- [x] `/google-genai tools|enable|disable` manages only Google GenAI tools, allows `tools: []`, persists to `google-genai.json`, and restores on `session_start`; verified by command and session-start unit tests.
- [x] Each tool sends the expected Interactions request body and returns normalized text, compact sources, truncation behavior, and metadata without live network calls; verified by mocked-fetch unit tests.
- [x] README documents config path, API key precedence including `/login google`, three tools, tool-selection commands, live smoke tests, and why `@google/genai` is not a dependency yet; verified in `extensions/pi-google-genai/README.md`.
- [x] Repository validation passes; verified by `npm run check`.
- [x] Package dry-run passes with expected contents; verified by `just pack-google-genai`.
