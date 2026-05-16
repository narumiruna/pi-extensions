# MEMORY

## GOTCHA

- `MEMORY.md` is not auto-loaded; check it before non-trivial debugging or design work when prior project context may matter.
- npm can show a scoped package dist-tag (for example `latest`) while `npm view <package>` still returns 404; fix visibility with `npm access set status=public <package> --otp=<otp>` or publish a bumped version.
- `npm access set status=public <package>` cannot create brand-new scoped packages; if it returns access 404, first run `npm publish --workspace <package> --access public`.
- For sleep-inhibitor extensions on WSL, prefer Windows `powershell.exe` with `SetThreadExecutionState`; `systemd-inhibit` may exist but fail without a usable systemd/logind session.
- When testing TypeScript extensions via direct Node import, avoid parameter properties; Node's strip-only TypeScript loader rejects them even though `tsc` accepts them.
- ty/ruff LSP servers may request `workspace/configuration`; respond with per-item empty config objects or diagnostic requests can hang.
- pi-statusline is display-only; avoid prompt interception or customization commands unless intentionally reintroduced.
- In Pi extensions, do not call action methods such as `getThinkingLevel()` during the factory load; defer them to `session_start` or later handlers.
- Extension statusline entries should be activity-based: only show an extension in status when it is actively running, retrying, or needs attention; avoid permanent “configured/ready/on” statuses.
- Codex usage can be queried without Codex CLI by sending Pi's `openai-codex` bearer token to `https://chatgpt.com/backend-api/wham/usage`; response uses Codex `RateLimitStatusPayload` snake_case fields.

## TASTE

- Keep entries short and reusable.
- Keep `just` install recipes resilient by verifying registry visibility and falling back only when it solves the current install path.
