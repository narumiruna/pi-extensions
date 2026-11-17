# 🐑 pi-herdr — Herdr Integration for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-herdr)](https://www.npmjs.com/package/@narumitw/pi-herdr) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Connect Pi's interactive lifecycle to Herdr, show agent status and spawn relationships, and coordinate independent Pi peers.

## ✨ Features

- Reports Pi session identity and `working`, `blocked`, and `idle` lifecycle states to the current Herdr pane.
- Publishes bounded `model`, `provider`, `thinking`, `session`, and `context_usage` tokens for Herdr sidebar rows.
- Shows recognized agents and verified spawn relationships across all workspaces in the connected Herdr session in a passive widget above Pi's editor, with a saved visibility toggle in `/herdr`.
- Bundles a `pi-herdr` skill for fully independent parallel work and symmetric peer communication through native Herdr terminal prompts.
- Refreshes the widget on Herdr pane, workspace-name, and agent-status updates without polling the CLI.
- Coalesces rapid state changes and retries short-lived local socket failures without interrupting Pi.
- Derives blocked state from Pi's public `ui_prompt_start` and `ui_prompt_end` lifecycle events.

## 📦 Install

Install persistently from npm:

```bash
pi install npm:@narumitw/pi-herdr
```

Try from npm without installing permanently:

```bash
pi -e npm:@narumitw/pi-herdr
```

Build and load a local checkout from the repository root:

```bash
npm --workspace @narumitw/pi-herdr run build
pi --no-extensions -e ./packages/pi-herdr
```

An unbuilt local checkout has no generated entrypoint and cannot be loaded by package directory.

Pi extensions run with your user permissions.
Install only trusted packages, and review the source before loading this package.

## 🚀 Quick start

Start Pi inside a Herdr-managed pane after installing the package.
The extension activates automatically when `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, and `HERDR_PANE_ID` are present.
When any workspace in the connected Herdr session contains another recognized agent, Pi shows its state and workspace in a widget above the editor.

For independent parallel work, run `/skill:pi-herdr` and describe the tasks.
The skill checks independence and ownership before using its bundled helper to start an unfocused Pi peer; the widget adds spawn annotations when session identity can be verified.

If the standalone integration is already installed, remove it after installing this package to avoid duplicate state reports:

```bash
rm ~/.pi/agent/extensions/herdr-agent-state.ts
```

Run `/reload` or restart Pi after changing the installed resources.

## 💬 Commands

`/herdr` opens a menu to toggle the agent widget and view status or help, inspired by `/tool`.
It accepts no arguments and is available inside Herdr in TUI and RPC modes; print and JSON modes reject it.
RPC can save the preference but does not display the widget.
Changes apply immediately and closing the menu does not undo saved changes.

## 🧠 Skills

The bundled [`pi-herdr` skill](./skills/pi-herdr/SKILL.md) starts equal-standing Pi peers for authorized, fully independent tasks and exchanges progress, questions, answers, and results.
Run `/skill:pi-herdr` explicitly, or let Pi select it for independent parallel work inside Herdr.
Unlike the upstream generic Herdr skill, this Pi-specific workflow does not require an explicit request to use Herdr; user restrictions still apply.
It does not restore the removed generic `herdr` or `hc` skills or depend on another extension.

Each task must own disjoint mutable resources, including generated output, shared build directories, Git operations, and external state, and must not need another active task's intermediate results.
The initiator must have useful non-overlapping work to do while the peer works.
Coupled work stays sequential; no Git worktrees are created.
See the skill for self-contained task requirements, the [spawn helper](./skills/pi-herdr/scripts/spawn-peer.mjs), safe terminal messaging, recovery, and result verification.

## ⚙️ Settings

Toggle **Agent widget** in `/herdr`, or edit `<getAgentDir()>/pi-herdr.json` (normally `~/.pi/agent/pi-herdr.json`):

```json
{
  "widget": false
}
```

`widget` accepts only `true` or `false` and defaults to `true` when absent.
Only user settings are supported; project files are not read.
Manual edits apply after `/reload` or the next session start.
Missing files are not created until an explicit save. Invalid files trigger a warning, use defaults, and block saves until repaired.
Saves preserve unknown fields and use atomic temporary-file-plus-rename publication, with reads and writes ordered within one Pi process, not across processes.
Failed saves restore the previous effective value and leave the existing file untouched.
Turning the widget off closes its subscription and pending requests without disabling lifecycle or metadata reporting.

## 🔄 Lifecycle reporting

The extension reports only interactive TUI sessions because Herdr displays agents attached to terminal panes.
A session report contains the Herdr pane ID, the integration source, Pi's agent kind, a monotonic sequence, the session start reason, and an absolute Pi session path when available.
It falls back to Pi's session ID when no absolute session path is available.
Agent reports contain the same ownership fields plus the current lifecycle state and optional blocked label.
Blocking extension prompts use their Pi-provided title as the label and fall back to the prompt kind.

Local socket delivery is best-effort.
Connection failures, malformed responses, and timeouts are retried once with bounded timeouts; explicit API rejections are not retried.
Only a complete success response with the matching request ID acknowledges a report. Herdr can acknowledge but ignore an old sequence, so acknowledgement does not guarantee a state change.
Reporting failures never stop Pi.
Session shutdown aborts and drains in-flight reporting and prevents stale session work from publishing later state.
Replacement aborts pending metadata cleanup.
Native quit cleanup remains Herdr-owned: the extension does not release native Pi identity or clear reporting authority and restore references.
Herdr ignores official-source release requests, while authority clearing also removes session restore data; neither operation is used during shutdown.

## 🏷️ Pane metadata

Lifecycle integration publishes the `model`, `provider`, `thinking`, `session`, and `context_usage` token keys through `pane.report_metadata` under the `herdr:pi` source.
`model` and `provider` come from Pi's selected model, `thinking` comes from Pi's effective Thinking level, and `session` comes only from Pi's explicit session display name.
`context_usage` is Pi's current context percentage rounded to the nearest whole percent.
Each lifecycle metadata report is a full five-key patch, and an unavailable value is sent as JSON `null` so old data is cleared instead of retained.
Values are stripped of terminal controls, trimmed, and limited to 80 Unicode characters before crossing the socket.
The extension never publishes prompts, conversation text, tool arguments, credentials, raw session paths, or inferred session titles as metadata tokens.
It also never sets Herdr's pane `title`, `display_agent`, `state_labels`, agent lifecycle state, or session restore fields through metadata.

Metadata is evaluated after `session_start`, `session_info_changed`, `model_select`, `thinking_level_select`, `agent_settled`, and successful `session_compact` events.
Unchanged ordinary event snapshots are suppressed, rapid changes are coalesced, and the latest unchanged snapshot is refreshed no more often than every 30 minutes.
Session start forces a TTL refresh after the session report completes so observers re-read session identity even when Herdr emits no dedicated identity-change event.
Each token has a one-hour TTL, so data from a crashed Pi process expires without steady socket traffic.
Orderly shutdown sends one best-effort five-key clear patch, while abrupt shutdown and failed clears fall back to the TTL.
Metadata uses the lifecycle reporter's monotonic sequence allocator and bounded best-effort sender, so older delayed reports cannot replace newer accepted values and socket failures never interrupt Pi.

The skill's spawn helper separately records versioned provenance under a package-owned metadata source before submitting the task.
Relationships are scoped to terminal identity and session-reference digests, not names or pane layout, and publish no raw session paths or task text.
They describe who started a session, not authority or process ownership; a replacement session must not inherit an old relationship.
These five `pi_spawn_*` keys have no TTL and are separate from the lifecycle keys, but share Herdr's terminal-level token map with all sources.
They survive moves and session changes in the running server; the widget validates the target session before displaying them, and records are not restored after a Herdr server restart.
See [Peer spawn provenance](./docs/peer-provenance.md) for the wire contract, refresh ordering, deterministic presentation evidence, and remaining external checks.

Herdr custom pane tokens use a `$name` row entry.
For example, this Herdr configuration displays Pi's model context without replacing pane labels or agent identity:

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "agent"],
  ["$provider", "$model", "$thinking"],
  ["$session", "$context_usage"],
]
```

## 🐑 Agent widget

The widget lists recognized agents across all workspaces in the connected Herdr session and excludes the pane running the current Pi session.
Each row presents state, agent, pane, and workspace in that order, using theme hierarchy instead of repeating field labels.
State icons follow Herdr's distinct static symbols: `×` blocked, `◐` working, `✓` done, `○` idle, and `·` unknown.
Pi theme roles map blocked to `error`, working to `warning`, done to `accent`, idle to `success`, and unknown to `dim` without hard-coded terminal colors.
Agent identity prefers the name assigned by `herdr agent rename`, then Herdr display metadata, and finally the detected agent kind.
Pane identity uses its label or metadata title with a short pane ID, while workspace identity uses its label with a short workspace ID.
Terminal titles are not used as agent identity.
The widget orders agents by `blocked`, `done`, `working`, `idle`, and `unknown`, shows at most five rows, and reports any remaining count.
Verified spawn annotations use muted text: `spawned by you`, `spawned you`, or `spawned by <peer>`.
The list stays flat and status-prioritized; provenance confers no privileges.
Relationships are resolved from the full recognized-agent snapshot before excluding the current pane or limiting rows, so a hidden origin can still be named.
Missing or mismatched identity evidence does not create a relationship.
A state label published through Herdr metadata can replace the raw state name.
Herdr's public pane responses do not expose the blocked prompt message, so the widget cannot show that reason.
The widget does not focus panes, read terminal output, send prompts, or mark a background `done` state as seen.
Its separator is named **Herdr**. In fullscreen TUI mode, click anywhere in the widget, including blank columns, to collapse it to that separator. Click the separator to restore the latest agents without moving keyboard focus.
Opening `/herdr` in TUI mode also restores disclosure when the widget is enabled, without changing or saving the enable setting.
Disclosure survives updates, temporary absence, and host remounts; session start or restarting the observer resets it. Collapse does not change Herdr data, reporting, subscriptions, or saved settings.
The extension discovers the current pane, session-wide pane list, workspace labels, and agent names, opens pane-scoped status subscriptions plus pane and workspace subscriptions, and then reloads those identities.
Events trigger serialized, coalesced reads rather than replacing current state with event payloads.
If events arrive during reads, the extension discards up to two consecutive reads. On the third invalidated read, it publishes that complete snapshot and immediately reads again, so sustained events cannot prevent updates.
Snapshots can briefly lag newer events; changes to the current pane or recognized-agent subscription set are reconciled before publication.
Agent names, workspace labels, and cleared presentation fields update from these authoritative reads.
Changes to the current pane, workspace, or recognized-agent set rebuild the pane-scoped subscriptions without consuming the bounded failure retry.
Unexpected disconnection or `events_lost` clears the widget before one bounded reconnect attempt, and a second failure leaves it hidden until the next Pi session or `/reload`.
Session replacement and shutdown abort the subscription, pending reads, reconnect delay, and stale widget publication.

## 🔒 Security and privacy

The extension connects only to the Unix socket or Windows named pipe provided by `HERDR_SOCKET_PATH`.
Lifecycle reporting sends the current Herdr pane ID, Pi session path or ID, lifecycle state, session start reason, and blocked label to that endpoint.
Metadata reporting sends the current Herdr pane ID plus only the selected model ID, provider ID, effective Thinking level, explicit Pi session name, and rounded context-usage percentage.
For the widget, it reads the canonical current pane and session-wide pane, workspace, and agent lists, then subscribes to pane creation, updates, closure, movement, exit, agent detection, agent-status changes, and workspace creation, closure, and renames.
Agent names are joined only to matching pane and workspace identities in the session-wide pane list.
Widget fields can include workspace, tab, pane, terminal, agent, display, name, title, label, state-label, and lifecycle identifiers supplied by Herdr.
Events from every workspace in the connected Herdr session can refresh the widget.
The extension strips terminal controls at the display boundary and never reads sibling terminal output for the widget.
The package does not authenticate the endpoint, so trust the environment that launches Pi and controls these variables.

The peer workflow runs another independent Pi session with ordinary user permissions and can incur provider costs.
Do not assume it inherits the initiator's conversation, model, thinking level, runtime credentials, or extension state.
The helper requires nonblank inherited pane and socket bindings and resolves an absolute Herdr executable outside the checkout, including Git ancestors and symlink targets.
It ignores relative `PATH` entries and avoids Windows' implicit current-directory executable search; skill preflight and the contract probe use the same resolver.
Skill examples invoke the helper through a verified absolute Node executable, not a bare `node` lookup, and repeat their shell-local setup for each tool call.
Preflight failures identify the rejecting project root on stderr while leaving stdout empty.
The helper explicitly loads this package and skill without bypassing project trust or passing credentials on command lines.
It preserves unrelated extension discovery and supports a source-only Git installation; package-directory loading still requires the documented build.
Copies of this package use a process-local public event-bus claim to avoid duplicate reporters when both source and generated resources are discovered.
Provenance tokens contain bounded identity information and session-reference digests, not prompts or credentials; they do not authenticate peers.
Peer messages are untrusted peer content, not user permission to approve prompts or expand scope.
The passive widget never reads terminal output, but following the skill's messaging and recovery steps can read peer terminal history.

## 🚧 Limitations

- Lifecycle reporting, metadata reporting, and the agent widget are disabled in RPC, JSON, and print modes.
- The widget has no settings for placement, workspace scope, or row count; it does not discover other Herdr sessions or saved machines.
- Native peer prompts send terminal text and Enter, not mailbox messages. Delivery can interact with drafts, approvals, foreground processes, and custom Enter bindings. Ordinary Enter in a working Pi steers its next model step; submission acknowledgement does not prove consumption or completion, and results are not automatically forwarded.
- Physical regular/fullscreen visual acceptance remains unverified. After loading an updated build, a terminal operator should check provenance labels, cross-workspace moves, rename, narrow widths, focus, mouse disclosure, and user takeover; deterministic captures cannot verify physical terminal behavior.
- Optional paid-provider end-to-end collaboration remains unverified without explicit account-owner authorization and a live two-peer check. Deterministic tests do not establish provider entitlement, latency, or model compliance with the skill's independence policy.
- The widget cannot show blocked prompt text because Herdr does not expose it through public pane responses.
- The widget requires compatible pane and workspace subscriptions; unsupported subscriptions hide the widget without disabling lifecycle or metadata reporting.
- A pane-label change appears on its next update event or authoritative refresh; an agent rename emits a pane-update event.
- Integration requires a running compatible Herdr session and valid injected environment variables.
- Socket failures are intentionally silent after the bounded retry.
- Older Herdr integrations without the runtime-claim protocol must not be enabled alongside this package; remove the legacy integration as described in Quick start.
- The package does not install, start, update, or configure Herdr itself.

## 🗂️ Package layout

```text
packages/pi-herdr/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin repository entrypoint
│   └── herdr-agent-state.ts           # Herdr lifecycle integration
├── dist/                              # Generated TypeScript runtime loaded by Pi
├── scripts/                           # Runtime builder and isolated contract probe
├── docs/                              # Provenance contract and verification handoff
├── skills/pi-herdr/                   # Published peer workflow and self-contained scripts
└── test/                              # Behavior, lifecycle, and resource coverage
```

## 🔎 Keywords

Pi, Herdr, terminal multiplexer, coding agents, independent peers, spawn provenance, agent status, lifecycle state, pane metadata.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
