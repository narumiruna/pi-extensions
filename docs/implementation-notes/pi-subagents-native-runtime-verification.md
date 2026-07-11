# pi-subagents native runtime verification

Date: 2026-07-11

## Automated evidence

- `npm run check`: passed with Biome, extension boundaries, all workspace typechecks, and 268 tests.
- `just pack-subagents`: passed; dry-run package contains 21 expected files, including transport and workspace modules.
- Transport contract behavior is exercised through fake transport lifecycle tests and the subprocess-backed local Pi smoke test.
- Hierarchy tests cover root/child/grandchild metadata, depth rejection, child ordering, cyclic restore rejection, subtree close, and inert migration.
- Mailbox tests cover bounded bytes/count, empty and cross-tree rejection, message IDs, deduplication keys, one-turn unread consumption, and completion delivery for successful and rejected child turns.
- Workspace tests create and remove real detached Git worktrees from repository roots and nested cwd values, verify ownership retry behavior, reject duplicate owners and dirty repositories, and exercise cleanup-all.
- Persistence tests cover version-1 migration, version-2 writes, hierarchy-aware retention, mailbox sanitation, unknown versions, corruption quarantine, atomic replacement, and deletion.
- Additional edge tests cover split UTF-8 JSON chunks, malformed limits, nested/unclosed private markers, duplicate context sources, recent-summary retention, active-ancestor expiry, closed-record bounds, and task/output bounds.

## Runtime evidence

A local `pi -e ./extensions/pi-subagents -p ...` scenario enabled stateful tools temporarily, spawned and waited for a root agent, spawned a child using `parentId`, waited for completion, and read the parent's completion mailbox. It returned `HIERARCHY_MAILBOX_OK`. The original settings file was restored and the smoke-test state file was removed.

## Native API boundary

Native child sessions, policy inheritance, transcript switching, and agent-navigation shortcuts remain blocked because the supported project dependency does not expose those APIs. The upstream-ready contract is documented in `pi-subagents-core-api-proposal.md`. No private imports or runtime casts were added. `SubprocessTransport` remains the supported fallback and the registry is ready for a native adapter when public APIs exist.

## Rollback

The changes are additive. Existing batch and stateful request shapes still work. Removing the new mailbox/hierarchy parameters returns behavior to root logical agents. `SubprocessTransport` remains the execution path. Persisted version-1 records migrate without destructive rewrites, while unknown future versions are quarantined.
