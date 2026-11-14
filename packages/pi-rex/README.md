# 🦖 Pi Rex — Pi Sessions in Rex

[![npm](https://img.shields.io/npm/v/@narumitw/pi-rex)](https://www.npmjs.com/package/@narumitw/pi-rex)
[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://github.com/earendil-works/pi)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Show Pi agents in the connected Rex server in a read-only widget above Pi's editor. The session list is inspired by [Brachio](https://github.com/narumiruna/brachio).

## ✨ Features

- Show Pi status, working directory, and Rex session, tab, and pane.
- Refresh automatically without reading terminal output or changing focus.
- Keep one width-safe Pi TUI Kit widget, with a collapse control in fullscreen mode.
- Mark partial snapshots and stale data when Rex cannot be read.

## 📦 Install

Install the official [Rex CLI](https://www.superlogical.com/rex/docs) and make `rex` available in `PATH`. Start Rex before using the widget. Extensions run with Pi's permissions; install only trusted code.

This package is not yet published. From the repository root:

```bash
npm install
npm --workspace @narumitw/pi-tui-kit run build
pi install ./packages/pi-rex
```

To try it for one invocation:

```bash
pi -e ./packages/pi-rex
```

After publication, persistent and temporary npm installation use:

```bash
pi install npm:@narumitw/pi-rex
pi -e npm:@narumitw/pi-rex
```

## 🚀 Quick start

Start Pi in Rex with this package enabled. The **Rex** widget lists detected Pi panes, including the current pane when its Rex IDs match. Run `/rex` to refresh and expand it.

## 💬 Commands

`/rex` refreshes and expands the widget. It accepts no arguments and requires TUI mode. RPC reports an error notification; print and JSON calls fail without starting discovery.

## 🧭 How it works

The extension reads Rex session and block metadata, `program_status`, and foreground process identity. It scans again two seconds after each completed refresh. Scans do not overlap; `/rex` joins a scan already in progress. Shutdown, reload, and session replacement cancel and join owned requests.

Each Pi pane produces one row. Related Pi reports use the most urgent state: Blocked, Error, Done, Working, then Idle. Unknown report states use Idle, as specified by Rex's CLI schema. A foreground process identified as `pi` without a report shows `Idle*`; this is a fallback, not a reported state. A generic `node` process does not identify Pi. Other agents are excluded.

Done is a report about a piece of work, not proof that the whole session is complete. Done and Error reports can remain after Pi exits. CWD is shown only when the foreground process is identified as Pi; otherwise it is unavailable. Paths under the terminal's reported home directory use `~` for display only.

The widget keeps Rex discovery order and uses at most eight rows, further reduced on short terminals. Overflow shows an omitted count when space permits; the divider always retains the total count. Fullscreen clicks collapse or expand the widget without taking editor focus. `/rex` restores it in both regular and fullscreen modes.

## 🔒 Security and privacy

The widget uses read-only Rex CLI calls against the connected server, which can include other sessions visible to your Rex account. It does not capture terminal text, read Pi conversation files, select an app, send terminal input, or change Rex focus. Displayed metadata is not added to model context or saved by this extension.

Requests disable Rex autostart, use separate arguments without a shell, and limit combined command output to 1 MiB. Rex requests have a three-second protocol timeout and a four-second process timeout; Pi can allow up to five more seconds before force-killing a process that ignores termination. Terminal controls are removed from displayed labels and paths.

## 🚧 Limitations

Only TUI mode starts the widget. This first version has no navigation, remote-host selection, settings, or event-stream listener. It requires Rex CLI support for JSON session/block metadata, `program_status`, and `process`.

A failed server scan retains the previous list and marks it stale. Session or pane failures produce a partial list and a warning; failed status reads are not shown as Idle. Missing Rex or a stopped server remains visible as an error and is retried. These reads are not an atomic snapshot of Rex state.

Automated tests cover rendering, discovery, lifecycle, and package loading. A terminal operator must still check regular/fullscreen appearance, narrow and short resize, themes, native mouse disclosure, and editor typing/paste. Publication and release actions require separate approval.

## 🗂️ Package layout

- `src/index.ts`: Pi extension entrypoint.
- `src/rex.ts`: session lifecycle, polling, command, and widget ownership.
- `src/rex-snapshot.ts`: bounded CLI reads and Pi pane discovery.
- `src/rex-widget.ts`: sanitized, row-bounded status rendering.
- `test/`: deterministic discovery, display, lifecycle, and loader tests.

The package publishes its TypeScript source for Pi's Jiti loader. Only the Pi TUI Kit dependency needs built JavaScript in a local checkout.

## 🔎 Keywords

Pi, Rex, sessions, terminal panes, program status, editor widget, Pi TUI Kit.

## 📄 License

[MIT](./LICENSE)
