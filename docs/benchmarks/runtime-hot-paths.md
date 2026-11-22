# Runtime hot-path measurements

The changes reduce footer redraw work, Git history subprocesses, and duplicate OTel reads on automatic trace start. Analytics and Codex Compact are unchanged. These measurements are local comparisons, not end-to-end latency or CI limits.

Baseline: `a2d1b5d4456acdcc327b0a5cf920a029eabc0877`. Linux x86-64, Node 26.11.1, Pi SDK 1.6.0, Git 2.53.0. Each comparison alternated baseline and candidate on the same host and fixture, excluding warm-ups. Cells show median milliseconds and the minimum–maximum range.

## Footer rendering

Nine samples per build loaded the generated footer through Jiti. Each sample measured the first render of a new footer after explicit garbage collection and the per-render mean over subsequent redraws. The same in-memory session was used for both builds. Compaction left only three visible messages. The candidate preserved rendered output. The model-plus-context layout isolates the default Statusline path that does not display token totals; the detailed layout adds tokens, cache, and cost.

| Layout | Entries | First render, before → after | Subsequent render, before → after |
| --- | ---: | --- | --- |
| Statusline, model and context | 102 | 0.143 (0.105–0.198) → 0.115 (0.096–0.181) | 0.027 (0.022–0.035) → 0.022 (0.020–0.024) |
| Statusline, model and context | 50,002 | 15.810 (13.803–18.811) → 13.438 (9.785–17.844) | 10.317 (9.373–15.994) → 8.716 (7.651–9.340) |
| Statusline, detailed | 102 | 0.174 (0.131–0.220) → 0.157 (0.134–0.194) | 0.030 (0.027–0.037) → 0.025 (0.023–0.029) |
| Statusline, detailed | 50,002 | 15.131 (10.991–20.403) → 14.981 (10.912–21.417) | 10.259 (8.835–10.767) → 8.346 (7.290–10.454) |
| Starship, without context | 102 | 0.544 (0.463–0.744) → 0.516 (0.433–0.714) | 0.230 (0.204–0.335) → 0.200 (0.188–0.321) |
| Starship, without context | 50,002 | 20.776 (17.109–23.916) → 6.081 (5.200–7.019) | 15.295 (14.465–16.496) → 0.197 (0.185–0.235) |
| Starship, with context | 102 | 0.496 (0.382–0.622) → 0.549 (0.452–0.587) | 0.227 (0.210–0.278) → 0.211 (0.203–0.240) |
| Starship, with context | 50,002 | 21.050 (18.739–25.450) → 16.117 (13.764–22.866) | 14.860 (14.146–16.612) → 9.221 (8.604–9.878) |

Detailed Statusline first-render samples varied across runs and still perform the same required calculations. Without a usage segment, Statusline no longer scans totals at all. A warm redraw of either Statusline layout removed one totals scan. A warm Starship redraw without context removed one totals scan, two branch reads (including the one within Pi's context API), and one context read. When context is reachable, Starship still calls Pi for live usage. One earlier non-GC run showed a slightly lower short Starship first-render median with context, while another showed a difference of 0.003 ms. The ranges overlap; we do not claim a short-session cold speedup.

Totals rely on Pi's public append-only session-manager contract. The footer owner, header identity, and entry count identify the observed session history; Starship's branch calculations additionally use the active leaf object rather than the ID alone. Hosts without the relevant accessors get fresh reads. No footer caches estimates from Pi's selected model identity, which does not identify the effective routed model. Starship's inspection still computes diagnostics for all modules; layout rendering skips data that is not reachable.

## Git-backed Sync history

Seven samples per build used a local bare Git remote and compared the full history and the visible 20-item preview. Cold samples start with a new backend cache; warm samples reuse a populated cache.

| Publications | Direct Git launches, warm | Warm cache, before → after | Cold cache, before → after |
| ---: | --- | --- | --- |
| 0 | 1 → 1 | 6.80 (6.24–7.08) → 6.51 (5.66–7.54) | 16.43 (14.92–17.65) → 15.69 (14.39–17.69) |
| 20 | 45 → 28 | 194.01 (186.76–205.94) → 120.91 (113.52–128.49) | 207.50 (201.06–222.80) → 143.22 (133.70–149.01) |
| 100 | 205 → 118 | 875.87 (836.09–921.15) → 494.08 (483.95–501.42) | 885.49 (878.71–911.69) → 518.57 (489.61–581.14) |

Of the 118 warm launches at 100 publications, 113 validate publications. The other five discover and fetch the head and enumerate commits. The largest measured batch reply was 2,680 bytes. The Git runner caps combined output at 8,389,376 bytes per eight-commit group; this is an output-buffer bound, not aggregate peak memory.

The positive path batches manifest bytes only, preserving oldest-first manifest and tree validation. Unusable batch output falls back to separate reads; cancellation does not fall back. Tests cover invalid publications beyond the preview limit, repeated IDs, first-parent order, UTF-8, missing and oversized data, diagnostics, and cancellation. A Lean model proves that consuming the same manifest bytes in grouped order or falling back preserves the ordered validation result and first error. Its framing and per-publication validation hypotheses are integration-test obligations, not claims that Lean verified Git or TypeScript.

## OTel snapshots

Seven alternating samples timed the `turn_start` hook after binding a fresh recorder without a root trace. The fixture used Pi's real context-usage calculation and an in-memory exporter substitute. Each sample is the median of repeated fresh root starts. Start/end leaf and token metadata matched after disposal.

| Session entries | Reads per rootless turn | Median hook time, before → after |
| ---: | --- | --- |
| 102 | 2 → 1 | 0.025 (0.021–0.051) → 0.019 (0.014–0.032) |
| 50,002 | 2 → 1 | 12.742 (12.345–14.545) → 6.685 (6.182–6.892) |

Ordinary traces already have a root by `turn_start`; their cross-hook reads are unchanged. In Pi 1.6.0, the effective routed model is not exposed as a revision keyed to the complete historical context-usage input. Keep the eager observations for interruption and keep the provider-triggered fallback's separate start read.

## Unshipped candidates

- **Analytics:** An exact-byte, in-memory index preserved Today, 7d, 30d, and All query results. With 50,000 runs across 500 writer files and one matching run, seven samples improved the warm median from 455.72 (441.46–585.94) to 271.69 (252.60–311.80) ms but increased the cold median from 408.31 to 427.38 ms. A separate five-sample run repeated the cold regression (412.51 to 444.95 ms). The prototype retained 29.9 MB of frame bytes and metadata for 50,000 runs; the seven-sample warm peak RSS rose from 96.2 to 155.4 MiB across fresh test processes. The index was not shipped. A future index must also preserve first occurrence by writer order and surface malformed complete frames outside the query interval.
- **Codex Compact:** `context` and `before_provider_request` lack a common request ID. The run signal is shared by multiple turns. Cache warming can reuse a provider callback without a new context hook and produce the same payload, and persisted checkpoint data can change in place under the same entry ID. Keep both validations until the request owner and unchanged validation inputs can be established without erasing the benefit. No provider request was made to reach that conclusion.
