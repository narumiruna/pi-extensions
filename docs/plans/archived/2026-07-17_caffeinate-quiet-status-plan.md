## Goal

Make `pi-caffeinate` quiet mode suppress ambient status-bar output while the sleep inhibitor remains active, then open a verified pull request that closes issue #214.

## Context

`quiet: true` already suppresses routine lifecycle notifications, but `updateStatus` still publishes active and unavailable status values. Explicit `/caffeinate` command feedback and actionable warnings should remain visible because they are not routine lifecycle output.

## Plan

- [x] Add regression coverage for active and failed inhibitors in quiet mode, proving the inhibitor still starts while the `caffeinate` status remains cleared; the focused test failed in three expected assertions before implementation and passed 20/20 afterward.
- [x] Gate `pi-caffeinate` status publication on quiet mode and update its README contract; `TMPDIR="$(realpath "${TMPDIR:-/tmp}")" npm run check` and `npm run pack:caffeinate` passed.
- [x] Review the complete branch diff, commit only the issue-related files, push the branch, and open a PR that closes #214; verified by commit `4cc6c76` and PR #230.

## Risks

- Quiet mode must not disable the sleep inhibitor or suppress explicit command feedback and failure warnings.
- Switching into quiet mode during `/reload` must clear a status value published earlier in the session.

## Completion Checklist

- [x] `quiet: true` leaves the inhibitor active but no `caffeinate` status item is published, verified by `quiet mode keeps the inhibitor active without lifecycle UI output`.
- [x] Quiet-mode failure warnings remain visible without an `unavailable` status item, verified by `quiet mode preserves inhibitor failure warnings`.
- [x] Documentation describes quiet mode as suppressing routine lifecycle notifications and status output while preserving commands and warnings in `extensions/pi-caffeinate/README.md`.
- [x] Repository checks and the caffeinate package dry-run pass, verified by `npm run check` with canonical `TMPDIR` and `npm run pack:caffeinate`.
- [x] A focused commit is pushed and GitHub PR #230 closes #214: https://github.com/narumiruna/pi-extensions/pull/230.
