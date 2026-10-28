# Configuration skill verification

The skill is guidance-only and manual-only.
The authoritative configuration text is `skills/configure-pi-sync/references/configuration.md`.
The previous settings URL remains a heading-preserving index, not a second settings specification.

## Representative question review

These are source-grounded answer and handoff reviews, not measured model-quality results.
Each case was checked against the bundled reference and the owning implementation below.
No user settings were read or changed and no backend command was run for these reviews.

| Question | Required answer and user handoff | Implementation evidence |
| --- | --- | --- |
| How do I use Git without automatic sync? | Use an existing credential-free SSH/HTTPS remote and a dedicated owned branch; choose the exact path, Minimal content, and automatic Off in `/sync` → Set up sync, then review before saving and separately review the first transfer. | `src/backends/git/git-config.ts`, `src/ui/setup/setup-wizard.ts`, `src/ui/setup/setup-review.ts` |
| Where do I enter a WebDAV password? | Enter it in the existing masked TUI, not chat or a URL; use HTTPS and review the collection and relative path, without assuming saving tests connectivity. | `src/backends/webdav/webdav-config.ts`, `src/ui/secret-input.ts`, `src/ui/setup/webdav-ui.ts` |
| What does `./` mean for R2/S3? | It is the selected existing bucket root, not a literal object prefix; R2 persists as type `s3`, and independent setups need separate prefixes. | `src/settings/settings-validation.ts`, `src/backends/s3/s3-backend.ts`, `src/ui/setup/s3-ui.ts` |
| Are the four automatic controls equivalent? | No: `automatic` controls startup observation and selected-content shutdown push when sessions are included; `automaticTransfer` controls one eligible startup transfer; `agentMode` authorizes autonomous merged sync and conflict disclosure; `continuous` adds recurring work only with Agent mode enabled. Review each opt-in separately in Settings. | `src/sync/automatic-sync.ts`, `src/sync/startup-check.ts`, `src/sync/agent-sync.ts`, `src/sync/continuous-sync.ts` |
| Can I sync sessions? | Sessions are an explicit privacy-sensitive include that can contain prompts, outputs, paths, images, and secrets; use the user-owned include review and acknowledge privacy, and do not promise automatic conversation resume or protection for every other live process. | `src/ui/file-selection.ts`, `src/snapshot/session-paths.ts`, `src/snapshot/snapshot-apply.ts` |
| Can you replace my version 2 settings with defaults? | No; this skill cannot inspect or replace them, and Pi Sync refuses unsupported schemas; keep the original private bytes, follow documented manual recovery, and review the destination and first direction in a supported client. | `src/settings/settings-validation.ts`, `src/settings/config-file.ts` |
| Which version supports `localFields`? | Any explicit array, including `[]`, requires settings version 4 or 5; nonempty rules require `settings.json` in the include list, and policy migration remains a separately reviewed direction rather than a silent settings edit. | `src/settings/settings-validation.ts`, `src/sync/local-fields.ts`, `src/sync/field-migration.ts` |
| Which version enables content merge and partial progress? | Enabling `mergeContent` or `partialSync` requires version 5; both are experimental, default off, and do not authorize erasing unresolved versions or downgrading pending state. | `src/settings/settings-validation.ts`, `src/sync/partial-progress.ts`, `src/sync/conflict-artifacts.ts` |
| Can you run a read-only doctor check? | The skill does not execute diagnostics; WebDAV doctor can write/delete its conditional probe and repair history, unlike the S3/R2 read-only pointer check, so disclose those effects before a user-owned diagnostic. | `src/backends/webdav/webdav-backend.ts`, `src/backends/s3/s3-backend.ts`, `src/sync/sync-inspection.ts` |
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

`test/skill.test.ts` checks real Pi discovery through package and root manifests, reload, exclusion from ordinary model prompts, reference boundaries, retained old anchors, and JSON examples against the real validator.
Its negative cases cover unsupported versions, missing required policy fields, invalid booleans, and forbidden version downgrades.

`test/skill-cli-smoke.ts` reads the installed Pi package's `bin.pi` entry and starts it with `process.execPath`, without a global `pi` or npm's PATH changes.
It starts the real `pi -e <package-directory>` process in RPC mode with a temporary HOME, workspace, agent directory, and loopback-only canned provider.
A direct Node run with `PATH=/usr/bin:/bin` passed all ten requests and reload checks.
It verifies one ordinary request without manual-only skill metadata, eight explicit question expansions, and an additional expansion after public `ctx.reload()` through a temporary test-only extension command.
The smoke makes ten local fixture requests and zero external provider requests, with tools disabled.
It verifies that no private Pi Sync settings, sync state, or workspace content was created.
It closes the child, drains its exit, closes the HTTP fixture, clears timers, and removes its temporary files on success and failure.
Failure-injection runs replaced `spawn` through a temporary Node preload with an immediately exiting child and a missing executable.
Both runs failed as expected and left no owned smoke directories behind.
The operation deadline starts only after the RPC readiness handshake.

The canned provider verifies transport and instruction loading, not whether a live model follows the skill or gives correct answers.
The source-grounded review above is separate evidence and does not establish a model success rate.
Native TUI `/reload` and masked credential input are not exercised by this non-interactive smoke; loader reload and real public command-context reload are exercised instead.
Live provider behavior, production backend access, and operating systems other than the verification host remain unverified.
No runtime lifecycle, settings writer, schema, or existing `/sync` command behavior changes in this delivery.
Guarded local settings edits remain deferred to a separately approved follow-up.
