# Pi TUI Kit Rename Plan

## Goal

Rename the unpublished shared UI library from `@narumitw/pi-extension-menu` to
`@narumitw/pi-tui-kit`, including its workspace path and every consumer, repository workflow,
documentation, and lockfile reference, without changing menu behavior or public API symbols.

## Context

- The package is prepared on PR #446 but has not been published.
- `npm view @narumitw/pi-tui-kit` currently returns 404, so no public package was found under the
  intended name; registry permissions remain external to this rename.
- The existing branch name `feat/pi-extension-menu` and historical commit references remain factual
  Git history and do not define the package name.

## Non-Goals

- Add new low-level component APIs or change the existing declarative menu contract.
- Rename menu-specific symbols such as `defineMenu()`, `runMenu()`, or
  `PI_EXTENSION_MENU_API_VERSION`.
- Rename the current Git branch or publish the package to npm.

## Plan

- [x] Rename `packages/pi-extension-menu` to `packages/pi-tui-kit` and update package metadata,
      README positioning, consumer imports/dependencies, repository guidance, recipes, fixtures, and
      archived plan paths. Evidence: repository search finds the old name only in this rename context
      and the factual `feat/pi-extension-menu` branch reference.
- [x] Regenerate `package-lock.json` and workspace links for `@narumitw/pi-tui-kit`. Evidence:
      `npm ls @narumitw/pi-tui-kit --all` resolves the root and both pilots to one deduplicated
      `packages/pi-tui-kit` workspace, and the old workspace link is absent.
- [x] Run the library check, both pilot typechecks, boundary checks, and full `npm run check`.
      Evidence: the renamed workspace check, Chrome DevTools and Firecrawl typechecks, and boundary
      validation pass; the full repository gate passes all 1,759 tests.
- [x] Run `just pack-tui-kit`, `just pack-chrome-devtools`, and `just pack-firecrawl`; inspect package
      names, dependency metadata, compiled ESM/declarations, and absence of bundled Pi peers.
      Evidence: the kit dry run reports `@narumitw/pi-tui-kit@0.35.0` with 15 intended files from
      `dist`, README, metadata, and license; both pilot packs retain only their intended source and
      package files with the renamed runtime dependency.
- [x] Audit the final diff against `docs/extension-conventions.md` and
      `docs/extension-settings.md`. Evidence: package files/exports, unrestricted Pi peers, runtime
      consumer dependencies, boundaries, publishing recipes, settings ownership, and lifecycle
      behavior remain conformant; implementation, test, build, config, and license files are
      byte-identical across the directory rename, with no accepted deviation.

## Completion Checklist

- [x] The publishable workspace is `packages/pi-tui-kit` with npm name
      `@narumitw/pi-tui-kit`, and no stale product/path/dependency references remain.
- [x] Chrome DevTools and Firecrawl import and resolve the renamed package without behavior changes.
- [x] Repository checks and all three dry-run packs pass.
- [x] No npm publication, Git branch rename, commit, or push was performed without separate approval.
