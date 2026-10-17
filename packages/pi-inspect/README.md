# 🔎 pi-inspect — Pi session inspector

[![npm version](https://img.shields.io/npm/v/@narumitw/pi-inspect)](https://www.npmjs.com/package/@narumitw/pi-inspect)
[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A read-only browser view of the current Pi session, with consent-gated live context and tool-call observation.

> Opening the viewer exposes session prompts, code, paths, and tool output to your browser. Structured credential fields and Bearer tokens are redacted, but arbitrary secrets in prose cannot be reliably removed. Open the URL privately; do not share it, record it, or load the viewer in an untrusted browser profile. Nothing is uploaded, and detailed traces are kept only in memory after consent.

## ✨ Features

- Explore ordered context messages and blocks with search, filters, a minimap and expandable details.
- Read branch-scoped Session history with conversation groups, direct search matches, and an explicit internal-events view.
- Inspect actual branches, historical prompts, tools, skills and codemode evidence through content-first Event details without changing Pi's active leaf.
- Follow bounded live tool calls, including observed nested calls, with explicit provenance and unavailable-data labels.
- Browse current Tools, MCP registrations and the startup skill catalog in Environment, separate from historical evidence.
- Review recorded branch cache usage, hit-rate trends, request comparisons and estimated costs without another extension.
- Use light/dark and responsive browser layouts with keyboard navigation.

## 📦 Install

This package has not been published yet. From a repository checkout:

```bash
npm install
npm --workspace @narumitw/pi-inspect run build
pi install ./packages/pi-inspect
```

For one invocation without saving an installation:

```bash
pi -e ./packages/pi-inspect
```

Extensions run with Pi's permissions; review the source before installing. Root `npm install` builds browser assets during prepare, including Pi's production-only Git installation path. Rebuild after frontend changes. Packaged browser assets require no development server; frontend/build dependencies remain production dependencies so asset-free Git checkouts can build with dev dependencies omitted. Factory loading does not start the server or read those assets.

The old project-local extension is removed. Replace explicit `.pi/extensions/inspect/index.ts` references with `packages/pi-inspect/src/index.ts`, or load the package directory. Reload an existing session after updating its installation.

## 🚀 Quick start

In Pi's interactive TUI, run `/inspect` and accept the sensitive-data warning. The command opens your default browser; if opening fails, Pi shows a private URL instead.

Use the Context, Session, Cache and Environment tabs below the header. Context shows the last observed model input, or an explicitly labeled session-derived fallback. Session contains History, Branch view and Captured executions, with inline filters; selecting a record opens Event details beside the list, or in a drawer on narrow screens. **View branch context** opens an explicit historical projection, not a captured request.

Environment contains Tools, MCP Servers and Skills. These show current tool metadata, extension-registered MCP server names and the skill catalog captured at inspector startup, not historical request evidence. Switching tabs retains resource reading state. Independent provider observations remain in Context.

Cache follows Pi's active branch, with weighted usage totals, the latest 200 records, 32 conversational trend points and links to Event details. Unknown cache accounting stays unavailable, not 0%; summary and warming usage contribute to totals but not conversational comparisons. Costs and re-billed tokens are estimates, not billing or proof of prefix reuse. See the [cache history contract](./docs/cache-history.md) for formulas, bounds and data availability. Streaming and historical-branch cache previews are not included.

Use `/inspect stop` when finished. Closing the browser tab alone does not stop the server or collection.

## 💬 Commands

| Command | TUI | RPC | JSON / print |
| --- | --- | --- | --- |
| `/inspect` | Confirm, start, open/reopen viewer | Observable notification rejecting opening | Extension command error reported by Pi |
| `/inspect stop` | Stop and notify | Stop and notify | Stop; no ad hoc protocol output |
| Unknown or trailing arguments | Usage warning | Usage warning | Extension command error reported by Pi |

`/session-inspector` and `/session-inspector stop` remain compatibility aliases with identical consent, mode checks and lifecycle behavior.

The default command is a frequent single action, not a manager menu. There are no saved settings, extension environment variables, model tools, or browser-controlled agent actions.

## 🔒 Security and privacy

The server binds only `127.0.0.1` on a random port. Data and SSE requests require a per-session token and generation; Host, Origin and method checks reject unrelated requests. The data-free shell and bundled JS/CSS are publicly readable on that loopback port. Do not expose the port remotely: tokens do not defend against a malicious process running as your local user.

CSP blocks remote content. Text and Markdown remain literal; only small validated raster images can render. No filesystem attachment is opened automatically. Capture and display are bounded, and Raw/Copy reveal only bounded captured data, not omitted content.

Stop, reload, session replacement and shutdown clear collection, close connections and revoke the URL. Revocation cannot erase data already received by a browser; close the tab to release that view. Pending requests, streams, timers, browser-launch tasks and session resources are cancelled at their owning boundary. Browser storage is optional: valid private URLs still work when it is blocked, but a fragment-free reload without saved credentials requires reopening the viewer from Pi.

See the bundled [viewer reference](./docs/viewer.md) for detailed bounds, connection behavior and security controls.

## 🚧 Limitations

The observed Pi-stage context and provider-payload copies are not guaranteed final transport inputs. Historical projections follow native Pi semantics; missing checkpoints, uncaptured results, segment token sizes and unavailable timings are labeled rather than inferred. Session ancestry and live execution parentage remain separate.

Environment cannot report the complete configured MCP server catalog, connection/authentication health or authoritative server-to-tool ownership. A registration or namespace is not proof of a connection. Skill file content and current file availability are unavailable; the inspector does not read skill files. The startup skill catalog is not continuously refreshed.

The [viewer reference](./docs/viewer.md) documents every view, supported interaction, provenance distinction and capture limit.

## Development verification

Run from the repository root:

```bash
npm --workspace @narumitw/pi-inspect run build
npm --workspace @narumitw/pi-inspect run typecheck
npm --workspace @narumitw/pi-inspect test
npm exec --workspace @narumitw/pi-inspect -- playwright install chromium
npm --workspace @narumitw/pi-inspect run test:browser
npm --workspace @narumitw/pi-inspect run smoke
npm --workspace @narumitw/pi-inspect run smoke:git-install
npm run package:pack -- inspect
npm run check
npm test
```

Root checks build and typecheck this workspace; root tests include its deterministic tests. Browser tests run separately. The smoke exercises package-directory loading, trusted source discovery, command-mode rejection, reload, replacement and orderly shutdown without a paid provider request. The production Git-install smoke starts with an asset-free source checkout, runs Pi's production npm install flags, and verifies generated assets, loopback serving and Pi loading. Browser bundles preserve third-party license comments.

[Historical verification](./docs/VERIFICATION.md) and [review evidence](./docs/REVIEW.md) retain earlier implementation audits; their old project-local paths describe that earlier revision.

## 🗂️ Package layout

- `src/index.ts`: thin Pi entrypoint forwarding to `src/extension.ts`.
- `src/`: session ownership, bounded collection, projection, privacy and loopback server.
- `src/web/`: React/Radix browser viewer and styles.
- `dist/`: generated browser assets, built before packing and included in the package.
- `docs/`: bundled viewer reference and historical review/verification evidence.
- `scripts/`, `test/`: repository build/smoke helpers and deterministic/browser tests; not published.

## 🔎 Keywords

Pi, session inspector, context composition, tool calls, codemode, read-only browser viewer, privacy.

## 📄 License

[MIT](./LICENSE).
