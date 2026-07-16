## Goal

Ensure subprocess timeout and cancellation cleanup can terminate a still-live POSIX process group when its leader has exited but a descendant keeps inherited output pipes open.

## Plan

- [x] Add a deterministic regression where the subprocess leader exits before a descendant holding stdout; the focused test took about 2 seconds and failed the prompt-cleanup assertion before the fix.
- [x] Update the shared termination helper to treat the group as closed only when the leader has exited and captured output streams have ended; both focused termination tests pass.
- [x] Scan timeout and abort callers, run the repository verification gate, and confirm the PR diff remains bounded; both callers share `terminateProcess` and `npm run check` passed 505 tests.

## Risks

- POSIX group signaling has no Windows equivalent; keep the existing Windows behavior and skip the group-specific regression there.
- Avoid signaling a reused process group after all captured streams have already closed.

## Completion Checklist

- [x] An exited leader with a live descendant is cleaned up promptly, proven by the focused regression completing in about 64 ms.
- [x] Existing SIGTERM-to-SIGKILL escalation behavior remains covered and passing.
- [x] `npm run check` passed 505 tests and `git diff --check` passed before the follow-up was pushed.
