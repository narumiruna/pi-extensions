---
description: Review and remove source comments in a bounded batch
argument-hint: "[source path]"
---
# Delete comments

Scope: ${@:-packages/*/src/}

1. Use the requested scope, defaulting to package source, and choose a batch you can review in context.
   Run `node scripts/check-source-comments.mjs --list` from the repository root or pass an exact directory or file, for example `node scripts/check-source-comments.mjs --list packages/pi-ticker/src`.
2. Read each comment with the surrounding code, tests, and any API contract it cites.
   Keep required notices and comments consumed by tools or published API documentation until you have a verified replacement.
   Leave uncertain comments in the baseline and report them as unreviewed or unresolved.
3. Classify each remaining comment and act on it:
   - **Tautology:** It repeats what the code already says; delete it.
   - **Stale:** Its claim no longer matches the implementation or supported runtime; verify that and delete it.
   - **Excuse:** It defends a workaround with a concrete drawback; search for an existing issue or file one when authorized, then delete the comment.
     Record the current behavior, affected source, and a verifiable fix in the issue.
     If no issue can be filed or found, keep the comment and report the blocker.
   - **Decision Record:** It explains a non-obvious choice, dependency contract, or tradeoff; preserve the rationale in a relevant ADR under `docs/adr/`, then delete the comment.
4. Review the diff for token boundaries, line breaks that affect parsing, tooling directives, and unchanged runtime behavior.
   Do not mix a workaround fix into a comment-only cleanup.
5. Run `node scripts/check-source-comments.mjs --prune` to drop obsolete entries, then `prek run check-source-comments --all-files`, `npm run check`, and `npm test`.
   Never add a baseline entry to pass a check.
6. Report the batch and counts, ADR and issue links, required or unresolved comments left in place, and remaining comment-only lines.
   Do not describe the remaining inventory as reviewed unless you classified it.
