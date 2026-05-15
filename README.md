# pi extensions

Monorepo for independently installable Pi extension packages.

## Packages

| Package | Source | Install |
| --- | --- | --- |
| `@narumitw/pi-caffeinate` | [`extensions/pi-caffeinate`](./extensions/pi-caffeinate) | `pi install npm:@narumitw/pi-caffeinate` |
| `@narumitw/pi-chrome-devtools` | [`extensions/pi-chrome-devtools`](./extensions/pi-chrome-devtools) | `pi install npm:@narumitw/pi-chrome-devtools` |
| `@narumitw/pi-firecrawl` | [`extensions/pi-firecrawl`](./extensions/pi-firecrawl) | `pi install npm:@narumitw/pi-firecrawl` |
| `@narumitw/pi-goal` | [`extensions/pi-goal`](./extensions/pi-goal) | `pi install npm:@narumitw/pi-goal` |
| `@narumitw/pi-retry` | [`extensions/pi-retry`](./extensions/pi-retry) | `pi install npm:@narumitw/pi-retry` |

## Local development

Run checks for all packages:

```bash
npm run check
```

Try a package locally:

```bash
pi -e ./extensions/pi-caffeinate
pi -e ./extensions/pi-chrome-devtools
pi -e ./extensions/pi-firecrawl
pi -e ./extensions/pi-goal
pi -e ./extensions/pi-retry
```

Preview package contents:

```bash
npm run pack:caffeinate
npm run pack:chrome-devtools
npm run pack:firecrawl
npm run pack:goal
npm run pack:retry
```

Publish packages from their package directories:

```bash
cd extensions/pi-caffeinate && npm publish --access public
cd extensions/pi-chrome-devtools && npm publish --access public
cd extensions/pi-firecrawl && npm publish --access public
cd extensions/pi-goal && npm publish --access public
cd extensions/pi-retry && npm publish --access public
```
