## Goal

Allow `@narumitw/pi-plan-mode` to keep built-in read-only tools available by default while `/plan` is active, and let users explicitly opt into any non-built-in tools from a selector at their own risk. Success means Plan mode no longer hard-codes only `read` and `bash`; it manages built-in tool safety itself, keeps extension/custom tools disabled by default, and preserves user-selected non-built-in tools without trying to classify their risk.

## Context

- `extensions/pi-plan-mode/src/plan-mode.ts` currently hard-codes `READ_ONLY_TOOLS = ["read", "bash"]` and calls `pi.setActiveTools(READ_ONLY_TOOLS)` on Plan mode activation.
- Pi's extension API supports `pi.getActiveTools()`, `pi.getAllTools()`, and `pi.setActiveTools()` for built-in, custom, and extension-registered tools. `pi.getAllTools()` includes `sourceInfo`, so Plan mode can avoid importing other extension packages.
- Pi's TUI supports custom interactive components through `ctx.ui.custom()`, and the docs include a `SettingsList` pattern for multi-setting toggle menus.
- This repository's boundary check forbids extension-to-extension package dependencies, so the change should be implemented by tool names/metadata in `pi-plan-mode`, not by importing `pi-firecrawl`, `pi-lsp`, etc.

## Architecture

Replace Plan mode's static active-tool list with a computed Plan-mode tool set:

1. Preserve the user's previously active tools when entering Plan mode for restoration after exit.
2. Include read-only built-in tools that are available, such as `read`, limited `bash`, `grep`, `find`, and `ls`.
3. Disable all extension/custom tools by default in Plan mode, regardless of whether they were active before entry.
4. Add an interactive Plan-mode tool selector, reachable from `/plan` and `/plan tools`, where users can explicitly enable non-built-in tools with a clear "user risk" label.
5. Persist the user's Plan-mode tool selection in `PlanModeState`, filter it against the currently available tools, and reapply it when Plan mode starts or resumes.
6. Enforce the built-in safety boundary in `tool_call` as defense in depth: block built-in mutating tools and unsafe `bash` commands, but do not classify or parameter-guard extension/custom tools.

## Assumptions

- Plan mode is responsible only for built-in Pi tool safety.
- Extension/custom tools do not have standardized mutability metadata, so they are disabled by default and become the user's responsibility if explicitly enabled.
- The checkbox-style tool selector is primarily for interactive TUI sessions; non-interactive sessions can use the built-in-only safe default unless a command-line/text fallback is added.

## Plan

- [x] Replace `READ_ONLY_TOOLS` in `extensions/pi-plan-mode/src/plan-mode.ts` with a helper that builds the default Plan-mode tool list from available built-in tools only; verified with the Node smoke script output `default bash,find,grep,ls,read`.
- [x] Add a checkbox-style Plan-mode tool selector in `extensions/pi-plan-mode/src/plan-mode.ts` using a dependency-free `ctx.ui.select()` toggle loop; verified `/plan tools` enables `firecrawl_scrape` only after explicit selection and labels non-built-in tools as `user risk`.
- [x] Persist the selected Plan-mode tools in the existing Plan mode state, keyed by tool name plus `sourceInfo` for non-built-in tools when available, and filter removed/unavailable tools on restore; verified by TypeScript checking and the selector smoke script preserving selected tool keys.
- [x] Add Plan-mode tool-call guards in `extensions/pi-plan-mode/src/plan-mode.ts` for built-in mutating tools (`edit`, `write`) and unsafe `bash` commands; verified by the Node smoke script blocking `edit` and `rm file`.
- [x] Refresh the computed Plan-mode tool list during `session_start`, `/plan` entry, and immediately before agent start so newly registered tools appear in the selector but remain disabled unless selected; verified with `npm --workspace @narumitw/pi-plan-mode run typecheck` and the local Node smoke script using loaded extension-like tools.
- [x] Update `extensions/pi-plan-mode/README.md` to explain that Plan mode manages built-in tools only, disables extension/custom tools by default, and lets users opt into non-built-in tools at their own risk; verified the README mentions `/plan tools`, Firecrawl, and LSP diagnostics.
- [x] Run package and repository verification: verified `npm --workspace @narumitw/pi-plan-mode run typecheck`, `npm run check`, and `npm run pack:plan-mode` all pass.

## Risks

- User-enabled extension/custom tools can weaken Plan mode because Pi's tool metadata does not declare mutability. Mitigation: keep all non-built-in tools disabled by default and label opt-in as user risk.
- Some user-enabled tools can mutate external state even if they do not edit repository files, such as browser navigation or starting a crawl job. Mitigation: document that Plan mode does not classify extension/custom tool risk.
- Dynamically registered tools may appear after Plan mode has already set active tools. Mitigation: refresh the selector and active tool list before each agent start while leaving new non-built-in tools disabled unless selected.

## Completion Checklist

- [x] `/plan` sessions default to built-in safe tools only, verified by the Node smoke script output `default bash,find,grep,ls,read` with `firecrawl_scrape` disabled until selected.
- [x] The Plan-mode tool selector can toggle extension/custom tools at user risk, verified by the Node smoke script output `selected bash,find,grep,ls,read,firecrawl_scrape` only after explicit `/plan tools` selection.
- [x] Built-in repository/file mutating paths remain blocked, verified by the Node smoke script blocking `edit` and unsafe `bash` command `rm file`.
- [x] User-facing behavior is documented in `extensions/pi-plan-mode/README.md` with examples of built-in defaults and opt-in extension/custom tools.
- [x] `npm --workspace @narumitw/pi-plan-mode run typecheck`, `npm run check`, and `npm run pack:plan-mode` all pass.
