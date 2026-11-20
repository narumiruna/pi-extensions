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

- With wikilinks off (the default), `[[label]]` is a decorative badge. It does
  not look up, open, or preview a file, even if the label matches a filename.
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

## Wikilinks

In Pi's terminal UI, run `/inline-markup` with no arguments and select **On**
or **Off**. Escape leaves the current value unchanged. The change takes effect
immediately and lasts for the current session only. A new session or
`/reload` starts with wikilinks off.

When enabled, `[[README]]` looks up files relative to the checkout, and
`[[README.md|Guide]]` supplies a custom label. Use `[[./README.md]]` for an
exact path. A bare filename that matches several Markdown files previews up
to three of them in one card. Click it to open the checkout-root match, or the
only match if the filename is unique. With multiple matches and no root file,
the badge previews files but is not clickable. Unresolved names stay
non-clickable. The index starts on first use and refreshes five seconds after
each scan. Turning wikilinks off stops the index and closes any preview.

Ordinary Markdown links and both linked badge forms work in either mode.
The system prompt keeps recommending Markdown links and does not change when
you toggle wikilinks.

Pi discovers `index.ts` in a trusted checkout. If you load the extension
explicitly with `-e` or a settings entry, point it at `index.ts`.

## Test

Run the focused tests from the checkout root:

```bash
npm exec --offline -- vitest run --root .pi/extensions/pi-inline-markup
```
