# Pi Subagents widget defaults verification

The widget uses task-first rows and hides thinking when it equals the main agent's effective level captured at spawn. Job IDs and tool names are hidden by default; saved preferences still take precedence. Child execution and model-visible tool contracts are unchanged.

## Completed checks

- `npm run check` passed workspace builds, Biome, package boundaries, and typechecks.
- The full `npm test` passed all 800 test files: 15,506 tests passed and 20 were skipped. It reused the successful workspace build. No unhandled errors were reported.
- The two filesystem regression files passed 179 tests. Earlier Subagents package and root lifecycle verification passed 487 tests across 20 files.
- A fenced-code-aware audit passed the required README headings and order for all 37 packages. The changed README retains its badges and install warnings.
- The offline `pi --mode rpc --no-extensions -e ./packages/pi-subagents` smoke passed startup, the generated lazy manager, settings defaults, the direct settings route, and orderly shutdown. No provider request or settings file was created.
- Review against `docs/extension-conventions.md`, `docs/extension-settings.md`, and `docs/readme-conventions.md` found no change to session cleanup, settings persistence, publication safety, or model-visible prefixes.

## Filesystem test corrections

Imagegen preflight deliberately rejects a missing directory-shaped symlink target without writing. Native write errors can differ by platform. Tests now check the preflight classification separately and compare binary publication with native WRITE. Coverage includes relative and absolute targets, direct and chained links, unchanged links, absent targets, and no preflight open or write.

Starship recursive deletion can report a child permission error or a parent `ENOTEMPTY` error. The test now verifies observable failure, retained resources, disabled read/write/edit tools and draft access, unchanged active settings, successful cleanup retry, and repeated disposal. The permission fixture remains disabled on Windows and when running as root.

These corrections change only tests. No additional Changeset, package metadata change, or runtime-loading smoke is required.

## Unverified physical-terminal behavior

The command harness permits non-interactive execution only, so no physical-terminal visual review was run. Automated rendering, lifecycle, and non-default keybinding tests passed; they do not establish physical-terminal acceptance.

Responsible role: terminal user. Prerequisites: built Kit and Subagents packages in the intended terminal. Review task-first rows, conditional thinking, saved display overrides, narrow layouts, and resizing. The expected result is readable, bounded rows with no change to editor input. This external review is not a remaining deterministic-test gate.

No live provider request was needed for these display and test changes. These checks do not grant publication or release approval.
