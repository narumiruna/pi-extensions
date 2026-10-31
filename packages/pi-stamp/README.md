# 🕒 pi-stamp — Add Timestamps and Timing to Pi's Transcript

[![npm](https://img.shields.io/npm/v/@narumitw/pi-stamp)](https://www.npmjs.com/package/@narumitw/pi-stamp) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Add a quiet, right-aligned timestamp after each user and assistant message in Pi's interactive transcript.
Optionally show response timing and output throughput, assistant provenance and usage, or tool duration and outcome.

## ✨ Features

- Shows each message's recorded creation time on a dim, right-aligned row.
- Supports 12/24-hour clocks, seconds, automatic date context, locales, and time zones.
- Applies metadata presets live to the original transcript Stamp rows before saving.
- Optionally shows response latency, average output throughput, elapsed time since user, model and provider identity, effective Pi Thinking level, stop reason, tokens, call cost, and cost since user.
- Optionally records tool duration and success or error after each complete tool block.
- Shows exact UTC ISO 8601 and Unix millisecond observation times only during transcript expansion.
- Keeps sensitive response IDs and bounded diagnostics behind explicit opt-in and transcript expansion.
- Persists exact session entries across reload and resume while keeping every stamp outside model context.
- Remains width-safe and owns no timer, process, watcher, network request, model tool, or persistent status.

## 📦 Install

Install from npm:

```bash
pi install npm:@narumitw/pi-stamp
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-stamp
```

Try this package from a local checkout:

```bash
npm --workspace @narumitw/pi-stamp run build
pi --no-extensions -e ./packages/pi-stamp
```

The package declares `dist/index.ts`, so build an unbuilt local checkout before Pi loads the package directory.
The isolated local command avoids loading an installed copy at the same time.
Install only from sources you trust because Pi extensions run with Pi's permissions.

## 🚀 Quick start

Load the extension and use Pi normally.
Each new user and assistant message receives a separate dim stamp aligned to the terminal's right edge:

```text
Your message
                                 14:32:08

Assistant reply
                                 14:32:11
```

Run `/stamp` and choose **Presets**. In TUI, move through the list to change the Stamp rows attached to the original assistant responses immediately, then confirm a preset to save it. Use **Settings** to adjust individual fields.
There is no separate preview block. A Stamp without saved metadata can display ordinary fields from its matching response in the active session branch. This does not rewrite history or read response content, IDs, diagnostics, or unrecorded Thinking values.
Presets leave timestamps, response timing, throughput, since-user controls, and tool stamps unchanged.
Settings edits save immediately. Closing a preview removes it without undoing confirmed saves.
Existing compatible stamps reformat on the next render.

## 💬 Commands

Run `/stamp` in TUI or RPC mode to configure transcript timestamps, response metadata, and tool stamps, or inspect their effective settings.
The command rejects arguments, print mode, and JSON mode without changing settings.

## ⚙️ Settings

Use `/stamp` → **Presets** for assistant metadata starting points, or **Settings** for independent layout, field, timing, and tool controls.
The current preset is derived from the metadata settings; combinations that match no preset are **Custom**.
RPC provides an ordinary selector without cursor previews.
New defaults show local `HH:mm:ss`, add dates at day changes, and keep metadata hidden.
Response IDs and diagnostic summaries require separate opt-in and remain hidden until transcript expansion.

The canonical user file is:

```text
~/.pi/agent/pi-stamp.json
```

Pi's configured agent directory replaces `~/.pi/agent` when applicable.
The file is a partial JSON object.
For example, show Taipei time with only the requested model and reported call cost:

```json
{
  "timeZone": "Asia/Taipei",
  "showRequestedModel": true,
  "showCallCost": true
}
```

There are no project settings or extension-specific environment overrides.
Confirmed presets and Settings edits apply immediately; manual edits load at startup, `/reload`, or session replacement.
Missing settings do not create a file or directory, and invalid files block saving instead of being overwritten.
Fix an invalid file and run `/reload`; a running process retains its last valid settings.

Read the [settings reference](./docs/settings.md) for all fields, preset contents, legacy-setting compatibility, precedence, and persistence guarantees.

Transcript stamps are appended only in TUI mode; RPC provides configuration dialogs without adding transcript entries.

## 🕰️ Timestamp and response timing

- A **user** stamp is the timestamp recorded when Pi creates the submitted user message.
- An **assistant** clock is the timestamp recorded when Pi creates the response stream/message.
- New assistant entries separately record when this extension observes Pi's final `message_end`.
  `responseTiming: "duration"` shows creation-to-completion elapsed time:

  ```text
  14:32:08 · 3.2s
  ```

- `responseTiming: "detailed"` distinguishes the first meaningful streamed content observed by Pi from total completion:

  ```text
  14:32:08 · first 0.8s · total 3.2s
  ```

First content is the first non-empty text, thinking, or tool-call update observed by Pi.
It is not a provider-server timestamp or guaranteed time to first token.
`first n/a` means Pi finalized the response without such an update; completion time is not substituted.

- If an assistant message invokes tools, response timing ends at the assistant's `message_end` and excludes tool execution even though the assistant stamp appears after the complete tool block.
- Error and aborted assistant messages use the same local completion boundary.
  Invalid or backwards clock observations degrade to timestamp-only data rather than showing a negative or clamped value.
- `dateContext: "day-change"` compares each newly recorded message stamp with its persisted predecessor in the selected time zone.
  The first known stamp stays time-only.
- Changing presentation settings re-renders compatible recorded stamps without rewriting session files.

Use Pi's transcript expansion action (`app.tools.expand`, `Ctrl+O` by default) to show an exact timeline after each compatible stamp.
Each available creation, first-content, completion, tool-start, or tool-completion observation appears as UTC ISO 8601 plus its original Unix millisecond value.
Legacy entries show only boundaries that their persisted version retained.
These rows are hidden in the collapsed transcript, require no new session data, and can be disabled with `showExactTimeline`.

Timing labels are local Pi lifecycle observations, not provider latency telemetry.
They require no network request or refresh task.
Relative labels such as `3m ago` remain unavailable because they would require periodic background refresh and lifecycle cleanup.

### Output throughput

Enable **Show output throughput** in `/stamp` Settings (`showOutputThroughput: true`) to add an average rate to the timing row:

```text
14:32:08 · first 0.8s · total 3.2s · 42 tok/s
```

The rate is `usage.output / ((completedAt - timestamp) / 1000)`: reported output tokens divided by the exact time from message creation to the observed `message_end`.
It includes waiting and reasoning time, excludes tool execution, and is **not server generation speed**.
Reasoning tokens are not added again, and first-content timing is not used as the denominator.

The setting defaults off and works independently of response timing, assistant metadata, and cost/time since user.
While enabled, eligible responses persist their output count and timing inputs, not a rounded rate.
Normal, tool-call, and length-limited responses qualify; error and aborted responses, missing or invalid counts, and missing or non-positive durations show no rate.
Valid zero counts display `0 tok/s`; positive rates below `0.1` display `<0.1 tok/s`, and other rates use at most one decimal place.

Disabling the setting hides recorded rates without erasing data.
Older stamps can show throughput only if they already contain valid output usage, an eligible stop reason, and completion timing; timestamp-only history is not backfilled.

### Time since user

Enable `showTimeSinceUser` in `/stamp` Settings to record elapsed wall-clock time from the latest user message's recorded timestamp to each non-`toolUse` assistant response's observed completion:

```text
14:32:08 · since user 1m 24s
```

This includes intermediate assistant calls, tools, retry delays, and pauses.
Every user message resets the starting point, including steering and queued follow-ups.
Error, aborted, and length-limited responses use the same completion boundary.
If the agent produces a new response after resuming without another user message, that new response includes the intervening idle time.

Each duration is captured once and persisted; rendering, `/reload`, resume, compaction, and tree navigation never recalculate an existing stamp.
New responses use the latest user message on their active branch.
Missing, invalid, or backwards timing boundaries omit the duration rather than inventing one.
Older stamps are not backfilled, and disabling the setting hides recorded durations without erasing them.

Time since user works independently of assistant metadata, cost since user, and response timing.
With `responseTiming: "duration"`, the single-response duration is labeled separately:

```text
14:32:08 · response 3.2s · since user 1m 24s
```

Sub-minute durations use tenths of a second; longer durations show whole minutes and seconds, with hours when needed.

## 🧾 Assistant provenance and usage

Enable individual metadata fields in Settings or choose a preset.
While any metadata field is enabled, finalized stamps retain a compatible snapshot of reported provenance and usage so recorded fields can be shown later without rewriting history.
`showPiThinkingLevel` independently captures Pi's effective turn setting as Pi provenance, not provider-reported reasoning behavior.
A compact stamp can look like:

```text
14:32:08 · 3.2s
claude-sonnet-4-6 · thinking high · 842 tok · est $0.018
```

With both model fields enabled, compact layout keeps distinct requested and response models:

```text
requested-alias → provider-response-model · 842 tok
```

Layout changes only presentation, not the selected fields.
`stopReason` independently selects hidden, abnormal-only, or all outcomes in either layout.
Disabling `showPiThinkingLevel` prevents new Thinking-level capture and hides recorded values.
Provider, API, each model field, each token count, and call cost have separate display controls.
Missing values stay absent; `pi-stamp` never derives a Thinking level, token total, response model, cost, or diagnostic message.

Use Pi's transcript expansion action (`app.tools.expand`, `Ctrl+O` by default) to open the debug view.
Enable `showResponseId` or `showDiagnostics` explicitly to capture and show those expansion-only fields.
Neither is enabled by the new presets.
Diagnostics retain at most five summaries.
A summary contains only diagnostic type, error name, and error code.
Stamp data never copies diagnostic messages, stacks, details, raw payloads, message content, tool arguments, or `textSignature`, `thinkingSignature`, and `thoughtSignature` fields.
Terminal controls are removed and retained text is bounded before persistence.

Provider support varies.
Every optional field is shown only when present and valid on that finalized assistant message.
The cost label says `est` because Pi's message value is an estimate based on the provider/model usage data available to Pi; the extension performs no price lookup.

### Cost since user

Cost since user is the cumulative estimated cost from the latest user message through the final response.
With `showCostSinceUser: true`, each finalized assistant call, tool result, and persisted cache-warming usage entry contributes its separately reported `usage.cost.total` to that running total.
A user message resets it, including a steering or queued follow-up user message.
Tool-use calls, model-backed or paid tools that report usage, retries, automatic continuations, and model runs started by extensions all keep accumulating until another user message arrives.
The next assistant response whose stop reason is not `toolUse` records and displays both its call cost and that total:

```text
claude-sonnet-4-6 · thinking high · 842 tok · est $0.009 · since user $0.039
```

Cost since user reads only the reported cost field and does not require metadata capture.
With metadata hidden, the final stamp uses a separate cost-only row.
This independently enabled control retains the final call cost even when `showCallCost` is off; intermediate `toolUse` stamps show call cost only when `showCallCost` is enabled.
Missing or invalid reported costs are omitted rather than estimated, while valid reported zero costs still count toward the total.

## 🛠️ Tool timing

With `toolStamps: true`, the extension observes `tool_execution_start` and `tool_execution_end`, pairs them by exact `toolCallId`, and appends entries in `turn_end.toolResults` source order:

```text
tool read · 1.3s · success
tool bash · 2.5s · error
```

The duration is the extension's local start-to-end observation.
Outcome is Pi's final `isError` state; it is not inferred from tool text.
Tool arguments, output, result details, and IDs are never shown.
Because Pi's public API cannot decorate built-in tool rows, stamps appear as separate rows after the complete tool block.

The tracker owns at most 256 observations in one turn.
Duplicate, unmatched, malformed, backwards, or excess observations are ignored.
Pending state is cleared on a new turn, agent cancellation/end, session replacement, reload, and shutdown.
Tools that were not observed while tool stamps were enabled are not backfilled.

## 🔒 Security and privacy

Stamps are Pi custom session entries that appear in the interactive transcript but stay outside model context.
The extension does not modify user, assistant, or tool-result content.

## 💾 Persistence and compatibility

Message entry compatibility is cumulative:

- Version 1 stores role and creation timestamp.
- Version 2 adds the previous message-stamp timestamp for live date-boundary formatting.
- Version 3 assistant entries add completion and optional first-content observations.
- Version 4 assistant entries add a sanitized metadata snapshot when metadata capture is enabled.
  Timing remains optional so a valid metadata stamp survives a backwards timing clock.
- Version 5 assistant entries add Pi's validated effective turn Thinking level when metadata capture is enabled and the runtime exposes it.
- Version 6 assistant entries add the optional call cost and cost since user.
  Full assistant metadata and Thinking level remain optional in this version.
- Version 7 assistant entries add fixed elapsed milliseconds since the latest user message and require a completion observation.
  Cost, full assistant metadata, and Thinking level remain optional.
- Version 8 assistant entries add an independently captured output-token count for throughput and require positive creation-to-completion time.
  Time since user, cost, full assistant metadata, and Thinking level remain optional.
- Version 1 tool entries store only bounded association/timing/outcome data.

Existing versions remain readable.
Changing settings never rewrites session history.
Once recorded, a stamp survives `/reload` and session resume while the extension remains loaded.
Messages and tools created before `pi-stamp` observed them are not backfilled because Pi cannot insert a new custom entry at an older session-tree position.

## 🚧 Limitations

- Pi does not currently expose a public decorator for built-in message or tool rows, so stamps appear as separate transcript rows rather than inside the original bubble/block.
- In short regular-mode terminals, the Presets menu can push changed Stamp rows into scrollback; enlarge the terminal to see them while selecting.
- Another extension can append transcript entries at the same lifecycle boundary, so strict visual adjacency between independently loaded extensions is not guaranteed.
- There are no arbitrary format strings, relative labels, provider-server latency, token aggregates, raw diagnostics, or analytics dashboard.
- Thinking level is Pi's effective turn setting and does not claim that a provider honored or reported the same reasoning behavior.
- Token and cost values come only from Pi's message fields.

## 🗂️ Package layout

```text
packages/pi-stamp/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── stamp.ts                       # Transcript entries and rendering lifecycle
├── docs/                              # Settings and compatibility reference
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, message timestamps, assistant provenance, token usage, tool timing, transcript metadata, TUI metadata, TypeScript Pi package.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
