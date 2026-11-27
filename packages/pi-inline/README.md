# 🔖 pi-inline — Inline Badges and File Previews for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-inline)](https://www.npmjs.com/package/@narumitw/pi-inline) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Style badges and preview local file citations in Pi's terminal transcript without changing stored messages.
`pi-inline` is inspired by [pi-emphasis](https://github.com/johnlindquist/pi-emphasis).

## ✨ Features

- Display decorative badges, linked badges, and local Markdown links in user and assistant messages.
- Hover over a file link in fullscreen mode to preview local text files, including files outside the workspace, or workspace images.
- Copy a whole code block with the **Copy code** button in fullscreen mode.
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
hover over the link to preview the file. Absolute and relative paths outside the
workspace also work for text previews without any setup. If Pi detects Kitty
graphics support, hover over a workspace image link such as
`[Cat Photo](./cat.png)` to see the image.

In fullscreen mode on a supported Pi version, click **Copy code** below a
fenced block in a user or assistant message. The button is on the left by
default. It copies the source without fences or display wrapping and shows
Pi's `Copied!` message in the upper-right corner.

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
- **Code Block Copy** saves and applies immediately, without a reload.
  **Copy button** (default) adds a filled `Copy code` button below each block.
  Narrow views use `Copy` when the full label does not fit. **Click block**
  hides the button and copies about half a second after a single click, leaving
  double-clicking and dragging to Pi. Moving the pointer alone after release
  does not cancel copying. **Off** leaves Pi's native selection and `/copy`
  command unchanged.
- **Copy Button Position** saves and applies immediately. Choose **Left**
  (default) or **Right**. This only affects **Copy button** mode.

After a prompt hint change is saved, Pi asks whether to reload. Choose No to
keep the saved change without applying it to the current session. Apply it later
with `/reload` or by starting another session. Cancelling an edit or submitting
an unchanged value does not save or ask for reload. While a save is pending,
Escape does not close the menu, but Ctrl+C closes it immediately. If the save
still goes through, Pi tells you to run `/reload`.

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
  as `%20` and `#` in a filename as `%23`. The icon does not indicate that a
  file exists or has a preview.
- **Click:** For a styled local path with a non-empty `#` anchor and no query,
  the extension sends a `file://` URL for the file, without the anchor. It does
  not ask the terminal or editor to jump to a line or heading.
- **Hover:** Use `#L12` for one source line or `#L12-L20` (also `#L12-20`)
  for an inclusive range. These previews show literal source. A Markdown heading
  anchor previews the file without selecting the heading.

When wikilinks are on, `[[README]]` looks up files under Pi's working directory,
`[[README.md|Guide]]` sets a custom label, and `[[./README.md]]` selects an exact
path. If a bare filename matches several Markdown files, the badge previews up
to three. Clicking opens the file at the working directory root if present, or
the only match if the filename is unique. If there is no root match and several
files match, the badge previews files but is not clickable. Unresolved names
also stay non-clickable. The index skips hidden paths, starts on first lookup,
and refreshes five seconds after each scan.

## ⚙️ Settings

User settings use `pi-inline.json` in Pi's agent directory (by default
`~/.pi/agent/`). Project settings are ignored. Use a regular file, not a
symbolic link. If its content is invalid, repair it before saving through the
menu. Settings writes are ordered within one Pi process, not between processes.
Finish saving before editing the file by hand or from another Pi process.
The former `externalPreviewRoots` field is ignored and can be removed.

`codeBlockCopyMode` accepts `"button"` (the default), `"click"`, and `"off"`.
`codeBlockCopyButtonPosition` accepts `"left"` (the default) and `"right"`.
An invalid mode disables block copying. An invalid position uses the default.
Invalid settings block saves until you repair the file. If you edit the file by
hand, reload Pi to apply it.

`promptHintEnabled` accepts a boolean and defaults to `true`. `promptHintText`
accepts a non-blank string, including multiple lines. Line endings are saved as
LF. Do not include terminal or bidirectional controls. Remove both keys and
reload to restore the default:

```text
Use [[label]] for badges.
Use Markdown links with workspace-relative paths for file citations, for example [file](./path/to/file#L12-L20).
```

## 🔒 Security and privacy

Hovering over a local Markdown link can display a file Pi can read, even outside
the workspace. This includes hidden files and files that contain secrets. Avoid
hovering over untrusted links, especially when sharing your screen. Previews
exclude `node_modules` and symbolic links. External PNG, JPEG, GIF, and WebP
links can be opened but not previewed. The extension does not add preview
contents to model context or stored messages.

In the terminal UI, Pi sends the enabled prompt hint to the model provider and
can retain it in session history. Do not put secrets in the hint. Editing or
turning it off does not remove text from earlier requests or stored history.

## 🚧 Limitations

- Rounded badges require a font with Powerline glyphs.
- Click-to-copy requires fullscreen SGR mouse reporting and a Pi version whose
  rendering and selection behavior the extension has verified. On other versions
  or in regular mode, Pi keeps its native behavior and the saved mode is retained.
- Block copying applies to complete, nonempty fenced blocks at the top level of
  user and assistant messages. It does not apply to streaming text, nested
  blocks, tool output, or thinking. If decoration would change the original
  rendering, the extension leaves the message unchanged. The button is omitted
  when there is not enough room.
- Hover previews require fullscreen mode, OSC 8 hyperlinks, and mouse movement
  reports without a button press. Pi does not request these reports in tmux,
  Zellij, or GNU Screen.
- Opening a `file://` link depends on your terminal. If Pi and the terminal
  viewer run on different hosts, the URL can resolve on the wrong host. Do not
  rely on these links to open remote files.
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
