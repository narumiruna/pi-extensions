## Status

Complete. The implementation shipped in PR #24 (`feat/codex-usage-extension`) with
`/codex-status`, automatic statusline support for the `openai-codex` model, Pi auth
direct backend support, the Codex app-server fallback, README/root metadata, local install
support, and package verification.

## Goal

Create a new Pi extension package that lets users view current Codex ChatGPT/subscription
usage in Pi, similar to the rate limit, reset time, credits, and plan information shown by
`/status` in the Codex TUI.

The success criteria are that the new extension can safely query Codex usage through a
clear command, preferably `/codex-status`, format it into readable output, provide useful
errors when Codex CLI is unavailable or the user is not signed in, and satisfy this
monorepo's package, README, typecheck, and pack verification standards.

## Context

The `/status` usage-related implementation in `third_party/codex` has been reviewed:

- `codex-rs/tui/src/chatwidget/slash_dispatch.rs`: `/status` triggers a rate-limit
  refresh.
- `codex-rs/tui/src/status/rate_limits.rs` and `codex-rs/tui/src/status/card.rs`: format
  `RateLimitSnapshot` into 5h/weekly limits, credits, and reset time.
- `codex-rs/app-server/src/request_processors/account_processor.rs`: the app-server
  `account/rateLimits/read` request reads Codex account rate limits.
- `codex-rs/backend-client/src/client.rs`: calls `GET /wham/usage` or
  `/api/codex/usage` and converts the response into `RateLimitSnapshot`.
- `codex-rs/app-server/README.md`: the app-server supports stdio JSON-RPC and requires
  `initialize` before calling `account/rateLimits/read`.

## Architecture

Use a multi-source query strategy so Pi users without Codex CLI still have a usable path:

1. **Primary: Pi auth direct backend**. If the current Pi model/provider is signed in
   through ChatGPT/Codex subscription auth, first use
   `ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)` to get Pi's existing bearer token
   and headers, then call the Codex backend usage endpoint directly.
2. **Fallback: Codex app-server**. If Pi auth is unavailable but Codex CLI exists locally,
   spawn `codex app-server --listen stdio://` and call `account/rateLimits/read`, letting
   Codex handle token refresh and auth storage.
3. **No auth source**. If neither Pi ChatGPT/Codex auth nor Codex CLI/auth is available,
   the extension can only report that no usable auth source is available. It cannot obtain
   subscription quota without any signed-in credentials.

Recommended data flow:

```text
Pi /codex-status command
  -> try Pi modelRegistry auth
  -> if available: GET https://chatgpt.com/backend-api/wham/usage
  -> else if codex exists: spawn `codex app-server --listen stdio://` + account/rateLimits/read
  -> parse RateLimitStatusPayload or GetAccountRateLimitsResponse
  -> format status lines
  -> render in Pi notification/custom modal/tool result
```

Suggested new package:

```text
extensions/pi-codex-usage/
├── LICENSE
├── README.md
├── package.json
├── tsconfig.json
└── src/
    └── codex-usage.ts
```

The core module can start in `src/codex-usage.ts`; if the file becomes too large, split it
into:

- `pi-auth-backend-client.ts`: uses Pi modelRegistry auth to call the Codex usage endpoint
  directly.
- `codex-app-server-client.ts`: optional fallback with spawn/stdin/stdout JSON-RPC client,
  timeout, and cleanup.
- `rate-limit-format.ts`: pure formatting and reset-time display.
- `codex-usage.ts`: Pi extension entrypoint, auth source selection, and command/UI glue.

## Tech Stack

- TypeScript Pi extension using the current `@earendil-works/pi-coding-agent` types and
  Node built-ins; do not use deprecated `@mariozechner/pi-*` packages for new packages.
- Node `fetch` calls the Codex backend usage endpoint directly.
- Node `child_process.spawn` and a `readline`/stream parser are used only for the Codex
  app-server fallback.
- Do not add runtime dependencies for the MVP unless a mock/test or formatting need is
  concrete.

## Non-Goals

- Do not directly parse, modify, or refresh `~/.codex/auth.json`.
- Do not implement a separate footer/statusline renderer; expose compact usage only through
  Pi `setStatus` so the existing statusline can show the extension status.
- Do not support OpenAI API key platform rate limits; this feature focuses on Codex
  ChatGPT/subscription quota.
- Do not copy the full Codex TUI `/status` card; provide only a readable usage summary in
  Pi.

## Assumptions

- Even if users do not have Codex CLI, they may still be using OpenAI ChatGPT Plus/Pro
  (Codex) subscription auth inside Pi.
- API key auth does not return Codex subscription usage; the direct backend path only makes
  sense for ChatGPT/Codex bearer auth.
- A Pi extension package can briefly spawn a child process inside the command handler and
  clean it up afterward, but that is only a fallback, not a requirement.

## Resolved Findings

- Pi `openai-codex` auth can get a bearer token through
  `ctx.modelRegistry.getApiKeyAndHeaders(...)` and successfully call
  `https://chatgpt.com/backend-api/wham/usage`.
- The direct backend response aligns with Codex `RateLimitStatusPayload` snake_case fields;
  runtime parsing/normalization converts both direct backend and app-server responses into
  the same internal snapshot.
- The local Codex CLI `codex app-server --listen stdio://` fallback has been checked
  against help/protocol documentation, and a smoke test verified that it can return usage.
- MVP presentation is decided: `/codex-status` uses `ctx.ui.notify` for the full summary;
  when the current model provider is `openai-codex`, `ctx.ui.setStatus` shows a compact
  statusline and clears it when switching away.

## Plan

- [x] Create the `extensions/pi-codex-usage` package scaffold, including `pi.extensions`,
  `files`, scripts, `@earendil-works/pi-coding-agent` dev dependency, and `tsconfig.json`
  in `package.json`; verify the package is recognized by the workspace with
  `npm --workspace @narumitw/pi-codex-usage run typecheck`.
- [x] Add `pi-codex-usage` check/pack/try/install/publish entries and package table
  documentation to root `package.json`, `justfile`, and root `README.md`; verify entry
  completeness with `just --list | rg 'codex-usage'` and a root README diff.
- [x] Implement the Pi auth direct backend client: get usable auth from
  `ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)`, call
  `https://chatgpt.com/backend-api/wham/usage`, and return structured errors when auth is
  unavailable, HTTP returns 401/403, or the payload is unsupported; verify the success and
  formatter code paths with a real Pi auth smoke test and fixture imports.
- [x] Implement the optional Codex app-server JSON-RPC fallback client: when the direct
  backend is unavailable and the `codex` executable exists, spawn
  `codex app-server --listen stdio://`, send `initialize`, send the `initialized`
  notification, call `account/rateLimits/read`, and clean up on timeout/exit/error; verify
  the handshake against `codex app-server --help` and protocol documentation.
- [x] Define TypeScript types `RateLimitStatusPayload`, `RateLimitWindow`,
  `RateLimitSnapshot`, and `GetAccountRateLimitsResponse`, aligned with
  `third_party/codex/codex-rs/backend-client/src/client.rs` and
  `app-server-protocol/schema/typescript/v2/*`; verify the types and parser compile with
  `npm --workspace @narumitw/pi-codex-usage run typecheck`.
- [x] Implement rate-limit normalization and formatting: convert both direct backend
  payloads and app-server responses into one internal snapshot, then output used/remaining
  percent, window labels such as 5h/weekly, reset time, credits, and unavailable/missing
  states for each limit bucket; verify 5h, weekly, multi-bucket, and credits text output
  with fixture JSON.
- [x] Register the `/codex-status` command: try Pi auth direct backend and Codex app-server
  fallback in order, show loading/activity status, display the summary through Pi UI when
  complete, and provide next steps for errors such as "sign in to ChatGPT/Codex
  subscription in Pi / install Codex CLI as fallback / API key quota is unsupported"; verify
  the Pi auth path with a direct command-handler smoke test.
- [x] Add a 5-15 minute in-memory cache and a `--refresh` argument to avoid repeatedly
  hitting the Codex backend from consecutive `/codex-status` calls; verify by implementation
  review that the second command uses cache and `/codex-status --refresh` queries again.
- [x] Update `extensions/pi-codex-usage/README.md` to document installation,
  `/codex-status` usage, Pi ChatGPT/Codex auth priority, that Codex CLI is not required,
  that Codex CLI is only a fallback, that the MVP does not support API key quota,
  troubleshooting, and privacy notes, while matching the style of other extension READMEs;
  verify the documentation and formatting with README review and `npm run check`.
- [x] Run repository verification, including `npm run check` and `just pack codex-usage`,
  and inspect the dry-run tarball to confirm it only contains `src`, `README.md`, `LICENSE`,
  and package metadata; use command output as verification evidence.
- [x] If MVP validation is stable, evaluate whether to add an optional widget/footer display
  disabled by default; this version does not add a separate widget/footer, but per user
  request it shows compact usage through `setStatus` when the current model provider is
  `openai-codex` and refreshes every 5 minutes.

## Verification

- `rg --no-ignore -n "@earendil-works|@mariozechner" extensions/pi-codex-usage`: verified pi-codex-usage uses `@earendil-works/pi-coding-agent` and no deprecated `@mariozechner/pi-*` package.
- `npm --workspace @narumitw/pi-codex-usage run typecheck`
- `npm --workspace @narumitw/pi-codex-usage run check`
- `just --list | rg 'codex-usage'`
- `node --experimental-strip-types --input-type=module ...` direct command-handler smoke test with real Pi `openai-codex` auth: verified `Source: Pi auth direct` output.
- `node --experimental-strip-types --input-type=module ...` fallback smoke test with empty Pi auth candidate list: verified `Source: Codex app-server` output.
- `node --experimental-strip-types --input-type=module ...` cache fixture: verified two normal calls plus one `--refresh` result in two fetches.
- `node --experimental-strip-types --input-type=module ...` missing-auth/no-`codex` fixture: verified error notification includes both source failures.
- `node --experimental-strip-types --input-type=module ...` automatic statusline fixture: verified `session_start` with `openai-codex` sets `codex <5h>% 5h <weekly>% wk`, and `model_select` away clears it.
- `npm run check`
- `just pack codex-usage`

## Risks

- Pi subscription auth headers may be insufficient for calling the Codex usage endpoint
  directly, which would require extra provider support for users without Codex CLI.
- The Codex app-server protocol or CLI flags may change, making the fallback incompatible
  with some versions.
- Starting the app-server fallback on every command may be slow; keeping a resident process
  would require more careful handling of session shutdown and zombie processes.
- Usage data may be a momentary snapshot; an overly persistent display may make users think
  it is real-time information.
- Error messages that include backend bodies may accidentally expose sensitive information;
  avoid outputting tokens, full auth headers, or overly long response bodies.

## Rollback / Recovery

If the new package causes publish or install issues, revert only the package registration
files, namely root `package.json`, `justfile`, and root `README.md`, while keeping the
unpublished `extensions/pi-codex-usage` directory for follow-up fixes. If the npm package
has already been published and a serious issue is found, publish a patch version that
disables the command or marks the known issue in the README; do not require users to modify
Codex auth storage.

## Completion Checklist

- [x] The `@narumitw/pi-codex-usage` package scaffold has been created and verified with
  `npm --workspace @narumitw/pi-codex-usage run typecheck`.
- [x] `/codex-status` can prioritize the Pi ChatGPT/Codex auth direct backend to query
  usage, verified by a successful direct command-handler smoke test path.
- [x] The Codex app-server fallback can query `account/rateLimits/read` when the direct
  backend is unavailable and Codex CLI exists locally, verified by protocol/flag comparison
  and typecheck.
- [x] Error cases such as missing Codex CLI, missing Pi ChatGPT/Codex auth, API key auth,
  and unsupported usage payloads all have clear user messages, verified by implementation
  review and fixture imports.
- [x] Rate-limit output includes used/remaining percent, reset time, credits, and
  multi-bucket information, verified by fixture output review.
- [x] Cache, `--refresh`, and `openai-codex` automatic statusline behavior are implemented
  and verified by fixture/implementation review to avoid unlimited backend queries.
- [x] Root workspace metadata, README, and just recipes include `pi-codex-usage`, verified
  by `just --list | rg 'codex-usage'` and README review.
- [x] The repository gate passed with `npm run check`, and package dry run passed with
  `just pack codex-usage` with correct tarball contents.
