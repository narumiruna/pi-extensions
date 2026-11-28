# Configuration skill verification

Pi advertises the skill's description so a model can load it for a matching request. Explicit invocation remains available. The skill saves authorized routine preferences through the existing daemon and uses the daemon to verify the configured ignore file before editing it locally. Questions and error reports do not authorize edits.
The authoritative configuration text is the [bundled settings reference](../skills/configure-pi-sync/references/configuration.md).

## Representative question review

These are source-grounded answer and handoff reviews, not measured model-quality results.
Each case was checked against the bundled reference and the owning implementation below.
No user settings were read or changed and no backend command was run for these reviews.

| Question | Required answer and user handoff | Implementation evidence |
| --- | --- | --- |
| Turn on debug logging in `pi-sync.json`. | Verify the canonical file, submit only the `debug` change through the passive settings client, re-read it, and do not run a sync. | `packages/pi-sync-daemon/test/settings.test.ts` covers a passive save for an existing ignore-file setup without changing its rules, as well as stale-source rejection. |
| Draft a new `.syncignore` that keeps package checkouts and a local cache off other devices. | Start with the current starter rules and add a narrow cache rule when its path is known. Check root anchoring and return a draft without writing. Leave creation and activation to the reviewed setup flow. | `packages/pi-sync-daemon/test/ignore-source.test.ts` and `packages/pi-sync-daemon/test/ignore-initialization.test.ts`. |
| Exclude `npm/` from the ignore file for my `home` setup. | Use `ignore.read` to check the `home` source and shared setups. If already excluded, report a no-op. Otherwise test a root match and a nested non-match, then recheck `home` before replacement. For a legacy setup, explain the path-selection review and account for re-inclusions. | `packages/pi-sync-daemon/test/ignore-edit.test.ts` and `packages/pi-sync-daemon/test/ignore-source.test.ts`. |
| Exclude `npm/` from my active ignore file only if the setup remains current. | Do not write. A named setup read and a later local replacement cannot guarantee that the setup remains current. If the user wants an edit independent of which setup is current, ask for its exact name. | `packages/pi-sync-daemon/src/engine/ignore/ignore-edit.ts` checks the requested setup under the settings lock, but that lock does not cover local replacement. |
| Add a rule when the configured filename points to another live client's session. | Stop on `ignore.read` refusal. Do not fall back to reading or overwriting that path directly. | `packages/pi-sync-daemon/test/ignore-edit.test.ts` covers a live session reached through an alias. |
| Turn on debug logging while an older daemon owns the agent directory. | `findDaemon` can return an owner with `needsUpgrade: true`. Stop before attaching and leave upgrade to the user. | `packages/pi-sync-daemon/test/closing-owner.test.ts` covers lookup of an older owner. |
| Turn on Autonomous sync in a legacy-only setup. | Route the user to Settings review. Do not submit `settings.cas` merely because the document validates. | `packages/pi-sync-daemon/src/engine/settings/settings-validation.ts` checks the field's type; the bundled settings reference describes authorization. |
| Audit `/notes/` followed by `!/notes/shared.md`. | Explain that the excluded parent blocks the exception. Propose `/notes/*` in place of `/notes/`, verify the exception and an ignored sibling, and do not write in an audit. If applying later, confirm the scope expansion and require peer alignment and fresh review. | `packages/pi-sync-daemon/test/ignore-source.test.ts` and `packages/pi-sync-daemon/test/ignore-automatic-permission.test.ts`. |
| Agent directory changed or has an unsafe filesystem layout. | Investigate local metadata and concurrent writes; the error does not identify a settings field. Do not reset settings, change rules without a supported fix, or run backend diagnostics. | `packages/pi-sync-daemon/src/engine/snapshot/snapshot.ts` and `test/agent-directory-files.test.ts`. |
| Autonomous sync requires a separate policy review. | Distinguish transfer approval from a settings parse failure; point to **Review automatic transfers** and do not grant consent on the user's behalf. | `packages/pi-sync-daemon/src/consent.ts` and `packages/pi-sync-daemon/test/ignore-automatic-permission.test.ts`. |
| How do I use Git without automatic sync? | Use an existing credential-free SSH/HTTPS remote and a dedicated owned branch; choose the exact path, Minimal content, and automatic Off in `/sync` → Set up sync, then review before saving and separately review the first transfer. | `src/backends/git/git-config.ts`, `src/ui/setup/setup-wizard.ts`, `src/ui/setup/setup-review.ts` |
| Where do I enter a WebDAV password? | Enter it in the existing masked TUI, not chat or a URL; use HTTPS and review the collection and relative path, without assuming saving tests connectivity. | `src/backends/webdav/webdav-config.ts`, `src/ui/secret-input.ts`, `src/ui/setup/webdav-ui.ts` |
| What does `./` mean for R2/S3? | It is the selected existing bucket root, not a literal object prefix; R2 persists as type `s3`, and independent setups need separate prefixes. | `src/settings/settings-validation.ts`, `src/backends/s3/s3-backend.ts`, `src/ui/setup/s3-ui.ts` |
| Are the four automatic controls equivalent? | No: `automatic` controls startup observation and selected-content shutdown push when sessions are included; `automaticTransfer` controls one eligible startup transfer; `agentMode` authorizes autonomous merged sync and conflict disclosure; `continuous` adds recurring work only with Agent mode enabled. Review each opt-in separately in Settings. | `src/sync/automatic-sync.ts`, `src/sync/startup-check.ts`, `src/sync/agent-sync.ts`, `src/sync/continuous-sync.ts` |
| Can I sync sessions? | Sessions are an explicit privacy-sensitive include that can contain prompts, outputs, paths, images, and secrets; use the user-owned include review and acknowledge privacy, and do not promise automatic conversation resume or protection for every other live process. | `src/ui/file-selection.ts`, `src/snapshot/session-paths.ts`, `src/snapshot/snapshot-apply.ts` |
| Can you replace my version 2 settings with defaults? | No; Pi Sync refuses saves over unsupported schemas. Keep the original private bytes, follow documented manual recovery, and review the destination and first direction in a supported client. | `src/settings/settings-validation.ts`, `src/settings/config-file.ts` |
| Which version supports `localFields`? | Any explicit array, including `[]`, requires settings version 4 or 5; nonempty rules require `settings.json` in the include list, and policy migration remains a separately reviewed direction rather than a silent settings edit. | `src/settings/settings-validation.ts`, `src/sync/local-fields.ts`, `src/sync/field-migration.ts` |
| Which version enables content merge and partial progress? | Enabling `mergeContent` or `partialSync` requires version 5; both are experimental, default off, and do not authorize erasing unresolved versions or downgrading pending state. | `src/settings/settings-validation.ts`, `src/sync/partial-progress.ts`, `src/sync/conflict-artifacts.ts` |
| Can you run a read-only sync check? | Use `pi_sync_debug` if available. `latest` reads private local summaries; `recheck` reads configured storage and shares a sanitized summary without a confirmation prompt. Use it only for a requested fresh comparison; do not bypass an unavailable tool. Leave WebDAV's isolated probe and confirmed history repair to **/sync → History**. | `src/sync/debug-tool.ts`, `packages/pi-sync-daemon/src/engine/sync/sync-queries.ts` |
| What if an answer or destination is unknown? | State missing evidence and ask at most one non-secret question; do not invent a valid destination, request raw settings, or claim connectivity and permissions. | Skill safety and stopping contract; `test/skill.test.ts` |

## Repeatable checks

Run repository commands from the root:

```bash
npm run check
npm test
npm run package:pack -- sync
npm --workspace @narumitw/pi-sync run build --if-present
node packages/pi-sync/test/skill-cli-smoke.ts
```

`test/skill.test.ts` checks real Pi discovery through package and root manifests, skill catalog visibility before and after reload, reference boundaries, retained legacy fragments in the authoritative reference, and JSON examples against the real validator.
Its negative cases cover unsupported versions, missing required policy fields, invalid booleans, and forbidden version downgrades.

`test/skill-cli-smoke.ts` reads the installed Pi package's `bin.pi` entry and starts it with `process.execPath`, without a global `pi` or npm's PATH changes.
It starts the real `pi -e <package-directory>` process in RPC mode with a temporary HOME, workspace, agent directory, and loopback-only canned provider.
It verifies that ordinary requests advertise only skill metadata, that the system prompt stays stable across ordinary turns, and that explicit requests still expand the skill instructions. It checks that both paths still work after public `ctx.reload()` through a temporary test-only extension command.
The smoke uses only a loopback fixture and enables only the built-in `read` tool, which Pi needs to advertise skills. The fixture does not call it.
It verifies that no private Pi Sync settings, sync state, or workspace content was created.
It closes the child, drains its exit, closes the HTTP fixture, clears timers, and removes its temporary files on success and failure.
Failure-injection runs replaced `spawn` through a temporary Node preload with an immediately exiting child and a missing executable.
Both runs failed as expected and left no owned smoke directories behind.
The operation deadline starts only after the RPC readiness handshake.

The canned provider verifies catalog visibility and explicit instruction loading, not whether a live model selects the skill for a matching request or gives correct answers.
The source-grounded review above is separate evidence and does not establish a model success rate.
Native TUI `/reload` and masked credential input are not exercised by this non-interactive smoke; loader reload and real public command-context reload are exercised instead.
Live provider behavior, production backend access, and operating systems other than the verification host remain unverified.
The skill uses the existing settings writer; it does not change the runtime lifecycle, schema, or `/sync` command behavior. The smoke does not execute an agent-driven edit; the daemon tests verify the underlying writer separately.
