# Runtime Diagnostics

Runtime Diagnostics is a project-local Pi extension for privacy-filtered runtime inspection.
It is optimized for the `runtime_diagnostics` tool because an agent is its primary consumer.
The default response is concise, while selected sections and sanitized bundles provide evidence only when needed.

## Capabilities

- Reports the active provider, model, thinking level, Node.js version, platform, architecture, and resolved Pi Coding Agent version.
- Aggregates prompt-cache usage and reports cautious findings when repeated requests have no cache reads.
- Lists active and inactive tools, lower-bound definition sizes, provenance, and the limitations of Pi's tool-inspection API.
- Lists visible extension tool and command surfaces with owning package versions when a package manifest is discoverable.
- Captures provider-visible tool names across installed adapter payload shapes, numeric request sizes, final HTTP status, and response-header latency without retaining payload content.
- Compares provider requests and runtime snapshots with explicit added, removed, and changed fields.
- Produces actionable findings and deduplicated recommendations.
- Audits retained provider fields and bundle source-path redaction before marking a diagnostic bundle shareable.
- Bounds every tool result to 50 KB and 2,000 lines.

## Tool

Call `runtime_diagnostics` with no arguments to receive a concise status summary.

| Action | Behavior |
| --- | --- |
| `status` | Returns summary health, findings, recommendations, and requested sections. |
| `latest` | Adds the latest provider request record. |
| `show` | Adds recent provider request records up to `limit`. |
| `compare` | Compares the first and latest retained provider and runtime records. |
| `enable` | Enables provider-request capture for the active session branch. |
| `disable` | Disables provider-request capture for the active session branch. |
| `clear` | Clears records from the active reporting window. |
| `configure` | Updates session-scoped `maxRecords` or `maxAgeMinutes`. |
| `bundle` | Returns every detail section as a sanitized shareable JSON bundle, regardless of `sections`. |

Set `detail` to `full` to include every section with an ordinary action.
Set `sections` to any combination of `provider`, `cache`, `tools`, `extensions`, `environment`, `timeline`, and `privacy` for targeted evidence.
The `limit` parameter accepts 1 through 20 records for `show` and `bundle`.
The `maxRecords` parameter accepts 1 through 500 records with `configure`.
The `maxAgeMinutes` parameter accepts 1 through 10,080 minutes with `configure`.

## Command

`/runtime-diagnostics` provides a concise human-readable status in TUI and RPC modes.
It accepts exactly one optional route: `status`, `provider`, `cache`, `tools`, `extensions`, `privacy`, or `help`.
Known routes have argument completion, and unknown or trailing arguments are rejected.
Print and JSON modes reject the command observably because notifications are unavailable there.
Use the tool for machine-readable output, capture controls, retention configuration, comparisons, and bundles.

## Retention

Capture defaults to 100 records and a 1,440-minute active reporting window.
Retention controls are stored as custom session entries and rebuild from the active branch after reload, resume, or fork.
Automatic pruning and `clear` remove records from the in-memory reporting window.
Pi session custom entries are append-only, so pruning and `clear` do not erase historical custom entries already present in an existing session file.
No extension settings file, external log, timer, watcher, or background cleanup task is created.

## Privacy

Provider request records retain only a timestamp, session ID, provider and model IDs, a plan marker boolean, numeric byte counts, bounded tool names, HTTP status, and response-header latency.
The extension does not retain prompts, instructions, message content, tool schemas, tool arguments, HTTP headers, response bodies, credentials, API keys, or authorization values.
Request and tool-definition sizes are retained as numbers rather than serialized content.
Captured display strings are stripped of terminal controls, bidirectional controls, and newlines before retention.
Bundle exports replace every non-virtual source path, every package source reference, and every other path-like source reference with `[redacted-local-path]`.
Ordinary targeted diagnostics keep sanitized source paths available for local troubleshooting.
The `privacy` section reports the provider-field allowlist and bundle source-redaction audit results.

## Limitations

The `before_provider_request` hook exposes the payload at this extension's handler position, so a later extension can still replace it.
A captured payload does not prove that the provider accepted or executed the exposed tools.
Response latency ends when headers arrive and does not measure stream completion.
The installed `google-generative-ai` and `google-vertex` adapters do not emit response-header telemetry, so their requests are marked `unsupported` rather than `pending`.
Restored requests without retained response telemetry are marked `unavailable` because a future response cannot complete a historical capture.
Retained-window byte totals are `null` when any included request has unknown legacy size data.
Provider responses are matched to requests by event order because the hook exposes no request identifier.
Failed HTTP attempts remain associated with the same request until a successful retry replaces them or `agent_end` ends the run.
Requests without response headers are marked `unavailable` at `agent_end`, and unmatched indexes are discarded so a failed run cannot offset later response attribution.
Extension visibility includes only public tool and slash-command surfaces, so passive event-only extensions cannot be enumerated.
Inactive tools include an honest generic explanation because Pi does not expose the configuration, filter, or deferred-loading reason.
Per-tool definition sizes are lower bounds over the provider-visible name, description, and parameters because `ExtensionAPI.getAllTools()` does not expose `constrainedSampling`.
Captured provider-request totals measure the actual serialized tool container and include adapter-specific strictness or grammar effects.
A cache finding cannot prove provider cache support and should be interpreted with the selected provider and model documentation.

## Source layout

- `index.ts` registers the tool, command, lifecycle hooks, and provider hooks.
- `capture-state.ts` owns session reconstruction, controls, and retention pruning.
- `provider-request.ts` owns privacy-filtered provider extraction across supported payload shapes and response-telemetry state.
- `snapshot.ts` owns runtime, cache, tool, extension, environment, and timeline snapshots.
- `report.ts` owns findings, comparisons, privacy audits, presentation, and output bounds.
- `text.ts` owns terminal-safe diagnostic string normalization.
- `index.test.ts` covers capture, controls, privacy, commands, bundles, and output bounds.
- `tsconfig.json` and `vitest.config.ts` provide extension-local verification boundaries.

## Verification

Run the focused checks from the repository root:

```bash
npx tsc -p .pi/extensions/runtime-diagnostics/tsconfig.json
npx vitest run --config .pi/extensions/runtime-diagnostics/vitest.config.ts
pi --no-extensions -e ./.pi/extensions/runtime-diagnostics/index.ts
```

Trusted projects auto-discover `.pi/extensions/runtime-diagnostics/index.ts` and can reload it with `/reload`.
