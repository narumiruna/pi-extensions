# Network-free usage identity checks

`usage:query:v1` with `refresh: false` currently returns `cache-miss` for every supported provider, even after a successful refresh. The supported Pi public API cannot prove the complete effective authentication identity without potentially running network work. Use an explicitly requested `refresh: true` query to obtain a report.

This is a conservative result required by the [v1 contract](./usage-v1.md), not an empty provider cache. Cache reads do not call auth resolvers, execute credential commands, dispatch credential-source or readiness events, or discover billing targets. The existing in-memory cache remains shared by menu, status, and refresh paths.

## Runtime branch audit

The audit covers the installed Pi implementation used by this repository. Recheck it when Pi changes its public auth API. A new safe cache-hit path needs both authoritative implementation evidence and tests for every applicable precedence and override branch; an unchanged credential snapshot is not sufficient.

| Effective-auth branch | Why local metadata cannot authorize a cache hit |
| --- | --- |
| Current model | Effective model auth composes provider auth and configured model headers; the visible model object does not contain every input |
| Explicit configured provider | Provider auth can differ from model-specific overrides and from another provider's auth |
| Custom model, provider, or resolved origin | A locally visible mismatch can reject a report, but matching visible origins do not prove the resolved origin or credential |
| Runtime key | Runtime credentials can override storage; public auth status reports presence, not effective key identity; empty overrides can fall through |
| Stored literal key | The runtime can use a different credential store, an override, or additional configured headers |
| Stored environment template | Raw stored data is not the resolved value and does not prove the complete effective source |
| Stored credential command | Resolution can execute a command that performs network work; a cached command result is not proof of current composed auth |
| Configured key or header | Literals, environment templates, and commands can participate; configured commands can run at request time |
| Ambient environment | An environment value cannot exclude higher-precedence runtime, storage, or configured auth |
| OAuth outside its refresh window | A still-valid stored token cannot exclude runtime/model overrides or another effective credential store |
| OAuth inside or at its refresh threshold | Resolution can acquire a lock, refresh remotely, and persist credentials; the installed threshold is five minutes before expiry |
| OAuth removed or rotated during resolution | Pi rereads the credential under its lock; an earlier token snapshot cannot authorize publication |
| Extension-owned auth | Public runtime resolvers can delegate to custom code without a network-free guarantee |
| Credential-source/readiness events | Participants can own asynchronous activation or other work; these protocols do not promise a network-free identity read |
| Fireworks target | Resolving even a saved target lists remote accounts; an unresolved target cannot be inferred from an old list |
| Native OpenAI companion | Both native and companion runtime identities, account IDs, origins, matching grants, and opt-in policy must remain valid |

Auth status, model lists, visible provider registrations, raw `readStoredCredential()` results, and usage-owned settings can reject some stale state, but none proves the full identity. Do not compose a partial auth resolver from these observations. In particular, invoking a composed provider's OAuth `toAuth()` is not a workaround: configured headers can still execute commands.

The inspected implementation paths are Pi's `model-registry`, `model-runtime`, and `provider-composer` modules and Pi AI's auth resolver. Usage-specific checks remain in `src/query.ts`, `src/providers/openai-chatgpt.ts`, `src/openai-companion-auth.ts`, and `src/usage-targets.ts`. Production code uses public Pi APIs only; these implementation paths are audit evidence, not imports.

## Provider-specific refresh checks

Refresh continues to use the existing guarded auth path. Native OpenAI requires provider OAuth and a matching complete native grant; its optional companion path validates both identities without claiming independent proof of the same user or workspace. GitHub Copilot and xAI require uniquely matched OAuth credentials, not arbitrary API keys. Moonshot sibling-region queries retain their shared-environment-key restriction. DeepSeek retains its Bearer requirement. All providers retain effective official-origin validation.

API refreshes add request-boundary and final-publication revalidation for every adapter, including adapters that do not perform their own multi-step guards. A changed session, model, credential, target, policy, or query owner cannot publish an API ready result. API refresh bypasses cached reports but not failure backoff, and never falls back to a previous report after failure.

## Capability measurements

Capabilities describe possible normalized fields, not present credentials, entitlement, or enabled optional sources. Every registered adapter supports an explicit read-only refresh in at least one valid auth mode.

| Provider | Possible measurements |
| --- | --- |
| `baseten` | spend |
| `openai` | quota, reset-time; numerical data requires the optional companion source |
| `openai-codex` | quota, balance, reset-time |
| `deepseek` | balance |
| `github-copilot` | quota, reset-time |
| `openrouter` | quota, spend |
| `vercel-ai-gateway` | balance, spend |
| `command-code` | quota, balance, spend, reset-time |
| `fireworks` | spend |
| `opencode-go` | quota, reset-time |
| `kimi-coding` | quota, balance, spend, reset-time |
| `minimax`, `minimax-cn` | quota, balance, reset-time; fields depend on key kind |
| `moonshotai`, `moonshotai-cn` | balance |
| `zai`, `zai-coding-cn` | quota, reset-time |
| `xai` | quota, balance, spend, reset-time; API refresh is explicit and does not start status polling |

OpenRouter's remaining key spend cap is not an account balance. Baseten's consumed credits are spend, not a remaining balance. Native OpenAI does not inherit the unrelated Codex credit-balance metric. Currency, target, and provider semantics remain separate.
