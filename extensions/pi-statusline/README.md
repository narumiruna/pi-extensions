# pi-statusline

A public [pi](https://pi.dev) extension package that replaces Pi's footer with a beautiful, information-rich statusline.

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

## What it shows

The default statusline includes:

- `π` brand marker
- emoji-labeled current model
- emoji-labeled thinking level
- emoji-labeled git branch
- emoji-labeled current project directory
- emoji-labeled active or last tool
- emoji-labeled context usage percentage
- emoji-labeled token totals
- emoji-labeled estimated cost
- emoji-labeled clock

Statuses from other extensions, such as goal mode, appear on their own emoji-labeled line below the main statusline and are separated with ``.
The layout adapts to terminal width and truncates safely.

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
