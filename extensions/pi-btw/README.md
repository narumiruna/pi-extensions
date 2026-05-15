# pi-btw

A public [pi](https://pi.dev) extension package that adds `/btw`, a side-question command for asking quick questions without interrupting the main conversation.

## Install

```bash
pi install npm:@narumitw/pi-btw
```

Try without installing:

```bash
pi -e npm:@narumitw/pi-btw
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/pi-btw
```

## Usage

```text
/btw <your side question>
```

The command answers the question in a temporary UI using the current session branch as context, but it does not append the side question or answer to the main conversation.

## Package layout

```txt
extensions/pi-btw/
├── src/
│   └── btw.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

The package exposes its extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/btw.ts"]
  }
}
```
