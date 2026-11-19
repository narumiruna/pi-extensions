# Pi Inline Markup

This project-local Pi extension styles local file links in user and assistant
messages. It does not change saved messages or model input.

```markdown
[Project manifest](./package.json)
[[README.md]]
[[README.md|Project guide]]
```

- Markdown file links use a file emoji (📄) and the theme's link color. Use a
  plain-text label and a path relative to Pi's working directory, or an absolute
  path inside it. Encode spaces as `%20`.
- Wikilinks use colored chips with rounded ends in every terminal. The terminal
  or its font must support the round Powerline glyphs to display them correctly.
  Paths are relative to the checkout. You can omit `.md`; a bare filename also
  matches a unique file in a subdirectory. The file index starts on first use and
  refreshes every five seconds after each scan. Unresolved wikilinks are not
  clickable.

Hover over a link in fullscreen mode to preview up to 16 KiB of a regular UTF-8
file. Markdown file links show Markdown or plain text. Wikilinks preview
Markdown files and omit YAML front matter. Paths outside the applicable root,
hidden paths, `node_modules`, and symbolic links are not read. Previews need OSC 8
hyperlinks and mouse movement reports without a button press. Pi does not request
these reports in tmux, Zellij, or GNU Screen.

Pi discovers `index.ts` in a trusted checkout. If an explicit `-e` or settings
entry refers to the old `filelinks` or `wikilinks` path, update it or remove it.
Run `/reload` in Pi to apply the change.

## Test

Run the focused tests from the checkout root:

```bash
npm exec --offline -- vitest run --root .pi/extensions/pi-inline-markup
```
