---
name: editing-pi-starship-toml
description: Edit a file named pi-starship.toml for @narumitw/pi-starship. Use only when the user asks to create, modify, repair, migrate, or otherwise write a file whose basename is exactly pi-starship.toml. Do not use for read-only explanation, general TOML work, shell Starship configuration, or pi-starship source-code changes.
license: MIT
---

# Editing pi-starship.toml

Edit the requested `pi-starship.toml` without replacing unrelated settings.

## Locate and inspect the document

Use an explicit user-provided path when present.

Otherwise use `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/pi-starship.toml`.

Read the existing document before editing it.

Treat a missing document as built-in defaults, and create it only when the requested change requires a persisted configuration.

Do not redirect this workflow to `starship.toml`, `pi-statusline.json`, project-local overrides, or extension source files.

Read only the relevant sections of the bundled [pi-starship configuration reference](../../README.md) before choosing fields, module variables, formats, styles, palettes, or detection options.

## Make the smallest valid change

Preserve comments, ordering, unknown fields, and unrelated custom settings unless the user explicitly requests a complete replacement.

Keep the root `format` limited to module names and `$all`.

Keep each module's `format` limited to that module's documented variables and style variables.

When adding a module, make it reachable from the root `format` or `$all`, and set `disabled = false` when the module is disabled by default.

Use pi-starship's documented format grammar and supported module options rather than assuming compatibility with shell Starship.

Do not add shell commands, unrestricted environment-variable modules, or unsupported Starship fields.

Do not enable network, command-backed, cloud, deployment, host, or user metadata beyond the user's request.

Preserve an existing malformed document while diagnosing it, and change only the bytes needed to repair the requested problem.

## Validate and hand off

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
