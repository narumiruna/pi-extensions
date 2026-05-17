# pi-lsp parity checklist

`@narumitw/pi-lsp` keeps the public tool Interface from the now-deprecated `@narumitw/pi-biome-lsp` and `@narumitw/pi-python-lsp` packages while moving common LSP behavior into a shared runner Module.

## Tool names and parameters

- [x] `biome_lsp_diagnostics`: `paths?`, `root?`, `limit?`.
- [x] `biome_lsp_format`: `path`, `root?`, `write?`.
- [x] `biome_lsp_fix`: `path`, `root?`, `kind?`, `write?`; default kind `source.fixAll.biome`.
- [x] `ty_lsp_diagnostics`: `paths?`, `root?`, `limit?`.
- [x] `ruff_lsp_diagnostics`: `paths?`, `root?`, `limit?`.
- [x] `ruff_lsp_format`: `path`, `root?`, `write?`.
- [x] `ruff_lsp_fix`: `path`, `root?`, `kind?`, `write?`; default kind `source.fixAll.ruff`.

## Server commands and environment variables

- [x] Biome defaults to `biome lsp-proxy`, supports `PI_BIOME_LSP_COMMAND`, and uses `PI_BIOME_LSP_TIMEOUT_MS`.
- [x] ty defaults to `ty server`, supports `PI_TY_LSP_COMMAND`, and uses `PI_TY_LSP_TIMEOUT_MS`.
- [x] Ruff defaults to `ruff server`, supports `PI_RUFF_LSP_COMMAND`, and uses `PI_RUFF_LSP_TIMEOUT_MS`.
- [x] Command splitting preserves the old quoted-command support but intentionally preserves normal backslashes so Windows command paths such as `C:\\Tools\\ruff.exe` remain valid.
- [x] Command probing validates runnable files, rejects directories/non-executable POSIX files, and resolves relative command paths against the LSP workspace root used as the server `cwd`.

## File discovery

- [x] Biome file extensions match `pi-biome-lsp`: `.astro`, `.css`, `.cts`, `.cjs`, `.graphql`, `.gql`, `.html`, `.js`, `.json`, `.jsonc`, `.jsx`, `.mjs`, `.mts`, `.svelte`, `.ts`, `.tsx`, `.vue`.
- [x] Biome skips `.git`, `.hg`, `.next`, `.nuxt`, `.output`, `.svelte-kit`, `coverage`, `dist`, `node_modules`, and `out`.
- [x] Python files match `pi-python-lsp`: `.py` and `.pyi`.
- [x] Python skips `.git`, `.hg`, `.mypy_cache`, `.ruff_cache`, `.tox`, `.venv`, `__pycache__`, `node_modules`, and `venv`.

## LSP behavior

- [x] Shared runner owns JSON-RPC framing, subprocess lifecycle, initialize/shutdown, file open/close, diagnostics, formatting, code actions, action resolution, and workspace edit application.
- [x] Biome Adapter keeps dynamic registration capabilities, publish-diagnostics fallback, workspace-folder request handling, tab size 2, and tabs.
- [x] ty Adapter keeps diagnostic requests without code actions, tab size 4, and spaces.
- [x] Ruff Adapter keeps diagnostic requests, code actions, tab size 4, and spaces.

## Result shapes and messages

- [x] Tool results still return `{ content: [{ type: "text", text }], details }`.
- [x] Diagnostics details include `root`, `command`, `files`, and `summary`.
- [x] Format/fix details include `path`, `uri`, `changed`, `write`, `edits`, and preview `text` when `write` is false.
- [x] Fix details include `kind` and resolved `actions`.
- [x] Missing-command errors preserve server-specific install guidance.

## Documentation and compatibility

- [x] `extensions/pi-lsp/README.md` documents tool-name compatibility, environment variables, and the deprecated status for the old packages.
- [x] Root `README.md`, `package.json`, and `justfile` include `pi-lsp` integration.
- [x] `pi-biome-lsp` and `pi-python-lsp` now live under `extensions/deprecated/` and are excluded from active workspace scripts.
