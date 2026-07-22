# Pi Langfuse Git metadata plan

## Goal

Attach the active Git branch to every Langfuse conversation as both trace metadata and a filterable tag, with commit/detached metadata for unambiguous source context.

## Architecture

- Resolve Git state once in `before_agent_start`, so the value represents the branch at conversation start.
- Run bounded, non-shell `git symbolic-ref` and `git rev-parse` commands through `pi.exec`.
- Add `pi.git.branch`, `pi.git.commit`, and `pi.git.detached` to the `pi.conversation`/`pi.agent` metadata.
- Add `branch:<name>` to trace tags; use `git:detached` when only a detached commit is available.
- Omit Git metadata without warning outside a repository or when Git lookup fails.

## Non-Goals

- Do not put branch names into trace or observation names.
- Do not capture remotes, repository URLs, dirty state, diffs, or file names.
- Do not add Git configuration or block tracing when Git is unavailable.

## Plan

- [x] Add deterministic resolver tests for branches, detached HEADs, and non-repositories; verified by focused resolver tests.
- [x] Add Git metadata/tag inputs to the conversation recorder and lifecycle integration; verified by recorder and lifecycle hierarchy assertions.
- [x] Document filtering behavior and the metadata privacy boundary; verified in the README and `/langfuse` privacy help test.
- [x] Run focused and repository verification plus the Langfuse package dry run; verified by 35 focused tests, `npm run check` with 1,023 passing tests, and `npm run pack:langfuse`.

## Completion Checklist

- [x] Normal branches produce `pi.git.branch`, commit metadata, and `branch:<name>`.
- [x] Detached HEADs produce commit/detached metadata and `git:detached`.
- [x] Lookup failures do not interrupt Pi or create misleading Git fields.
- [x] `captureContent: false` still behaves as documented: content is hidden while Git context remains metadata.
