# 🗜️ pi-codex-compact — Use Codex Remote Compaction in Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-codex-compact)](https://www.npmjs.com/package/@narumitw/pi-codex-compact) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Use Responses compaction in Pi through Remote Compaction V2 or the unary `responses/compact` API.
The extension stores an opaque server-generated checkpoint and replays it in later compatible requests instead of generating a local plaintext summary.
Pi still decides when compaction runs and keeps its normal `/compact`, threshold, overflow, and session-publication behavior.

## ✨ Features

- Supports `openai-codex-responses`, `openai-responses`, and `azure-openai-responses`.
- Uses Remote V2 or same-origin unary `responses/compact` through the active provider and credentials.
- Handles manual, threshold, and overflow compaction through Pi's existing lifecycle.
- Validates and persists one bounded opaque checkpoint that survives compatible reloads, resumes, and forks.
- Replays the latest checkpoint while preserving newer conversation and extension context.
- Supports repeated and cross-protocol compaction by carrying the previous checkpoint forward.
- Falls back to Pi's native plaintext compaction on non-cancellation failures.
- Provides `/codex-compact` for effective-route status, settings, and manual compaction.

## 📦 Install

Install persistently from npm:

```bash
pi install npm:@narumitw/pi-codex-compact
```

Try the published package without installing:

```bash
pi -e npm:@narumitw/pi-codex-compact
```

Try a local checkout from the repository root:

```bash
npm --workspace @narumitw/pi-codex-compact run build
pi -e ./packages/pi-codex-compact
```

The package declares `dist/index.ts`, so build a local checkout before loading its package directory.
Loading the package enables automatic Responses compaction routing with the documented defaults.
Do not load a global npm installation and the local workspace at the same time.

Pi extensions run with your user permissions.
Review third-party extension source before installing it.

## 🚀 Quick start

1. Sign in through Pi's built-in OpenAI, OpenAI Codex, or Azure OpenAI provider, or configure a compatible custom provider.
2. Select a model using `openai-codex-responses`, `openai-responses`, or `azure-openai-responses`.
3. Work normally; Pi's automatic compaction and built-in `/compact` continue to operate.

Run `/codex-compact` when you want to inspect the effective route or choose **Compact now**.
After compaction, compatible requests replay the opaque checkpoint automatically.

With the default `auto` protocol, Codex Responses uses Remote V2 while OpenAI and Azure OpenAI Responses use unary `responses/compact`.
When the active model uses another API, compaction remains entirely Pi-native.

## 💬 Commands

```text
/codex-compact
```

In TUI mode, the menu shows whether remote compaction is enabled, the protocol setting, the active model, and whether manual compaction will use **Responses Remote V2**, **Responses Compact API**, or **Pi native**.
It contains:

```text
Compact now
Settings
Close
```

**Compact now** closes the menu before asking Pi to compact the active session.
Escape or Ctrl+C closes without compacting, and an obsolete menu cannot trigger work after session replacement or shutdown.
**Settings** opens the bounded settings editor.
In RPC mode, the command reports the manual settings path instead of opening custom UI or compacting.
Print and JSON modes reject the command explicitly because they cannot open the menu or safely replace their normal output with an interactive result.

Pi's built-in `/compact` remains available and follows the same extension hook for all three supported Responses APIs.

## ⚙️ Settings

The extension has one optional, global-only JSON settings file:

```text
<getAgentDir()>/pi-codex-compact.json
```

The normal path is `~/.pi/agent/pi-codex-compact.json`.
There is no environment-variable or project-level override.

```json
{
  "enabled": true,
  "protocol": "auto",
  "requestTimeoutMs": 300000,
  "maxRetries": 2,
  "replacementTokenBudget": 64000,
  "notifyOnFallback": true
}
```

| Setting | Default | Accepted values | Behavior | Recommendation |
| --- | ---: | --- | --- | --- |
| `enabled` | `true` | Boolean | Attempt a supported remote compaction route. | Keep enabled unless diagnosing provider behavior. |
| `protocol` | `"auto"` | `"auto"`, `"remote-v2"`, or `"responses-compact"` | Select by API or force one remote protocol. | Keep `auto`; force a route only when diagnosing a compatible backend. |
| `requestTimeoutMs` | `300000` | Integer from 30,000 to 600,000 ms | Bound one extension-owned remote request. | Keep five minutes; increase only for a consistently slow connection. |
| `maxRetries` | `2` | Integer from 0 to 2 | Retry transient provider transport failures before Pi fallback. | Keep two; use zero when diagnosing the first failure. |
| `replacementTokenBudget` | `64000` | Integer from 8,000 to 128,000 tokens | Bound approximate retained user-message text beside the opaque item. | Keep 64K; lower it to reduce session size or raise it only when recent user context is being lost. |
| `notifyOnFallback` | `true` | Boolean | Warn when remote compaction fails and Pi-native compaction takes over. | Keep enabled so silent fallback does not hide protocol or entitlement problems. |

Missing fields use defaults.
Settings reload on every `session_start`, including `/reload`, resume, and fork.
Menu writes apply immediately, preserve unknown JSON fields, serialize within the current Pi process, and use a final conflict check plus same-directory atomic rename.
On Unix, temporary files use mode `0600`.

Malformed, invalid, oversized, or symlinked settings files remain unchanged.
Defaults stay active, and the menu remains read-only until the file is fixed and Pi is reloaded.
Separate Pi processes do not share a mutation lock; a detected concurrent edit is rejected so the user can reopen Settings and retry.

### Relationship to Codex configuration

This extension does **not** read `~/.codex/config.toml`.

| Codex setting | Extension behavior |
| --- | --- |
| `features.remote_compaction_v2` | Conceptually corresponds to `protocol: "remote-v2"`; it is not imported. |
| `model_auto_compact_token_limit` | Not duplicated. Pi's own compaction threshold remains authoritative. |
| `model_auto_compact_token_limit_scope` | Not supported; Pi extensions do not own Codex's compact-window lineage. |
| `compact_prompt` / `experimental_compact_prompt_file` | Not used by either remote protocol, whose opaque checkpoint is generated by the server. |
| `features.token_budget` | Not supported; token-budget context reset is a different experimental strategy. |

## ✅ Requirements and compatibility

- Pi APIs compatible with the package's declared peer dependencies.
- One of `openai-codex-responses`, `openai-responses`, or `azure-openai-responses` on the active model.
- A provider whose HTTP Responses adapter honors Pi's public `onPayload` and injected `fetch` options.
- A backend supporting the selected protocol and opaque `compaction` replay.
- Working credentials and any required compaction entitlement.

| Model API | `auto` route | Other selectable route |
| --- | --- | --- |
| `openai-codex-responses` | Responses Remote V2 | Responses Compact API |
| `openai-responses` | Responses Compact API | Responses Remote V2 |
| `azure-openai-responses` | Responses Compact API | Responses Remote V2 |

The installed built-in adapters are covered by deterministic transport tests.
A custom provider or proxy is eligible when its model explicitly uses one of these APIs, but its backend still owns compatible routing, authentication, request transforms, and opaque replay.
The extension does not send a separate capability probe or automatically retry a failed billable request through the other protocol.
A failed remote attempt falls back to Pi native, but an ordinary request cannot transparently recover after an incompatible provider has already received an existing opaque checkpoint.
Provider provenance is stored for diagnosis but is not a replay gate.
Switching providers can replay a checkpoint only when the API label and exact model ID still match; switching APIs or model IDs leaves Pi's visible fallback marker plus retained recent messages in context.

## 🔄 How it works

1. Pi prepares compaction and selects the recent message suffix it will retain.
2. If an earlier compatible checkpoint is present, the extension identifies its boundary from the summary persisted on the active `CompactionEntry` and validates the retained suffix fingerprints.
3. Remote V2 projects that checkpoint into a normal Responses SSE request and appends exactly one final `compaction_trigger`.
4. Unary compact captures the provider-built payload and authentication, rewrites only the same-origin `/responses` path to `/responses/compact`, and requests JSON without making a normal inference call.
5. It requires one bounded non-empty opaque `compaction` item; unary output may precede it only with user-role retained messages.
6. It constructs bounded replacement history and stores it with Pi suffix fingerprints in versioned `CompactionEntry.details`.
7. On later compatible requests, it replaces an exactly validated marker with the persisted replacement history immediately before provider dispatch.

The persisted entry remains the summary identity source, so replay does not depend on the wording generated by the currently installed extension version.
If persisted summary identity, fingerprints, model identity, payload shape, or marker count do not match exactly, the extension leaves Pi's visible fallback context unchanged instead of guessing.

## 🔒 Security and privacy

Remote compaction sends the active conversation context and system prompt to the configured Responses backend; Remote V2 also sends active tool schemas.
The Pi session stores the producing provider ID, encrypted compaction item, and bounded recent user-role Responses items.
It does not store credentials, authorization headers, or request headers in checkpoint details.

| Boundary | Limit |
| --- | ---: |
| Observed SSE stream or unary JSON response | 8 MiB |
| Serialized opaque compaction item or retained output item | 2 MiB |
| Persisted replacement history | 8 MiB |
| Retained user text | 64K approximate tokens by default; configurable from 8K to 128K |
| Settings file | 64 KiB |
| Transport retries | At most 2 |
| Request timeout | At most 10 minutes |

An individually oversized media item is dropped rather than making the session entry unbounded.
The oldest fitting text item may be partially truncated to preserve newer context.
These hard byte ceilings are intentionally not configurable.

## 🚧 Limitations

- Codex Remote V2 remains an undocumented hosted contract and can change independently of Pi or this package; keep backups of important sessions.
- Full older history depends on this extension, the checkpoint API label, the exact checkpoint model ID, and a provider route whose backend accepts the opaque item.
  Removing the extension exposes only the portability fallback marker and Pi-retained recent messages.
- The package does not reproduce Codex core's context-window UUID/number lineage, previous-model compatibility fallback, exact pre-turn ordering, or exact mid-turn model-session ownership.
- Pi's public `getAllTools()` metadata does not expose `constrainedSampling`; Remote V2 preserves active tool order, names, descriptions, and parameter schemas but cannot reproduce that optional field.
- Remote failure falls back to Pi's plaintext summary, so a session can contain both remote opaque and native compaction entries over time.
- Settings concurrency is coordinated only within one Pi process; separate processes rely on the final conflict check.

## 📊 Benchmark

The repository includes a seeded benchmark that compares uncompressed full context, Pi-native plaintext compaction, and this extension's Remote V2 path.
It keeps history length nearly fixed while varying information density across five state categories and ten history epochs.
Benchmark v3 uses repeated artifacts, isolated evaluator probes, seed-level paired statistics, one Pi SDK estimator for dry and live fixtures, and committed protocol manifests for confirmatory candidates.
It never treats nominal Pi 20K and Codex 20K settings as equal information capacity or automatically claims that protocol-conformant evidence was genuinely held out.

Preview its exploratory diagnostic without making a provider request:

```bash
npm run benchmark:codex-compact
```

A live run requires `--live`, review of the request and cost exposure, OpenAI Codex OAuth, and Remote V2 entitlement.
The repository preserves the explicitly labeled v2 matched-tail diagnostic and the v3 calibration evidence, while seeds 301–304 remain consumed and unavailable for future confirmatory protocols.
See the [benchmark guide](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-codex-compact/benchmark) for manifests, repetitions, commands, privacy, cost semantics, and interpretation limits.

## 🧪 Development

From the repository root:

```bash
npm --workspace @narumitw/pi-codex-compact run check
npm test
npm run package:pack -- codex-compact
```

See the [Codex compaction mechanism notes](https://github.com/narumiruna/pi-extensions/blob/main/docs/implementation-notes/codex-compaction-mechanism.md) for the underlying Codex mechanism research and the extension boundary.

## 🗂️ Package layout

```text
packages/pi-codex-compact/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── codex-compact.ts               # Compaction routing, replay, and fallback
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
├── benchmark/                         # Repository-only benchmark and methodology
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, OpenAI Codex, Azure OpenAI, custom provider, proxy, Remote Compaction V2, Responses Compact API, opaque checkpoint, Responses API, context compaction.

## 📄 License

[MIT](LICENSE)
