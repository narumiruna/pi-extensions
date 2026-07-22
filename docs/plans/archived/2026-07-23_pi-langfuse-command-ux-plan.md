# Pi Langfuse command UX plan

## Goal

Replace the argument-heavy `/langfuse` workflow with one interactive manager that shows the current session's tracing state and offers context-aware next actions. Agent-directory configuration changes and per-process restart requirements must be labeled clearly, while current-session actions such as flushing stay prioritized.

## Context

`/langfuse` currently defaults to a status notification and expects users to remember `status`, `flush`, `help`, and `init` arguments. `MEMORY.md` prefers manager commands to use one interactive slash command, show current state plus next actions, prioritize the current session, make cross-context changes explicit, and avoid hidden argument fallbacks unless non-interactive support is a real product requirement.

## Non-Goals

- Do not change trace capture, export, credential storage, or runtime initialization semantics.
- Do not add project-scoped configuration or environment-variable credential fallbacks.
- Do not apply changed credentials to a running process; the isolated Langfuse runtime still requires each Pi process to restart.
- Do not add a custom TUI component for this small action menu.

## Plan

- [x] Add command tests for enabled and disabled summaries, context-aware action ordering, ignored legacy arguments, non-interactive guidance, action routing, pending restart state, session replacement, and UI error secret redaction; verified by 33 focused pi-langfuse tests.
- [x] Implement `/langfuse` as the only interactive entrypoint using `ctx.ui.select`, with the current session state in the menu title and no argument autocomplete or hidden subcommand dispatch; verified by command registration and menu tests.
- [x] Label flush as a current-session action and configuration as an agent-directory change that requires each Pi process to restart; redact configured keys from all surfaced runtime/write errors; verified by menu, update, initialization, flush, and write-failure tests.
- [x] Route configuration through the existing private atomic config writer and preserve the existing prompt/cancellation behavior; verified by the private-file create/update test.
- [x] Update the README to document the single-command menu, dynamic actions, agent-directory configuration scope, per-process restart behavior, non-interactive manual setup, and all supported install paths; verified by source inspection and package dry-run contents.
- [x] Run focused formatting, package typecheck, root tests/checks, package dry-run inspection, and `git diff --check`; verified by `npm --workspace @narumitw/pi-langfuse run check`, 33 focused tests, `npm run check` with 1,021 passing tests, `npm run pack:langfuse`, explicit ignored-source Biome checks, and `git diff --check`.

## Risks

- Removing documented subcommands is a command-surface change; tests and README must make argument ignoring explicit.
- Selector labels are plain strings, so scope and restart semantics must be concise but visible before the user chooses an action.
- A config may be saved while the old runtime remains active; the menu and success notification must not imply immediate application.

## Completion Checklist

- [x] Bare `/langfuse` shows current-session tracing state and relevant next actions in one selector.
- [x] Enabled sessions prioritize flushing; disabled sessions prioritize setup.
- [x] Configuration actions clearly state their Pi agent-directory scope and per-process restart requirement.
- [x] Legacy arguments do not silently execute actions, and non-interactive invocation gives manual guidance without exposing credentials.
- [x] Tests, typechecks, formatting, package contents, and repository checks pass.
