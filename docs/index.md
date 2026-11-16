# Pi Extensions documentation

Guides and technical references for independently installable Pi extensions and reusable libraries.
Start with the [repository package catalog](../README.md#-choose-an-extension) to choose a package, then follow its README for installation and first use.
Extensions run with your user permissions; review each package's compatibility, security, and experimental-feature warnings before enabling it.

## Package guides and references

The [package documentation index](packages.md) groups settings, workflows, protocols, architecture, and developer evidence by package.
Package-owned documents remain in `packages/<package>/docs/`; this site renders them without creating another maintained copy.

## Author extensions

- [Extension conventions](extension-conventions.md): package boundaries, lifecycle, commands, TUI, and verification.
- [Extension settings](extension-settings.md): scope, precedence, validation, persistence, and recovery.
- [README conventions](readme-conventions.md): required sections, warnings, and reference boundaries.
- [Generated-runtime builder](runtime-builder.md): build-backed extension entrypoints and validation.
- [Workflow mutex protocol](api/workflow-mutex-v1.md): the versioned cooperative workflow contract.

## Maintain the repository

- [Dependency installation](dependency-installation.md) and [test performance](test-performance.md).
- [Release workflow](release-workflow.md) and [publish workflow](publish-workflow.md).
- [Coordinated releases](coordinated-releases.md) and [registry diagnostics](publish-registry-diagnostics.md).
- [Documentation site](documentation.md): preview, build, content ownership, and navigation updates.

## Explore design and evidence

The [design and evidence index](design-and-evidence.md) separates architecture decisions, implementation audits, verification records, benchmarks, research, and roadmaps.
Historical evidence and proposals do not replace current package documentation or authorize a release.
