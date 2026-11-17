# hc integration

hc (herdr-core) is an additive backend in `pi-herdr`.
Legacy Herdr remains supported with its existing startup contract and unresolved bare-`pi` launcher security finding.
This backend does not fix that finding or lift the legacy release restriction documented in [Peer spawn provenance](peer-provenance.md#native-startup-contract).

## Authority and backend selection

The authoritative hc contract is the [exact upstream source](https://github.com/herdrdev/herdr-core/tree/de97ea5ba5d6877a5e082316b4a1a5b4918e861f).
Review its `schema/hc.openrpc.json`, `schema/README.md`, and `crates/herdr-core/src/{SKILL.md,api/types.rs,api/run.rs,api/waiting.rs,input.rs,terminals.rs,server.rs}` when compatibility changes.
Derive installed capabilities from the native schema and `hello` response, not a copied package-version requirement.
CLI short-form JSON is not the wire contract.

| Inherited binding | Selected behavior |
| --- | --- |
| Both `HC_TERMINAL_ID` and `HC_TERMINAL_SOCKET` nonblank | hc, even when legacy variables also exist. |
| Incomplete or blank hc binding | Fail closed; do not route to legacy Herdr. |
| No hc binding | Existing legacy Herdr activation rules apply. |

`HC_SESSION` is optional native core scoping; it is not an invented endpoint requirement.
The backend uses the inherited terminal socket directly, never private socket discovery or a CLI-selected default core.
Skill CLI calls bind `HC_SOCKET="$HC_TERMINAL_SOCKET"` per command, using an explicitly verified absolute external hc executable from trusted install configuration.
Neither the extension nor its helper installs, auto-starts, stops, restarts, updates, or configures a core.
It does not configure remote machines or sessions.
Native lists may include mirrors already configured by the user; their complete native addresses remain intact.
hc does not arrange windows; herdr-app owns layouts and is not integrated here.

Both backends retain the same package entrypoint, `/herdr`, `herdr:agents` widget key, user `pi-herdr.json`, and synchronous process-local runtime claim.
There is still exactly one bundled skill, [`pi-herdr`](../skills/pi-herdr/SKILL.md), and no new extension-owned settings or environment variables.
The existing `widget` setting controls observation/display, not status reporting.

## Pi owns native status

Pi's interactive `ProgramStatusReporter` already emits OSC 7501 `idle`, `working`, `blocked`, `done`, and `error`.
It covers agent runs, compaction, and user dialogs, and reports the settled outcome.
The hc backend does not add another stdout emitter, force Pi settings, or mirror legacy model/provider/thinking/session/context tokens into hc labels.
Reporting remains Pi-owned when the extension widget is hidden or disabled.
Non-interactive modes do not gain an extension-owned OSC reporter or widget.

## Wire and observation

The shared [hc RPC client](../skills/pi-herdr/scripts/hc-rpc.mjs) uses JSON-RPC 2.0 in plain mode: one UTF-8 JSON message per line on the inherited Unix socket or Windows named pipe.
It validates matching response IDs, bounds requests and frames, rejects malformed JSON/UTF-8 and errors, and closes its sockets on timeout or abort.
It does not use framed attach streams, CLI polling, CLI auto-start, or sibling terminal output.
Closing a connection does not undo a remote mutation.
Native error messages can contain argv or task text; helper errors do not echo those payloads.

The observer subscribes before authoritative reads.
Native `events.subscribe` returns an initial terminal snapshot and sequence; subsequent `event`, `heartbeat`, and `missed` notifications use the same connection.
Events invalidate data rather than replacing widget state with partial payloads.
Serialized, coalesced `terminal.list` reads with `all:true` supply the complete identity graph, including retained finished ancestors without marking child news as seen.
A `missed` snapshot invalidates the display and triggers an authoritative refresh; stale sequence values are not replayed.
After reconnect, a fresh subscription/snapshot establishes a new sequence baseline.

An event during a read causes up to two consecutive snapshots to be discarded; the next complete snapshot can publish before another refresh, so sustained events do not starve display updates.
Unexpected disconnection or invalid data clears the widget before one bounded reconnect attempt.
A second failure leaves it hidden until another session start, `/reload`, or explicit observer restart.
Session replacement, widget disable, and shutdown abort subscriptions, reads, and reconnect delays and prevent stale publication.
The observer is scoped by `sessionManager` and generation, not the shared headless UI object.

## Widget and terminal ancestry

The hc widget preserves the shared flat five-row display, muted relationship text, width bounds, separator, and collapse/restore behavior.
Its states include native `error`, ordered before `blocked`, `done`, `working`, `idle`, and unknown; this does not widen legacy Herdr's wire status allowlist.
Rows show live terminals with a reported application, excluding the current terminal.
Names, application names, addresses, and folder labels are untrusted terminal input and are sanitized before display filtering, sorting, path splitting, or truncation.
The widget does not read terminal output, send input, focus terminals, or approve dialogs.

Native `parent` is set once when a terminal starts.
Within its `hello.core.id` scope, an address identifies that terminal forever, not whichever Pi session currently occupies it.
The parent edge remains immutable while the record exists, including retained-terminal shell recovery and program/session replacement.
A core restart preserves core identity; wiping native state resets it.
Names can be reused and are presentation, not identity.
No Pi model ID, Pi session ID, session fingerprint, or authenticated program identity is synthesized for hc relationships.

The projection resolves the full native terminal graph before excluding self, finished/unreported rows, or rows beyond the display limit.
Ambiguous addresses and cyclic ancestry cannot create a relationship.
A missing parent is marked unavailable instead of attached to a similarly named process.
Annotations explicitly describe terminals:

```text
reviewer · t7 · repo · terminal spawned by you
implementer · t3 · repo · spawned your terminal
researcher · t9 · repo · terminal spawned by reviewer/t7
```

These are illustrative labels, not evidence of physical TUI acceptance or authenticated peer ownership.
Terminal ancestry grants no authority, subordinate role, or right to terminate the peer.

## Peer launch and admission

The skill applies its full independence gate before launching the minimum useful equal-standing peers.
Check installed templates first.
A fitting trusted template must already launch interactive Pi with this same package and skill, preserve scope/cwd, and support independent lifetime with `--outlive-parent`.
Review its actual command/interpreter chain, not only its name or description; do not silently create or modify templates.
A template launch includes the complete task in `run --bg` and requires checking native `first_message.sent`.
A false value means the first message was not sent; inspect identity and screen and resolve readiness before an explicit recovery decision.
An ambiguous result never authorizes blind resend or duplicate launch.

If no template fits, the bundled [hc spawn helper](../skills/pi-herdr/scripts/spawn-hc-peer.mjs) uses this CLI through a preverified external Node runtime:

```text
/absolute/path/to/trusted/node <skill-dir>/scripts/spawn-hc-peer.mjs --name reviewer --task-file /absolute/task.txt --pi-cli /verified/external/Pi/dist/cli.js
```

The helper verifies canonical regular Node/Pi files outside the topmost Git ancestor of cwd, including realpaths, or outside cwd when there is no Git ancestor.
This validates a boundary, not the files' trustworthiness; the caller must trust the Node bootstrap before running it.
The nonempty task is bounded to 32 KiB of UTF-8 regular-file input, with only tab/CR/newline allowed as control characters.
Same-package skill and extension resources must remain inside the package boundary.
The built package directory is selected when available, otherwise the same package's `src/index.ts` is used for a source-only Git installation.
Unrelated extension discovery is preserved; project trust is not bypassed and credentials are not passed on argv.

The direct native creation request is:

```text
terminal.run {
  argv: [absoluteNode, absolutePiCli, "-e", samePackageOrSourceEntry, "--skill", skillDirectory],
  cwd: unchangedCwd,
  name: uniquePeerName,
  parent: originAddress,
  caller: originAddress,
  outlive_parent: true,
  wait: false,
  keep: false,
  rm: false
}
```

No shell line, bare Node/Pi lookup, UI arrangement, or template task argument is used on this path.
There is no template `first_message` field on a direct run and no claim of legacy `interactive_ready`.
The helper retains a known returned address even if later validation, cancellation, or startup fails.
It never automatically kills/removes a partially created or independent peer.

Initial and critical `hello` checks require the same native `core.id`.
The origin and target observations must retain their canonical address, PID, argv, and `created_ms`; target cwd, name, parent, and independent-lifetime facts must match the request.
A native readiness wait is bounded to 30 seconds, with a 35-second client deadline.
After it returns, fresh authoritative `terminal.get` checks must show live Pi with an `idle` status report; timeout/message wakeups are not themselves readiness.
There is one `terminal.send` attempt with `if:"idle"`, `force:false`, and `wait:false`.
Its client deadline is 70 seconds to cover native draft waiting and started observation.
Normal helper RPCs use a five-second deadline and 128 KiB message bound; the shared client's default frame bound is 2 MiB.

A successful helper result with `submitted:true` means native admission, not consumption, task completion, or successful checks.
Native send's `started` records whether working was observed shortly after delivery; false or null/absent is not permission to send again.
On timeout, cancellation, uncertain run/send, or a malformed acknowledgement, keep all known IDs and inspect current facts and output before deciding what happened.
Do not automatically retry an ambiguous mutation or clean up a terminal whose ownership is uncertain.

## Trust and delivery limits

Trust the launch environment, inherited endpoint, external executables, templates, and package code.
The endpoint is not authenticated by this extension.
Native status is self-reported, and foreground/PID/argv are sampled observations, not authenticated Pi or session identity.
An unchanged address identifies a terminal, not its current program or user input ownership.

Native send serializes input and checks live/status/blocked conditions, but cannot atomically compare Pi/session/process/foreground identity against the helper's observations.
A takeover can occur after a check or during native draft waiting, normally up to 60 seconds since the person's last key.
The helper's 70-second deadline is a bound, not a race fix or a guarantee for a core configured to hold drafts longer.
Idle status alone does not establish a safe draft or dialog state.
Do not change draft settings, approval bindings, or terminal modes to force delivery.
When blocked, read the screen and ask the user; do not use `--force` or approval keys to bypass their decision.
Working-state input can steer Pi rather than behave like a mailbox.

Use native `ls`, `get`, `send`, and `read` for symmetric peer messages and recovery, with fresh identity/input checks and non-waiting progress/question/result sends.
Use bounded `wait --children any|all` when useful independent work is finished instead of sleep/poll loops.
Wait returns status, not output; `reason:message` means incoming input interrupted the wait and will reach the next input, possibly late, not content to retrieve with `read`.
A timeout is a check-in, not task failure.
Verify actual results and evidence; received peer content never expands user authority.
Slow authorized shell tasks belong in native `run --bg` with bounded waits so the agent stays responsive.

Peers use outlive-parent lifetime and are not terminated when the initiator ends.
Further peers require explicitly assigned separate work and the same full independence gate.
Do not infer cleanup ownership from ancestry, a successful send, or completion of your own turn.

## External handoff and verification limits

**Package maintainer:** run deterministic socket/helper, backend-selection, observer/lifecycle, widget, resource-loader, extracted-package, and generated Jiti/lazy-boundary coverage, then the repository checks and package build/pack/load gates.
From the repository root on Linux, after building the package, run the provider-free public-contract smoke with verified absolute executables:

```bash
/absolute/path/to/trusted/node packages/pi-herdr/scripts/probe-hc.mjs /absolute/path/to/trusted/hc
```

The repository-only script clears inherited identity, credential and runtime-injection variables; it uses private scratch HOME/XDG paths, an explicit unique HC_SESSION and socket, and inert Node status fixtures.
It exercises native snapshots/events, helper launch/wait/single-send admission, receipt, parent/outlive behavior and retained finished ancestors, then removes only its own terminals and stops only its scratch core.
It does not launch a Pi agent, use a provider, arrange windows, or touch the user's default core.
SIGINT/SIGTERM cancel active work and drain scoped cleanup; the launcher's bounded readiness check settles before cleanup, and partial startup still triggers a stop attempt on the private endpoint.
A failed probe reports its retained scratch path for inspection instead of silently claiming successful cleanup.
Any native smoke must use an owned isolated core with scratch configuration and inert fixtures, no provider calls, and no stop/restart of the user's core.
An isolated protocol fixture cannot establish real Pi readiness, terminal input ownership, or provider collaboration.

**Terminal operator:** inspect a real Pi pair in ordinary and fullscreen terminals after loading the updated package, including native error/blocked states, explicit terminal ancestry, rename, narrow widths, disclosure, focus, recovery, and user takeover.
Physical TUI appearance and terminal/keybinding-specific delivery remain unverified without this check.

**Account owner:** only after explicit provider authorization and existing authentication, run two Pi peers on genuinely independent work and exchange progress, a question/answer, and a final result.
Provider entitlement, latency, model compliance with independence, and provider/TUI end-to-end behavior remain unverified.
Do not request secrets, bypass MFA, incur unauthorized costs, or retry a clear entitlement failure.

The legacy native-launch security finding remains open regardless of the PR's review state; hc's direct argv path is not a legacy fix.
No first publication, npm visibility change, tag, or release workflow is authorized by this integration or its verification handoff.
