# Command output limits

Each active `pi.exec` consumer sets a local limit for combined stdout and stderr. An overflow is a failed execution, not a timeout or complete reply. No shared execution framework or user setting controls these limits.

## Inventory

Limits are bytes per command, not character or line counts. KiB means 1,024 bytes; MiB means 1,048,576 bytes.

| Owner and execution boundary | Operations | Combined limit | Reason and overflow behavior |
| --- | --- | --- | --- |
| `packages/pi-worktree/src/git.ts`: native and injected Git executor | Paths, branches, commit IDs, existence checks, sparse-checkout configuration, quiet index checks | 64 KiB | These commands return one small value or only diagnostics. Reject overflow before parsing or interpreting an expected nonzero exit. |
| Worktree Git executor | Worktree listings, removal inventories, index flags, submodules, administrative refs, containing refs, prune previews | 8 MiB | These operations can list many paths or records. Reject incomplete inventories rather than approve removal or pruning from a prefix. |
| Worktree Git executor | Add, remove, prune | 1 MiB | Allow progress and hook diagnostics without retaining unlimited output. Report overflow and require inspection of Git state before retrying: a mutation can finish before its output exceeds the limit. |
| Worktree stdin-only Git executor | `sparse-checkout check-rules -z` | 8 MiB | Pi exec has no stdin option. Retain the existing spawn implementation, bound both streams, and reject overflow before the unsupported-Git fallback or path parsing. |
| `packages/pi-worktree/src/status.ts` | Porcelain status; last-commit date and subject | 8 MiB; 64 KiB | Status can list every path; one commit has a much smaller budget. Show the affected card as unavailable with an overflow diagnostic. |
| `packages/pi-github-pr/src/github-pr.ts` | PR JSON; GraphQL comment counts; Git HEAD path | 1 MiB; 64 KiB; 16 KiB | PR JSON includes reviews and checks, the count query returns two values, and HEAD returns one path. Reject incomplete JSON with a command-specific overflow error; do not create a watcher from an incomplete path. |
| `packages/pi-statusline/src/git-status.ts` | Porcelain status; Git root path | 1 MiB; 16 KiB | Allow a large status listing and a small absolute path. Omit incomplete status or root information without disrupting polling or replacement cleanup. |
| `packages/pi-starship/src/modules/git/runtime.ts`: native and injected Git executor | Porcelain status, repository metadata, metrics, tags, and bare-repository probes | 64 KiB | Preserve the existing footer budget and pass it to Pi before collection. Reject truncated replies before parsing or the bare-repository fallback; omit unavailable optional fields. |
| `packages/pi-starship/src/runtime/helpers.ts` and `command.ts` | Injected workspace version, health, environment, deployment, and repository probes | 64 KiB | The existing combined cap is sufficient for short footer metadata. Keep process-tree cleanup and report truncation explicitly; injected results must also satisfy the combined limit. |
| `packages/pi-starship/src/runtime/github-pr.ts` | Injected PR JSON query | 128 KiB | The existing cap is sufficient for one PR's selected fields and bounded check summaries. Reject truncated JSON and combined stream overflow. |
| `packages/pi-langfuse/src/git.ts`, forwarded by `pi-session.ts` | Branch and commit metadata | 4 KiB | A branch is limited to 256 characters and a commit ID to 64 hexadecimal characters. Allow small diagnostics; omit incomplete optional metadata, including the detached-HEAD decision. |
| `packages/pi-fleet/src/terminal.ts`, forwarded to the tmux, Ghostty, and Zellij adapters | Version, pane creation, pane placement | 16 KiB | Version strings and identities are short. Reject overflow before parsing or timeout/abort classification. Creation failures retain the partial-launch marker but never trust an incomplete identity; placement failures retain an already verified identity. |
| `packages/pi-inspect/src/extension.ts` | Platform browser launcher | 16 KiB | Launchers return no application data. Use the private URL fallback on overflow without logging launcher diagnostics or changing server ownership. |

Fleet's injected adapter result types keep an optional `truncated` field for existing non-Pi executors; the default Pi executor always supplies it. Starship's workspace executor reports the field on every result. Tests that adapt Pi exec to a workspace executor forward the workspace limit as `maxBuffer`.

The inventory includes direct calls, chained `.exec` calls, `Pick<ExtensionAPI, "exec">` clients, `ExtensionAPI["exec"]` injection, and forwarding closures. Project-local extensions have no Pi exec consumers. Archived code under `deprecated/`, regular-expression `.exec`, database execution, and separate non-Pi process implementations are not active Pi exec boundaries.

## Failure and lifecycle contract

- Check `truncated` before success, expected-nonzero fallbacks, timeout classification, or structured-data parsing.
  - Passive status and optional trace metadata omit incomplete data.
  - Command failures identify overflow without presenting partial command output as complete data.
- Preserve each operation's timeout, abort signal, spawn-error handling, session/generation guards, and cleanup.
- Keep UTF-8 chunk decoding and termination escalation in Pi for native exec calls.
  - Existing stdin-only and environment-aware executors retain their own process contracts; this change does not replace them with a copy of Pi's implementation.
- Do not use an incomplete pane identity, path, Git inventory, or JSON reply to start follow-up work.

## Verification

`test/pi-exec-output.test.ts` exercises the real Pi extension API through its resource loader: exact combined limits, partial JSON overflow, combined stdout/stderr overflow, spawn diagnostics, timeout and abort after a readiness handshake, split UTF-8 writes, and a cap inside a UTF-8 character. Package tests cover operation-specific caps, injected success-shaped truncated replies, fallback rejection, cancellation, polling recovery, stale-session results, and cleanup.

Use `npm run check` and `npm test` for the repository gates. Representative command smokes can use read-only Git and GitHub queries. Native macOS Ghostty automation, Zellij placement, and host browser opening require their respective runtime environments; deterministic adapter and lifecycle tests cover their changed result handling without launching a user interface. Maintainers with those environments can run the existing platform smokes or launch commands to confirm normal operation and cleanup. Native platform execution remains unverified; package publication requires separate approval.
