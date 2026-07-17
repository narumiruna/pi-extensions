## Goal

Add a production `@narumitw/pi-telegraph` package that safely creates, reads, and edits public Telegraph pages through Pi tools, with Markdown/raw-node content support, private file-based account storage, mutation confirmation, tests, docs, and repository integration.

## Architecture

- `extensions/pi-telegraph/src/telegraph.ts`: Pi entrypoint, slash command, lifecycle cleanup.
- `config.ts`: canonical `pi-telegraph.json` parsing, private atomic writes, and lazy-account serialization.
- `client.ts`: bounded/cancellable Telegraph API requests and secret-safe error handling.
- `content.ts`: Markdown/Telegraph-node conversion and boundary validation.
- `tools.ts`: create/get/edit contracts, confirmation, partial-edit preservation, status, and output truncation.

## Non-Goals

- Deleting Telegraph pages, project-scoped overrides, Telegraph-specific environment variables, live publication during tests, and package publication.

## Plan

- [x] Scaffolded `extensions/pi-telegraph` metadata, source/test layout, and initial contract tests; `npm test` failed on the intentionally missing `src` modules, confirming the red TDD state.
- [x] Implemented entrypoint registration, `/telegraph status|init|help`, strict private `pi-telegraph.json` storage, and abort-aware in-/cross-process locking; focused config/command tests pass.
- [x] Implemented direct `marked` token conversion, raw-node boundary validation, and deterministic Markdown output; focused conversion, cycle/depth, URL, HTML, table, and 64 KB tests pass.
- [x] Implemented the bounded Telegraph client and create/get/edit tools with confirmation, partial-edit preservation, cancellation/timeout, redaction, status cleanup, truncation, and private temporary-file cleanup; all 24 focused pi-telegraph tests pass.
- [x] Integrated root pack script, `just` pack/try/install/publish aliases, npm 11.16-generated lockfile, root README, and package README; boundary checks report 17 active packages and shared-version discovery includes `extensions/pi-telegraph/package.json`.
- [x] Ran explicit Biome checks, `npm run check`, and `just pack-telegraph`; all 568 tests (567 pass, 1 compatibility skip) passed and the 10-file dry-run package contained only metadata, `LICENSE`, `README.md`, and `src/*.ts`, with no live Telegraph mutation.

## Risks

- Telegraph publication is public and has no delete API; create/edit require explicit confirmation.
- Access tokens grant edit rights; config and temporary output files must remain private and errors/results must redact credentials.
- Concurrent first use could create competing accounts; lazy registration must re-read config under a bounded cross-process lock.

## Completion Checklist

- [x] All specified tool, command, configuration, conversion, API, confirmation, concurrency, cleanup, and redaction behavior is covered by 24 focused deterministic pi-telegraph tests within the passing root suite.
- [x] `npm run check` passes from the repository root (Biome, 17-package boundary check, all workspace typechecks, and 568 tests).
- [x] `just pack-telegraph` contains 10 intended files: package metadata, `LICENSE`, `README.md`, and seven `src/*.ts` modules.
- [x] The completed plan is archived at `docs/plans/archived/2026-07-17_pi-telegraph-plan.md` with verification evidence recorded above.
