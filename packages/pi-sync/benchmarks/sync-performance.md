# Configured sync performance

This compares the local runtime with the review base `f7e94a48`. Counts are more portable than timings. The host was Linux x86-64 under WSL2, Node 26.11.1, Git 2.53, with temporary agent roots on tmpfs. No live provider was used. Do not use these timings as test thresholds.

| Fixture | Review base | Updated |
| --- | --- | --- |
| Pull apply, 300 equal 4 KiB files | 300 replacements (3.5 s in review fixture) | 0 replacements; 1 replacement when just 1 file differs; both scopes |
| Changed continuous cycle, per unchanged fixture file | 6 content reads, 6 base64 payloads | 5 reads, 2 base64 payloads |
| 4,096-file standalone inspection (small files) | 3.53–3.56 s | 1.70–1.83 s |
| 8,192-file standalone inspection | 7.54–7.63 s | 3.64–3.66 s |
| Warm Git scoped head + snapshot | 15 Git commands, 2 fetches | 8 commands, 1 fetch; 6 commands with metadata already cached |
| WebDAV three-level destination, first/second write | 24/24 requests (code count) | 22/17 requests in the loopback fixture |
| S3-compatible, first/second write | 16/16 requests | 16/16; encoding overlaps the required fresh probe |
| 20 identical facts updates over local sockets | 20 ledger flushes, 0.96 ms median, 1.16 ms p95 | 0 ledger flushes, 0.31 ms median, 0.35 ms p95 |
| Three idle clients, three seconds | 87 polls | 12 state waits (includes initial observations) |
| Same clients, one three-second job | 90 polls and 118 job polls | 10 state waits and one terminal job read |
| Manager refresh, ten legacy setups | 12 settings jobs | 1 settings job at the authority boundary |
| Cancel a paged review from its summary | 3 pages (164,544 detail bytes) | 0 pages with two compatible peers |

The 8,192-file changed cycle timed out at 30 seconds on the base and completed in 24.54 seconds with the changes **only in a benchmark that isolated the periodic authorization timer**. With the timer enabled, both versions can abort a large directory scan: a settings read can create and remove its lock inside the scanned root, changing the root metadata. The scanner rejects that observation. No production guard or deadline was disabled. The benchmark does not establish that a normal 8,192-file automatic cycle always completes. The loopback backend tests retain serial conditional checks, including cleanup, and verify that no snapshot stages or publishes before they succeed.

The [daemon tests](../../pi-sync-daemon/test) cover write/scan counts (`directional-identical-apply`, `hash-only-sync-performance`), local sockets (`state-wait-performance`, `paged-merge-review-performance`), configured bootstrap (`configured-startup-evidence`, `configured-startup-readiness`), and real bare Git/loopback providers (`git-current-head-performance`, `object-store-publication-performance`, `snapshot-wire-v6`). Pi fixtures cover [manager settings reads](../test/manager-refresh-snapshot.test.ts) and [configured two-client startup](../test/configured-startup-rpc.test.ts). Run the repository build before exercising fixtures that load the generated package. Native macOS/Windows behavior, external providers, and production end-to-end timing are not measured here.
