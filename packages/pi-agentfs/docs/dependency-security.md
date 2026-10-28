# Dependency security

The root manifest overrides `just-bash`'s `guarded-fetch` dependency to use its patched HTTP dependency chain.
The root manifest also aligns `agentfs-sdk`'s Turso database dependencies with this workspace's direct database dependency.
The lockfile records the selected versions.
These overrides apply to repository installs, not independent installs of published workspace packages.
Remove each override when the declared upstream dependencies resolve to compatible, patched releases without it.

## Formatter replacement

The root manifest replaces `just-bash`'s `sprintf-js` dependency with the `@lvcabral/sprintf` fork through an npm alias.
This removes the package flagged by [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) without downgrading AgentFS or suppressing audit results.
The [authoritative CVE record](https://cveawg.mitre.org/api/cve/CVE-2026-97058) marks this CVE as `REJECTED`; the alias is a dependency replacement, not a claim that the fork patches the rejected CVE.

Invalid precision can still raise JavaScript exceptions.
`just-bash` must contain those exceptions and return command failures.
`packages/pi-agentfs/test/formatter-compatibility.test.ts` verifies that behavior, recovery after failure, and the relevant native and formatter-backed conversions through both ESM and CommonJS entrypoints.

AgentFS does not expose `printf` or `awk` in its restricted shell.
`packages/pi-agentfs/test/workspace.test.ts` verifies that the reported precision inputs cannot reach either command and that the workspace remains usable after rejection.
