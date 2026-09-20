# Remove the unused Pi TUI Kit selection controller

## Goal

Remove the unreferenced, unexported `SelectionController` source and generated files without changing Pi TUI Kit's public API or interaction behavior.

## Context

`packages/pi-tui-kit/src/components/selection-controller.ts` has no imports, exports, tests, or documentation references. Because `tsconfig.build.json` includes all `src/**/*.ts`, it still emits JavaScript and declarations under `dist` and is included in the package tarball's `dist` tree.

## Non-Goals

- Do not replace current selector, menu, questionnaire, or live-choice movement logic with this controller.
- Do not refactor active selection behavior.
- Do not change package exports or public declarations.

## Risks

- A non-obvious generated or dynamic reference could make the file reachable despite the static search.
- A stale `dist` file could remain if the build does not clean output before emission.

## Plan

- [ ] Verify repository-wide source, test, documentation, generated-runtime, and package-export searches find no `SelectionController` or `selection-controller` reference other than the source and generated files.
- [ ] Build Pi TUI Kit before removal and confirm the source is emitted only because of the broad TypeScript include, not because an entrypoint imports it.
- [ ] Delete `packages/pi-tui-kit/src/components/selection-controller.ts` without changing active selection implementations.
- [ ] Rebuild Pi TUI Kit and verify `dist/components/selection-controller.js`, its declaration, maps, and stale variants are absent.
- [ ] Run Pi TUI Kit selector, menu, live-choice, multi-select, and questionnaire tests to prove active selection behavior remains unchanged.
- [ ] Run `npm run check` and plain `npm test`; verify package boundaries, typechecks, and tests pass.
- [ ] Run `npm run package:pack -- pi-tui-kit` and inspect the tarball; verify the deleted implementation is absent and the public export/declaration inventory is unchanged.
- [ ] Review the final diff to confirm it contains only source removal and expected generated-output cleanup, then record checks and pack evidence in the handoff.

## Completion Checklist

- [ ] No source, test, documentation, export, or generated reference requires the controller.
- [ ] The source and all emitted controller files are absent.
- [ ] Active selection behavior tests pass unchanged.
- [ ] Pi TUI Kit's public exports and declarations are unchanged.
- [ ] Root checks, tests, and package pack inspection pass.
- [ ] No unrelated file changed.
