# 🧩 Pi Session Skills

Load one Agent Skill from a Git repository or local path into the current Pi session without installing it into project or global skill directories.

## ✨ Features

- Resolves GitHub shorthand, GitHub and GitLab repository URLs, HTTPS or SSH Git URLs, and local paths.
- Copies the selected skill into an extension-owned cache and activates only its cache path.
- Uses Pi's native skill validation, system-prompt discovery, and `/skill:name` command.
- Restores activation on `/reload`, `/resume`, `/fork`, and restart of the same saved session.
- Keeps cache content separate from session activation and supports explicit refresh.
- Has no runtime dependency on external skill manager CLIs or another extension.

## 🚀 Quick start

```text
/session-skills load <source>
/session-skills load <source> --skill <name>
/session-skills list
/session-skills unload <name>
```

Loading or unloading calls Pi's reload flow because Pi does not expose a dynamic `registerSkill()` API. The conversation remains in the same saved session, but all extensions and resources are reloaded.

## 💬 Command

### `/session-skills`

With no arguments, show the current session skills and command usage. All actions use this single slash command:

```text
/session-skills load <source> [--skill <name>] [--refresh]
/session-skills list
/session-skills unload <name>
/session-skills unload --all
```

The `load` route activates exactly one skill. A source containing multiple skills requires `--skill`.

```text
/session-skills load owner/repo
/session-skills load owner/repo@<name>
/session-skills load https://github.com/owner/repo/tree/main/path/to/skill
/session-skills load https://gitlab.com/group/repo/-/tree/main/path/to/skill
/session-skills load git@github.com:owner/repo.git --skill <name>
/session-skills load ssh://git@example.com/team/repo.git --skill <name>
/session-skills load ./local-skills --skill <name>
/session-skills load .\\local-skills --skill <name>
```

Use `--refresh` to resolve a fresh cache version. The prior version remains intact until validation and collision checks pass. Without refresh, the command reuses cached content, including for mutable branches and local paths. The `list` route shows active skills with their source and cache path. The `unload` route deactivates skills without deleting cached content.

GitHub shorthand and HTTPS URLs first use normal Git credentials. Authentication failures retry the equivalent SSH URL when one can be derived. Explicit SSH sources use the user's SSH configuration and agent. Git runs non-interactively, and each Git command times out after five minutes. Tree URLs with a 40-character commit hash fetch that commit directly and check it out detached.

## 🔄 Session and cache behavior

Activation is stored as a full snapshot in the current session branch. The desired snapshot is written before Pi reloads so the replacement runtime can discover it. If the broader Pi reload fails, that snapshot is applied by the next successful reload. A saved activation skipped because it is missing, unsafe, or conflicting remains unloadable by name or with `unload --all`. A new session starts empty, while resume and fork follow the snapshot present on their active branch.

Cache content is stored under:

```text
${XDG_CACHE_HOME}/pi/session-skills
```

When `XDG_CACHE_HOME` is unset or relative, Windows uses `LOCALAPPDATA` when available:

```text
%LOCALAPPDATA%\pi\session-skills
```

Other platforms use:

```text
~/.cache/pi/session-skills
```

Temporary clone and copy directories are removed after success, failure, cancellation, or shutdown. Cache entries are published only after Pi validates the copied skill.

## 🔐 Security

Remote skills contain instructions and executable files that can run with the full permissions of the Pi process. Review the source before invoking the loaded skill.

The extension rejects embedded URL credentials, unsafe repository subpaths, invalid skill names, unsupported file types, and symbolic links inside skills. Git credentials remain owned by Git credential helpers or SSH and are not copied into the cache metadata.

Existing project or global skills win name collisions. The extension rejects activation when the selected name is already provided by another active skill path.

## ⚠️ Limitations

- Direct HTTP files, archives, well-known endpoints, and GitHub API downloads are not supported.
- Discovery follows Pi's hidden-directory and `.gitignore`, `.ignore`, and `.fdignore` rules, scans `SKILL.md` directories to a maximum depth of eight, and rejects sources with more than 500 discovered skills.
- GitHub and GitLab tree URLs treat the segment after `tree` as the ref; refs containing `/` are not currently supported.
- Cache publication is serialized within one Pi process; independent Pi processes can still race while refreshing the same source.
- The command supports TUI and RPC modes. Print and JSON modes reject it explicitly.

## 🗂️ Layout

```text
pi-session-skills/
├── index.ts
├── extension.ts
├── command-parser.ts
├── source-parser.ts
├── resolver.ts
├── *.test.ts
├── tsconfig.json
└── vitest.config.ts
```
