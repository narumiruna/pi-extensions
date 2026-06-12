## Goal

Improve `@narumitw/pi-chrome-devtools` browser startup so agents can use CDP tools when no compatible browser is already listening. Success means the extension first attaches to an existing configured/default endpoint, then lazily launches an extension-owned Chromium-family browser only for local launchable connection failures, avoids default-port conflicts with managed dynamic ports when possible, reports actionable failures, and preserves manual endpoint override behavior.

## Context

Issue: <https://github.com/narumiruna/pi-extensions/issues/89>

Implementation evidence:

- `extensions/pi-chrome-devtools/src/chrome-devtools.ts` now routes `/json/list` and `/json/new` through `ensureDevToolsEndpoint()` before CDP calls.
- Missing local transport failures can start one extension-owned browser through `ensureManagedBrowserLaunched()` / `launchBrowserCandidate()`.
- Default auto-launch uses `--remote-debugging-port=0` and reads `DevToolsActivePort`; explicit `PI_CHROME_DEVTOOLS_PORT` keeps the configured port.
- `extensions/pi-chrome-devtools/README.md` documents existing-endpoint reuse, auto-launch, fallback browsers, opt-out/manual overrides, WSL guidance, and cleanup semantics.
- Screenshot file saving from issue 89 is handled separately; this plan covers browser launch and fallback discovery only.

## Architecture

- Add a small browser-launch layer in `extensions/pi-chrome-devtools/src/chrome-devtools.ts` rather than a new package or daemon.
- Endpoint flow:
  1. Try the current endpoint first (`PI_CHROME_DEVTOOLS_HOST` / `PI_CHROME_DEVTOOLS_PORT`, or the default `127.0.0.1:9222`).
  2. If the endpoint is usable, attach to it and treat it as unowned.
  3. If the failure is local and launchable, start one extension-owned browser and retry.
  4. If the host is remote, auto-launch is disabled, or the endpoint returns a non-CDP/HTTP error, keep the manual failure path.
- Use a single-flight launch promise so concurrent tool calls cannot spawn multiple browsers.
- Prefer a managed dynamic debugging port (`--remote-debugging-port=0` plus `DevToolsActivePort`) when the user did not explicitly configure `PI_CHROME_DEVTOOLS_PORT`; respect an explicit local port when provided.
- Track only browser processes and temp profiles created by this extension; never terminate or modify pre-existing endpoints.

## Non-Goals

- Do not manage remote CDP endpoints.
- Do not attach remote debugging to an existing normal browser profile.
- Do not close user-started browser windows.
- Do not implement full WSL Windows-browser launch in the first pass unless a shell-free path and profile-dir translation is proven by a harness; document WSL manual override guidance instead.

## Assumptions

- A newly auto-launched browser should use an isolated user data directory from `mkdtemp(join(tmpdir(), "pi-chrome-devtools-profile-"))`.
- `PI_CHROME_DEVTOOLS_BROWSER` should allow users to force a specific executable before fallback discovery.
- `PI_CHROME_DEVTOOLS_AUTO_LAUNCH=0` should preserve the current manual endpoint behavior.
- Dynamic managed ports are safer than defaulting every auto-launched session to `9222`, but explicit `PI_CHROME_DEVTOOLS_PORT` remains authoritative.

## Plan

- [x] Add endpoint-source state to `extensions/pi-chrome-devtools/src/chrome-devtools.ts` so the extension can distinguish default endpoint values from explicit environment overrides; verify with source review that explicit `PI_CHROME_DEVTOOLS_PORT` disables dynamic-port launch while default `9222` does not.
- [x] Split endpoint failures into launchable transport failures, retryable HTTP failures, and non-launchable protocol/configuration failures; verified by source review of `DevToolsEndpointError` flags plus the browser-launch harness cases for connection refusal, opt-out transport failure, and valid existing CDP JSON.
- [x] Add a single `ensureDevToolsEndpoint()` helper used before both `/json/list` and `/json/new`; verify by code review that `listPages()` and `createPage()` cannot call `fetchDevToolsJson()` without passing through endpoint readiness.
- [x] Implement single-flight `ensureManagedBrowserLaunched()` state so concurrent missing-endpoint tool calls share one launch attempt; verify with a mocked `spawn` harness that two simultaneous `listPages()` calls produce one spawn.
- [x] Implement platform-specific browser candidate discovery for explicit `PI_CHROME_DEVTOOLS_BROWSER` plus Chrome, Chromium, Brave, and Edge executable names/paths on Linux, macOS, and Windows; verified by source review of deterministic candidate order and browser-launch harness use of an explicit fake browser path.
- [x] Implement `launchBrowserForDevTools()` with shell-free `spawn`, isolated temp profile, `--no-first-run`, `--no-default-browser-check`, and `about:blank`; verify with a mocked `spawn` harness that arguments include the expected profile and no shell string is constructed.
- [x] For managed launches without explicit `PI_CHROME_DEVTOOLS_PORT`, start the browser with `--remote-debugging-port=0`, read `<userDataDir>/DevToolsActivePort`, update `state.port` to the assigned port, and wait for `/json/version`; verify with a temp-dir harness that delayed `DevToolsActivePort` creation updates the endpoint before `/json/list` runs.
- [x] For explicit local ports, launch with `--remote-debugging-port=<port>` and wait for that configured endpoint; verify with mocked args that `PI_CHROME_DEVTOOLS_PORT=9223` keeps port `9223`.
- [x] Gate auto-launch with local-host detection and `PI_CHROME_DEVTOOLS_AUTO_LAUNCH=0`; verified by source review of local-host checks and browser-launch harness cases for `127.0.0.1` plus opt-out env.
- [x] Update endpoint retry errors, `launchHint()`, and `/chrome-devtools quickstart` to report whether the extension will attach, auto-launch with dynamic port, use an explicit port, or require manual startup, including browser candidates and opt-out/configuration environment variables; verified by source review and README review.
- [x] Track extension-owned child processes and temp profiles in state until cleanup, mark readiness separately from process creation, await/cancel in-flight launches during shutdown, guard best-effort kill calls, and attempt graceful termination on `session_shutdown` without touching unowned endpoints; verified by source review and mocked browser-launch/shutdown harness behavior.
- [x] Update `extensions/pi-chrome-devtools/README.md` to document existing-endpoint-first behavior, dynamic managed ports, fallback browser order, `PI_CHROME_DEVTOOLS_BROWSER`, `PI_CHROME_DEVTOOLS_AUTO_LAUNCH=0`, endpoint overrides, WSL/manual fallback guidance, and cleanup semantics; verify by README review.
- [x] Run `npm --workspace @narumitw/pi-chrome-devtools run check` and `npm run check`; verify both commands exit successfully.
- [x] Run `just pack-chrome-devtools`; verify the tarball still contains only the package files expected by `extensions/pi-chrome-devtools/package.json`.

## Risks

- Browser executable names and install paths vary by OS and package manager, so candidate discovery must be explicit, ordered, and easy to override.
- Dynamic ports require reading `DevToolsActivePort`; if that file is delayed or missing, the extension must time out with a manual launch hint rather than hang.
- Auto-launch can surprise users by leaving a browser process running; cleanup must apply only to extension-owned processes and be documented.
- Removing temp profiles too early can race browser shutdown, while dropping exited-browser state can leak profiles; cleanup should be best-effort and never delete user-configured or unowned directories.
- WSL setups may need Windows path/profile translation; first-pass behavior should either be proven by harness or documented as manual/override-only.

## Rollback / Recovery

- Users can set `PI_CHROME_DEVTOOLS_AUTO_LAUNCH=0` or configure `PI_CHROME_DEVTOOLS_HOST` / `PI_CHROME_DEVTOOLS_PORT` to retain manual endpoint behavior.
- If dynamic managed ports regress, fall back to explicit-port-only auto-launch while keeping browser candidate discovery and manual hints.
- A code rollback is bounded to `extensions/pi-chrome-devtools/src/chrome-devtools.ts` and README changes.

## Completion Checklist

- [x] Existing CDP endpoints are reused and not owned by the extension, verified by a mocked existing-endpoint harness where no browser process is spawned.
- [x] Missing local default endpoints are recovered by launching exactly one extension-owned Chromium-family browser, verified by a local smoke test or mocked endpoint/spawn harness.
- [x] Managed launches without explicit `PI_CHROME_DEVTOOLS_PORT` use a dynamic port from `DevToolsActivePort`, verified by harness output showing `--remote-debugging-port=0` and the updated endpoint.
- [x] Explicit local endpoint configuration is respected, verified by harness cases for `PI_CHROME_DEVTOOLS_PORT=9223` and `PI_CHROME_DEVTOOLS_BROWSER=<path>`.
- [x] Google Chrome absence falls back to at least Chromium and Brave candidates, verified by candidate-order harness output.
- [x] Remote endpoint configuration, non-launchable HTTP/protocol failures, and explicit auto-launch opt-out do not spawn a local browser, verified by source review and the opt-out harness case.
- [x] `/chrome-devtools quickstart` and README explain auto-launch, dynamic ports, fallbacks, cleanup, and manual override variables, verified by source review of `buildQuickstartMessage()` and `extensions/pi-chrome-devtools/README.md`.
- [x] Typecheck, repo check, and package dry-run pass, verified by `npm --workspace @narumitw/pi-chrome-devtools run check`, `npm run check`, and `just pack-chrome-devtools`.
