## Goal

Make `rust-analyzer` and `gopls` built-in pi-lsp defaults so unconfigured Rust and Go workspaces route `.rs` and `.go` files to the official language servers with standard LSP language IDs.

## Context

pi-lsp currently defaults to Biome, ty, and Ruff. User or project configuration will continue to replace the default server map rather than merge with it, and pi-lsp will continue to require each external server binary on `PATH`.

## Assumptions

- Rust support uses the official `rust-analyzer` command for `.rs` files.
- Go support uses the official `gopls` command for `.go` files.
- No server-specific initialization settings are required for baseline diagnostics and source actions.

## Plan

- [x] Add an executable specification in `extensions/pi-lsp/test/lsp.test.ts` for the Rust and Go default routes, commands, extensions, and language IDs; the focused compiled test failed on the missing `rust-analyzer` adapter via `node --test "$(realpath node_modules/.cache/pi-extensions-test/extensions/pi-lsp/test/lsp.test.js)"`.
- [x] Add `rust-analyzer` and `gopls` to `DEFAULT_SERVER_CONFIGS` and map `.rs` to the standard `rust` language ID in `extensions/pi-lsp/src/adapters.ts`; the focused compiled pi-lsp test passes (7/7).
- [x] Update `extensions/pi-lsp/README.md` and the root `README.md` to describe Rust/Go default support and installation prerequisites; `npm run check` passed (597 passed, 1 skipped) and `npm run pack:lsp` showed the expected 12 package files.

## Risks

- An incorrect Rust language ID could start the server but degrade diagnostics; the test must assert `rust`, not the extension-derived fallback `rs`.
- Adding defaults means unconfigured scans consider more file types, but servers remain lazily started only when matching files exist.

## Completion Checklist

- [x] Default runtime behavior is verified by the focused compiled pi-lsp test (7/7), including `rust-analyzer`, `gopls`, `.rs`/`.go`, and `rust`/`go` language IDs.
- [x] User-facing documentation identifies the two new defaults and their official installation commands in `extensions/pi-lsp/README.md`, with root-package discovery text updated in `README.md`.
- [x] Repository checks pass with `npm run check` (597 passed, 1 skipped).
- [x] Published package contents remain correct as verified by `npm run pack:lsp` (12 expected files, including `src`, `README.md`, `LICENSE`, and `package.json`).
