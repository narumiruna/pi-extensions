# Changesets

Add one changeset Markdown file for every pull request that should release one or more packages:

```bash
npm run changeset
```

Choose each affected package and its SemVer bump. Changesets are consumed by the automated version
pull request, which updates selected packages and required dependents with their changelogs. Documentation, tests,
repository tooling, and package moves that do not change published package behavior may omit a
changeset.

Packages version independently. Do not add `fixed` or `linked` groups. A new
`@narumitw/pi-tui-kit` API and consumers that adopt it can share one changeset, Version PR, and
release batch. Select each adopting consumer with its required SemVer bump; Changesets updates
ordinary internal dependency ranges and includes out-of-range consumers automatically. A compatible
Kit patch does not force every consumer to release.

The publish workflow releases Kit first and verifies its registry tarball before dependent
publication. Failures stop later batches; retries verify existing artifact bytes rather than
republishing them. See [coordinated releases](../docs/coordinated-releases.md) for verification,
release-age policy, and partial-release recovery.
