# 🔖 pi-inline — Inline Badges and File Previews for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-inline)](https://www.npmjs.com/package/@narumitw/pi-inline) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Style badges and preview local file citations in Pi's terminal transcript without changing stored messages.
`pi-inline` is inspired by [pi-emphasis](https://github.com/johnlindquist/pi-emphasis).

## ✨ Features

- Display decorative badges, linked badges, and local Markdown links in user and assistant messages.
- Hover over a file link in fullscreen mode to preview an image, a text file, or a range of source lines.
- Turn on filename lookup for wikilinks in the current session.

## 📦 Install

Pi extensions run with your user permissions. Load only code you trust.

`@narumitw/pi-inline` is not yet published to npm. From the repository root,
install dependencies and try it without a build:

```bash
npm install
pi -e ./packages/pi-inline
```

To keep this checkout installed:

```bash
pi install ./packages/pi-inline
```

After the first npm release, install or try it with:

```bash
pi install npm:@narumitw/pi-inline
pi -e npm:@narumitw/pi-inline
```

### Migrate from pi-inline-markup

`pi update` does not switch to the new npm name. After the first release, run
`pi remove npm:@narumitw/pi-inline-markup` in the original scope, then run
`pi install npm:@narumitw/pi-inline` in that same scope. Add `-l` to both commands for a
project install.

If you load the old checkout path, replace it with `./packages/pi-inline`.
Remove any explicit entry for the former `.pi/extensions/pi-inline-markup/`
extension. Do not load both copies. The `/inline-markup` command is unchanged.

## 🚀 Quick start

Start Pi in a directory with a `README.md` file. Send a message containing
`[README](./README.md)` to see a file icon next to the label. In fullscreen mode,
hover over the link to preview the file. If Pi detects Kitty graphics support,
hover over an image link such as `[Cat Photo](./cat.png)` to see the image.

## 💬 Commands

Run `/inline-markup` with no arguments in the terminal UI. Select **On** or **Off**
to toggle wikilinks immediately, or press Escape to leave the value unchanged.
Wikilinks start off in each new session and after `/reload`. Turning them off
stops file indexing and closes any open preview.

## 🔗 Link and badge syntax

```markdown
[[README]]
[[[README](./README.md)]]
[[[README]]](./README.md)
[`runTests()`](./scripts/run-tests.mjs#L12-L20)
```

- `[[label]]` is decorative unless you enable wikilinks. With wikilinks off, the
  badge does not look up, open, or preview a file.
- The two linked badge forms are equivalent. Both use standard local Markdown
  destinations and support hover previews whether or not wikilinks are enabled.
- Ordinary Markdown links use a file icon (📄). Use a plain-text or inline-code
  label and a path relative to Pi's working directory or an absolute path within
  it. Hidden paths work too, for example `[CI workflow](./.github/workflows/ci.yml#L1)`.
  Encode spaces as `%20`.
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

## 🔒 Security and privacy

Previews are local. They exclude files outside Pi's working directory,
`node_modules`, and symbolic links. Hovering over an explicit Markdown link
can display a hidden workspace file, including dotfiles that may contain secrets.
The extension does not add file contents to the model context.

In the terminal UI, the extension adds a fixed system prompt hint about badge
labels and Markdown file citations. The hint uses a placeholder path and contains
no extension name or workspace data. Updating the hint does not rewrite existing
session history.

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

## 📋 First publication

Maintainers must review the regenerated Version PR for `@narumitw/pi-inline`
before merging it and coordinate the merge with the approved first publication.
Do not merge a Version PR that still targets `@narumitw/pi-inline-markup`. Leave
the old npm package and its tags intact. After publication, verify the public
version and npm-source loading, confirm npm Trusted Publishing for later releases,
and update the install status in both READMEs.

## 🗂️ Package layout

- `src/index.ts` forwards the extension factory to Pi. The rest of `src/` owns
  transcript rendering, hover previews, and the wikilink index.
- `test/` covers rendering, session cleanup, file boundaries, and workspace lookups.

The package ships its TypeScript source and needs no build step.

## 🔎 Keywords

Pi extension, terminal Markdown, inline badges, wikilinks, file citations, hover previews.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
