---
name: hardening-code-paths
description: Use when asked to proactively harden a specific code path by confirming and fixing plausible edge-case, boundary, failure-mode, or lifecycle bugs; to fix a confirmed security finding; or to check nearby same-pattern regression risks. Use auditing-code-security first for broad threat analysis or unverified security alerts.
---

# Hardening Code Paths

Actively inspect the relevant code path, confirm plausible edge-case and failure-mode bugs, and fix or harden them. Do not wait for the user to enumerate cases. Accept confirmed security findings from `auditing-code-security`; leave broad threat analysis and unverified alerts in that audit workflow rather than making speculative security changes.

## Default Scope

When the user does not provide files, a commit, or a diff, inspect `git status --short` and start with relevant staged, unstaged, and untracked paths. For a branch or pull request, determine its target from repository or PR context and include paths from the merge-base diff, such as `git diff --name-only <target>...HEAD`; do not assume the target is `main` or `master`. If no changed path applies, inspect the files implied by the request; if no scope can be inferred, ask for one target.

## Loop

1. Infer intended behavior from the user request, code, tests, docs, and sibling flows; state assumptions, but only ask when the rule is ambiguous.
2. Trace the real flow end to end, including callers, sibling routes, cleanup paths, stored state, and representation changes.
3. Load [the edge-case checklist](references/edge-case-checklist.md) and select only domains reachable in this flow.
4. Build a bounded risk matrix across the few dimensions most likely to interact: representative inputs, operations, before/during/after states, lifecycle events, and representations. Prioritize security, data loss, corruption, hangs, and broken core behavior; avoid exhaustive Cartesian products and unsupported platform speculation.
5. Establish that each candidate violates intended behavior, then add the smallest regression test or executable check that fails before the fix when practical. For a security finding, reproduce the original attack conditions without exposing secrets or targeting an external system. If the failure cannot be verified, report the risk as unverified instead of changing behavior.
6. Fix or harden each confirmed bug at the shared root path, not only the reported symptom. Put security fixes at the shared trust boundary so equivalent callers cannot bypass them.
7. Run the narrow check, then scan sibling callers/routes for the same pattern, including alternate encodings, identities, tenants, or objects implicated by a security finding.
8. Perform one fresh pass over the resulting diff for opposite bounds, equivalent encodings, stale or cancelled state at asynchronous boundaries, cleanup, and whether the regression test would fail if the bug returned.
9. Repeat only while the fix exposes a concrete adjacent case in the same failure class; stop before materially different behavior or scope.
10. Run the repo's normal verification gate before final response.

## Fix Rules

- Prefer one guard or normalization in the shared boundary over repeated caller patches.
- Preserve existing contracts unless the task explicitly changes them.
- If retained state is introduced, add the minimal eviction or cleanup path.
- If a timeout or cancellation can fire, close or clear the resource too.
- If input crosses a trust boundary, validate type and shape before use; keep authentication, authorization, and tenant or object ownership checks at the authoritative boundary.
- For confirmed security findings, cover the denied attack path and a permitted control path so the fix neither bypasses policy nor breaks authorized behavior.
- If a package/config points to code, prove the referenced file exists in the packaged/runtime form.
- Keep the sibling scan bounded to the same root cause and directly affected flow. Stop and report when the next candidate requires a new behavior decision or material scope expansion.
- Stop when checks pass and the sibling scan finds no same-pattern bug; report fixed cases, checks run, and any unverified risk plainly.
- Do not return only a checklist or plan unless the user explicitly asks for one.
