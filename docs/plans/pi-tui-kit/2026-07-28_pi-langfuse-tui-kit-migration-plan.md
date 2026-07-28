# pi-langfuse pi-tui-kit migration plan

## Goal

Migrate the context-aware `/langfuse` action menu to `@narumitw/pi-tui-kit` while preserving trace
recording, private credential configuration, ordered atomic writes, setup/update prompts, flush
semantics, restart requirements, redaction, and per-session recorder lifecycle.

## Context

`extensions/pi-langfuse/src/langfuse.ts` builds one state-dependent selector whose actions are Flush,
Set up/Update, and Help. Configuration prompts and secret handling are specialized. Existing
`sessionGeneration` checks prevent stale publication but an unanswered menu has no owner signal.
Arguments are intentionally ignored and documented as compatibility behavior.

## Architecture

Define one dynamic action screen with sanitized state lines for enabled/disabled tracing, endpoint,
content capture, initialization errors, configuration notice, and private path. Stable action ids are
independent of the long labels. Add a menu abort controller rotated with `sessionGeneration`; pass
its signal and generation guard to `runMenu()`.

Flush and configuration actions continue to use the existing recorder/prompt/write queue. Do not mark
Flush cancellable unless the recorder exposes an abort contract. Setup/update retains fresh config
loading, secret redaction, unknown-field preservation, and restart-only application. RPC uses dialog
adaptation; print/JSON must reject or provide a genuinely observable status route rather than a no-op
notification.

## Non-Goals

- Changing trace schema, SDK/provider initialization, batch export, credentials, capture policy, or
  restart semantics.
- Genericizing secret input, setup forms, or trace flushing in the kit.
- Adding textual subcommands or changing ignored-argument compatibility.

## Risks

- Recorder/config state can be replaced while a menu action awaits. Capture only plain identity,
  revalidate generation after every await, and never publish stale success.
- Error text can contain credentials or endpoint userinfo; retain existing `formatError()` redaction
  before handing text to the menu/notifier.

## Plan

- [ ] Add the `<1` kit dependency and lockfile edge; verify independent install and package metadata.
- [ ] Add failing tests for no-config, active-recorder, initialization-error, notice, setup/update,
      flush, help, RPC, no-UI, menu cancellation, and session-replacement screens/actions.
- [ ] Replace the selector with a typed dynamic action screen and session-owned signal while retaining
      existing recorder/config snapshots and generation checks; verify focused menu tests pass.
- [ ] Route Flush and setup/update actions through existing domain flows, revalidating state after
      recorder flush, config load, each prompt, and queued write; verify tracing, redaction,
      permissions, unknown-field, malformed-file, and shutdown-drain tests pass.
- [ ] Audit and document observable non-TUI behavior without changing the ignored-argument public
      contract, then run package/root checks, root tests, `npm run pack:langfuse`, and isolated RPC
      loading with mocked/no external exporter traffic.
- [ ] Audit menu, settings, credentials, lifecycle, error redaction, package, and verification
      conventions before archiving.

## Completion Checklist

- [ ] `/langfuse` standard rendering/navigation uses `pi-tui-kit` in TUI/RPC.
- [ ] Setup, update, flush, tracing, restart, credential, redaction, and shutdown behavior is unchanged.
- [ ] Stale/cancelled menu actions cannot write config or report recorder success.
- [ ] Focused tests, package/root checks, pack inspection, and runtime smoke pass.
