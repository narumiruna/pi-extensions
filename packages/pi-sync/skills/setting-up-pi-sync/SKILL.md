---
name: setting-up-pi-sync
description: Set up or reconfigure pi-sync safely, including choosing Git, WebDAV, Cloudflare R2, or S3 storage, preparing prerequisites, selecting content, validating the setup, and choosing the first push or pull. Use when a user asks to install, configure, initialize, validate, onboard another device, or troubleshoot first-time pi-sync setup.
license: MIT
disable-model-invocation: true
---

# Setting Up Pi Sync

Help the user reach one verified first sync without exposing credentials to the model.

## Protect credentials and data

Prefer the interactive `/sync` manager because it masks secret access keys, session tokens, and WebDAV passwords and writes version 3 settings atomically.

Access key IDs and WebDAV usernames are visible during input; warn the user before screen sharing or recording.

Never ask the user to paste access keys, secret keys, session tokens, passwords, or a complete `pi-sync.json` into chat.

Do not read or print `pi-sync.json`, because it can contain storage credentials.

Use `/sync config`, `/sync status`, and `/sync doctor` for redacted diagnostics.

Do not create a bucket or repository, install the package, or run a remote operation without the user's approval.

Never use `--yes`, `--force`, `rollback`, `unlock --stale`, or `migrate-state` as a setup shortcut.

Keep sessions excluded unless the user explicitly accepts that session JSONL can contain prompts, tool output, paths, images, and secrets.

Stop without replacing the file if existing settings are malformed, unsupported version 1 or 2, or non-empty and unversioned.

## Establish the setup plan

Confirm the backend, setup name, exact remote location, authoritative first copy, included content, and automatic-sync preference.

Treat the local device as authoritative only when the user intends the first operation to publish its content.

Treat remote storage as authoritative when onboarding a device to an existing pi-sync location.

Use a dedicated remote path, and do not reuse a location owned by another setup unless the user intends to join that exact sync history.

Choose backend prerequisites from this table:

| Backend | Required before setup |
| --- | --- |
| Cloudflare R2 | Existing bucket, account endpoint, access key ID, secret access key, and session token when using temporary credentials. |
| Other S3-compatible storage | Existing bucket, HTTPS endpoint, region, access key ID, secret access key, and session token when using temporary credentials. |
| WebDAV | HTTPS collection URL, username, app password, and a server that supports strong ETags plus conditional writes. |
| Git | Existing remote repository, Git 2.30 or newer, a SHA-1-format remote, and working non-interactive SSH or credential-helper authentication. |

For Git, use a credential-free SSH or HTTPS remote and never embed userinfo, passwords, or tokens in the URL.

## Guide the interactive setup

If `/sync` is unavailable, first check `pi list` for an existing installation in the current project's global or project scope.

For an installed package, ask the user to open `pi config` in their terminal and re-enable the pi-sync extension resource, checking project overrides with Tab or `pi config -l`.

A package filter can leave the skill enabled while disabling the extension; reinstalling preserves that filter.

Ask the user to reload or restart Pi, and if `/sync` is still unavailable, inspect extension-load errors or launch flags such as `--no-extensions` instead of repeatedly reinstalling.

Only when the package is absent, ask before installing it with:

```bash
pi install npm:@narumitw/pi-sync
```

Ask the user to reload or restart Pi after installation.

In a Pi TUI, ask the user to run `/sync` and choose **Set up sync**, or run `/sync init` directly.

If settings already exist, use the manager's **Settings**, **Sync setups…**, and **Storage connections…** actions instead of overwriting the file.

Guide the user through these decisions:

1. Select the prepared backend.
2. Review or enter clear names for the sync setup and reusable storage connection.
3. Enter the exact backend-specific bucket, branch, and storage path requested by the wizard.
4. Choose **Recommended Pi settings** or **Minimal settings** when offered, then adjust **Included content** from **Settings** if needed.
5. Keep automatic sync off until the first manual sync is verified unless the user explicitly prefers otherwise.
6. Keep sessions off unless the privacy acknowledgement is deliberate.
7. Review the backend, remote location, included content, automatic-sync choice, and masked credential summary before saving.

For temporary S3 or R2 credentials, choose **Store temporary credentials privately** and enter the session token in its masked prompt.

For an existing connection, use **Storage connections… → Edit storage connection… → Change credential source** to replace the complete credential set; keep the token out of chat, shell arguments, and logs.

Temporary credentials expire; replace them through the same reviewed flow before the next transfer when needed.

Explain that saving a setup changes only local settings and does not contact, create, pull from, or publish to remote storage.

## Validate before the first transfer

Ask the user to run `/sync config` and confirm the setup name, backend, storage path, included content, and automatic-sync state.

For Git, `/sync config` can abbreviate an SCP-style remote to its host, so also open `/sync` → **More… → Storage connections…**, select the configured connection, and confirm the full repository path shown in **Endpoint** together with the branch and storage path from config.

Do not approve an exact Git destination from a host-only summary.

For WebDAV, confirm the complete collection URL during the storage-connection input step and its setup storage path in config; URL summaries intentionally hide the collection path.

Explain that `/sync doctor` validates local configuration, selected files, secret warnings, and lock state for every backend.

Explain that Git diagnostics contact the remote and inspect the configured sync branch.

Explain that WebDAV diagnostics contact the server, run and clean up a conditional-write probe, and may repair the active history entry.

Explain that S3 and R2 diagnostics are local-only and do not validate the endpoint, bucket, credentials, permissions, or connectivity.

After the user accepts any backend-specific remote checks, ask them to run `/sync doctor` and resolve every blocking result before transfer.

Choose the first reviewed operation from the intended source of truth:

- For a new or empty remote with authoritative local content, use `/sync push`.
- For an existing remote that this device should adopt, use `/sync pull`.
- For an existing remote with authoritative local content, open `/sync` → **More… → Push to remote…** and use its reviewed local-wins resolution: **Use local as initial source…** or **Keep local content and replace remote…**.
- When the source of truth is uncertain, use `/sync diff` and review exact changes before choosing one of these paths.

If a direct push or pull reports a conflict, return to `/sync` → **More…** and choose **Push to remote…** or **Pull from remote…** for the intended source of truth and reviewed resolution instead of retrying the direct command.

Do not choose **Sync now** when the user has explicitly chosen a direction, because it decides the direction automatically.

The manager performs the guarded forced operation internally after preview and confirmation; this is not permission to type `--force` or bypass review.

Use the interactive operation without `--yes` or `--force`, and require the user to review the displayed writes, deletions, remote publication, and conflict guidance.

After a successful first operation, ask the user to run `/sync status` and enable automatic sync only if desired.

## Finish with evidence

Report setup as complete only when the redacted configuration matches the plan, doctor has no blocking failure, one reviewed initial operation completed, and status shows the expected state.

If any step is cancelled or fails, preserve the current settings and data, report the exact safe next action, and do not claim setup is complete.
