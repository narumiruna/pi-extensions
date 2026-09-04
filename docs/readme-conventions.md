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
Do not remove supported behavior, compatibility guidance, or safety details merely to shorten a README.

## Content rules

Write user-facing prose in English.
Group narrative text into concise Markdown paragraphs, keeping related source lines together without blank lines between every sentence.
Use lists when independent items, choices, steps, or references are easier to scan separately.
Keep the introduction and Features section concise enough to scan before installation.
Document only commands, tools, settings, modes, and guarantees implemented by the package.
Treat model IDs, paths, session text, and pasted text shown in examples as untrusted terminal input where relevant.
Use stable absolute GitHub and npm links when referring to another package in this monorepo.
Describe borrowed syntax as inspired by another project unless compatibility is guaranteed.

Keep Settings sections focused on the configuration entry points, a minimal example, and essential default or safety behavior.
Detailed configuration guidance may live in package-owned documentation or a package-owned skill bundled with the package.
When it does, the README must identify that source and explain how to access it instead of duplicating the complete configuration reference.

Installation instructions must state that extensions run with Pi's permissions when that warning is material to the package's install flow.
Build-backed packages must explain that an unbuilt local checkout needs its build before package-directory loading.
Keep security, privacy, and other information that users must understand before installing or enabling the package in the README.
Document additional precedence, persistence, failure, cancellation, recovery, or lifecycle behavior in the README or its linked package-owned guidance when users need it for safe operation.

## Verification

For every README change:

1. Review the documented interfaces against the package implementation and tests.
2. Run a fenced-code-aware heading audit over `packages/*/README.md`.
3. Confirm every active package has Features, Install, Quick start, Package layout, Keywords, and License.
4. Confirm standard labels and emojis are used where applicable.
5. Run `npm run check`.
6. Run `npm test`.

Run a package dry-run pack when package metadata or published contents change.
Run the package build and local Pi loading smoke when extension runtime loading changes.
Documentation-only section organization does not require either smoke and does not require a changeset.
