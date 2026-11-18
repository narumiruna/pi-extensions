# /// script
# requires-python = ">=3.10"
# dependencies = ["markdown-it-py==4.3.0"]
# ///

"""Check that each npm workspace has a README with the required sections."""

import pathlib
import sys

import markdown_it

# Keep these labels in sync with docs/readme-conventions.md.
REQUIRED_HEADINGS = (
    "✨ Features",
    "📦 Install",
    "🚀 Quick start",
    "🗂️ Package layout",
    "🔎 Keywords",
    "📄 License",
)


def readme_errors(
    readme: pathlib.Path, parser: markdown_it.MarkdownIt
) -> list[str]:
    """Return the missing-file, read, or heading errors for one README."""
    if not readme.is_file():
        return ["Missing README.md file"]
    try:
        markdown = readme.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        return [f"Cannot read README.md: {error}"]

    tokens = parser.parse(markdown)
    headings = {
        tokens[index + 1].content
        for index, token in enumerate(tokens)
        if token.type == "heading_open"
        and token.markup == "##"
        and token.level == 0
    }
    return [
        f"Missing required heading: ## {heading}"
        for heading in REQUIRED_HEADINGS
        if heading not in headings
    ]


def main() -> int:
    """Check all package READMEs and report every failure."""
    root = pathlib.Path(__file__).resolve().parents[1]
    manifests = [
        path
        for path in sorted(root.glob("packages/*/package.json"))
        if path.is_file()
    ]
    parser = markdown_it.MarkdownIt("commonmark")
    failed = False
    for manifest in manifests:
        readme = manifest.with_name("README.md")
        location = readme.relative_to(root).as_posix()
        for error in readme_errors(readme, parser):
            print(f"{location}: {error}", file=sys.stderr)
            failed = True
    if failed:
        return 1
    print(f"Checked {len(manifests)} package READMEs.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
