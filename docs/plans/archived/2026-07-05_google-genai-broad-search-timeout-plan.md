## Goal

Make `pi-google-genai` recover better when Google Search grounding receives an overly broad query. Success means the model is guided to split market-research-style searches, timeout errors explain the likely cause and next step, and the README documents a small-query workflow.

## Context

`google_search` currently sends `query` to the Gemini Interactions API as-is with a default `timeoutMs` of 30 seconds. A query like `2026 AI coding assistant product trends agentic coding IDE local first developer tools web UI Cursor Claude Code GitHub Copilot` mixes trends, product comparison, feature areas, and current-year synthesis, so it can time out. The current timeout error only says the request timed out; it does not tell the user this may be a too-broad query rather than auth failure, sensitive content, or a broken tool.

## Non-Goals

- Do not add an automatic query planner or multi-search orchestration; that adds cost, latency, and source-selection complexity.
- Do not raise the default `timeoutMs` as the main fix; narrower queries are cheaper and more reliable.
- Do not add `@google/genai` or any new dependency.

## Assumptions

- The reported failure is most likely the 30-second timeout, not Google auth, content policy, or API schema breakage.
- Pi reads `promptGuidelines` for registered tools, so a short guideline can influence model tool usage.

## Plan

- [x] Add a timeout-error unit test in `extensions/pi-google-genai/test/google-genai.test.ts` that expects the error to include the timeout duration and advice to split broad queries; verified the test failed before implementation with `npm test`.
- [x] Update the timeout error in `extensions/pi-google-genai/src/google-genai.ts` to say broad trend, multi-product, or market-research queries should be split into smaller `google_search` calls before increasing `timeoutMs`; verified with `npm test`.
- [x] Add a `googleSearchTool.promptGuidelines` rule that broad, multi-product, or trend-synthesis searches should be narrowed or split by product/topic first; verified in the tool-registration test that the guideline contains split/narrow wording, then ran `npm test`.
- [x] Add a short “Large / broad searches” section to `extensions/pi-google-genai/README.md` with the bad example and suggested smaller searches for Cursor, Claude Code, GitHub Copilot, overall trends, and local-first tools; verified with `rg -n "Large|broad|Cursor|Claude Code|GitHub Copilot" extensions/pi-google-genai/README.md`.
- [x] Run `npm run check` to verify Biome, boundary checks, typechecks, and tests.

## Risks

- A timeout can also be caused by temporary Google-side slowness. Phrase the message as a likely recovery path, not a definitive diagnosis.
- Prompt guidelines do not prevent direct manual calls with broad queries, so the timeout hint is still required.

## Completion Checklist

- [x] `google_search` prompts the model to split or narrow broad multi-product research queries; verified by the tool-registration unit test in `npm test` and `npm run check`.
- [x] Timeout errors include an actionable recovery step; verified by the timeout unit test in `npm test` and `npm run check`.
- [x] README documents broad-query failure mode and split-query examples; verified by `rg -n "Large|broad|Cursor|Claude Code|GitHub Copilot" extensions/pi-google-genai/README.md`.
- [x] Repository validation passes; verified by `npm run check`.
