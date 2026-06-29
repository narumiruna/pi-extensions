# MEMORY

## GOTCHA

- `MEMORY.md` is not auto-loaded; check it before non-trivial debugging or design work when prior project context may matter.
- npm can show a scoped package dist-tag (for example `latest`) while `npm view <package>` still returns 404; fix visibility with `npm access set status=public <package> --otp=<otp>` or publish a bumped version.
- `npm access set status=public <package>` cannot create brand-new scoped packages; if it returns access 404, first run `npm publish --workspace <package> --access public`.
- For sleep-inhibitor extensions on WSL, prefer Windows `powershell.exe` with `SetThreadExecutionState`; `systemd-inhibit` may exist but fail without a usable systemd/logind session. Ensure Windows inhibitors exit on stdin EOF, clear `ES_CONTINUOUS`, and pass execution-state flags as `[uint32]'0x...'`; ensure Unix inhibitors are parent-bound and trap cleanup, or Pi shutdown can leave a power request/process active.
- When testing TypeScript extensions via direct Node import, avoid parameter properties; Node's strip-only TypeScript loader rejects them even though `tsc` accepts them.
- Symptom: Node's built-in TypeScript test runner cannot resolve source imports written as `./module.js` to local `.ts` files. Cause: Node strip-types does not apply TypeScript's NodeNext extension remapping. Fix: compile tests with `tsc` to a temp JS outDir before running `node --test`.
- ty/ruff LSP servers may request `workspace/configuration`; respond with per-item empty config objects or diagnostic requests can hang.
- pi-statusline is display-only; avoid prompt interception or customization commands unless intentionally reintroduced.
- In Pi extensions, do not call action methods such as `getThinkingLevel()` during the factory load; defer them to `session_start` or later handlers.
- Symptom: extension accept/execute actions from `agent_end` may not trigger a new turn. Cause: `pi.sendMessage({ triggerTurn: true })` only triggers when idle, and `sendUserMessage(..., { deliverAs: "followUp" })` can miss the current drain point late in `agent_end`. Fix: avoid starting new user turns from `agent_end`; let the user submit normally or schedule work after the agent is truly idle.
- Extension statusline entries should be activity-based: only show an extension in status when it is actively running, retrying, or needs attention; avoid permanent “configured/ready/on” statuses.
- Codex usage can be queried without Codex CLI by sending Pi's `openai-codex` bearer token to `https://chatgpt.com/backend-api/wham/usage`; response uses Codex `RateLimitStatusPayload` snake_case fields.
- `pi-codex-usage` statusline must select a rate-limit bucket by current model id/name; `gpt-5.3-codex-spark` can use its own returned bucket instead of primary `codex`.
- `node-domexception` deprecation comes via `@google/genai -> google-auth-library -> gaxios -> node-fetch -> fetch-blob`; use the root npm override to `npm:@profoundlogic/node-domexception`.
- New filesystem-writing Pi tools need a pre-review edge-case pass: workspace containment, absolute/`..` paths, symlink loops/escapes, duplicate paths, cancellation, process errors, protocol errors, and edit ordering.
- New extension package source may match the root `.gitignore` `src/` rule; stage intended `extensions/<pkg>/src/*.ts` with `git add -f`.
- Symptom: `npm test --workspace @narumitw/<extension>` fails with “Missing script: test”. Cause: extension packages do not define workspace test scripts; root `npm test` compiles and runs all extension tests. Fix: run `npm test` from the repository root.
- When PR comments expose one class of bug, stop patching comment-by-comment and do a holistic pass over adjacent Modules before pushing again.
- Symptom: PR status shows no issue comments but inline review comments exist. Cause: `gh pr view --json comments,reviews` omits pull review comment bodies. Fix: use `gh api repos/OWNER/REPO/pulls/NUMBER/comments` plus issue comments/reviews when actual PR review comments are needed.
- Symptom: Chrome DevTools `/json/new` may reject unsafe `GET`. Cause: modern Chrome expects `PUT` for target creation. Fix: use `PUT /json/new?${encodeURIComponent(url)}`.
- Symptom: Telegram bot polling can replay stale queued messages or conflict across Pi processes. Cause: `getUpdates` is a single bot-token queue controlled by offsets. Fix: discard pending updates on startup with an offset and run one active polling Pi per bot token.
- For pi-sync on Cloudflare R2, keep session-token support for temporary credentials but retry once without the token when R2 static keys reject `X-Amz-Security-Token`.
- Symptom: Pi extension async/timer/command continuations can crash after reload or session replacement. Cause: captured `ExtensionContext` becomes stale. Fix: pass plain data into delayed callbacks, catch stale-context errors, and scope cleanup to the failing ctx/request.
- Codex `websocket_connection_limit_reached` is a retryable fresh-websocket case, but Pi 0.79.8's auto-retry regex does not classify “connection limit”; pi-retry must add the `provider returned error` hint.
- Symptom: pi-goal compaction/retry hooks can mis-handle continuation state if a fresh continuation reuses a cancelled marker. Cause: markers based only on goal id and iteration collide after compaction cancellation. Fix: include a unique nonce in continuation markers.
- Symptom: Pi compaction event docs may mention `reason`/`willRetry` while project target typings lack them. Cause: local/global `@earendil-works/pi-coding-agent` version skew. Fix: run `npm install`, verify target version, and treat compaction event fields as optional.

## TASTE

- Keep entries short and reusable.
- Prefer status-producing extensions to publish text-only status values; keep extension icons in pi-statusline defaults/settings so styling and suppression stay centralized.
- Keep `just` install recipes resilient by verifying registry visibility and falling back only when it solves the current install path.
- New extension README files should mirror the existing style: emoji title, npm/Pi/license badges, Features, Install, Usage/What it does, Package layout, Keywords, and License.
- New slash-command extensions should include argument autocomplete when the command has known subcommands, modes, or flags.
- Earendil Works acquired the Pi tooling from mariozechner; prefer `@earendil-works/*` Pi packages because `@mariozechner/pi-*` packages are deprecated and should not be used for new extension work.
