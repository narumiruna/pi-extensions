# @narumitw/pi-inspect

## 0.4.0

### Minor Changes

- 6ffefab: Replace Environment tool cards with a source explorer, searchable tool table, selectable columns and a responsive detail panel. Show nested-call eligibility for codemode without claiming runner availability or MCP ownership.

### Patch Changes

- 1eb53e8: Move Tools, MCP Servers and Skills into the primary navigation beside Context, Session and Cache. Remove the Environment navigation layer while preserving lazy catalog mounting, independent reading state and overlay cleanup on navigation.
- 0341b4d: Use precise Environment tool labels: Namespaces, separate Extensions and Packages categories, and Namespace, Source and Exposure grouping options. Preserve namespace fallback to the registration source.

## 0.3.4

### Patch Changes

- 57cf529: Prebuild the Inspector runtime for faster package startup. Keep browser assets in a separate output directory and preserve source loading for production Git installs.

## 0.3.3

### Patch Changes

- 3dab482: Improve Environment resource cards with bounded width, complete wrapping descriptions, clear status and navigation states, and consistent Copy actions. Preserve the inspector's original typography, spacing, colors, other surfaces, resource data, and disclosure state.

## 0.3.2

### Patch Changes

- 67d99ca: Replace cache trend meters with a fixed 0–100% vertical bar chart, explicit empty and unknown states, text-labeled rate bands, and known epoch separators. Preserve the 32-point limit, accounting formulas, and keyboard and pointer access to Event details.

## 0.3.1

### Patch Changes

- 1f1c293: Update React to 19.3.1, Langfuse to 6.0, and the TypeSafe SDK to 0.7 in their respective packages. Preserve trace-only input and output updates, metadata encoding, and root observation detection with Langfuse 6. Accept unreported TypeSafe token usage without rejecting valid answers.

## 0.3.0

### Minor Changes

- c3c65e8: Add a read-only Cache tab with active-branch usage history, weighted hit rates, conversational comparisons, and estimated costs. Keep unknown accounting explicit and include persisted warming and summary usage without changing model input.
- 1be48cb: Add Environment with Tools, MCP Servers and Skills tabs beside Context and Session. Move Session filters inline and keep Event details controls inside Session. Show bounded public resource metadata with explicit unavailable states for MCP health, server ownership and skill content.

## 0.2.2

### Patch Changes

- c0d362f: Update the Radix collapsible runtime dependency to the latest patch release.

## 0.2.1

### Patch Changes

- 617069f: Show searchable structured tool documentation in Details → Tools, including expandable parameter schemas, constraints, documented returns, and original captured JSON access. Recognize Pi's Codemode return syntax, preserve declared types, and show conservative requiredness for composed schemas.

## 0.2.0

### Minor Changes

- a2157ba: Add an independently installable, consent-gated session inspector with a read-only browser viewer, historical context projections and bounded live tool-call observation.
- c9c59c8: Separate model Context from Session history, add branch-scoped conversation groups and explicit branch previews, and show content-first Details with independently navigable captured executions. Preserve historical evidence and move current runtime inventories out of event details.
