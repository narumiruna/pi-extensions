# Coordinated Kit and consumer releases

A Kit API and the consumers that adopt it can ship in one Version PR and one release workflow run. Packages keep independent versions. npm publication is not atomic: Kit can remain published if a later consumer fails.

## Versioning

Add a Changeset for Kit and each consumer that adopts the API. The consumer must have a dependency floor that supplies every API it uses. Changesets updates ordinary SemVer ranges and automatically patches consumers whose ranges exclude a new internal version. A compatible Kit patch does not automatically release unselected consumers. Keep `fixed` and `linked` empty.

Run the existing `version-packages` command only in the normal versioning workflow or a disposable fixture. It changes versions, changelogs, and the lockfile. The lockfile command resolves an unpublished Kit through its local workspace, not the registry. The separate Docker smoke manifest and lockfile are not part of root workspace version propagation.

## Publication

The pack job builds tarballs and records their SHA256 hashes in the publish-plan artifact. The publish job downloads that artifact and runs `npm run publish-packages -- --from-pack-dir <directory>` through the pinned Changesets publish Action. The command validates every local tarball before invoking native `changeset publish` for each dependency-ordered chunk. It copies the exact packed bytes and release entries into temporary chunk directories; it does not rebuild or repack them.

The guard uses the installed Changesets public runtime dependency graph, including workspace paths, peer and optional dependencies, and native field precedence. Development dependencies do not add ordering edges. Cycles and runtime references to the private workspace root are rejected. No package-specific ordering rule is used.

Before a dependent chunk, the guard queries each required internal dependency by exact name and version, downloads its registry tarball, and verifies the strongest supported Subresource Integrity (SRI) hash. When that dependency has a tarball in the packed plan, the registry bytes must also match its recorded SHA256 hash. Dependencies omitted from a retry plan, or represented by a tag-only entry, still require exact registry metadata and a verified download; they have no local packed hash to compare. A successful publish exit is not evidence of artifact availability.

Missing or incorrect metadata, unavailable tarballs, hash failures, redirects, and download timeouts block dependent publication. Downloads must be readable through HTTP(S); the guard does not add registry credentials to artifact requests. The guard rejects duplicate or native-equivalent packed-directory overrides. Other arguments pass to the native CLI unchanged. Native npm authentication, provenance, tag creation, and append-only `CHANGESETS_OUTPUT` reporting remain with Changesets; the Action handles tag pushes, GitHub releases, and publication outputs.

The exact Kit release-age exception in `.npmrc` permits fresh registry resolution without weakening the three-day rule for third-party dependencies or strict install-script review. That exception does not change external users' policies.

## Failure and recovery

A native publication failure or artifact-verification failure stops later chunks. Changesets can finish concurrent peers in a reached chunk before reporting failure. Successful publications reported by the CLI remain in `CHANGESETS_OUTPUT` for the Action to process. The guard does not retry registry visibility checks automatically.

Inspect registry versions and the failed step before retrying through the approved release workflow. A new workflow plan normally omits versions already visible in registry metadata. Required dependency artifacts are still verified. There is no custom tag recovery. Never overwrite or reuse a published version for changed contents; prepare a corrective version instead.

Native Action recovery has limits. Existing local or remote tags do not emit new publication events, so replay does not repair a missing GitHub release for an existing tag. GitHub tag-push failures can produce warnings, and GitHub release-creation errors can prevent Action outputs and the summary from being set even when npm publication succeeded. Inspect registry versions, tags, GitHub releases, and logs before recovery; an empty summary is not proof that nothing was published. Repair external tags or releases only with explicit approval.

## Verification

The workflow pins the Actions revisions; `package.json` and the lockfile define the Changesets CLI version. Offline tests cover version propagation, the native runtime graph, packed-mode argument safety, exact-artifact failures, and native artifact-command wiring. A real installed-CLI test uses fail-closed npm and Git shims plus a local HTTP server to prove partial reporting, blocked dependents, already-published results, and a successful retry without publication or tags. Mock-registry install tests cover the exact Kit age exception and unchanged third-party/script protections.

Run the focused tests, then both repository gates:

```bash
npm exec -- vitest run test/changesets-release.test.ts test/changesets-versioning.test.ts test/publish-workflow.test.ts test/packed-publish-guard.test.ts test/packed-publish-native.test.ts test/dependency-installation.test.ts test/install-policy-wiring.test.ts
npm run check
npm test
```

Production npm authentication, GitHub OIDC publication, registry propagation, and GitHub tag/release creation remain unverified until a separately approved live release. Do not dispatch a release workflow to validate a tooling pull request.
