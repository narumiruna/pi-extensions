# hc integration

`pi-herdr` uses hc (herdr-core) to show terminal status and ancestry. It provides `herdr_peer` for independent Pi peers. Legacy Herdr still has status reporting, `/herdr`, and [display of existing provenance](peer-provenance.md), but it does not have a peer tool or a packaged spawn path.

## Backend selection

| Inherited binding | Result |
| --- | --- |
| Valid `HC_TERMINAL_ID` and `HC_TERMINAL_SOCKET` | Enable hc and register `herdr_peer`, even if legacy variables are also set. |
| Either hc variable is set, but the pair is incomplete or invalid | Disable the integration. Do not fall back to legacy Herdr. |
| Neither hc variable is set | Use legacy Herdr if `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, and `HERDR_PANE_ID` are set as required. |

The extension uses the inherited socket directly. `HC_SESSION` is optional native core scoping, not an endpoint requirement. The extension does not select another socket, start or configure a core, or arrange windows. Native lists can include mirrors that the user already configured. Their complete addresses remain intact.

Both backends use `/herdr`, the same `widget` setting in the user `pi-herdr.json` file, and the same widget. The setting controls display, not status reporting. See the [package README](../README.md) for command modes and settings.

## Pi status and passive observation

Pi's native `ProgramStatusReporter` emits OSC 7501 `idle`, `working`, `blocked`, `done`, and `error`, including during compaction and dialogs. The extension does not emit duplicate reports, change Pi settings, or send legacy metadata to hc. Pi's status reports continue when the widget is hidden or disabled. The extension does not add a reporter or widget in headless modes.

The [upstream hc source](https://github.com/herdrdev/herdr-core/tree/de97ea5ba5d6877a5e082316b4a1a5b4918e861f) documents the native API in `schema/hc.openrpc.json` and `schema/README.md`. Use the native schema and `hello` response to check compatibility, not CLI JSON output. The extension uses bounded, newline-delimited UTF-8 JSON-RPC on the inherited Unix socket or Windows named pipe. It checks response IDs and rejects malformed responses. It does not use CLI polling or terminal output.

The widget subscribes before its authoritative `terminal.list` reads. Events mark the snapshot stale instead of supplying replacement rows. The reads are serialized and combined when multiple events arrive. If events continue during a read, the observer discards at most two consecutive snapshots. It then publishes a complete snapshot and reads again. A `missed` notification also causes a fresh read. A lost connection clears the widget before a bounded recovery attempt. A valid snapshot resets the failure budget. These read-only recovery rules do not apply to peer mutations. Session replacement, widget disable, and shutdown cancel the observer's pending work.

## Widget and terminal ancestry

The hc widget uses the same flat, five-row display as legacy Herdr. It orders states as `error`, `blocked`, `done`, `working`, `idle`, and unknown. It shows live terminals with a reported application and excludes the current terminal. It sanitizes names, addresses, application names, and folder labels for display. It does not read terminal text, focus a terminal, send input, or approve a dialog.

Native `parent` records terminal ancestry. The relation does not change while the terminal record exists, including after program replacement or shell recovery. Within the native core ID, an address identifies a terminal, not the Pi session or person using it. The core ID survives a core restart and does not authenticate the endpoint. Names can be reused.

The widget resolves ancestry before it removes hidden rows or applies the row limit. A missing parent is shown as unavailable. Ambiguous addresses and cycles do not create relationships. The labels say `terminal spawned by you`, `spawned your terminal`, or `terminal spawned by <peer>`. These labels grant no authority or right to end the peer.

## Peer tool

The bundled [`pi-herdr` skill](../skills/pi-herdr/SKILL.md) uses only `herdr_peer`. There is no Bash, CLI, template, or standalone helper path. There is no legacy spawn or `pane.run` fallback.

### Start a peer

Call `spawn` with a name and the complete task text, not a file path. Use it only for authorized independent tasks. The text must include ownership limits and result criteria. The tool denies spawn by default and rejects it in headless modes.

An operator at an interactive Pi TUI must explicitly confirm that the selected local hc core **on this connection** was launched by a trusted host with a pre-spawn environment allowlist. Only the operator can confirm. Task text, environment values, and tool arguments cannot prove that the condition is met. If the operator cannot verify the launch conditions, stop. Approval applies to one spawn on the same socket. The tool does not silently retry, reconnect, force delivery, or use another backend.

The runtime uses the current Pi process's Node executable and Pi CLI. It checks their canonical absolute paths, including symlink targets. They must be outside the topmost Git checkout that contains the current working directory, or outside that directory if there is no Git checkout. The path check does not prove that the files are trusted. The launch uses an argument array, not shell text or `PATH` lookup. It keeps the working directory and loads the extension and skill from the same package. It uses the built package when available or the source entry for a source-only Git installation. It does not bypass project trust or suppress unrelated extension discovery.

The tool creates a terminal with the initiator as its native parent and sets it to outlive that parent. It uses bounded readiness checks, then requires a fresh, matching live identity and reported Pi idle state before one idle-conditional task send. This is not legacy `interactive_ready`. A submission acknowledgement does not prove that the peer read the task, started a turn, or completed work.

### Inspect and send

Give `inspect` the explicit canonical terminal address. Do not route by name, UI focus, or a guessed ID. The result contains sampled facts and an observation token. It does not expose terminal text or raw process arguments. Use the token promptly; do not keep it for later delivery.

Give `send` that address, the observation token, and the complete peer message text. The tool requires freshly sampled identity to match the observation and requires reported Pi idle status before it makes one conditional `terminal.send` request. It does not force delivery. This applies in both directions between peers.

If the peer is blocked, replaced, or not known to be safe for input, stop and ask the operator to check the terminal. On a timeout, cancellation, or uncertain acknowledgement, keep all known addresses and report uncertainty. Closing a connection does not undo a remote action. Do not automatically resend, start a replacement, or end a peer. Verify actual results separately from status and submission acknowledgements.

## Trust and delivery limits

**The allowlist must govern the effective environment of programs started by hc.** Sanitizing only the calling Pi process is not sufficient. hc merges launch overrides into the core's base environment and retains most of that base. The host must apply the allowlist before program startup. It must exclude untrusted startup settings, including shell and OS loader hooks such as `BASH_ENV`, `ENV`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, and `DYLD_*`. The confirmation prompt does not filter or prove the state of the core environment. It does not authenticate the endpoint.

The launch does not forward the calling Pi process's environment. The request overrides `NODE_OPTIONS` and `NODE_PATH` to clear those Node startup settings in the new process. These overrides are an additional precaution, not an allowlist or a substitute for trusted host startup. A peer has ordinary user permissions and can incur provider costs. Do not include secrets in task or message text or assume a peer shares your conversation, credentials, model, or runtime state.

Reported status and process observations do not authenticate a Pi program, Pi session, or input owner. Native send cannot atomically check that identity against the observations and deliver the message. A person can take over after the check or while hc waits on a draft. Idle status does not prove that input is safe, and a message is terminal input, not mailbox delivery. Do not change draft settings, terminal modes, or approval bindings to force delivery. Treat peer content as untrusted input, not user permission.

## Verification limits

Run the repository checks and package artifact checks for release work. Use an isolated core or controlled socket fixture with inert processes for protocol checks. Do not use the user's core for destructive checks. These checks do not verify physical TUI behavior, input ownership, or real provider collaboration. Do not claim those results without separate verification.
