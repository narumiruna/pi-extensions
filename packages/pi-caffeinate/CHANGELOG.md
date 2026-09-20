# @narumitw/pi-caffeinate

## 0.49.8

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.49.7

### Patch Changes

- bd00d53: Render standard horizontal frames around the remaining extension menus.

## 0.49.6

### Patch Changes

- 358a179: Lazy-load Linux D-Bus support so other platforms do not load `dbus-native` during Pi startup.

## 0.49.5

### Patch Changes

- dc4f90e: Load each extension from a generated source-mapped Jiti runtime while preserving first-use feature boundaries.

## 0.49.4

### Patch Changes

- 5aaa7b3: Keep Linux desktops awake by pairing sleep blocking with `org.freedesktop.ScreenSaver` idle inhibition in display mode.
