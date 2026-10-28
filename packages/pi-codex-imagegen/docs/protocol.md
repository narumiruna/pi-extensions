# Codex image protocol contract

This is an independent TypeScript implementation of the generation HTTP operation confirmed against the OpenAI Codex source mapped below. No Codex executable, library, agent, or plugin is bundled or started. The endpoint is internal; source review and offline tests do not establish real account access.

## Source mapping

The inspected reference is OpenAI Codex checkout `ffda54f5b8d5595eb0963594de32e206f98cc77f`, licensed under Apache-2.0. No source files are vendored. This implementation uses the protocol fields below rather than porting the Codex runtime.

| Reference under `codex-rs/` | TypeScript contract |
| --- | --- |
| `model-provider-info/src/lib.rs` | Fixed `https://chatgpt.com/backend-api/codex` root. |
| `codex-api/src/endpoint/images.rs` | JSON `POST images/generations`; optional `x-codex-imagegen-request-id` response header. |
| `codex-api/src/images.rs` | Response contains `data[].b64_json`. A URL, file reference, assistant message, or saved path is not image data. |
| `ext/image-generation/src/tool.rs` | Prompt, `gpt-image-2`, quality `auto`, size `auto`, and background `transparent` or `opaque`. The built-in generation path omits `n`; this client does too and requires exactly one returned image. |
| `model-provider/src/bearer_auth_provider.rs` | Bearer token and ChatGPT account header. |
| `ext/image-generation/src/backend.rs` | Originator header. The optional Codex turn metadata is omitted because no Codex turn exists. |

Reference source: [OpenAI Codex](https://github.com/openai/codex/tree/ffda54f5b8d5595eb0963594de32e206f98cc77f/codex-rs). Recheck the source when diagnosing upstream changes; do not silently infer a new wire contract from an error example.

## Authentication boundary

`image-client.ts` uses only Pi public `ModelRegistry` methods. It checks `openai-codex` provider/model metadata and `isUsingOAuth()` before resolving `getProviderAuth("openai-codex")`. Metadata is checked again after the await, and stale owners cannot send requests.

The installed Pi Codex adapter's OAuth implementation resolves its access token as `auth.apiKey`. Its JWT payload contains `payload["https://api.openai.com/auth"].chatgpt_account_id`. The client parses the identifier to create the account header; it does not claim to verify the JWT signature. Pi and the server own authentication and token refresh. API keys and incompatible token shapes fail before HTTP.

Accept only the exact canonical provider roots `/backend-api` or `/backend-api/codex`, optionally followed by one slash. A resolved auth base URL must be canonical too. These checks do not select a destination: the actual image URL remains fixed. Provider headers and labels are never copied to requests or error messages.

The allowed request headers are `Content-Type`, `Authorization`, `ChatGPT-Account-ID`, `originator`, and an honest `User-Agent`. No Codex client identity, session ID, turn ID, or organization-policy bypass is fabricated.

Pi login and Codex CLI login are separate. There is no private credential-file/keyring access or import path. The primary chat model does not have to use Codex. A compatible Pi login still does not prove image entitlement; the server can deny the request.

## Failure and cancellation classes

| Class | Behavior |
| --- | --- |
| Missing provider/auth, non-OAuth auth, noncanonical root, invalid account claim | Reject with fixed setup guidance; no HTTP request. |
| Delayed or failed Pi refresh | Bound the wait, redact the error, reject late results. Pi may continue its own refresh. |
| Owner/caller abort, replacement, reload, shutdown, direct SDK invalidation | Abort owned request work and reject stale continuations before publication. |
| 401 | Fixed sign-in guidance; no automatic retry. |
| 403 | Fixed entitlement/policy guidance; no fallback or bypass. |
| 429 | Fixed quota/rate-limit guidance; no retry loop. |
| Redirect, other HTTP status, transport loss, timeout | Error; no credential redirect and no generation retry. |
| Invalid content type, UTF-8, JSON, count, base64, image media, or bounds | Reject before saving; do not interpret URLs or file references. |
| Missing path, directory destination, or obvious filesystem/permission failure | Reject before HTTP without writing destination bytes. Preflight can create parent directories and is not a reservation against concurrent changes. |
| Image write failure or cancellation | Report failure; native-style writes can leave truncated or partial files. Do not remove or restore the destination automatically. |
| Settings write/application failure | Keep the previous effective values and restore the previous settings document; recover the in-process queue. |

Do not display raw upstream bodies, credential errors, provider labels, or arbitrary headers. Only a bounded token-like nested image request ID is retained in artifact details. Tool errors and saved-path notices are bounded to Pi's text-output limits even when a filesystem error echoes a very long path; structured path metadata remains complete.

## Bounds and storage

Prompt length is at most 32,000 characters. Authentication waits have a 30-second limit, and the total auth/HTTP operation has a five-minute limit. Header waiting can use the remaining total budget because image generation can precede response headers. Readers, listeners, and timers are released on all paths. Local HTTP tests synchronize on request and abort callbacks rather than sleeps.

The JSON body limit is the canonical base64 length of a 32 MiB image plus 64 KiB of metadata. A growable bounded buffer avoids unbounded per-chunk overhead. Artifact decoding requires canonical padded base64 and bounded image dimensions. PNG validation includes container/CRC and bounded raster checks; JPEG and WebP validation checks supported static containers and headers, not complete entropy decoding.

Image output requires an exact `path`; there is no output-directory setting, generated name, or extension adjustment. The captured session cwd and raw input are passed to Pi's public `createWriteTool` with custom binary filesystem operations. Pi owns path normalization and the absolute-path mutation queue. This keeps relative/absolute paths, tilde, leading `@`, file URLs, Unicode-space normalization, dot segments, and literal shell syntax aligned with `write` without importing private utilities.

Preflight uses the same public factory with non-writing operations. It creates parent directories and checks existing targets or missing targets' actual parents without truncating files. Existing writable targets do not require a writable parent directory. File and directory symlinks are followed, including final dangling symlinks when their target parent permits creation. Only the entered prompt and fixed image options reach the HTTP client; local paths are not sent to the endpoint.

The binary writer preserves validated image bytes and normal Node write/truncate/umask behavior, including overwrites and symlink following. It passes cancellation to the byte write and drains that operation before releasing the queue. Partial writes are not deleted or rolled back. Pi's in-process queue uses the real path for existing destinations and falls back to the resolved path when a destination is missing or has a non-directory component. Existing symlink aliases therefore share a queue; missing/dangling aliases and separate processes do not have that guarantee. Paths and preflight are not a filesystem sandbox.

Settings remain separate ordered, same-directory temporary-file-plus-rename transactions with rollback; image writes do not use that settings policy.

The extension has no mutable leading prompt, context hook, or deferred tool loader. Explicit tool toggles are loadout transitions; later ordinary requests preserve their established prefix. Manual generation appends one result message without triggering inference. Immutable artifact metadata stays in tool details or the result message; it does not cause automatic regeneration after reload, branching, or compaction.
