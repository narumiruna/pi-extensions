# Standard Pi Extension Entrypoints Plan

## Goal

Give every active extension package a Pi-conventional `src/index.ts` entrypoint, make that convention enforceable for future agent work, and document Git installation—including loading one extension from this monorepo—in the root README.

## Context

- The repository currently has 20 active production extension packages. Their `pi.extensions` manifests point to package-specific files such as `./src/accounts.ts` and `./src/goal.ts`.
- Pi officially recognizes `index.ts` as the conventional entrypoint for directory-based extensions.
- Pi package filters match discovered resource files, not package directories. A single-extension Git filter therefore needs a path such as `extensions/pi-accounts/src/index.ts`, not only `extensions/pi-accounts`.
- `extensions/pi-usage/src/index.ts` already exists as a named-export barrel and must retain those exports while also exposing the default Pi extension factory.

## Architecture

Each active package will keep its descriptive implementation module and add a stable, thin Pi-facing boundary:

```text
extensions/<package>/
├── package.json              # pi.extensions -> ./src/index.ts
└── src/
    ├── index.ts              # stable default-export forwarding entrypoint
    └── <descriptive-name>.ts # existing implementation and test target
```

The root boundary check will own enforcement of the entrypoint filename and manifest path. `AGENTS.md` will state the same rule for agents, while `README.md` will own user-facing Git installation instructions.

## Non-Goals

- Do not rename or relocate the existing descriptive implementation modules or rewrite tests to import through `index.ts`.
- Do not migrate packages under `deprecated/` unless they are reactivated later.
- Do not publish, bump package versions, or modify a user's `~/.pi/agent/settings.json` as part of this work.

## Assumptions

- “Every extension” means every active package discovered under `extensions/`, including future experimental packages, but excludes archived packages under `deprecated/`.
- Installing the Git source without a filter intentionally enables every extension discovered from the monorepo; the README will distinguish that from the filtered single-extension configuration.

## Risks

- A wrapper that omits or misroutes the default export can pass file-existence checks but fail at Pi load time; typechecking and a Pi package-resolution/load smoke must cover the new entrypoints.
- Updating all package manifests changes every publishable package's tarball metadata; dry-run packaging must verify that each tarball contains `src/index.ts` and its implementation modules.
- Documentation can become stale if new packages bypass the convention; the repository check must fail when `src/index.ts` or the canonical manifest path is missing.

## Plan

- [x] Extend `scripts/check-extension-boundaries.mjs` to require every active extension package to contain `src/index.ts` and declare `pi.extensions` as `['./src/index.ts']`; red evidence: `npm run check:boundaries` reported 39 expected missing-entrypoint/legacy-manifest failures, and green evidence: it passes for 20 active packages after migration.
- [x] Add a thin `src/index.ts` default-export forwarder to each active package while preserving descriptive implementation modules and all existing named exports in `extensions/pi-usage/src/index.ts`; `npm run typecheck` passes all 20 workspaces.
- [x] Update every active extension `package.json` so `pi.extensions` points to `./src/index.ts`; `npm run check:boundaries` passes and a `jq -e '.pi.extensions == ["./src/index.ts"]'` loop accepts all 20 active package manifests.
- [x] Update active extension README package-manifest snippets and package-layout descriptions that identify the old implementation file as the Pi entrypoint, while keeping implementation-specific examples such as source references and Git commands accurate; all 20 active package READMEs list `index.ts`, and every README Pi manifest example uses `./src/index.ts`.
- [x] Amend root `AGENTS.md` with the enforceable convention that active packages expose Pi only through a thin `src/index.ts`, keep `package.json` aligned to `./src/index.ts`, and retain descriptive modules for implementation; `rg` confirms the guidance names `npm run check:boundaries` and contains no Git installation walkthrough.
- [x] Add a root `README.md` Git-installation section showing `pi install git:github.com/narumiruna/pi-extensions`, warning that the unfiltered source enables all discovered extensions, and showing a valid `settings.json` object filter such as `extensions/pi-accounts/src/index.ts` for loading one extension; the documented filter path exists and matches Pi's Git source/resource-filter syntax.
- [x] Run a non-interactive Pi resource-loader smoke against the Git/package layout to confirm representative `src/index.ts` entrypoints resolve and load without extension errors; a `node --input-type=module` harness using Pi 0.81.1 `DefaultResourceLoader` loaded `pi-accounts`, `pi-usage`, and `pi-retry` from their `src/index.ts` paths with `errors: []`.
- [x] Run dry-run packaging for every active workspace and verify each package includes `src/index.ts`, its default-forwarded descriptive implementation module, `package.json`, `README.md`, and `LICENSE`; a parsed `npm pack --workspace <name> --dry-run --json` loop passes for all 20 packages.
- [x] Run the repository-wide gate `npm run check` and review `git diff --check` plus the final diff to confirm changes are limited to entrypoint wrappers, manifests, enforcement, and aligned documentation; the gate passes 1,135 tests and both staged and unstaged whitespace checks pass.

## Completion Checklist

- [x] Every active extension package has a working `src/index.ts` default Pi entrypoint and `pi.extensions` points only to `./src/index.ts`.
- [x] Repository automation rejects future active packages that omit or bypass the canonical entrypoint.
- [x] `AGENTS.md` records the maintainer/agent convention and its verification command.
- [x] Root `README.md` accurately documents unfiltered Git installation and filtered single-extension loading.
- [x] Active package README entrypoint references are aligned with the new structure.
- [x] Typecheck, package dry runs, Pi load smoke, `npm run check`, and `git diff --check` all pass with recorded evidence.
