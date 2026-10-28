# Checkpoint replay after a provider switch

Validation date: October 18, 2026. Environment: Pi 1.3.0, `@narumitw/pi-codex-compact` 0.56.1 with this patch, Linux, Node 24.21.0. Source: a custom Responses provider using `remote-v2`; target: Pi's built-in `openai` provider. Both use `openai-responses` and `openai-responses-v1`.

## Failure and cause

An old session resumed successfully on its custom provider. After switching to `openai`, normal inference failed with HTTP 400, `invalid_encrypted_content`: the saved compaction item could not be decrypted or parsed. Inspection matched the error's item ID to the preceding custom-provider checkpoint and the subsequent provider change. The supplied session reference and the session containing that exact error were different; both were checked locally.

The extension used API/profile compatibility to permit opaque replay across provider IDs. These labels describe request shape and authorization; they do not prove shared encryption keys. It injected custom-provider ciphertext into the OpenAI request. This differs from the original [same-provider model-switch bug](model-switch-validation.md): concrete live tests showed the tested models could reuse opaque state on one backend, so exact model-ID equality remains unnecessary there. No general claim about encryption-key ownership is needed to explain the observed cross-provider rejection.

## Repair

| File | Behavior |
| --- | --- |
| `src/codex-compact.ts` | Require issuer provider identity for direct opaque replay; transfer through the issuer on compatible provider changes; block failed/stale transfers and unresolved foreign markers. |
| `src/checkpoint-portability.ts` | Resolve issuer model/auth separately, project plaintext summaries, and find persisted transfers by compaction entry plus checkpoint ID. |
| `src/checkpoint-recovery.ts` | Share the existing validated, tool-free plaintext summarization path with ordinary replay transfer. |
| `src/checkpoint.ts` | Explain issuing-provider requirements in visible checkpoint markers. |
| `test/provider-switch.test.ts` | Cover transfer, persisted reload/resume/fork reuse, source unavailability/failure, disabled recovery, stale model/branch, abort/reload cancellation, wrong saved identity, same-provider cross-model replay, and cross-provider compaction. |
| `test/lifecycle.test.ts` | Keep custom-API replay assertions within their issuing provider. |
| `docs/implementation.md` | Document provider boundary, persistence, cancellation, and transfer limits. |

With summary recovery enabled, the first request after switching asks the original provider/model to summarize the saved checkpoint with tools disabled. The selected provider receives plaintext plus retained recent messages. The extension saves the validated summary in a branch-local Pi custom entry; reload, resume, and fork can reuse it. Later cross-provider compaction publishes an ordinary plaintext compaction. The original opaque checkpoint is preserved until superseded by a new compaction.

Source authentication is resolved independently of target authentication. Failed or disabled transfer stops the request and preserves history. Changing model ID within the same authorized provider/API/profile continues to use opaque replay.

## Tests and observed results

The new regression failed before repair: the simulated target returned 400 rather than 200 when foreign opaque state reached it. After repair, **25 package test files / 558 tests passed**, including **12 new provider-switch tests**. Package build, source typecheck, focused test typecheck, and focused formatting checks passed. The generated runtime loaded through real Pi sessions passed **17/17 checks**.

The live test used synthetic assistant-only history and Pi's actual HTTP transport, with independently authenticated source and target providers:

| Operation | Result | Wall time |
| --- | --- | ---: |
| Custom provider compacts | Genuine opaque item; 2,852 encrypted-content characters | 7.657 s |
| Switch to OpenAI; recall | Issuer summary followed by target request; exact `VIOLET-5831` and `CONTINUITY-2048` recall | 9.302 s |
| Reload; recall on OpenAI | Same values; no additional issuer request | 3.481 s |
| Compact with OpenAI selected | Issuer-generated plaintext compaction, `fromHook=true` | 5.123 s |
| Reload; switch back; recall | Same values | 3.259 s |

All seven harness checks passed with zero extension errors. The inspected post-reload OpenAI payload had zero `compaction` items and contained the transferred plaintext fact. The payload observer was reloaded with the extension, so this record does not claim interception of every target request. Unit tests independently assert that foreign opaque state and source credentials are not injected into target payloads.

The two actual saved-session snapshots also passed checkpoint fingerprint validation, issuer-only dispatch, and plaintext projection with **zero external requests and zero original-session writes**. Those checks mocked the issuer response; they do not establish semantic recovery of the business conversations. The live semantic evidence above uses synthetic content only. An initial isolated live run lacked the native OpenAI auth path and stopped at model selection; correcting the harness to reuse native authentication allowed the recorded successful run without copying credentials.

To reproduce the regression and package checks, run the package build/typecheck and `npx vitest run packages/pi-codex-compact/test --config vitest.config.ts` as described in the model-switch report. For live validation, create a source checkpoint containing an assistant-only fact outside the retained window, switch providers, and verify exact recall, plaintext transfer, reload reuse without another issuer request, and further compaction. Never use private production history as a public fixture.

Required root `npm run check` and `npm test` were attempted separately. The focused dependency installation lacks unrelated workspace dependencies; root builds fail on React/Radix, Langfuse, and TUI dependency/type errors. Full-monorepo success is not claimed; upstream CI remains required.

## Limits

The transfer is a lossy model-generated summary and makes an additional issuer inference request. It requires the original model/provider and valid authentication. It cannot decrypt the checkpoint locally or guarantee exact retention of arbitrary facts. With recovery disabled or the issuer unavailable, the request is stopped rather than discarding the opaque history. Providers with different API/profiles retain the existing incompatibility behavior. Provider identity is conservative: reconfiguring the endpoint or account behind the same provider ID may still invalidate existing ciphertext, because saved checkpoints do not contain a cryptographic issuer identity.

Public model labels are normalized to `gpt-6.1-sol` and `gpt-6-astra`. Private endpoints, credentials, raw session IDs, local deployment paths, and business conversation content are excluded.
