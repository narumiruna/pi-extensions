# Package README conventions

This guide defines the shared structure for active package READMEs under `packages/`.
It keeps package documentation predictable without forcing irrelevant sections onto every extension or reusable library.

## Required foundation

Every active package README must present these elements in this order:

1. An emoji title with the package name and a concise purpose.
2. The package's npm and license badges, plus the Pi extension badge for extension packages.
3. A short summary that states what the package does.
4. `## ✨ Features`.
5. `## 📦 Install`.
6. `## 🚀 Quick start`.
7. Applicable interface and operational sections.
8. `## 🗂️ Package layout`.
9. `## 🔎 Keywords`.
10. `## 📄 License`.

Reusable libraries omit the Pi extension badge and may make Quick start an import example rather than a Pi command.

## Standard section labels

Use these exact labels when the subject applies:

- `## ✨ Features` for a concise capability overview.
- `## 📦 Install` for persistent installation, temporary execution, and local-checkout instructions that apply to the package.
- `## 🚀 Quick start` for the shortest successful first use.
- `## 💬 Commands` for user-facing slash commands.
- `## 🛠️ Tools` for tools registered for the model.
- `## ⚙️ Settings` for configuration entry points, minimal examples, essential defaults or safety behavior, and links to detailed guidance.
- `## 🔒 Security and privacy` for permissions, credentials, external data, or other material trust boundaries.
- `## 🚧 Limitations` for known unsupported behavior and important constraints.
- `## 🗂️ Package layout` for the package's maintained source and publication structure.
- `## 🔎 Keywords` for a short searchable summary.
- `## 📄 License` for the license name and a link to the package license.

Use one standard heading instead of variants such as `Usage`, `Command`, `Configuration`, `Pi tools`, `Known limits`, `📁 Package layout`, or `🏷️ Keywords`.
Keep a more specific heading when it describes a separate package concept rather than the standard subject.
For example, `Model and thinking level` may remain separate after the general Quick start section.

## Applicability

Commands, Tools, Settings, Security and privacy, and Limitations are conditional sections.
Do not add an empty section or claim an interface that the package does not provide.
A passive extension may omit Commands and Tools.
A package with no user-owned settings may omit Settings.
Split safety, privacy, recovery, and limitations into separate headings when users need that distinction.

Package-specific sections belong between the common interface sections and Package layout.
Order them from first-use information to deeper behavior, lifecycle, recovery, limitations, and development material.
Preserve documentation of supported behavior, compatibility, and safety when shortening a README; move detail to linked package-owned guidance rather than silently deleting it.
Keep essential warnings in the README near the action they affect.

## Content rules

Write user-facing prose in English.
Group narrative text into concise Markdown paragraphs, keeping related source lines together without blank lines between every sentence.
Use lists when independent items, choices, steps, or references are easier to scan separately.
Give each topic one authoritative explanation and link to it from other sections instead of repeating its details.
Repeat a command when needed for a runnable example, or a brief warning at a risky action, but do not repeat the surrounding reference material.
Choose depth by what users need to decide, start, or operate safely, not by the number of implementation branches or tests.
Document only commands, tools, settings, modes, and guarantees implemented by the package.
Treat model IDs, paths, session text, and pasted text shown in examples as untrusted terminal input where relevant.
Use stable absolute GitHub and npm links when referring to another package in this monorepo.
Describe borrowed syntax as inspired by another project unless compatibility is guaranteed.

Detailed user guidance may live in linked package-owned documentation or a package-owned skill bundled with the package.
Identify the authoritative source and explain how to access it instead of duplicating the complete reference.
Keep implementation rationale, component ownership, and internal lifecycle mechanics in developer documentation or code comments unless they explain a user-visible constraint.
Do not create extra documents for short explanations that already fit naturally in the README.

## Section scope

Use these boundaries without adding sections that do not apply:

| Section | Keep in the README | Avoid |
| --- | --- | --- |
| Title, badges, and summary | Package identity, purpose, and a short explanation of when to use it. | Restating the title or listing features in the summary. |
| Features | Distinct user-facing capabilities that help readers choose the package. | Command inventories, configuration fields, implementation details, or guarantees repeated verbatim elsewhere. |
| Install | Applicable persistent, temporary, and local-checkout commands, with required prerequisites and trust warnings. | Full usage tutorials or repeated setup instructions for each install method. |
| Quick start | One shortest successful path after installation, including required setup and the expected result. | Repeating Install, showing every alternative, or touring the entire menu. |
| Tools | Registered tool names or concise groups, their purpose, and important prerequisites or side effects. | Complete parameter schemas and tool-result examples for every variant; link a detailed catalog when needed. |
| Security and privacy | Permissions, credentials, data access, storage, external destinations, and controls needed for informed use. | Internal security mechanisms that do not change a user's decision or required precautions. |
| Limitations | Material unsupported behavior, compatibility constraints, and practical workarounds. | Every defensive check, hypothetical failure, or a second copy of security guidance. |
| Package-specific sections | Distinct concepts and operational or recovery guidance users need beyond the common sections. | Moving an exhaustive menu tour or internal lifecycle specification under a new heading just to shorten Commands. |
| Package layout | Main maintained directories, entrypoints, publication boundaries, and their responsibilities. | Exhaustive file trees, generated chunks, or a description of every helper and test file. |
| Keywords | A short set of relevant discovery terms. | Feature prose, repeated synonyms, or unrelated search terms. |
| License | License name and a link to the package license. | Reproducing the license text. |

Installation instructions must state that extensions run with Pi's permissions when that warning is material to the package's install flow.
Build-backed packages must explain that an unbuilt local checkout needs its build before package-directory loading.
Keep security, privacy, experimental-feature warnings, and other information users must understand before installing or enabling the package in the README.
Document additional precedence, persistence, failure, cancellation, recovery, or lifecycle behavior in the README or its linked package-owned guidance when users need it for safe operation.

### Commands

Keep Commands a quick reference to public slash-command syntax and outcomes, not a complete UI specification.
Use a short paragraph for a single command and a compact list or table for multiple routes; a table is not required.
Document each accepted route and compatibility alias with a concise purpose, grouping aliases that behave identically.
State common supported modes and argument restrictions once, then note only route-specific differences.
Include important prerequisites, side effects, and safety constraints directly or through a clearly labeled reference to their owning section.
Add an example only when it clarifies syntax or behavior not already clear from the reference or Quick start.

For menu-first commands, describe what the manager lets users accomplish instead of transcribing every menu item, state, dialog, or standard keybinding.
Explain unusual interaction or cancellation behavior when it affects safe use, such as changes saved immediately that Escape does not undo.
Keep destructive-operation and external-data warnings visible; link detailed workflows, recovery instructions, or long command references from a concise overview.

### Settings

Keep Settings focused on configuration entry points, a minimal example when configuration is needed, and essential defaults or safety behavior.
State the settings path and scope, how to edit settings, and when changes take effect.
Keep accepted values, full defaults, precedence, validation, migration, and persistence details in one authoritative package-owned reference, following [Extension settings conventions](extension-settings.md).
A small reference may stay in the README; a large one should be linked with access instructions rather than copied into it.
Do not repeat the same fields in a menu inventory, a defaults dump, and a reference table.

## Verification

For every README change:

1. Review the documented interfaces against the package implementation and tests.
2. Run a fenced-code-aware heading audit over `packages/*/README.md`.
3. Confirm every active package has Features, Install, Quick start, Package layout, Keywords, and License.
4. Confirm standard labels and emojis are used where applicable.
5. Review section scope and duplication: keep one detailed explanation per topic and justify repeated examples or warnings by their local purpose.
6. Confirm Commands remains a syntax-and-outcome reference, and that moved interface, compatibility, and safety details remain accessible through working links.
7. Confirm installation and enablement warnings remain in the README, and linked skills or guidance are available to installed-package users.
8. Run `npm run check`.
9. Run `npm test`.

Run a package dry-run pack when package metadata or published contents change.
Run the package build and local Pi loading smoke when extension runtime loading changes.
Documentation-only section organization does not require either smoke and does not require a changeset.
