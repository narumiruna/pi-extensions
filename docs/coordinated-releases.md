# Coordinated Kit and consumer releases

A Kit API and the consumers that adopt it can ship in one Version PR and one release workflow run. Packages keep independent versions. npm publication is not atomic: Kit can remain published if a later consumer fails.

## Versioning

Add a Changeset for Kit and each consumer that adopts the API. The consumer must have a dependency floor that supplies every API it uses. Changesets updates ordinary SemVer ranges and automatically patches consumers whose ranges exclude a new internal version. A compatible Kit patch does not automatically release unselected consumers. Keep `fixed` and `linked` empty.

Run the existing `version-packages` command only in the normal versioning workflow or a disposable fixture. It changes versions, changelogs, and the lockfile. The lockfile command resolves an unpublished Kit through its local workspace, not the registry. The separate Docker smoke manifest and lockfile are not part of root workspace version propagation.

## Publication

The pack job builds tarballs and records their SHA256 hashes in the publish-plan artifact. The publish job downloads that artifact and runs `npm run publish-packages -- --from-pack-dir <directory>` through the pinned Changesets publish Action. This command invokes native `changeset publish`. Changesets uses the packed dependency chunks; no custom Kit-first ordering is applied. The Action handles GitHub tags, releases, and publication outputs.

The workflow relies on the native publish result. It does not query registry readiness, download published tarballs, or compare their hashes after publication. Registry visibility can lag behind a successful publish. Native artifact publication does not verify the recorded hashes against registry contents.

The exact Kit release-age exception in `.npmrc` permits fresh registry resolution without weakening the three-day rule for third-party dependencies or strict install-script review. That exception does not change external users' policies.

## Failure and recovery

A native publication failure stops later chunks. Changesets can finish concurrent peers in a reached chunk before reporting failure. Successful publications reported by the CLI remain in `CHANGESETS_OUTPUT` for the Action to process.

Inspect registry versions and the failed step before retrying through the approved release workflow. A new workflow plan normally omits versions already visible in registry metadata. There is no custom registry-byte comparison or tag recovery. Never overwrite or reuse a published version for changed contents; prepare a corrective version instead.

Native Action recovery has limits. Existing local or remote tags do not emit new publication events, so replay does not repair a missing GitHub release for an existing tag. GitHub tag-push failures can produce warnings, and GitHub release-creation errors can prevent Action outputs and the summary from being set even when npm publication succeeded. Inspect registry versions, tags, GitHub releases, and logs before recovery; an empty summary is not proof that nothing was published. Repair external tags or releases only with explicit approval.

## Verification

The workflow pins the Actions revisions; `package.json` and the lockfile define the Changesets CLI version. Offline tests cover version propagation, dependency-ordered publish plans, and native artifact-command wiring. Mock-registry install tests cover the exact Kit age exception and unchanged third-party/script protections.

Run the focused tests, then both repository gates:

```bash
npm exec -- vitest run test/changesets-release.test.ts test/changesets-versioning.test.ts test/publish-workflow.test.ts test/dependency-installation.test.ts test/install-policy-wiring.test.ts
npm run check
npm test
```

Production npm authentication, GitHub OIDC publication, registry propagation, and GitHub tag/release creation remain unverified until a separately approved live release. Do not dispatch a release workflow to validate a tooling pull request.
