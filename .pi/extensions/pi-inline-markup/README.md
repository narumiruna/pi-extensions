# Pi Inline Markup

This project-local Pi extension styles badges and local Markdown links without
rewriting chat messages. In TUI sessions, it adds one fixed system prompt hint
about the syntax. The hint does not include file contents.

```markdown
[[README]]
[[[README](./README.md)]]
[[[README]]](./README.md)
[`runTests()`](./scripts/run-tests.mjs#L12-L20)
```

- `[[label]]` is a decorative badge. It never looks up, opens, or previews a
  file, even if the label matches a filename. Use one of the linked forms to
  replace a former wikilink.
- `[[[label](./file.md)]]` and `[[[label]]](./file.md)` are the same linked badge.
  Both use a standard local Markdown link as the destination and show the same
  hover preview as `[label](./file.md)`. Rounded badges require a terminal font
  with the Powerline glyphs.
- Ordinary local Markdown links use a file emoji (📄). Use a plain-text or
  inline-code label and a path relative to Pi's working directory or an absolute
  path inside it. Encode spaces as `%20`.
- Add `#L12` for one source line or `#L12-L20` for an inclusive range. Hover also
  accepts `#L12-20`. A line-anchored preview shows literal source. The first
  requested line must start within the first 256 KiB of the file.

Hover previews are available in fullscreen mode and show up to 16 KiB of a
regular UTF-8 file as Markdown or plain text. They exclude paths outside the
working directory, hidden paths, `node_modules`, and symbolic links. Previews
need OSC 8 hyperlinks and mouse movement reports without a button press. Pi does
not request these reports in tmux, Zellij, or GNU Screen.

Pi discovers `index.ts` in a trusted checkout. If an explicit `-e` or settings
entry refers to the old `filelinks` or `wikilinks` path, update it or remove it.
Run `/reload` in Pi to apply the change.

## Test

Run the focused tests from the checkout root:

```bash
npm exec --offline -- vitest run --root .pi/extensions/pi-inline-markup
```
