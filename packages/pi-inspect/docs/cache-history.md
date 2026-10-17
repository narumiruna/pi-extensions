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

## Bounds and lifecycle

The authenticated snapshot includes at most the latest 200 usage rows and 32 conversational trend points, oldest first. The UI names the omitted row count. Totals include the full validated active ancestry before row clipping; ancestry over the existing 10,000-entry budget is unavailable. Display labels are redacted, stripped of terminal controls and limited to 128 characters. Entry IDs retain the inspector's validated 512-character limit. Missing cache fields in older snapshots show an unavailable view.

The existing consent, loopback authentication, generation checks, CSP, and read-only policy apply. No additional server, timer, fetch path, model tool, settings or persistent storage is added. Usage reconstructs when opening the viewer, after completed messages, compaction, tree navigation and settled work. The existing one-second reconciliation detects persisted idle warming without guessing from warming-decision hooks. Stop, reload, replacement and shutdown release the feed and revoke its URL. Already-received browser data cannot be remotely erased.

Streaming preview, cross-session history and historical-branch cache previews are not implemented. Opening an event only changes browser selection, not Pi's active leaf.

## Implementation evidence

The source audit uses the installed Pi implementations, not provider payload guesses:

- `pi-coding-agent/dist/core/session-manager.js`: `appendUsage`, `appendCompaction`, and `branchWithSummary` preserve model-attributed auxiliary usage or model-unattributed summary usage in branch ancestry.
- `pi-coding-agent/dist/core/cache-warmer.js`: confirmed warm usage is persisted with `appendUsage("cache_warm", ...)`; decision callbacks are not completion records.
- `pi-coding-agent/dist/core/cache-stats.js`: model switches are not comparison exemptions; `message_end` precedes persistence. The inspector deliberately excludes warming from conversational comparison baselines and exposes no native miss-noise threshold or TTL-cause inference.
- `pi-ai/dist/models.js`: `calculateCost` selects the highest matching strict prompt threshold, applies long-retention writes, and mutates its usage argument.
- Inspector `ancestry.ts`, `identity.ts` and `entry-index.ts`: validate identity and ancestry before native projection; do not combine off-branch usage.

`test/cache-history.test.ts` covers the decision classes, calculations, bounds, branch reconstruction and feed polling. `test/lifecycle.test.ts` covers settled invalidation, model-input stability and revocation. `test/cache.spec.ts` covers the browser view, details, keyboard/theme/narrow layouts, authorization and stale snapshot cancellation.
