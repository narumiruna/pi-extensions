## Goal

Add a small `@narumitw/pi-wait-what` Pi extension package that lets the user type `/wait-what` when the agent's behavior is surprising, then steers the main conversation so the agent pauses, explains what it was doing, and waits for user confirmation before continuing.

Success means the package is npm-ready, follows this monorepo's extension conventions, and passes the repository verification gates.

## Context

The agreed v0 design is intentionally simple:

- Register `/wait-what`.
- Allow an optional concern/question argument; naked `/wait-what` is valid.
- Write the intervention into the main conversation, not a side UI.
- Use `pi.sendUserMessage()` with `deliverAs: "steer"` while the agent is active; send normally while idle.
- Do not force-abort running tools and do not hard-block future tool calls.
- Ask the agent to answer in the current conversation language, not call tools in the explanation response, use a fixed checklist, and wait for confirmation.

## Architecture

`pi-wait-what` should be a standalone workspace package under `extensions/pi-wait-what/`. Its extension source should be a single TypeScript file that registers the slash command and builds the steering prompt. No persistent state, custom tools, custom UI, background events, or package-to-package dependencies are needed for v0.

## Non-Goals

- Do not implement automatic suspicious-action detection.
- Do not add keyboard shortcuts.
- Do not add `/wait-what resume` or paused-state management.
- Do not create side-channel answer UI like `pi-btw`.
- Do not abort currently running tools or block tool calls at the extension layer.

## Assumptions

- `deliverAs: "steer"` is sufficient for v0 even though it waits until any already-running tool batch finishes before the next model turn.
- New extension work should prefer `@earendil-works/*` Pi packages instead of deprecated `@mariozechner/*` packages.
- The repository's package version stays aligned with the current monorepo version unless a separate release task changes it.

## Plan

- [x] Create `extensions/pi-wait-what/` package metadata (`package.json`, `tsconfig.json`, `LICENSE`) matching active workspace package conventions and using `@earendil-works/pi-coding-agent` as the Pi API dev dependency; verified with `node -p "require('./extensions/pi-wait-what/package.json').name"` returning `@narumitw/pi-wait-what`.
- [x] Implement `extensions/pi-wait-what/src/wait-what.ts` to register `/wait-what`, accept optional arguments, build the agreed fixed-checklist prompt, send it with `pi.sendUserMessage(prompt)` when idle, and send it with `pi.sendUserMessage(prompt, { deliverAs: "steer" })` when busy; verified by source review, direct Node command smoke test, and `npm --workspace @narumitw/pi-wait-what run typecheck`.
- [x] Add `extensions/pi-wait-what/README.md` following the repository README style with badges, features, install/try commands, usage examples for naked and argument forms, limitations, package layout, keywords, and license; verified by reading `extensions/pi-wait-what/README.md`.
- [x] Update root workspace affordances for the new package by adding `pack:wait-what` to `package.json` scripts and `pack-wait-what`, `try-wait-what`, `install-wait-what`, and `publish-wait-what` recipes to `justfile`; verified with `npm run pack:wait-what` and `just pack-wait-what` dry runs.
- [x] Refresh dependency metadata if required by npm workspaces so `package-lock.json` includes the new workspace package; verified with `npm install --package-lock-only` and `git diff -- package-lock.json` showing `extensions/pi-wait-what` plus the workspace link.
- [x] Run formatting and repository checks; verified with `npm run check` from the repository root.
- [x] Preview the npm package contents; verified with `just pack-wait-what`, which reported only `LICENSE`, `README.md`, `package.json`, and `src/wait-what.ts` in the tarball.
- [x] Not applicable: skipped interactive `just try-wait-what` because it opens Pi TUI; command behavior was verified non-interactively with a direct Node smoke test that registered `/wait-what` and asserted idle vs busy `sendUserMessage` delivery.

## Risks

- A model may ignore the prompt-only instruction and call tools anyway; v0 accepts this tradeoff to stay simple.
- `deliverAs: "steer"` cannot interrupt an already-running tool call; README should document this limitation.
- If package metadata uses deprecated Pi package names, future installs may inherit deprecation warnings; prefer `@earendil-works/*` for new work.

## Completion Checklist

- [x] `@narumitw/pi-wait-what` package exists under `extensions/pi-wait-what/` with npm-ready metadata verified by `npm --workspace @narumitw/pi-wait-what run typecheck`.
- [x] `/wait-what` sends the agreed main-conversation prompt, with optional concern handling, verified by source review and the direct Node command smoke test output `wait-what command smoke test passed`.
- [x] Root scripts and `justfile` include wait-what pack/try/install/publish commands verified by `npm run pack:wait-what` and `just pack-wait-what`.
- [x] README documents usage, examples, and steer-only limitations verified by reading `extensions/pi-wait-what/README.md`.
- [x] Repository checks pass, verified by `npm run check`.
- [x] Package dry-run contents are correct, verified by `just pack-wait-what` output showing four files: `LICENSE`, `README.md`, `package.json`, and `src/wait-what.ts`.
