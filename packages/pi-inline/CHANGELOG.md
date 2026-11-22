# @narumitw/pi-inline

## 0.6.1

### Patch Changes

- Updated dependencies [1cbb470]
  - @narumitw/pi-tui-kit@0.71.0

## 0.6.0

### Minor Changes

- 502e95d: Preview local text files outside the workspace by hovering over Markdown links in fullscreen mode. The `externalPreviewRoots` setting is now ignored, including empty lists that previously disabled external previews. External images, symbolic links, and `node_modules` are still excluded. Hover previews stay on screen and are not sent to the model or stored in the session.

## 0.5.0

### Minor Changes

- 41c08ba: Open the settings menu with `/inline`. `/inline-markup` remains a compatibility alias. Turn the system prompt hint on or off, or edit its text. After saving a change, choose whether to reload now or apply it in a later session. The default hint and session-only Wikilinks behavior are unchanged.

## 0.4.0

### Minor Changes

- 2722e8a: Style explicit Markdown file links outside the workspace. Allow bounded text previews in approved directories when users set `externalPreviewRoots` in their user settings. External previews remain off by default.

### Patch Changes

- 913bf63: Show a picture icon on ordinary Markdown file links to PNG, JPEG, GIF, and WebP paths. Other file icons, linked badges, and hover preview rules stay the same.

## 0.3.0

### Minor Changes

- 0501c6c: Rename the package from `@narumitw/pi-inline-markup` to `@narumitw/pi-inline`. The `/inline-markup` command and rendering behavior are unchanged. To migrate, remove the old npm source and install the new one in the same scope (`-l` for project installs). For a local checkout, use `packages/pi-inline` instead. Do not load both copies.

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
