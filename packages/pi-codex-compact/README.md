# 🗜️ pi-codex-compact — Use Codex Remote Compaction in Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-codex-compact)](https://www.npmjs.com/package/@narumitw/pi-codex-compact) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Use OpenAI Codex Remote Compaction V2 in Pi instead of generating a local plaintext summary for compatible `openai-codex` sessions, including `pi-multi-account` aliases such as `openai-codex-account-2`.

The extension requests and stores an opaque server-generated checkpoint, then safely replays it in later Codex Responses requests.

Pi still decides when compaction runs and retains its normal `/compact`, threshold, overflow, and session-publication behavior.

## ✨ Features

- Uses the active `openai-codex` OAuth credentials (including `openai-codex-*` provider aliases) without persisting tokens or request headers.
- Handles manual, threshold, and overflow compaction through Pi's existing lifecycle.
- Validates and persists one bounded opaque checkpoint that survives compatible reloads, resumes, and forks.
- Replays the latest checkpoint while preserving newer conversation and extension context.
- Supports repeated compaction by carrying the previous checkpoint into the next request.
- Falls back to Pi's native plaintext compaction on non-cancellation failures.
- Provides `/codex-compact` for route status, settings, and manual compaction.

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

The package declares `dist/index.ts`, so an unbuilt local checkout must be built before Pi loads the package directory.
Loading the package enables Remote V2 with safe defaults.
Avoid loading a global npm installation and the local workspace at the same time.

## 🚀 Quick start

1. Sign in through Pi's built-in OpenAI Codex OAuth provider.
2. Select a model whose provider is `openai-codex` or an `openai-codex-*` alias and whose API is `openai-codex-responses`.
3. Work normally.
   Pi's automatic compaction and built-in `/compact` continue to operate.
4. Run `/codex-compact` to inspect the effective route or choose **Compact now**.
5. After compaction, continue the session normally; compatible requests replay the opaque checkpoint.

When the active model is unsupported, compaction remains entirely Pi-native.

## 💬 Commands

```text
/codex-compact
```

In TUI mode, the root menu shows whether Remote V2 is enabled, the active model, and whether a manual compact will use **Codex Remote V2** or **Pi native**.
It contains:

```text
Compact now
Settings
Close
```

**Compact now** closes the menu before asking Pi to compact the active session.
Escape or Ctrl+C closes without compacting, and an obsolete menu cannot trigger work after session replacement or shutdown.
**Settings** opens the bounded settings editor.
In non-TUI modes, the command reports the manual settings path instead of opening custom UI or compacting.

Pi's built-in `/compact` remains available and follows the same extension hook when the active model is compatible.

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
  "requestTimeoutMs": 300000,
  "maxRetries": 2,
  "replacementTokenBudget": 64000,
  "notifyOnFallback": true
}
```

| Setting | Default | Accepted values | Behavior | Recommendation |
| --- | ---: | --- | --- | --- |
| `enabled` | `true` | Boolean | Attempt Remote V2 for a compatible model. | Keep enabled unless diagnosing provider behavior. |
| `requestTimeoutMs` | `300000` | Integer from 30,000 to 600,000 ms | Bound one extension-owned remote request. | Keep five minutes; increase only for a consistently slow connection. |
| `maxRetries` | `2` | Integer from 0 to 2 | Retry transient provider transport failures before Pi fallback. | Keep two; use zero when diagnosing the first failure. |
| `replacementTokenBudget` | `64000` | Integer from 8,000 to 128,000 tokens | Bound approximate retained user-message text beside the opaque item. | Keep 64K; lower it to reduce session size or raise it only when recent user context is being lost. |
| `notifyOnFallback` | `true` | Boolean | Warn when Remote V2 fails and Pi-native compaction takes over. | Keep enabled so silent fallback does not hide protocol or entitlement problems. |

Missing fields use defaults.
Settings reload on every `session_start`, including `/reload`, resume, and fork.
Menu writes apply immediately, preserve unknown JSON fields, serialize within the current Pi process, and use a final conflict check plus same-directory atomic rename.
On Unix, temporary files use mode `0600`.

Malformed, invalid, oversized, or symlinked settings files are never overwritten.
Safe defaults stay active, and the menu provides read-only repair guidance until the file is fixed and Pi is reloaded.
Separate Pi processes do not share a mutation lock; a detected concurrent edit is rejected so the user can reopen Settings and retry.

### Relationship to Codex configuration

This extension does **not** read `~/.codex/config.toml`.

| Codex setting | Extension behavior |
| --- | --- |
| `features.remote_compaction_v2` | Conceptually corresponds to this extension's `enabled`; it is not imported. |
| `model_auto_compact_token_limit` | Not duplicated. Pi's own compaction threshold remains authoritative. |
| `model_auto_compact_token_limit_scope` | Not supported; Pi extensions do not own Codex's compact-window lineage. |
| `compact_prompt` / `experimental_compact_prompt_file` | Not used by Remote V2, whose opaque checkpoint is generated by the server. |
| `features.token_budget` | Not supported; token-budget context reset is a different experimental strategy. |

## ✅ Requirements and compatibility

- Pi APIs compatible with the package's declared peer dependencies.
- The built-in provider `openai-codex`, or a compatible `openai-codex-*` alias such as those created by `pi-multi-account`.
- API `openai-codex-responses` on the active model.
- A working OpenAI Codex OAuth login and Remote V2 entitlement.

OpenAI API-key, Azure, GitHub Copilot, proxies, and arbitrary Responses-compatible providers are not supported. Checkpoints remain bound to the exact provider alias that created them, so switching between Codex accounts does not replay one account's opaque checkpoint through another account.
Switching to another provider or model leaves Pi's visible fallback marker plus retained recent messages in context.
Switching back to the checkpoint's original compatible model restores opaque replay.

## 🔄 How it works

1. Pi prepares compaction and selects the recent message suffix it will retain.
2. The extension projects an earlier compatible checkpoint, if present, into the current Responses input.
3. It appends exactly one final `compaction_trigger` and sends a normal authenticated Codex Responses SSE request with cache retention disabled.
4. It requires a completed response containing exactly one non-empty opaque `compaction` item.
5. It constructs bounded replacement history from recent raw user-role Responses items followed by the opaque item.
6. It stores that history and fingerprints of Pi's retained suffix in versioned `CompactionEntry.details`.
7. On later compatible requests, it replaces an exactly validated marker with the persisted replacement history immediately before provider dispatch.

If fingerprints, model identity, payload shape, or marker count do not match exactly, the extension leaves Pi's visible fallback context unchanged instead of guessing.

## 🔒 Security and privacy

Remote compaction sends the active conversation context, system prompt, and active tool schemas to the same OpenAI Codex backend used by the selected model.
The Pi session stores the encrypted compaction item and bounded recent user-role Responses items.
It does not store OAuth tokens, authorization headers, or request headers in checkpoint details.

| Boundary | Limit |
| --- | ---: |
| Observed SSE stream | 8 MiB |
| Serialized opaque compaction item | 2 MiB |
| Persisted replacement history | 8 MiB |
| Retained user text | 64K approximate tokens by default; configurable from 8K to 128K |
| Settings file | 64 KiB |
| Transport retries | At most 2 |
| Request timeout | At most 10 minutes |

An individually oversized media item is dropped rather than making the session entry unbounded.
The oldest fitting text item may be partially truncated to preserve newer context.
These hard byte ceilings are intentionally not configurable.

## 🚧 Limitations

- The wire contract is undocumented and can change independently of Pi or this package.
  Keep backups of important sessions.
- Full older history depends on this extension and the same compatible model.
  Removing the extension exposes only the portability fallback marker and Pi-retained recent messages.
- The package does not reproduce Codex core's context-window UUID/number lineage, previous-model compatibility fallback, exact pre-turn ordering, or exact mid-turn model-session ownership.
- Remote failure falls back to Pi's plaintext summary, so a session can contain both remote opaque and native compaction entries over time.
- Settings concurrency is coordinated only within one Pi process; separate processes rely on the final conflict check.

## 🗂️ Package layout

```text
src/index.ts          Thin Pi entrypoint
src/codex-compact.ts  Pi lifecycle, command, provider projection, and fallback
src/remote.ts         Provider stream invocation, auth payload, timeout, and retry controls
src/protocol.ts       Bounded SSE parsing and Remote V2 payload/output validation
src/checkpoint.ts     Replacement history, fingerprints, persistence, and replay projection
src/settings.ts       Global settings validation and atomic persistence
src/settings-menu.ts  First-use manual compaction and settings TUI

dist/                 Generated source-mapped Jiti runtime and lazy menu chunk
scripts/              Runtime builder
benchmark/            Three-arm compaction benchmark, self-test, and methodology
test/                 Protocol, checkpoint, lifecycle, remote, settings, menu, and builder coverage
```

## 📊 Benchmark

The repository includes a seeded three-arm benchmark for uncompressed full context, Pi-native plaintext compaction, and this extension's Codex Remote Compaction V2 path.

It holds history length nearly fixed while varying information density across five state categories and ten history epochs.

Benchmark v3 uses repeated artifacts, isolated evaluator probes, seed-level paired statistics, one Pi SDK estimator for dry and live fixtures, and committed protocol manifests for confirmatory candidates.

It never treats nominal Pi 20K and Codex 20K settings as equal information capacity or automatically claims that protocol-conformant evidence was genuinely held out.

Preview its exploratory diagnostic without making a provider request:

```bash
just benchmark-codex-compact
```

A live run requires an explicit `--live` flag, reviewed request and cost exposure, OpenAI Codex OAuth, and Remote V2 entitlement.

The repository preserves the explicitly labeled v2 matched-tail diagnostic and the v3 calibration evidence, while seeds 301–304 remain consumed and unavailable for future confirmatory protocols.

See the [benchmark guide](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-codex-compact/benchmark) for manifests, repetitions, commands, privacy, cost semantics, and interpretation limits.

## 🧪 Development

From the repository root:

```bash
npm --workspace @narumitw/pi-codex-compact run check
npm test
just pack codex-compact
```

See [`docs/implementation-notes/codex-compaction-mechanism.md`](../../docs/implementation-notes/codex-compaction-mechanism.md) for the underlying Codex mechanism research and the extension boundary.

## 🔎 Keywords

Pi extension, Pi coding agent, OpenAI Codex, OAuth, Remote Compaction V2, opaque checkpoint, Responses API, context compaction.

## 📄 License

[MIT](LICENSE)
