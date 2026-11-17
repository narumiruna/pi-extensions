# Pi Sync Daemon Guidelines

## Engine and documents

- Keep this package a non-extension library and Node service without imports from Pi Sync internals or interactive TUI components.
- Keep the public client export free of eager engine, backend, watcher, and model-runtime imports.
- Hold one cross-process lock across each settings read-modify-write, full validation, and atomic same-directory replacement.
- Queue each complete settings mutation before prerequisite awaits and make every writer share its lock and exact source checks.
- Require explicit legacy-process handover because an absent operation lock does not prove that an idle older process is absent.
- Keep legacy state active until explicit migration, serialize upgraded state/cache users against the migration guard, and fail closed when both state roots exist.

## Backends and snapshots

- Keep snapshot content IDs, backend references, and backend-scoped opaque revisions distinct.
- Make forced publication reread the observed revision instead of disabling concurrency checks.
- Preserve Cloudflare R2 temporary credentials and retry once without `X-Amz-Security-Token` when static keys reject that header.
- Defer descendant preflight when replacing a file ancestor with a directory and journal `ENOTDIR` descendants as missing for rollback.
- Reserve actual participating Pi mutation queues and protect all live or ambiguously disconnected sessions before apply.

## Processes and models

- Close Git stdin, strip inherited Git control variables, and disable prompts, hooks, pagers, and editors in non-interactive subprocesses.
- Serialize Git cache mutations and reconcile remote refs after ambiguous failures.
- Keep service lifetime separate from reviewed transfer and model permission and preserve persistent request accounting across restart.
- Resolve only the exact independently available model through public SDK APIs without parent context, tools, runtime credentials, or extension loading.
- Retain session protection after orderly exit while its PID is alive without treating that retired client as an ambiguous active participant.
