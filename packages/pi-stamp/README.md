# 🕒 pi-stamp — Add Timestamps and Timing to Pi's Transcript

[![npm](https://img.shields.io/npm/v/@narumitw/pi-stamp)](https://www.npmjs.com/package/@narumitw/pi-stamp) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Add a quiet, right-aligned timestamp after each user and assistant message in Pi's interactive transcript.
Optionally show response timing, assistant provenance and usage, or tool duration and outcome.

## ✨ Features

- Shows each message's recorded creation time on a dim, right-aligned row.
- Supports 12/24-hour clocks, seconds, automatic date context, locales, and time zones.
- Optionally shows response latency, model and provider identity, effective Pi Thinking level, stop reason, tokens, and estimated cost.
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
pi -e ./packages/pi-stamp
```

The package declares `dist/index.ts`, so build an unbuilt local checkout before Pi loads the package directory.
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

Run `/stamp` to open the presentation menu:

```text
Stamp
24-hour · seconds · Day changes · Invariant · Local · Timing off · Timeline shown · Metadata off · Thinking shown · Abnormal shown · Tool stamps hidden

Settings
Status
Help
Close
```

Settings save immediately.
Existing compatible stamps reformat on the next render, and new stamps use the same settings.

## 💬 Commands

Run `/stamp` in TUI or RPC mode to open Settings, Status, and Help.
The command rejects arguments, print mode, and JSON mode without changing settings.

## ⚙️ Settings

The `/stamp` Settings screen provides these controls:

| Field | Accepted values | Default | Behavior |
| --- | --- | --- | --- |
| `hourCycle` | `"24h"`, `"12h"` | `"24h"` | Selects the clock style. |
| `showSeconds` | boolean | `true` | Shows or hides seconds. |
| `dateContext` | `"day-change"`, `"always"`, `"never"` | `"day-change"` | Adds a date at recorded day boundaries, every time, or never. |
| `locale` | `"invariant"`, `"system"`, or one BCP 47 tag | `"invariant"` | Controls localized date/time presentation. |
| `timeZone` | `"local"` or one supported IANA zone | `"local"` | Controls time and day-boundary interpretation; `UTC` is accepted. |
| `responseTiming` | `"off"`, `"duration"`, `"detailed"` | `"off"` | Keeps timestamps minimal, adds total assistant duration, or labels first-content and total timing. |
| `showExactTimeline` | boolean | `true` | Shows exact UTC and Unix observation times when transcript details are expanded. |
| `assistantMetadata` | `"off"`, `"compact"`, `"expanded"` | `"off"` | Captures and shows no assistant metadata, a compact model/Thinking-level/total/cost summary, or all supported provenance and usage fields. |
| `showThinkingLevel` | boolean | `true` | Captures and shows Pi's effective turn Thinking level when assistant metadata is enabled. |
| `showCompactAbnormalOutcome` | boolean | `true` | Shows `length`, `error`, and `aborted` stop reasons in compact assistant metadata. |
| `toolStamps` | boolean | `false` | Records and shows duration plus success/error for newly observed tools. |

The compatibility defaults produce local `HH:mm:ss` for ordinary same-day messages.
`invariant` uses Gregorian ISO dates, Latin digits, and English `AM`/`PM`.
`system` uses the operating system locale; examples of explicit locales are `en-US`, `fr-FR`, and `zh-TW`.

The canonical user file is:

```text
~/.pi/agent/pi-stamp.json
```

Pi's configured agent directory replaces `~/.pi/agent` when applicable.
The file is a partial JSON object.
This example shows 12-hour Taipei time without seconds, compact assistant metadata without Thinking or compact abnormal labels, an exact expanded timeline, and tool stamps:

```json
{
  "hourCycle": "12h",
  "showSeconds": false,
  "timeZone": "Asia/Taipei",
  "responseTiming": "duration",
  "showExactTimeline": true,
  "assistantMetadata": "compact",
  "showThinkingLevel": false,
  "showCompactAbnormalOutcome": false,
  "toolStamps": true
}
```

Settings precedence is intentionally:

```text
built-in defaults -> user pi-stamp.json
```

Presentation is a personal preference, so `pi-stamp` does not read project settings or extension-specific environment variables.
Missing settings do not create a file or directory.
Updates preserve unknown fields and publish through a private temporary file plus atomic rename.
Malformed or invalid files become read-only and are never overwritten; fix the reported file and run `/reload`.
A fresh process uses defaults while the file is invalid, and a running process retains its last valid settings.
Reads and writes are serialized within one Pi process.
Separate Pi processes do not share a lock, so concurrent saves are last-writer-wins even though each process rereads immediately before atomic publication.

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

## 🧾 Assistant provenance and usage

Assistant metadata is captured when the stamp is finalized and only when `assistantMetadata` is `"compact"` or `"expanded"`.
When `showThinkingLevel` and assistant metadata are enabled and Pi exposes an effective Thinking level for that turn, the stamp records it as Pi provenance rather than provider-reported reasoning behavior.
A compact stamp can look like:

```text
14:32:08 · 3.2s
claude-sonnet-4-6 · thinking high · 842 tok · est $0.018
```

When Pi reports a response model different from the requested model, compact mode keeps both:

```text
requested-alias → provider-response-model · 842 tok
```

With `showCompactAbnormalOutcome: true`, compact mode adds `stop length`, `stop error`, or `stop aborted` for abnormal outcomes while keeping normal `stop` and `toolUse` outcomes quiet.
This compact control does not remove the complete stop reason from expanded assistant metadata.
Disabling `showThinkingLevel` prevents new Thinking-level capture and hides that field on compatible persisted stamps without rewriting them.
Expanded mode adds labeled rows for API, provider, requested model, provider-reported response model, effective Pi Thinking level, stop reason, and each individually reported input/output/reasoning/cache-read/cache-write/total token or estimated-cost field.
Missing values stay absent; `pi-stamp` never derives a Thinking level, token total, response model, cost, or diagnostic message.

Use Pi's transcript expansion action (`app.tools.expand`, `Ctrl+O` by default) to open the debug view.
With assistant metadata enabled, it may additionally show the sanitized response ID and at most five diagnostic summaries.
A summary contains only diagnostic type, error name, and error code.
Stamp data never copies diagnostic messages, stacks, details, raw payloads, message content, tool arguments, or `textSignature`, `thinkingSignature`, and `thoughtSignature` fields.
Terminal controls are removed and retained text is bounded before persistence.

Provider support varies.
Every optional field is shown only when present and valid on that finalized assistant message.
The cost label says `est` because Pi's message value is an estimate based on the provider/model usage data available to Pi; the extension performs no price lookup.

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
- Version 1 tool entries store only bounded association/timing/outcome data.

Existing versions remain readable.
Changing settings never rewrites session history.
Once recorded, a stamp survives `/reload` and session resume while the extension remains loaded.
Messages and tools created before `pi-stamp` observed them are not backfilled because Pi cannot insert a new custom entry at an older session-tree position.

## 🚧 Limitations

- Pi does not currently expose a public decorator for built-in message or tool rows, so stamps appear as separate transcript rows rather than inside the original bubble/block.
- Another extension can append transcript entries at the same lifecycle boundary, so strict visual adjacency between independently loaded extensions is not guaranteed.
- There are no arbitrary format strings, relative labels, provider-server latency, aggregates, raw diagnostics, or analytics dashboard.
- Thinking level is Pi's effective turn setting and does not claim that a provider honored or reported the same reasoning behavior.
- Token and cost values come only from Pi's message fields.

## 🗂️ Package layout

```text
packages/pi-stamp/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── stamp.ts                       # Transcript entries and rendering lifecycle
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
