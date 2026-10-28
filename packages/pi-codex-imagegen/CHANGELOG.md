# @narumitw/pi-codex-imagegen

## 0.2.0

### Minor Changes

- 5e7658f: Enable the `codex_imagegen` model tool by default. Existing `toolEnabled: false` overrides remain disabled, and invalid or unreadable settings keep tool access disabled. Disable model access through `/codex-imagegen` Settings or the user settings file; manual generation remains available.

### Patch Changes

- 33ace2b: Remove the experimental classification from package metadata, tool and command descriptions, menus, and documentation. The request contract is confirmed against OpenAI Codex source. Keep internal-endpoint, account-access, quota, and live-verification limits unchanged.
- Updated dependencies [a21d39b]
- Updated dependencies [f68aa54]
- Updated dependencies [b062d21]
  - @narumitw/pi-tui-kit@0.68.0

## 0.1.1

### Patch Changes

- Updated dependencies [57eeae7]
  - @narumitw/pi-tui-kit@0.67.0

## 0.1.0

### Minor Changes

- 393c25e: Add experimental image generation through the Codex image endpoint with an `/codex-imagegen` menu, user settings, and an opt-in model tool. No Codex agent or plugins are started.
- afa50bc: Require an exact `path` for image generation and remove the output-directory setting. Use Pi-native path resolution, overwrite existing files, follow symlinks, and request a destination in the manual menu without adding extensions or generating filenames.
