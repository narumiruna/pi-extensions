## Goal

Fix `@narumitw/pi-sync` in code so Cloudflare R2 auto sync no longer fails from stale or unrelated session tokens. Do not require users to unset or override environment variables as a quick workaround. The success condition is that R2 static access keys recover automatically when R2 rejects `X-Amz-Security-Token`, while valid R2 temporary credentials can still use a session token.

## Context

Previously, `loadPartialConfig()` in `extensions/pi-sync/src/sync.ts` could apply a session token to R2 requests. This is useful for AWS STS/SSO S3 and any R2 temporary credentials, but Cloudflare R2 static keys reject signed requests that include `x-amz-security-token` and return:

```text
InvalidArgument: X-Amz-Security-Token
```

A first implementation avoided the error by ignoring all session tokens for R2 endpoints. PR review correctly flagged that as a regression for valid R2 temporary credentials, so the final fix keeps session-token support and adds an R2-specific retry fallback when the token is rejected.

## Assumptions

- R2 static access keys usually do not need a session token.
- R2 temporary credentials may require a session token and must remain supported.
- Regular AWS S3 must still support `AWS_SESSION_TOKEN`.

## Non-Goals

- Do not require users to unset `AWS_SESSION_TOKEN`, edit shell profiles, or launch Pi with `PI_SYNC_SESSION_TOKEN=`.
- Do not introduce a new opt-in flag for R2 temporary credentials.

## Plan

- [x] Restore normal session-token resolution in `extensions/pi-sync/src/sync.ts`: `PI_SYNC_SESSION_TOKEN` takes precedence, then `AWS_SESSION_TOKEN`, then local config `sessionToken`; verified by reviewing `selectSessionToken()` and by a non-R2 config handler showing `sessionToken: configured`.
- [x] Add R2-specific request fallback in `S3Client`: if a signed R2 request with a session token receives `InvalidArgument: X-Amz-Security-Token`, retry the same request once without the token; verified by a live R2 `status` handler check using a configured token.
- [x] Cache successful token omission for the current `S3Client` command after the fallback retry succeeds, preventing repeated token failures in the same sync operation; verified by code review of `omitSessionTokenAfterRejection`.
- [x] Normalize empty token strings as unset so `PI_SYNC_SESSION_TOKEN=`, whitespace-only strings, or `"sessionToken": ""` in config do not confuse display or signing logic; verified by the `normalizeOptionalString()` implementation.
- [x] Strengthen `/pisync doctor` and `/pisync config` diagnostics: when a session token is configured under an R2 endpoint, explain that pi-sync will retry without it if R2 rejects `X-Amz-Security-Token`; verified with live config and doctor handler output.
- [x] Update `extensions/pi-sync/README.md` R2 configuration docs: document that R2 static keys do not need session tokens, R2 temporary credentials remain supported, and rejected R2 tokens trigger a one-time retry without the token; verified by the README diff.
- [x] Run formatting and type checks from the repository root with `npm run check`; verified by successful command completion.
- [x] Run a package dry run with `npm run pack:sync`; verified that the tarball contains only `LICENSE`, `README.md`, `package.json`, and `src/sync.ts`.
- [x] Verify against R2: using the real R2 config and a configured session token, call the extension `config`, `doctor`, and `status` handlers; `config` showed the token as configured with the fallback warning, and `status` successfully read the remote pointer without surfacing `InvalidArgument X-Amz-Security-Token`.

## Risks

- If R2 temporary credentials reject an expired or malformed token, the retry without the token may still fail with an auth error; this is acceptable because the credentials are invalid, and static-key setups still recover.
- If Cloudflare changes the XML error shape for rejected session tokens, the retry detector may not match; the helper is deliberately narrow to avoid retrying unrelated failures.

## Rollback / Recovery

- If the retry fallback causes unexpected behavior, revert the R2-specific retry in `S3Client.request()` while keeping normal session-token resolution.

## Completion Checklist

- [x] R2 static-key setups with a stale or unrelated session token recover automatically, verified by actual R2 `status` succeeding with a configured token.
- [x] R2 temporary credentials remain possible because configured session tokens are still sent first, verified by `selectSessionToken()` preserving session-token resolution.
- [x] Non-R2 AWS S3 endpoints can still use `AWS_SESSION_TOKEN`, verified by a non-R2 config handler showing `sessionToken: configured`.
- [x] User documentation clearly explains R2 static-key and temporary-credential session-token behavior, verified by the `extensions/pi-sync/README.md` diff.
- [x] Repository quality gates pass, verified by successful `npm run check` output.
- [x] The pi-sync package dry run has no anomalies, verified by successful `npm run pack:sync` output.
