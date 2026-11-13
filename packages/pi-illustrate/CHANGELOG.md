# @narumitw/pi-illustrate

## 0.2.0

### Minor Changes

- 4f50aea: Add local SVG and Mermaid terminal previews, appearance-aware resizing, opt-in model images, and the `/illustrate` settings menu. Retry preview updates when the local render queue is full, preserve completed results at the preview cache limit, and account for rounded raster dimensions when capping resolution.

### Patch Changes

- 07f7e31: Avoid TUI redraws while a preview waits for render capacity. Keep redraws after a completed render or a permanent render error.
- 08ad672: Reuse unchanged preview output so Pi can move and scroll fullscreen images without uploading the same PNG again. Include encoded image output in the session cache limit.

## 0.1.0

Initial local SVG and Mermaid terminal previews.
