---
name: configure-pi-starship
description: Configure @narumitw/pi-starship and answer questions about its pi-starship.toml settings. Use when the user asks to create, edit, repair, migrate, or understand pi-starship.toml, or asks which pi-starship module, variable, option, style, palette, preset, or runtime behavior to use. Do not use for generic TOML, shell Starship configuration, pi-starship source-code development, or unrelated footer work.
license: MIT
disable-model-invocation: true
---

# Configure pi-starship

Answer pi-starship configuration questions or make the requested `pi-starship.toml` change.

## Hosted preview-only chat

When the host explicitly supplies an owned draft path and identifies this as the hosted preview-only workflow, use this section instead of the standalone path-resolution and publication steps below.
Read and edit only that draft for configuration changes; never write or edit the active settings file.
The host provides `read`, `write`, and `edit`, validates each completed mutation, and updates the footer preview without `/reload`.
Read the relevant bundled references using their paths relative to this skill directory.
Use `read` before `edit`, preserve comments and unknown fields, and repair errors reported by the host.
A rejected preview can leave invalid text in the draft; fix that text rather than assuming the write was rolled back.
Do not run or request the resolver, validator, backup, or apply scripts in this workflow.
Do not request shell access, publish settings, or tell the user that settings were saved.
Only the user can choose the host's reviewed Save draft as profile action and enter its name.
The host then asks separately whether to apply the saved profile; declining keeps the profile without changing active settings.
Closing or discarding before that user save does not save the preview.

## Choose the task path

For a configuration question, load only the smallest relevant reference and answer with the exact supported names, values, defaults, and behavior.

Do not read or modify the user's settings file for a question that the references can answer directly.

For a configuration edit, inspect the existing document and follow the editing and validation workflow below.

Treat the bundled references and implementation as authoritative instead of assuming compatibility with shell Starship.

If the references do not answer a question, inspect the bundled source relative to this skill.

Use `../../src/config.ts` for parsing, defaults, validation, and persistence behavior.

Use `../../src/modules/catalog.ts`, `../../src/modules/types.ts`, and the relevant `../../src/modules/*.ts` file for module variables, options, defaults, and runtime values.

Use `../../src/presets/` for the exact bundled preset documents.

State clearly when an answer comes from implementation detail rather than a documented public configuration surface.

## Load configuration references

Read [configuration and format](references/configuration.md) for settings location and persistence, named profiles, recovery history, presets, complete examples, root and module formats, styles, palettes, and display thresholds.

For profile management, explain `/starship` → **Profiles** and **Configuration** → **History** from that reference; do not treat a saved profile as a live link to the active TOML or claim that arbitrary external edits are recorded.

Read [the complete module catalog](references/module-catalog.md) for exact module names, format variables, default formats, symbols, enabled state, style fields, display defaults, option types, ranges, and enum values.

For one module, search that catalog for its exact `### \`module_name\`` heading and read only through the next module heading.

Read [module behavior](references/modules.md) for output semantics, detection defaults, aliases, truncation, and module-specific behavior.

Read [runtime and security](references/runtime-and-security.md) before enabling or explaining network, command-backed, development, cloud, deployment, host, user, or width-sensitive modules, and when checking limitations.

## Locate and inspect an editable document

Use an explicit user-provided path when present.

Otherwise resolve the active path through Pi's `getAgentDir()` API with the bundled resolver:

```bash
skill_dir="<directory containing this SKILL.md>"
node "$skill_dir/scripts/config-path.mjs"
```

Keep the current working directory unchanged so relative agent-directory settings retain their meaning.
The resolver prints a JSON string containing the exact absolute path, including correct expansion of a configured `~`.
It first resolves Pi from the skill's module tree; when Pi is absent there, it resolves beside the first `pi` executable on `PATH`, following symbolic links.
This supports separate npm or Bun global Pi installations without assuming a fixed global directory.
Make sure `PATH` selects the intended Pi installation when multiple installations exist.
Shell wrappers or compiled launchers without a nearby Pi package can still fail resolution.

If resolution fails, report the error and stop before reading or writing a guessed settings path.
Ask for the exact settings path or the intended Pi executable to be made available on `PATH`.
Do not install another Pi copy, modify `node_modules`, hard-code a Bun global directory, or use an ad hoc loader hook to bypass the failure.

Read the existing document before editing it.

Treat a missing document as Pi's native footer, and create it only when the requested change requires a persisted Starship configuration.
Use the built-in Starship example as an editing seed, not as a document equivalent to Pi's native footer.
The menu action **Restore built-in…** archives the exact active bytes in History and removes the settings document; a saved built-in Starship example remains eligible for Restore.

Do not redirect this workflow to `starship.toml`, `pi-statusline.json`, project-local overrides, or extension source files.

## Make the smallest valid change

Preserve comments, ordering, unknown fields, and unrelated custom settings unless the user explicitly requests a complete replacement.

Keep the root `format` limited to module names and `$all`.

Keep each module's `format` limited to that module's documented variables and style variables.

When adding a module, make it reachable from the root `format` or `$all`, and set `disabled = false` when the module is disabled by default.

Use pi-starship's documented format grammar and supported module options.

Do not add shell commands, unrestricted environment-variable modules, or unsupported Starship fields.

Do not enable network, command-backed, cloud, deployment, host, or user metadata beyond the user's request.

Preserve an existing malformed document while diagnosing it, and change only the bytes needed to repair the requested problem.

## Validate and hand off an edit

Create a separate draft without changing the active document, then make the smallest requested edit in that draft.

When the active document exists, also keep an untouched baseline file containing the exact bytes initially inspected.

Before replacing that document, the apply script saves the baseline permanently under `<directory containing pi-starship.toml>/pi-starship/` with a local-time name such as `pi-starship-202609130742.toml`.

For the default settings path, this backup directory is `<getAgentDir()>/pi-starship/`.

These timestamped skill backups remain available read-only in the interactive History browser; interactive replacements use its separate `history/` directory.

If that minute's backup name exists when checked, publication stops without changing the active document; this check does not lock out another process before rename, and retained backups are never deliberately removed by this workflow.

When the active document is missing, use the explicit `--expect-missing` state instead of creating a baseline or backup.

Resolve the bundled scripts relative to this `SKILL.md`, validate the draft, and publish it through the guarded atomic apply script:

```bash
skill_dir="<directory containing this SKILL.md>"
draft_path="<path to the proposed pi-starship.toml draft>"
config_path="<absolute path to the active pi-starship.toml>"
expected_state="<path to the untouched baseline, or --expect-missing>"
node "$skill_dir/scripts/validate.mjs" "$draft_path"
node "$skill_dir/scripts/apply.mjs" "$draft_path" "$config_path" "$expected_state"
```

The apply script stages the proposed bytes in the destination directory, validates that staged file, and immediately re-reads the active path.

It rejects publication when the active bytes differ from the baseline or when a supposedly missing document has appeared.

For an existing document, it writes and flushes the backup to a private temporary file, confirms that the minute's final backup name is absent, atomically renames the completed backup into place, and flushes the backup directory and its parent directory before renaming the staged configuration over the unchanged active path.

It removes its owned temporary backup after a recoverable write or publication failure; if cleanup also fails, it reports the primary failure and every cleanup failure while preserving the active document.

If configuration publication fails after the backup is durable, it reports the retained backup path and preserves the active document.

This comparison does not lock out other processes after the re-read, so do not claim cross-process synchronization.

Fix every TOML syntax error and rerun the validator unless the user explicitly requested an invalid test fixture, which must not replace the active document.

Remove the separate draft and temporary baseline after a successful publication, but keep the durable timestamped backup.

Then re-read the saved document and review the exact change for accidental replacement or unrelated edits.

Report the edited path, durable backup path when one was created, effective layout or module change, and validator and atomic-publication results.

External edits do not update an active footer immediately.

When the pi-starship extension and `/starship status` command are available, tell the user to run `/reload` and inspect `/starship status` for semantic warnings.

When the extension or command is unavailable, report that only standalone TOML syntax and atomic publication were verified.

Do not claim semantic validation or an active-footer update unless that runtime verification actually occurred.
