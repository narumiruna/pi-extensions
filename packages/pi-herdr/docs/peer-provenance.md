# Peer spawn provenance

The `pi-herdr` skill starts independent, equal-standing Pi sessions.
The spawn helper records who initiated a session; the widget reads that record without controlling the agents.
Neither a spawn edge nor a peer message grants authority.

## Wire record

The helper patches five public Herdr pane tokens with source `pi-herdr:spawn:v1` and no TTL:

| Token | Value |
| --- | --- |
| `pi_spawn_v` | Protocol version `1`. |
| `pi_spawn_origin` | Initiator's terminal ID, at most 80 Unicode characters. |
| `pi_spawn_from` | Initiator's session fingerprint. |
| `pi_spawn_to` | Started peer's session fingerprint. |
| `pi_spawn_label` | Sanitized initiator name or pane ID, at most 80 Unicode characters. |

A fingerprint is the lowercase hexadecimal SHA-256 digest of UTF-8 `JSON.stringify([terminal_id, source, agent, kind, value])`, using the complete public `agent_session` reference.
This version accepts only native `herdr:pi` / `pi` references with kind `id` or `path`.
Missing identity evidence prevents tracked startup; the helper does not invent an identity.
Only the digest crosses the metadata boundary, not the raw session path or ID.
Fingerprints are correlation keys, not authentication or a guarantee of anonymity.

Herdr tokens share one terminal-level map across sources.
The source scopes sequence handling, not token ownership; another caller can overwrite a key.
The helper writes only its five distinct keys and verifies their exact readback and both live session identities before attempting the task prompt.
Before CLI execution, it selects a canonical absolute Herdr executable outside the checkout and its Git ancestors, rejects project-local symlink targets, and skips relative `PATH` entries.
The skill's `--cli-path` preflight prints that path without launching Herdr; the probe and default helper runner use the same resolver, including on Windows where a bare command could otherwise use the project cwd.
This requires a trusted Node runtime and launch environment; it does not authenticate the selected external executable or the Herdr socket.
It leaves a partially created pane available for inspection after failure or cancellation and never retries an ambiguous submission automatically.
Stopping its CLI subprocess does not undo server-side changes or terminate the independent peer.

The widget ignores unsupported, incomplete, self-referential, cyclic, or target-mismatched records.
It resolves origins against the complete session snapshot before excluding the current pane or limiting visible rows.
Moves and renames retain a relationship when terminal and session identities still match.
A replacement target session cannot inherit the previous session's edge.
An absent, ambiguous, or replaced origin is shown as an unavailable captured origin, not attached to a different current occupant.

Omitted TTL means tokens remain in the running Herdr server until overwritten, cleared, or their pane closes.
They are not restored after a Herdr server restart.
The widget then shows ordinary unrelated agents rather than inferring history from layout or names.
There is no shared registry, background coordinator, or dependency on another extension.
Within one Pi process, copies of this package coordinate registration on the public synchronous `pi-herdr:runtime-claim:v1` event channel: a `{ version: 1, claimed: false }` probe is marked claimed by an already registered copy.
The claim is released on session shutdown and acquired again for the next session; Pi also disposes factory event subscriptions when its runtime is invalidated.
This prevents duplicate reporters from source/generated discovery without disabling unrelated extensions; it does not coordinate agents or deduplicate legacy integrations that lack this protocol.

## Refresh ordering

Token changes emit `pane.updated`, which the existing observer uses to request authoritative snapshots.
A native session-reference-only update does not necessarily emit an event.
Therefore each Pi `session_start` refreshes its existing five-key, TTL-bearing display metadata after its session report completes.
This refresh is forced even if another event published the same metadata while startup was pending.
Changing the TTL deadline supplies the invalidation after identity reporting without adding a polling loop or a new display token.

The observer retains its coalesced reads, bounded retry, cancellation, generation checks, and passive widget behavior.
Like the existing status display, relationships describe the latest completed snapshot and can briefly lag newer events.
Reporting remains best-effort; acknowledgement does not guarantee that Herdr applied an identity report.
There is no atomic compare-and-set against a session identity, so read/check/write cannot exclude every concurrent takeover.
The native prompt endpoint separately checks known blocked state and foreground-agent ownership before writing terminal input.
It cannot prove that an unfamiliar dialog or a briefly focused draft is safe.

## Deterministic presentation evidence

The widget keeps its flat status order, five-row bound, workspace information, and existing separator/disclosure behavior.
Relation text uses the callback-provided muted theme role.
For an initiator observing two independent peers, the normalized body changes as follows:

```text
Before
◐ working  reviewer · p2 · work/w1
○ idle  researcher · p3 · work/w1

After
◐ working  reviewer · p2 · work/w1 · spawned by you
○ idle  researcher · p3 · work/w1 · spawned by you
```

A peer observing its initiator sees `spawned you` on that initiator's row.
Other origins use their live name and pane label/ID; unavailable origins use the captured label.
Tests exercise these normalized strings, nested edges without privileged roles, hidden origins, terminal controls, Unicode, zero/narrow widths, theme invalidation, session replacement, and authoritative refresh after stale events.
These are deterministic render examples, not physical-terminal screenshots.

## Maintainer verification

From the repository root, after the normal build prerequisites, run `npm run check` and `npm test` separately.
The package tests include the fake-CLI spawn state machine, producer/consumer round trips, native resource-loader discovery, extracted tarball resources, lifecycle ordering, and widget/observer behavior.

When Herdr is installed and the caller is already in a managed pane, run the repository-only public-contract probe:

```bash
node packages/pi-herdr/scripts/probe-provenance.mjs
```

On a Unix-like host with `/bin/sh`, the probe creates a uniquely named headless session and an inert shell process recognized as Pi, waits for readiness, and uses only that isolated session's public API.
It opens no TUI and makes no model request.
It checks native identity acquisition, shared token patches, TTL expiry/cancellation, metadata invalidations, identity replacement, move, rename, unchanged-identity re-report, and owned-key clearing, then stops and deletes its named session.
Do not restart a probe containing synthetic native session references because Herdr could try to resume them.
The contract was checked against the installed Herdr release and its [exact upstream implementation](https://github.com/herdrdev/herdr/tree/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01), including `src/terminal/state.rs`, `src/metadata_tokens.rs`, `src/app/api_helpers.rs`, and `src/app/api/panes.rs`.
Recheck the installed contract after an upstream compatibility change rather than assuming token or identity behavior from the schema alone.

## Remaining external checks

**Terminal operator:** after loading an updated build, inspect a real Pi peer pair in regular and fullscreen terminals, including narrow widths, labels, cross-workspace moves, rename, collapse/restore, and user takeover of a peer pane.
Expected result: readable provenance, preserved focus, and unchanged native interaction.
Physical rendering and subjective usability remain unverified by automated tests; do not claim this acceptance without evidence.

**Account owner:** only after authorization for provider usage and existing local authentication, run two Pi peers on independent tasks and exchange progress, a question/answer, and results.
Expected result: symmetric communication without a privileged parent, duplicate task submission, or mutual synchronous waits.
Actual provider latency, entitlement, model compliance, and terminal/keybinding-specific delivery remain unverified without that check.
Do not request secrets, bypass MFA, incur unauthorized costs, or claim live-provider end-to-end verification.

Package publication, tags, visibility changes, and release workflow dispatch require separate explicit approval.
