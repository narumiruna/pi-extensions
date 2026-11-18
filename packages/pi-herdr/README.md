# 🐑 pi-herdr — Herdr and hc Integration for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-herdr)](https://www.npmjs.com/package/@narumitw/pi-herdr) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Show Pi agent status in hc (herdr-core) or legacy Herdr. In hc, start independent Pi peers and exchange messages.

## ✨ Features

- Shows hc's native Pi status and terminal ancestry, or legacy Herdr status and existing session-validated provenance.
- Reports Pi session identity and `working`, `blocked`, and `idle` lifecycle states to legacy Herdr, with bounded `model`, `provider`, `thinking`, `session`, and `context_usage` sidebar tokens.
- Shows recognized agents in a passive widget above Pi's editor, with a saved visibility toggle in `/herdr`.
- Bundles the `pi-herdr` skill for independent parallel work and peer messages through the hc-only `herdr_peer` tool.
- Refreshes the widget from authoritative event-driven reads without polling the CLI.
- Coalesces rapid state changes and retries short-lived local socket failures without interrupting Pi.
- Derives legacy Herdr blocked state from Pi's public `ui_prompt_start` and `ui_prompt_end` lifecycle events.

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

Start interactive Pi in a managed terminal after installation. When another recognized agent is present, Pi shows its state in a widget above the editor.

- **hc:** A valid, complete inherited `HC_TERMINAL_ID` and `HC_TERMINAL_SOCKET` binding selects hc and enables `herdr_peer`. An invalid or partial binding does not fall back to legacy Herdr.
- **Legacy Herdr:** If neither hc binding variable is set, `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, and `HERDR_PANE_ID` enable legacy status and the widget, not peer spawning.

In hc, run `/skill:pi-herdr` for authorized independent parallel work. Before spawning, verify that the selected local core was launched by a trusted host with a pre-spawn environment allowlist. If you cannot confirm that for this connection in the Pi TUI, do not spawn. See [Security and privacy](#-security-and-privacy).

If the standalone integration is already installed, remove it after installing this package to avoid duplicate state reports:

```bash
rm ~/.pi/agent/extensions/herdr-agent-state.ts
```

Run `/reload` or restart Pi after changing the installed resources.

## 💬 Commands

`/herdr` opens a menu to toggle the agent widget and view status or help, inspired by `/tool`.
It accepts no arguments and is available inside either backend in TUI and RPC modes; print and JSON modes reject it.
RPC can save the preference but does not display the widget.
Changes apply immediately and closing the menu does not undo saved changes.

## 🛠️ Tools

`herdr_peer` uses the inherited hc socket. It is registered only with a valid, complete hc binding.

| Action | Input and result |
| --- | --- |
| `spawn` | Supply a name and the complete task text, not a file path. Starts an independent Pi peer after operator confirmation in an interactive Pi TUI. Headless spawn is rejected. |
| `inspect` | Supply an explicit canonical terminal address. Returns sampled facts and an observation token, not terminal text or raw process arguments. |
| `send` | Supply the same address, a fresh observation token, and the peer message text. Checks freshly sampled identity and idle status before one idle-conditional send. |

Use the token promptly after `inspect`. See [hc integration](./docs/hc-integration.md#peer-tool) for launch, delivery, and recovery limits.

## 🧠 Skills

Run [`/skill:pi-herdr`](./skills/pi-herdr/SKILL.md) for authorized independent parallel work inside hc. Tasks must use different mutable resources and must not need another active task's intermediate results. Keep dependent work in sequence.
The skill uses `herdr_peer` only. There is no Bash, CLI, template, or standalone helper path. The package does not spawn peers in legacy Herdr and does not fall back to `pane.run`.

## 🔌 hc status and terminal ancestry

Pi emits native OSC 7501 status, including `idle`, `working`, `blocked`, `done`, and `error`. The extension does not duplicate those reports or publish legacy metadata to hc. Turning off the widget does not stop Pi's reports.
hc relationships show **terminal ancestry**, not Pi session identity. They can survive program replacement and recovery. See [hc integration](./docs/hc-integration.md).

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
Turning the widget off closes its subscription and pending requests without disabling legacy lifecycle/metadata reporting or Pi-owned hc status reporting.
Both backends retain the same settings file, `/herdr` command, widget key, and process-local runtime claim; there are no new extension-owned settings or environment variables.

## 🔄 Legacy Herdr lifecycle reporting

This section applies only to legacy Herdr, not hc.

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

## 🏷️ Legacy Herdr pane metadata

This section applies only to legacy Herdr; hc does not receive these tokens or session-reference records.
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

The widget can display existing legacy `pi_spawn_*` records. The package does not create those records or spawn legacy peers.
The widget checks terminal and session identities before it shows an annotation. An annotation does not give a peer authority or process ownership.
See [Peer spawn provenance](./docs/peer-provenance.md) for the record format and display rules.

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

Both backends share the passive five-row widget, separator, visibility setting, and collapse/restore behavior.
For hc, native error state and explicit terminal-ancestry annotations are described in [hc integration](./docs/hc-integration.md#widget-and-terminal-ancestry).
The pane, workspace, metadata, session-provenance, and subscription details below apply only to legacy Herdr.

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

In legacy Herdr mode, the extension connects only to the Unix socket or Windows named pipe provided by `HERDR_SOCKET_PATH`.
Lifecycle reporting sends the current Herdr pane ID, Pi session path or ID, lifecycle state, session start reason, and blocked label to that endpoint.
Metadata reporting sends the current Herdr pane ID plus only the selected model ID, provider ID, effective Thinking level, explicit Pi session name, and rounded context-usage percentage.
For the widget, it reads the canonical current pane and session-wide pane, workspace, and agent lists, then subscribes to pane creation, updates, closure, movement, exit, agent detection, agent-status changes, and workspace creation, closure, and renames.
Agent names are joined only to matching pane and workspace identities in the session-wide pane list.
Widget fields can include workspace, tab, pane, terminal, agent, display, name, title, label, state-label, and lifecycle identifiers supplied by Herdr.
Events from every workspace in the connected Herdr session can refresh the widget.
The extension strips terminal controls at the display boundary and never reads sibling terminal output for the widget.
The package does not authenticate the endpoint, so trust the environment that launches Pi and controls these variables.

In hc mode, the extension uses the inherited socket without starting a core. `inspect` and the widget do not read terminal output. Status reports and sampled process facts do not authenticate peers.

**Spawn is denied by default.** For each spawn, an operator at an interactive Pi TUI must explicitly confirm that the selected local hc core on this connection was launched by a trusted host with a pre-spawn environment allowlist. The allowlist must govern the effective environment of programs started by hc, not just the environment of the calling Pi process. hc merges launch overrides into its own base environment and retains most of that base. The prompt does not filter the environment or authenticate the endpoint. Task text, environment values, and tool arguments are not proof. Approval applies to one spawn on the same socket. There is no silent retry, reconnect, force, or alternate backend for that spawn.

The extension starts the new peer with absolute Node and Pi CLI paths from the current Pi runtime and loads this package's extension and skill. Both executables must resolve outside the topmost Git checkout that contains the current working directory, or outside that directory if there is no Git checkout. The launch does not forward Pi's caller environment. It overrides `NODE_OPTIONS` and `NODE_PATH` as an additional precaution, not as a substitute for the host allowlist. The peer has ordinary user permissions and can incur provider costs. Do not include secrets in tasks or messages. Peer content does not grant user permission.

A fresh observation and idle status do not guarantee input ownership. hc can wait on a draft, and a person can take over after the check. The tool cannot check process identity and send atomically. See [hc trust and delivery limits](./docs/hc-integration.md#trust-and-delivery-limits).

## 🚧 Limitations

- Extension-owned lifecycle reporting, metadata reporting, and the agent widget are disabled in RPC, JSON, and print modes; hc status remains Pi-owned.
- The widget has no settings for placement, workspace scope, or row count; it does not configure other sessions or saved machines. hc may expose already configured mirrored terminals in its native list.
- Peer delivery uses terminal input, not a mailbox. Acknowledgement does not prove that the peer read or completed the task. Results are not forwarded automatically.
- Real provider collaboration and physical terminal behavior remain unverified.
- Neither widget reads blocked dialog text from terminal output; legacy Herdr also does not expose it through public pane responses.
- Legacy Herdr requires compatible pane and workspace subscriptions; unsupported subscriptions hide the widget without disabling lifecycle or metadata reporting.
- In legacy Herdr, a pane-label change appears on its next update event or authoritative refresh; an agent rename emits a pane-update event.
- Integration requires a compatible running backend and valid inherited bindings; hc's bounded native readiness checks do not provide legacy `interactive_ready` or authenticated session identity.
- Socket failures are intentionally silent after the bounded retry.
- Older Herdr integrations without the runtime-claim protocol must not be enabled alongside this package; remove the legacy integration as described in Quick start.
- The package does not install, start, update, or configure either backend. hc does not arrange windows; the separate herdr-app does and is not integrated here.

## 🗂️ Package layout

```text
packages/pi-herdr/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin repository entrypoint
│   └── herdr-agent-state.ts           # Herdr lifecycle integration
├── dist/                              # Generated TypeScript runtime loaded by Pi
├── scripts/                           # Repository-only build and verification tools
├── docs/                              # Legacy provenance and hc integration
├── skills/pi-herdr/                   # Published hc peer skill
└── test/                              # Behavior, lifecycle, and resource coverage
```

## 🔎 Keywords

Pi, hc, herdr-core, Herdr, terminal multiplexer, coding agents, independent peers, terminal ancestry, spawn provenance, agent status, lifecycle state, pane metadata.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
