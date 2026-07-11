## Goal

Resolve every README issue found in the repository audit so package descriptions match current behavior, compatibility policy, and documentation conventions.

## Non-Goals

- Change extension runtime behavior or package versions.
- Rewrite deprecated package documentation beyond adding the missing deprecation notice.

## Plan

- [x] Update the root and `pi-retry` READMEs to document generic retryable Codex backend failures; verified against `extensions/pi-retry/src/retry.ts` and the passing generic retry regression test.
- [x] Align the legacy settings filename removal policy in the caffeinate, Chrome DevTools, and Firecrawl READMEs with their runtime notices; verified README and runtime references say removal occurs in a future major release.
- [x] Add the missing deprecation notice to `extensions/deprecated/pi-sidebar/README.md`; verified all five deprecated package READMEs identify their status within the first eight lines.
- [x] Add npm one-off trial commands to the Google GenAI and LSP READMEs; verified both contain `pi -e npm:@narumitw/...` before their local-development examples.
- [x] Run documentation consistency checks and the repository CI-equivalent check; validated 22 README files and completed `npm run check` with 242 passing tests.

## Risks

- Overstating retry matching could imply all Codex failures are retried; keep the wording limited to backend errors that explicitly say the request can be retried.
- Compatibility wording must not promise removal before a major release.

## Completion Checklist

- [x] All audited README findings are resolved, verified by `git diff` across the eight listed README files.
- [x] README links and referenced source/test paths pass the local validation script for 22 repository READMEs.
- [x] Repository checks pass with `npm run check` (`242` tests passed).
- [x] The completed plan is ready to archive under `docs/plans/archived/` with completion evidence recorded above.
