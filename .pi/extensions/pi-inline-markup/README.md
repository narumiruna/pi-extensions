# Pi Inline Markup

This project-local Pi extension styles local file links in user and assistant
messages. It does not change saved messages or model input.

```markdown
[Project manifest](./package.json)
[`runTests()`](./scripts/run-tests.mjs#L12-L20)
[[README.md]]
[[README.md|Project guide]]
```

- Markdown file links use a file emoji (📄) and the theme's link color. Use a
  plain-text or inline-code label and a path relative to Pi's working directory,
  or an absolute path inside it. Encode spaces as `%20`.
- Add `#L12` for one source line or `#L12-L20` for an inclusive range.
  Hover also accepts `#L12-20`. The card shows literal source, even for Markdown
  files, and looks for the first requested line within the first 256 KiB.
  If that line is not available, no card appears.
- Wikilinks use colored chips with rounded ends in every terminal. The terminal
  or its font must support the round Powerline glyphs to display them correctly.
  Paths are relative to the checkout. You can omit `.md`; a bare filename also
  matches a file in a subdirectory if the name is unique. The file index starts
  on first use and refreshes every five seconds after each scan. Unresolved
  wikilinks are not clickable.

Hover over a bare wikilink such as `[[README.md]]` to see up to three short
excerpts stacked in one card. Each excerpt shows its checkout-relative path.
The root file appears first when present, followed by other matches in path
order. The card counts any matches it cannot show. Clicking the chip still
opens the root file if present; if there are multiple matches and no root file,
the chip offers a preview but does not open a file. Use `[[./README.md]]` or
`[[packages/pi-lsp/README.md]]` to preview only that file.

Hover previews are available in fullscreen mode and read up to 16 KiB per
regular UTF-8 file. Markdown file links show Markdown or plain text. Wikilinks preview
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
