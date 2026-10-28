# Dependency installation policy

CI and release provision Node.js from [`.node-version`](../.node-version) and use its bundled npm. The exact npm assertion lives in [`scripts/check-install-policy.mjs`](../scripts/check-install-policy.mjs). Run that preflight from the repository root before installing dependencies locally to check the validated toolchain and effective policy.

CI and release use `npm ci`: manifest/lockfile mismatches fail instead of being repaired during installation. Local development and intentional dependency/Changesets lockfile updates still use `npm install`. Installation settings, platform restrictions, optional dependencies, and `omit` can affect the installed tree even when manifests and the lockfile are unchanged.

## Script review

Root `package.json#allowScripts` is the reviewed policy. Required third-party installation scripts use exact resolved identities; an upgrade needs a fresh review and an explicit new approval. Denials may cover a package name across versions. An unreviewed dependency script fails installation under `.npmrc`'s strict policy; an explicit denial skips the script without blocking the package itself.

Review the actual artifact and install-time behavior, not only its manifest name or registry metadata. npm matches registry approvals against resolved name/version identity. Registry-style approvals do not authorize a similarly named file, remote tarball, or Git dependency. Broad semver ranges and dist-tags are not valid version-scoped approvals. Denial wins when entries conflict.

`fsevents` installation scripts are denied. Its reviewed artifact includes a native binary and no install lifecycle script or `binding.gyp`, although registry metadata and the lockfile indicate installation scripts. CI does not run a dedicated macOS installation job. Run the native smoke below on macOS after a clean install when validating platform compatibility; Linux skips this optional dependency and cannot establish macOS compatibility. A native smoke failure must be investigated, not fixed by automatically approving metadata scripts.

The preflight rejects unexpected toolchain versions, disabled strict policy, changed release age, script-ignore/allow-all bypasses, exclusions other than the exact Kit exception below, and explicit `before` cutoffs. An environment `allow-scripts` policy is rejected; an ignored lower-priority user/global `.npmrc` allowlist is not mistaken for an active override. Complete npm configuration is never logged by the preflight.

Install policy is not a sandbox. It does not constrain an approved script, root/workspace-owned scripts, builds, tests, package tooling, runtime imports, or third-party Actions. npm separately excludes linked workspace inventory nodes, bundled dependency scripts, and platform-incompatible optional dependencies from strict review. Non-registry install/prepare scripts and implicit native build scripts require source-specific review when applicable.

## Release age and lockfile maintenance

`.npmrc` applies a three-day minimum release age to newly resolved third-party registry versions. The exact `@narumitw/pi-tui-kit` name is exempt so independently installed consumers can use a just-published Kit release. Kit's third-party dependencies are not exempt, and the exception does not approve installation scripts. The preflight rejects scope-wide, additional, or substituted exceptions. External users' npm policies remain independent of this repository's `.npmrc`.

A range may select an older eligible version; a fresh exact version or range with no eligible candidate fails. **Existing lockfile versions can be retained without rechecking age**, both by lockfile-only updates and by `npm ci`. This policy is not an independent age audit of the lockfile.

`npm run update:lock` asks `npm-check-updates` for proposed versions, then uses `npm install --package-lock-only --ignore-scripts`. The proposal tool may select a version too recent for npm's policy; the subsequent npm resolution then fails rather than silently weakening the age requirement. Changesets' `version-packages` lockfile update has the same boundary for third-party packages. An unpublished Kit version can resolve through the local npm workspace; [coordinated release fixtures](coordinated-releases.md) verify the complete versioning command and a subsequent unchanged-lockfile `npm ci`. `--ignore-scripts` is intentional for these metadata-only updates and does not itself disable release-age filtering.

If an update fails, inspect the manifest and lockfile diff, then use Git to restore only that attempted update or choose eligible versions and rerun verification. The updater requires a clean worktree before mutation but can leave manifest edits when npm rejects a proposal; there is no automatic rollback.

For an urgent patch, prefer an eligible fixed version where possible. Otherwise review the artifact, advisory, age exception, and exact resulting lockfile diff explicitly, and obtain maintainer approval for a targeted temporary exception during lockfile generation. Do not broaden the exact Kit exclusion, disable strict policy, or silently add overrides to CI. Subsequent normal installs must pass the unchanged preflight and script policy; retaining the reviewed lock does not establish that every entry is three days old.

## Toolchain upgrades and verification

Update the shared Node pin and bundled npm assertion together after inspecting the upstream release and running the policy fixtures. Pinning avoids unreviewed automatic toolchain changes but also requires prompt review of security patches. Do not broaden the supported npm range without behavioral evidence.

Run `npm exec -- vitest run test/dependency-installation.test.ts test/install-policy-wiring.test.ts` for offline mock-registry fixtures and wiring checks, then `npm run check` and `npm test` separately. Fixtures prove approved execution, denied skipping, policy-specific unreviewed failure before a marker script executes, effective override rejection, lockfile mismatch, and fresh versus reused lockfile-age behavior. They cover updater proposal failures and the versioning lockfile command without publishing or modifying external repositories.

On macOS, run `npm ci` followed by `npm exec -- vitest run test/macos-install.test.ts` to verify native file watching manually. The smoke also runs as part of `npm test` on macOS and is deliberately skipped elsewhere; platform metadata simulation is not native compatibility evidence. Keep clean-install/hash comparison, representative tarball inspection, and final release-gate review as part of a toolchain/policy change. Revert the focused policy, toolchain, workflow, test, and documentation changes together if recovery is needed; do not publish or dispatch release workflows as part of validation.
