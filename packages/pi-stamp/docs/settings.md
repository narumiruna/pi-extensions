# Pi Stamp settings

Open `/stamp` → **Settings** to edit individual fields, or choose **Presets** to preview a metadata starting point. Settings edits save immediately; presets save only after confirmation. Successful saves reformat compatible stamps on the next render, and closing a screen does not undo a saved change. Manual file edits load on startup, `/reload`, or session replacement.

## Presets

Presets change only the metadata settings in the table below. They do not change timestamps, response timing, throughput, exact timelines, cost or time since user, or tool stamps.

In TUI, moving the cursor immediately applies the focused preset to the original right-aligned Stamp rows in the transcript. There is no separate preview block. This changes display only; canonical settings and session history remain unchanged until an explicit save. Each render retains the latest actual nonmetadata settings and the existing transcript expansion state.

When a Stamp has no saved metadata, the renderer can read bounded ordinary fields from its matching earlier assistant response in the active branch. The Stamp ID and response timestamp keep each row associated with its own response. Saved Stamp metadata remains authoritative; user and tool stamps are not changed. Branch and session changes discard stale associations.

Response content, response IDs, diagnostics, and raw/current Thinking are never recovered. Thinking and debug fields still require values already recorded by Stamp. Unreported values stay absent, and some presets can therefore produce the same visible rows. No synthetic data or persisted backfill is added. Ordinary recovered fields remain visible after confirmation because canonical rendering uses the same read-only fallback.

The menu can cover transcript rows in a short regular-mode terminal. Enlarge that terminal to see the actual Stamp change while navigating.

Confirmation removes the preview and saves all metadata fields together in one ordered, atomic update. A successful save reopens the preset list with the applied preset focused and marked current. A failed save keeps the previous actual settings and permits retry. Cancelling the saving screen closes the flow after an accepted write finishes; it does not undo the save.

Back, cancellation (including `Ctrl+C`), closing or replacing the screen, session replacement, and shutdown remove only that preview. Saved settings and later changes remain intact.

RPC provides the seven presets plus Back as ordinary options, without cursor previews. Confirmation still saves exactly one complete metadata patch.

| Preset | Metadata selection | Layout |
| --- | --- | --- |
| Compact | Requested and response models, Pi Thinking level, total tokens, call cost, and abnormal stop reasons | Compact |
| Model | Requested and response models, plus Pi Thinking level | Compact |
| Usage | Input, output, reasoning, cache-read, cache-write, and total tokens | Expanded |
| Cost | Reported estimated cost per assistant call | Compact |
| Abnormal | Only `length`, `error`, and `aborted` stop reasons | Compact |
| Detailed | Both models, provider, API, Thinking level, all reported token fields, call cost, and all stop reasons | Expanded |
| None | All metadata fields hidden | Compact |

Response ID and diagnostics remain off in every preset. Enable them separately if needed.

A preset is a one-time update, not a mode that overrides later edits. The menu derives the current name from the complete actual metadata settings; unmatched combinations show **Custom**. The current marker follows the actual settings, not cursor focus or the temporary preview. When the settings are Custom, the initial cursor previews Compact without saving it. Layout is part of that comparison even when every field is hidden. Applying a preset replaces all metadata settings, including custom metadata choices, but preserves unrelated settings and unknown JSON fields.

## Metadata fields

Every field can be edited independently. Layout selects only formatting; it never enables or disables another field.

| Field | Accepted values | Default | Behavior |
| --- | --- | --- | --- |
| `metadataLayout` | `"compact"`, `"expanded"` | `"compact"` | Uses one joined row, or labeled provenance and usage rows. Empty rows are omitted. |
| `showRequestedModel` | boolean | `false` | Shows the requested model ID. |
| `showResponseModel` | boolean | `false` | Shows the provider-reported response model when present. Compact layout joins distinct selected models with an arrow. |
| `showProvider` | boolean | `false` | Shows the provider name. |
| `showApi` | boolean | `false` | Shows the Pi API identifier. |
| `showPiThinkingLevel` | boolean | `false` | Captures and shows Pi's effective turn Thinking level without requiring another metadata field. |
| `showInputTokens` | boolean | `false` | Shows reported input tokens. |
| `showOutputTokens` | boolean | `false` | Shows reported output tokens; this does not enable throughput. |
| `showReasoningTokens` | boolean | `false` | Shows reported reasoning tokens without adding them to another count. |
| `showCacheReadTokens` | boolean | `false` | Shows reported cache-read tokens. |
| `showCacheWriteTokens` | boolean | `false` | Shows reported cache-write tokens. |
| `showTotalTokens` | boolean | `false` | Shows the reported total; missing totals are not calculated. |
| `showCallCost` | boolean | `false` | Shows the reported estimated cost of each assistant call. Cost since user separately includes the final call cost when enabled. |
| `stopReason` | `"hidden"`, `"abnormal"`, `"all"` | `"hidden"` | Hides stop reasons, shows only `length`/`error`/`aborted`, or shows all reasons in either layout. |
| `showResponseId` | boolean | `false` | Captures a sanitized response ID and shows it only in the expanded transcript. |
| `showDiagnostics` | boolean | `false` | Captures bounded diagnostic summaries and shows them only in the expanded transcript. |

While any metadata field or stop-reason display is enabled, a finalized stamp captures its compatible reported provenance and usage snapshot. Ordinary display flags hide fields without erasing that snapshot. Thinking level, response ID, and diagnostics additionally require their own capture flags. Disabling these flags hides previously recorded values but does not erase history. Enabling them cannot reconstruct data that was never recorded.

Transcript expansion is Pi's `app.tools.expand` action (`Ctrl+O` by default). The `"expanded"` metadata layout is separate from transcript expansion: it controls ordinary metadata rows, not whether debug fields are visible. Neither debug setting permits raw messages, stacks, payloads, or tool arguments to be stored.

## Timestamp, timing, and tool fields

| Field | Accepted values | Default | Behavior |
| --- | --- | --- | --- |
| `hourCycle` | `"24h"`, `"12h"` | `"24h"` | Selects the clock style. |
| `showSeconds` | boolean | `true` | Shows seconds. |
| `dateContext` | `"day-change"`, `"always"`, `"never"` | `"day-change"` | Adds dates at recorded day changes, always, or never. The first known stamp remains time-only with day-change mode. |
| `locale` | `"invariant"`, `"system"`, or one BCP 47 tag | `"invariant"` | Selects localized date/time presentation. |
| `timeZone` | `"local"` or a supported IANA zone | `"local"` | Selects the clock and day-boundary zone; `UTC` and `Asia/Taipei` are accepted. |
| `responseTiming` | `"off"`, `"duration"`, `"detailed"` | `"off"` | Hides response timing, shows total duration, or shows first-content and total duration. |
| `showOutputThroughput` | boolean | `false` | Captures and shows reported output tokens divided by creation-to-completion seconds. |
| `showExactTimeline` | boolean | `true` | Shows exact UTC and Unix observation times only during transcript expansion. |
| `showCostSinceUser` | boolean | `false` | Shows cumulative cost since the last user message and the final call cost on a non-`toolUse` response. |
| `showTimeSinceUser` | boolean | `false` | Records fixed elapsed time from the last user message through a non-`toolUse` response's completion. |
| `toolStamps` | boolean | `false` | Records and shows duration plus success/error for newly observed tools. |

`invariant` uses Gregorian ISO dates, Latin digits, and English `AM`/`PM`. `system` uses the operating system locale; explicit examples include `en-US`, `fr-FR`, and `zh-TW`.

See the [README timing sections](../README.md) for observation boundaries, throughput calculations, and since-user behavior.

## Location and persistence

The canonical file is `<getAgentDir()>/pi-stamp.json`, normally `~/.pi/agent/pi-stamp.json`. It is a partial JSON object with this precedence:

```text
built-in defaults -> user pi-stamp.json
```

There are no project settings or extension-specific environment overrides. Missing files use defaults without creating a file or directory. An explicit save rereads the latest valid document, preserves unknown fields, and publishes through a private temporary file followed by atomic rename.

Invalid JSON, invalid recognized fields, unreadable files, and unsafe file types block saving. The file is never replaced with defaults. A fresh process uses defaults while the file is invalid; a running process keeps its last valid settings. Fix the file and run `/reload`.

Reads and writes are serialized within one Pi process, including reload and shutdown. A failed write preserves the previous file and runtime values and does not prevent later saves. Separate processes have no shared lock: concurrent saves are last-writer-wins even though each process rereads before publication.

## Legacy settings

The loader still accepts `assistantMetadata: "off" | "compact" | "expanded"`, `showThinkingLevel`, and `showCompactAbnormalOutcome`. It validates legacy fields even when they are inactive.

- `off` maps to hidden metadata; `compact` maps to Compact fields; `expanded` maps to Detailed fields.
- `showThinkingLevel` controls the translated `showPiThinkingLevel`; it defaults to true only within an enabled legacy metadata mode.
- `showCompactAbnormalOutcome` controls the translated compact stop reasons. Legacy expanded mode continues to show every stop reason.
- An enabled legacy metadata mode retains its previous response-ID and diagnostic opt-in. Thus its effective settings can show **Custom** rather than matching a new privacy-preserving preset.
- Explicit canonical fields override the legacy translation one field at a time.

Loading never rewrites a file. On the next explicit successful save, the extension materializes the translated metadata settings and removes only the three recognized legacy keys. Unknown fields and unrelated settings remain intact. A failed save leaves the original file unchanged.

Session entries are not migrated or rewritten. Older extension releases do not understand the independent metadata fields; restore the prior user settings file before a downgrade if the old presentation is required.
