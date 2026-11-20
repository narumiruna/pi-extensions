# @narumitw/pi-inline-markup

## 0.2.0

### Minor Changes

- 20ea0d0: Preview local PNG, JPEG, GIF, and WebP files by hovering over their Markdown links in Pi's fullscreen terminal UI. Image previews require Kitty graphics support and use the same workspace file restrictions as text previews. Previews use the original pixel dimensions and only scale down when the image does not fit in the available terminal space. There is no fixed source file size or pixel count limit. The overlay fits the image so it does not hide unrelated transcript content on the right.

### Patch Changes

- c780a73: Style and preview explicit Markdown file links to hidden workspace paths such as `.github/workflows/ci.yml`. Wikilink lookup still skips hidden paths, and previews still exclude `node_modules`, symbolic links, and files outside the workspace.

## 0.1.1

### Patch Changes

- b4d2c30: Remove the extension name and identifier from the prompt guidance. Keep a generic badge label and a Markdown file citation example. Rendering and wikilink behavior are unchanged.

## 0.1.0

Package the former project-local extension for independent installation. Wikilinks
resolve in Pi's working directory rather than the extension's installation directory.
