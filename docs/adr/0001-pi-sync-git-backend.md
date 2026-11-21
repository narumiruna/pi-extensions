# ADR: pi-sync Git backend

## Status

Accepted on 2026-07-27 and maintained by the current `packages/pi-sync` implementation.

## Context

Pi Sync separates snapshot collection, reviewed local apply, backup, rollback, and lifecycle policy
from remote persistence through `SyncBackend`. Git must fit that contract while retaining native
commit history and exact ref-update leases, without touching a user's working tree or treating Git as
a confidentiality boundary.

The first implementation proposal stored one gzip bundle per commit. Before release, that was
replaced by a strict manifest plus raw Git blobs so unchanged files can reuse object identity and
changed content remains pack/delta-friendly. S3/R2 and WebDAV continue to use the snapshot codec; the
Git representation is intentionally backend-specific.

## Decision drivers

- Preserve the backend-neutral snapshot/content/reference/revision contract.
- Publish with an exact expected-ref lease and reconcile ambiguous transport outcomes.
- Keep Git state, indexes, temporary payloads, hooks, prompts, and cleanup away from user working
  trees.
- Fail closed on malformed branch content, unsafe paths, unsupported object formats, excessive
  payloads, and untrusted terminal text.
- Keep history and rollback append-only from Pi Sync's perspective.

## Decision

### Repository representation

Each publication is one commit on one Pi-Sync-owned branch. The reviewed version 3
`syncSetups.<name>.storage.path` is the publication root:

```text
<storage.path>/
├── manifest.json
└── files/
    ├── settings.json
    ├── keybindings.json
    └── sessions/…
```

`manifest.json` is the authoritative Git wire format. It records snapshot metadata and an ordered
list of `{ path, sha256, size }` entries. Every declared `files/<path>` is a regular `100644` blob containing the exact decoded snapshot
bytes. Reads require exact recursive blob/file membership: only the manifest and declared payload
blobs may appear at the reviewed root. Git's recursive leaf listing does not expose undeclared empty
tree objects, which carry no file bytes. File mode, size, SHA-256, metadata, timestamps, paths,
uniqueness, file/directory prefix consistency, and total bounds are validated before an in-memory
snapshot is returned.

Writes decode and validate content into a private temporary directory, hash it through one bounded
`hash-object -w --no-filters --stdin-paths` operation, construct a tree through a private temporary
index, and remove temporary payloads on success, failure, cancellation, replacement, or shutdown.
Reads use exact tree inspection and bounded `cat-file --batch`. No checkout, attributes,
clean/smudge filters, or user index/worktree participates.

Gzip is not used by this backend and was never an encryption boundary. The unreleased gzip manifest
format is unsupported and fails closed with guidance to recreate only the Pi-Sync-owned branch.

### Contract mapping

- `snapshotId` is the validated logical snapshot ID embedded in the manifest; it is neither the
  commit reference nor a content digest.
- `snapshotRef` is the publication commit SHA, so repeated publication of the same snapshot remains
  independently addressable.
- `revision` is an opaque backend/identity-scoped encoding of the owned ref tip SHA. Only the Git
  backend decodes or compares it.
- `listHistory` follows first parents, validates each publication, and returns valid entries in
  oldest-first order.
- `readSnapshot` accepts a retained full commit SHA or resolves an unambiguous snapshot ID through
  bounded first-parent history.

Rollback reads a historical publication through the contract, applies current local policy, and
publishes a new child commit. It never resets or rewrites the branch.

### Version 3 settings and identity

A storage connection owns the credential-free remote:

```json
{
  "storageConnections": {
    "github": {
      "type": "git",
      "remote": "git@github.com:owner/private-pi-sync.git"
    }
  }
}
```

A sync setup owns the exact branch and publication root:

```json
{
  "syncSetups": {
    "home": {
      "storage": {
        "connection": "github",
        "branch": "pi-sync/home",
        "path": "pi-sync/home"
      },
      "sync": {
        "include": ["settings.json", "AGENTS.md"],
        "automatic": false
      }
    }
  }
}
```

`branch` is stored without `refs/heads/`; traversal, controls, option-like values, ambiguous names,
and full refs are rejected. `path` is a normalized relative POSIX path with no empty, dot, dot-dot,
`.git`, control, or backslash components. The local setup name does not implicitly rename either
coordinate.

The backend identity hashes normalized secret-free remote identity, branch, and publication path.
Equivalent supported SSH spellings share one remote identity. HTTPS userinfo/passwords are rejected;
SSH usernames remain addressing data.

One branch is operationally owned by one reviewed publication root because every commit contains a
complete exact tree. The manager therefore requires a new branch when changing a setup's path.
Version 3 duplicate-location validation compares normalized remote, branch, and path, so direct JSON
can express the same branch with a different path; that does not create branch multiplexing. A reader
at the other path rejects the complete branch tree as unrelated before publication, and exact leases
prevent silent overwrite. Users must assign a distinct branch to every Git setup.

### Cache and filesystem ownership

Each backend identity owns a private bare SHA-1 repository at `git/<identity>/repository.git` beneath the active Pi Sync state directory.
The package README owns the current canonical and legacy state-directory paths and their reviewed migration procedure.
The backend never discovers or mutates the process cwd's repository, working tree, index, hooks, or config.
A missing, partial, non-bare, non-SHA-1, malformed, or unusable ordinary cache is removed and rebuilt without modifying settings, local sync state, backups, or remote data.
A symlinked cache fails closed and requires explicit user inspection or removal; the backend never follows or automatically removes that link.

Every operation against the initialized private repository supplies `--git-dir`; version discovery
and explicit-path `git init --bare <cache>` do not require it. Commit construction also supplies a
private `GIT_INDEX_FILE`. Shared-cache initialization/fetch work is serialized, temporary refs are
uniquely named and removed, and automatic maintenance is disabled. Removing a verified ordinary
private cache is safe recovery because the owned remote ref remains authoritative; symlink refusal
requires inspection before manual removal.

### Bootstrap, publication, and consistency

The remote repository must already exist; the owned branch may be absent. Existing unrelated refs are
allowed. An existing owned branch is accepted only when its recursive blob/file membership matches the strict
publication format. Malformed, unrelated, or additional file content fails closed and is never
deleted automatically; undeclared empty tree objects are outside the current leaf-membership check.

Before creating a commit, the backend fetches the owned ref and compares it with the explicit
expected missing/revision state. The fetched ref, not an earlier discovery response, is authoritative.
The candidate uses the expected tip as first parent, or no parent for a missing branch. Publication
uses an exact lease:

```text
git push --porcelain --no-verify --force-with-lease=<ref>:<expected-sha> <validated-remote> <candidate>:<ref>
```

A missing expectation uses an empty expected value. Plain force, wildcard/deletion refspecs, and
lease-free pushes are forbidden. The remote ref update is the commit boundary: user cancellation is
authoritative before it; push and reconciliation use an independent bounded completion signal.
After failure or a lost response:

- candidate SHA current: committed success;
- another SHA current: typed conflict, possibly after the candidate was briefly active;
- remote state unresolved: `SyncBackendPublicationOutcomeUnknownError`.

### Authentication and process trust

Production accepts credential-free HTTPS, SSH URLs, and conservative scp-like SSH remotes. Local
paths and `file`, `git`, `ext`, arbitrary helper transports, URL query/fragment, and HTTPS userinfo
are rejected. Test-only local remotes require an explicit constructor option.

Git is invoked directly with argument arrays, closed stdin, bounded stdout/stderr, fixed timeouts, and
process-tree cancellation. Inherited Git control variables are removed. Prompts, askpass, hooks,
pagers, editors, and interactive credential managers are disabled through owned environment and
command config. User-approved SSH configuration, agents, proxy commands, and remaining credential
helpers are trusted external authentication inputs; Pi Sync suppresses interaction and redacts
output but does not sandbox them or store credentials.

Git 2.30 or newer and SHA-1 repository format are required by the current cache/protocol. SHA-256 refs
fail with an explicit unsupported diagnostic.

### Retention and limits

Git history retains prior synchronized content, including opted-in sessions, until the repository
owner deliberately rewrites and prunes it. Publishing a later snapshot or deleting a local setup or
cache does not erase historical secrets.

Individual decoded payloads above 100 MiB are rejected before commit construction; documentation
warns at 50 MiB and recommends S3/WebDAV for large or high-churn binary/session archives. Git may
reuse blobs and delta-compress packs, but retained history still grows cumulatively. Pi Sync does not
rewrite remote history or run remote garbage collection.

## Consequences

### Positive

- Native commits and stable raw blobs provide reusable objects and directly addressable history.
- Exact leases expose concurrent changes, including missing-branch creation races.
- A disposable private cache isolates Git mechanics from user repositories and is recoverable.
- Strict blob/file membership validation prevents unrelated or malformed file content from being
  replaced.

### Negative

- Git is an additional runtime dependency and the current implementation supports only SHA-1.
- Every setup needs an exclusive branch even though version 3 exact-location duplicate validation
  includes path.
- Historical content and secrets persist until repository-owner history rewriting.
- Provider limits and cumulative growth make Git unsuitable for some datasets.

## Alternatives rejected

- **One gzip bundle per commit:** weak object reuse/delta behavior and another full compressed object
  per publication.
- **Git LFS or release assets:** provider-specific authentication and atomicity dependencies.
- **Normal or unconditional force push:** cannot protect reviewed concurrent publication.
- **User working tree:** risks hooks, dirty index/worktree state, unrelated config, and destructive
  cleanup.
- **Credentials in settings or remote URL:** conflicts with private-output and redaction guarantees.

## Verification

The executable evidence is in:

- `packages/pi-sync/test/git-backend-contract.test.ts`
- `packages/pi-sync/test/git-backend.test.ts`
- `packages/pi-sync/test/git-config.test.ts`
- `packages/pi-sync/test/git-runner.test.ts`
- `packages/pi-sync/test/git-routes.test.ts`
- `packages/pi-sync/test/git-ui.test.ts`
- the shared backend/orchestration/lifecycle suites
