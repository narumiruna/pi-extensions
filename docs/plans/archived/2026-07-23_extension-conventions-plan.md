# Extension Conventions Plan

## Goal

Create an English `docs/extension-conventions.md` that distinguishes official Pi requirements, monorepo requirements, and preferred patterns; gives maintainers actionable command, menu, lifecycle, package, UI, documentation, and verification guidance; and is discoverable from `AGENTS.md`.

## Context

- New extensions must follow the full convention set; existing extensions adopt the relevant section when that area is changed.
- The document will use MUST/SHOULD/MAY and identify each MUST's actual verification method as Validator, Test, Review, or Smoke.
- `docs/extension-settings.md` remains the detailed settings authority; the new document summarizes and links to it.
- Pi guidance targets the latest release and records the version reviewed.

## Non-Goals

- Do not change extension runtime behavior, package metadata, or README content.
- Do not add validators solely for this documentation change; future extension work may add reliable checks when touching the relevant area.
- Do not duplicate the full Pi API reference or the detailed settings guide.

## Plan

- [x] Verify the current Pi release and canonical official documentation links; `npm view` reported 0.81.1 and all three `earendil-works/pi` documentation URLs returned HTTP 200.
- [x] Add `docs/extension-conventions.md` with scoped authority, official Pi guidance, monorepo conventions, verification labels, and separate new-extension and touched-area checklists; a focused script confirmed every MUST names an actual verification method and the settings section links to `docs/extension-settings.md`.
- [x] Update `AGENTS.md` with a concise pointer requiring maintainers to read the conventions document for new extensions and touched areas without duplicating the guide.
- [x] Run formatting/document checks and the repository CI-equivalent gate; `npm run check` passed all 1,135 tests and `git diff --check` passed. Biome reported that the Markdown files are outside its handled file set.
- [x] Review the final diff for scope, source accuracy, internal consistency, and whitespace errors; only `AGENTS.md`, the conventions guide, and this plan are changed.

## Risks

- Official guidance can drift; mitigate with canonical source links and a reviewed Pi version rather than copied API tutorials.
- Overstating observed patterns as requirements could force unrelated migrations; mitigate by separating MUST/SHOULD/MAY and applying touched-area adoption to existing packages.
- Verification labels can claim enforcement that does not exist; label only current checks as Validator and use Test, Review, or Smoke otherwise.

## Completion Checklist

- [x] `docs/extension-conventions.md` exists, is English, and clearly separates official, repository, and preferred guidance.
- [x] A focused verification script confirmed all 23 MUST rules name a real Validator, Test, Review, or Smoke method.
- [x] Settings ownership remains in `docs/extension-settings.md` without material duplication.
- [x] `AGENTS.md` points agents to the new guide.
- [x] No extension implementation, manifest, or README is changed.
- [x] Required checks pass; archive this completed plan under `docs/plans/archived/` as the final file operation.
