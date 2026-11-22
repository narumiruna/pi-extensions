# Coordinated Kit and consumer releases

A Kit API and the consumers that adopt it can ship in one Version PR and one release workflow run. Packages keep independent versions. npm publication is not atomic: Kit can remain published if a later consumer fails.

## Versioning

Add a Changeset for Kit and each consumer that adopts the API. The consumer must have a dependency floor that supplies every API it uses. Changesets updates ordinary SemVer ranges and automatically patches consumers whose ranges exclude a new internal version. A compatible Kit patch does not automatically release unselected consumers. Keep `fixed` and `linked` empty.

Run the existing `version-packages` command only in the normal versioning workflow or a disposable fixture. It changes versions, changelogs, and the lockfile. The lockfile command resolves an unpublished Kit through its local workspace, not the registry. The separate Docker smoke manifest and lockfile are not part of root workspace version propagation.

### Pi Sync and the daemon

Pi Sync builds after the local daemon workspace and embeds that build in its npm tarball. Its daemon `devDependencies` entry is a local build edge, not a registry publication edge. A daemon-only release does not update a packed Pi Sync version. Add an explicit `@narumitw/pi-sync` Changeset whenever Pi Sync needs to adopt a daemon build, including security or correctness fixes. Confirm the selected daemon version is in the build range. Changesets can update that range without bumping Pi Sync, so a range update alone does not ship a new embedded build. Use a separate Changeset when standalone behavior changes; both packages can ship in the same batch without a daemon-first registry requirement for Pi Sync.

Kit remains an ordinary Pi Sync runtime dependency at the existing floor. Keep Kit-first publication when both packages ship together, and verify the exact Kit registry artifact before publishing Pi Sync even when Kit was already published. See the [embedded-daemon decision](adr/0009-pi-sync-ship-daemon-in-package.md) and [build requirements](runtime-builder.md#pi-syncs-embedded-daemon).

## Publication

The `pack` job builds tarballs once and records their SHA-256 hashes in `publish-plan.json`. Each later job downloads that same packed artifact by ID and validates the entire plan and every local tarball before selecting a stage. The guard copies the exact selected bytes and release entries into temporary chunk directories for native `changeset publish`; it does not rebuild or repack them.

The guard takes `npm run publish-packages -- --from-pack-dir DIRECTORY` with one optional `--stage`:

| Stage | Behavior |
| --- | --- |
| `prerequisites` | Publish every planned entry required by another planned entry, including tag-only entries. Preserve dependency order and verify any required registry artifacts before each dependent chunk. |
| `verify-registry` | Verify the distinct runtime dependencies of all remaining entries. Never invoke native publish. If nothing requires verification, make no registry requests. |
| `remaining` | Recheck those same dependencies, then publish the rest of the plan, including unrelated entries. No remaining entry depends on another remaining entry. |
| No stage | Verify and publish the full plan in dependency-ordered chunks, as before. |

A Kit-only plan publishes Kit in `remaining` without a registry wait unless Kit itself requires an internal runtime artifact. A consumer-only plan still verifies Kit, even though `prerequisites` is empty.

The guard uses the installed Changesets public runtime dependency graph, including workspace paths, peer and optional dependencies, and native field precedence. Development dependencies do not add ordering edges. Cycles and runtime references to the private workspace root are rejected. No package-specific ordering rule is used.

Before a dependent chunk, the guard queries each required internal dependency by exact name and version, downloads its registry tarball, and verifies the strongest supported Subresource Integrity (SRI) hash. When that dependency has a tarball in the packed plan, the registry bytes must also match its recorded SHA256 hash. Dependencies omitted from a retry plan, or represented by a tag-only entry, still require exact registry metadata and a verified download; they have no local packed hash to compare. A successful publish exit is not evidence of artifact availability.

The read-only gate has a five-minute budget per exact dependency version and waits up to five seconds between attempts. Publishing stages (and the unsplit command) retain the 30-second budget with waits up to two seconds. The final short check protects direct invocations and final-job-only reruns from publishing against stale gate results. Metadata queries, tarball fetches, body reads, and retry waits share the applicable monotonic budget. Expiry cancels registry I/O and blocks consumers, including when an operation reports success after the deadline.

Retryable failures are npm or HTTP 404, 408, 429, and 5xx responses, recognized connection errors, and timeouts while budget remains. Authentication failures, unknown errors, malformed or incorrect metadata, invalid URLs, redirects, and hash failures stop immediately. Registry subprocesses receive SIGTERM on cancellation, then SIGKILL after a separate one-second termination grace if needed; the guard waits for closure before removing staging. During registry verification, SIGINT and SIGTERM cancel owned work and wait for cleanup before the CLI re-raises the original signal. Native Changesets publication keeps normal signal handling, has no registry deadline, and is never retried by the guard. See [registry diagnostics](publish-registry-diagnostics.md) for safe failure output and cleanup limits.

Neither budget guarantees registry propagation. Downloads must be readable through HTTP(S); the guard rejects URLs with credentials and does not add credentials to artifact requests. The guard rejects duplicate or ambiguous packed-directory and stage options. Other arguments pass to the native CLI unchanged for publishing; the read-only stage rejects them. Native npm authentication, provenance, tag creation, and append-only `CHANGESETS_OUTPUT` reporting remain with Changesets; both publishing jobs use the pinned Action to push tags, create GitHub releases, and report tracked publications.

The exact Kit release-age exception in `.npmrc` permits fresh registry resolution without weakening the three-day rule for third-party dependencies or strict install-script review. That exception does not change external users' policies.

## Failure and recovery

A native publication failure or artifact-verification failure stops later chunks. Changesets can finish concurrent peers in a reached chunk before reporting failure. Successful publications reported by the CLI remain in `CHANGESETS_OUTPUT` for the Action to process. The guard retries only temporary registry availability failures; it does not retry native publication or bypass artifact checks.

For a temporary gate failure, **Re-run failed jobs** reuses the original packed artifact without republishing successful prerequisites. After a native publication failure, inspect registry versions and the failed step before replaying the job. A replay can submit already-published versions from its immutable plan; it cannot overwrite them. An approved fresh run normally omits versions already visible in registry metadata and still checks required artifacts. See the [release recovery matrix](release-workflow.md#failures-and-recovery).

Native Action recovery has limits. Existing local or remote tags do not emit new publication events, so replay does not repair a missing GitHub release for an existing tag. GitHub tag-push failures can produce warnings, and GitHub release-creation errors can prevent Action outputs and the summary from being set even when npm publication succeeded. Inspect registry versions, tags, GitHub releases, and logs before recovery; an empty summary is not proof that nothing was published. Repair external tags or releases only with explicit approval.

## Verification

The workflow pins the Actions revisions; `package.json` and the lockfile define the Changesets CLI version. Deterministic tests cover stage selection, version propagation, exact hashes, both deadlines, cancellation, and the job graph. The installed-CLI fixture uses npm and Git shims and a loopback registry to check that a gate retry neither rebuilds nor invokes the publisher, that the final stage rechecks before writing, and that a native failure preserves partial reports without repairing missing tags on replay. Mock-registry install tests cover the exact Kit age exception and unchanged third-party/script protections.

Run the focused tests, then both repository gates:

```bash
npm exec -- vitest run test/changesets-{release,versioning}.test.ts \
  test/publish-{workflow,command}.test.ts test/packed-publish-{guard,stages,deadline,native}.test.ts \
  test/{pi-sync-daemon-release,dependency-installation,install-policy-wiring}.test.ts
actionlint .github/workflows/publish.yml
npm run check
npm test
```

Hosted reuse of the original packed artifact across attempts, production npm propagation, OIDC provenance, and GitHub tag/release writes remain unverified until a separately approved live release. Do not dispatch a release workflow to validate a tooling pull request.
