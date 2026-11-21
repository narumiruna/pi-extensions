# Source comment ratchet

New JavaScript, TypeScript, and CSS comments are not allowed in
`packages/*/src/`. The check includes nested source files and new non-ignored
files, but not tests, project extensions, or generated output outside
`src/`. It parses source rather than searching for comment markers, so strings,
regular expressions, template text, JSX text, and URLs are not counted.

Run these commands from the repository root:

```bash
prek run check-source-comments --all-files
node scripts/check-source-comments.mjs --list packages/pi-ticker/src
node scripts/check-source-comments.mjs --prune
```

The first command runs the pre-commit hook directly. The second lists locations
and exact comment text for review. Without a path it also gives the total number
of comment-only lines; deleting an inline comment does not remove the line if
code remains. Use `--prune` after removing comments and stage the baseline with
the source changes.

The checked-in baseline records the path and a hash of each comment, including
duplicate occurrences. A line-number shift is fine; moving to another file,
rewriting text, or adding another copy is not. Pruning never adds entries.
The hook also compares the baseline against `HEAD`. The commit that introduces
the baseline has no prior baseline to shrink.

Use `/delete-comment [source path]` in a trusted Pi checkout. Delete redundant
and stale comments, track confirmed workarounds in issues, and move durable
rationale into [ADRs](./adr/). Review notices,
compiler and bundler directives, and published API documentation before
removing them; the check does not decide what is safe to delete. If code needs
a new directive or notice to work or to meet a legal obligation, raise it for an
explicit policy review rather than removing it or silently expanding the
baseline.

## First batch

| Package | Removed | Disposition |
| --- | ---: | --- |
| Cache Hit Monitor | 4 | Removed redundant rendering wording and preserved lifecycle and display rationale in [its ADR](./adr/0005-pi-cache-hit-monitor-confirmed-usage.md). |
| Ticker | 4 | Dropped the stale parity claim, moved the UI choice to [its ADR](./adr/0006-pi-ticker-mode-specific-reorder.md), and filed [#1983](https://github.com/narumiruna/pi-extensions/issues/1983) for the shortcut workaround. |
| Tool | 3 | Moved exposure, keyboard access, and width rationale to [its ADR](./adr/0007-pi-tool-available-tools-widget.md). |

The other baseline entries are inventoried, not semantically classified.
