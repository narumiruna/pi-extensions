# Pi Sync settings reference

[Back to README](../README.md)

- [Complete version 3 example](#complete-version-3-example)
- [Required backend shapes](#required-backend-shapes)
- [Included content](#included-content)
- [Unsupported old settings and recovery](#unsupported-old-settings-and-recovery)

## ⚙️ Settings

The canonical private user file is:

```text
~/.pi/agent/pi-sync.json
```

Pi's configured agent directory replaces `~/.pi/agent` when applicable.
Missing settings load as unconfigured without creating an agent directory, file, temporary file, or lock.

An explicit setup creates the file atomically.
On POSIX, pi-sync creates and replaces it with mode `0600`.
Pi-sync processes coordinate settings access through `pi-sync.json.mutation-lock`; lock-unaware editors are outside that serialization boundary and should not save the file while a pi-sync settings operation is running.
Credentials stay in this canonical private file and are never shown in menus, reviews, status, notifications, errors, logs, or completion metadata.

A private `pi-sync.local.json` containing a valid version 3 document is copied byte-for-byte to `pi-sync.json`.
The old file remains as a recovery copy.
If both paths exist, `pi-sync.json` wins and the legacy file remains untouched.

### Complete version 3 example

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
        "accessKeyId": "<access-key-id>",
        "secretAccessKey": "<secret-access-key>"
      }
    },
    "github": {
      "type": "git",
      "remote": "git@github.com:owner/private-pi-sync.git"
    },
    "nextcloud": {
      "type": "webdav",
      "url": "https://cloud.example.com/remote.php/dav/files/user",
      "credentials": {
        "username": "user",
        "password": "<app-password>"
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
    },
    "git-backup": {
      "storage": {
        "connection": "github",
        "branch": "pi-sync/home",
        "path": "pi-sync/home"
      },
      "sync": {
        "include": ["settings.json", "AGENTS.md"],
        "automatic": false
      }
    },
    "webdav-backup": {
      "storage": {
        "connection": "nextcloud",
        "path": "pi-sync/home"
      },
      "sync": {
        "include": ["settings.json", "sessions"],
        "automatic": false
      }
    }
  }
}
```

Cloudflare R2 is persisted as `"type": "s3"`; R2 is a setup preset, not another schema type.
Temporary S3 credentials may additionally include `credentials.sessionToken`.

### Required backend shapes

- **S3/R2 connection:** `type`, `endpoint`, `region`, and `credentials.accessKeyId` / `credentials.secretAccessKey`.
- **S3/R2 setup storage:** `connection`, `bucket`, and complete relative `path`; `branch` is rejected.
- **Git connection:** `type` and a credential-free SSH or HTTPS `remote`.
- **Git setup storage:** `connection`, `branch`, and complete repository `path`; `bucket` is rejected.
- **WebDAV connection:** `type`, HTTPS `url`, and `credentials.username` / `credentials.password`.
- **WebDAV setup storage:** `connection` and complete relative `path`; `bucket` and `branch` are rejected.

Every setup requires `sync.include` and explicit `sync.automatic`.
`activeSyncSetup` must reference an own-property setup when any setups exist and must be absent when the setup catalog is empty.
A referenced connection cannot be removed.
The current setup must be switched before removal.
Two setups cannot resolve to the same normalized backend location.

`onSwitch` accepts:

- `ask-before-pull` — switch, then ask in TUI whether to start a reviewed pull;
- `pull-after-switch` — require observable UI and start the normal reviewed pull;
- `switch-only` — switch without reading or applying remote content.

### Included content

`sync.include` is ordered and duplicate-free.
Supported Pi roots are:

```text
settings.json, keybindings.json, models.json, AGENTS.md, APPEND_SYSTEM.md,
skills, prompts, themes, extensions, sessions
```

Safe agent-relative custom files or directories may also be included.
Absolute paths, `..`, backslashes, controls, denied secret/settings paths, duplicate case variants, and ambiguous nested paths under reserved roots are rejected.

An empty array is valid.
It means no useful transfer is selected: **Sync now** reports the condition and does not claim that the setup is up to date.
Unselected content remains unmanaged locally and is preserved when republishing existing remote snapshots.

The Included Content editor is a standard bounded multi-select backed by one in-memory draft.
Toggles never write settings.
**Add custom path…** accepts a safe agent-relative file or directory even when it does not exist locally yet, allowing a new environment to select content that exists only in the remote snapshot.
Leaving the editor opens an exact Include/Exclude review with **Save changes**, **Discard changes**, and **Continue editing**; only reviewed Save publishes, while Continue preserves the draft and Discard/cancellation preserves the settings bytes.
RPC remains a read-only summary with the manual `sync.include` path.

Every new snapshot stores the normalized included-content selection separately from the files that happened to exist.
This preserves selected-but-missing paths without syncing `pi-sync.json`, storage credentials, automatic-sync preferences, or setup names.
**Settings → Compare synced content** opens the same review-first flow as a manager operation when local and remote lists differ.
Adoption revalidates the remote head, immutable snapshot, reviewed storage coordinates, and local include list before one atomic settings update.
The saved state changes only `sync.include`, preserves unknown settings fields, and never pulls files or writes sync state.
Its explicit Continue action starts a fresh **Sync now** route, while **Done** leaves the reviewed settings change saved without implying a file operation.
Keeping this device's list opens the reviewed force-push path and explicitly replaces the remote policy while preserving eligible unmanaged remote files.

Automatic sync and pull, including forced pull, pause on an explicit remote-policy difference rather than silently expanding local scope.
Status reports matches and exact local-only/remote-only paths.
Old snapshots remain readable.
Because they have no authoritative selection, pi-sync offers only a clearly labeled read-only partial discovery from safe remote file roots; selected-but-missing and preserved-unmanaged intent cannot be reconstructed.
Use **Add custom path…** for any needed path.

Adding `sessions` requires a privacy acknowledgement in interactive flows.
Session JSONL can contain prompts, tool output, file paths, images, and secrets.
Automatic apply protects the currently open session file; restart Pi or resume a pulled session to use newly synchronized conversations.

### Unsupported old settings and recovery

Version 1, version 2, and non-empty unversioned documents are unsupported after the version 3 schema reset.
Pi Sync does **not** migrate, partially interpret, downgrade, or overwrite them.
Automatic sync pauses and reports an actionable version 3 error without displaying secrets.

Recovery:

1. retain the old file byte-for-byte;
2. move it aside manually;
3. create a new version 3 document or run the setup manager;
4. run `/sync doctor`, inspect the exact storage path, and review the first pull or push;
5. restore the retained file and a compatible older package only if rolling back.

Malformed, invalid, unsupported, symlinked, or concurrently changed documents remain untouched.
Failed UI saves keep the previous file and displayed/effective state.
