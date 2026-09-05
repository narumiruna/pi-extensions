---
name: configuring-pi-starship
description: Configure @narumitw/pi-starship and answer questions about its pi-starship.toml settings. Use when the user asks to create, edit, repair, migrate, or understand pi-starship.toml, or asks which pi-starship module, variable, option, style, palette, preset, or runtime behavior to use. Do not use for generic TOML, shell Starship configuration, pi-starship source-code development, or unrelated footer work.
license: MIT
disable-model-invocation: true
---

# Configuring pi-starship

Answer pi-starship configuration questions or make the requested `pi-starship.toml` change.

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

Read [configuration and format](references/configuration.md) for settings location and persistence, presets, complete examples, root and module formats, styles, palettes, and display thresholds.

Read [the complete module catalog](references/module-catalog.md) for exact module names, format variables, default formats, symbols, enabled state, style fields, display defaults, option types, ranges, and enum values.

For one module, search that catalog for its exact `### \`module_name\`` heading and read only through the next module heading.

Read [module behavior](references/modules.md) for output semantics, detection defaults, aliases, truncation, and module-specific behavior.

Read [runtime and security](references/runtime-and-security.md) before enabling or explaining network, command-backed, development, cloud, deployment, host, user, or width-sensitive modules, and when checking limitations.

## Locate and inspect an editable document

Use an explicit user-provided path when present.

Otherwise resolve the active path through Pi's `getAgentDir()` API by running `node scripts/config-path.mjs` relative to this `SKILL.md`.

The resolver prints a JSON string containing the exact absolute path, including correct expansion of a configured `~`.

Read the existing document before editing it.

Treat a missing document as built-in defaults, and create it only when the requested change requires a persisted configuration.

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

When it is missing, use the explicit `--expect-missing` state instead of creating a baseline.

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

It rejects publication when the active bytes differ from the baseline or when a supposedly missing document has appeared, then renames the staged file over the unchanged path.

This comparison does not lock out other processes after the re-read, so do not claim cross-process synchronization.

Fix every TOML syntax error and rerun the validator unless the user explicitly requested an invalid test fixture, which must not replace the active document.

Remove the separate draft and baseline after a successful publication, then re-read the saved document and review the exact change for accidental replacement or unrelated edits.

Report the edited path, the effective layout or module change, and the validator and atomic-publication results.

External edits do not update an active footer immediately.

When the pi-starship extension and `/starship status` command are available, tell the user to run `/reload` and inspect `/starship status` for semantic warnings.

When the extension or command is unavailable, report that only standalone TOML syntax and atomic publication were verified.

Do not claim semantic validation or an active-footer update unless that runtime verification actually occurred.
