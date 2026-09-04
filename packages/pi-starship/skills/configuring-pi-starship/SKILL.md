---
name: configuring-pi-starship
description: Configure @narumitw/pi-starship and answer questions about its pi-starship.toml settings. Use when the user asks to create, edit, repair, migrate, or understand pi-starship.toml, or asks which pi-starship module, variable, option, style, palette, preset, or runtime behavior to use. Do not use for generic TOML, shell Starship configuration, pi-starship source-code development, or unrelated footer work.
license: MIT
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

Read [modules](references/modules.md) whenever answering about or changing a module, variable, alias, truncation rule, detection option, or module-specific field.

Read [runtime and security](references/runtime-and-security.md) before enabling or explaining network, command-backed, development, cloud, deployment, host, user, or width-sensitive modules, and when checking limitations.

## Locate and inspect an editable document

Use an explicit user-provided path when present.

Otherwise use `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/pi-starship.toml`.

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

Resolve `scripts/validate.mjs` relative to this `SKILL.md`, then run it with the absolute configuration path:

```bash
skill_dir="<directory containing this SKILL.md>"
config_path="<absolute path to pi-starship.toml>"
node "$skill_dir/scripts/validate.mjs" "$config_path"
```

Fix every TOML syntax error and rerun the validator unless the user explicitly requested an invalid test fixture.

Re-read the saved document and review the exact change for accidental replacement or unrelated edits.

Report the edited path, the effective layout or module change, and the validator result.

External edits do not update the active footer immediately, so tell the user to run `/reload` and inspect `/starship status` for pi-starship semantic warnings.

Do not claim semantic validation or an active-footer update unless that runtime verification actually occurred.
