# Main-thread tree snapshots

The tree picker preserves the entries available when it opens. Display text is sanitized, but copying uses the original text captured in that snapshot, not a later lookup in the current session.

## Allocation behavior

`prepareTreeSnapshot()` builds the sanitized tree in one iterative depth-first traversal. It keeps one raw string for single-block copy sources and an array of immutable strings for multi-block sources. It does not retain image or tool-call payloads in copy sources. The copy callback joins only the selected entry's fragments and does not cache that joined string. If joining fails, the picker reports a sanitized copy error without starting clipboard work.

Whitespace-only sources are excluded without joining them. Assistant errors replace empty content, but do not replace whitespace-only content. Copy preserves the original spaces, line breaks, terminal controls, and text-block order.

The saved-label map contains only entries with a defined label or timestamp. Empty strings and timestamp-only values remain distinct from absent values. Successful label updates replace the saved value, clearing removes it, and failed writes restore the last saved value.

The display tree still contains the full session history. Its preparation time and retained heap remain proportional to history size. Joining a selected multi-block message moves that work to each copy action; this change does not guarantee faster picker startup.

## Measured allocation change

The baseline was repository commit `348ed352`. The comparison used the actual updated snapshot functions, without a replacement implementation. Both sides included entry sanitization and snapshot maps, but excluded Pi's core tree builder, native selector, Jiti startup, and clipboard I/O.

Measurements ran on macOS arm64 with Node `26.11.1`. Each synthetic session was a 10,000-node linear tree. Each result is the median of three separate Node processes. Each process performed three warmup preparations, then measured retained heap with `--expose-gc` before and after one preparation. The input was allocated before measurement and the output was retained through the final collection.

| Workload | Baseline heap | Updated heap | Baseline preparation | Updated preparation |
| --- | ---: | ---: | ---: | ---: |
| Short single-block messages | 6.228 MiB | 5.410 MiB | 8.07 ms | 7.71 ms |
| Four-block messages | 27.965 MiB | 18.685 MiB | 113.45 ms | 110.80 ms |
| Four-block messages, all labeled | 29.032 MiB | 20.571 MiB | 121.62 ms | 122.65 ms |
| Metadata entries | 4.184 MiB | 3.368 MiB | 2.94 ms | 2.53 ms |
| Whitespace-only blocks | 6.630 MiB | 5.812 MiB | 115.55 ms | 113.57 ms |

Message text used an entry/block prefix followed by 32 `x` characters for the short case, or 256 `x` characters per block for four-block cases. Whitespace entries had four blocks of 256 spaces. Except for the all-labeled and metadata cases, labels occurred every 1,000 entries. Metadata entries were unlabeled model changes. Disposable benchmark files were removed after the comparison.

The multi-block workload retained about 33% less snapshot heap. The other measured workloads also retained less heap. The all-labeled workload took about one millisecond longer in this sample, so the timing data does not establish a general startup-speed improvement. These samples are not deterministic test thresholds or total Pi memory measurements.

## Verification and platform limits

`test/main-tree-snapshot.test.ts` checks fragment retention, whitespace classification, and sparse-label storage. `test/main-tree-copy.test.ts` checks copy-source branches, immutable snapshot behavior, label state transitions, missing entries, and cancellation of pending clipboard work. The existing deep-tree and Jiti tests cover native rendering and lazy package loading with 10,000 entries.

The package-directory smoke checks offline registration, RPC guards, unchanged transcript state, and shutdown. It does not verify a physical terminal or a real clipboard.

Windows terminal behavior and the original private reported session remain unverified. A Windows maintainer with a synthetic deep session can check rendering, raw copying, label rollback, and cancellation in a physical terminal. The expected behavior is unchanged; this platform check does not replace the deterministic tests or repository verification gates.
