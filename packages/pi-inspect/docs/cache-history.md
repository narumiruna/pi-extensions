# Cache history contract

The Cache tab reports persisted usage on Pi's active branch. It works without another extension. Browser history selection and historical context previews do not change its branch scope.

## Records and availability

Rows follow recorded ancestry, not timestamp order. Each row retains its session entry ID for **View event details**. The count is usage records, not transport attempts: summaries can aggregate multiple calls, and unrecorded retries cannot be recovered. Provider payload observations do not establish request identities.

| Recorded evidence | Row and totals | Comparison and trend |
| --- | --- | --- |
| Assistant response with positive prompt tokens and cache read or write | Include; cache accounting known | Conversational sample |
| Assistant response with zero cache fields, before that provider reports conversational cache activity | Include tokens and available cost; hit rate and savings unavailable | Unknown trend point; break adjacent comparison |
| Assistant response with zero cache fields, after that provider reports conversational cache activity | Include; complete miss when prompt tokens are positive | Conversational sample; do not reclassify earlier rows |
| Assistant with zero prompt tokens | Include zero token counts; hit rate unavailable | Unknown trend point; break adjacent comparison |
| Error or aborted assistant response | Include recorded usage with error/cancelled status; no estimated missing usage | Same accounting rules as other assistant responses |
| Missing, negative, nonfinite or overflowing input/read/write values | Retain row with unavailable metrics; mark report incomplete and affected totals unavailable | Unknown trend point; break adjacent comparison |
| Compaction or branch summary with usage | Include auxiliary row; provider/model unavailable because these entry types have no model identity | Never a conversational sample; start a new prefix epoch |
| Compaction or branch summary without usage | No usage row | Still start a new prefix epoch |
| Generic usage entry, including `cache_warm` | Include once; warming has its own kind | Never a trend point, support signal, or comparison baseline |
| Model or provider switch | Retain original model/provider labels | Compare adjacent known responses in the same epoch and flag the change |
| Custom entries, tools, labels and other bookkeeping | No cache row | Do not change the comparison baseline |
| Missing/duplicate/cyclic/over-budget ancestry or invalid active leaf | Report unavailable, not a complete empty branch | No inferred branch or repaired links |

Auxiliary zero cache fields remain unknown even if a conversational provider previously reported caching. A valid but unknown accounting field is different from malformed usage: it can leave the traversal complete while hit rate and savings remain unavailable. An unknown component prevents a partial sum from appearing as a complete total.

## Calculations

`promptTokens = input + cacheRead + cacheWrite`. Hit rate is `100 * cacheRead / promptTokens`. Branch hit rate uses summed counts, not the average of request percentages; it is unavailable if any counted record lacks cache accounting or the denominator is zero. Input tokens are the uncached-input bucket; cache writes are a separate bucket.

Compare only adjacent conversational responses with known accounting in the same epoch. Display hit-rate change and downward loss in percentage points, prompt-token change, and cache-read change. Eligible tokens are the smaller of the two prompt-token counts. Estimated re-billed tokens are `max(0, eligible - current cacheRead)`. These count comparisons do not prove reuse of particular prefix bytes. Model/provider switches are flagged but do not exempt the resulting token-count comparison.

Request start gap is the nonnegative difference between recorded assistant message timestamps. Missing or invalid timestamps leave it unavailable; it is not response duration or transport latency. Row time is the session entry's recorded timestamp, not a fabricated request start time.

Positive reported input/read/write component costs take precedence. When a positive-token component has zero or unavailable reported cost, Pi's effective model pricing is a fallback. This includes prompt-length tiers and `cacheWrite1h` retention pricing. Zero-token components cost zero. With no usable model or reported price, cost remains unavailable; normalized zero costs alone do not establish free billing. The cost-source label describes prompt cost: reported, model-estimate, mixed, or unavailable.

Savings estimate the cache-read tokens multiplied by the nonnegative difference between input and read unit prices. Miss premium estimates re-billed tokens multiplied by the nonnegative difference between the current paid input/write unit price and read unit price. Unit-price fallback probes preserve total prompt tokens so that pricing tiers do not change. All pricing calls operate on copies: they cannot mutate recorded usage. Model prices are current estimates, not historical subscription invoices.

## Conversational trend

The trend shows the latest 32 conversational points in oldest-to-newest order. This limit is unchanged; auxiliary usage does not add trend points. Known values use vertical bars on a fixed 0–100% axis, with a visible baseline and reference lines at 50%, 90% and 100%. The axis never autoscales. Bars have consistent sample slots within the 32-point capacity, so sparse samples do not stretch across the pane. On narrow screens, horizontal scrolling stays inside the chart; points do not wrap or widen the document.

### Display states

| Data state | Display |
| --- | --- |
| Cache report absent in an older snapshot | Existing cache-report unavailable message |
| Report unavailable or incomplete | Existing reason and incomplete-report handling; not an empty-state claim |
| No conversational points, including auxiliary-only usage | “No conversational responses yet. The trend appears after a response is recorded.” No empty axis; auxiliary totals and rows remain available. |
| Points exist, but every hit rate is unknown | “Hit rate is unavailable for the recorded responses.” Sample count and per-response Event details buttons, but no axis or zero bars; accounting is not necessarily missing. |
| One to three points, with at least one known value | Normal-width bars and each exact percentage shown directly; unknown points retain their positions. |
| Four to 32 points, with at least one known value | Bars with latest and minimum known-value annotations; every value is available through keyboard and pointer interaction. |
| Mixed known and unknown points | All positions remain in chronological order. Unknown points have a neutral missing-value mark, not a numeric height or low-rate color. |

A known 0% value has a visible baseline mark, not an inflated positive bar. It remains distinct from an unknown value.

### Bands and summaries

A text legend shows these fixed ranges alongside the colors:

| Raw hit rate | Color | Label |
| --- | --- | --- |
| 0% to less than 50% | Red | Low |
| 50% to less than 90% | Amber | Moderate |
| 90% to 100% | Green | High |
| Unknown | Gray | Unavailable |

These bands are visual targets, not provider guarantees or a universal cache-efficiency standard. High is the display target. Low values are measurements, not errors or proof of a cache defect or cold start. Classification uses the raw percentage before formatting; a rounded label must not imply a different band. The thresholds are not configurable, and accounting formulas do not change.

Latest and minimum summaries above the chart apply only to the displayed window. Latest is the last point, even when its value is unknown; it does not fall back to the last known point. Minimum uses only known values and is unavailable when none are known. These summaries do not replace the branch-weighted total or calculate cross-epoch deltas.

### Epochs and Event details

Each trend point can include an optional `epoch` field in the existing snapshot format. A dashed separator with a text explanation appears only between consecutive points whose epochs are both known and different. No separator appears before the first retained point. Older points without epoch metadata still display their values, but the viewer invents no boundary and does not infer one from low values, model switches, missing comparisons or clipped usage rows. Comparisons remain within an epoch.

Each point uses a native button connected to the existing Event details selection. Its accessible text includes the sample position, hit rate and band. Labels remain available without hover. Pointer activation, including touch, and keyboard Enter or Space open the same event; keyboard focus stays visible in light and dark themes. Opening an event changes only browser selection, not Pi's active leaf.

## Bounds and lifecycle

The authenticated snapshot includes at most the latest 200 usage rows and 32 conversational trend points, oldest first. The UI names the omitted row count. Totals include the full validated active ancestry before row clipping; ancestry over the existing 10,000-entry budget is unavailable. Display labels are redacted, stripped of terminal controls and limited to 128 characters. Entry IDs retain the inspector's validated 512-character limit. Missing cache fields in older snapshots show an unavailable view.

The existing consent, loopback authentication, generation checks, CSP, and read-only policy apply. No additional server, timer, fetch path, model tool, settings or persistent storage is added. Usage reconstructs when opening the viewer, after completed messages, compaction, tree navigation and settled work. The existing one-second reconciliation detects persisted idle warming without guessing from warming-decision hooks. Stop, reload, replacement and shutdown release the feed and revoke its URL. Already-received browser data cannot be remotely erased.

Streaming preview, cross-session history and historical-branch cache previews are not implemented.

## Implementation evidence

The source audit uses the installed Pi implementations, not provider payload guesses:

- `pi-coding-agent/dist/core/session-manager.js`: `appendUsage`, `appendCompaction`, and `branchWithSummary` preserve model-attributed auxiliary usage or model-unattributed summary usage in branch ancestry.
- `pi-coding-agent/dist/core/cache-warmer.js`: confirmed warm usage is persisted with `appendUsage("cache_warm", ...)`; decision callbacks are not completion records.
- `pi-coding-agent/dist/core/cache-stats.js`: model switches are not comparison exemptions; `message_end` precedes persistence. The inspector deliberately excludes warming from conversational comparison baselines and exposes no native miss-noise threshold or TTL-cause inference.
- `pi-ai/dist/models.js`: `calculateCost` selects the highest matching strict prompt threshold, applies long-retention writes, and mutates its usage argument.
- Inspector `ancestry.ts`, `identity.ts` and `entry-index.ts`: validate identity and ancestry before native projection; do not combine off-branch usage.

`test/cache-history.test.ts` covers the decision classes, calculations, bounds, branch reconstruction and feed polling. `test/lifecycle.test.ts` covers settled invalidation, model-input stability and revocation. `test/cache.spec.ts` covers the browser view, details, keyboard/theme/narrow layouts, authorization and stale snapshot cancellation.
