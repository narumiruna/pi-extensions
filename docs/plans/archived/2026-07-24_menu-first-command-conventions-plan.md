# Menu-first command conventions plan

## Goal

Clarify that extension managers are menu-first rather than necessarily menu-only, while keeping direct subcommands bounded to concrete payload, automation, compatibility, or frequent-action needs and making public-route compatibility and mode support explicit.

## Context

- `docs/extension-conventions.md` already prefers a no-argument current-state menu and says not to mirror every menu action into subcommands by default.
- The guide already recognizes deterministic RPC/automation routes and existing-interface compatibility as valid reasons for direct subcommands.
- The current wording does not explicitly say that adopting a menu must not silently remove documented routes, and its non-TUI rule does not spell out that `ctx.ui.notify()` is unavailable when `ctx.hasUI` is false.

## Non-Goals

- Require every menu action to have a textual subcommand.
- Require new manager extensions to add automation routes without a concrete need.
- Change any extension implementation, README, package metadata, or release behavior in this documentation-only branch.
- Add a validator for product-level command semantics.

## Plan

- [x] Verify Pi's current TUI, RPC, JSON, and print UI observability against the installed official documentation, then record only mode claims supported by that evidence in `docs/extension-conventions.md`. Evidence: the installed `extensions.md` mode table and `rpc.md` Extension UI Protocol confirm `ctx.hasUI` and notification behavior.
- [x] Revise `docs/extension-conventions.md` under “Slash commands and menus” to define manager commands as menu-first rather than menu-only, retain the default against speculative menu-action mirroring, and keep the existing concrete exceptions for payload, deterministic RPC/automation, compatibility, and frequent unambiguous actions; verify the paragraph has one coherent default and exception model.
- [x] Add an explicit public-interface compatibility rule stating that a menu-first migration does not itself justify removing documented arguments or subcommands, and that removal requires an intentionally approved breaking change with migration, documentation, release, and test ownership; verify the rule names `Review` and `Test` evidence consistently with the guide's authority model.
- [x] Strengthen the direct-route and non-TUI guidance so accepted routes reject trailing or unknown input, document and complete known values, test each claimed mode, and do not treat `ctx.ui.notify()` as observable in print or JSON mode; verify TUI and RPC support are distinguished from `ctx.hasUI === false` modes without prescribing unsupported output mechanisms.
- [x] Update the new-extension and touched-area checklists only where needed to surface menu-first/public-route compatibility and mode verification without duplicating the normative rules; review the settings cross-reference for consistency without editing `docs/extension-settings.md` unless the central wording would otherwise conflict. Evidence: the existing settings cross-reference remains consistent and requires no edit.
- [x] Run `git diff --check` and `npm run check`, review the final diff for concise non-duplicative guidance, then archive this completed plan under `docs/plans/archived/`. Evidence: both commands passed; `npm run check` completed with 1,155 passing tests.

## Completion Checklist

- [x] The guide explicitly distinguishes menu-first from menu-only.
- [x] Menu actions remain unmirrored by default, while concrete RPC/automation and compatibility routes remain allowed.
- [x] Existing documented routes cannot be removed merely to adopt a menu; intentional breaking removal has explicit ownership requirements.
- [x] Accepted direct routes must handle exact input, documentation, completions, safety, compatibility, and per-mode tests.
- [x] The non-TUI rule accurately explains `ctx.hasUI` observability and does not claim print/JSON output from `ctx.ui.notify()`.
- [x] No extension behavior or unrelated guidance changes, repository checks pass, and the plan is archived.
