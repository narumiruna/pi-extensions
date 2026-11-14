# ADR: pi-sync version 3 settings and sync setup model

## Status

Accepted as the legacy storage-connection and setup model.
Settings versions 3–5 retain per-setup include lists until explicit migration; version 6 replaces file selection with one shared `.syncignore` while retaining storage connections and setup behavior.
See the [current settings reference](../../packages/pi-sync/skills/configure-pi-sync/references/configuration.md#shared-syncignore-rules).

## Context

Earlier Pi Sync settings mixed connection credentials, remote coordinates, included-content policy,
automatic behavior, and the selected destination. The words profile, target, destination, and saved
connection also varied between JSON, menus, commands, and backend adapters.

The product needs two user-owned concepts:

- a reusable **storage connection** that answers how to access one storage service; and
- a named **sync setup** that answers where and what to sync through one connection.

The reset also needed to remove accumulated version 1/2 compatibility ambiguity. Automatically
migrating credentials, paths, backend fields, and remote identity could redirect publication, so the
new schema was approved as a fail-closed breaking boundary.

## Decision

### Canonical document

The canonical private file is `<agent-dir>/pi-sync.json`:

```json
{
  "version": 3,
  "activeSyncSetup": "home",
  "onSwitch": "ask-before-pull",
  "storageConnections": {
    "r2": {
      "type": "s3",
      "endpoint": "https://example.r2.cloudflarestorage.com",
      "region": "auto",
      "credentials": {
        "accessKeyId": "...",
        "secretAccessKey": "..."
      }
    }
  },
  "syncSetups": {
    "home": {
      "storage": {
        "connection": "r2",
        "bucket": "personal-pi",
        "path": "pi-sync/home"
      },
      "sync": {
        "include": ["settings.json", "AGENTS.md", "skills", "prompts", "themes"],
        "automatic": true
      }
    }
  }
}
```

The package README owns the complete field reference and backend examples. This ADR owns why the
concepts and failure boundaries are separate.

### Storage connection ownership

`storageConnections` is the only reusable access catalog. Every own-property key names one strict
discriminated connection:

- `s3`: endpoint, region, access-key credentials, and an optional temporary session token; Cloudflare R2 is an S3 setup preset, not a persisted fourth type;
- `git`: credential-free SSH/HTTPS remote, relying on user Git/SSH authentication; or
- `webdav`: HTTPS URL plus username/password credentials.

Mixed fields fail closed. Git URLs cannot contain credentials. Connection names such as
`__proto__`/`constructor`, empty or whitespace-changing names, controls, malformed credentials, and
unsupported own fields from version 1/2 are rejected before backend construction. Unknown future
fields at retained version 3 boundaries are preserved but do not bypass recognized-field validation.

A referenced connection cannot be removed. Editing a shared connection reviews the affected setup
names and revalidates the dependency set inside the settings mutation protocol before publication.

### Sync setup ownership

`syncSetups` owns exact backend coordinates and sync policy. A referenced connection's type selects
the accepted storage shape:

- S3/R2: `connection`, `bucket`, and complete relative `path`;
- Git: `connection`, `branch`, and complete relative `path`; or
- WebDAV: `connection` and complete relative `path`.

Backend-incompatible fields are rejected rather than ignored. `storage.path` is the complete reviewed
location beneath the backend container. The local setup name is an identifier only: creating,
renaming, or switching a setup never silently derives or changes the remote path.

Normalized backend location tuples must be unique and do not include the setup name. For S3 and
WebDAV this prevents two local state records from managing one active pointer. Git's tuple includes
remote, branch, and path: exact duplicates are rejected, but direct JSON can still name one branch
with different paths. Git operationally requires a distinct branch per setup, as recorded in
`docs/adr/pi-sync-git-backend.md`.

`activeSyncSetup` must reference an own-property setup whenever the catalog is non-empty and must be
absent when it is empty. A current setup cannot be removed while alternatives exist; switch first.
Only the current setup participates in automatic lifecycle sync.

### Included content and automatic policy

Each setup has one ordered, duplicate-free `sync.include` list and an explicit boolean
`sync.automatic`.

The include list accepts supported Pi roots and safe agent-relative paths. Absolute paths, traversal,
backslashes, controls, denied private/settings paths, case-ambiguous duplicates, and ambiguous nested
reserved-root paths fail closed. `sessions` is a reserved privacy-sensitive root and retains explicit
acknowledgement and live-session protections.

An empty include list is valid because users may stage a setup before choosing content. It represents
no useful transfer: status/sync must say nothing is selected and must not call the setup up to date.
Unselected remote content remains unmanaged and is preserved during publication.

### Switch policy

`onSwitch` is one document-level policy with three values:

- `ask-before-pull`;
- `pull-after-switch`; or
- `switch-only`.

Switching first performs one atomic settings mutation that changes only `activeSyncSetup`. It does not
implicitly publish. Any post-switch pull carries the selected setup explicitly and runs through the
normal read, preview, backup, conflict, cancellation, and transactional apply safeguards. A failed or
declined pull does not silently switch back or claim local files changed.

### Breaking-version boundary

Version 1, version 2, and non-empty unversioned documents are unsupported. Pi Sync does not migrate,
partially interpret, downgrade, or overwrite them. Loading reports a generic actionable version error
without echoing source bytes or secrets; automatic sync remains paused. Users retain/export the old
file and create a reviewed version 3 document.

An empty/unconfigured state is distinct from an unsupported non-empty document. Missing settings mean
no explicit setup and reads remain side-effect-free.

### Persistence and concurrency

All supported Pi Sync writers participate in one cross-process lock protocol covering the latest
read, complete version 3 validation, mutation, and atomic publication. A mutation:

1. acquires the settings lock;
2. reads the latest canonical/eligible legacy document;
3. parses and validates the complete document;
4. changes only owned fields while preserving unknown retained fields;
5. revalidates the complete result; and
6. publishes privately through same-directory temporary/quarantine handling and rename/exclusive
   installation.

Missing-file reads create no directory, file, lock, or temporary artifact. The first explicit setup
uses exclusive publication so a concurrent creator wins rather than being overwritten. Logical no-op
updates retain exact bytes and identity. Failed or raced replacement restores/retains exact prior
private bytes and effective state; malformed, invalid, unsupported, or symlinked files remain
untouched. POSIX settings are `0600`.

Lock-unaware editors and older versions are outside this serialization boundary. The package README
instructs users not to save manually while a Pi Sync mutation is running.

### Canonical filename recovery

A valid private `pi-sync.local.json` containing version 3 bytes may be copied byte-for-byte into the
canonical `pi-sync.json` under the same lock and exclusive-publication checks. The legacy file remains
as a private recovery copy because older uncoordinated writers could replace it. When both exist, the
canonical file wins. Invalid, unsupported, changed, unsafe, or symlinked legacy content is never
removed or rewritten.

Canonical, legacy, temporary, lock, quarantine, and recovery names are denied from synchronized
content.

### Credentials and output

S3 and WebDAV credentials stay in the canonical private file. Menus use masked input where available
and display only presence/source. Credentials and parser source bytes are excluded from settings
reviews, status, notifications, errors, logs, snapshots, and tests. Git credentials remain outside
Pi Sync in the user's Git/SSH mechanisms.

## Consequences

### Positive

- Users reason about reusable access separately from exact sync behavior/location.
- Cross-object validation prevents impossible backend combinations and missing references.
- Setup renaming cannot redirect remote storage.
- One ordered include list removes precedence ambiguity between built-ins, sessions, and extra paths.
- A breaking fail-closed boundary avoids unsafe credential/path migration.
- Settings writes have explicit concurrency, recovery, privacy, and unknown-field guarantees.

### Negative

- Version 1/2 users must recreate settings manually; downgrade also requires a separately retained old
  file.
- Connection validation is cross-object and every mutation must revalidate the whole document.
- Reusable connection edits can affect several setups and therefore require dependency review.
- Lock-unaware editors cannot receive the same serialization guarantee.

## Alternatives rejected

- **Automatic version 1/2 migration:** too much risk of reinterpreting credentials, namespace/path,
  environment precedence, or active remote identity.
- **One object per remote location:** adds a third managed catalog without a demonstrated user need.
- **Setup-name-derived remote paths:** makes a local rename an unexpected remote migration.
- **Project-scoped secrets or environment mirrors:** conflicts with private ownership and creates
  precedence ambiguity.
- **Separate credential file:** duplicates lifecycle/migration policy without changing the owning
  extension.

## Verification

- Schema and remote identity: `packages/pi-sync/test/v3-schema.test.ts`, backend config/state tests,
  and Git/WebDAV config tests.
- Persistence, locking, migration, permissions, and unknown fields:
  `packages/pi-sync/test/config-filename.test.ts` and settings-management tests.
- CRUD, switching, dependency review, and failed-save rollback: settings-management,
  menu-wording, review-feedback, setup, and backend UI tests.
- Included content, sessions, and path safety: sync policy/storage/snapshot tests.
- User-facing field reference and recovery: `packages/pi-sync/README.md`.
