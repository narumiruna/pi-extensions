# 🔖 pi-inline — Inline Badges and File Previews for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-inline)](https://www.npmjs.com/package/@narumitw/pi-inline) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Style badges and preview local file citations in Pi's terminal transcript without changing stored messages.
`pi-inline` is inspired by [pi-emphasis](https://github.com/johnlindquist/pi-emphasis).

## ✨ Features

- Display decorative badges, linked badges, and local Markdown links in user and assistant messages.
- Hover over a file link in fullscreen mode to preview a workspace image or text file, or text in an approved external directory.
- Turn on filename lookup for wikilinks in the current session.
- Edit or turn off the system prompt hint for badges and file citations.

## 📦 Install

Pi extensions run with your user permissions. Load only code you trust.

Install from npm or try it for one Pi session:

```bash
pi install npm:@narumitw/pi-inline
pi -e npm:@narumitw/pi-inline
```

For a local checkout, install dependencies from the repository root and try the
extension without a build:

```bash
npm install
pi -e ./packages/pi-inline
```

To keep this checkout installed, run `pi install ./packages/pi-inline`.

### Migrate from pi-inline-markup

`pi update` does not switch to the new npm name. Run
`pi remove npm:@narumitw/pi-inline-markup` in the original scope, then run
`pi install npm:@narumitw/pi-inline` in the same scope. Add `-l` to both commands
for a project install.

If you load the old checkout path, replace it with `./packages/pi-inline`.
Remove any explicit entry for the former `.pi/extensions/pi-inline-markup/`
extension. Do not load both copies. Use `/inline` to open the settings menu.
`/inline-markup` still opens the same menu.

## 🚀 Quick start

Start Pi in a directory with a `README.md` file. Send a message containing
`[README](./README.md)` to see a file icon next to the label. In fullscreen mode,
hover over the link to preview the file. If Pi detects Kitty graphics support,
hover over an image link such as `[Cat Photo](./cat.png)` to see the image.

## 💬 Commands

Run `/inline` with no arguments in the terminal UI. `/inline-markup` is a
compatibility alias.

- **Wikilinks** changes filename lookup immediately for the current session.
  It starts Off in each new session and after `/reload`. Turning it Off stops
  file indexing and closes any open preview.
- **Prompt Hint** turns system prompt guidance On or Off. Turning it Off keeps
  the saved text.
- **Edit Prompt Hint…** opens a multiline editor with the saved text, even if
  the hint is Off.

After a prompt hint change is saved, Pi asks whether to reload. Choose No to
keep the saved change without applying it to the current session. Apply it later
with `/reload` or by starting another session. Cancelling an edit or submitting
an unchanged value does not save or ask for reload.

## 🔗 Link and badge syntax

```markdown
[[README]]
[[[README](./README.md)]]
[[[README]]](./README.md)
[`runTests()`](./scripts/run-tests.mjs#L12-L20)
[rename plan](/home/alex/.agents/plans/rename%20plan.md#L2-L5)
```

- `[[label]]` is decorative unless you enable wikilinks. With wikilinks off, the
  badge does not look up, open, or preview a file.
- The two linked badge forms are equivalent. Both use standard local Markdown
  destinations and support hover previews whether or not wikilinks are enabled.
- Ordinary Markdown file links use an image icon (🖼️) for PNG, JPEG, GIF, and
  WebP paths and a file icon (📄) for other paths. Use a plain-text or inline-code
  label with an absolute path or a path relative to Pi's working directory.
  Paths can point outside that directory, including with `../`. Encode spaces
  as `%20`. The icon does not indicate that a file exists or has a preview.
- Use `#L12` for one source line or `#L12-L20` for an inclusive range. Hover also
  accepts `#L12-20`. These previews show literal source rather than rendered Markdown.

When wikilinks are on, `[[README]]` looks up files under Pi's working directory,
`[[README.md|Guide]]` sets a custom label, and `[[./README.md]]` selects an exact
path. If a bare filename matches several Markdown files, the badge previews up
to three. Clicking opens the file at the working directory root if present, or
the only match if the filename is unique. If there is no root match and several
files match, the badge previews files but is not clickable. Unresolved names
also stay non-clickable. The index skips hidden paths, starts on first lookup,
and refreshes five seconds after each scan.

## ⚙️ Settings

Both settings groups use `pi-inline.json` in Pi's agent directory (by default
`~/.pi/agent/`). Project settings are ignored. Use a regular file, not a
symbolic link. If its content is invalid, repair it before saving through the
menu. Settings writes are ordered within one Pi process, not between processes.

### Prompt hint

`promptHintEnabled` accepts a boolean and defaults to `true`. `promptHintText`
accepts a non-blank string, including multiple lines. Line endings are saved as
LF. Do not include terminal or bidirectional controls. Remove both keys and
reload to restore the default:

```text
Use [[label]] for badges.
Use Markdown links with workspace-relative paths for file citations, for example [file](./path/to/file#L12-L20).
```

### External text previews

To allow external text previews, set `externalPreviewRoots`:

```json
{
  "externalPreviewRoots": ["/home/alex/.agents/plans"]
}
```

A conversation link can trigger a file read inside an approved directory when
you hover over it. Approve only narrow directories you control, not shared
directories. Use existing absolute directories without symbolic links. Do not
use globs, a filesystem root, your home directory, or a directory that contains
your home directory.

The default is `[]`. Invalid roots or an unreadable file leave external
previews off. Changes take effect on session start or `/reload`. To revoke
access, remove the field or set it to `[]`, then run `/reload`. Link icons do not
depend on this setting.

## 🔒 Security and privacy

Hover can show hidden files, including files that contain secrets. Previews
exclude `node_modules` and symbolic links. External previews are text-only.
External PNG, JPEG, GIF, and WebP links can be opened but never start an image
preview. The extension does not add preview contents to model context or
stored messages.

In the terminal UI, Pi sends the enabled prompt hint to the model provider and
can retain it in session history. Do not put secrets in the hint. Editing or
turning it off does not remove text from earlier requests or stored history.

## 🚧 Limitations

- Rounded badges require a font with Powerline glyphs.
- Hover previews require fullscreen mode, OSC 8 hyperlinks, and mouse movement
  reports without a button press. Pi does not request these reports in tmux,
  Zellij, or GNU Screen.
- Text previews show up to 16 KiB of a regular UTF-8 file. For a line-anchored
  preview, the first requested line must start within the first 256 KiB.
- Image previews require Kitty graphics and display a static PNG, JPEG, GIF, or
  WebP image. The preview keeps the original pixel dimensions when the image fits
  above or below its link. Otherwise, it scales down without changing the aspect
  ratio. The extension has no fixed source size limit, but the image decoder
  and available memory still set practical limits. If a preview is unavailable,
  you can still open the link.

## 🗂️ Package layout

- `src/index.ts` forwards the extension factory to Pi. The rest of `src/` owns
  settings, transcript rendering, hover previews, and the wikilink index.
- `test/` covers settings, rendering, session cleanup, and preview boundaries.

The package ships its TypeScript source and needs no build step.

## 🔎 Keywords

Pi extension, terminal Markdown, inline badges, wikilinks, file citations, hover previews.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
