# Documentation site

The site uses [Zensical](https://zensical.org/) and was initialized with `uvx zensical new`.
Run all commands from the repository root with the Node.js version in [`.node-version`](../.node-version), Git, and [uv](https://docs.astral.sh/uv/getting-started/installation/) installed.
The documentation workflow needs no npm dependencies or project Python environment; `uvx` provides Zensical in an isolated tool environment.

## Preview and build

Start a local preview:

```bash
npm run docs:serve
```

Open the local URL printed by Zensical, normally `http://localhost:8000/`.
Changes under existing documentation directories are staged automatically and trigger Zensical's live reload.
Restart the preview after adding a new package documentation directory or changing Git ignore rules.
Use Ctrl+C to stop the preview and its file watchers.

Build the static site with link and anchor validation:

```bash
npm run docs:build
```

The build fails on warnings. To discard Zensical's build cache, run `npm run docs:build -- --clean`.
Generated source is under `.zensical-docs/`; the static site is under `site/`.
Staging stays outside `.cache/` because Zensical clears that directory during `--clean`.
Both paths are ignored by Git. Do not edit generated files.
The site uses file-style `.html` URLs so a page such as `providers.md` can coexist with the `providers/README.md` directory index.
CI runs the same build without deploying it. Hosting and GitHub Pages setup are separate operations.

## Content ownership and links

Edit repository guidance under `docs/` and package guidance under `packages/<package>/docs/`.
Keep installation, first use, and essential warnings in the owning package README.
Keep one authoritative explanation per topic and link to it instead of duplicating content.

[`scripts/docs.mjs`](../scripts/docs.mjs) stages only the two documentation scopes, including their supporting assets, and honors Git ignores.
It preserves repository-relative paths, except that `docs/index.md` becomes the site homepage.
Links between staged documents remain inside the site. Relative links to package READMEs, source, tests, skills, and other repository files point to GitHub's `main` branch instead.
Fenced examples and inline code are not rewritten. Missing repository link targets fail preparation before Zensical runs.
Documentation assets must be regular files, not symbolic links.

Use relative Markdown links with explicit filenames for local documents, including directory indexes such as `providers/README.md`.
Keep link destinations on one line. Use ordinary inline links or reference definitions; do not use raw HTML for repository links.
The configured heading slug function preserves the existing GitHub-style emoji fragments. Verify changed fragments with the site build.

## Navigation and document status

Add new pages to [`zensical.toml`](../zensical.toml) and link them from the relevant index or owning package README.
Use these sections:

- **Packages:** package guides, settings, protocols, and package-owned developer evidence.
- **Authoring:** conventions and reusable extension-development contracts.
- **Maintenance:** dependency, testing, release, and publication workflows.
- **Design and evidence:** architecture decisions, audits, verification, benchmarks, research, and roadmaps.

Update the [package index](packages.md) or [design and evidence index](design-and-evidence.md) when adding topics there.
Keep compatibility pages at their existing paths, but navigate directly to the current reference where possible.
Label proposals and historical evidence clearly, retain original verification context, and do not present old checks as current release acceptance.

After changing the staging workflow or navigation, run `npm run docs:build`, `npm run check`, and `npm test`.
