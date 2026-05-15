# pi-statusline

A public [pi](https://pi.dev) extension package that replaces Pi's footer with a beautiful, information-rich statusline and lets you customize it with `/statusline <prompt>`.

Use the slash command for changes, such as `/statusline make it minimal and blue, hide cost`. Normal prompts are not intercepted.

## Install

```bash
pi install npm:@narumitw/pi-statusline
```

Try without installing:

```bash
pi -e npm:@narumitw/pi-statusline
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/pi-statusline
```

## Slash command examples

Use `/statusline <prompt>`:

```text
/statusline make it beautiful and compact
/statusline minimal, blue, and show git branch plus time
/statusline hide cost and tokens
/statusline use rainbow colors with context, tools, and cwd
/statusline monochrome with no separators
/statusline show current configuration
/statusline reset to default
/statusline turn off
/statusline turn on
```

Only the `/statusline` command applies changes directly. Other prompts continue to the agent normally.

## What it shows

The default statusline includes:

- `π` brand marker
- current model
- thinking level
- git branch
- current project directory
- active or last tool
- statuses from other extensions, such as goal mode
- context usage percentage
- token totals
- estimated cost
- clock

The layout adapts to terminal width and truncates safely.

## Agent tool

The package also registers `statusline_customize`, so the agent can apply statusline changes when a statusline request is part of a broader natural-language conversation.

## Package layout

```txt
extensions/pi-statusline/
├── src/
│   └── statusline.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

The package exposes its extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/statusline.ts"]
  }
}
```
