# Verification and release handoff

The request contract is confirmed against [OpenAI Codex source](./protocol.md#source-mapping). Deterministic tests validate the TypeScript implementation, not the availability of the internal Codex endpoint for a real account. No live image request is part of the default tests, build, package load, or Status action.

## Deterministic coverage

Package tests cover synthetic OAuth metadata/resolution, golden HTTP payloads, fixed destination and header filtering, redaction, redirects, quota/status errors, deadlines, bounded/chunked streams, socket cancellation, image validation, path preflight, native-style binary writes, settings transactions, UI, and lifecycle cleanup.

Real Pi SDK fixtures exercise explicitly disabled tool behavior through direct activation, codemode, tool search, and nested execution; default-enabled generation; normalized model-visible prefixes and toggle transitions; command modes; direct SDK disposal; and the package entrypoint through Pi's Jiti loader. All credentials, model streams, and image responses in those tests are synthetic.

Regression coverage includes required exact paths, native `write` path equivalence, overwrites, symlink and permission branches, partial write behavior, destination input cancellation, release-then-click mouse dispatch without a render boundary, save failures after normal Settings closure, partial tool-application rollback, bounded filesystem error text, terminal-marker injection, and transport results returned after SDK invalidation.

Run the repository gates from its root:

```bash
npm run check
npm test
npm run package:pack -- codex-imagegen
```

Build Kit before consumer tests and do not overlap root checks with Kit builds. Inspect a real tarball in a temporary directory as well as the pack dry-run list. Do not publish it as a smoke test.

For loading, use a controlled non-interactive subprocess with a temporary Pi agent directory and no credentials:

```bash
pi --mode rpc --no-extensions -e ./packages/pi-codex-imagegen
```

The harness must establish RPC readiness, check `/codex-imagegen` rejection, reload settings, and shut down cleanly. It must not send an ordinary model prompt or attempt generation. The source package has no required generated runtime build.

## Account-owner setup

Responsible role: account owner. Prerequisite: an account allowed to use Codex images and the supported Pi `openai-codex` provider. Sign in using Pi's `/login` if this provider is not configured. Confirm only the non-secret Status output; never paste credentials into chat or an issue. Codex CLI-only login is not automatically reused.

Expected result: Pi owns credential storage and refresh. The extension creates no credential file or migration. Actual image access remains unverified until the live procedure succeeds.

## Live-provider smoke

Responsible role: maintainer/account owner. Prerequisites: explicit permission to consume quota, compatible OAuth, network access, and completion of deterministic checks. This procedure is not authorization to spend quota.

1. Set `toolEnabled` to `false` in a temporary or controlled Pi configuration before loading only this extension; the tool is enabled by default.
2. Open `/codex-imagegen` and inspect Status without causing auth refresh or an image request.
3. Choose Generate Image, enter one simple prompt, then provide an explicit path in a disposable directory. Existing files and symlink targets can be overwritten. Submit once; do not retry automatically.
4. Confirm that a supported image exists at that exact path, inspect its actual bytes/dimensions, and confirm that the reported absolute path is correct. An extension does not request format conversion.
5. With separate authorization for another image, request a transparent background and inspect actual alpha. A checkbox or successful HTTP response is not proof of transparency.
6. If tool use is to be claimed as live-verified, enable it explicitly and authorize one additional model invocation; confirm saved-path and image results, then restore the desired setting.
7. Record only sanitized outcome, media/dimensions, and a non-secret request ID if useful. Do not retain tokens, account identifiers, prompts containing secrets, or raw upstream error bodies.

Stop after one clear entitlement, unsupported-endpoint, or external failure. Record it and return to deterministic tests; do not change identity headers, bypass policy, or switch credentials/models to make the smoke pass.

Remote generation cancellation and quota refunds are not guaranteed even after a successful smoke. Local cancellation should close the owned request and prevent stale result publication. A filesystem write already started can leave complete or partial bytes; cancellation does not restore previous content.

## Physical-terminal review

Responsible role: terminal user. Prerequisites: the built Kit dependency, intended terminal/input mode, and synthetic prompts for editor checks. Review menu navigation, the required destination input and overwrite/symlink warning, remapped cancellation, hard Ctrl+C, IME, Backspace/newlines, large and multiline paste, mouse press/release/click, narrow/short terminal layouts, theme changes, and resizing.

Review inline preview with the intended image protocol only after a live image has been separately authorized or with an existing safe fixture. Confirm a readable file path when inline rendering is disabled or unavailable. The external-editor shortcut is intentionally unavailable in this owned prompt dialog.

Expected result: Pi-native input behavior and bounded screens. Mocked frames do not prove physical terminal behavior. Keep untested terminal/input modes listed as unverified rather than claim general visual compatibility.

## Current external limits and release restriction

Live account/endpoint compatibility, actual generated image bytes, transparent alpha, live tool use, physical terminal/IME behavior, and runtime-specific proxy setups remain unverified. The tests must not be described as proving those paths.

Do not publish the initial package until the supported live generation path is verified and publication is explicitly approved. Do not create version tags, change npm visibility, or dispatch release workflows as part of implementation verification.
